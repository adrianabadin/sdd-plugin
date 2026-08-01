import assert from "node:assert/strict";
import path from "node:path";
import { resolveForeignAgentSources, AbsolutePath } from "../src/infrastructure/opencode/foreign-agent-sources.js";

const workspaceRoot = path.resolve("/test/workspace") as AbsolutePath;

const sources = resolveForeignAgentSources({
  workspaceRoot,
  cwd: path.resolve("/test/cwd"),
  env: {
    OPENCODE_CONFIG: path.resolve("/test/env/opencode.json"),
    OPENCODE_CONFIG_DIR: path.resolve("/test/env-dir"),
    OPENCODE_CONFIG_CONTENT: "inline-config-content",
    SDD_MODEL_ROUTING_EXTRA_WATCHED_CONFIG_ROOTS: path.resolve("/test/extra1") + path.delimiter + path.resolve("/test/extra2"),
  },
  homeDir: path.resolve("/test/home"),
  platform: "win32",
  managedConfigFiles: [path.resolve("/test/managed/opencode.json")]
});

assert.ok(sources.length > 0);
console.log("OK foreign-agent-sources");
