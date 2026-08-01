import assert from "node:assert/strict";
import {
  buildCanonicalRoutedAgentDefinition,
  renderCanonicalRoutedAgentMarkdown,
  compareResolvedAgentDefinition,
  type CanonicalRoutedAgentDefinition
} from "../src/infrastructure/opencode/routed-agent-definition.js";

const route = {
  hostName: "sdd-mr-v1-test",
  providerId: "provider",
  modelId: "model",
  baseTemplate: "base"
};

const canonical = buildCanonicalRoutedAgentDefinition(route);
assert.equal(canonical.mode, "subagent");
assert.equal(canonical.hidden, true);
assert.equal(canonical.model, "provider/model");

const markdown = renderCanonicalRoutedAgentMarkdown(route);
assert.ok(markdown.includes("mode: subagent"));
assert.ok(markdown.includes("hidden: true"));

const diffs = compareResolvedAgentDefinition({
  mode: "subagent",
  hidden: true,
  model: "provider/model",
  description: canonical.description
}, canonical);

assert.equal(diffs.length, 0);

console.log("OK routed-agent-definition");
