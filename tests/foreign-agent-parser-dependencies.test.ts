import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { parse as parseJsonc } from "jsonc-parser";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
assert.equal(typeof pkg.dependencies?.yaml, "string");
assert.equal(typeof pkg.dependencies?.["jsonc-parser"], "string");
assert.deepEqual(parseYaml("name: sdd-mr-v1-test\n"), { name: "sdd-mr-v1-test" });
assert.deepEqual(parseJsonc('{ // comment\n "agent": {},\n}'), { agent: {} });
console.log("OK foreign-agent-parser-dependencies");
