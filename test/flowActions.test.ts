import { describe, it, expect, vi } from 'vitest';
import { resolveUnitId, runResetLeakAction, runValveAction } from '../lib/flowActions';

function deviceWithId(id: unknown) {
  return { getData: () => ({ id }) };
}

describe('resolveUnitId', () => {
  it('returns the device id', () => {
    expect(resolveUnitId(deviceWithId('abra-1001'))).toBe('abra-1001');
  });

  it('throws when the id is missing', () => {
    expect(() => resolveUnitId(undefined)).toThrow();
    expect(() => resolveUnitId(deviceWithId(undefined))).toThrow();
  });
});

describe('valve flow actions', () => {
  it('opens, closes and resets via the controller', async () => {
    const controller = { setValveOpen: vi.fn().mockResolvedValue(undefined), resetLeak: vi.fn().mockResolvedValue(undefined) };
    const device = deviceWithId('abra-1001');

    await expect(runValveAction(controller, device, true)).resolves.toBe(true);
    await runValveAction(controller, device, false);
    await runResetLeakAction(controller, device);

    expect(controller.setValveOpen).toHaveBeenNthCalledWith(1, 'abra-1001', true);
    expect(controller.setValveOpen).toHaveBeenNthCalledWith(2, 'abra-1001', false);
    expect(controller.resetLeak).toHaveBeenCalledWith('abra-1001');
  });
});
