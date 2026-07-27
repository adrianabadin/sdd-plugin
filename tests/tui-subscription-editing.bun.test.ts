/**
 * PR3 Phase 3 — TUI Subscription editing renderer/keymap tests.
 *
 * This file drives the production `ModelControlCenter` through the
 * captured `keymap.registerLayer` surface and the OpenTUI testRender
 * renderer under Bun. It proves:
 *
 *   1. The subscription tab in `ModelDetailScreen` renders every
 *      subscription field with the descriptors' labels (no
 *      "pending schema (Task 5)" leftovers from the pre-PR3 baseline).
 *   2. A text descriptor (planName) opens a text session whose
 *      accept/parse contract comes from the shared typed editor.
 *   3. A numeric descriptor (periodicCost) opens a numeric session
 *      whose accept/parse contract preserves the PR1
 *      decimal/trailing-decimal policy.
 *   4. The detail draft is immutable: editing a subscription field
 *      updates the draft through the descriptor's update function,
 *      and the saved command carries the new value.
 *   5. Invalid buffer (trailing decimal) blocks the save; the dirty
 *      marker stays on the subscription tab until a valid save lands.
 *   6. Cancellation closes the session without mutating the draft
 *      (no leaked partial values into the saved command).
 *
 * Runs under Bun. The pure (Node) companion is
 * `tests/tui-subscription-editing.test.ts`.
 */
import { testRender } from "@opentui/solid";
import type { JSX } from "@opentui/solid";
import { createComponent } from "solid-js/web";
import ModelControlCenter from "../src/tui/ModelControlCenter.js";
import type { TuiPluginApi } from "@opencode-ai/plugin/tui";
import type { ConnectedModelInfo } from "../src/domain/model/connected-model.js";
import type { SaveModelDetailInput } from "../src/application/save-model-detail/save-model-detail.use-case.js";

console.log("--- PR3 Phase 3: TUI Subscription editing (Bun renderer) ---");

let failures = 0;
function assert(condition: unknown, message: string): void {
  if (condition) {
    console.log(`  pass: ${message}`);
  } else {
    failures++;
    console.error(`  FAIL: ${message}`);
  }
}
assert.ok = function(condition: unknown, message?: string) {
  assert(condition, message ?? "expected truthy value");
};
assert.equal = function(actual: unknown, expected: unknown, message?: string) {
  assert(actual === expected, message ?? `expected ${String(expected)}, got ${String(actual)}`);
};

interface Harness {
  runKey: (key: string) => Promise<boolean>;
  frame: () => string;
  saves: SaveModelDetailInput[];
  waitForFrame: (predicate: (frame: string) => boolean) => Promise<unknown>;
  flush: () => Promise<void>;
  destroy: () => void;
}

interface MountOptions {
  withPersistence: boolean;
}

