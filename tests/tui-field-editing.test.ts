import assert from "node:assert/strict";
import type { DetailDraft } from "../src/tui/model-detail-view.js";
import {
  ACTIVE_FIELD_EDIT_PRIORITY,
  BASE_NAVIGATION_PRIORITY,
  appendFieldEdit,
  backspaceFieldEdit,
  cancelFieldEdit,
  commitFieldEdit,
  createBooleanFieldDescriptor,
  createEnumFieldDescriptor,
  createNumericFieldDescriptor,
  createTextFieldDescriptor,
  getFieldEditBindings,
  getFieldEditCaptureLayer,
  startFieldEdit,
} from "../src/tui/model-detail-field-edit.js";

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

function testTypedDescriptors(): void {
  console.log("--- Typed field descriptor parsing, accepting, and updates ---");
  const draft = makeDraft();

  const text = createTextFieldDescriptor({
    tab: "subscription",
    index: 0,
    path: "planName",
    label: "Plan name",
    validationKey: "planName",
    read: (value) => value.planName,
    update: (value, next) => ({ ...value, planName: next }),
  });
  assert.equal(text.kind, "text");
  assert.equal(text.accept("", "Pro"), "Pro", "text descriptors accept printable input");
  assert.deepEqual(text.parse("Pro"), { ok: true, value: "Pro" });
  assert.equal(text.parse("   ").ok, false, "text descriptors reject blank values");
  const textDraft = text.update(draft, "Pro");
  assert.equal(text.read(textDraft), "Pro", "text descriptor update is typed and immutable");
  assert.notEqual(textDraft, draft, "text descriptor update returns a new draft");

  const enumeration = createEnumFieldDescriptor({
    tab: "subscription",
    index: 1,
    path: "subscriptionTier",
    label: "Subscription tier",
    validationKey: "subscriptionTier",
    options: ["small", "pro", "enterprise"] as const,
    read: (value) => value.subscriptionTier,
    update: (value, next) => ({ ...value, subscriptionTier: next }),
  });
  assert.equal(enumeration.kind, "enum");
  assert.equal(enumeration.accept("", "p"), "p", "enum descriptors accept a valid option prefix");
  assert.equal(enumeration.accept("p", "r"), "pr", "enum descriptors append accepted characters");
  assert.equal(enumeration.accept("pr", "x"), null, "enum descriptors reject an invalid option prefix");
  assert.deepEqual(enumeration.parse("pro"), { ok: true, value: "pro" });
  assert.equal(enumeration.parse("unknown").ok, false, "enum descriptors reject values outside options");
  const enumDraft = enumeration.update(draft, "pro");
  assert.equal(enumeration.read(enumDraft), "pro", "enum descriptor update preserves its option type");

  const boolean = createBooleanFieldDescriptor({
    tab: "overview",
    index: 0,
    path: "isBlocked",
    label: "Blocked",
    validationKey: "isBlocked",
    read: (value) => value.isBlocked,
    update: (value, next) => ({ ...value, isBlocked: next }),
  });
  assert.equal(boolean.kind, "boolean");
  assert.equal(boolean.accept("", "t"), "t", "boolean descriptors accept boolean text");
  assert.deepEqual(boolean.parse("true"), { ok: true, value: true });
  assert.deepEqual(boolean.parse("FALSE"), { ok: true, value: false });
  assert.equal(boolean.parse("maybe").ok, false, "boolean descriptors reject non-boolean text");
  const booleanDraft = boolean.update(draft, true);
  assert.equal(boolean.read(booleanDraft), true, "boolean descriptor update is typed");

  const numeric = createNumericFieldDescriptor({
    tab: "pricing",
    index: 0,
    path: "inputPerMillion",
    label: "Input per 1M tokens",
    validationKey: "inputPerMillion",
    read: (value) => value.inputPerMillion,
    update: (value, next) => ({ ...value, inputPerMillion: next }),
  });
  assert.equal(numeric.kind, "numeric");
  let numericBuffer = numeric.accept("", "1");
  numericBuffer = numeric.accept(numericBuffer ?? "", "2") ?? "";
  numericBuffer = numeric.accept(numericBuffer, ".") ?? "";
  numericBuffer = numeric.accept(numericBuffer, ".") ?? numericBuffer;
  numericBuffer = numeric.accept(numericBuffer, "5") ?? numericBuffer;
  assert.equal(numericBuffer, "12.5", "numeric descriptors preserve single-decimal input behavior");
  assert.deepEqual(numeric.parse(numericBuffer), { ok: true, value: 12.5 });
  assert.equal(numeric.parse("12.").ok, false, "numeric descriptors reject a trailing decimal on commit");
  assert.deepEqual(numeric.parse(".5"), { ok: true, value: 0.5 });
  assert.equal(numeric.parse("-1").ok, false, "numeric descriptors reject negative values");
  const numericDraft = numeric.update(draft, 12.5);
  assert.equal(numeric.read(numericDraft), 12.5, "numeric descriptor update is typed");
}

