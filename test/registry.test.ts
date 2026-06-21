import {
  describe, it, expect, afterEach,
} from 'vitest';
import { WaterguardRegistry, GatewayEndpoint } from '../lib/WaterguardRegistry';
import { enumerateObjects } from '../lib/waterguardDiscovery';
import { FakeLinkbox, SENSOR_ONE } from './helpers/fakeLinkbox';

const ENDPOINT: GatewayEndpoint = {
  unitId: 'abra-1001', deviceId: 1001, ip: '192.168.1.143', port: 47808, writePriority: 8,
};

function fakeDevice() {
  const caps = new Map<string, any>();
  const present = new Set<string>();
  return {
    caps,
    present,
    reachable: true,
    triggers: [] as Array<{ trigger: string; tokens: any }>,
    applyCapability(capability: string, value: any) { caps.set(capability, value); },
    ensureCapabilityPresent(capability: string, isPresent: boolean) {
      if (isPresent) present.add(capability);
      else present.delete(capability);
    },
    setReachable(reachable: boolean) { this.reachable = reachable; },
    triggerFlow(trigger: string, tokens: any) { this.triggers.push({ trigger, tokens }); },
  };
}

function makeRegistry(fake: FakeLinkbox, overrides: Record<string, any> = {}) {
  const registry = new WaterguardRegistry({
    getClient: () => fake.client,
    enumerate: (client, ip, deviceId) => enumerateObjects(client, ip, deviceId),
    discover: async () => [],
    pollIntervalMs: 1_000_000,
    sleep: async () => {}, // don't actually wait between valve-verify retries
    ...overrides,
  });
  return registry;
}

const registries: WaterguardRegistry[] = [];
function track(registry: WaterguardRegistry) {
  registries.push(registry);
  return registry;
}
afterEach(() => {
  for (const registry of registries.splice(0)) registry.dispose();
});

describe('gateway polling', () => {
  it('distributes the gateway capabilities and registers the tape sub-capability', async () => {
    const fake = new FakeLinkbox();
    const registry = track(makeRegistry(fake));
    const gateway = fakeDevice();
    registry.registerGateway(gateway, ENDPOINT);
    await registry.refresh(ENDPOINT.unitId);

    expect(gateway.caps.get('alarm_water')).toBe(false);
    expect(gateway.caps.get('onoff')).toBe(false);
    expect(gateway.caps.get('valve_open')).toBe(false);
    expect(gateway.caps.get('alarm_tamper')).toBe(false);
    expect(gateway.caps.get('valve_alarm_state')).toBe('noAlarm');
    expect(gateway.present.has('alarm_water.tape')).toBe(true);
  });

  it('fires the valve fault trigger only when the fault state changes', async () => {
    const fake = new FakeLinkbox();
    const registry = track(makeRegistry(fake));
    const gateway = fakeDevice();
    registry.registerGateway(gateway, ENDPOINT);
    await registry.refresh(ENDPOINT.unitId);
    expect(gateway.triggers).toHaveLength(1); // initial noAlarm

    fake.setPresent('valveMonitor:8.alarm', 6);
    await registry.refresh(ENDPOINT.unitId);
    expect(gateway.triggers.at(-1)).toEqual({ trigger: 'valve_fault_changed', tokens: { state: 'timeoutOpen' } });

    await registry.refresh(ENDPOINT.unitId);
    expect(gateway.triggers).toHaveLength(2); // unchanged -> no new trigger
  });
});

