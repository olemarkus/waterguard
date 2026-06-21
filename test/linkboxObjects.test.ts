import { describe, it, expect } from 'vitest';
import {
  buildObjectMap,
  decodeStateValue,
  isLeakWet,
  isTamperActive,
  ObjectTypeId,
  parseObjectName,
  resolveStateValue,
  StatePattern,
  voltageToBatteryPercent,
} from '../lib/linkboxObjects';
import { defaultObjects, SENSOR_ONE, SENSOR_TWO } from './helpers/fakeLinkbox';

describe('parseObjectName', () => {
  it('classifies a wireless-sensor object with its ID prefix', () => {
    expect(parseObjectName('5149013726658557.waterMonitor:8.temperature')).toEqual({
      role: 'sensor',
      sensorId: '5149013726658557',
      field: 'temperature',
    });
  });

  it('classifies hub, valve, control and tamper objects', () => {
    expect(parseObjectName('waterMonitor:8.alarm')).toEqual({ role: 'hubWater', field: 'alarm' });
    expect(parseObjectName('valveMonitor:8.valveStatus1')).toEqual({ role: 'valveMonitor', field: 'valveStatus1' });
    expect(parseObjectName('valveControl:8.openClose')).toEqual({ role: 'valveControl' });
    expect(parseObjectName('waterTamper:0.state')).toEqual({ role: 'tamper' });
  });

  it('returns null for an unrecognised name', () => {
    expect(parseObjectName('something.else')).toBeNull();
  });
});

describe('buildObjectMap', () => {
  it('maps the dynamic layout into hub, valve and per-sensor objects', () => {
    const map = buildObjectMap(defaultObjects().map((object) => ({
      type: object.type,
      instance: object.instance,
      name: object.name,
      stateTexts: object.stateTexts,
    })));

    expect(map.hub.alarm).toEqual({ type: ObjectTypeId.ANALOG_INPUT, instance: 19 });
    expect(map.valve.openClose).toEqual({ type: ObjectTypeId.MULTI_STATE_OUTPUT, instance: 13 });
    expect(map.valve.status1?.instance).toBe(17);
    expect(map.tamper?.instance).toBe(23);
    expect([...map.sensors.keys()].sort()).toEqual([SENSOR_ONE, SENSOR_TWO].sort());
    expect(map.sensors.get(SENSOR_ONE)?.humidity?.instance).toBe(33);
    expect(map.sensors.get(SENSOR_TWO)?.humidity).toBeUndefined();
    expect(map.stateTexts.get(`${ObjectTypeId.MULTI_STATE_INPUT}:17`)).toEqual(['unknown', 'closed', 'open', 'unused']);
  });
});

describe('resolveStateValue', () => {
  it('returns the 1-based index whose text matches the pattern', () => {
    expect(resolveStateValue(['none', 'close', 'open'], StatePattern.OPEN, 99)).toBe(3);
    expect(resolveStateValue(['none', 'close', 'open'], StatePattern.CLOSE, 99)).toBe(2);
  });

  it('falls back when state text is missing or has no match', () => {
    expect(resolveStateValue(undefined, StatePattern.OPEN, 3)).toBe(3);
    expect(resolveStateValue(['a', 'b'], StatePattern.OPEN, 7)).toBe(7);
  });
});

describe('decodeStateValue', () => {
  it('decodes a 1-based value to its state text', () => {
    expect(decodeStateValue(['unknown', 'closed', 'open'], 2)).toBe('closed');
    expect(decodeStateValue(['unknown', 'closed', 'open'], 9)).toBeUndefined();
    expect(decodeStateValue(undefined, 1)).toBeUndefined();
  });
});

describe('leak and tamper interpretation', () => {
  it('treats a reading at or above the threshold as wet', () => {
    expect(isLeakWet(1)).toBe(true);
    expect(isLeakWet(0.5)).toBe(false);
    expect(isLeakWet(undefined)).toBe(false);
  });

  it('treats warning/error/override tamper states as active', () => {
    expect(isTamperActive(1)).toBe(false);
    expect(isTamperActive(3)).toBe(true);
    expect(isTamperActive(5)).toBe(true);
    expect(isTamperActive(7)).toBe(false);
  });
});

describe('voltageToBatteryPercent', () => {
  it('maps the documented battery curve and clamps to 0-100', () => {
    expect(voltageToBatteryPercent(3.3)).toBe(100);
    expect(voltageToBatteryPercent(2.2)).toBe(15);
    expect(voltageToBatteryPercent(4)).toBe(100);
    expect(voltageToBatteryPercent(1)).toBe(0);
  });
});
