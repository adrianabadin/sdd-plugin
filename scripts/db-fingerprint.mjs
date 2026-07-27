/**
 * Read-only fingerprint helper for guarding the real project database.
 *
 * Prints a stable SHA-256 + size + mtime line for a database file without
 * acquiring an exclusive lock, so it can run while the plugin holds the file
 * open. Used before/after test runs to prove the real database was untouched.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const target = path.resolve(process.argv[2] ?? "opencode-models.db");
const label = process.argv[3] ?? "FINGERPRINT";

if (!fs.existsSync(target)) {
  process.stdout.write(`${label}_STATE=ABSENT path=${target}\n`);
  process.exit(0);
}

const stat = fs.statSync(target);
const hash = createHash("sha256");
const fd = fs.openSync(target, "r");
try {
  const buffer = Buffer.alloc(1024 * 1024);
  let position = 0;
  for (;;) {
    const bytes = fs.readSync(fd, buffer, 0, buffer.length, position);
    if (bytes <= 0) break;
    hash.update(buffer.subarray(0, bytes));
    position += bytes;
  }
} finally {
  fs.closeSync(fd);
}

process.stdout.write(
  `${label}_HASH=${hash.digest("hex")} ${label}_SIZE=${stat.size} ${label}_MTIME=${stat.mtimeMs}\n`,
);
