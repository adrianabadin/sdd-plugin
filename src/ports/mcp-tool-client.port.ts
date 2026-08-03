/**
 * Structured MCP tool invocation (design §2, §8.2 row 5 — "we never parse
 * `pmc` CLI text output; every read/write goes through `agent-memory-mcp`'s
 * MCP tools directly, structured JSON in/out"). Any adapter that talks to
 * PMC does so exclusively through this port; there is no code path in
 * `sdd-plugin2` that shells out to the `pmc` CLI and scrapes its stdout.
 */

export interface McpToolClientPort {
  callTool<TResult = unknown>(toolName: string, args: Readonly<Record<string, unknown>>): Promise<TResult>;
}
