import {
  describe, it, expect, afterEach,
} from 'vitest';
import {
  discoverLinkboxes,
  enumerateObjects,
  probeLinkboxAt,
  resetProbeClientFactoryForTests,
  setProbeClientFactoryForTests,
} from '../lib/waterguardDiscovery';
import { FakeLinkbox } from './helpers/fakeLinkbox';

afterEach(() => resetProbeClientFactoryForTests());

describe('discoverLinkboxes', () => {
  it('returns Fell Technology gateways validated by their identity', async () => {
    const fake = new FakeLinkbox({ serial: 'SN-1' });
    setProbeClientFactoryForTests(() => fake.client);
    const found = await discoverLinkboxes({ timeoutMs: 5 });
    expect(found).toEqual([{
      deviceId: 1001,
      ip: '192.168.1.143',
      port: 47808,
      model: 'Abra Linkbox+',
      name: 'Abra Linkbox+',
      serial: 'SN-1',
      vendorId: 1480,
    }]);
  });

  it('ignores responders that are neither Fell Technology nor named like a Linkbox', async () => {
    const fake = new FakeLinkbox({ vendorId: 99, model: 'Some Thermostat' });
    setProbeClientFactoryForTests(() => fake.client);
    expect(await discoverLinkboxes({ timeoutMs: 5 })).toEqual([]);
  });
});

describe('probeLinkboxAt', () => {
  it('matches the responder by IP address', async () => {
    const fake = new FakeLinkbox();
    setProbeClientFactoryForTests(() => fake.client);
    const result = await probeLinkboxAt('192.168.1.143', 47808, 5);
    expect(result?.deviceId).toBe(1001);
  });

  it('returns null when no responder matches the address', async () => {
    const fake = new FakeLinkbox();
    setProbeClientFactoryForTests(() => fake.client);
    expect(await probeLinkboxAt('10.0.0.9', 47808, 5)).toBeNull();
  });

  it('issues a directed unicast Who-Is to the probed address', async () => {
    const fake = new FakeLinkbox();
    setProbeClientFactoryForTests(() => fake.client);
    await probeLinkboxAt('192.168.1.143', 47808, 5);
    expect(fake.whoIsCalls).toContainEqual({ address: '192.168.1.143' });
  });
});

describe('enumerateObjects', () => {
  it('reads every object name and the state text of multistate objects', async () => {
    const fake = new FakeLinkbox();
    const objects = await enumerateObjects(fake.client, fake.ip, fake.deviceId);
    const openClose = objects.find((object) => object.name === 'valveControl:8.openClose');
    const analog = objects.find((object) => object.name === 'waterMonitor:8.alarm');
    expect(openClose?.stateTexts).toEqual(['none', 'close', 'open']);
    expect(analog?.stateTexts).toBeUndefined();
    expect(objects.length).toBe(fake.objects.size);
  });
});
