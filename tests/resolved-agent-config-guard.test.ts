import assert from "node:assert/strict";
import { ResolvedAgentConfigGuard } from "../src/infrastructure/opencode/resolved-agent-config-guard.js";
import { ResolvedAgentConfigUnavailableError, RoutedAgentDefinitionMismatchError } from "../src/infrastructure/opencode/foreign-agent-errors.js";

const guard = new ResolvedAgentConfigGuard();

// 1. Before observation
assert.throws(() => guard.assertMatches({ routes: [] } as any), ResolvedAgentConfigUnavailableError);

// 2 & 3. Full / observed-field pass, differently-cased key
let agentCfg: any = {};
guard.observe(() => agentCfg);

const manifest = { routes: [{ hostName: "sdd-mr-v1-test", providerId: "p", modelId: "m", baseTemplateName: "b" }] };

// Absent reserved keys pass in observed-field branch
assert.doesNotThrow(() => guard.assertMatches(manifest as any));

agentCfg = { "sdd-mr-v1-test": { description: "Deterministic routed host for p/m (host).", mode: "subagent", hidden: true, model: "p/m" } };
assert.doesNotThrow(() => guard.assertMatches(manifest as any));

// Differently cased key
agentCfg = { "SDD-MR-V1-TEST": { description: "Deterministic routed host for p/m (host).", mode: "subagent", hidden: true, model: "p/m" } };
assert.throws(() => guard.assertMatches(manifest as any), RoutedAgentDefinitionMismatchError);

// 4. Value changed
agentCfg = { "sdd-mr-v1-test": { description: "Deterministic routed host for p/m (host).", mode: "subagent", hidden: false, model: "p/m" } };
assert.throws(() => guard.assertMatches(manifest as any), RoutedAgentDefinitionMismatchError);

// 6. Rereads the live cfg
guard.observe(() => agentCfg);
agentCfg = { "sdd-mr-v1-test": { description: "Deterministic routed host for p/m (host).", mode: "subagent", hidden: true, model: "p/m" } };
assert.doesNotThrow(() => guard.assertMatches(manifest as any));

// 8. observe(undefined)
guard.observe(() => undefined);
assert.throws(() => guard.assertMatches(manifest as any), ResolvedAgentConfigUnavailableError);

// 9. recordObservationFailure
guard.observe(() => agentCfg);
const err = guard.recordObservationFailure(new Error("foo"));
assert.equal(err.message, "foo");
assert.throws(() => guard.assertMatches(manifest as any), RoutedAgentDefinitionMismatchError);

// 10. recordAuditFailure
guard.recordAuditFailure(new Error("audit fail"));
assert.throws(() => guard.assertMatches(manifest as any), RoutedAgentDefinitionMismatchError);

console.log("OK resolved-agent-config-guard");
