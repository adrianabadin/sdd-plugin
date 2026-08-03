/**
 * Tests for the SQLite-direct McpToolClientPort adapter (Option B bridge).
 * Uses a temp SQLite file so it never touches the real agent-memory-mcp DB.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { SqliteMcpToolClient } from "../src/infrastructure/pmc/sqlite-mcp-tool-client.adapter.js";

async function runTests(): Promise<void> {
  console.log("--- sqlite-mcp-tool-client (Option B bridge) ---");

  const tempDir = mkdtempSync(path.join(tmpdir(), "sdd-sqlite-bridge-"));
  const dbPath = path.join(tempDir, "test-memory.db");

  try {
    // Round-trip: store then recall returns the same content and an incremented version.
    {
      const client = new SqliteMcpToolClient({ dbPath });
      const storeRes = await client.callTool<{ version: number }>("pmc-agent-memory_store", {
        key: "sdd/abc/explore",
        content: "explore content",
        kind: "artifact",
      });
      assert.equal(typeof storeRes.version, "number", "store returns a version number");
      assert.ok((storeRes.version as number) >= 1, "first store version is >= 1");

      const recall = await client.callTool<{ content: unknown; version: number }>("pmc-agent-memory_recall", {
        key: "sdd/abc/explore",
        kind: "artifact",
      });
      assert.equal(recall.content, "explore content", "recall returns the stored artifact content");
      assert.equal(recall.version, storeRes.version, "recall version matches the store version");
      client.close();
    }
    console.log("  pass: store→recall round-trips artifact content with a version");

    // Checkpoint content (JSON object) round-trips as parsed JSON.
    {
      const client = new SqliteMcpToolClient({ dbPath });
      const payload = { checkpoints: { apply: { completedIds: ["s1"], attemptCounts: {}, currentBatch: null } } };
      await client.callTool("pmc-agent-memory_store", { key: "sdd/x/y/checkpoints", content: payload, kind: "checkpoint" });
      const recall = await client.callTool<{ content: unknown }>("pmc-agent-memory_recall", {
        key: "sdd/x/y/checkpoints",
        kind: "checkpoint",
      });
      assert.deepEqual(recall.content, payload, "checkpoint content round-trips as parsed JSON");
      client.close();
    }
    console.log("  pass: checkpoint JSON content round-trips parsed");

    // Recall of a non-existent key returns { content: null, version: 0 }.
    {
      const client = new SqliteMcpToolClient({ dbPath });
      const recall = await client.callTool<{ content: unknown; version: number }>("pmc-agent-memory_recall", {
        key: "sdd/does-not-exist",
      });
      assert.equal(recall.content, null, "non-existent key recalls null content");
      assert.equal(recall.version, 0, "non-existent key reports version 0");
      client.close();
    }
    console.log("  pass: recall of a missing key returns null content and version 0");

    // OCC: a write with a stale expectedVersion reports a conflict, not a silent overwrite.
    {
      const client = new SqliteMcpToolClient({ dbPath });
      const first = await client.callTool<{ version: number }>("pmc-agent-memory_store", {
        key: "sdd/occ/test",
        content: "v1",
        kind: "artifact",
      });
      // A concurrent writer bumps the version.
      await client.callTool("pmc-agent-memory_store", { key: "sdd/occ/test", content: "v2-rival", kind: "artifact" });

      // Now write with the STALE version from `first` — must conflict.
      const conflictRes = await client.callTool<{ version: number; conflict?: boolean }>("pmc-agent-memory_store", {
        key: "sdd/occ/test",
        content: "v3-mine",
        kind: "artifact",
        expectedVersion: first.version,
      });
      assert.equal(conflictRes.conflict, true, "a stale expectedVersion reports a conflict");
      assert.equal(conflictRes.version, first.version + 1, "conflict reports the actual current version");

      // The conflicting write did NOT land — content is still the rival's.
      const recall = await client.callTool<{ content: unknown }>("pmc-agent-memory_recall", { key: "sdd/occ/test" });
      assert.equal(recall.content, "v2-rival", "the conflicting write did not overwrite the rival");
      client.close();
    }
    console.log("  pass: OCC conflict detected and reported, no silent overwrite");

    // A write with the CORRECT expectedVersion succeeds and bumps the version.
    {
      const client = new SqliteMcpToolClient({ dbPath });
      const first = await client.callTool<{ version: number }>("pmc-agent-memory_store", {
        key: "sdd/occ/ok",
        content: "a",
        kind: "artifact",
      });
      const second = await client.callTool<{ version: number; conflict?: boolean }>("pmc-agent-memory_store", {
        key: "sdd/occ/ok",
        content: "b",
        kind: "artifact",
        expectedVersion: first.version,
      });
      assert.equal(second.conflict, undefined, "a correct expectedVersion does not conflict");
      assert.equal(second.version, first.version + 1, "version increments on a successful conditional write");
      client.close();
    }
    console.log("  pass: a correct expectedVersion succeeds and increments the version");

    // An unsupported tool name throws.
    {
      const client = new SqliteMcpToolClient({ dbPath });
      await assert.rejects(
        () => client.callTool("some-other-tool", { key: "x" }),
        /unsupported tool/,
        "unsupported tool names throw",
      );
      client.close();
    }
    console.log("  pass: unsupported tool names throw");

    console.log("All sqlite-mcp-tool-client tests passed.");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

runTests().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
