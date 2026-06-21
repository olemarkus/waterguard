/**
 * Coordinates one Abra Linkbox+ gateway = one "unit": a single poll loop reads
 * the gateway's BACnet objects and routes values to the registered Homey devices
 * (the gateway/valve device plus one device per wireless sensor). Also serves the
 * valve open/close and reset-leak commands, with write-then-read-back verify.
 *
 * The Homey SDK is kept at arm's length behind {@link RegistryDevice}, so the
 * whole class is testable with plain fakes.
 */
import type { BacnetClient } from 'bacstack';
import { getBacnetClient } from './bacnetClient';
import {
  asNumber,
  firstScalar,
  readProperty,
  readPropertyMultiple,
  writeProperty,
} from './bacnetRead';
import { discoverLinkboxes, DiscoveredLinkbox, enumerateObjects } from './waterguardDiscovery';
import {
  ApplicationTag,
  buildObjectMap,
  DiscoveredObject,
  LinkboxObjectMap,
  ObjectRef,
  objectKey,
  PropertyId,
} from './linkboxObjects';
import {
  buildPollSpecs,
  deriveGatewayCapabilities,
  deriveSensorCapabilities,
  extractPresentValues,
  PresentValues,
  resolveValveCommands,
  resolveValveStatusValues,
} from './pollMapping';
import { RuntimeLogger } from './logging';

export const DEFAULT_POLL_INTERVAL_MS = 20_000;
export const DEFAULT_WRITE_PRIORITY = 8;
const MAX_CONSECUTIVE_FAILURES = 3;
const GATEWAY_UNAVAILABLE_MESSAGE = 'Abra Linkbox+ gateway is not available.';
// A motor-driven ball valve takes seconds to travel; confirm its position by
// polling the status rather than trusting one immediate read-back.
const VALVE_VERIFY_ATTEMPTS = 16;
const VALVE_VERIFY_INTERVAL_MS = 750;
// While a unit stays unavailable, re-run discovery every Nth failed poll so a
// DHCP move missed by the first attempt is still picked up later.
const REDISCOVERY_RETRY_EVERY = 3;

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

export type CapabilityValue = number | string | boolean | null;
export type DeviceRole = { kind: 'gateway' } | { kind: 'sensor'; sensorId: string };

/** The narrow Homey-device surface the registry drives (fire-and-forget). */
export type RegistryDevice = {
  applyCapability(capability: string, value: CapabilityValue): void;
  ensureCapabilityPresent(capability: string, present: boolean): void;
  setReachable(reachable: boolean, message?: string): void;
  triggerFlow(trigger: string, tokens: Record<string, CapabilityValue>): void;
};

export type GatewayEndpoint = {
  unitId: string;
  deviceId: number;
  ip: string;
  port: number;
  writePriority?: number;
};

export type RegistryDependencies = {
  getClient: (port: number) => BacnetClient;
  enumerate: (client: BacnetClient, ip: string, deviceId: number) => Promise<DiscoveredObject[]>;
  discover: () => Promise<DiscoveredLinkbox[]>;
  pollIntervalMs: number;
  sleep: (ms: number) => Promise<void>;
  logger?: RuntimeLogger;
};

function defaultDependencies(): RegistryDependencies {
  return {
    getClient: getBacnetClient,
    enumerate: enumerateObjects,
    discover: () => discoverLinkboxes(),
    pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
    sleep: realSleep,
  };
}

/** Mutable per-gateway state. State transitions live here (as methods) so the
 *  registry never reassigns a parameter's properties. */
class Unit {
  objectMap?: LinkboxObjectMap;

  gateway?: RegistryDevice;

  readonly sensors = new Map<string, RegistryDevice>();

  pollTimer?: ReturnType<typeof setInterval>;

  inflight?: Promise<void>;

  private consecutiveFailures = 0;

  available = true;

  private lastValveFault?: string;

  writePriority = DEFAULT_WRITE_PRIORITY;

  constructor(
    readonly unitId: string,
    public deviceId: number,
    public ip: string,
    public port: number,
  ) {}

  adopt(deviceId: number, ip: string, port: number): void {
    this.deviceId = deviceId;
    this.ip = ip;
    this.port = port;
  }

  setEndpoint(ip: string, port: number): void {
    this.ip = ip;
    this.port = port;
    this.objectMap = undefined;
  }

  setObjectMap(map: LinkboxObjectMap): void {
    this.objectMap = map;
  }

  /** Force the unit into the unavailable state so the next successful poll
   *  re-runs the recover transition (recordSuccess fires only on a flip). */
  markUnavailable(): void {
    this.available = false;
    this.objectMap = undefined;
  }

