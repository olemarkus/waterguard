/**
 * Hand-written type surface for the subset of `bacstack@0.0.1-beta.14` this app
 * uses. The package ships no types; declaring the real shapes here keeps the
 * BACnet boundary fully typed so `@typescript-eslint/no-explicit-any` stays on
 * everywhere. Only the calls/events we actually use are declared.
 */
declare module 'bacstack' {
  export type BacnetObjectId = { type: number; instance: number };

  /** A decoded BACnet application value. `value` shape depends on `type`. */
  export type BacnetValue =
    | number
    | string
    | boolean
    | null
    | BacnetObjectId
    | { errorClass: number; errorCode: number }
    | BacnetValue[]
    | { [key: string]: BacnetValue };

  export type BacnetApplicationValue = { type: number; value: BacnetValue };

  export type BacnetPropertyRef = { id: number; index?: number };

  export type BacnetReadAccessSpec = {
    objectId: BacnetObjectId;
    properties: BacnetPropertyRef[];
  };

  /** Response shape of `readProperty`. */
  export type BacnetReadPropertyResult = {
    len?: number;
    objectId?: BacnetObjectId;
    property?: { id: number; index: number };
    values: BacnetApplicationValue[];
  };

  /** One object's results inside a `readPropertyMultiple` response. */
  export type BacnetReadAccessResult = {
    objectId: BacnetObjectId;
    values: Array<{
      property: { id: number; index: number };
      value: BacnetApplicationValue[];
    }>;
  };

  export type BacnetReadPropertyMultipleResult = {
    len?: number;
    values: BacnetReadAccessResult[];
  };

  export type BacnetWriteValue = { type: number; value: BacnetValue };

  export type BacnetReadWriteOptions = {
    maxSegments?: number;
    maxApdu?: number;
    arrayIndex?: number;
    priority?: number;
    invokeId?: number;
  };

  export type WhoIsOptions = { lowLimit?: number; highLimit?: number; address?: string };

  /** Payload of the `iAm` event emitted in response to `whoIs`. */
  export type IAmEvent = {
    address: string;
    deviceId: number;
    maxApdu: number;
    segmentation: number;
    vendorId: number;
  };

  /** Pluggable transport (e.g. a fixed-destination UDP socket for discovery). */
  export type BacnetTransport = {
    getBroadcastAddress(): string;
    getMaxPayload(): number;
    send(buffer: Buffer, offset: number, receiver: string): void;
    open(): void;
    close(): void;
  };

  export type BacnetClientOptions = {
    port?: number;
    interface?: string;
    broadcastAddress?: string;
    apduTimeout?: number;
    apduSize?: number;
    transport?: BacnetTransport;
  };

  type ErrCallback = (err: Error | null) => void;
  type ResultCallback<T> = (err: Error | null, result: T) => void;

  export type BacnetClient = {
    on(event: 'iAm', listener: (device: IAmEvent) => void): BacnetClient;
    on(event: 'error', listener: (err: Error) => void): BacnetClient;
    whoIs(options?: WhoIsOptions): void;
    readProperty(
      address: string,
      objectId: BacnetObjectId,
      propertyId: number,
      options: BacnetReadWriteOptions,
      next: ResultCallback<BacnetReadPropertyResult>,
    ): void;
    readProperty(
      address: string,
      objectId: BacnetObjectId,
      propertyId: number,
      next: ResultCallback<BacnetReadPropertyResult>,
    ): void;
    readPropertyMultiple(
      address: string,
      propertiesArray: BacnetReadAccessSpec[],
      options: BacnetReadWriteOptions,
      next: ResultCallback<BacnetReadPropertyMultipleResult>,
    ): void;
    readPropertyMultiple(
      address: string,
      propertiesArray: BacnetReadAccessSpec[],
      next: ResultCallback<BacnetReadPropertyMultipleResult>,
    ): void;
    writeProperty(
      address: string,
      objectId: BacnetObjectId,
      propertyId: number,
      values: BacnetWriteValue[],
      options: BacnetReadWriteOptions,
      next: ErrCallback,
    ): void;
    writeProperty(
      address: string,
      objectId: BacnetObjectId,
      propertyId: number,
      values: BacnetWriteValue[],
      next: ErrCallback,
    ): void;
    close(): void;
  };

  /** A named BACnet enum table (e.g. ObjectType), mapping name -> number. */
  export type BacnetEnumMap = Record<string, number>;

  export type BacnetEnums = {
    ObjectType: BacnetEnumMap;
    PropertyIdentifier: BacnetEnumMap;
    ApplicationTags: BacnetEnumMap;
    MaxSegmentsAccepted: BacnetEnumMap;
    MaxApduLengthAccepted: BacnetEnumMap;
    Segmentation: BacnetEnumMap;
    ASN1_ARRAY_ALL: number;
    [key: string]: BacnetEnumMap | number;
  };

  export type BacnetStatic = {
    new (options?: BacnetClientOptions): BacnetClient;
    enum: BacnetEnums;
  };

  const Bacstack: BacnetStatic;
  export default Bacstack;
}
