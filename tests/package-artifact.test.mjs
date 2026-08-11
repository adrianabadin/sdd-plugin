import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const npmCommand = process.platform === "win32" ? process.env.ComSpec ?? "cmd.exe" : "npm";
const npmArgs = process.platform === "win32"
  ? ["/d", "/s", "/c", "npm pack --dry-run --json"]
  : ["pack", "--dry-run", "--json"];
const packageManifest = JSON.parse(
  execFileSync(npmCommand, npmArgs, {
    cwd: projectRoot,
    encoding: "utf8",
  }),
)[0];
const files = new Set(packageManifest.files.map(({ path: filePath }) => filePath));

assert.ok(
  existsSync(path.join(projectRoot, "dist", "generated", "prisma", "client.js")),
  "the build must emit the self-contained generated Prisma client",
);
assert.ok(
  files.has("dist/generated/prisma/client.js"),
  "npm pack must include the generated Prisma client",
);
assert.ok(
  files.has("dist/generated/prisma/internal/class.js"),
  "npm pack must include the generated Prisma runtime",
);
assert.ok(
  files.has("dist/generated/prisma/package.json"),
  "npm pack must include the generated Prisma module metadata",
);

assert.ok(
  files.has("dist/plugin.js"),
  "npm pack must include the plugin entry point",
);

execFileSync(process.execPath, [
  "--input-type=module",
  "-e",
  "await import('./dist/plugin.js')",
], {
  cwd: projectRoot,
  stdio: "inherit",
});

console.log("Package artifact test passed.");