  setInflight(promise: Promise<void>): void {
    this.inflight = promise;
  }

  clearInflight(): void {
    this.inflight = undefined;
  }

  recordSuccess(): boolean {
    this.consecutiveFailures = 0;
    if (this.available) return false;
    this.available = true;
    return true;
  }

  recordFailure(): boolean {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures < MAX_CONSECUTIVE_FAILURES || !this.available) return false;
    this.available = false;
    return true;
  }

  /** True when an already-unavailable unit is due for another rediscovery sweep,
   *  so a DHCP move missed by the first attempt is still picked up later. */
  shouldRetryRediscovery(): boolean {
    return !this.available
      && this.consecutiveFailures > MAX_CONSECUTIVE_FAILURES
      && (this.consecutiveFailures - MAX_CONSECUTIVE_FAILURES) % REDISCOVERY_RETRY_EVERY === 0;
  }

  noteValveFault(state: string): boolean {
    if (state === this.lastValveFault) return false;
    this.lastValveFault = state;
    return true;
  }

  setTimer(timer: ReturnType<typeof setInterval>): void {
    this.pollTimer = timer;
  }

  clearTimer(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = undefined;
  }

  devices(): RegistryDevice[] {
    return this.gateway ? [this.gateway, ...this.sensors.values()] : [...this.sensors.values()];
  }
}

export class WaterguardRegistry {
  private readonly units = new Map<string, Unit>();

  private deps: RegistryDependencies;

  constructor(deps?: Partial<RegistryDependencies>) {
    this.deps = { ...defaultDependencies(), ...deps };
  }

  configure(deps: Partial<RegistryDependencies>): void {
    this.deps = { ...this.deps, ...deps };
  }

  private upsertUnit(unitId: string, deviceId: number, ip: string, port: number): Unit {
    const existing = this.units.get(unitId);
    if (existing) {
      existing.adopt(deviceId, ip, port);
      return existing;
    }
    const unit = new Unit(unitId, deviceId, ip, port);
    this.units.set(unitId, unit);
    return unit;
  }

  registerGateway(device: RegistryDevice, endpoint: GatewayEndpoint): void {
    const unit = this.upsertUnit(endpoint.unitId, endpoint.deviceId, endpoint.ip, endpoint.port);
    unit.gateway = device;
    unit.writePriority = endpoint.writePriority ?? DEFAULT_WRITE_PRIORITY;
    this.startPolling(unit);
  }

  registerSensor(unitId: string, sensorId: string, device: RegistryDevice): void {
    const unit = this.units.get(unitId) ?? this.upsertUnit(unitId, 0, '', 0);
    unit.sensors.set(sensorId, device);
    if (unit.gateway && unit.ip) {
      this.startPolling(unit);
    } else {
      // Gateway not added (or removed): show the sensor as unavailable rather
      // than letting it sit with stale/empty values until a gateway appears.
      unit.markUnavailable();
      device.setReachable(false, GATEWAY_UNAVAILABLE_MESSAGE);
    }
  }

  unregister(device: RegistryDevice): void {
    for (const unit of this.units.values()) {
      const removedGateway = unit.gateway === device;
      if (removedGateway) unit.gateway = undefined;
      for (const [sensorId, sensorDevice] of unit.sensors) {
        if (sensorDevice === device) unit.sensors.delete(sensorId);
      }
      if (!unit.gateway && unit.sensors.size === 0) {
        this.disposeUnit(unit);
      } else if (removedGateway) {
        this.handleGatewayRemoved(unit);
      }
    }
  }

  /** Gateway deleted but sensors remain: stop polling and mark the orphaned
   *  sensors unavailable. They recover when a gateway with the same unit id is
   *  re-added (same serial), since the first good poll flips them back. */
  private handleGatewayRemoved(unit: Unit): void {
    unit.clearTimer();
    unit.markUnavailable();
    for (const sensor of unit.sensors.values()) {
      sensor.setReachable(false, GATEWAY_UNAVAILABLE_MESSAGE);
    }
  }

  updateEndpoint(unitId: string, ip: string, port: number): void {
    const unit = this.units.get(unitId);
    if (!unit) return;
    unit.setEndpoint(ip, port);
    this.startPolling(unit);
  }

  private disposeUnit(unit: Unit): void {
    unit.clearTimer();
    this.units.delete(unit.unitId);
  }

  /** Stop every poll loop — used by tests and app shutdown. */
  dispose(): void {
    for (const unit of [...this.units.values()]) this.disposeUnit(unit);
  }

  private startPolling(unit: Unit): void {
    if (!unit.gateway || !unit.ip || unit.pollTimer) return;
    unit.setTimer(setInterval(() => {
      void this.poll(unit);
    }, this.deps.pollIntervalMs));
    void this.poll(unit);
  }

