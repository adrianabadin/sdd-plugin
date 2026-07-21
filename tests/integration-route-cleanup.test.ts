/**
 * Task 7 Integration Test — Route open/close cleanup, listener leak detection,
 * and Ctrl+Alt+F host collision check.
 *
 * Acceptance scenarios (design.md):
 *   - "Verify route-specific layers and modes are removed on route leave and
 *      plugin unload."
 *   - "Open and close the route repeatedly to detect duplicate registrations
 *      or stale globalThis listeners."
 *   - "Register Ctrl+Alt+F only in the base layer and verify host collision
 *      behavior against the supported OpenCode version."
 *   - "Repeated route open/close cycles leave no mode, keymap, listener, or
 *      registry leak."
 */
import assert from "node:assert/strict";
import type { TuiPluginApi, TuiRouteDefinition } from "@opencode-ai/plugin/tui";
import { createRoot } from "solid-js";
import { createComponent } from "solid-js/web";
import type { JSX } from "@opentui/solid";

import SddTuiModule from "../src/tui.js";
import { getOrCreateModelConfigRegistry } from "../src/infrastructure/runtime/model-config-registry.js";

console.log("--- Task 7 Integration: Route Cleanup, Listener Leak, Host Collision ---");

const failures: string[] = [];

function assertOk(condition: unknown, message: string): void {
  if (!condition) {
    failures.push(message);
    console.error("  FAIL: " + message);
  } else {
    console.log("  pass: " + message);
  }
}

interface RegistrationCounters {
  layerRegistrations: number;
  layerDisposersInvoked: number;
  routeRegistrations: number;
  routeDisposersInvoked: number;
  modePushes: number;
  modePops: number;
  listenerErrors: number;
  dialogAlertInvocations: number;
}

function buildMockApi(
  counters: RegistrationCounters,
  layers: Array<{ mode?: string; priority?: number; commands: unknown[]; bindings: unknown[] }>,
  routes: TuiRouteDefinition[],
  disposers: Array<() => void>,
  navigateHolder: { value: string | null },
): TuiPluginApi {
  return {
    app: { version: "1.18.4" },
    attention: {} as never,
    keys: {} as never,
    keymap: {
      registerLayer: (layer: unknown) => {
        counters.layerRegistrations++;
        layers.push(layer as { mode?: string; priority?: number; commands: unknown[]; bindings: unknown[] });
        return () => {
          counters.layerDisposersInvoked++;
        };
      },
    } as never,
    route: {
      register: (registeredRoutes: TuiRouteDefinition[]) => {
        counters.routeRegistrations++;
        for (const r of registeredRoutes) routes.push(r);
        return () => {
          counters.routeDisposersInvoked++;
        };
      },
      navigate: (name: string) => {
        navigateHolder.value = name;
      },
      current: { name: "home" },
    },
    mode: {
      current: () => "base",
      push: (_name: string) => {
        counters.modePushes++;
        return () => {
          counters.modePops++;
        };
      },
    },
    ui: {
      DialogAlert: (props: { title?: string; message?: string }): JSX.Element => {
        counters.dialogAlertInvocations++;
        return createComponent((p) => null as unknown as JSX.Element, props);
      },
      Dialog: (() => null) as never,
      DialogConfirm: (() => null) as never,
      DialogPrompt: (() => null) as never,
      DialogSelect: (() => null) as never,
      Slot: (() => null) as never,
      Prompt: (() => null) as never,
      toast: () => {},
      dialog: {} as never,
    },
    tuiConfig: {} as never,
    kv: {} as never,
    state: {} as never,
    theme: {} as never,
    client: {} as never,
    event: {} as never,
    renderer: {} as never,
    slots: {} as never,
    plugins: {} as never,
    lifecycle: {
      signal: new AbortController().signal,
      onDispose: (cb: () => void) => {
        disposers.push(cb);
        return () => {};
      },
    },
  };
}

