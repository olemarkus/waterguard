/**
 * Pure mapping between a BACnet poll response and Homey capability values. The
 * valve open/close/fault semantics are resolved from each object's STATE_TEXT
 * (read from the device) and only fall back to documented constants — so we
 * never trust a hardcoded polarity for a safety-critical valve.
 */
import type { BacnetReadAccessSpec, BacnetReadPropertyMultipleResult } from 'bacstack';
import {
  CABLE_DISCONNECTED_FALLBACK,
  decodeStateValue,
  isLeakWet,
  isTamperActive,
  LinkboxObjectMap,
  ObjectRef,
  objectKey,
  PropertyId,
  RESET_LEAK_FALLBACK,
  resolveStateValue,
  StatePattern,
  VALVE_COMMAND_FALLBACK,
  VALVE_STATUS_FALLBACK,
  voltageToBatteryPercent,
} from './linkboxObjects';

export type PresentValues = Map<string, number>;

export type GatewayCapabilities = {
  alarm_water: boolean;
  // The leak value stays a hard boolean; this flag says whether any leak source
  // reported this poll. When false, leave alarm_water unchanged (do not clear it
  // from a transient missing read).
  alarmWaterKnown: boolean;
  onoff?: boolean;
  alarm_tamper: boolean;
  alarm_generic: boolean;
  valve_alarm_state: string;
  cable_disconnected: boolean;
  tapeLeakPresent: boolean;
  tapeLeak?: boolean;
};

export type SensorCapabilities = {
  alarm_water: boolean;
  alarmWaterKnown: boolean;
  measure_temperature?: number;
  measure_humidity?: number;
  measure_battery?: number;
};

export type ValveCommands = { openCmd: number; closeCmd: number; resetCmd: number };
export type ValveStatusValues = { openValue: number; closedValue: number };

function collectRefs(map: LinkboxObjectMap): ObjectRef[] {
  const refs: ObjectRef[] = [];
  const push = (ref?: ObjectRef): void => {
    if (ref) refs.push(ref);
  };
  push(map.hub.alarm);
  push(map.hub.tapeLeak);
  push(map.valve.status1);
  push(map.valve.status2);
  push(map.valve.alarm);
  push(map.valve.numValves);
  push(map.valve.cable);
  push(map.tamper);
  for (const sensor of map.sensors.values()) {
    push(sensor.leak1);
    push(sensor.leak2);
    push(sensor.temperature);
    push(sensor.humidity);
    push(sensor.batteryVoltage);
  }
  return refs;
}

export function buildPollSpecs(map: LinkboxObjectMap): BacnetReadAccessSpec[] {
  return collectRefs(map).map((objectId) => ({
    objectId,
    properties: [{ id: PropertyId.PRESENT_VALUE }],
  }));
}

export function extractPresentValues(result: BacnetReadPropertyMultipleResult): PresentValues {
  const values: PresentValues = new Map();
  for (const object of result.values) {
    const scalar = object.values[0]?.value[0]?.value;
    if (typeof scalar === 'number') {
      values.set(objectKey(object.objectId.type, object.objectId.instance), scalar);
    }
  }
  return values;
}

function valueOf(values: PresentValues, ref?: ObjectRef): number | undefined {
  return ref ? values.get(objectKey(ref.type, ref.instance)) : undefined;
}

function textsFor(map: LinkboxObjectMap, ref?: ObjectRef): string[] | undefined {
  return ref ? map.stateTexts.get(objectKey(ref.type, ref.instance)) : undefined;
}

function deriveOnoff(map: LinkboxObjectMap, values: PresentValues): boolean | undefined {
  const status = valueOf(values, map.valve.status1);
  if (status === undefined) return undefined;
  const texts = textsFor(map, map.valve.status1);
  const openValue = resolveStateValue(texts, StatePattern.OPEN, VALVE_STATUS_FALLBACK.OPEN);
  const closedValue = resolveStateValue(texts, StatePattern.CLOSED, VALVE_STATUS_FALLBACK.CLOSED);
  if (status === openValue) return true;
  if (status === closedValue) return false;
  return undefined; // unknown/unused — leave the capability unchanged
}