  private async ensureObjectMap(unit: Unit): Promise<boolean> {
    if (unit.objectMap) return true;
    try {
      const client = this.deps.getClient(unit.port);
      const objects = await this.deps.enumerate(client, unit.ip, unit.deviceId);
      unit.setObjectMap(buildObjectMap(objects));
      return true;
    } catch (error) {
      this.deps.logger?.error('registry.enumerate.failed', 'Object enumeration failed', error, {
        unitId: unit.unitId,
      });
      this.handleFailure(unit, error);
      return false;
    }
  }

  private poll(unit: Unit): Promise<void> {
    if (!unit.gateway || !unit.ip) return Promise.resolve();
    if (unit.inflight) return unit.inflight;
    const promise = this.runPoll(unit).finally(() => unit.clearInflight());
    unit.setInflight(promise);
    return promise;
  }

  private async runPoll(unit: Unit): Promise<void> {
    if (!(await this.ensureObjectMap(unit))) return;
    try {
      const values = await this.readAll(unit);
      this.handleSuccess(unit);
      this.distribute(unit, values);
    } catch (error) {
      this.handleFailure(unit, error);
    }
  }

  /** Poll a unit once, awaiting the full cycle (joins any in-flight poll).
   *  Used for tests and on-demand refresh. */
  async refresh(unitId: string): Promise<void> {
    const unit = this.units.get(unitId);
    if (unit) await this.poll(unit);
  }

  private async readAll(unit: Unit): Promise<PresentValues> {
    const map = unit.objectMap;
    if (!map) return new Map();
    const client = this.deps.getClient(unit.port);
    const specs = buildPollSpecs(map);
    try {
      const result = await readPropertyMultiple(client, unit.ip, specs);
      return extractPresentValues(result);
    } catch (rpmError) {
      this.deps.logger?.info('registry.poll.rpm_fallback', 'readPropertyMultiple failed; reading individually', {
        unitId: unit.unitId,
      });
      return this.readIndividually(unit.ip, client, specs.map((spec) => spec.objectId), rpmError);
    }
  }

  private async readIndividually(
    ip: string,
    client: BacnetClient,
    objects: ObjectRef[],
    rpmError: unknown,
  ): Promise<PresentValues> {
    const values: PresentValues = new Map();
    for (const objectId of objects) {
      try {
        const result = await readProperty(client, ip, objectId, PropertyId.PRESENT_VALUE);
        const scalar = asNumber(firstScalar(result));
        if (scalar !== undefined) values.set(objectKey(objectId.type, objectId.instance), scalar);
      } catch {
        // individual object failed — keep going; an empty result decides failure
      }
    }
    if (values.size === 0) throw rpmError;
    return values;
  }

  private distribute(unit: Unit, values: PresentValues): void {
    const map = unit.objectMap;
    if (!map) return;
    if (unit.gateway) this.distributeGateway(unit, unit.gateway, map, values);
    for (const [sensorId, device] of unit.sensors) {
      applySensorCapabilities(device, map, values, sensorId);
    }
  }

  private distributeGateway(unit: Unit, device: RegistryDevice, map: LinkboxObjectMap, values: PresentValues): void {
    const caps = deriveGatewayCapabilities(map, values);
    device.ensureCapabilityPresent('alarm_water.tape', caps.tapeLeakPresent);
    device.applyCapability('alarm_water', caps.alarm_water);
    if (caps.onoff !== undefined) {
      device.applyCapability('onoff', caps.onoff);
      device.applyCapability('valve_open', caps.onoff);
    }
    device.applyCapability('alarm_tamper', caps.alarm_tamper);
    device.applyCapability('alarm_generic', caps.alarm_generic);
    device.applyCapability('valve_alarm_state', caps.valve_alarm_state);
    device.applyCapability('cable_disconnected', caps.cable_disconnected);
    if (caps.tapeLeak !== undefined) device.applyCapability('alarm_water.tape', caps.tapeLeak);
    if (unit.noteValveFault(caps.valve_alarm_state)) {
      device.triggerFlow('valve_fault_changed', { state: caps.valve_alarm_state });
    }
  }

  private handleSuccess(unit: Unit): void {
    if (unit.recordSuccess()) {
      for (const device of unit.devices()) device.setReachable(true);
    }
  }

