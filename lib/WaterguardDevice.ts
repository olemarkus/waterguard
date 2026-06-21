import Homey from 'homey';
import { createRuntimeLogger, RuntimeLogger } from './logging';
import { CapabilityValue, RegistryDevice } from './WaterguardRegistry';

/**
 * Base class for both drivers' devices. Implements the registry's
 * {@link RegistryDevice} bridge by delegating to the Homey SDK, swallowing and
 * logging the async failures so the registry stays synchronous and SDK-free.
 */
export abstract class WaterguardDevice extends Homey.Device implements RegistryDevice {
  private runtimeLogger?: RuntimeLogger;

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
    if (present === has) return;
    const change = present ? this.addCapability(capability) : this.removeCapability(capability);
    change.catch((error: unknown) => {
      this.getLogger().error('device.capability.presence.failed', 'Failed to change capability presence', error, {
        capability,
        present,
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
