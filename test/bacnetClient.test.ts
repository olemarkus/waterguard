import {
  describe, it, expect, vi, afterEach,
} from 'vitest';
import {
  bacnetEnums,
  closeAllBacnetClients,
  createBacnetClient,
  getBacnetClient,
  resetBacnetClientStateForTests,
  setBacnetLogger,
  setBacnetModuleForTests,
} from '../lib/bacnetClient';

class FakeModule {
  static enum = { ApplicationTags: { UNSIGNED_INTEGER: 2 }, ObjectType: { DEVICE: 8 } };

  options: any;

  closed = false;

  handlers: Record<string, (arg: any) => void> = {};

  constructor(options: any) {
    this.options = options;
  }

  on(event: string, cb: (arg: any) => void) {
    this.handlers[event] = cb;
    return this;
  }

  close() {
    this.closed = true;
  }
}

afterEach(() => resetBacnetClientStateForTests());

describe('getBacnetClient', () => {
  it('reuses one client per port and defaults a falsy port to 47808', () => {
    setBacnetModuleForTests(FakeModule as any);
    const a = getBacnetClient(47808);
    const b = getBacnetClient(47808);
    const fallback = getBacnetClient(0 as any);
    expect(a).toBe(b);
    // The client binds an ephemeral local port and targets the device's BACnet
    // port via the transport (it must not bind the well-known port itself).
    expect((a as any).options.port).toBeUndefined();
    expect((a as any).options.transport.targetPort).toBe(47808);
    // A falsy port resolves to 47808 — same pooled client.
    expect(fallback).toBe(a);
  });

  it('routes client error events through the configured logger', () => {
    setBacnetModuleForTests(FakeModule as any);
    const logger = { error: vi.fn(), info: vi.fn(), child() { return this; } };
    setBacnetLogger(logger as any);
    const client = getBacnetClient(47808) as any;
    client.handlers.error(new Error('boom'));
    expect(logger.error).toHaveBeenCalledWith(
      'bacnet.client.error',
      expect.any(String),
      expect.any(Error),
      expect.objectContaining({ port: 47808 }),
    );
  });
});

describe('closeAllBacnetClients', () => {
  it('closes and drops every pooled client', () => {
    setBacnetModuleForTests(FakeModule as any);
    const client = getBacnetClient(47808) as any;
    closeAllBacnetClients();
    expect(client.closed).toBe(true);
    expect(getBacnetClient(47808)).not.toBe(client); // pool was cleared
  });
});

describe('createBacnetClient and bacnetEnums', () => {
  it('builds a standalone client and exposes the module enums', () => {
    setBacnetModuleForTests(FakeModule as any);
    const client = createBacnetClient({ apduTimeout: 1000 }) as any;
    expect(client.options.apduTimeout).toBe(1000);
    expect(bacnetEnums().ApplicationTags.UNSIGNED_INTEGER).toBe(2);
  });
});
