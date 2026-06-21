import Homey from 'homey';
import type PairSession from 'homey/lib/PairSession';
import { getBacnetClient } from '../../lib/bacnetClient';
import { DEFAULT_BACNET_PORT, enumerateObjects } from '../../lib/waterguardDiscovery';
import { buildObjectMap } from '../../lib/linkboxObjects';

type LinkboxData = { id: string; deviceId: number };
type SensorData = { sensorId: string; gatewayUnitId: string };

type GatewaySummary = { id: string; name: string; hasIp: boolean };

type SensorPairItem = {
  name: string;
  data: SensorData;
  settings: Record<string, string>;
};

/** Identity of a paired sensor is (gateway, sensorId) — the same sensorId can
 *  legitimately appear behind two different Linkboxes. */
function sensorKey(gatewayUnitId: string, sensorId: string): string {
  return `${gatewayUnitId}:${sensorId}`;
}

export = class WaterSensorDriver extends Homey.Driver {
  /**
   * Hue-style flow: pick the Linkbox+ gateway first (auto-skipped when only one
   * is paired), then list the wireless sensors reachable through that gateway.
   */
  async onPair(session: PairSession): Promise<void> {
    let selectedGatewayId: string | undefined;

    session.setHandler('list_gateways', async (): Promise<GatewaySummary[]> => this.listGateways());

    session.setHandler('select_gateway', async (data: unknown) => {
      selectedGatewayId = (data as { gatewayId?: string } | null)?.gatewayId;
      return { ok: true };
    });

    session.setHandler('list_devices', async (): Promise<SensorPairItem[]> => {
      const gateway = this.resolveSelectedGateway(selectedGatewayId);
      return this.sensorsForGateway(gateway);
    });
  }

  private getLinkboxes(): Homey.Device[] {
    return this.homey.drivers.getDriver('linkbox').getDevices();
  }

  private listGateways(): GatewaySummary[] {
    return this.getLinkboxes().map((gateway) => ({
      id: (gateway.getData() as LinkboxData).id,
      name: gateway.getName(),
      hasIp: String(gateway.getSetting('ip') ?? '').trim().length > 0,
    }));
  }

  private resolveSelectedGateway(selectedGatewayId: string | undefined): Homey.Device {
    const gateways = this.getLinkboxes();
    if (gateways.length === 0) {
      throw new Error('Add an Abra Linkbox+ first, then add its water sensors.');
    }
    const gateway = selectedGatewayId
      ? gateways.find((candidate) => (candidate.getData() as LinkboxData).id === selectedGatewayId)
      : gateways[0];
    if (!gateway) throw new Error('That Abra Linkbox+ is no longer available. Start over and pick another.');
    return gateway;
  }

  private async sensorsForGateway(gateway: Homey.Device): Promise<SensorPairItem[]> {
    const data = gateway.getData() as LinkboxData;
    const ip = String(gateway.getSetting('ip') ?? '').trim();
    const port = Number(gateway.getSetting('bacnetPort')) || DEFAULT_BACNET_PORT;
    if (!ip) {
      throw new Error('This Abra Linkbox+ has no IP address yet. Set it in the Linkbox+ settings, then try again.');
    }

    const map = await this.enumerate(gateway, data, ip, port);
    const existing = this.pairedSensorKeys();
    const items: SensorPairItem[] = [];
    for (const sensorId of map.sensors.keys()) {
      if (existing.has(sensorKey(data.id, sensorId))) continue;
      items.push({
        name: `Water Sensor ${sensorId}`,
        data: { sensorId, gatewayUnitId: data.id },
        settings: { gateway: gateway.getName() },
      });
    }
    return items;
  }

  private async enumerate(gateway: Homey.Device, data: LinkboxData, ip: string, port: number) {
    try {
      const objects = await enumerateObjects(getBacnetClient(port), ip, data.deviceId);
      return buildObjectMap(objects);
    } catch (error) {
      this.error('Failed to enumerate sensors for gateway', data.id, error);
      throw new Error(
        `Could not reach ${gateway.getName()}. Check it is powered on and on the network, then try again.`,
        { cause: error },
      );
    }
  }

  private pairedSensorKeys(): Set<string> {
    return new Set(
      this.getDevices().map((device) => {
        const data = device.getData() as SensorData;
        return sensorKey(data.gatewayUnitId, data.sensorId);
      }),
    );
  }
};