describe('valve commands', () => {
  it('writes the open command resolved from state text and verifies the read-back', async () => {
    const fake = new FakeLinkbox();
    const registry = track(makeRegistry(fake));
    registry.registerGateway(fakeDevice(), ENDPOINT);
    await registry.refresh(ENDPOINT.unitId);

    await registry.setValveOpen(ENDPOINT.unitId, true);
    expect(fake.writes).toContainEqual({ key: '14:13', value: 3 });
    expect(fake.byName('valveMonitor:8.valveStatus1').present).toBe(3);

    await registry.setValveOpen(ENDPOINT.unitId, false);
    expect(fake.writes).toContainEqual({ key: '14:13', value: 2 });
  });

  it('confirms the valve only after a slow ball valve finishes travelling', async () => {
    const fake = new FakeLinkbox();
    const base = fake.client;
    let statusReads = 0;
    // A motor-driven valve reads back 'unknown' (1) for the first reads while it
    // is moving, then reaches 'open' (3); verify must wait it out, not fail.
    const client = {
      ...base,
      readProperty(ip: string, objectId: any, propertyId: number, a: any, b?: any) {
        if (objectId.type === 13 && objectId.instance === 17 && propertyId === 85) {
          statusReads += 1;
          if (statusReads <= 2) return (b ?? a)(null, { values: [{ type: 4, value: 1 }] });
        }
        return base.readProperty(ip, objectId, propertyId, a, b);
      },
    };
    const registry = track(makeRegistry(fake, { getClient: () => client }));
    registry.registerGateway(fakeDevice(), ENDPOINT);
    await registry.refresh(ENDPOINT.unitId);

    await expect(registry.setValveOpen(ENDPOINT.unitId, true)).resolves.toBeUndefined();
    expect(statusReads).toBeGreaterThan(2); // retried past the 'moving' reads
  });

  it('throws if the valve does not reach the requested state', async () => {
    const fake = new FakeLinkbox();
    // Make the write a no-op so the read-back never matches.
    const original = fake.client;
    const client = { ...original, writeProperty: (_ip: string, _o: any, _p: number, _v: any, _opt: any, cb: any) => cb(null) };
    const registry = track(makeRegistry(fake, { getClient: () => client }));
    registry.registerGateway(fakeDevice(), ENDPOINT);
    await registry.refresh(ENDPOINT.unitId);

    await expect(registry.setValveOpen(ENDPOINT.unitId, true)).rejects.toThrow(/did not reach open/);
  });

  it('writes the reset-leak command', async () => {
    const fake = new FakeLinkbox();
    const registry = track(makeRegistry(fake));
    registry.registerGateway(fakeDevice(), ENDPOINT);
    await registry.refresh(ENDPOINT.unitId);

    await registry.resetLeak(ENDPOINT.unitId);
    expect(fake.writes).toContainEqual({ key: '14:22', value: 2 });
  });

  it('rejects commands for an unknown unit', async () => {
    const registry = track(makeRegistry(new FakeLinkbox()));
    await expect(registry.setValveOpen('nope', true)).rejects.toThrow(/Unknown/);
  });
});

describe('sensors', () => {
  it('routes a wireless sensor to its own device', async () => {
    const fake = new FakeLinkbox();
    const registry = track(makeRegistry(fake));
    registry.registerGateway(fakeDevice(), ENDPOINT);
    const sensor = fakeDevice();
    registry.registerSensor(ENDPOINT.unitId, SENSOR_ONE, sensor);
    await registry.refresh(ENDPOINT.unitId);

    expect(sensor.caps.get('measure_temperature')).toBe(21);
    expect(sensor.caps.get('measure_humidity')).toBe(45);
    expect(sensor.caps.get('measure_battery')).toBe(85);
    expect(sensor.caps.get('alarm_water')).toBe(false);
  });
});

describe('device lifecycle', () => {
  it('registers a sensor that joined before its gateway', async () => {
    const fake = new FakeLinkbox();
    const registry = track(makeRegistry(fake));
    const sensor = fakeDevice();
    registry.registerSensor(ENDPOINT.unitId, SENSOR_ONE, sensor);
    registry.registerGateway(fakeDevice(), ENDPOINT);
    await registry.refresh(ENDPOINT.unitId);
    expect(sensor.caps.get('measure_temperature')).toBe(21);
  });

  it('re-points to a new endpoint without re-pairing', async () => {
    const fake = new FakeLinkbox();
    const registry = track(makeRegistry(fake));
    const gateway = fakeDevice();
    registry.registerGateway(gateway, ENDPOINT);
    await registry.refresh(ENDPOINT.unitId);
    registry.updateEndpoint(ENDPOINT.unitId, '192.168.1.200', 47808);
    registry.updateEndpoint('unknown-unit', 'x', 1); // no-op, must not throw
    await registry.refresh(ENDPOINT.unitId);
    expect(gateway.caps.get('valve_alarm_state')).toBe('noAlarm');
  });

  it('keeps a sensor unavailable until its gateway is present', async () => {
    const fake = new FakeLinkbox();
    const registry = track(makeRegistry(fake));
    const sensor = fakeDevice();
    registry.registerSensor(ENDPOINT.unitId, SENSOR_ONE, sensor);
    expect(sensor.reachable).toBe(false);

    registry.registerGateway(fakeDevice(), ENDPOINT);
    await registry.refresh(ENDPOINT.unitId);
    expect(sensor.reachable).toBe(true);
  });

  it('marks orphaned sensors unavailable when the gateway is removed and recovers them on re-add', async () => {
    const fake = new FakeLinkbox();
    const registry = track(makeRegistry(fake));
    const gateway = fakeDevice();
    const sensor = fakeDevice();
    registry.registerGateway(gateway, ENDPOINT);
    registry.registerSensor(ENDPOINT.unitId, SENSOR_ONE, sensor);
    await registry.refresh(ENDPOINT.unitId);
    expect(sensor.reachable).toBe(true);

    registry.unregister(gateway);
    expect(sensor.reachable).toBe(false);

    registry.registerGateway(fakeDevice(), ENDPOINT);
    await registry.refresh(ENDPOINT.unitId);
    expect(sensor.reachable).toBe(true);
  });

  it('disposes a unit once its last device unregisters', async () => {
    const fake = new FakeLinkbox();
    const registry = track(makeRegistry(fake));
    const gateway = fakeDevice();
    registry.registerGateway(gateway, ENDPOINT);
    await registry.refresh(ENDPOINT.unitId);
    registry.unregister(gateway);
    await expect(registry.setValveOpen(ENDPOINT.unitId, true)).rejects.toThrow(/Unknown/);
  });
});

