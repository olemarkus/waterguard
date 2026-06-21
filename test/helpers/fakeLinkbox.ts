import { ObjectTypeId, PropertyId, objectKey } from '../../lib/linkboxObjects';

const AI = ObjectTypeId.ANALOG_INPUT;
const MSI = ObjectTypeId.MULTI_STATE_INPUT;
const MSO = ObjectTypeId.MULTI_STATE_OUTPUT;
const DEVICE = ObjectTypeId.DEVICE;

const VALVE_STATE_TEXTS = ['unknown', 'closed', 'open', 'unused'];
const OPEN_CLOSE_TEXTS = ['none', 'close', 'open'];
const RESET_TEXTS = ['none', 'reset'];
const CABLE_TEXTS = ['unknown', 'connected', 'disconnected'];
const TAMPER_TEXTS = ['ok', 'restored', 'warning', 'error', 'override', 'noValve', 'unknown'];
const VALVE_ALARM_TEXTS = [
  'noAlarm', 'currentOpenLow', 'currentOpenHigh', 'currentCloseLow', 'currentCloseHigh',
  'timeoutOpen', 'timeoutClose', 'timeout', 'unknownCommand', 'valveNum', 'currentLow', 'unknownError',
];

export type FakeObject = {
  type: number;
  instance: number;
  name: string;
  present: number;
  stateTexts?: string[];
};

export const SENSOR_ONE = '5149013726658557';
export const SENSOR_TWO = '5149013726659907';

export function defaultObjects(): FakeObject[] {
  return [
    { type: AI, instance: 19, name: 'waterMonitor:8.alarm', present: 0.5 },
    { type: AI, instance: 2, name: 'waterMonitor:8.leak1', present: 0 },
    { type: MSO, instance: 13, name: 'valveControl:8.openClose', present: 1, stateTexts: OPEN_CLOSE_TEXTS },
    { type: MSO, instance: 22, name: 'waterMonitor:8.resetLeak', present: 1, stateTexts: RESET_TEXTS },
    { type: MSI, instance: 14, name: 'valveMonitor:8.alarm', present: 1, stateTexts: VALVE_ALARM_TEXTS },
    { type: MSI, instance: 15, name: 'valveMonitor:8.numValves', present: 2 },
    { type: MSI, instance: 16, name: 'valveMonitor:8.valveType', present: 2, stateTexts: ['unknown', 'Ball', 'Ball Adapter', 'Solenoid Adapter'] },
    { type: MSI, instance: 17, name: 'valveMonitor:8.valveStatus1', present: 2, stateTexts: VALVE_STATE_TEXTS },
    { type: MSI, instance: 20, name: 'waterMonitor:8.cable', present: 2, stateTexts: CABLE_TEXTS },
    { type: MSI, instance: 23, name: 'waterTamper:0.state', present: 1, stateTexts: TAMPER_TEXTS },
    { type: AI, instance: 30, name: `${SENSOR_ONE}.waterMonitor:8.leak1`, present: 0 },
    { type: AI, instance: 31, name: `${SENSOR_ONE}.waterMonitor:8.leak2`, present: 0 },
    { type: AI, instance: 32, name: `${SENSOR_ONE}.waterMonitor:8.temperature`, present: 21 },
    { type: AI, instance: 33, name: `${SENSOR_ONE}.waterMonitor:8.humidity`, present: 45 },
    { type: AI, instance: 34, name: `${SENSOR_ONE}.waterMonitor:8.batteryVoltage`, present: 3.1 },
    { type: AI, instance: 40, name: `${SENSOR_TWO}.waterMonitor:8.leak1`, present: 0 },
    { type: AI, instance: 41, name: `${SENSOR_TWO}.waterMonitor:8.leak2`, present: 0 },
    { type: AI, instance: 42, name: `${SENSOR_TWO}.waterMonitor:8.temperature`, present: 19 },
    { type: AI, instance: 43, name: `${SENSOR_TWO}.waterMonitor:8.batteryVoltage`, present: 2.4 },
  ];
}

export type FakeLinkboxOptions = {
  ip?: string;
  deviceId?: number;
  vendorId?: number;
  model?: string;
  serial?: string;
  objects?: FakeObject[];
};

export class FakeLinkbox {
  readonly ip: string;

  readonly deviceId: number;

  readonly vendorId: number;

  readonly model: string;

  readonly serial?: string;

  readonly objects = new Map<string, FakeObject>();

  failReads = false;

  failWrites = false;

  writes: Array<{ key: string; value: number }> = [];

  whoIsCalls: Array<{ address?: string } | undefined> = [];

