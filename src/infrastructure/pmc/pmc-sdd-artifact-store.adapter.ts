/**
 * `agent-memory-mcp`-backed implementation of `SddArtifactStorePort` (SS-8).
 *
 * This adapter talks exclusively to the injected `McpToolClientPort` — it
 * never imports `node:child_process`, never shells out to the `pmc` CLI,
 * and never parses stdout text. All values in/out are structured JSON, per
 * design §8.2 row 5.
 *
 * Checkpoint versioning (design §9.12, CP-16/CP-17): the store/recall tool
 * contract carries a `version` field. `writeCheckpoint` passes
 * `expectedVersion` through; a mismatch surfaces as
 * `CheckpointConcurrencyError` so the durable write loop re-reads and
 * recomputes instead of clobbering a concurrent writer.
 */

import { CheckpointConcurrencyError } from "../../application/sdd/checkpoint.js";
import type { McpToolClientPort } from "../../ports/mcp-tool-client.port.js";
import type {
  CheckpointRecord,
  CheckpointWriteResult,
  SddArtifactStorePort,
} from "../../ports/sdd-artifact-store.port.js";

const STORE_TOOL = "pmc-agent-memory_store";
const RECALL_TOOL = "pmc-agent-memory_recall";

interface ArtifactRecallResult {
  readonly content: string | null;
}

interface CheckpointRecallResult {
  readonly content: unknown | null;
  readonly version: number;
}

interface CheckpointStoreResult {
  readonly version: number;
  /** Present when the store rejected the write due to a version mismatch. */
  readonly conflict?: boolean;
}

export class PmcSddArtifactStoreAdapter implements SddArtifactStorePort {
  constructor(private readonly mcp: McpToolClientPort) {}

  async writeArtifact(key: string, content: string): Promise<void> {
    await this.mcp.callTool(STORE_TOOL, { key, content, kind: "artifact" });
  }

  async readArtifact(key: string): Promise<string | null> {
    const result = await this.mcp.callTool<ArtifactRecallResult>(RECALL_TOOL, { key, kind: "artifact" });
    return result.content;
  }

  async writeCheckpoint(key: string, content: unknown, expectedVersion?: number): Promise<CheckpointWriteResult> {
    const result = await this.mcp.callTool<CheckpointStoreResult>(STORE_TOOL, {
      key,
      content,
      kind: "checkpoint",
      ...(expectedVersion !== undefined ? { expectedVersion } : {}),
    });
    if (result.conflict) {
      throw new CheckpointConcurrencyError(
        `Checkpoint '${key}' version mismatch: a concurrent writer landed first.`,
      );
    }
    return { version: result.version };
  }

  async readCheckpoint(key: string): Promise<CheckpointRecord | null> {
    const result = await this.mcp.callTool<CheckpointRecallResult>(RECALL_TOOL, { key, kind: "checkpoint" });
    if (result.content === null) return null;
    return { content: result.content, version: result.version };
  }
}
