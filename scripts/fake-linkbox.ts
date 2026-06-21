/**
 * Fake Abra Linkbox+ — a standalone BACnet/IP responder that behaves like a real
 * Linkbox controller so the Homey app can be paired and exercised without the
 * physical hardware. It answers Who-Is/I-Am, ReadProperty(Multiple) and
 * WriteProperty exactly the way the app expects (see lib/waterguardDiscovery.ts
 * and lib/pollMapping.ts), with a configurable composition (valves, wired tape,
 * tamper, wireless sensors) and a small HTTP control API to simulate events such
 * as leaks, faults and a yanked cable.
 *
 * Run it on the same LAN as your Homey (BACnet discovery is L2 broadcast):
 *   npm run fake-linkbox -- --valves 1 --sensors 2
 *   npm run fake-linkbox -- --config scripts/fake-linkbox.example.json
 *   npm run fake-linkbox -- --help
 * (or `node scripts/fake-linkbox.ts ...` directly — Node 22 runs the TS as-is).
 * See scripts/fake-linkbox.example.json for the full per-sensor config shape.
 *
 * Then `homey app run --remote` and pair the gateway. Simulate a leak with:
 *   curl -XPOST localhost:18099/leak -d '{"target":"hub","wet":true}'
 *
 * Node 22 strips the TypeScript types natively, so no build/runner is needed.
 * `scripts/` is homeyignored, so this file is never bundled into the app.
 */
import http from 'node:http';
import os from 'node:os';
import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type {
  BacnetApplicationValue,
  BacnetClientOptions,
  BacnetObjectId,
  BacnetReadAccessResult,
  BacnetTransport,
  BacnetValue,
  BacnetWriteValue,
} from 'bacstack';

// ---------------------------------------------------------------------------
// bacstack server surface — the package ships no types for the responder side,
// so we declare exactly what we call and cast the require() once.
// ---------------------------------------------------------------------------
const require = createRequire(import.meta.url);

type PropertyRef = { id: number; index?: number };

type WhoIsRequest = { address: string; lowLimit?: number; highLimit?: number };

type ReadPropertyRequest = {
  address: string;
  invokeId: number;
  request: { objectId: BacnetObjectId; property: PropertyRef };
};

type ReadPropertyMultipleRequest = {
  address: string;
  invokeId: number;
  request: { properties: Array<{ objectId: BacnetObjectId; properties: PropertyRef[] }> };
};

type WritePropertyRequest = {
  address: string;
  invokeId: number;
  request: {
    objectId: BacnetObjectId;
    value: { property: PropertyRef; value: BacnetWriteValue[]; priority?: number };
  };
};

type ServerClient = {
  on(event: 'whoIs', listener: (req: WhoIsRequest) => void): ServerClient;
  on(event: 'readProperty', listener: (req: ReadPropertyRequest) => void): ServerClient;
  on(event: 'readPropertyMultiple', listener: (req: ReadPropertyMultipleRequest) => void): ServerClient;
  on(event: 'writeProperty', listener: (req: WritePropertyRequest) => void): ServerClient;
  on(event: 'error', listener: (err: Error) => void): ServerClient;
  iAmResponse(deviceId: number, segmentation: number, vendorId: number): void;
  readPropertyResponse(
    address: string,
    invokeId: number,
    objectId: BacnetObjectId,
    property: PropertyRef,
    values: BacnetApplicationValue[],
  ): void;
  readPropertyMultipleResponse(address: string, invokeId: number, values: BacnetReadAccessResult[]): void;
  simpleAckResponse(address: string, serviceChoice: number, invokeId: number): void;
  errorResponse(address: string, serviceChoice: number, invokeId: number, errorClass: number, errorCode: number): void;
  close(): void;
};

type ServerStatic = { new (options: BacnetClientOptions): ServerClient };

const Bacnet = require('bacstack') as ServerStatic;

// ---------------------------------------------------------------------------
// BACnet constants (fixed by the spec; verified against bacstack 0.0.1-beta.14).
// ---------------------------------------------------------------------------
const DEFAULT_PORT = 47808;
const SEGMENTATION_NONE = 3;
const ASN1_ARRAY_ALL = 4294967295;

const TAG = {
  UNSIGNED: 2,
  REAL: 4,
  CHARACTER_STRING: 7,
  ENUMERATED: 9,
  OBJECT_ID: 12,
  ERROR: 105,
};

const OBJ = {
  ANALOG_INPUT: 0,
  DEVICE: 8,
  MSI: 13, // MultiStateInput
  MSO: 14, // MultiStateOutput
};

