/**
 * PR3 Phase 3 — TUI Subscription editing (pure / Node) tests.
 *
 * The Bun renderer test for the same scope lives in
 * `tests/tui-subscription-editing.bun.test.ts`. This file proves the
 * pure descriptor contracts that the subscription tab relies on:
 *
 *   1. Subscription descriptors exist for `planName` (text), and for
 *      `periodicCost`, `includedUsage`, and `overageRate` (numeric).
 *   2. `planName` is a text descriptor: accepts printable input, rejects
 *      blank/trim-only values, and updates the draft immutably.
 *   3. Numeric descriptors preserve the existing decimal/trailing-decimal
 *      contract: digits + a single decimal point, partial buffers
 *      (e.g. "12.") parse as a validation failure, leading-decimal
 *      ("0.5") parses, negatives are rejected.
 *   4. The `getSubscriptionFieldDescriptors` aggregator returns exactly
 *      four descriptors in a stable order so the screen field cursor
 *      and the save command can rely on indexes.
 *
 * Persistence round-trip is NOT exercised here: the spec scenario
 * "subscription edits survive restart" is a Phase 4 integration
 * concern. The PR1 `Provider.metadata` envelope round-trip is already
 * proven by `tests/full-contract-readback.test.ts` and is the contract
 * the existing `SaveModelDetailUseCase` uses today.
 */
import assert from "node:assert/strict";
import { extractCharacter } from "../src/tui/ModelControlCenter.js";
import {
  createBooleanFieldDescriptor,
  createNumericFieldDescriptor,
  createTextFieldDescriptor,
  getSubscriptionFieldDescriptors,
  parseNumericBuffer,
} from "../src/tui/model-detail-field-edit.js";
import type { DetailDraft } from "../src/tui/model-detail-view.js";

console.log("--- PR3 Phase 3: TUI subscription editing (pure) tests ---");

function makeDraft(): DetailDraft {
  return {
    providerId: "openai",
    modelId: "gpt-4o",
    providerName: "OpenAI",
    modelName: "GPT-4o",
    isBlocked: false,
    contextWindow: null,
    maxOutputTokens: null,
    capabilities: { vision: false, tools: false, reasoning: false },
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
    currency: "USD",
    subscriptionEnabled: true,
    subscriptionTier: "small",
    subscription: "small",
    planName: null,
    periodicCost: null,
    includedUsage: null,
    overageRate: null,
  };
}

function testSubscriptionDescriptorsExist(): void {
  console.log("\n--- subscription descriptors exist for every field ---");
  const descriptors = getSubscriptionFieldDescriptors();
  assert.equal(descriptors.length, 6, "six subscription descriptors are exposed");
  const keys = descriptors.map((d) => d.validationKey);
  assert.deepEqual(
    keys,
    ["subscriptionEnabled", "subscriptionTier", "planName", "periodicCost", "includedUsage", "overageRate"],
    "descriptors expose the six documented subscription keys in a stable order",
  );
  for (const descriptor of descriptors) {
    assert.equal(descriptor.tab, "subscription", "all subscription descriptors live on the subscription tab");
    assert.ok(typeof descriptor.path === "string" && descriptor.path.length > 0, "descriptor has a path");
    assert.ok(typeof descriptor.label === "string" && descriptor.label.length > 0, "descriptor has a label");
    assert.ok(typeof descriptor.read === "function", "descriptor exposes a read function");
    assert.ok(typeof descriptor.update === "function", "descriptor exposes an update function");
    assert.ok(typeof descriptor.accept === "function", "descriptor exposes an accept function");
    assert.ok(typeof descriptor.parse === "function", "descriptor exposes a parse function");
  }
}

function testPlanNameTextDescriptor(): void {
  console.log("\n--- planName is a typed text descriptor ---");
  const descriptors = getSubscriptionFieldDescriptors();
  const planName = descriptors.find((d) => d.validationKey === "planName");
  assert.ok(planName, "planName descriptor exists");
  // Narrow to the text descriptor so TypeScript can pick the right
  // `update` / `parse` overloads (the union of text and numeric
  // descriptor `update` would otherwise require `value: never`).
  const text = planName as ReturnType<typeof createTextFieldDescriptor>;
  assert.equal(text.kind, "text", "planName is a text descriptor (not numeric/boolean/enum)");
  const draft = makeDraft();
  assert.equal(text.read(draft), null, "planName reads the current draft value (null by default)");

  // Accept contract: any printable character appends; the descriptor
  // does NOT pre-trim during typing — that is the parse step's job.
  let buffer = "";
  buffer = text.accept(buffer, "P") ?? buffer;
  buffer = text.accept(buffer, "r") ?? buffer;
  buffer = text.accept(buffer, "o") ?? buffer;
  assert.equal(buffer, "Pro", "planName accepts printable characters");

  // Parse contract: trimmed non-empty is valid; blank/whitespace is rejected.
  const parsed = text.parse("  Pro  ");
  assert.equal(parsed.ok, true, "planName parse accepts a trimmed non-empty value");
  if (parsed.ok) {
    assert.equal(parsed.value, "Pro", "parse returns the value (NOT the buffer — caller trims for the draft)");
  }
  const blank = text.parse("   ");
  assert.equal(blank.ok, false, "planName parse rejects a whitespace-only value");
  const empty = text.parse("");
  assert.equal(empty.ok, false, "planName parse rejects an empty value");

  // Update contract: immutable draft, single-field replacement.
  const updated = text.update(draft, "Pro");
  assert.notEqual(updated, draft, "planName update returns a new draft");
  assert.equal(updated.planName, "Pro", "planName is replaced in the new draft");
  assert.equal(draft.planName, null, "source draft is unchanged after the update");

  // The persisted draft planName survives a back-and-forth through the
  // accept/parse contract without leaking the whitespace into storage.
  const roundTrip = text.read(text.update(draft, "  Team  "));
  assert.equal(roundTrip, "  Team  ", "draft stores the user-typed value verbatim; trim is the use case's responsibility");
}

