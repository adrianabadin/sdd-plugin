/**
 * Synchronous durable JSONL audit logger for deterministic model routing.
 *
 * Behavior contract:
 *  - One JSON object per line, terminated with a newline.
 *  - Every `append` is followed by an `fsync` so the line survives an
 *    immediate power loss. The hook treats any sync failure as fail-closed.
 *  - File is created with mode 0600 (owner read/write only). On Windows
 *    chmod is best-effort because the platform does not enforce POSIX bits.
 *  - Sensitive keys (`token`, `apiKey`, `apikey`, `authorization`,
 *    `password`, `secret`, `cookie`, `session`, `credential`) are stripped
 *    at every depth. Nested plain objects are walked recursively.
 *  - Field values are bounded by a maximum byte length; over-long values
 *    are truncated with a single-character ellipsis suffix.
 *  - Any synchronous failure (open, write, fsync, close) throws
 *    `ModelRouteAuditLoggerError` with `code === "AUDIT_WRITE_FAILED"` so
 *    the hook can recognize the bounded failure mode.
 *
 * Design: 0695919c-2264-4e0d-a3fb-f7d4190661fc.
 */

import { closeSync, fsyncSync, mkdirSync, openSync, writeSync, chmodSync } from "node:fs";
import path from "node:path";

/**
 * Audit stages for the deterministic model-routing hook.
 *
 * The explicit `model-route:v1|...` grammar uses `routing.launch` /
 * `routing.blocked`; the WU2 natural-intent prompt path uses
 * `routing.natural.launch` / `routing.natural.blocked` so audit consumers
 * can distinguish caller-declared routes from natural-language requests.
 */
export type ModelRouteAuditStage =
  | "routing.launch"
  | "routing.blocked"
  | "routing.natural.launch"
  | "routing.natural.blocked";
export type ModelRouteAuditStatus = "success" | "error";

export interface ModelRouteAuditEntry {
  readonly stage: ModelRouteAuditStage;
  readonly status: ModelRouteAuditStatus;
  readonly correlationId: string;
  readonly requestedAlias: string;
  readonly resolutionTier: "exact" | "alias" | "normalized";
  readonly resolvedProviderId: string;
  readonly resolvedModelId: string;
  readonly routedAgent: string;
  readonly quarantineChecked: boolean;
  readonly durationMs: number;
  readonly errorClass?: string;
  /**
   * WU2-only. The natural-intent trigger label (e.g. `usando`,
   * `con el modelo`) for natural routing audit entries. Undefined for the
   * explicit-grammar path.
   */
  readonly trigger?: string;
  /**
   * WU2-only. The raw reference string extracted from the user prompt for
   * natural routing audit entries. The user prompt itself is never
   * recorded in audit. Undefined for the explicit-grammar path.
   */
  readonly requestedNaturalReference?: string;
  readonly ts?: number;
  readonly [key: string]: unknown;
}

export interface ModelRouteAuditLoggerOptions {
  readonly path: string;
  readonly maxFieldBytes?: number;
  readonly maxDepth?: number;
}

const DEFAULT_MAX_FIELD_BYTES = 4096;
const DEFAULT_MAX_DEPTH = 4;
const FILE_MODE = 0o600;

const SENSITIVE_KEYS = new Set<string>([
  "token", "apikey", "apikey", "authorization", "password", "secret", "cookie",
  "session", "credential", "credentials", "privatekey", "privatekey",
  "refreshtoken", "accesstoken",
  // WU4: defense-in-depth — the audit logger must NEVER carry the
  // raw user prompt, even if a caller mistakenly passes one. The
  // hook contract is that the prompt is data and is never recorded
  // (the parser extracts only the trigger + raw reference), but the
  // sink is the last line of defense for downstream consumers.
  "prompt", "rawprompt", "userprompt", "systemprompt",
  // WU4 remediation (C2 fix, RED-first): the boot manager's
  // SDD_MODEL_ROUTING_BOOT_ID / SDD_MODEL_ROUTING_SIGNING_KEY env
  // vars carry the live boot identity and HMAC key. A caller that
  // mistakenly forwards these into an audit entry must NOT leak the
  // value. `isSensitive()` already lowercases and strips non-alnum,
  // so `bootIdentity` -> `bootidentity`, `bootId` -> `bootid`,
  // `signingKey` -> `signingkey`, `hmacKey` -> `hmackey`.
  "bootidentity", "bootid", "signingkey", "hmackey",
]);