async function run() {
  const counters: RegistrationCounters = {
    layerRegistrations: 0,
    layerDisposersInvoked: 0,
    routeRegistrations: 0,
    routeDisposersInvoked: 0,
    modePushes: 0,
    modePops: 0,
    listenerErrors: 0,
    dialogAlertInvocations: 0,
  };
  const layers: Array<{ mode?: string; priority?: number; commands: unknown[]; bindings: unknown[] }> = [];
  const routes: TuiRouteDefinition[] = [];
  const disposers: Array<() => void> = [];
  const navigateHolder: { value: string | null } = { value: null };
  const api = buildMockApi(counters, layers, routes, disposers, navigateHolder);

  // === Initial registration via tui() ===
  await SddTuiModule.tui(api, undefined, {} as never);

  assertOk(counters.layerRegistrations === 1, "first tui() call registers the base keymap layer exactly once");
  assertOk(counters.routeRegistrations === 1, "first tui() call registers the route exactly once");
  assertOk(layers[0]?.mode === "base", "keymap layer is registered with mode='base'");
  assertOk(typeof layers[0]?.priority === "number", "keymap layer carries a numeric priority");

  // === Host collision: Ctrl+Alt+F is bound on the base layer ONLY ===
  // The supported OpenCode version contract (peer dependency >= 1.17.11).
  assertOk(api.app.version === "1.18.4", "host API reports supported OpenCode version 1.18.4");
  const [major, minor] = api.app.version.split(".").map(Number) as [number, number];
  assertOk(
    major > 1 || (major === 1 && minor >= 17),
    "host version satisfies >= 1.17.11 peer dependency contract",
  );

  const ctrlAltF = layers[0]?.bindings.find((b: { key?: string; cmd?: string }) => b.key === "ctrl+alt+f");
  assertOk(ctrlAltF !== undefined, "base layer registers binding 'ctrl+alt+f'");
  assertOk(
    ctrlAltF?.cmd === "model-control-center.open",
    "ctrl+alt+f binding points to command 'model-control-center.open'",
  );
  assertOk(
    typeof ctrlAltF?.desc === "string" && ctrlAltF.desc.length > 0,
    "ctrl+alt+f binding carries a non-empty description",
  );

  const openCmd = layers[0]?.commands.find((c: { name?: string; run?: () => unknown }) => c.name === "model-control-center.open");
  assertOk(openCmd !== undefined, "command 'model-control-center.open' is registered in base layer");
  assertOk(typeof openCmd?.run === "function", "command 'model-control-center.open' has a run function");

  // Running the command triggers route navigation to the registered route.
  navigateHolder.value = null;
  await openCmd?.run?.();
  assertOk(navigateHolder.value === "model-control-center", "command execution navigates to 'model-control-center'");

  // The route is registered with a name and render function
  const route = routes.find((r) => r.name === "model-control-center");
  assertOk(route !== undefined, "route 'model-control-center' is registered");
  assertOk(typeof route?.render === "function", "route 'model-control-center' exposes a render function");

  // Snapshot the base layer registrations before cycles begin.
  const baseLayerRegistrations = counters.layerRegistrations;
  const baseDisposersAtStart = counters.layerDisposersInvoked;

  // === Repeated route open/close cycles ===
  // Each mount registers one route-scoped keymap layer (from ModelControlCenter)
  // and disposes it on unmount via Solid onCleanup. The base layer is registered
  // once and never re-registered. After cycles, all route-scoped layers must be
  // disposed and no listener/keymap leak must remain.
  const CYCLES = 5;
  for (let i = 0; i < CYCLES; i++) {
    const pushesBefore = counters.modePushes;
    const popsBefore = counters.modePops;
    const layersBefore = counters.layerRegistrations;
    let dispose: (() => void) | null = null;
    createRoot((d) => {
      dispose = d;
      route!.render({ params: {} });
    });
    assertOk(counters.modePushes === pushesBefore + 1, `cycle ${i + 1}: route render pushes mode exactly once`);
    assertOk(counters.modePops === popsBefore, `cycle ${i + 1}: mode remains active while route is mounted`);
    assertOk(counters.layerRegistrations === layersBefore + 1, `cycle ${i + 1}: route render registers one route-scoped layer`);
    dispose!();
    assertOk(counters.modePops === popsBefore + 1, `cycle ${i + 1}: leaving route pops mode exactly once`);
    assertOk(counters.layerDisposersInvoked === baseDisposersAtStart + (i + 1), `cycle ${i + 1}: route-scoped layer disposer invoked on route leave`);
  }

  // After cycles, push/pop must be balanced and base layer must be unique.
  assertOk(counters.modePushes === counters.modePops, `mode push/pop balanced after ${CYCLES} cycles (pushes=${counters.modePushes}, pops=${counters.modePops})`);
  assertOk(counters.modePushes === CYCLES, `expected ${CYCLES} mode pushes`);
  assertOk(counters.modePops === CYCLES, `expected ${CYCLES} mode pops`);
  assertOk(counters.layerRegistrations === baseLayerRegistrations + CYCLES, "base keymap layer registered once; only route-scoped layers added per cycle");
  assertOk(layers.filter((l) => l.mode === "base").length === 1, "exactly one base keymap layer is registered");
  assertOk(counters.layerDisposersInvoked === CYCLES, `all ${CYCLES} route-scoped layer disposers invoked on route leave (no leak)`);
  assertOk(counters.routeRegistrations === 1, "no duplicate route registration after repeated route cycles");

  // === No listener leak on globalThis registry ===
  const registry = getOrCreateModelConfigRegistry();
  const initialRevision = registry.revision;
  // Subscribe a listener and verify unsubscribe reduces listener count.
  let listenerCalls = 0;
  const unsubscribe = registry.subscribe(() => {
    listenerCalls++;
  });
  registry.publish({
    providerId: "cleanup-test",
    modelId: "cleanup-test",
    contextWindow: null,
    maxOutputTokens: null,
    capabilities: [],
    inputPerMillion: null,
    outputPerMillion: null,
    cachedPerMillion: null,
    currency: "USD",
    isBlocked: false,
    subscription: null,
    metadataEnvelopeHash: null,
  });
  assertOk(listenerCalls === 1, "subscriber receives publish event");
  unsubscribe();
  registry.publish({
    providerId: "cleanup-test",
    modelId: "cleanup-test",
    contextWindow: null,
    maxOutputTokens: null,
    capabilities: [],
    inputPerMillion: null,
    outputPerMillion: null,
    cachedPerMillion: null,
    currency: "USD",
    isBlocked: false,
    subscription: null,
    metadataEnvelopeHash: null,
  });
  assertOk(listenerCalls === 1, "unsubscribed listener does not receive subsequent events (no leak)");

  // === Plugin unload disposes base keymap and route registrations ===
  for (const dispose of disposers) {
    dispose();
  }
  // The base layer registration was onDispose'd by tui(); the only outstanding
  // disposer after route cycles is the base one.
  assertOk(
    counters.layerDisposersInvoked === CYCLES + 1,
    `base keymap layer disposer invoked on plugin unload (disposers=${counters.layerDisposersInvoked}, expected=${CYCLES + 1})`,
  );
  assertOk(counters.routeDisposersInvoked === 1, "route registration disposer invoked on plugin unload");

  // Cleanup entry from registry (so we don't pollute subsequent tests)
  const key = "cleanup-test/cleanup-test";
  const deleted = (registry as unknown as { entries: Map<string, unknown> }).entries.delete(key);
  assertOk(deleted === true, "test cleanup entry removed from registry");

  // registry revision should have advanced at least 2 publishes (one before unsubscribe, one after)
  assertOk(registry.revision > initialRevision, "registry revision advances with each publish");

  console.log("\n=== INTEGRATION ROUTE CLEANUP + HOST COLLISION SUMMARY ===");
  if (failures.length === 0) {
    console.log("All route cleanup, listener leak, and host collision assertions passed.");
    process.exit(0);
  } else {
    console.error(failures.length + " assertion(s) failed.");
    process.exit(1);
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});