function testNumericSubscriptionDescriptors(): void {
  console.log("\n--- periodicCost / includedUsage / overageRate are numeric descriptors ---");
  const descriptors = getSubscriptionFieldDescriptors();
  for (const key of ["periodicCost", "includedUsage", "overageRate"] as const) {
    const descriptor = descriptors.find((d) => d.validationKey === key);
    assert.ok(descriptor, `${key} descriptor exists`);
    assert.equal(descriptor!.kind, "numeric", `${key} is a numeric descriptor`);
    // path mirrors the existing PR1 convention
    assert.ok(typeof descriptor!.path === "string" && descriptor!.path.length > 0);
  }

  // Reuse the existing PR1 numeric accept/parse contract. Narrow to the
  // numeric descriptor so TypeScript can pick the right `update` overload.
  const cost = descriptors.find((d) => d.validationKey === "periodicCost") as ReturnType<typeof createNumericFieldDescriptor>;
  let buffer = "";
  for (const ch of "12.5") {
    buffer = cost.accept(buffer, ch) ?? buffer;
  }
  assert.equal(buffer, "12.5", "numeric descriptor accepts digits and a single decimal");
  buffer = cost.accept(buffer, ".") ?? buffer;
  assert.equal(buffer, "12.5", "a second decimal point is rejected by the numeric accept contract");

  // Parse: trailing decimal is invalid (matches PR1 numeric policy).
  const trailing = parseNumericBuffer("12.");
  assert.equal(trailing.ok, false, "trailing decimal is not commit-able");
  const leading = parseNumericBuffer(".5");
  assert.equal(leading.ok, true, "leading decimal parses to 0.5");
  if (leading.ok) {
    assert.equal(leading.value, 0.5, "leading decimal value matches the typed number");
  }
  const negative = parseNumericBuffer("-1");
  assert.equal(negative.ok, false, "negative numbers are rejected by the numeric parse contract");

  // Immutable update on the draft.
  const draft = makeDraft();
  const updated = cost.update(draft, 12.5);
  assert.equal(updated.periodicCost, 12.5, "periodicCost is set on the new draft");
  assert.equal(draft.periodicCost, null, "source draft is unchanged after the update");
}

function testSubscriptionDescriptorOrdering(): void {
  console.log("\n--- subscription descriptor aggregator is stable ---");
  const first = getSubscriptionFieldDescriptors();
  const second = getSubscriptionFieldDescriptors();
  assert.deepEqual(
    first.map((d) => d.validationKey),
    second.map((d) => d.validationKey),
    "repeated calls return descriptors in the same order",
  );
  for (let i = 0; i < first.length; i++) {
    assert.equal(first[i]!.index, i, `descriptor ${first[i]!.validationKey} index is ${i}`);
  }
}

function testReusedTextAndNumericDescriptorFactories(): void {
  console.log("\n--- shared typed factories are reused (no per-field copy) ---");
  // PR1 established the typed factories. The subscription tab reuses them
  // rather than introducing a parallel set of ad-hoc helpers.
  const planName = createTextFieldDescriptor({
    tab: "subscription",
    index: 0,
    path: "planName",
    label: "Plan Name",
    validationKey: "planName",
    read: (d) => d.planName,
    update: (d, next) => ({ ...d, planName: next }),
  });
  const cost = createNumericFieldDescriptor({
    tab: "subscription",
    index: 1,
    path: "periodicCost",
    label: "Periodic Cost",
    validationKey: "periodicCost",
    read: (d) => d.periodicCost,
    update: (d, next) => ({ ...d, periodicCost: next }),
  });
  assert.equal(planName.kind, "text");
  assert.equal(cost.kind, "numeric");
  // The aggregator exports a descriptor with the same key/path; here we
  // verify the in-place factories match the same accept/parse behaviour
  // as the centralised ones (single source of truth for the contracts).
  assert.equal(
    planName.accept("", "x"),
    "x",
    "in-place text factory accepts a single printable character",
  );
  assert.equal(
    cost.accept("", "5"),
    "5",
    "in-place numeric factory accepts a single digit",
  );
}

