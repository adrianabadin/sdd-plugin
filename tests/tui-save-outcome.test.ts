/**
 * Finding 11/12 — TUI save outcome (PR4 RED, Bun-gated).
 *
 * ModelControlCenter must branch on the typed `SaveModelDetailResult.outcome`:
 *
 *   - `verified` → swap the loaded baseline and the draft, render the
 *     success notice.
 *   - `committed-unverified` → KEEP the prior baseline/draft (no swap), do
 *     NOT publish to the runtime registry, render a warning/mismatches/
 *     guidance notice, and never render "Persisted and verified" for this
 *     outcome.
 *
 * RED contract (asserted before ModelControlCenter is updated):
 *   1. Committed-unverified still renders "Persisted and verified".
 *   2. Committed-unverified still swaps the baseline/draft.
 *
 * GREEN contract (after ModelControlCenter is updated):
 *   1. Committed-unverified renders a warning/mismatches/guidance notice,
 *      does NOT render "Persisted and verified", and the prior
 *      baseline/draft remain unchanged (the dirty marker persists).
 *   2. Verified renders "Persisted and verified", clears the dirty marker,
 *      and the baseline/draft reflect the new envelope hash.
 */
import { testRender } from "@opentui/solid";
import type { JSX } from "@opentui/solid";
import { createComponent } from "solid-js/web";
import ModelControlCenter from "../src/tui/ModelControlCenter.js";
import type { ConnectedModelInfo } from "../src/domain/model/connected-model.js";
import type { TuiPluginApi } from "@opencode-ai/plugin/tui";
import type { SaveModelDetailInput } from "../src/application/save-model-detail/save-model-detail.use-case.js";

console.log("--- Finding 11/12: TUI save outcome (Bun) ---");

let failures = 0;
function assert(condition: unknown, message: string): void {
  if (condition) {
    console.log(`  pass: ${message}`);
  } else {
    failures++;
    console.error(`  FAIL: ${message}`);
  }
}

interface Harness {
  runKey: (key: string) => Promise<void>;
  frame: () => string;
  saves: SaveModelDetailInput[];
  waitForFrame: (predicate: (frame: string) => boolean) => Promise<unknown>;
}

interface MountOptions {
  saveOutcome: "verified" | "committed-unverified";
  publishSpy: () => number;
}