describe('availability and resilience', () => {
  it('marks devices unreachable after repeated failures and recovers', async () => {
    const fake = new FakeLinkbox();
    const registry = track(makeRegistry(fake));
    const gateway = fakeDevice();
    registry.registerGateway(gateway, ENDPOINT);
    await registry.refresh(ENDPOINT.unitId); // build the map while healthy

    fake.failReads = true;
    await registry.refresh(ENDPOINT.unitId);
    await registry.refresh(ENDPOINT.unitId);
    expect(gateway.reachable).toBe(true); // not yet at the threshold
    await registry.refresh(ENDPOINT.unitId);
    expect(gateway.reachable).toBe(false);

    fake.failReads = false;
    await registry.refresh(ENDPOINT.unitId);
    expect(gateway.reachable).toBe(true);
  });

  it('updates the endpoint when a failed unit is rediscovered at a new address', async () => {
    const fake = new FakeLinkbox();
    const moved = {
      deviceId: 1001, ip: '192.168.1.250', port: 47808, model: 'Abra Linkbox+', name: 'Abra Linkbox+', vendorId: 1480,
    };
    const registry = track(makeRegistry(fake, { discover: async () => [moved] }));
    const gateway = fakeDevice();
    registry.registerGateway(gateway, ENDPOINT);
    await registry.refresh(ENDPOINT.unitId);

    fake.failReads = true;
    await registry.refresh(ENDPOINT.unitId);
    await registry.refresh(ENDPOINT.unitId);
    await registry.refresh(ENDPOINT.unitId); // crosses threshold -> triggers rediscovery
    await new Promise((resolve) => { setTimeout(resolve, 5); });

    fake.failReads = false;
    await registry.refresh(ENDPOINT.unitId);
    expect(gateway.reachable).toBe(true);
  });

  it('keeps retrying rediscovery while a moved unit stays unavailable', async () => {
    const fake = new FakeLinkbox();
    const moved = {
      deviceId: 1001, ip: '192.168.1.250', port: 47808, model: 'Abra Linkbox+', name: 'Abra Linkbox+', vendorId: 1480,
    };
    let discoverCalls = 0;
    // The first rediscovery (on the threshold-crossing poll) misses; a later one
    // finds the device at its new address.
    const registry = track(makeRegistry(fake, {
      discover: async () => {
        discoverCalls += 1;
        return discoverCalls >= 2 ? [moved] : [];
      },
    }));
    const gateway = fakeDevice();
    registry.registerGateway(gateway, ENDPOINT);
    await registry.refresh(ENDPOINT.unitId);

    fake.failReads = true;
    for (let i = 0; i < 6; i += 1) await registry.refresh(ENDPOINT.unitId); // cross threshold, then retry
    await new Promise((resolve) => { setTimeout(resolve, 5); });
    expect(discoverCalls).toBeGreaterThanOrEqual(2);

    fake.failReads = false;
    await registry.refresh(ENDPOINT.unitId);
    expect(gateway.reachable).toBe(true);
  });

  it('falls back to individual reads when readPropertyMultiple fails', async () => {
    const fake = new FakeLinkbox();
    const client = {
      ...fake.client,
      readPropertyMultiple: (_ip: string, _specs: any, a: any, b?: any) => (b ?? a)(new Error('RPM unsupported')),
    };
    const registry = track(makeRegistry(fake, { getClient: () => client }));
    const gateway = fakeDevice();
    registry.registerGateway(gateway, ENDPOINT);
    await registry.refresh(ENDPOINT.unitId);

    expect(gateway.caps.get('valve_alarm_state')).toBe('noAlarm');
    expect(gateway.reachable).toBe(true);
  });
});
