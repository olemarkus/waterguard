import Homey from 'homey';
import { Registry } from './lib/WaterguardRegistry';
import {
  runResetLeakAction,
  runValveAction,
  runWiredLeakCondition,
  FlowCapabilityDevice,
  FlowDeviceArg,
} from './lib/flowActions';
import { closeAllBacnetClients, setBacnetLogger } from './lib/bacnetClient';
import { createRuntimeLogger } from './lib/logging';

type ValveActionArgs = { device?: FlowDeviceArg };
// Condition cards are device-scoped, so Homey always supplies the device arg.
type ConditionArgs = { device: FlowCapabilityDevice };

// Homey loads the app as CommonJS, so use TypeScript's `export =`.
export = class WaterguardApp extends Homey.App {
  async onInit(): Promise<void> {
    const logger = createRuntimeLogger(this, { component: 'app' });
    setBacnetLogger(logger);
    Registry.configure({ logger: createRuntimeLogger(this, { component: 'registry' }) });

    this.homey.flow.getActionCard('open_valve')
      .registerRunListener((args: ValveActionArgs) => runValveAction(Registry, args.device, true));
    this.homey.flow.getActionCard('close_valve')
      .registerRunListener((args: ValveActionArgs) => runValveAction(Registry, args.device, false));
    this.homey.flow.getActionCard('reset_leak_alarm')
      .registerRunListener((args: ValveActionArgs) => runResetLeakAction(Registry, args.device));

    this.homey.flow.getConditionCard('wired_leak_active')
      .registerRunListener((args: ConditionArgs) => runWiredLeakCondition(args.device));

    logger.info('app.init', 'Waterguard app initialized');
  }

  async onUninit(): Promise<void> {
    // Stop every poll loop and close pooled UDP sockets so a reload/uninstall
    // tears down deterministically instead of leaking timers and sockets.
    Registry.dispose();
    closeAllBacnetClients();
  }
};
