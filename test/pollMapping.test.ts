import { describe, it, expect } from 'vitest';
import { buildObjectMap, objectKey, ObjectTypeId } from '../lib/linkboxObjects';
import {
  buildPollSpecs,
  deriveGatewayCapabilities,
  deriveSensorCapabilities,
  extractPresentValues,
  PresentValues,
  resolveValveCommands,
  resolveValveStatusValues,
} from '../lib/pollMapping';
import { defaultObjects, FakeObject, SENSOR_ONE, SENSOR_TWO } from './helpers/fakeLinkbox';

function mapFrom(objects: FakeObject[] = defaultObjects()) {
  return buildObjectMap(objects.map((object) => ({
    type: object.type,
    instance: object.instance,
    name: object.name,
    stateTexts: object.stateTexts,
  })));
}

function valuesFrom(objects: FakeObject[] = defaultObjects()): PresentValues {
  const values: PresentValues = new Map();
  for (const object of objects) values.set(objectKey(object.type, object.instance), object.present);
  return values;
}

describe('buildPollSpecs', () => {
  it('produces one present-value spec per present object', () => {
    const specs = buildPollSpecs(mapFrom());
    expect(specs.length).toBeGreaterThan(10);
    expect(specs.every((spec) => spec.properties[0].id === 85)).toBe(true);
  });
});

describe('extractPresentValues', () => {
  it('reads the nested present-value out of a readPropertyMultiple response', () => {
    const result = {
      values: [{
        objectId: { type: ObjectTypeId.ANALOG_INPUT, instance: 19 },
        values: [{ property: { id: 85, index: 0 }, value: [{ type: 4, value: 0.5 }] }],
      }],
    };
    expect(extractPresentValues(result)).toEqual(new Map([[`${ObjectTypeId.ANALOG_INPUT}:19`, 0.5]]));
  });
});

describe('deriveGatewayCapabilities', () => {
  it('reports no leak, a closed valve and no faults for an idle device', () => {
    const caps = deriveGatewayCapabilities(mapFrom(), valuesFrom());
    expect(caps.alarm_water).toBe(false);
    expect(caps.onoff).toBe(false); // valveStatus1 = 2 (closed) via state text
    expect(caps.alarm_tamper).toBe(false);
    expect(caps.alarm_generic).toBe(false);
    expect(caps.valve_alarm_state).toBe('noAlarm');
    expect(caps.cable_disconnected).toBe(false);
    expect(caps.tapeLeakPresent).toBe(true);
  });

  it('flags a disconnected valve actuator cable from the waterMonitor:8.cable object', () => {
    const objects = defaultObjects();
    const cable = objects.find((object) => object.name === 'waterMonitor:8.cable')!;
    expect(mapFrom(objects).valve.cable).toBeDefined(); // the real device name must parse
    cable.present = 3; // disconnected
    expect(deriveGatewayCapabilities(mapFrom(objects), valuesFrom(objects)).cable_disconnected).toBe(true);
  });

  it('raises the water alarm when the hub alarm reads 1', () => {
    const objects = defaultObjects();
    objects.find((object) => object.name === 'waterMonitor:8.alarm')!.present = 1;
    expect(deriveGatewayCapabilities(mapFrom(objects), valuesFrom(objects)).alarm_water).toBe(true);
  });

  it('maps valveStatus 3 to an open valve and a non-noAlarm state to a fault', () => {
    const objects = defaultObjects();
    objects.find((object) => object.name === 'valveMonitor:8.valveStatus1')!.present = 3;
    objects.find((object) => object.name === 'valveMonitor:8.alarm')!.present = 6;
    const caps = deriveGatewayCapabilities(mapFrom(objects), valuesFrom(objects));
    expect(caps.onoff).toBe(true);
    expect(caps.alarm_generic).toBe(true);
    expect(caps.valve_alarm_state).toBe('timeoutOpen');
  });

  it('leaves onoff undefined when the valve status is unknown', () => {
    const objects = defaultObjects();
    objects.find((object) => object.name === 'valveMonitor:8.valveStatus1')!.present = 1;
    expect(deriveGatewayCapabilities(mapFrom(objects), valuesFrom(objects)).onoff).toBeUndefined();
  });

  it('marks the water alarm known when at least one leak source reported', () => {
    expect(deriveGatewayCapabilities(mapFrom(), valuesFrom()).alarmWaterKnown).toBe(true);
  });

  it('marks the water alarm unknown when no leak source reported this poll', () => {
    const objects = defaultObjects();
    const map = mapFrom(objects);
    const values = valuesFrom(objects);
    if (map.hub.alarm) values.delete(objectKey(map.hub.alarm.type, map.hub.alarm.instance));
    if (map.hub.tapeLeak) values.delete(objectKey(map.hub.tapeLeak.type, map.hub.tapeLeak.instance));
    expect(deriveGatewayCapabilities(map, values).alarmWaterKnown).toBe(false);
  });
});

describe('deriveSensorCapabilities', () => {
  it('derives leak, temperature, humidity and a battery percentage', () => {
    const caps = deriveSensorCapabilities(mapFrom(), valuesFrom(), SENSOR_ONE);
    expect(caps?.alarm_water).toBe(false);
    expect(caps?.measure_temperature).toBe(21);
    expect(caps?.measure_humidity).toBe(45);
    expect(caps?.measure_battery).toBe(85); // 3.1 V on the documented curve
  });

  it('omits humidity for a sensor that lacks it and flags a wet leak point', () => {
    const objects = defaultObjects();
    objects.find((object) => object.name === `${SENSOR_TWO}.waterMonitor:8.leak1`)!.present = 1;
    const caps = deriveSensorCapabilities(mapFrom(objects), valuesFrom(objects), SENSOR_TWO);
    expect(caps?.measure_humidity).toBeUndefined();
    expect(caps?.alarm_water).toBe(true);
  });

  it('returns undefined for an unknown sensor id', () => {
    expect(deriveSensorCapabilities(mapFrom(), valuesFrom(), 'nope')).toBeUndefined();
  });

  it('marks the leak alarm unknown when the sensor reported no leak points this poll', () => {
    const objects = defaultObjects();
    const map = mapFrom(objects);
    const values = valuesFrom(objects);
    const sensor = map.sensors.get(SENSOR_ONE)!;
    if (sensor.leak1) values.delete(objectKey(sensor.leak1.type, sensor.leak1.instance));
    if (sensor.leak2) values.delete(objectKey(sensor.leak2.type, sensor.leak2.instance));
    expect(deriveSensorCapabilities(map, values, SENSOR_ONE)?.alarmWaterKnown).toBe(false);
  });
});

describe('valve command and status resolution', () => {
  it('resolves open/close/reset from the device state text', () => {
    expect(resolveValveCommands(mapFrom())).toEqual({ openCmd: 3, closeCmd: 2, resetCmd: 2 });
    expect(resolveValveStatusValues(mapFrom())).toEqual({ openValue: 3, closedValue: 2 });
  });

  it('falls back to documented values when state text is absent', () => {
    const objects = defaultObjects().map((object) => ({ ...object, stateTexts: undefined }));
    expect(resolveValveCommands(mapFrom(objects))).toEqual({ openCmd: 3, closeCmd: 2, resetCmd: 2 });
  });
});