  private iamHandlers: Array<(device: any) => void> = [];

  constructor(options: FakeLinkboxOptions = {}) {
    this.ip = options.ip ?? '192.168.1.143';
    this.deviceId = options.deviceId ?? 1001;
    this.vendorId = options.vendorId ?? 1480;
    this.model = options.model ?? 'Abra Linkbox+';
    this.serial = options.serial;
    for (const object of options.objects ?? defaultObjects()) {
      this.objects.set(objectKey(object.type, object.instance), object);
    }
  }

  byName(name: string): FakeObject {
    for (const object of this.objects.values()) {
      if (object.name === name) return object;
    }
    throw new Error(`No fake object named ${name}`);
  }

  setPresent(name: string, value: number): void {
    this.byName(name).present = value;
  }

  private deviceProp(propertyId: number): any {
    if (propertyId === PropertyId.MODEL_NAME) return [{ type: 7, value: this.model }];
    if (propertyId === PropertyId.OBJECT_NAME) return [{ type: 7, value: this.model }];
    if (propertyId === PropertyId.VENDOR_IDENTIFIER) return [{ type: 2, value: this.vendorId }];
    if (propertyId === PropertyId.SERIAL_NUMBER) {
      if (this.serial === undefined) throw new Error('no serial');
      return [{ type: 7, value: this.serial }];
    }
    if (propertyId === PropertyId.OBJECT_LIST) {
      return [...this.objects.values()].map((object) => ({
        type: 12,
        value: { type: object.type, instance: object.instance },
      }));
    }
    throw new Error(`Unsupported device property ${propertyId}`);
  }

  private objectProp(object: FakeObject, propertyId: number): any {
    if (propertyId === PropertyId.PRESENT_VALUE) return [{ type: 4, value: object.present }];
    if (propertyId === PropertyId.OBJECT_NAME) return [{ type: 7, value: object.name }];
    if (propertyId === PropertyId.STATE_TEXT) {
      if (!object.stateTexts) throw new Error('no state text');
      return object.stateTexts.map((text) => ({ type: 7, value: text }));
    }
    throw new Error(`Unsupported property ${propertyId}`);
  }

  private resolve(objectId: any, propertyId: number): any {
    if (objectId.type === DEVICE) return this.deviceProp(propertyId);
    const object = this.objects.get(objectKey(objectId.type, objectId.instance));
    if (!object) throw new Error(`Unknown object ${objectId.type}:${objectId.instance}`);
    return this.objectProp(object, propertyId);
  }

  private applyWrite(objectId: any, value: number): void {
    const openClose = this.byName('valveControl:8.openClose');
    const target = this.objects.get(objectKey(objectId.type, objectId.instance));
    if (target) target.present = value;
    if (target === openClose) {
      // 2 = close, 3 = open -> reflect into valveStatus1 (2 closed, 3 open)
      this.byName('valveMonitor:8.valveStatus1').present = value;
    }
  }

  get client(): any {
    const self = this;
    return {
      on(event: string, handler: (arg: any) => void) {
        if (event === 'iAm') self.iamHandlers.push(handler);
        return this;
      },
      whoIs(options?: { address?: string }) {
        self.whoIsCalls.push(options);
        for (const handler of self.iamHandlers) {
          handler({ address: self.ip, deviceId: self.deviceId, vendorId: self.vendorId, maxApdu: 1476, segmentation: 0 });
        }
      },
      readProperty(_ip: string, objectId: any, propertyId: number, a: any, b?: any) {
        const cb = b ?? a;
        if (self.failReads) return cb(new Error('unreachable'));
        try {
          return cb(null, { values: self.resolve(objectId, propertyId) });
        } catch (error) {
          return cb(error as Error);
        }
      },
      readPropertyMultiple(_ip: string, specs: any[], a: any, b?: any) {
        const cb = b ?? a;
        if (self.failReads) return cb(new Error('unreachable'));
        try {
          const values = specs.map((spec) => ({
            objectId: spec.objectId,
            values: spec.properties.map((property: any) => ({
              property: { id: property.id, index: 0 },
              value: self.resolve(spec.objectId, property.id),
            })),
          }));
          return cb(null, { values });
        } catch (error) {
          return cb(error as Error);
        }
      },
      writeProperty(_ip: string, objectId: any, _propertyId: number, values: any[], _options: any, cb: any) {
        if (self.failWrites) return cb(new Error('write denied'));
        const value = values[0].value as number;
        self.writes.push({ key: objectKey(objectId.type, objectId.instance), value });
        self.applyWrite(objectId, value);
        return cb(null);
      },
      close() {},
    };
  }
}