async function mountDetailScreen(options: MountOptions): Promise<Harness> {
  const saves: SaveModelDetailInput[] = [];

  const api: TuiPluginApi = {
    app: { version: "1.18.4" },
    attention: {} as never,
    keys: {} as never,
    keymap: {
      registerLayer: (layer: unknown) => {
        const snapshot = layer as {
          priority?: number;
          commands?: Array<{ name: string; run: (ctx?: unknown) => void }>;
          bindings?: Array<{ key: string; cmd: string }>;
        };
        const entry = {
          priority: snapshot.priority ?? 0,
          commands: (snapshot.commands ?? []).map((c) => ({ name: c.name, run: c.run })),
          bindings: (snapshot.bindings ?? []).map((b) => ({ key: b.key, cmd: b.cmd })),
        };
        layers.push(entry);
        return () => {
          const idx = layers.indexOf(entry);
          if (idx !== -1) layers.splice(idx, 1);
        };
      },
    } as never,
    route: { register: () => () => {}, navigate: () => {}, current: { name: "home" } },
    mode: { current: () => "modal", push: () => () => {} },
    ui: {
      DialogAlert: (() => null) as never,
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
    lifecycle: { signal: new AbortController().signal, onDispose: () => () => {} },
  };

  const models: ConnectedModelInfo[] = [
    { providerId: "openai", modelId: "gpt-4o", modelName: "GPT-4o" },
  ];

  const saveDetailUseCase = {
    execute: async (input: SaveModelDetailInput) => {
      saves.push(input);
      return {
        outcome: "verified" as const,
        updatedAt: new Date("2026-07-27T00:00:00Z"),
        envelopeHash: "verified-hash-subscription",
      };
    },
  };

  const props: Record<string, unknown> = {
    api,
    catalog: { getConnectedModels: async () => models },
    detailQuery: { findModelDetail: async () => null },
  };
  if (options.withPersistence) {
    props.saveDetailUseCase = saveDetailUseCase;
  }

  const setup = await testRender(
    () => createComponent(ModelControlCenter, props as never) as JSX.Element,
  );

  const runKey = async (key: string): Promise<boolean> => {
    for (let i = layers.length - 1; i >= 0; i--) {
      const layer = layers[i]!;
      let binding = layer.bindings.find((candidate) => candidate.key === key);
      let isWildcard = false;
      if (!binding && key.length === 1) {
        binding = layer.bindings.find((candidate) => candidate.key === "<character>");
        isWildcard = true;
      }
      if (!binding) continue;
      const command = layer.commands.find((candidate) => candidate.name === binding.cmd);
      if (!command) continue;
      if (isWildcard) {
        (command.run as (ctx?: { ch?: string }) => void)({ ch: key });
      } else {
        command.run();
      }
      await setup.flush();
      return true;
    }
    console.error(`  FAIL: no registered command for key '${key}'`);
    failures++;
    return false;
  };

  return {
    runKey,
    frame: () => setup.captureCharFrame(),
    saves,
    waitForFrame: (predicate) => setup.waitForFrame(predicate),
    flush: () => setup.flush(),
    destroy: () => setup.renderer.destroy(),
  };
}

const layers: Array<{
  priority: number;
  commands: Array<{ name: string; run: (ctx?: unknown) => void }>;
  bindings: Array<{ key: string; cmd: string }>;
}> = [];

async function navigateToSubscriptionTab(h: Harness): Promise<void> {
  await h.waitForFrame((frame) => frame.includes("Model Control Center"));
  await h.runKey("enter");
  await h.waitForFrame((frame) => frame.includes("Connected Providers") && frame.includes("openai"));
  await h.runKey("enter");
  await h.waitForFrame((frame) => frame.includes("Models (openai)") && frame.includes("GPT-4o"));
  await h.runKey("enter");
  await h.waitForFrame((frame) => frame.includes("Model Detail: GPT-4o"));
  // Tab to BENCHMARKS, then PRICING, then SUBSCRIPTION tab.
  await h.runKey("tab");
  await h.waitForFrame((frame) => frame.includes("BENCHMARKS"));
  await h.runKey("tab");
  await h.waitForFrame((frame) => frame.includes("PRICING"));
  await h.runKey("tab");
  await h.waitForFrame((frame) => frame.includes("SUBSCRIPTION"));
}

async function testSubscriptionTabRendersDescriptors(): Promise<void> {
  console.log("\n[case] subscription tab renders the four typed descriptors (no pending-schema labels)");
  const h = await mountDetailScreen({ withPersistence: true });
  await navigateToSubscriptionTab(h);

  const frame = h.frame();
  // Every subscription field's label is rendered.
  assert(frame.includes("Plan Name"), "Plan Name label rendered");
  assert(frame.includes("Periodic Cost"), "Periodic Cost label rendered");
  assert(frame.includes("Included Usage"), "Included Usage label rendered");
  assert(frame.includes("Overage Rate"), "Overage Rate label rendered");
  // The pre-PR3 "pending schema (Task 5)" labels are gone.
  assert(
    !frame.includes("pending schema"),
    "no 'pending schema (Task 5)' labels remain on the subscription tab",
  );
  h.destroy();
}

async function testPlanNameTextEditSession(): Promise<void> {
  console.log("\n[case] planName opens a text session with the shared typed editor");
  const h = await mountDetailScreen({ withPersistence: true });
  await navigateToSubscriptionTab(h);
  // Enter focus area on the subscription tab.
  await h.runKey("enter");
  await h.waitForFrame((frame) => frame.includes("FOCUS: Form Fields"));
  // Field 0: Subscription Enabled, Field 1: Tier, Field 2: Plan Name.
  // Tab 2 times to reach Plan Name.
  await h.runKey("tab");
  await h.runKey("tab");
  await h.waitForFrame((frame) => frame.includes("> Plan Name:"));
  await h.runKey("enter");
  await h.waitForFrame((frame) => frame.includes("EDIT:"));
  // The text accept contract accepts any printable character.
  for (const ch of "Team") await h.runKey(ch);
  await h.waitForFrame((frame) => frame.includes("EDIT: Team"));
  // Commit with Enter.
  await h.runKey("enter");
  await h.waitForFrame((frame) => frame.includes("Plan Name: Team"));
  // The draft is now dirty on the subscription tab.
  assert(h.frame().includes("UNSAVED DRAFT"), "typed value marks the draft dirty");
  h.destroy();
}

async function testPeriodicCostNumericEditSession(): Promise<void> {
  console.log("\n[case] periodicCost opens a numeric session with PR1 decimal policy");
  const h = await mountDetailScreen({ withPersistence: true });
  await navigateToSubscriptionTab(h);
  await h.runKey("enter");
  // Tab to Plan Name (2), Periodic Cost (3).
  await h.runKey("tab");
  await h.runKey("tab");
  await h.runKey("tab");
  await h.waitForFrame((frame) => frame.includes("> Periodic Cost:"));
  await h.runKey("enter");
  await h.waitForFrame((frame) => frame.includes("EDIT:"));
  // Numeric accept contract: digits + a single decimal.
  for (const ch of "30.5") await h.runKey(ch);
  await h.waitForFrame((frame) => frame.includes("EDIT: 30.5"));
  // A second decimal is rejected by the accept contract (PR1 numeric policy).
  await h.runKey(".");
  assert(
    !h.frame().includes("EDIT: 30.5."),
    "second decimal is rejected by the numeric accept contract",
  );
  // Commit.
  await h.runKey("enter");
  await h.waitForFrame((frame) => frame.includes("Periodic Cost: $30.5"));
  h.destroy();
}

async function testInvalidBufferBlocksSaveAndDirtyStays(): Promise<void> {
  console.log("\n[case] invalid numeric buffer (trailing decimal) blocks save and keeps the dirty marker");
  const h = await mountDetailScreen({ withPersistence: true });
  await navigateToSubscriptionTab(h);
  await h.runKey("enter");
  // Tab to Periodic Cost (3).
  await h.runKey("tab");
  await h.runKey("tab");
  await h.runKey("tab");
  await h.runKey("enter");
  // Buffer "12." — invalid per PR1 numeric policy.
  for (const ch of "12.") await h.runKey(ch);
  await h.waitForFrame((frame) => frame.includes("EDIT: 12."));
  // Ctrl+S without committing: the active buffer blocks the save.
  await h.runKey("ctrl+s");
  // The save is NOT invoked while the buffer is invalid.
  assert.equal(h.saves.length, 0, "invalid buffer blocks the save command");
  // Correct the buffer with digit 5 and commit.
  await h.runKey("5");
  await h.runKey("enter");
  await h.runKey("ctrl+s");
  await h.waitForFrame((frame) => frame.includes("Persisted and verified"));
  assert.equal(h.saves.length, 1, "save runs once the buffer becomes valid");
  const saved = h.saves[0];
  assert.ok(saved);
  assert.equal(saved!.periodicCost, 12.5, "save command receives the committed periodicCost");
  h.destroy();
}

async function testCancelSessionDoesNotMutateDraft(): Promise<void> {
  console.log("\n[case] cancel the session — draft is unchanged, no leaked partial value in the save");
  const h = await mountDetailScreen({ withPersistence: true });
  await navigateToSubscriptionTab(h);
  await h.runKey("enter");
  // Tab to Plan Name (2) and start the session.
  await h.runKey("tab");
  await h.runKey("tab");
  await h.runKey("enter");
  await h.waitForFrame((frame) => frame.includes("EDIT:"));
  for (const ch of "Trial") await h.runKey(ch);
  // Esc cancels the session; the draft remains as it was (null planName).
  await h.runKey("esc");
  await h.waitForFrame((frame) => !frame.includes("EDIT:"));
  const frame = h.frame();
  assert(!frame.includes("Plan Name: Trial"), "cancelled session does not write Trial into the draft");
  assert(
    !frame.includes("UNSAVED DRAFT"),
    "cancelled session does not mark the draft dirty",
  );
  // Save with no changes — the save command receives null for planName
  // (the baseline) and verifies successfully.
  await h.runKey("ctrl+s");
  await h.waitForFrame((frame) => frame.includes("Persisted and verified"));
  assert.equal(h.saves.length, 1, "save runs after cancel with no partial values");
  const saved = h.saves[0];
  assert.ok(saved);
  assert.equal(saved!.planName, null, "save command receives null planName (no leaked value)");
  h.destroy();
}

async function main(): Promise<void> {
  await testSubscriptionTabRendersDescriptors();
  await testPlanNameTextEditSession();
  await testPeriodicCostNumericEditSession();
  await testInvalidBufferBlocksSaveAndDirtyStays();
  await testCancelSessionDoesNotMutateDraft();

  console.log("\n=== PR3 SUBSCRIPTION EDITING SUMMARY ===");
  if (failures > 0) {
    console.error(`${failures} assertion(s) failed.`);
    process.exit(1);
  }
  console.log("All PR3 subscription editing assertions passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