  private handleFailure(unit: Unit, error: unknown): void {
    const crossedThreshold = unit.recordFailure();
    this.deps.logger?.error('registry.poll.failed', 'Poll failed', error, { unitId: unit.unitId });
    if (crossedThreshold) {
      for (const device of unit.devices()) {
        device.setReachable(false, 'Linkbox+ unreachable — will auto-reconnect when found');
      }
      void this.rediscover(unit);
      return;
    }
    // Already unavailable: keep relocating it (e.g. after a DHCP IP change) on a
    // throttled cadence, not only on the single poll that first marked it down.
    if (unit.shouldRetryRediscovery()) void this.rediscover(unit);
  }

  private async rediscover(unit: Unit): Promise<void> {
    try {
      const found = await this.deps.discover();
      const match = found.find((linkbox) => linkbox.deviceId === unit.deviceId);
      if (!match || (match.ip === unit.ip && match.port === unit.port)) return;
      this.deps.logger?.info('registry.rediscovered', 'Linkbox+ moved; updating endpoint', {
        unitId: unit.unitId,
        ip: match.ip,
      });
      unit.setEndpoint(match.ip, match.port);
      void this.poll(unit);
    } catch (error) {
      this.deps.logger?.error('registry.rediscover.failed', 'Rediscovery failed', error, { unitId: unit.unitId });
    }
  }

  private requireUnit(unitId: string): Unit {
    const unit = this.units.get(unitId);
    if (!unit) throw new Error(`Unknown Linkbox+ unit ${unitId}`);
    return unit;
  }

  async setValveOpen(unitId: string, open: boolean): Promise<void> {
    const unit = this.requireUnit(unitId);
    const map = unit.objectMap;
    const openClose = map?.valve.openClose;
    const status1 = map?.valve.status1;
    if (!map || !openClose || !status1) throw new Error('Valve control is not available yet.');

    const commands = resolveValveCommands(map);
    const client = this.deps.getClient(unit.port);
    await writeProperty(client, unit.ip, {
      objectId: openClose,
      propertyId: PropertyId.PRESENT_VALUE,
      values: [{ type: ApplicationTag.UNSIGNED_INTEGER, value: open ? commands.openCmd : commands.closeCmd }],
      options: { priority: unit.writePriority },
    });
    await this.verifyValve(unit, status1, open);
    await this.poll(unit);
  }

  private async verifyValve(unit: Unit, status1: ObjectRef, open: boolean): Promise<void> {
    const map = unit.objectMap;
    if (!map) return;
    const expected = resolveValveStatusValues(map);
    const target = open ? expected.openValue : expected.closedValue;
    const client = this.deps.getClient(unit.port);
    // The write already went out; this only confirms the valve got there. A
    // motor-driven ball valve reads back as the old value or 'unknown' while
    // moving, so poll the status (treating reads/transitional values as "still
    // moving") and only fail if it never reaches target within the window.
    let status: number | undefined;
    for (let attempt = 0; attempt < VALVE_VERIFY_ATTEMPTS; attempt += 1) {
      if (attempt > 0) await this.deps.sleep(VALVE_VERIFY_INTERVAL_MS);
      try {
        status = asNumber(firstScalar(await readProperty(client, unit.ip, status1, PropertyId.PRESENT_VALUE)));
        if (status === target) return;
      } catch {
        // transient read while the valve is in motion — keep waiting
      }
    }
    throw new Error(`Valve did not reach ${open ? 'open' : 'closed'} (status read back as ${status ?? 'unknown'}).`);
  }

  async resetLeak(unitId: string): Promise<void> {
    const unit = this.requireUnit(unitId);
    const map = unit.objectMap;
    const reset = map?.hub.resetLeak;
    if (!map || !reset) throw new Error('Leak reset is not available.');
    const commands = resolveValveCommands(map);
    const client = this.deps.getClient(unit.port);
    await writeProperty(client, unit.ip, {
      objectId: reset,
      propertyId: PropertyId.PRESENT_VALUE,
      values: [{ type: ApplicationTag.UNSIGNED_INTEGER, value: commands.resetCmd }],
      options: { priority: unit.writePriority },
    });
    await this.poll(unit);
  }
}

function applySensorCapabilities(
  device: RegistryDevice,
  map: LinkboxObjectMap,
  values: PresentValues,
  sensorId: string,
): void {
  const caps = deriveSensorCapabilities(map, values, sensorId);
  if (!caps) return;
  device.applyCapability('alarm_water', caps.alarm_water);
  if (caps.measure_temperature !== undefined) {
    device.applyCapability('measure_temperature', caps.measure_temperature);
  }
  if (caps.measure_humidity !== undefined) {
    device.applyCapability('measure_humidity', caps.measure_humidity);
  }
  if (caps.measure_battery !== undefined) {
    device.applyCapability('measure_battery', caps.measure_battery);
  }
}

/** App-wide singleton, mirroring flexit's shared registry. */
export const Registry = new WaterguardRegistry();