const PROP = {
  DESCRIPTION: 28,
  MODEL_NAME: 70,
  NUMBER_OF_STATES: 74,
  OBJECT_IDENTIFIER: 75,
  OBJECT_LIST: 76,
  OBJECT_NAME: 77,
  OBJECT_TYPE: 79,
  PRESENT_VALUE: 85,
  SERIAL_NUMBER: 96,
  STATE_TEXT: 110,
  VENDOR_IDENTIFIER: 120,
};

const ERR = {
  CLASS_OBJECT: 1,
  CLASS_PROPERTY: 2,
  CODE_UNKNOWN_OBJECT: 31,
  CODE_UNKNOWN_PROPERTY: 32,
};

const SERVICE = {
  READ_PROPERTY: 12,
  WRITE_PROPERTY: 15,
};

// ---------------------------------------------------------------------------
// Device-side data model: object names + state-text tables the real Linkbox
// exposes. The app parses these names (lib/linkboxObjects.ts) to build its map,
// and resolves valve open/close from the state-text — never a hardcoded value.
// ---------------------------------------------------------------------------
const OPEN_CLOSE_TEXTS = ['none', 'close', 'open'];
const VALVE_STATE_TEXTS = ['unknown', 'closed', 'open', 'unused'];
const RESET_TEXTS = ['none', 'reset'];
const CABLE_TEXTS = ['unknown', 'connected', 'disconnected'];
const TAMPER_TEXTS = ['ok', 'restored', 'warning', 'error', 'override', 'noValve', 'unknown'];
const VALVE_TYPE_TEXTS = ['unknown', 'Ball', 'Ball Adapter', 'Solenoid Adapter'];
const VALVE_ALARM_TEXTS = [
  'noAlarm', 'currentOpenLow', 'currentOpenHigh', 'currentCloseLow', 'currentCloseHigh',
  'timeoutOpen', 'timeoutClose', 'timeout', 'unknownCommand', 'valveNum', 'currentLow', 'unknownError',
];

const HUB_ALARM_NAME = 'waterMonitor:8.alarm';
const HUB_TAPE_NAME = 'waterMonitor:8.leak1';
const RESET_LEAK_NAME = 'waterMonitor:8.resetLeak';
const VALVE_OPEN_CLOSE_NAME = 'valveControl:8.openClose';
const VALVE_STATUS_NAMES = ['valveMonitor:8.valveStatus1', 'valveMonitor:8.valveStatus2'];
const VALVE_ALARM_NAME = 'valveMonitor:8.alarm';
// The real device names the valve actuator-cable status under the waterMonitor
// prefix (verified against the device export), not valveMonitor.
const CABLE_NAME = 'waterMonitor:8.cable';
const TAMPER_NAME = 'waterTamper:0.state';

const HUB_ALARM_IDLE = 0.5;
const LEAK_WET_VALUE = 1.0;

/** 1-based index of the first state matching `text` (BACnet multistate), or fallback. */
function stateValue(texts: string[], text: string, fallback = 1): number {
  const index = texts.findIndex((candidate) => candidate.toLowerCase() === text.toLowerCase());
  return index >= 0 ? index + 1 : fallback;
}

// ---------------------------------------------------------------------------
// Configuration.
// ---------------------------------------------------------------------------
type SensorConfig = {
  id: string;
  leak2?: boolean;
  temperature?: number;
  humidity?: number;
  batteryVoltage?: number;
};

type LinkboxConfig = {
  bind?: string;
  port: number;
  deviceId: number;
  serial: string;
  model: string;
  name: string;
  vendorId: number;
  valves: number;
  valveType: string;
  tape: boolean;
  tamper: boolean;
  sensors: SensorConfig[];
  periodicIAmMs: number;
  api: boolean;
  apiHost: string;
  apiPort: number;
  logTraffic: boolean;
};

const FELL_TECHNOLOGY_VENDOR_ID = 1480;

function generatedSensor(index: number): SensorConfig {
  return {
    id: `5149013726${String(650000 + index).padStart(6, '0')}`,
    leak2: false,
    temperature: 20 + index,
    humidity: 45,
    batteryVoltage: Math.max(2.2, 3.2 - index * 0.2),
  };
}

