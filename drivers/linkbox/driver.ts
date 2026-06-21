import Homey from 'homey';
import type PairSession from 'homey/lib/PairSession';
import {
  DEFAULT_BACNET_PORT,
  DiscoveredLinkbox,
  discoverLinkboxes,
  probeLinkboxAt,
} from '../../lib/waterguardDiscovery';
import { DEFAULT_WRITE_PRIORITY } from '../../lib/WaterguardRegistry';
import { createRuntimeLogger } from '../../lib/logging';

type PairDeviceItem = {
  name: string;
  data: { id: string; deviceId: number };
  settings: Record<string, string | number>;
};

function toDeviceListItem(linkbox: DiscoveredLinkbox): PairDeviceItem {
  const idSuffix = linkbox.serial && linkbox.serial.length > 0 ? linkbox.serial : String(linkbox.deviceId);
  return {
    name: linkbox.name && linkbox.name.length > 0 ? linkbox.name : `Abra Linkbox+ ${linkbox.deviceId}`,
    data: { id: `abra-${idSuffix}`, deviceId: linkbox.deviceId },
    settings: {
      ip: linkbox.ip,
      bacnetPort: linkbox.port,
      model: linkbox.model,
      serial: linkbox.serial ?? '',
      deviceInstance: String(linkbox.deviceId),
      valve_write_priority: DEFAULT_WRITE_PRIORITY,
    },
  };
}

export = class LinkboxDriver extends Homey.Driver {
  async onPair(session: PairSession): Promise<void> {
    const logger = createRuntimeLogger(this, { component: 'pair', driver: 'linkbox' });

    session.setHandler('list_devices', async () => {
      logger.info('pair.list_devices', 'Pairing: searching the network for Linkboxes');
      try {
        const found = await discoverLinkboxes({ logger });
        logger.info('pair.list_devices.done', 'Pairing: network search finished', { found: found.length });
        return found.map(toDeviceListItem);
      } catch (err) {
        logger.error('pair.list_devices.failed', 'Pairing: network search threw', err);
        throw err;
      }
    });

    session.setHandler('manual_probe', async (data: unknown) => {
      const input = data as { ip?: string; port?: string | number };
      const ip = String(input.ip ?? '').trim();
      const port = Number(input.port) || DEFAULT_BACNET_PORT;
      if (!ip) throw new Error('Enter the Linkbox+ IP address.');
      logger.info('pair.manual_probe', 'Pairing: probing a manual IP', { ip, port });
      try {
        const linkbox = await probeLinkboxAt(ip, port, undefined, logger);
        if (!linkbox) throw new Error('No Abra Linkbox+ responded at that address.');
        return [toDeviceListItem(linkbox)];
      } catch (err) {
        logger.error('pair.manual_probe.failed', 'Pairing: manual probe failed', err, { ip, port });
        throw err;
      }
    });
  }
};
