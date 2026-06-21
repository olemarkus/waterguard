/**
 * BACnet discovery for Abra Linkbox+ gateways: a broadcast Who-Is (filtered to
 * Fell Technology, vendor 1480, then validated by reading the Device identity),
 * a targeted probe for manual-IP pairing / rediscovery, and runtime enumeration
 * of the device's object list (the layout is dynamic, so we never hardcode it).
 */
import type { BacnetClient, BacnetObjectId, IAmEvent } from 'bacstack';
import { createBacnetClient } from './bacnetClient';
import { FixedDestinationTransport } from './bacnetTransport';
import {
  asNumber,
  asString,
  firstScalar,
  isObjectId,
  readProperty,
} from './bacnetRead';
import {
  DiscoveredObject,
  FELL_TECHNOLOGY_VENDOR_ID,
  ObjectTypeId,
  PropertyId,
} from './linkboxObjects';
import type { RuntimeLogger } from './logging';

export const DEFAULT_BACNET_PORT = 47808;
const DEFAULT_DISCOVERY_TIMEOUT_MS = 5000;
const PROBE_APDU_TIMEOUT_MS = 6000;

export type DiscoveredLinkbox = {
  deviceId: number;
  ip: string;
  port: number;
  model: string;
  name: string;
  serial?: string;
  vendorId: number;
};

export type DiscoveryOptions = {
  timeoutMs?: number;
  port?: number;
  logger?: RuntimeLogger;
};

function deviceObject(deviceId: number): BacnetObjectId {
  return { type: ObjectTypeId.DEVICE, instance: deviceId };
}

function isMultistate(type: number): boolean {
  return type === ObjectTypeId.MULTI_STATE_INPUT || type === ObjectTypeId.MULTI_STATE_OUTPUT;
}

function createProbeClient(port: number): BacnetClient {
  return createBacnetClient({
    apduTimeout: PROBE_APDU_TIMEOUT_MS,
    // Bind the well-known BACnet port itself (not an ephemeral one): a device
    // answers Who-Is with a *broadcast* I-Am to :<port> (ASHRAE 135 Annex J —
    // I-Am is an unconfirmed broadcast, not a unicast back to our source port),
    // so a socket on an ephemeral port would never hear it and discovery/manual
    // probe would find nothing. reuseAddr (set by the transport) lets these
    // transient discovery binds coexist; the pooled poll clients stay ephemeral
    // because confirmed reads/writes *do* reply to the request's source port.
    transport: new FixedDestinationTransport({
      localPort: port,
      targetPort: port,
      broadcastAddress: '255.255.255.255',
    }),
  });
}

type ProbeClientFactory = (port: number) => BacnetClient;
let probeClientFactory: ProbeClientFactory = createProbeClient;

export function setProbeClientFactoryForTests(factory: ProbeClientFactory): void {
  probeClientFactory = factory;
}

export function resetProbeClientFactoryForTests(): void {
  probeClientFactory = createProbeClient;
}

function collectIAm(
  client: BacnetClient,
  timeoutMs: number,
  logger?: RuntimeLogger,
  target?: string,
): Promise<IAmEvent[]> {
  return new Promise((resolve) => {
    const found = new Map<string, IAmEvent>();
    client.on('iAm', (device) => {
      found.set(`${device.address}:${device.deviceId}`, device);
      logger?.info('discovery.iam', 'Heard an I-Am from a BACnet device', {
        component: 'discovery',
        address: device.address,
        deviceId: device.deviceId,
        vendorId: (device as { vendorId?: number }).vendorId,
      });
    });
    // A directed (unicast) Who-Is reaches a device that doesn't answer broadcasts
    // or lives on another subnet; the broadcast still covers the normal case.
    if (target) client.whoIs({ address: target });
    client.whoIs();
    logger?.info('discovery.whois_sent', 'Sent Who-Is, waiting for I-Am responses', {
      component: 'discovery',
      timeoutMs,
      target: target ?? 'broadcast',
    });
    setTimeout(() => {
      logger?.info('discovery.window_closed', 'Who-Is listen window closed', {
        component: 'discovery',
        responders: found.size,
      });
      resolve([...found.values()]);
    }, timeoutMs);
  });
}

/** Log (instead of crash on) socket/transport errors from a transient probe
 *  client. The pooled poll clients get this in bacnetClient.ts; the probe client
 *  is created standalone, so without this an `error` event would be unhandled. */
function attachClientErrorLogger(client: BacnetClient, logger?: RuntimeLogger): void {
  client.on('error', (err) => {
    logger?.error('discovery.client_error', 'BACnet discovery client emitted an error', err, {
      component: 'discovery',
    });
  });
}

async function readIdentity(
  client: BacnetClient,
  ip: string,
  deviceId: number,
): Promise<{ model: string; name: string; vendorId: number; serial?: string }> {
  const object = deviceObject(deviceId);
  const model = asString(firstScalar(await readProperty(client, ip, object, PropertyId.MODEL_NAME))) ?? '';
  const name = asString(firstScalar(await readProperty(client, ip, object, PropertyId.OBJECT_NAME))) ?? '';
  const vendorId = asNumber(firstScalar(await readProperty(client, ip, object, PropertyId.VENDOR_IDENTIFIER))) ?? 0;
  let serial: string | undefined;
  try {
    serial = asString(firstScalar(await readProperty(client, ip, object, PropertyId.SERIAL_NUMBER)));
  } catch {
    serial = undefined;
  }
  return { model, name, vendorId, serial };
}