function deriveValveFault(map: LinkboxObjectMap, values: PresentValues): { active: boolean; state: string } {
  const alarm = valueOf(values, map.valve.alarm);
  const texts = textsFor(map, map.valve.alarm);
  const noAlarmValue = resolveStateValue(texts, StatePattern.NO_ALARM, 1);
  if (alarm === undefined) return { active: false, state: 'unknown' };
  return {
    active: alarm !== noAlarmValue,
    state: decodeStateValue(texts, alarm) ?? `state ${alarm}`,
  };
}

function deriveCableDisconnected(map: LinkboxObjectMap, values: PresentValues): boolean {
  const cable = valueOf(values, map.valve.cable);
  if (cable === undefined) return false;
  const texts = textsFor(map, map.valve.cable);
  const disconnected = resolveStateValue(texts, StatePattern.DISCONNECTED, CABLE_DISCONNECTED_FALLBACK);
  return cable === disconnected;
}

export function deriveGatewayCapabilities(map: LinkboxObjectMap, values: PresentValues): GatewayCapabilities {
  const hubAlarm = valueOf(values, map.hub.alarm);
  const tapeLeak = valueOf(values, map.hub.tapeLeak);
  const fault = deriveValveFault(map, values);
  const tapeLeakPresent = map.hub.tapeLeak !== undefined;
  return {
    alarm_water: isLeakWet(hubAlarm) || isLeakWet(tapeLeak),
    alarmWaterKnown: hubAlarm !== undefined || tapeLeak !== undefined,
    onoff: deriveOnoff(map, values),
    alarm_tamper: isTamperActive(valueOf(values, map.tamper)),
    alarm_generic: fault.active,
    valve_alarm_state: fault.state,
    cable_disconnected: deriveCableDisconnected(map, values),
    tapeLeakPresent,
    tapeLeak: tapeLeakPresent ? isLeakWet(tapeLeak) : undefined,
  };
}

export function deriveSensorCapabilities(
  map: LinkboxObjectMap,
  values: PresentValues,
  sensorId: string,
): SensorCapabilities | undefined {
  const sensor = map.sensors.get(sensorId);
  if (!sensor) return undefined;
  const leak1 = valueOf(values, sensor.leak1);
  const leak2 = valueOf(values, sensor.leak2);
  const voltage = valueOf(values, sensor.batteryVoltage);
  return {
    alarm_water: isLeakWet(leak1) || isLeakWet(leak2),
    alarmWaterKnown: leak1 !== undefined || leak2 !== undefined,
    measure_temperature: valueOf(values, sensor.temperature),
    measure_humidity: valueOf(values, sensor.humidity),
    measure_battery: voltage === undefined ? undefined : voltageToBatteryPercent(voltage),
  };
}

export function resolveValveCommands(map: LinkboxObjectMap): ValveCommands {
  const openTexts = textsFor(map, map.valve.openClose);
  const resetTexts = textsFor(map, map.hub.resetLeak);
  return {
    openCmd: resolveStateValue(openTexts, StatePattern.OPEN, VALVE_COMMAND_FALLBACK.OPEN),
    closeCmd: resolveStateValue(openTexts, StatePattern.CLOSE, VALVE_COMMAND_FALLBACK.CLOSE),
    resetCmd: resolveStateValue(resetTexts, StatePattern.RESET, RESET_LEAK_FALLBACK),
  };
}

export function resolveValveStatusValues(map: LinkboxObjectMap): ValveStatusValues {
  const texts = textsFor(map, map.valve.status1);
  return {
    openValue: resolveStateValue(texts, StatePattern.OPEN, VALVE_STATUS_FALLBACK.OPEN),
    closedValue: resolveStateValue(texts, StatePattern.CLOSED, VALVE_STATUS_FALLBACK.CLOSED),
  };
}
