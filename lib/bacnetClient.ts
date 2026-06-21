/**
 * Shared bacstack client(s) keyed by the device's BACnet port. Each pooled
 * client talks to devices on that port from an *ephemeral* local UDP port (via
 * {@link FixedDestinationTransport}) instead of binding the well-known BACnet
 * port itself. A polling client only sends requests, and BACnet/IP returns
 * replies to the request's source port (ASHRAE 135 Annex J) — so there is no
 * need to own 47808, and not owning it lets the app coexist with other BACnet
 * apps (or a co-located device/mock) on the same host instead of fighting over
 * the bind. The bacstack module is indirected behind a settable reference so
 * tests can inject a fake.
 */
import Bacnet, {
  BacnetClient,
  BacnetClientOptions,
  BacnetEnums,
  BacnetStatic,
} from 'bacstack';
import { FixedDestinationTransport } from './bacnetTransport';
import { RuntimeLogger } from './logging';

const DEFAULT_BACNET_PORT = 47808;
const APDU_TIMEOUT_MS = 15000;
const APDU_SIZE = 1476; // typical max ethernet APDU

const clientsByPort = new Map<number, BacnetClient>();
let bacnetLogger: RuntimeLogger | undefined;
let bacnetModule: BacnetStatic = Bacnet;

export function setBacnetLogger(logger: RuntimeLogger): void {
  bacnetLogger = logger;
}

export function setBacnetModuleForTests(module: BacnetStatic): void {
  clientsByPort.clear();
  bacnetLogger = undefined;
  bacnetModule = module;
}

export function resetBacnetClientStateForTests(): void {
  clientsByPort.clear();
  bacnetLogger = undefined;
  bacnetModule = Bacnet;
}

export function getBacnetClient(port: number): BacnetClient {
  const resolvedPort = Number(port) || DEFAULT_BACNET_PORT;

  const existing = clientsByPort.get(resolvedPort);
  if (existing) return existing;

  const ClientCtor = bacnetModule;
  const client = new ClientCtor({
    // Bind an ephemeral local port and send to the device's BACnet port; replies
    // return to that source port, so we never bind the well-known port ourselves.
    transport: new FixedDestinationTransport({ targetPort: resolvedPort }),
    apduTimeout: APDU_TIMEOUT_MS,
    apduSize: APDU_SIZE,
  });

  // Prevent unhandled error events from crashing the app.
  client.on('error', (err) => {
    bacnetLogger?.error('bacnet.client.error', 'BACnet client emitted an error event', err, {
      component: 'bacnet',
      port: resolvedPort,
    });
  });

  clientsByPort.set(resolvedPort, client);
  return client;
}

export function bacnetEnums(): BacnetEnums {
  return bacnetModule.enum;
}

/** Close and drop every pooled client (their UDP sockets). Called on app
 *  shutdown so a reload/uninstall does not leak bound sockets. */
export function closeAllBacnetClients(): void {
  for (const client of clientsByPort.values()) {
    try {
      client.close();
    } catch (err) {
      bacnetLogger?.error('bacnet.client.close_failed', 'Failed to close BACnet client', err, {
        component: 'bacnet',
      });
    }
  }
  clientsByPort.clear();
}

/**
 * Create a standalone (non-pooled) client the caller owns and closes — used by
 * discovery/probe flows that bind a transient socket. Honours the test module.
 */
export function createBacnetClient(options: BacnetClientOptions): BacnetClient {
  const ClientCtor = bacnetModule;
  return new ClientCtor(options);
}
