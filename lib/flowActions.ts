/**
 * Pure flow-action handlers, decoupled from the Homey SDK so they can be unit
 * tested. The app wires these into the action cards.
 */
export type FlowDeviceArg = { getData(): unknown } | undefined;

export type ValveController = {
  setValveOpen(unitId: string, open: boolean): Promise<void>;
  resetLeak(unitId: string): Promise<void>;
};

export function resolveUnitId(device: FlowDeviceArg): string {
  const data = device?.getData() as { id?: unknown } | undefined;
  const id = typeof data?.id === 'string' ? data.id : '';
  if (!id) throw new Error('Flow device is missing its Linkbox+ id.');
  return id;
}

export async function runValveAction(
  controller: ValveController,
  device: FlowDeviceArg,
  open: boolean,
): Promise<boolean> {
  await controller.setValveOpen(resolveUnitId(device), open);
  return true;
}

export async function runResetLeakAction(controller: ValveController, device: FlowDeviceArg): Promise<boolean> {
  await controller.resetLeak(resolveUnitId(device));
  return true;
}