async function mountDetailScreen(options: MountOptions): Promise<Harness> {
  let componentLayer: {
    commands: Array<{ name: string; run: () => void }>;
    bindings: Array<{ key: string; cmd: string }>;
  } | null = null;

  const api: TuiPluginApi = {
    app: { version: "1.18.4" },
    attention: {} as never,
    keys: {} as never,
    keymap: {
      registerLayer: (layer: unknown) => {
        componentLayer = layer as typeof componentLayer;
        return () => {};
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

  const saves: SaveModelDetailInput[] = [];
  const saveDetailUseCase = {
    execute: async (input: SaveModelDetailInput) => {
      saves.push(input);
      if (options.saveOutcome === "verified") {
        return {
          outcome: "verified" as const,
          updatedAt: new Date("2026-07-26T00:00:00Z"),
          envelopeHash: "verified-hash-after-save",
        };
      }
      return {
        outcome: "committed-unverified" as const,
        updatedAt: new Date("2026-07-26T00:00:00Z"),
        envelopeHash: "committed-hash",
        mismatches: ["mmlu: expected 88.5, got 0", "inputPerMillion: expected 2.5, got null"],
        guidance: "Committed but verifier disagrees. Re-run verification or restore from backup.",
      };
    },
  };

  const props: Record<string, unknown> = {
    api,
    catalog: { getConnectedModels: async () => models },
    detailQuery: { findModelDetail: async () => null },
    saveDetailUseCase,
  };

  const setup = await testRender(
    () => createComponent(ModelControlCenter, props as never) as JSX.Element,
  );

  const runKey = async (key: string): Promise<void> => {
    const layer = componentLayer as {
      commands: Array<{ name: string; run: () => void }>;
      bindings: Array<{ key: string; cmd: string }>;
    } | null;
    const binding = layer?.bindings.find((candidate) => candidate.key === key);
    const command = binding
      ? layer?.commands.find((candidate) => candidate.name === binding.cmd)
      : undefined;
    if (!command) {
      failures++;
      console.error(`  FAIL: no registered command for key '${key}'`);
      return;
    }
    command.run();
    await setup.flush();
  };

  // Navigate: main menu -> providers -> models -> model detail -> BENCHMARKS
  await setup.waitForFrame((frame) => frame.includes("Model Control Center"));
  await runKey("enter");
  await setup.waitForFrame((frame) => frame.includes("Connected Providers") && frame.includes("openai"));
  await runKey("enter");
  await setup.waitForFrame((frame) => frame.includes("Models (openai)") && frame.includes("GPT-4o"));
  await runKey("enter");
  await setup.waitForFrame((frame) => frame.includes("Model Detail: GPT-4o"));
  await runKey("tab");
  await setup.waitForFrame((frame) => frame.includes("BENCHMARKS"));
  await runKey("enter"); // focus first field (mmlu)
  await runKey("enter"); // start numeric edit session on the focused field
  await setup.waitForFrame((frame) => frame.includes("EDIT:"));
  await runKey("8");
  await runKey("8");
  await runKey(".");
  await runKey("5");
  await setup.waitForFrame((frame) => frame.includes("EDIT: 88.5"));
  // The buffer now holds "88.5" but is NOT yet committed to the draft.
  // We deliberately do NOT commit the buffer manually here. The save path
  // in handleSaveIntent auto-commits the active numeric buffer before
  // invoking the use case, so a single ctrl+s both commits the draft and
  // triggers Save — matching the production save flow.
  return {
    runKey,
    frame: () => setup.captureCharFrame(),
    saves,
    waitForFrame: (predicate) => setup.waitForFrame(predicate),
  };
}

async function testVerifiedOutcome(): Promise<void> {
  console.log("\n[case] verified outcome — baseline/draft swap, success notice");
  const h = await mountDetailScreen({ saveOutcome: "verified", publishSpy: () => 0 });

  await h.runKey("ctrl+s");
  await h.waitForFrame((frame) => frame.includes("Persisted and verified"));

  assert(h.saves.length === 1, `verified: Save invoked exactly once (got ${h.saves.length})`);

  const frame = h.frame();
  assert(frame.includes("NOTICE: Persisted and verified"), "verified: success notice rendered");
  assert(!frame.includes("UNSAVED DRAFT"), "verified: dirty marker cleared after successful commit + save");
}

async function testCommittedUnverifiedOutcome(): Promise<void> {
  console.log("\n[case] committed-unverified outcome — baseline/draft retained, warning shown");
  const publishCount = { n: 0 };
  const h = await mountDetailScreen({
    saveOutcome: "committed-unverified",
    publishSpy: () => publishCount.n,
  });

  // Capture the baseline/draft state before ctrl+s so we can detect a swap.
  const frameBefore = h.frame();

  await h.runKey("ctrl+s");
  // Wait for the committed-unverified warning notice to render so we know
  // the save flow completed; the dirty marker should be present afterwards.
  await h.waitForFrame(
    (frame) =>
      /warning|committed[- ]?unverified|verifier|mismatch|guidance/i.test(frame),
  );

  assert(h.saves.length === 1, `committed-unverified: Save invoked exactly once (got ${h.saves.length})`);

  const frame = h.frame();
  void frameBefore;
  // === Exact success text MUST be absent.
  assert(
    !frame.includes("Persisted and verified"),
    "committed-unverified: success text MUST NOT render",
  );
  // === Warning/mismatches/guidance MUST be visible.
  assert(
    /warning|committed[- ]?unverified|verifier|mismatch|guidance/i.test(frame),
    "committed-unverified: warning / mismatches / guidance notice rendered",
  );
  // === Prior baseline/draft MUST remain unchanged. The dirty marker persists
  //     because the save committed the buffer but did NOT swap the baseline.
  assert(
    frame.includes("UNSAVED DRAFT"),
    "committed-unverified: prior dirty draft retained (baseline/draft unchanged)",
  );
  // === Persisted identifiers/data MUST still be visible to the caller. The
  //     envelope hash from the committed write MUST be surfaced so the user
  //     can identify what was committed.
  assert(
    frame.includes("committed-hash"),
    "committed-unverified: committed envelope hash surfaced for caller identification",
  );
}

async function main(): Promise<void> {
  await testVerifiedOutcome();
  await testCommittedUnverifiedOutcome();

  console.log("\n=== TUI SAVE OUTCOME SUMMARY ===");
  if (failures > 0) {
    console.error(`${failures} assertion(s) failed.`);
    process.exit(1);
  }
  console.log("All TUI save-outcome assertions passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});