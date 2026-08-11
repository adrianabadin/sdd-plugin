import nodeAssert from "node:assert/strict";
import { testRender } from "@opentui/solid";
import type { JSX } from "@opentui/solid";
import { createComponent } from "solid-js/web";
import ModelControlCenter from "../src/tui/ModelControlCenter.js";
import type { ConnectedModelInfo } from "../src/domain/model/connected-model.js";
import type { TuiPluginApi } from "@opencode-ai/plugin/tui";
import type { SaveModelDetailInput } from "../src/application/save-model-detail/save-model-detail.use-case.js";

/**
 * Real Ctrl+S behaviour through the registered keymap commands and the rendered
 * frame. This drives the production ModelControlCenter, not helper functions.
 */
console.log("--- C9: Ctrl+S save behaviour via registered commands ---");

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

/** Mount the production component and expose its registered command surface. */
async function mountDetailScreen(options: { withPersistence: boolean }): Promise<Harness> {
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
      return {
        outcome: "verified" as const,
        updatedAt: new Date("2026-07-26T00:00:00Z"),
        envelopeHash: "verified-hash",
      };
    },
  };

  const props: Record<string, unknown> = {
    api,
    catalog: { getConnectedModels: async () => models },
     detailQuery: {
       findModelDetail: async () => ({
         providerId: "openai",
         providerName: "OpenAI",
         providerSubscription: null,
         providerIsBlocked: false,
         providerQuarantineType: null,
         providerQuarantineUntil: null,
         modelId: "gpt-4o",
         modelName: "GPT-4o",
         benchmarks: null,
         modelQuarantineType: null,
         modelQuarantineUntil: null,
         modelProviderQuarantineType: null,
         modelProviderQuarantineUntil: null,
         pricing: null,
         providerMetadata: undefined,
         modelMetadata: undefined,
         metadataEnvelopeHash: "baseline-envelope-hash",
       }),
     },
  };
  if (options.withPersistence) {
    props.saveDetailUseCase = saveDetailUseCase;
  }

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

  return {
    runKey,
    frame: () => setup.captureCharFrame(),
    saves,
    waitForFrame: (predicate) => setup.waitForFrame(predicate),
  };
}

/** Ctrl+S with a VALID active buffer commits it and saves exactly once. */
async function testValidBufferCommitsAndSaves(): Promise<void> {
  console.log("\n[case] valid active buffer + Ctrl+S");
  const h = await mountDetailScreen({ withPersistence: true });

  await h.runKey("enter"); // start numeric edit
  assert(h.frame().includes("EDIT: <empty>"), "numeric edit session started");

  await h.runKey("8");
  await h.runKey("8");
  await h.runKey(".");
  await h.runKey("5");
  assert(h.frame().includes("EDIT: 88.5"), "active buffer holds 88.5 before Ctrl+S");

  // Ctrl+S WITHOUT a prior Enter: Save must commit the active buffer first.
  await h.runKey("ctrl+s");
  await h.waitForFrame((frame) => frame.includes("Persisted and verified"));

  assert(h.saves.length === 1, `Save invoked exactly once (got ${h.saves.length})`);
   assert(
     h.saves[0]?.benchmarks.mmlu === 88.5,
     `Save received the committed numeric value 88.5 (got ${String(h.saves[0]?.benchmarks.mmlu)})`,
   );
   nodeAssert.deepEqual(
     h.saves[0],
     {
       providerId: "openai",
       modelId: "gpt-4o",
       providerName: "OpenAI",
       modelName: "GPT-4o",
       isBlocked: false,
       subscription: null,
       planName: null,
       periodicCost: null,
       includedUsage: null,
       overageRate: null,
       contextWindow: null,
       maxOutputTokens: null,
       capabilities: [],
       benchmarks: {
         mmlu: 88.5,
         humaneval: null,
         sweBench: null,
         gpqa: null,
         math: null,
         bbh: null,
         mtBench: null,
         multineedle: null,
       },
       pricing: {
         inputPerMillion: null,
         outputPerMillion: null,
         cachedPerMillion: null,
         currency: "USD",
       },
       expectedEnvelopeHash: "baseline-envelope-hash",
     },
     "Ctrl+S forwards the complete edited draft payload and expected envelope hash",
   );

  const frame = h.frame();
  assert(frame.includes("NOTICE: Persisted and verified"), "verified success notice rendered");
  assert(!frame.includes("UNSAVED DRAFT"), "draft is clean after verified persistence");
  assert(!frame.includes("EDIT:"), "edit session closed after successful commit + save");
}

