import { testRender } from "@opentui/solid";
import type { JSX } from "@opentui/solid";
import { createComponent } from "solid-js/web";
import ModelControlCenter from "../src/tui/ModelControlCenter.js";
import type { ConnectedModelInfo } from "../src/domain/model/connected-model.js";
import type { TuiPluginApi } from "@opencode-ai/plugin/tui";

const failures: string[] = [];

function assert(condition: unknown, message: string): void {
  if (condition) {
    console.log(`  pass: ${message}`);
    return;
  }
  failures.push(message);
  console.error(`  FAIL: ${message}`);
}

async function testPureNumericEditing(): Promise<void> {
  console.log("\n--- Numeric edit session and field descriptors ---");

  let numeric: Record<string, unknown> | null = null;
  try {
    numeric = await import("../src/tui/model-detail-numeric-edit.js");
  } catch {
    // RED: the focused helper does not exist yet.
  }

  assert(numeric !== null, "numeric edit helper module exists");
  if (!numeric) return;

  const startNumericEdit = numeric.startNumericEdit as ((value: number | null) => { buffer: string; error?: string }) | undefined;
  const appendNumericEdit = numeric.appendNumericEdit as ((session: { buffer: string; error?: string }, input: string) => { buffer: string; error?: string }) | undefined;
  const backspaceNumericEdit = numeric.backspaceNumericEdit as ((session: { buffer: string; error?: string }) => { buffer: string; error?: string }) | undefined;
  const parseNumericEdit = numeric.parseNumericEdit as ((session: { buffer: string; error?: string }) => { ok: boolean; value?: number; error?: string }) | undefined;
  const getNumericFieldDescriptor = numeric.getNumericFieldDescriptor as ((tab: string, index: number) => { path: string } | undefined) | undefined;
  const getNumericFieldDescriptors = numeric.getNumericFieldDescriptors as ((tab: string) => ReadonlyArray<{ path: string }>) | undefined;
  const getPricingCurrencyFieldIndex = numeric.getPricingCurrencyFieldIndex as (() => number) | undefined;
  const updateNumericDetailField = numeric.updateNumericDetailField as ((draft: any, tab: string, index: number, value: number) => any) | undefined;

  assert(typeof startNumericEdit === "function", "startNumericEdit is exported");
  assert(typeof appendNumericEdit === "function", "appendNumericEdit is exported");
  assert(typeof backspaceNumericEdit === "function", "backspaceNumericEdit is exported");
  assert(typeof parseNumericEdit === "function", "parseNumericEdit is exported");
  assert(typeof getNumericFieldDescriptor === "function", "getNumericFieldDescriptor is exported");
  assert(typeof getPricingCurrencyFieldIndex === "function", "pricing currency index derives from the centralized descriptor module");
  assert(typeof updateNumericDetailField === "function", "updateNumericDetailField is exported");
  if (!startNumericEdit || !appendNumericEdit || !backspaceNumericEdit || !parseNumericEdit || !getNumericFieldDescriptor || !getNumericFieldDescriptors || !getPricingCurrencyFieldIndex || !updateNumericDetailField) return;

  assert(
    getPricingCurrencyFieldIndex() === getNumericFieldDescriptors("pricing").length,
    "pricing currency index follows the numeric pricing descriptor count",
  );

  const empty = startNumericEdit(null);
  assert(empty.buffer === "", "starting an edit from null uses an empty buffer");

  let session = appendNumericEdit(empty, "1");
  session = appendNumericEdit(session, "2");
  session = appendNumericEdit(session, ".");
  session = appendNumericEdit(session, ".");
  session = appendNumericEdit(session, "5");
  assert(session.buffer === "12.5", "digits append and a second decimal point is rejected");

  session = backspaceNumericEdit(session);
  assert(session.buffer === "12.", "Backspace removes the final buffer character");
  session = appendNumericEdit(session, "5");
  const parsed = parseNumericEdit(session);
  assert(parsed.ok && parsed.value === 12.5, "a finite non-negative decimal buffer parses for commit");
  assert(!parseNumericEdit({ buffer: "." }).ok, "an incomplete decimal buffer cannot commit");
  assert(!parseNumericEdit({ buffer: "12." }).ok, "a trailing decimal buffer cannot commit");
  const leadingDecimal = parseNumericEdit({ buffer: ".5" });
  assert(leadingDecimal.ok && leadingDecimal.value === 0.5, "a leading decimal with digits remains valid");
  assert(!parseNumericEdit({ buffer: "-1" }).ok, "a negative buffer cannot commit");

  const expectedMappings: Array<[string, number, string]> = [
    ["benchmarks", 0, "benchmarks.mmlu"],
    ["benchmarks", 1, "benchmarks.humaneval"],
    ["benchmarks", 2, "benchmarks.sweBench"],
    ["benchmarks", 3, "benchmarks.gpqa"],
    ["benchmarks", 4, "benchmarks.math"],
    ["benchmarks", 5, "benchmarks.bbh"],
    ["benchmarks", 6, "benchmarks.mtBench"],
    ["benchmarks", 7, "benchmarks.multineedle"],
    ["pricing", 0, "inputPerMillion"],
    ["pricing", 1, "outputPerMillion"],
    ["pricing", 2, "cachedPerMillion"],
  ];

  const draft = {
    benchmarks: {
      mmlu: null,
      humaneval: null,
      sweBench: null,
      gpqa: null,
      math: null,
      bbh: null,
      mtBench: null,
      multineedle: null,
    },
    inputPerMillion: null,
    outputPerMillion: null,
    cachedPerMillion: null,
  };

  for (const [tab, index, path] of expectedMappings) {
    const descriptor = getNumericFieldDescriptor(tab, index);
    assert(descriptor?.path === path, `${tab} field ${index} maps to ${path}`);
    const updated = updateNumericDetailField(draft, tab, index, index + 0.5);
    const actual = path.startsWith("benchmarks.")
      ? updated.benchmarks[path.slice("benchmarks.".length)]
      : updated[path];
    assert(actual === index + 0.5, `${path} updates through the immutable descriptor path`);
    assert(updated !== draft, `${path} update returns a new draft`);
    assert(draft.benchmarks.mmlu === null && draft.inputPerMillion === null, `${path} update leaves the source draft unchanged`);
  }

  assert(getNumericFieldDescriptor("pricing", 3) === undefined, "Pricing currency is not a supported numeric field");
  assert(getNumericFieldDescriptor("overview", 0) === undefined, "Overview fields are not supported numeric fields");
  assert(getNumericFieldDescriptor("subscription", 0) === undefined, "Subscription fields are not supported numeric fields");
}

