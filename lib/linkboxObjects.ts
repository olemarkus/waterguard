/**
 * Pure helpers describing the Abra Linkbox+ BACnet object model: name parsing
 * (the layout is dynamic — each wireless sensor adds ID-prefixed objects), the
 * state-text-driven value mapping for the valve (so open/close come from the
 * device, not a hardcoded guess), and unit conversions. No I/O here.
 */

export const ObjectTypeId = {
  ANALOG_INPUT: 0,
  MULTI_STATE_INPUT: 13,
  MULTI_STATE_OUTPUT: 14,
  DEVICE: 8,
} as const;

export const PropertyId = {
  PRESENT_VALUE: 85,
  OBJECT_NAME: 77,
  OBJECT_LIST: 76,
  MODEL_NAME: 70,
  VENDOR_IDENTIFIER: 120,
  SERIAL_NUMBER: 96,
  STATE_TEXT: 110,
  NUMBER_OF_STATES: 74,
} as const;

export const FELL_TECHNOLOGY_VENDOR_ID = 1480;

/** BACnet application tags used when writing present-values (fixed by the spec). */
export const ApplicationTag = {
  NULL: 0,
  UNSIGNED_INTEGER: 2,
} as const;

// Anchored so "close" (command) never matches "closed" (status) and vice-versa.
export const StatePattern = {
  OPEN: /^open$/i,
  CLOSE: /^close$/i,
  CLOSED: /^closed$/i,
  RESET: /^reset$/i,
  NO_ALARM: /^noalarm$/i,
  DISCONNECTED: /^disconnected$/i,
} as const;

/** An AnalogInput reading is "wet"/alarm at ~1; the hub alarm idles at 0.5. */
export const LEAK_ALARM_THRESHOLD = 0.9;

// Fallback command/status values, used only when the device's STATE_TEXT is
// unreadable. Corroborated by the official spec AND the raw device export.
export const VALVE_COMMAND_FALLBACK = { CLOSE: 2, OPEN: 3 } as const;
export const RESET_LEAK_FALLBACK = 2;
export const VALVE_STATUS_FALLBACK = { UNKNOWN: 1, CLOSED: 2, OPEN: 3 } as const;
// Tamper state-text (ref 5): 1 ok, 2 restored, 3 warning, 4 error, 5 override.
export const TAMPER_ALARM_MIN = 3;
export const TAMPER_ALARM_MAX = 5;
// Cable state-text (ref 4): 1 unknown, 2 connected, 3 disconnected.
export const CABLE_DISCONNECTED_FALLBACK = 3;

// Battery voltage curve from the vendor docs: 3.3 V = 100 %, 2.2 V = 15 %.
const BATTERY_FULL_VOLTAGE = 3.3;
const BATTERY_LOW_VOLTAGE = 2.2;
const BATTERY_LOW_PERCENT = 15;

export type ObjectRef = { type: number; instance: number };

export type SensorField = 'leak1' | 'leak2' | 'temperature' | 'humidity' | 'batteryVoltage' | 'buttonPressed';
export type HubWaterField = 'alarm' | 'leak1' | 'leak' | 'resetLeak';
export type ValveMonitorField =
  | 'alarm' | 'numValves' | 'valveType' | 'valveStatus1' | 'valveStatus2' | 'cable';

export type ParsedObjectName =
  | { role: 'sensor'; sensorId: string; field: SensorField }
  | { role: 'hubWater'; field: HubWaterField }
  | { role: 'valveMonitor'; field: ValveMonitorField }
  | { role: 'valveControl' }
  | { role: 'tamper' }
  | null;

const SENSOR_NAME = /^(\d{6,})\.waterMonitor[:.]\d*\.(leak1|leak2|temperature|humidity|batteryVoltage|buttonPressed)$/;
const HUB_WATER_NAME = /^waterMonitor[:.]\d*\.(alarm|leak1|leak|resetLeak)$/;
const VALVE_MONITOR_NAME = /^valveMonitor[:.]\d*\.(alarm|numValves|valveType|valveStatus1|valveStatus2)$/;
// The valve actuator-cable status is a valve property but the real device names
// it under the waterMonitor prefix (waterMonitor:8.cable); accept either prefix.
const CABLE_NAME = /^(?:water|valve)Monitor[:.]\d*\.cable$/;
const VALVE_CONTROL_NAME = /^valveControl[:.]\d*\.openClose$/;
const TAMPER_NAME = /^waterTamper[:.]\d*\.state$/;