function parseArgs(argv: string[]): Map<string, string> {
  const valueFlags = new Set([
    '--bind', '--port', '--device-id', '--serial', '--model', '--name', '--vendor-id',
    '--valves', '--valve-type', '--sensors', '--api-host', '--api-port', '--periodic-iam-ms', '--config',
  ]);
  const args = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const part = argv[index];
    if (!part.startsWith('--')) continue;
    if (valueFlags.has(part)) {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) throw new Error(`Missing value for ${part}`);
      args.set(part, next);
      index += 1;
    } else {
      args.set(part, 'true');
    }
  }
  return args;
}

function num(args: Map<string, string>, flag: string, fallback: number): number {
  const raw = args.get(flag);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function loadConfigFile(path: string): Partial<LinkboxConfig> {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Config file ${path} must be a JSON object`);
  }
  return parsed as Partial<LinkboxConfig>;
}

function resolveSensors(args: Map<string, string>, file: Partial<LinkboxConfig>): SensorConfig[] {
  if (Array.isArray(file.sensors)) return file.sensors;
  const count = num(args, '--sensors', 2);
  return Array.from({ length: Math.max(0, count) }, (_unused, index) => generatedSensor(index));
}

function boolFlag(args: Map<string, string>, onFlag: string, offFlag: string, fallback: boolean): boolean {
  if (args.has(onFlag)) return true;
  if (args.has(offFlag)) return false;
  return fallback;
}

function resolveConfig(args: Map<string, string>): LinkboxConfig {
  const file = args.has('--config') ? loadConfigFile(args.get('--config') as string) : {};
  const tape = boolFlag(args, '--tape', '--no-tape', file.tape ?? false);
  const tamper = boolFlag(args, '--tamper', '--no-tamper', file.tamper ?? true);
  return {
    bind: args.get('--bind') ?? file.bind,
    port: num(args, '--port', file.port ?? DEFAULT_PORT),
    deviceId: num(args, '--device-id', file.deviceId ?? 1001),
    serial: args.get('--serial') ?? file.serial ?? '800200-000001',
    model: args.get('--model') ?? file.model ?? 'Abra Linkbox+',
    name: args.get('--name') ?? file.name ?? 'Abra Linkbox+',
    vendorId: num(args, '--vendor-id', file.vendorId ?? FELL_TECHNOLOGY_VENDOR_ID),
    valves: num(args, '--valves', file.valves ?? 1),
    valveType: args.get('--valve-type') ?? file.valveType ?? 'Ball',
    tape,
    tamper,
    sensors: resolveSensors(args, file),
    periodicIAmMs: num(args, '--periodic-iam-ms', file.periodicIAmMs ?? 10000),
    api: !args.has('--no-api') && (file.api ?? true),
    apiHost: args.get('--api-host') ?? file.apiHost ?? '127.0.0.1',
    apiPort: num(args, '--api-port', file.apiPort ?? 18099),
    logTraffic: !args.has('--quiet'),
  };
}

// ---------------------------------------------------------------------------
// State: the object table plus the small amount of behaviour a real unit has
// (writing the valve command reflects into the valve status; resetLeak clears
// the hub leak latch).
// ---------------------------------------------------------------------------
type FakeObject = {
  type: number;
  instance: number;
  name: string;
  present: number;
  analog: boolean;
  stateTexts?: string[];
};

type Identity = {
  deviceId: number;
  serial: string;
  model: string;
  name: string;
  vendorId: number;
};

function buildObjects(config: LinkboxConfig): FakeObject[] {
  const objects: FakeObject[] = [];
  let instance = 1;
  const add = (type: number, name: string, present: number, stateTexts?: string[]): void => {
    objects.push({ type, instance, name, present, analog: type === OBJ.ANALOG_INPUT, stateTexts });
    instance += 1;
  };

  // Hub (water source) — always present.
  add(OBJ.ANALOG_INPUT, HUB_ALARM_NAME, HUB_ALARM_IDLE);
  add(OBJ.MSO, RESET_LEAK_NAME, stateValue(RESET_TEXTS, 'none'), RESET_TEXTS);
  if (config.tape) add(OBJ.ANALOG_INPUT, HUB_TAPE_NAME, 0);

  // Valve(s) — the hub reports up to two valve positions.
  if (config.valves >= 1) {
    add(OBJ.MSO, VALVE_OPEN_CLOSE_NAME, stateValue(OPEN_CLOSE_TEXTS, 'open'), OPEN_CLOSE_TEXTS);
    add(OBJ.MSI, VALVE_ALARM_NAME, stateValue(VALVE_ALARM_TEXTS, 'noAlarm'), VALVE_ALARM_TEXTS);
    add(OBJ.MSI, 'valveMonitor:8.numValves', Math.min(2, config.valves));
    add(OBJ.MSI, 'valveMonitor:8.valveType', stateValue(VALVE_TYPE_TEXTS, config.valveType, 2), VALVE_TYPE_TEXTS);
    for (let valve = 0; valve < Math.min(2, config.valves); valve += 1) {
      add(OBJ.MSI, VALVE_STATUS_NAMES[valve], stateValue(VALVE_STATE_TEXTS, 'open'), VALVE_STATE_TEXTS);
    }
    add(OBJ.MSI, CABLE_NAME, stateValue(CABLE_TEXTS, 'connected'), CABLE_TEXTS);
  }

  if (config.tamper) add(OBJ.MSI, TAMPER_NAME, stateValue(TAMPER_TEXTS, 'ok'), TAMPER_TEXTS);

  // Wireless sensors — each adds ID-prefixed objects.
  for (const sensor of config.sensors) {
    const prefix = `${sensor.id}.waterMonitor:8`;
    add(OBJ.ANALOG_INPUT, `${prefix}.leak1`, 0);
    if (sensor.leak2) add(OBJ.ANALOG_INPUT, `${prefix}.leak2`, 0);
    if (sensor.temperature !== undefined) add(OBJ.ANALOG_INPUT, `${prefix}.temperature`, sensor.temperature);
    if (sensor.humidity !== undefined) add(OBJ.ANALOG_INPUT, `${prefix}.humidity`, sensor.humidity);
    if (sensor.batteryVoltage !== undefined) add(OBJ.ANALOG_INPUT, `${prefix}.batteryVoltage`, sensor.batteryVoltage);
  }

  return objects;
}

class LinkboxState {
  readonly identity: Identity;

  private readonly byKey = new Map<string, FakeObject>();

  private readonly byName = new Map<string, FakeObject>();

  constructor(config: LinkboxConfig) {
    this.identity = {
      deviceId: config.deviceId,
      serial: config.serial,
      model: config.model,
      name: config.name,
      vendorId: config.vendorId,
    };
    for (const object of buildObjects(config)) {
      this.byKey.set(`${object.type}:${object.instance}`, object);
      this.byName.set(object.name, object);
    }
  }

  list(): FakeObject[] {
    return [...this.byKey.values()];
  }

  get(type: number, instance: number): FakeObject | undefined {
    return this.byKey.get(`${type}:${instance}`);
  }

  setPresent(name: string, value: number): boolean {
    const object = this.byName.get(name);
    if (!object) return false;
    object.present = value;
    return true;
  }

  /** Mirror real behaviour: a valve command updates the valve status; resetLeak clears the hub latch. */
  applyWrite(object: FakeObject, value: number): void {
    this.setPresent(object.name, value);
    if (object.name === VALVE_OPEN_CLOSE_NAME) {
      for (const statusName of VALVE_STATUS_NAMES) this.setPresent(statusName, value);
    } else if (object.name === RESET_LEAK_NAME) {
      this.setPresent(HUB_ALARM_NAME, HUB_ALARM_IDLE);
      this.setPresent(HUB_TAPE_NAME, 0);
    }
  }

  snapshot(): unknown {
    return {
      identity: this.identity,
      objects: this.list().map((object) => ({
        type: object.type,
        instance: object.instance,
        name: object.name,
        present: object.present,
        stateTexts: object.stateTexts,
      })),
    };
  }
}

// ---------------------------------------------------------------------------
// Transport that replies to each request's own source port — what a real BACnet
// device does. bacstack's stock transport always answers on a fixed port, but
// the app discovers and enumerates from an ephemeral UDP port (see
// lib/bacnetTransport.ts), so replies must follow the source port to arrive.
// ---------------------------------------------------------------------------
const MAX_PAYLOAD = 1482;
const BROADCAST_ADDRESS = '255.255.255.255';

class ReplyToSourceTransport extends EventEmitter implements BacnetTransport {
  private readonly server: dgram.Socket;

  private readonly port: number;

  private readonly bind?: string;

  private readonly portByAddress = new Map<string, number>();

  private lastSource: { address: string; port: number } | null = null;

  constructor(port: number, bind?: string) {
    super();
    this.port = port;
    this.bind = bind;
    this.server = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.server.on('message', (msg, rinfo) => {
      this.portByAddress.set(rinfo.address, rinfo.port);
      this.lastSource = { address: rinfo.address, port: rinfo.port };
      this.emit('message', msg, rinfo.address);
    });
    this.server.on('error', (err) => this.emit('error', err));
  }

  getBroadcastAddress(): string {
    return BROADCAST_ADDRESS;
  }

  getMaxPayload(): number {
    return MAX_PAYLOAD;
  }

  send(buffer: Buffer, offset: number, receiver: string): void {
    if (receiver === BROADCAST_ADDRESS) {
      // I-Am: reach the requester on its own (often ephemeral) port, plus a
      // classic broadcast for any node listening on the well-known port.
      if (this.lastSource) this.server.send(buffer, 0, offset, this.lastSource.port, this.lastSource.address);
      this.server.send(buffer, 0, offset, this.port, BROADCAST_ADDRESS);
      return;
    }
    const port = this.portByAddress.get(receiver) ?? this.port;
    this.server.send(buffer, 0, offset, port, receiver);
  }

  open(): void {
    this.server.bind(this.port, this.bind, () => this.server.setBroadcast(true));
  }

  close(): void {
    this.server.close();
  }
}

// ---------------------------------------------------------------------------
// BACnet responder.
// ---------------------------------------------------------------------------
type ReadResult =
  | { ok: true; values: BacnetApplicationValue[] }
  | { ok: false; errorClass: number; errorCode: number };

function okValues(values: BacnetApplicationValue[]): ReadResult {
  return { ok: true, values };
}

const UNKNOWN_PROPERTY: ReadResult = {
  ok: false,
  errorClass: ERR.CLASS_PROPERTY,
  errorCode: ERR.CODE_UNKNOWN_PROPERTY,
};

function toWriteNumber(value: BacnetValue | undefined): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  return null;
}

class FakeLinkboxServer {
  private client: ServerClient | null = null;

  private readonly state: LinkboxState;

  private readonly config: LinkboxConfig;

  constructor(state: LinkboxState, config: LinkboxConfig) {
    this.state = state;
    this.config = config;
  }

  start(): void {
    if (this.client) return;
    const client = new Bacnet({
      transport: new ReplyToSourceTransport(this.config.port, this.config.bind),
      apduTimeout: 6000,
    });
    client.on('error', (err) => console.error('[fake-linkbox] bacnet error:', err.message));
    client.on('whoIs', (req) => this.handleWhoIs(req));
    client.on('readProperty', (req) => this.handleReadProperty(req));
    client.on('readPropertyMultiple', (req) => this.handleReadPropertyMultiple(req));
    client.on('writeProperty', (req) => this.handleWriteProperty(req));
    this.client = client;
  }

  stop(): void {
    this.client?.close();
    this.client = null;
  }

  announce(): void {
    const { deviceId, vendorId } = this.state.identity;
    this.client?.iAmResponse(deviceId, SEGMENTATION_NONE, vendorId);
  }

  private log(message: string): void {
    if (this.config.logTraffic) console.log(`[fake-linkbox] ${message}`);
  }

  private handleWhoIs(req: WhoIsRequest): void {
    const { deviceId } = this.state.identity;
    if (typeof req.lowLimit === 'number' && deviceId < req.lowLimit) return;
    if (typeof req.highLimit === 'number' && deviceId > req.highLimit) return;
    this.log(`whoIs from ${req.address} -> iAm deviceId=${deviceId}`);
    this.announce();
  }

  private handleReadProperty(req: ReadPropertyRequest): void {
    const client = this.client;
    if (!client) return;
    const { objectId, property } = req.request;
    const result = this.readValue(objectId, property.id);
    this.log(`read ${objectId.type}:${objectId.instance} prop=${property.id} from ${req.address}`);
    const propertyRef = { id: property.id, index: property.index ?? ASN1_ARRAY_ALL };
    if (result.ok) {
      client.readPropertyResponse(req.address, req.invokeId, objectId, propertyRef, result.values);
    } else {
      client.errorResponse(req.address, SERVICE.READ_PROPERTY, req.invokeId, result.errorClass, result.errorCode);
    }
  }

  private handleReadPropertyMultiple(req: ReadPropertyMultipleRequest): void {
    const client = this.client;
    if (!client) return;
    this.log(`readMultiple ${req.request.properties.length} objects from ${req.address}`);
    const results: BacnetReadAccessResult[] = req.request.properties.map((spec) => ({
      objectId: spec.objectId,
      values: spec.properties.map((property) => {
        const result = this.readValue(spec.objectId, property.id);
        const value = result.ok
          ? result.values
          : [{ type: TAG.ERROR, value: { errorClass: result.errorClass, errorCode: result.errorCode } }];
        return { property: { id: property.id, index: property.index ?? ASN1_ARRAY_ALL }, value };
      }),
    }));
    client.readPropertyMultipleResponse(req.address, req.invokeId, results);
  }

  private handleWriteProperty(req: WritePropertyRequest): void {
    const client = this.client;
    if (!client) return;
    const { objectId } = req.request;
    const object = this.state.get(objectId.type, objectId.instance);
    const numeric = toWriteNumber(req.request.value.value[0]?.value);
    if (!object || numeric === null) {
      const { CLASS_OBJECT, CODE_UNKNOWN_OBJECT } = ERR;
      client.errorResponse(req.address, SERVICE.WRITE_PROPERTY, req.invokeId, CLASS_OBJECT, CODE_UNKNOWN_OBJECT);
      return;
    }
    this.log(`write ${object.name} = ${numeric} from ${req.address}`);
    this.state.applyWrite(object, numeric);
    client.simpleAckResponse(req.address, SERVICE.WRITE_PROPERTY, req.invokeId);
  }

  private readValue(objectId: BacnetObjectId, propertyId: number): ReadResult {
    if (objectId.type === OBJ.DEVICE && objectId.instance === this.state.identity.deviceId) {
      return this.readDeviceProperty(propertyId);
    }
    const object = this.state.get(objectId.type, objectId.instance);
    if (!object) return { ok: false, errorClass: ERR.CLASS_OBJECT, errorCode: ERR.CODE_UNKNOWN_OBJECT };
    return this.readObjectProperty(object, propertyId);
  }

  private readDeviceProperty(propertyId: number): ReadResult {
    const id = this.state.identity;
    if (propertyId === PROP.OBJECT_IDENTIFIER) {
      return okValues([{ type: TAG.OBJECT_ID, value: { type: OBJ.DEVICE, instance: id.deviceId } }]);
    }
    if (propertyId === PROP.OBJECT_NAME) return okValues([{ type: TAG.CHARACTER_STRING, value: id.name }]);
    if (propertyId === PROP.OBJECT_TYPE) return okValues([{ type: TAG.ENUMERATED, value: OBJ.DEVICE }]);
    if (propertyId === PROP.MODEL_NAME) return okValues([{ type: TAG.CHARACTER_STRING, value: id.model }]);
    if (propertyId === PROP.VENDOR_IDENTIFIER) return okValues([{ type: TAG.UNSIGNED, value: id.vendorId }]);
    if (propertyId === PROP.SERIAL_NUMBER) return okValues([{ type: TAG.CHARACTER_STRING, value: id.serial }]);
    if (propertyId === PROP.OBJECT_LIST) {
      const device: BacnetApplicationValue = {
        type: TAG.OBJECT_ID,
        value: { type: OBJ.DEVICE, instance: id.deviceId },
      };
      const objects = this.state.list().map((object): BacnetApplicationValue => ({
        type: TAG.OBJECT_ID,
        value: { type: object.type, instance: object.instance },
      }));
      return okValues([device, ...objects]);
    }
    return UNKNOWN_PROPERTY;
  }

  private readObjectProperty(object: FakeObject, propertyId: number): ReadResult {
    if (propertyId === PROP.PRESENT_VALUE) {
      return okValues([{ type: object.analog ? TAG.REAL : TAG.UNSIGNED, value: object.present }]);
    }
    if (propertyId === PROP.OBJECT_NAME) return okValues([{ type: TAG.CHARACTER_STRING, value: object.name }]);
    if (propertyId === PROP.OBJECT_TYPE) return okValues([{ type: TAG.ENUMERATED, value: object.type }]);
    if (propertyId === PROP.OBJECT_IDENTIFIER) {
      return okValues([{ type: TAG.OBJECT_ID, value: { type: object.type, instance: object.instance } }]);
    }
    if (propertyId === PROP.DESCRIPTION) return okValues([{ type: TAG.CHARACTER_STRING, value: object.name }]);
    if (propertyId === PROP.STATE_TEXT) {
      if (!object.stateTexts) return UNKNOWN_PROPERTY;
      return okValues(object.stateTexts.map((text) => ({ type: TAG.CHARACTER_STRING, value: text })));
    }
    if (propertyId === PROP.NUMBER_OF_STATES) {
      if (!object.stateTexts) return UNKNOWN_PROPERTY;
      return okValues([{ type: TAG.UNSIGNED, value: object.stateTexts.length }]);
    }
    return UNKNOWN_PROPERTY;
  }
}

// ---------------------------------------------------------------------------
// HTTP control API — simulate runtime events to exercise the app's flows.
// ---------------------------------------------------------------------------
type ApiResult = { status: number; body: unknown };

function asNum(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asStr(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asBool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function ok(extra: Record<string, unknown> = {}): ApiResult {
  return { status: 200, body: { ok: true, ...extra } };
}

function fail(message: string): ApiResult {
  return { status: 400, body: { ok: false, error: message } };
}

function setOr404(state: LinkboxState, name: string, value: number): ApiResult {
  return state.setPresent(name, value) ? ok({ name, value }) : fail(`no object named ${name}`);
}

function leakName(target: string, field: string): string {
  if (target === 'hub') return HUB_ALARM_NAME;
  if (target === 'tape') return HUB_TAPE_NAME;
  return `${target}.waterMonitor:8.${field}`;
}

function handleLeak(state: LinkboxState, body: Record<string, unknown>): ApiResult {
  const target = asStr(body.target) ?? 'hub';
  const field = asStr(body.field) ?? 'leak1';
  const wet = asBool(body.wet) ?? true;
  const idle = target === 'hub' ? HUB_ALARM_IDLE : 0;
  return setOr404(state, leakName(target, field), wet ? LEAK_WET_VALUE : idle);
}

function handleValve(state: LinkboxState, body: Record<string, unknown>): ApiResult {
  const open = asBool(body.open);
  if (open === undefined) return fail('expected { open: boolean }');
  const value = stateValue(VALVE_STATE_TEXTS, open ? 'open' : 'closed');
  const valve = asNum(body.valve);
  const names = valve ? [VALVE_STATUS_NAMES[valve - 1]] : VALVE_STATUS_NAMES;
  const updated = names.filter((name) => name && state.setPresent(name, value));
  return updated.length ? ok({ open, updated }) : fail('no valve status object');
}

function handleFault(state: LinkboxState, body: Record<string, unknown>): ApiResult {
  const fault = asStr(body.state) ?? 'unknownError';
  return setOr404(state, VALVE_ALARM_NAME, stateValue(VALVE_ALARM_TEXTS, fault));
}

function handleCable(state: LinkboxState, body: Record<string, unknown>): ApiResult {
  const connected = asBool(body.connected) ?? false;
  return setOr404(state, CABLE_NAME, stateValue(CABLE_TEXTS, connected ? 'connected' : 'disconnected'));
}

function handleTamper(state: LinkboxState, body: Record<string, unknown>): ApiResult {
  const requested = asStr(body.state) ?? (asBool(body.state) ? 'warning' : 'ok');
  return setOr404(state, TAMPER_NAME, stateValue(TAMPER_TEXTS, requested));
}

function handleBattery(state: LinkboxState, body: Record<string, unknown>): ApiResult {
  const sensor = asStr(body.sensor);
  const voltage = asNum(body.voltage);
  if (!sensor || voltage === undefined) return fail('expected { sensor, voltage }');
  return setOr404(state, `${sensor}.waterMonitor:8.batteryVoltage`, voltage);
}

function handleSet(state: LinkboxState, body: Record<string, unknown>): ApiResult {
  const name = asStr(body.name);
  const value = asNum(body.value);
  if (!name || value === undefined) return fail('expected { name, value }');
  return setOr404(state, name, value);
}

function handleDry(state: LinkboxState): ApiResult {
  const cleared: string[] = [];
  for (const object of state.list()) {
    if (!object.name.endsWith('.leak1') && !object.name.endsWith('.leak2')) continue;
    state.setPresent(object.name, 0);
    cleared.push(object.name);
  }
  state.setPresent(HUB_ALARM_NAME, HUB_ALARM_IDLE);
  state.setPresent(VALVE_ALARM_NAME, stateValue(VALVE_ALARM_TEXTS, 'noAlarm'));
  return ok({ cleared });
}

const API_ACTIONS: Record<string, (state: LinkboxState, body: Record<string, unknown>) => ApiResult> = {
  'POST /set': handleSet,
  'POST /leak': handleLeak,
  'POST /dry': handleDry,
  'POST /valve': handleValve,
  'POST /fault': handleFault,
  'POST /cable': handleCable,
  'POST /tamper': handleTamper,
  'POST /battery': handleBattery,
};

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function parseBody(text: string): Record<string, unknown> {
  if (!text.trim()) return {};
  const parsed = JSON.parse(text) as unknown;
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {};
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(payload);
}

async function handleApi(state: LinkboxState, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const method = req.method ?? 'GET';
  const path = (req.url ?? '/').split('?')[0];
  try {
    if (method === 'GET' && path === '/state') {
      sendJson(res, 200, state.snapshot());
      return;
    }
    const action = API_ACTIONS[`${method} ${path}`];
    if (!action) {
      sendJson(res, 404, { ok: false, error: `no route ${method} ${path}` });
      return;
    }
    const result = action(state, parseBody(await readBody(req)));
    sendJson(res, result.status, result.body);
  } catch (error) {
    sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}

function startApi(state: LinkboxState, config: LinkboxConfig): Promise<http.Server> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      void handleApi(state, req, res);
    });
    server.listen(config.apiPort, config.apiHost, () => resolve(server));
  });
}

// ---------------------------------------------------------------------------
// Entry point.
// ---------------------------------------------------------------------------
function printUsage(): void {
  console.log(`Fake Abra Linkbox+ — BACnet responder for the Waterguard Homey app

Usage: node scripts/fake-linkbox.ts [options]

Composition:
  --valves <n>          Number of valves (0-2, default 1)
  --valve-type <name>   Ball | Ball Adapter | Solenoid Adapter (default Ball)
  --sensors <n>         Number of wireless sensors (default 2)
  --tape / --no-tape    Wired sensor-tape on the hub (default off)
  --tamper / --no-tamper Tamper switch (default on)
  --config <file.json>  Full composition incl. per-sensor fields (see README)

Identity / network:
  --bind <ip>           Bind to a specific interface (default all)
  --port <n>            BACnet UDP port (default 47808)
  --device-id <n>       BACnet device instance (default 1001)
  --serial <s>          Device serial (default 800200-000001)
  --model <s>           Model name (default "Abra Linkbox+")
  --name <s>            Device object name (default "Abra Linkbox+")
  --vendor-id <n>       Vendor id (default 1480 = Fell Technology)
  --periodic-iam-ms <n> Periodic I-Am broadcast interval (default 10000)

Control API:
  --api-host <host>     HTTP API host (default 127.0.0.1)
  --api-port <n>        HTTP API port (default 18099)
  --no-api              Disable the HTTP control API
  --quiet               Silence per-request logging`);
}

function lanIPv4Addresses(): string[] {
  const out: string[] = [];
  for (const infos of Object.values(os.networkInterfaces())) {
    for (const info of infos ?? []) {
      if (info.family === 'IPv4' && !info.internal) out.push(info.address);
    }
  }
  return out;
}

function logStartup(config: LinkboxConfig, state: LinkboxState): void {
  const id = state.identity;
  const bind = config.bind ?? '0.0.0.0';
  console.log(`[fake-linkbox] ${id.model} serial=${id.serial} deviceId=${id.deviceId} vendorId=${id.vendorId}`);
  console.log(`[fake-linkbox] BACnet on ${bind}:${config.port} (broadcast I-Am every ${config.periodicIAmMs}ms)`);
  const lan = lanIPv4Addresses();
  if (lan.length) {
    console.log(`[fake-linkbox] LAN IPv4: ${lan.join(', ')} — pass --bind <ip> if Homey can't reach the mock`);
  }
  console.log(
    `[fake-linkbox] Composition: valves=${config.valves} tape=${config.tape} tamper=${config.tamper}`
    + ` sensors=${config.sensors.length} (${state.list().length} BACnet objects)`,
  );
  if (config.api) {
    const base = `http://${config.apiHost}:${config.apiPort}`;
    console.log(`[fake-linkbox] Control API at ${base}`);
    console.log(`[fake-linkbox]   curl ${base}/state`);
    console.log(`[fake-linkbox]   curl -XPOST ${base}/leak  -d '{"target":"hub","wet":true}'`);
    console.log(`[fake-linkbox]   curl -XPOST ${base}/valve -d '{"open":false}'`);
    console.log(`[fake-linkbox]   curl -XPOST ${base}/dry`);
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    printUsage();
    return;
  }

  const config = resolveConfig(parseArgs(argv));
  const state = new LinkboxState(config);
  const server = new FakeLinkboxServer(state, config);
  server.start();
  server.announce();

  const apiServer = config.api ? await startApi(state, config) : null;
  const iam = setInterval(() => server.announce(), config.periodicIAmMs);

  logStartup(config, state);

  const shutdown = (): void => {
    clearInterval(iam);
    server.stop();
    apiServer?.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error: unknown) => {
  console.error('[fake-linkbox] fatal:', error);
  process.exitCode = 1;
});
