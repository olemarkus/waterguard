import Homey from 'homey';
import { createRuntimeLogger, RuntimeLogger } from './logging';
import { WIRED_LEAK_CAPABILITY } from './pollMapping';
import { CapabilityValue, RegistryDevice } from './WaterguardRegistry';

/**
 * Presentation for capabilities added at runtime. Homey only copies a driver
 * manifest's `capabilitiesOptions` when a device is created, so a capability
 * the registry adds later (the wired-sensor leak alarm only exists on hubs
 * that actually have one) must carry its own options — otherwise it shows up
 * under the generic "water alarm" title, indistinguishable from the aggregate
 * `alarm_water` on the device page.
 */
const RUNTIME_CAPABILITY_OPTIONS: Record<string, object> = {
  [WIRED_LEAK_CAPABILITY]: {
    title: { en: 'Water leak (wired sensor)' },
    insights: true,
    insightsTitleTrue: { en: 'Wired sensor water alarm turned on', no: 'Vannalarm (kablet sensor) aktivert' },
    insightsTitleFalse: { en: 'Wired sensor water alarm turned off', no: 'Vannalarm (kablet sensor) deaktivert' },
  },
};

/**
 * Base class for both drivers' devices. Implements the registry's
 * {@link RegistryDevice} bridge by delegating to the Homey SDK, swallowing and
 * logging the async failures so the registry stays synchronous and SDK-free.
 */
export abstract class WaterguardDevice extends Homey.Device implements RegistryDevice {
  private runtimeLogger?: RuntimeLogger;

  private readonly optionsChecked = new Set<string>();

  protected getLogger(): RuntimeLogger {
    if (!this.runtimeLogger) {
      this.runtimeLogger = createRuntimeLogger(this, { driver: this.driver.id });
    }
    return this.runtimeLogger;
  }

  applyCapability(capability: string, value: CapabilityValue): void {
    if (!this.hasCapability(capability)) return;
    this.setCapabilityValue(capability, value).catch((error: unknown) => {
      this.getLogger().error('device.capability.failed', 'Failed to set capability', error, { capability });
    });
  }

  ensureCapabilityPresent(capability: string, present: boolean): void {
    const has = this.hasCapability(capability);
    if (present === has) {
      if (present) this.ensureRuntimeOptions(capability);
      return;
    }
    const change = present ? this.addCapability(capability) : this.removeCapability(capability);
    change
      .then(() => {
        if (present) this.ensureRuntimeOptions(capability);
      })
      .catch((error: unknown) => {
        this.getLogger().error('device.capability.presence.failed', 'Failed to change capability presence', error, {
          capability,
          present,
        });
      });
  }

  /** Apply a runtime-added capability's options once per app run — devices
   *  paired before the capability was named still carry the old (empty)
   *  options, and Homey never back-fills them from the manifest. The write is
   *  an idempotent local call, so it is not worth diffing against the current
   *  options first. */
  private ensureRuntimeOptions(capability: string): void {
    const options = RUNTIME_CAPABILITY_OPTIONS[capability];
    if (!options || this.optionsChecked.has(capability)) return;
    this.optionsChecked.add(capability);
    this.setCapabilityOptions(capability, options).catch((error: unknown) => {
      this.getLogger().error('device.capability.options.failed', 'Failed to set capability options', error, {
        capability,
      });
    });
  }

  setReachable(reachable: boolean, message?: string): void {
    const change = reachable ? this.setAvailable() : this.setUnavailable(message ?? 'Unavailable');
    change.catch((error: unknown) => {
      this.getLogger().error('device.availability.failed', 'Failed to change availability', error, { reachable });
    });
  }

  triggerFlow(trigger: string, tokens: Record<string, CapabilityValue>): void {
    try {
      const card = this.homey.flow.getDeviceTriggerCard(trigger);
      card.trigger(this, tokens).catch((error: unknown) => {
        this.getLogger().error('device.flow.trigger.failed', 'Failed to trigger flow', error, { trigger });
      });
    } catch (error) {
      this.getLogger().error('device.flow.trigger.lookup_failed', 'Flow trigger card not found', error, { trigger });
    }
  }
}
