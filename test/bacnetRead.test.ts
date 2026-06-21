import { describe, it, expect } from 'vitest';
import {
  asNumber,
  asString,
  firstScalar,
  isObjectId,
  readProperty,
  readPropertyMultiple,
  writeProperty,
} from '../lib/bacnetRead';
import { ApplicationTag, ObjectTypeId, PropertyId } from '../lib/linkboxObjects';
import { FakeLinkbox } from './helpers/fakeLinkbox';

describe('value extraction helpers', () => {
  it('reads the first scalar and narrows by type', () => {
    expect(firstScalar({ values: [{ type: 4, value: 7 }] })).toBe(7);
    expect(asNumber(7)).toBe(7);
    expect(asNumber('7')).toBeUndefined();
    expect(asString('x')).toBe('x');
    expect(asString(7)).toBeUndefined();
  });

  it('recognises a BACnet object identifier', () => {
    expect(isObjectId({ type: 8, instance: 1001 })).toBe(true);
    expect(isObjectId({ errorClass: 2, errorCode: 40 })).toBe(false);
    expect(isObjectId(null as never)).toBe(false);
  });
});

describe('promisified client calls', () => {
  it('reads a single property', async () => {
    const fake = new FakeLinkbox();
    const result = await readProperty(fake.client, fake.ip, { type: ObjectTypeId.DEVICE, instance: 1001 }, PropertyId.MODEL_NAME);
    expect(asString(firstScalar(result))).toBe('Abra Linkbox+');
  });

  it('reads multiple present values', async () => {
    const fake = new FakeLinkbox();
    const result = await readPropertyMultiple(fake.client, fake.ip, [
      { objectId: { type: ObjectTypeId.ANALOG_INPUT, instance: 19 }, properties: [{ id: PropertyId.PRESENT_VALUE }] },
    ]);
    expect(result.values[0].values[0].value[0].value).toBe(0.5);
  });

  it('writes a present value and rejects on device error', async () => {
    const fake = new FakeLinkbox();
    await writeProperty(fake.client, fake.ip, {
      objectId: { type: ObjectTypeId.MULTI_STATE_OUTPUT, instance: 13 },
      propertyId: PropertyId.PRESENT_VALUE,
      values: [{ type: ApplicationTag.UNSIGNED_INTEGER, value: 3 }],
      options: { priority: 8 },
    });
    expect(fake.writes).toEqual([{ key: '14:13', value: 3 }]);

    fake.failWrites = true;
    await expect(writeProperty(fake.client, fake.ip, {
      objectId: { type: ObjectTypeId.MULTI_STATE_OUTPUT, instance: 13 },
      propertyId: PropertyId.PRESENT_VALUE,
      values: [{ type: ApplicationTag.UNSIGNED_INTEGER, value: 2 }],
      options: { priority: 8 },
    })).rejects.toThrow('write denied');
  });
});
