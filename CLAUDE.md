# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Homey (SDK v3, `runtime: nodejs`, `platforms: ["local"]`) app that protects against water
damage by talking to an **Abra Linkbox+** gateway (vendor: Fell Technology, BACnet vendor id
1480) over **BACnet/IP** on the local network. It surfaces each wireless WaterSensor+ and the
main shut-off valve as Homey devices, and shuts the valve when a leak is detected.

## Commands

```bash
npm run build           # tsc -> .homeybuild/
npm run typecheck       # tsc --noEmit
npm run lint            # check-test-titles + eslint (--max-warnings=0)
npm run lint:fix
npm run arch:check      # dependency-cruiser layering rules
npm test                # typecheck + vitest run (with v8 coverage, 80% gate)
npm run test:watch
npm run validate        # lint + arch:check + test + `homey app validate` — run before considering work done
npm run start           # homey app run --remote (runs on a real Homey)
npm run fake-linkbox    # standalone BACnet mock to pair/exercise the app without hardware
```

Run a single test file / test:

```bash
npx vitest run --config vitest.config.mts test/pollMapping.test.ts
npx vitest run --config vitest.config.mts -t 'name of the test'
```

### Testing against the fake Linkbox

`scripts/fake-linkbox.ts` is a full BACnet/IP responder mock (Who-Is/I-Am, ReadProperty,
ReadPropertyMultiple, WriteProperty, STATE_TEXT) so you can pair and drive the real app with no
hardware. It also exposes an HTTP control API to inject leaks/faults. See
`scripts/fake-linkbox.example.json` for the config shape.

```bash
npm run fake-linkbox -- --valves 1 --sensors 2
npm run fake-linkbox -- --config scripts/fake-linkbox.example.json
```

## Architecture

The design rule is: **`lib/` is a Homey-SDK-free, fully unit-testable core**; the Homey SDK
only appears in `app.ts`, `drivers/**`, and `lib/WaterguardDevice.ts`. Layering is enforced by
`.dependency-cruiser.cjs` (`npm run arch:check`): `drivers → lib` only — no `lib → drivers`,
no `lib → app`, no cross-driver imports, no circular deps, no runtime → tests.

### The two-way bridge (key abstraction)

The registry never touches the Homey SDK. It drives devices through the narrow synchronous
`RegistryDevice` interface (`applyCapability`, `ensureCapabilityPresent`, `setReachable`,
`triggerFlow`). `lib/WaterguardDevice.ts` (the only SDK-aware file in `lib/`) implements that
interface by delegating to `Homey.Device` and swallowing/logging the async failures, keeping
the registry synchronous and testable with plain fakes.

### Runtime flow

- **`lib/WaterguardRegistry.ts`** — app-wide singleton `Registry`. One **`Unit` per gateway**
  ("unit" = one Linkbox+). Each unit owns a poll loop (`DEFAULT_POLL_INTERVAL_MS`) that reads
  all BACnet objects once and distributes values to the registered gateway device + one device
  per sensor. Also serves valve open/close and reset-leak commands with **write-then-read-back
  verify** (`verifyValve`). On `MAX_CONSECUTIVE_FAILURES` it marks devices unavailable and
  triggers rediscovery (the Linkbox may have changed IP). `Unit` holds all mutable state, with
  transitions as methods, so the registry never mutates a parameter's properties.
- **`drivers/linkbox/`** — the gateway/valve device. Pairing discovers Linkboxes (broadcast
  Who-Is) or probes a manual IP. `device.ts` registers with the registry and wires the `onoff`
  (valve) and `clear_leak_alarm` capability listeners.
- **`drivers/watersensor/`** — one device per wireless sensor. Pairing enumerates a paired
  gateway's objects and lists the sensors not yet added.

### BACnet layer

- **`lib/bacnetClient.ts`** — bacstack clients pooled by local UDP port (one socket per port).
  The bacstack module is behind a settable reference so tests inject a fake
  (`setBacnetModuleForTests`).
- **`lib/bacnetTransport.ts`** — `FixedDestinationTransport`: a UDP transport that binds one
  socket and sends to a fixed target port with broadcast on (discovery + targeted reads).
- **`lib/bacnetRead.ts`** — promise wrappers around callback-style bacstack + value extractors.
- **`lib/waterguardDiscovery.ts`** — Who-Is discovery (validated by reading Device identity),
  manual-IP probe, and **runtime object enumeration** (the object layout is dynamic, so it is
  never hardcoded — it is read from the device each time).

### Object model + value mapping (pure, no I/O)

- **`lib/linkboxObjects.ts`** — parses the dynamic Linkbox object names (each wireless sensor
  adds ID-prefixed objects), builds the `LinkboxObjectMap`, and converts units. Multistate
  present-values are **1-based indices into the object's STATE_TEXT array**.
- **`lib/pollMapping.ts`** — maps a BACnet poll response to Homey capability values.
  **Safety-critical:** valve open/close/reset commands and open/closed/fault status are
  resolved from each object's **STATE_TEXT read from the device**, falling back to documented
  constants only when STATE_TEXT is unreadable. Do not hardcode a valve polarity. (The
  documented fallbacks are open=3, close=2, reset=2; a prose summary in localdocs is wrong —
  always derive from STATE_TEXT and verify against a real export.)
- **`lib/logging.ts`** — structured pino logging written to the Homey log sink; errors (level
  ≥ 50) go to `sink.error`. `RuntimeLogger.info/error(event, msg, ...)` is the API.

## Conventions

- **Don't design for transient failures.** Guards, "known/unknown" flags, retries and
  suppression logic added to tolerate transient read errors add state and branches that are more
  likely to cause bad behavior down the line than the transient error itself. Keep the simple
  mapping; a wrong value for one 20-second poll cycle self-corrects on the next poll.

- **Homey loads modules as CommonJS** — driver/device/app classes use TypeScript's
  `export = class …`, not `export default`.
- **`app.json` is generated** from `.homeycompose/` (`_comment` says so). Edit
  `.homeycompose/**` (app metadata, `flow/`, `capabilities/`) and driver `driver.compose.json`,
  never `app.json` directly.
- **Test titles are linted** by `scripts/check-test-titles.js`: describe observable behavior —
  no `should`/`covers`/`branch(es)` phrasing.
- **Coverage gate is 80%** (branches/functions/lines/statements) over `lib/**`; thin SDK/socket
  adapters (`WaterguardDevice.ts`, `bacnetTransport.ts`) are excluded — their wrapped logic is
  tested elsewhere.
- New core logic belongs in `lib/` with deps injectable (see `RegistryDependencies`,
  `setBacnetModuleForTests`, `setProbeClientFactoryForTests`) so it stays SDK-free and testable.
- Husky + lint-staged run eslint on commit.

## Reference material

`localdocs/` holds unrelated reference apps (`com.homewizard`, `com.linktap`) and the Abra
Linkbox protocol notes (`localdocs/message1.txt`) — reference only, not part of the build
(excluded from lint/arch/coverage).