export class ModelRouteAuditLoggerError extends Error {
  readonly code = "AUDIT_WRITE_FAILED";
  constructor(message: string, readonly cause?: unknown) { super(message); this.name = "ModelRouteAuditLoggerError"; }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isSensitive(rawKey: string): boolean {
  return SENSITIVE_KEYS.has(rawKey.toLowerCase().replace(/[^a-z0-9]/g, ""));
}

function boundString(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  const safe = Math.max(1, maxBytes - 1);
  let truncated = value;
  while (Buffer.byteLength(truncated, "utf8") > safe) truncated = truncated.slice(0, -1);
  return `${truncated}…`;
}

function sanitizeValue(value: unknown, maxBytes: number, depth: number, maxDepth: number): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return boundString(value, maxBytes);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) {
    return depth >= maxDepth ? "[array]" : value.map((item) => sanitizeValue(item, maxBytes, depth + 1, maxDepth));
  }
  if (isPlainObject(value)) {
    if (depth >= maxDepth) return "[object]";
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (!isSensitive(k)) out[k] = sanitizeValue(v, maxBytes, depth + 1, maxDepth);
    }
    return out;
  }
  return String(value);
}

function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  return value;
}

export class ModelRouteAuditLogger {
  private readonly filePath: string;
  private readonly maxFieldBytes: number;
  private readonly maxDepth: number;
  private fd: number | null = null;
  private closed = false;

  constructor(options: ModelRouteAuditLoggerOptions) {
    this.filePath = path.resolve(options.path);
    this.maxFieldBytes = options.maxFieldBytes ?? DEFAULT_MAX_FIELD_BYTES;
    this.maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  }

  private ensureOpen(): number {
    if (this.fd !== null) return this.fd;
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    try {
      this.fd = openSync(this.filePath, "a", FILE_MODE);
    } catch (error) {
      throw new ModelRouteAuditLoggerError(`audit open failed: ${(error as Error).message}`, error);
    }
    try { chmodSync(this.filePath, FILE_MODE); } catch { /* Windows: chmod is best-effort. */ }
    return this.fd;
  }

  async append(entry: ModelRouteAuditEntry): Promise<void> {
    if (this.closed) throw new ModelRouteAuditLoggerError("audit logger is closed");
    const sanitized = sanitizeValue(entry, this.maxFieldBytes, 0, this.maxDepth) as Record<string, unknown>;
    sanitized["ts"] = Date.now();
    let payload: string;
    try {
      payload = `${JSON.stringify(sanitized, jsonReplacer)}\n`;
    } catch (error) {
      throw new ModelRouteAuditLoggerError(`audit serialization failed: ${(error as Error).message}`, error);
    }
    const fd = this.ensureOpen();
    try {
      writeSync(fd, payload);
      fsyncSync(fd);
    } catch (error) {
      this.closed = true;
      try { if (this.fd !== null) closeSync(this.fd); } catch { /* ignore */ }
      this.fd = null;
      throw new ModelRouteAuditLoggerError(`audit write/fsync failed: ${(error as Error).message}`, error);
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.fd !== null) {
      try {
        try { fsyncSync(this.fd); } catch { /* ignore */ }
      } finally {
        try { closeSync(this.fd); } catch { /* ignore */ }
        this.fd = null;
      }
    }
  }
}