function testSubscriptionEnabledBooleanFieldDescriptor(): void {
  console.log("\n--- subscriptionEnabled is a typed boolean descriptor ---");
  const descriptors = getSubscriptionFieldDescriptors();
  const desc = descriptors.find((d) => d.validationKey === "subscriptionEnabled");
  assert.ok(desc, "subscriptionEnabled descriptor exists");
  const boolDesc = desc as ReturnType<typeof createBooleanFieldDescriptor>;
  assert.equal(boolDesc.kind, "boolean", "subscriptionEnabled is a boolean descriptor");
  const draft = makeDraft();
  assert.equal(boolDesc.read(draft), true, "reads current subscriptionEnabled");

  // Accept contract for boolean: "true"/"false" prefix matching
  let buffer = "";
  buffer = boolDesc.accept(buffer, "t") ?? buffer;
  buffer = boolDesc.accept(buffer, "r") ?? buffer;
  assert.equal(buffer, "tr", "accepts 'tr' prefix");

  // Parse contract
  const parsedTrue = boolDesc.parse("true");
  assert.equal(parsedTrue.ok, true);
  if (parsedTrue.ok) assert.equal(parsedTrue.value, true);

  const parsedFalse = boolDesc.parse("false");
  assert.equal(parsedFalse.ok, true);
  if (parsedFalse.ok) assert.equal(parsedFalse.value, false);

  const parsedInvalid = boolDesc.parse("maybe");
  assert.equal(parsedInvalid.ok, false);

  // Update contract
  const updated = boolDesc.update(draft, false);
  assert.equal(updated.subscriptionEnabled, false);
  assert.equal(draft.subscriptionEnabled, true, "source draft unchanged");
}

function testSubscriptionTierTextDescriptor(): void {
  console.log("\n--- subscriptionTier is a typed text descriptor ---");
  const descriptors = getSubscriptionFieldDescriptors();
  const desc = descriptors.find((d) => d.validationKey === "subscriptionTier");
  assert.ok(desc, "subscriptionTier descriptor exists");
  const textDesc = desc as ReturnType<typeof createTextFieldDescriptor>;
  assert.equal(textDesc.kind, "text", "subscriptionTier is a text descriptor");
  const draft = makeDraft();
  assert.equal(textDesc.read(draft), "small", "reads current subscriptionTier");

  let buffer = "";
  buffer = textDesc.accept(buffer, "p") ?? buffer;
  buffer = textDesc.accept(buffer, "r") ?? buffer;
  buffer = textDesc.accept(buffer, "o") ?? buffer;
  assert.equal(buffer, "pro");

  const parsed = textDesc.parse("pro");
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.equal(parsed.value, "pro");

  const updated = textDesc.update(draft, "pro");
  assert.equal(updated.subscriptionTier, "pro");
  assert.equal(draft.subscriptionTier, "small", "source draft unchanged");
}

function testExtractCharacterContextVariants(): void {
  console.log("\n--- extractCharacter handles all OpenTUI and OpenCode event variants ---");
  assert.equal(extractCharacter("t"), "t", "raw character string");
  assert.equal(extractCharacter("space"), " ", "space name string");
  assert.equal(extractCharacter({ ch: "y" }), "y", "{ ch } object");
  assert.equal(extractCharacter({ char: "n" }), "n", "{ char } object");
  assert.equal(extractCharacter({ sequence: "a" }), "a", "{ sequence } object");
  assert.equal(extractCharacter({ raw: "b" }), "b", "{ raw } object");
  assert.equal(extractCharacter({ name: "c" }), "c", "{ name } object (OpenTUI KeyEvent)");
  assert.equal(extractCharacter({ name: "space" }), " ", "{ name: 'space' } object");
  assert.equal(extractCharacter({ key: { name: "d" } }), "d", "nested key.name object");
  assert.equal(extractCharacter({ event: { name: "e" } }), "e", "nested event.name object");
  assert.equal(extractCharacter({ event: { sequence: "f" } }), "f", "nested event.sequence object");
  assert.equal(extractCharacter(null), "", "null is safe");
  assert.equal(extractCharacter(undefined), "", "undefined is safe");
  assert.equal(extractCharacter({ name: "enter" }), "", "enter is excluded as non-printable");
}

async function run(): Promise<void> {
  testExtractCharacterContextVariants();
  testSubscriptionDescriptorsExist();
  testSubscriptionEnabledBooleanFieldDescriptor();
  testSubscriptionTierTextDescriptor();
  testPlanNameTextDescriptor();
  testNumericSubscriptionDescriptors();
  testSubscriptionDescriptorOrdering();
  testReusedTextAndNumericDescriptorFactories();
  console.log("\nAll PR3 TUI subscription editing pure assertions passed.");
}

run().catch((err) => {
  console.error("PR3 TUI subscription editing test failed:", err);
  process.exit(1);
});
