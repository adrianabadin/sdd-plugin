/**
 * WU1 — SS-8, SS-9, SS-10: PMC-only structured access and read-back
 * durability checks (RED-first). See
 * docs/superpowers/specs/2026-08-02-sdd-phase-agents-SPEC.md capability
 * `sdd-status-store`.
 *
 * SS-9/SS-10 are exercised against an injected in-memory fake store
 * (design's own framing: read-back is a durability check we own, testable
 * without a real PMC backend). SS-8 is exercised against the
 * `PmcSddArtifactStoreAdapter`, asserting it only ever calls the structured
 * `McpToolClientPort` — never `node:child_process`, never `pmc` CLI text.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import type { CheckpointRecord, CheckpointWriteResult, SddArtifactStorePort } from "../src/ports/sdd-artifact-store.port.js";
import type { McpToolClientPort } from "../src/ports/mcp-tool-client.port.js";
import { saveArtifact } from "../src/application/sdd/save-artifact.js";
import { saveCheckpoint, CheckpointConcurrencyError } from "../src/application/sdd/checkpoint.js";
import { PmcSddArtifactStoreAdapter } from "../src/infrastructure/pmc/pmc-sdd-artifact-store.adapter.js";

/** In-memory fake — SS-9/SS-10 target the read-back behavior, not a real PMC round-trip. */
class FakeStore implements SddArtifactStorePort {
  private artifacts = new Map<string, string>();
  private checkpoints = new Map<string, { content: unknown; version: number }>();
  private nextVersion = 1;
  /** When true, simulates a write that silently did not land. */
  public dropNextArtifactWrite = false;
  public dropNextCheckpointWrite = false;

  async writeArtifact(key: string, content: string): Promise<void> {
    if (this.dropNextArtifactWrite) {
      this.dropNextArtifactWrite = false;
      return; // simulate a lost write — nothing stored
    }
    this.artifacts.set(key, content);
  }
  async readArtifact(key: string): Promise<string | null> {
    return this.artifacts.get(key) ?? null;
  }
  async writeCheckpoint(key: string, content: unknown, expectedVersion?: number): Promise<CheckpointWriteResult> {
    if (this.dropNextCheckpointWrite) {
      this.dropNextCheckpointWrite = false;
      return { version: this.nextVersion };
    }
    const current = this.checkpoints.get(key);
    if (expectedVersion !== undefined && current && current.version !== expectedVersion) {
      throw new CheckpointConcurrencyError(
        `Checkpoint '${key}' version mismatch (expected ${expectedVersion}, found ${current.version}).`,
      );
    }
    const version = this.nextVersion++;
    this.checkpoints.set(key, { content: JSON.parse(JSON.stringify(content)), version });
    return { version };
  }
  async readCheckpoint(key: string): Promise<CheckpointRecord | null> {
    const val = this.checkpoints.get(key);
    return val ? { content: JSON.parse(JSON.stringify(val.content)), version: val.version } : null;
  }
  /** Final-review finding #3 — stub for the atomic persist seam. The
   *  tests that use this fake exercise SS-9 / SS-10, NOT atomic
   *  persistence; throwing here makes a misuse loud rather than silent. */
  async persistArtifactWithOwnership(): Promise<never> {
    throw new Error("FakeStore.persistArtifactWithOwnership is not exercised by these tests");
  }
}

class FakeMcpToolClient implements McpToolClientPort {
  public readonly calls: Array<{ toolName: string; args: Readonly<Record<string, unknown>> }> = [];
  private stored = new Map<string, { content: unknown; version: number }>();
  private nextVersion = 1;

  async callTool<TResult = unknown>(toolName: string, args: Readonly<Record<string, unknown>>): Promise<TResult> {
    this.calls.push({ toolName, args });
    if (toolName === "pmc-agent-memory_store") {
      const key = args.key as string;
      if (args.kind === "checkpoint") {
        const existing = this.stored.get(key);
        if (args.expectedVersion !== undefined && existing && existing.version !== args.expectedVersion) {
          return { conflict: true, version: existing.version } as TResult;
        }
        const version = this.nextVersion++;
        this.stored.set(key, { content: args.content, version });
        return { version } as TResult;
      }
      this.stored.set(key, { content: args.content, version: this.nextVersion++ });
      return { version: this.nextVersion } as TResult;
    }
    if (toolName === "pmc-agent-memory_recall") {
      const entry = this.stored.get(args.key as string);
      if (args.kind === "checkpoint") {
        return { content: entry?.content ?? null, version: entry?.version ?? 0 } as TResult;
      }
      return { content: entry?.content ?? null } as TResult;
    }
    throw new Error(`unexpected tool: ${toolName}`);
  }
}

async function runTests(): Promise<void> {
  console.log("--- sdd-artifact-store (RED-first) ---");

  // SS-9: sdd_save_artifact reports failure when read-back doesn't match.
  {
    const store = new FakeStore();
    const okResult = await saveArtifact(store, "sdd/abc/change-x/explore", "hello world");
    assert.equal(okResult.ok, true, "a normal write reports ok:true");

    store.dropNextArtifactWrite = true;
    const failResult = await saveArtifact(store, "sdd/abc/change-x/explore", "second content");
    assert.equal(failResult.ok, false, "a write that did not land reports ok:false");
  }
  console.log("  pass: SS-9 sdd_save_artifact reports failure on read-back mismatch");

  // SS-10: sdd_checkpoint reports failure when read-back doesn't reflect the completion.
  {
    const store = new FakeStore();
    const completion = { batchId: "b1", completedIds: ["s1"] };
    const okResult = await saveCheckpoint(store, "sdd/abc/change-x/checkpoints/apply", completion);
    assert.equal(okResult.ok, true, "a normal checkpoint write reports ok:true");

    store.dropNextCheckpointWrite = true;
    const failResult = await saveCheckpoint(store, "sdd/abc/change-x/checkpoints/apply", { batchId: "b2", completedIds: ["s1", "s2"] });
    assert.equal(failResult.ok, false, "a checkpoint write that did not land reports ok:false");
  }
  console.log("  pass: SS-10 sdd_checkpoint reports failure on read-back mismatch");

  // SS-8: no pmc CLI stdout is parsed; all access via agent-memory-mcp MCP tools with structured JSON.
  {
    const client = new FakeMcpToolClient();
    const adapter = new PmcSddArtifactStoreAdapter(client);

    await adapter.writeArtifact("sdd/abc/change-x/explore", "explore content");
    const readBack = await adapter.readArtifact("sdd/abc/change-x/explore");
    assert.equal(readBack, "explore content", "adapter round-trips structured content via the MCP tool client");

    for (const call of client.calls) {
      assert.match(call.toolName, /^pmc-agent-memory_/, "every store access is a named MCP tool call");
      assert.equal(typeof call.args, "object", "arguments are structured, not a raw CLI string");
    }

    const adapterSource = readFileSync(
      new URL("../src/infrastructure/pmc/pmc-sdd-artifact-store.adapter.ts", import.meta.url),
      "utf8",
    );
    assert.doesNotMatch(
      adapterSource,
      /^\s*import[^\n]*child_process/m,
      "adapter never imports node:child_process",
    );
    assert.doesNotMatch(
      adapterSource,
      /\b(execFileSync|execSync|spawnSync|spawn|exec)\s*\(/,
      "adapter never shells out (no exec/spawn call)",
    );
  }
  console.log("  pass: SS-8 store access goes through agent-memory-mcp MCP tools only, never pmc CLI text");

  console.log("All sdd-artifact-store tests passed.");
}

runTests().catch((err) => { console.error("Test failed:", err); process.exit(1); });