async function testRegisteredCommandPath(): Promise<void> {
  console.log("\n--- Registered keymap command path ---");

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

  const setup = await testRender(() =>
    createComponent(ModelControlCenter, {
      api,
      catalog: { getConnectedModels: async () => models },
      detailQuery: { findModelDetail: async () => null },
    }) as JSX.Element,
  );

  const runKey = async (key: string): Promise<boolean> => {
    const layer = componentLayer as {
      commands: Array<{ name: string; run: () => void }>;
      bindings: Array<{ key: string; cmd: string }>;
    } | null;
    const binding = layer?.bindings.find((candidate) => candidate.key === key);
    assert(Boolean(binding), `registered keymap contains '${key}' binding`);
    const command = binding
      ? layer?.commands.find((candidate) => candidate.name === binding.cmd)
      : undefined;
    assert(Boolean(command), `registered '${key}' binding resolves to a command`);
    if (!command) return false;
    command.run();
    await setup.flush();
    return true;
  };

  await setup.waitForFrame((frame) => frame.includes("Model Control Center"));
  await runKey("enter");
  await setup.waitForFrame((frame) => frame.includes("Connected Providers") && frame.includes("openai"));
  await runKey("enter");
  await setup.waitForFrame((frame) => frame.includes("Models (openai)") && frame.includes("GPT-4o"));
  await runKey("enter");
  await setup.waitForFrame((frame) => frame.includes("Model Detail: GPT-4o") && frame.includes("Model ID (readonly)"));

  await runKey("tab");
  let frame = setup.captureCharFrame();
  assert(frame.includes("BENCHMARKS"), "outside edit mode Tab keeps existing tab navigation");
  await runKey("enter");
  frame = setup.captureCharFrame();
  assert(/>\s*mmlu:\s*null/.test(frame), "Enter on the tab strip keeps existing field-focus navigation");

  await runKey("enter");
  frame = setup.captureCharFrame();
  assert(frame.includes("EDIT: <empty>"), "Enter on a supported focused field starts an explicit empty edit buffer");

  await runKey(".");
  await runKey("enter");
  frame = setup.captureCharFrame();
  assert(frame.includes("ERROR: Enter a finite non-negative number"), "an incomplete buffer remains in edit mode with visible validation");
  await runKey("5");
  frame = setup.captureCharFrame();
  assert(!frame.includes("ERROR:"), "editing an invalid buffer clears its stale validation message");
  await runKey("esc");
  frame = setup.captureCharFrame();
  assert(/>\s*mmlu:\s*null/.test(frame), "Escape cancels without mutating the focused null field");
  assert(!frame.includes("EDIT:"), "Escape closes the edit indicator while retaining field focus");

  await runKey("enter");
  const numericKeysAvailable =
    (await runKey("1")) &&
    (await runKey("2")) &&
    (await runKey(".")) &&
    (await runKey("5"));
  if (numericKeysAvailable) {
    await runKey("enter");
  }
  frame = setup.captureCharFrame();
  assert(/>\s*mmlu:\s*12\.5/.test(frame), "Enter -> 1 -> 2 -> . -> 5 -> Enter changes null to 12.5 through registered commands");
  assert(frame.includes("UNSAVED DRAFT"), "committing the numeric edit marks the rendered draft dirty");

  await runKey("tab");
  frame = setup.captureCharFrame();
  assert(/>\s*humaneval:\s*null/.test(frame), "outside edit mode Tab still advances the focused field");
  await runKey("enter");
  await runKey("1");
  await runKey("2");
  await runKey("tab");
  frame = setup.captureCharFrame();
  assert(/>\s*humaneval:\s*\[EDIT:\s*12\]/.test(frame), "Tab cannot move the cursor away from an active edit target or change its buffer");
  await runKey("shift+tab");
  await runKey("shift+tab");
  frame = setup.captureCharFrame();
  assert(/>\s*humaneval:\s*\[EDIT:\s*12\]/.test(frame), "Shift+Tab cannot move the cursor away from an active edit target or change its buffer");
  await runKey("backspace");
  await runKey("3");
  await runKey("enter");
  frame = setup.captureCharFrame();
  assert(/>\s*humaneval:\s*13/.test(frame), "Backspace edits the buffer before commit");

  await runKey("tab");
  await runKey("enter");
  await runKey("1");
  await runKey(".");
  await runKey(".");
  await runKey("5");
  frame = setup.captureCharFrame();
  assert(frame.includes("EDIT: 1.5"), "a second decimal point is visibly rejected from the edit buffer");
  await runKey("enter");
  frame = setup.captureCharFrame();
  assert(/>\s*sweBench:\s*1\.5/.test(frame), "the single-decimal buffer commits without corruption");

  await runKey("tab");
  await runKey("enter");
  await runKey("1");
  await runKey("2");
  await runKey(".");
  await runKey("enter");
  frame = setup.captureCharFrame();
  assert(/>\s*gpqa:\s*\[EDIT:\s*12\.\]/.test(frame), "a trailing decimal remains in the active edit buffer on commit");
  assert(frame.includes("ERROR: Enter a finite non-negative number"), "a trailing decimal commit surfaces validation without mutating the draft");
  await runKey("esc");
  frame = setup.captureCharFrame();
  assert(/>\s*gpqa:\s*null/.test(frame), "cancelling after a trailing decimal confirms the draft stayed unchanged");

  await runKey("esc");
  frame = setup.captureCharFrame();
  assert(frame.includes("FOCUS: Tab Strip"), "outside edit mode Escape keeps existing fields-to-tabs navigation");

  await runKey("tab");
  frame = setup.captureCharFrame();
  assert(frame.includes("PRICING"), "registered Tab command reaches the Pricing tab");
  await runKey("enter");
  frame = setup.captureCharFrame();
  assert(/>\s*Input per 1M tokens:\s*null/.test(frame), "Pricing input field starts focused with a rendered null value");
  await runKey("enter");
  frame = setup.captureCharFrame();
  assert(/>\s*Input per 1M tokens:\s*\[EDIT:\s*<empty>\]/.test(frame), "registered Enter starts an empty Pricing numeric edit buffer");
  await runKey("4");
  await runKey(".");
  await runKey("2");
  await runKey("5");
  await runKey("enter");
  frame = setup.captureCharFrame();
  assert(/>\s*Input per 1M tokens:\s*\$4\.25/.test(frame), "registered Pricing commands commit and render 4.25 from null");
  assert(/PRICING\*/.test(frame), "committing the Pricing value marks the Pricing tab dirty");

  setup.renderer.destroy();
}

async function main(): Promise<void> {
  await testPureNumericEditing();
  await testRegisteredCommandPath();

  console.log("\n=== TUI NUMERIC EDITING TEST SUMMARY ===");
  if (failures.length > 0) {
    console.error(`${failures.length} assertion(s) failed.`);
    process.exit(1);
  }
  console.log("All numeric editing assertions passed.");
}

main().catch((error) => {
  console.error("TUI numeric editing test crashed:", error);
  process.exit(1);
});
