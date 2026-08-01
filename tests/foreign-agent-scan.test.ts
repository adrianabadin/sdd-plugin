import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { scanForForeignAgentDefinitions } from "../src/infrastructure/opencode/foreign-agent-scan.js";
import { resolveForeignAgentSources, type AbsolutePath } from "../src/infrastructure/opencode/foreign-agent-sources.js";

const workspaceRoot = path.resolve(process.cwd(), "temp-test-workspace") as AbsolutePath;

fs.mkdirSync(path.join(workspaceRoot, ".opencode", "agents"), { recursive: true });
fs.writeFileSync(path.join(workspaceRoot, ".opencode", "agents", "sdd-mr-v1-test.md"), "---\nname: sdd-mr-v1-test\n---\nbody");

const sources = resolveForeignAgentSources({ workspaceRoot });
const findings = scanForForeignAgentDefinitions({
  workspaceRoot,
  sources,
  ownedAgentFiles: [],
  reservedPrefix: "sdd-mr-v1-"
});

assert.ok(findings.length > 0);
console.log("OK foreign-agent-scan");
