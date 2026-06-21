import { WaterguardDevice } from '../../lib/WaterguardDevice';
import { Registry } from '../../lib/WaterguardRegistry';
import { DEFAULT_BACNET_PORT } from '../../lib/waterguardDiscovery';

type LinkboxData = { id: string; deviceId: number };
type SettingsEvent = { newSettings: Record<string, unknown>; changedKeys: string[] };

export = class LinkboxGatewayDevice extends WaterguardDevice {
  async onInit(): Promise<void> {
    const data = this.getData() as LinkboxData;
    const ip = String(this.getSetting('ip') ?? '');
    const port = Number(this.getSetting('bacnetPort')) || DEFAULT_BACNET_PORT;
    const writePriority = Number(this.getSetting('valve_write_priority')) || undefined;

    Registry.registerGateway(this, {
      unitId: data.id,
      deviceId: data.deviceId,
      ip,
      port,
      writePriority,
    });

    // `onoff` stays for voice assistants and generic on/off Flows, but it is
    // hidden from the device UI (uiComponent: null) so the valve can't be
    // toggled by an accidental tap. Deliberate manual control happens through
    // the open/close maintenance-action buttons in the device settings.
    this.registerCapabilityListener('onoff', async (value: boolean) => {
      await Registry.setValveOpen(data.id, value);
    });
    this.registerCapabilityListener('open_valve', async () => {
      await Registry.setValveOpen(data.id, true);
    });
    this.registerCapabilityListener('close_valve', async () => {
      await Registry.setValveOpen(data.id, false);
    });
    this.registerCapabilityListener('clear_leak_alarm', async () => {
      await Registry.resetLeak(data.id);
    });

    this.getLogger().info('device.init', 'Linkbox+ gateway initialized', { unitId: data.id, ip });
  }

  async onSettings(event: SettingsEvent): Promise<void> {
    if (!event.changedKeys.includes('ip') && !event.changedKeys.includes('bacnetPort')) return;
    const data = this.getData() as LinkboxData;
    const ip = String(event.newSettings.ip ?? '');
    const port = Number(event.newSettings.bacnetPort) || DEFAULT_BACNET_PORT;
    Registry.updateEndpoint(data.id, ip, port);
  }

  async onUninit(): Promise<void> {
    Registry.unregister(this);
  }

  async onDeleted(): Promise<void> {
    Registry.unregister(this);
  }
};
