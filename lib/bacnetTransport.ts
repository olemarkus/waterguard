import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import type { BacnetTransport } from 'bacstack';

const DEFAULT_TARGET_PORT = 47808;
const MAX_PAYLOAD = 1482;

export type FixedDestinationTransportOptions = {
  localPort?: number;
  localAddress?: string;
  targetPort?: number;
  broadcastAddress?: string;
};

/**
 * A bacstack transport that binds a single UDP socket and sends to a fixed
 * target port, with broadcast enabled. Used for discovery (broadcast Who-Is)
 * and targeted reads against a known IP. Adapted from the flexit read-probe.
 */
export class FixedDestinationTransport extends EventEmitter implements BacnetTransport {
  private readonly localPort: number;

  private readonly localAddress?: string;

  readonly targetPort: number;

  private readonly broadcastAddress: string;

  private readonly server: dgram.Socket;

  constructor(options: FixedDestinationTransportOptions = {}) {
    super();
    this.localPort = options.localPort ?? 0;
    this.localAddress = options.localAddress;
    this.targetPort = options.targetPort ?? DEFAULT_TARGET_PORT;
    this.broadcastAddress = options.broadcastAddress ?? '255.255.255.255';
    this.server = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.server.on('message', (msg, rinfo) => this.emit('message', msg, rinfo.address));
    this.server.on('error', (err) => this.emit('error', err));
  }

  getBroadcastAddress(): string {
    return this.broadcastAddress;
  }

  getMaxPayload(): number {
    return MAX_PAYLOAD;
  }

  send(buffer: Buffer, offset: number, receiver: string): void {
    this.server.send(buffer, 0, offset, this.targetPort, receiver);
  }

  open(): void {
    this.server.bind(this.localPort, this.localAddress, () => {
      this.server.setBroadcast(true);
    });
  }

  close(): void {
    this.server.close();
  }
}
