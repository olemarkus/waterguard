/**
 * Thin promise wrappers around the callback-style bacstack client, plus value
 * extraction helpers. Shared by discovery and the registry.
 */
import type {
  BacnetClient,
  BacnetObjectId,
  BacnetReadAccessSpec,
  BacnetReadPropertyMultipleResult,
  BacnetReadPropertyResult,
  BacnetReadWriteOptions,
  BacnetValue,
  BacnetWriteValue,
} from 'bacstack';

export function readProperty(
  client: BacnetClient,
  ip: string,
  objectId: BacnetObjectId,
  propertyId: number,
): Promise<BacnetReadPropertyResult> {
  return new Promise((resolve, reject) => {
    client.readProperty(ip, objectId, propertyId, (err, value) => {
      if (err) reject(err);
      else resolve(value);
    });
  });
}

export function readPropertyMultiple(
  client: BacnetClient,
  ip: string,
  specs: BacnetReadAccessSpec[],
): Promise<BacnetReadPropertyMultipleResult> {
  return new Promise((resolve, reject) => {
    client.readPropertyMultiple(ip, specs, (err, value) => {
      if (err) reject(err);
      else resolve(value);
    });
  });
}

export type WriteRequest = {
  objectId: BacnetObjectId;
  propertyId: number;
  values: BacnetWriteValue[];
  options: BacnetReadWriteOptions;
};

export function writeProperty(client: BacnetClient, ip: string, request: WriteRequest): Promise<void> {
  return new Promise((resolve, reject) => {
    client.writeProperty(ip, request.objectId, request.propertyId, request.values, request.options, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

export function firstScalar(result: BacnetReadPropertyResult): BacnetValue | undefined {
  return result.values[0]?.value;
}

export function asNumber(value: BacnetValue | undefined): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

export function asString(value: BacnetValue | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function isObjectId(value: BacnetValue | undefined): value is BacnetObjectId {
  return (
    typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && 'type' in value
    && 'instance' in value
    && typeof (value as { type: unknown }).type === 'number'
    && typeof (value as { instance: unknown }).instance === 'number'
  );
}
