import assert from "node:assert/strict";
import {
  ForeignAgentDefinitionError,
  ForeignAgentInspectionError,
  RoutedAgentDefinitionMismatchError,
  ResolvedAgentConfigUnavailableError
} from "../src/infrastructure/opencode/foreign-agent-errors.js";

const err1 = new ForeignAgentDefinitionError("FOREIGN_AGENT_DEFINITION", [{ kind: "foreign-reserved-definition", sourceLabel: "test", reason: "test" }]);
assert.equal(err1.name, "ForeignAgentDefinitionError");
assert.equal(err1.code, "FOREIGN_AGENT_DEFINITION");

const err2 = new ForeignAgentInspectionError("FOREIGN_AGENT_INSPECTION", []);
assert.equal(err2.name, "ForeignAgentInspectionError");

const err3 = new RoutedAgentDefinitionMismatchError("ROUTED_AGENT_DEFINITION_MISMATCH", ["model"]);
assert.equal(err3.name, "RoutedAgentDefinitionMismatchError");

const err4 = new ResolvedAgentConfigUnavailableError("RESOLVED_AGENT_CONFIG_UNAVAILABLE");
assert.equal(err4.name, "ResolvedAgentConfigUnavailableError");

console.log("OK foreign-agent-errors");