function testFieldEditSession(): void {
  console.log("--- Field edit session lifecycle ---");
  const draft = makeDraft();
  const descriptor = createNumericFieldDescriptor({
    tab: "pricing",
    index: 0,
    path: "inputPerMillion",
    label: "Input per 1M tokens",
    validationKey: "inputPerMillion",
    read: (value) => value.inputPerMillion,
    update: (value, next) => ({ ...value, inputPerMillion: next }),
  });

  let session = startFieldEdit(descriptor, descriptor.read(draft));
  assert.equal(session.buffer, "", "starting a null edit uses an empty buffer");
  session = appendFieldEdit(session, "1");
  session = appendFieldEdit(session, "2");
  session = appendFieldEdit(session, ".");
  session = appendFieldEdit(session, "5");
  assert.equal(session.buffer, "12.5", "active sessions append accepted input");
  session = backspaceFieldEdit(session);
  assert.equal(session.buffer, "12.", "active sessions support backspace");
  assert.equal(cancelFieldEdit(session), null, "cancel closes the session without a draft mutation");

  const committed = commitFieldEdit(appendFieldEdit(session, "5"));
  assert.deepEqual(committed, { ok: true, value: 12.5 }, "commit parses and returns the typed value");
  const invalid = commitFieldEdit({ ...startFieldEdit(descriptor, null), buffer: "12." });
  assert.equal(invalid.ok, false, "invalid commit returns a validation error");
  const corrected = appendFieldEdit(
    { ...startFieldEdit(descriptor, null), buffer: "12.", error: "Enter a finite non-negative number" },
    "5",
  );
  assert.equal(corrected.error, undefined, "accepted input clears a stale session error");
}

function testCaptureContract(): void {
  console.log("--- Active field capture contract ---");
  const descriptor = createTextFieldDescriptor({
    tab: "subscription",
    index: 0,
    path: "planName",
    label: "Plan name",
    validationKey: "planName",
    read: (value) => value.planName,
    update: (value, next) => ({ ...value, planName: next }),
  });

  assert.equal(BASE_NAVIGATION_PRIORITY, 200, "base navigation priority remains 200");
  assert.deepEqual(getFieldEditBindings(null), [], "inactive mode exposes no capture bindings");
  assert.equal(getFieldEditCaptureLayer(null), null, "inactive mode has no capture layer");

  const session = startFieldEdit(descriptor, null);
  const layer = getFieldEditCaptureLayer(session);
  assert.equal(layer?.priority, ACTIVE_FIELD_EDIT_PRIORITY, "active editing uses a higher-priority capture layer");
  assert.ok(layer?.bindings.some((binding) => binding.key === "backspace"));
  assert.ok(layer?.bindings.some((binding) => binding.key === "enter"));
  assert.ok(layer?.bindings.some((binding) => binding.key === "esc"));
  assert.equal(
    getFieldEditBindings(session).length,
    layer?.bindings.length,
    "capture bindings are exposed only from an active session",
  );
}

function main(): void {
  testTypedDescriptors();
  testFieldEditSession();
  testCaptureContract();
  console.log("TUI field editing assertions passed.");
}

main();