/** Ctrl+S with an INVALID active buffer must not save and must keep editing. */
async function testInvalidBufferBlocksSave(): Promise<void> {
  console.log("\n[case] invalid active buffer + Ctrl+S");
  const h = await mountDetailScreen({ withPersistence: true });

  await h.runKey("enter");
  await h.runKey("1");
  await h.runKey("2");
  await h.runKey(".");
  assert(h.frame().includes("EDIT: 12."), "active buffer holds incomplete '12.'");

  await h.runKey("ctrl+s");

  assert(h.saves.length === 0, `Save invoked zero times for an invalid buffer (got ${h.saves.length})`);

  const frame = h.frame();
  assert(frame.includes("ERROR:"), "validation error surfaced for the incomplete buffer");
  assert(frame.includes("EDIT: 12."), "edit session retained with its buffer intact");
  // The invalid buffer must not leak into the draft: an uncommitted edit leaves
  // the draft equal to its baseline, so no unsaved-draft marker may appear.
  assert(
    !frame.includes("UNSAVED DRAFT"),
    "invalid buffer is not committed into the draft (no partial write)",
  );
  assert(!frame.includes("Persisted and verified"), "no success notice for a blocked save");

  // The retained session is still live: continuing the edit then saving works.
  await h.runKey("5");
  await h.runKey("ctrl+s");
  await h.waitForFrame((f) => f.includes("Persisted and verified"));
  assert(h.saves.length === 1, `Save runs once the buffer becomes valid (got ${h.saves.length})`);
  assert(
    h.saves[0]?.benchmarks.mmlu === 12.5,
    `continued edit committed 12.5 (got ${String(h.saves[0]?.benchmarks.mmlu)})`,
  );
}

/** Without persistence there is no save and the dirty baseline is preserved. */
async function testNoPersistenceKeepsDirty(): Promise<void> {
  console.log("\n[case] persistence unavailable + Ctrl+S");
  const h = await mountDetailScreen({ withPersistence: false });

  await h.runKey("enter");
  await h.runKey("7");
  await h.runKey("7");
  await h.runKey("enter"); // commit buffer into the draft
  assert(h.frame().includes("UNSAVED DRAFT"), "committed edit marks the draft dirty");

  await h.runKey("ctrl+s");
  await h.waitForFrame((frame) => frame.includes("Persistence unavailable"));

  assert(h.saves.length === 0, `no Save invocation without persistence (got ${h.saves.length})`);

  const frame = h.frame();
  assert(
    frame.includes("NOTICE: Persistence unavailable"),
    "persistence-unavailable notice rendered instead of a success message",
  );
  assert(!frame.includes("Persisted and verified"), "no success notice without persistence");
  assert(
    frame.includes("UNSAVED DRAFT"),
    "dirty baseline retained: no clean in-memory fallback",
  );
}

async function main(): Promise<void> {
  await testValidBufferCommitsAndSaves();
  await testInvalidBufferBlocksSave();
  await testNoPersistenceKeepsDirty();

  console.log("\n=== C9 CTRL+S SUMMARY ===");
  if (failures > 0) {
    console.error(`${failures} assertion(s) failed.`);
    process.exit(1);
  }
  console.log("All Ctrl+S save-behaviour assertions passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