function looksLikeLinkbox(identity: { model: string; name: string; vendorId: number }): boolean {
  if (identity.vendorId === FELL_TECHNOLOGY_VENDOR_ID) return true;
  return /linkbox|abra/i.test(`${identity.model} ${identity.name}`);
}

async function validateCandidate(
  client: BacnetClient,
  ip: string,
  deviceId: number,
  port: number,
  logger?: RuntimeLogger,
): Promise<DiscoveredLinkbox | null> {
  try {
    const identity = await readIdentity(client, ip, deviceId);
    if (!looksLikeLinkbox(identity)) {
      logger?.info('discovery.rejected', 'Responder is not an Abra Linkbox+', {
        component: 'discovery',
        address: ip,
        deviceId,
        model: identity.model,
        name: identity.name,
        vendorId: identity.vendorId,
      });
      return null;
    }
    return { deviceId, ip, port, ...identity };
  } catch (err) {
    // A responder we heard but could not read identity from (timeout, wrong
    // port). Without this log it silently drops out of the device list.
    logger?.error('discovery.identity_failed', 'Failed to read identity of a responder', err, {
      component: 'discovery',
      address: ip,
      deviceId,
    });
    return null;
  }
}

/** Broadcast Who-Is, then validate each responder by reading its Device identity. */
export async function discoverLinkboxes(options: DiscoveryOptions = {}): Promise<DiscoveredLinkbox[]> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS;
  const port = options.port ?? DEFAULT_BACNET_PORT;
  const { logger } = options;
  const client = probeClientFactory(port);
  attachClientErrorLogger(client, logger);
  const byDeviceId = new Map<number, DiscoveredLinkbox>();
  logger?.info('discovery.start', 'Starting Linkbox discovery', { component: 'discovery', port, timeoutMs });
  try {
    const responders = await collectIAm(client, timeoutMs, logger);
    for (const responder of responders) {
      if (byDeviceId.has(responder.deviceId)) continue;
      const linkbox = await validateCandidate(client, responder.address, responder.deviceId, port, logger);
      if (linkbox) byDeviceId.set(linkbox.deviceId, linkbox);
    }
    const result = [...byDeviceId.values()];
    logger?.info('discovery.done', 'Linkbox discovery finished', {
      component: 'discovery',
      responders: responders.length,
      linkboxes: result.length,
    });
    return result;
  } finally {
    client.close();
  }
}

/** Validate a specific IP (manual pairing / rediscovery): directed + broadcast
 *  Who-Is, match the responder by address, read identity. */
export async function probeLinkboxAt(
  ip: string,
  port: number = DEFAULT_BACNET_PORT,
  timeoutMs: number = DEFAULT_DISCOVERY_TIMEOUT_MS,
  logger?: RuntimeLogger,
): Promise<DiscoveredLinkbox | null> {
  const client = probeClientFactory(port);
  attachClientErrorLogger(client, logger);
  logger?.info('probe.start', 'Probing a specific IP for a Linkbox', { component: 'discovery', ip, port, timeoutMs });
  try {
    const responders = await collectIAm(client, timeoutMs, logger, ip);
    const match = responders.find((responder) => responder.address === ip);
    if (!match) {
      logger?.info('probe.no_match', 'No responder matched the probed IP', {
        component: 'discovery',
        ip,
        responders: responders.length,
      });
      return null;
    }
    return validateCandidate(client, ip, match.deviceId, port, logger);
  } finally {
    client.close();
  }
}

async function readObjectList(client: BacnetClient, ip: string, deviceId: number): Promise<BacnetObjectId[]> {
  const result = await readProperty(client, ip, deviceObject(deviceId), PropertyId.OBJECT_LIST);
  return result.values
    .map((entry) => entry.value)
    .filter(isObjectId);
}

async function readStateTexts(client: BacnetClient, ip: string, object: BacnetObjectId): Promise<string[] | undefined> {
  if (!isMultistate(object.type)) return undefined;
  try {
    const result = await readProperty(client, ip, object, PropertyId.STATE_TEXT);
    const texts = result.values
      .map((entry) => entry.value)
      .filter((value): value is string => typeof value === 'string');
    return texts.length > 0 ? texts : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Read the device's object list and each object's name (+ state-text for
 * multistate objects), so the registry can build the dynamic object map.
 */
export async function enumerateObjects(
  client: BacnetClient,
  ip: string,
  deviceId: number,
): Promise<DiscoveredObject[]> {
  const objects = await readObjectList(client, ip, deviceId);
  const discovered: DiscoveredObject[] = [];
  for (const object of objects) {
    const name = asString(firstScalar(await readProperty(client, ip, object, PropertyId.OBJECT_NAME)));
    if (name === undefined) continue;
    const stateTexts = await readStateTexts(client, ip, object);
    discovered.push({ type: object.type, instance: object.instance, name, stateTexts });
  }
  return discovered;
}