export function parseObjectName(rawName: string): ParsedObjectName {
  const name = rawName.trim();

  const sensor = SENSOR_NAME.exec(name);
  if (sensor) return { role: 'sensor', sensorId: sensor[1], field: sensor[2] as SensorField };

  if (CABLE_NAME.test(name)) return { role: 'valveMonitor', field: 'cable' };

  const hub = HUB_WATER_NAME.exec(name);
  if (hub) return { role: 'hubWater', field: hub[1] as HubWaterField };

  const valve = VALVE_MONITOR_NAME.exec(name);
  if (valve) return { role: 'valveMonitor', field: valve[1] as ValveMonitorField };

  if (VALVE_CONTROL_NAME.test(name)) return { role: 'valveControl' };
  if (TAMPER_NAME.test(name)) return { role: 'tamper' };

  return null;
}

export function objectKey(type: number, instance: number): string {
  return `${type}:${instance}`;
}

export type SensorObjects = {
  sensorId: string;
  leak1?: ObjectRef;
  leak2?: ObjectRef;
  temperature?: ObjectRef;
  humidity?: ObjectRef;
  batteryVoltage?: ObjectRef;
};

export type LinkboxObjectMap = {
  hub: { alarm?: ObjectRef; tapeLeak?: ObjectRef; resetLeak?: ObjectRef };
  valve: {
    openClose?: ObjectRef;
    status1?: ObjectRef;
    status2?: ObjectRef;
    alarm?: ObjectRef;
    numValves?: ObjectRef;
    valveType?: ObjectRef;
    cable?: ObjectRef;
  };
  tamper?: ObjectRef;
  sensors: Map<string, SensorObjects>;
  stateTexts: Map<string, string[]>;
};

export type DiscoveredObject = { type: number; instance: number; name: string; stateTexts?: string[] };

const HUB_FIELD_TARGET: Record<HubWaterField, keyof LinkboxObjectMap['hub']> = {
  alarm: 'alarm',
  resetLeak: 'resetLeak',
  leak1: 'tapeLeak', // sensor-tape wired directly to the hub
  leak: 'tapeLeak',
};

const VALVE_FIELD_TARGET: Record<ValveMonitorField, keyof LinkboxObjectMap['valve']> = {
  alarm: 'alarm',
  numValves: 'numValves',
  valveType: 'valveType',
  valveStatus1: 'status1',
  valveStatus2: 'status2',
  cable: 'cable',
};

function applySensorObject(
  sensors: Map<string, SensorObjects>,
  sensorId: string,
  field: SensorField,
  ref: ObjectRef,
): void {
  if (field === 'buttonPressed') return; // physical button — not surfaced as a capability
  const existing = sensors.get(sensorId) ?? { sensorId };
  existing[field] = ref;
  sensors.set(sensorId, existing);
}

export function buildObjectMap(objects: DiscoveredObject[]): LinkboxObjectMap {
  const map: LinkboxObjectMap = {
    hub: {},
    valve: {},
    sensors: new Map(),
    stateTexts: new Map(),
  };

  for (const object of objects) {
    const ref: ObjectRef = { type: object.type, instance: object.instance };
    if (object.stateTexts) map.stateTexts.set(objectKey(object.type, object.instance), object.stateTexts);

    const parsed = parseObjectName(object.name);
    if (!parsed) continue;
    switch (parsed.role) {
      case 'sensor': applySensorObject(map.sensors, parsed.sensorId, parsed.field, ref); break;
      case 'hubWater': map.hub[HUB_FIELD_TARGET[parsed.field]] = ref; break;
      case 'valveMonitor': map.valve[VALVE_FIELD_TARGET[parsed.field]] = ref; break;
      case 'valveControl': map.valve.openClose = ref; break;
      case 'tamper': map.tamper = ref; break;
      default: break;
    }
  }

  return map;
}

/** BACnet multistate present-values are 1-based indices into the state-text array. */
export function resolveStateValue(stateTexts: string[] | undefined, pattern: RegExp, fallback: number): number {
  if (stateTexts) {
    const index = stateTexts.findIndex((text) => pattern.test(text));
    if (index >= 0) return index + 1;
  }
  return fallback;
}

export function decodeStateValue(stateTexts: string[] | undefined, value: number): string | undefined {
  if (stateTexts && Number.isInteger(value) && value >= 1 && value <= stateTexts.length) {
    return stateTexts[value - 1];
  }
  return undefined;
}

export function isLeakWet(value: number | undefined): boolean {
  return typeof value === 'number' && value >= LEAK_ALARM_THRESHOLD;
}

export function isTamperActive(state: number | undefined): boolean {
  return typeof state === 'number' && state >= TAMPER_ALARM_MIN && state <= TAMPER_ALARM_MAX;
}

export function voltageToBatteryPercent(voltage: number): number {
  const slope = (100 - BATTERY_LOW_PERCENT) / (BATTERY_FULL_VOLTAGE - BATTERY_LOW_VOLTAGE);
  const percent = BATTERY_LOW_PERCENT + (voltage - BATTERY_LOW_VOLTAGE) * slope;
  return Math.max(0, Math.min(100, Math.round(percent)));
}
