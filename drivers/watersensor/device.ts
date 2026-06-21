import { WaterguardDevice } from '../../lib/WaterguardDevice';
import { Registry } from '../../lib/WaterguardRegistry';

type SensorData = { sensorId: string; gatewayUnitId: string };

export = class WaterSensorDevice extends WaterguardDevice {
  async onInit(): Promise<void> {
    const data = this.getData() as SensorData;
    Registry.registerSensor(data.gatewayUnitId, data.sensorId, this);
    this.getLogger().info('device.init', 'Water sensor initialized', {
      sensorId: data.sensorId,
      gatewayUnitId: data.gatewayUnitId,
    });
  }

  async onUninit(): Promise<void> {
    Registry.unregister(this);
  }

  async onDeleted(): Promise<void> {
    Registry.unregister(this);
  }
};
