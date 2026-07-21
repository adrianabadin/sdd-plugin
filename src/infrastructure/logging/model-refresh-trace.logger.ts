import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

/**
 * A single per-step trace event emitted during the model refresh
 * pipeline. The trace logger is intentionally minimal so adapters and
 * the bootstrap can fire trace points without deciding the JSON shape.
 *
 * Required fields are the ones runtime debugging needs to find a
 * specific step in the log:
 *   - `timestamp` — ISO 8601 UTC string.
 *   - `correlationId` — stable identifier linking every event for one
 *      refresh cycle.
 *   - `stage` — dotted stage name (e.g. `discovery.start`,
 *      `app.providers.response`).
 *   - `status` — one of `start`, `success`, `failure`, `request`,
 *      `response`. The status is recorded as a string so the log
 *      reader can group by status without parsing a flag.
 *
 * Optional fields:
 *   - `durationMs` — wall-clock duration of the stage when measured.
 *   - `details` — bounded, redacted, structured summary.
 *   - `message` — short human-readable note when something failed.
 *   - `error` — bounded, redacted error summary (with stack trace
 *      truncated to a safe length).
 */
export interface TraceEvent {
  correlationId: string;
  stage: string;
  status: "start" | "success" | "failure" | "request" | "response";
  details?: unknown;
  durationMs?: number;
  message?: string;
  error?: unknown;
}

/**
 * Sink contract for the trace logger. The default implementation
 * appends JSONL lines to a file; tests can pass an in-memory sink so
 * they do not depend on the user home directory.
 */
export interface TraceSink {
  write(line: string): Promise<void> | void;
}

export interface FileTraceSinkOptions {
  filePath: string;
}

const MAX_TRACE_LINE_BYTES = 16 * 1024;
const MAX_STRING_CHARS = 512;
const MAX_MESSAGE_CHARS = 512;
const MAX_ERROR_STACK_CHARS = 2 * 1024;
const MAX_DEPTH = 6;
const MAX_ARRAY_ITEMS = 20;
const MAX_OBJECT_ITEMS = 40;
const MAX_TOTAL_ITEMS = 160;
const REDACTED = "[REDACTED]";
const DEPTH_CAP = "[depth-cap]";
const ITEM_CAP = "[item-cap]";
const UNAVAILABLE = "[unavailable]";

/**
 * Default trace file path: `~/.cache/sdd-plugin/model-refresh.log`.
 * Overridable via the `SDD_PLUGIN_TRACE_PATH` environment variable so
 * production runs can redirect to a project-local log and tests can
 * redirect to a temp directory without touching `homedir()`.
 */
export function defaultTracePath(): string {
  const override = process.env.SDD_PLUGIN_TRACE_PATH;
  if (typeof override === "string" && override.length > 0) return override;
  return path.join(homedir(), ".cache", "sdd-plugin", "model-refresh.log");
}

const REDACTED_KEY_PATTERNS: readonly RegExp[] = [
  /authorization/i,
  /api[_-]?key/i,
  /cookie/i,
  /password/i,
  /credential/i,
  /secret/i,
  /token/i,
];

const HEADER_SECRET_PATTERN = /\b(authorization|cookie)\b\s*[:=]\s*[^\r\n,;]*/gi;
const LABELED_SECRET_PATTERN =
  /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|credential)\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;}\]]+)/gi;

interface SanitizeState {
  readonly seen: WeakSet<object>;
  remainingItems: number;
}

function isSensitiveKey(key: string): boolean {
  return REDACTED_KEY_PATTERNS.some((pattern) => pattern.test(key));
}

function redactSensitiveText(value: string): string {
  if (!value) return value;
  // Redact header style: authorization: secret or authorization=secret
  let result = value.replace(/\b(authorization|cookie)\b(\s*[:=]\s*)([^\r\n,;]*)/gi, (_, key, sep, val) => {
    return `${key}${sep}${REDACTED}`;
  });
  // Redact labeled style: token: "secret", token=secret
  result = result.replace(/\b(api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|credential)\b(\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;}\]]+)/gi, (_, key, sep, val) => {
    return `${key}${sep}${REDACTED}`;
  });
  // Redact bearer token
  result = result.replace(/\bbearer\s+[a-zA-Z0-9_\-\.\~+/=]+/gi, `bearer ${REDACTED}`);
  return result;
}

function boundString(value: string, maxChars: number): string {
  const limit = Math.max(maxChars * 2, 4096);
  const truncated = value.length > limit ? value.slice(0, limit) : value;
  const redacted = redactSensitiveText(truncated);
  if (redacted.length <= maxChars) return redacted;
  return `${redacted.slice(0, maxChars)}\u2026[truncated ${value.length - maxChars} chars]`;
}

function safeString(value: unknown): string {
  try {
    return typeof value === "string" ? value : String(value);
  } catch {
    return UNAVAILABLE;
  }
}

function safeRead(value: object, key: PropertyKey): unknown {
  try {
    return (value as Record<PropertyKey, unknown>)[key];
  } catch {
    return UNAVAILABLE;
  }
}

function consumeItem(state: SanitizeState): boolean {
  if (state.remainingItems <= 0) return false;
  state.remainingItems -= 1;
  return true;
}

function isDate(value: unknown): value is Date {
  try {
    return value instanceof Date;
  } catch {
    return false;
  }
}

function isError(value: unknown): value is Error {
  try {
    return value instanceof Error;
  } catch {
    return false;
  }
}

/**
 * Convert any trace value into a redacted, JSON-safe, bounded value.
 * This is the only content pipeline used for messages, details,
 * errors, stacks, and nested values. It tolerates cycles, invalid
 * dates, throwing getters, proxies, symbols, bigints, and hostile
 * string conversion without allowing those values to escape tracing.
 */
function sanitizeValue(
  value: unknown,
  state: SanitizeState,
  depth = 0,
  maxStringChars = MAX_STRING_CHARS,
): unknown {
  if (depth > MAX_DEPTH) return DEPTH_CAP;
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return boundString(value, maxStringChars);
  if (typeof value === "number") return Number.isFinite(value) ? value : safeString(value);
  if (typeof value === "boolean") return value;
  if (typeof value === "bigint" || typeof value === "symbol" || typeof value === "function") {
    return boundString(safeString(value), maxStringChars);
  }

  if (isDate(value)) {
    try {
      return Number.isFinite(value.getTime()) ? value.toISOString() : "[Invalid Date]";
    } catch {
      return "[Invalid Date]";
    }
  }

  if (isError(value)) {
    if (state.seen.has(value)) return "[cycle]";
    state.seen.add(value);
    const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    output.name = sanitizeValue(safeRead(value, "name"), state, depth + 1, MAX_MESSAGE_CHARS);
    output.message = sanitizeValue(
      safeRead(value, "message"),
      state,
      depth + 1,
      MAX_MESSAGE_CHARS,
    );
    const stack = safeRead(value, "stack");
    if (stack !== undefined) {
      output.stack = sanitizeValue(stack, state, depth + 1, MAX_ERROR_STACK_CHARS);
    }
    const cause = safeRead(value, "cause");
    if (cause !== undefined) {
      output.cause = sanitizeValue(cause, state, depth + 1);
    }
    return output;
  }

  if (typeof value !== "object") {
    return boundString(safeString(value), maxStringChars);
  }

  if (state.seen.has(value)) return "[cycle]";
  state.seen.add(value);

  if (Array.isArray(value)) {
    let length = 0;
    try {
      length = Number.isSafeInteger(value.length) && value.length >= 0 ? value.length : 0;
    } catch {
      return UNAVAILABLE;
    }

    const sample: unknown[] = [];
    const limit = Math.min(length, MAX_ARRAY_ITEMS);
    for (let index = 0; index < limit; index += 1) {
      if (!consumeItem(state)) {
        sample.push(ITEM_CAP);
        break;
      }
      sample.push(sanitizeValue(safeRead(value, index), state, depth + 1));
    }
    return length > MAX_ARRAY_ITEMS ? { length, sample } : sample;
  }

  const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  let included = 0;
  try {
    for (const key in value as Record<string, unknown>) {
      let isOwn = false;
      try {
        isOwn = Object.prototype.hasOwnProperty.call(value, key);
      } catch {
        output.unavailable = UNAVAILABLE;
        break;
      }
      if (!isOwn) continue;
      if (included >= MAX_OBJECT_ITEMS || !consumeItem(state)) {
        output.truncated = ITEM_CAP;
        break;
      }
      included += 1;
      output[key] = isSensitiveKey(key)
        ? REDACTED
        : sanitizeValue(safeRead(value, key), state, depth + 1);
    }
  } catch {
    output.unavailable = UNAVAILABLE;
  }
  return output;
}

function createSanitizeState(): SanitizeState {
  return { seen: new WeakSet<object>(), remainingItems: MAX_TOTAL_ITEMS };
}

/**
 * File sink: best-effort append to a JSONL file. The directory is
 * created lazily so callers do not have to bootstrap it. Every write
 * is awaited inside the caller; failures are absorbed and never
 * thrown so a logging outage can never crash the plugin.
 */
export class FileTraceSink implements TraceSink {
  private readonly filePath: string;
  private readonly dir: string;

  constructor(options: FileTraceSinkOptions) {
    this.filePath = options.filePath;
    this.dir = path.dirname(options.filePath);
  }

  async write(line: string): Promise<void> {
    try {
      await mkdir(this.dir, { recursive: true });
      await appendFile(this.filePath, `${line}\n`, "utf8");
    } catch {
      // Best-effort: a logging failure must never break the plugin.
    }
  }
}

/**
 * In-memory sink used by tests. Stores every line so assertions can
 * inspect the trace log directly without touching the file system.
 */
export class MemoryTraceSink implements TraceSink {
  readonly lines: string[] = [];
  private shouldThrow = false;

  write(line: string): void {
    if (this.shouldThrow) throw new Error("sink failure (test)");
    this.lines.push(line);
  }

  /** Force the next write to throw — used to prove best-effort behavior. */
  armFailure(): void {
    this.shouldThrow = true;
  }

  /** Return every line parsed as JSON (skips empty lines). */
  parsed(): TraceEvent[] {
    const out: TraceEvent[] = [];
    for (const line of this.lines) {
      if (line.trim().length === 0) continue;
      try {
        out.push(JSON.parse(line) as TraceEvent);
      } catch {
        // Skip malformed lines.
      }
    }
    return out;
  }

  /** Reset state between subtests. */
  clear(): void {
    this.lines.length = 0;
    this.shouldThrow = false;
  }
}

export interface ModelRefreshTraceLoggerOptions {
  /**
   * Destination sink. Defaults to a `FileTraceSink` writing to
   * `defaultTracePath()`. Pass `new MemoryTraceSink()` from tests to
   * avoid touching the file system.
   */
  sink?: TraceSink;
  /**
   * Override the timestamp producer. Defaults to `new Date()`. Tests
   * can pin a deterministic clock.
   */
  clock?: () => Date;
  /**
   * Override the correlation id generator. Defaults to
   * `randomUUID()`. Tests can pass a deterministic counter.
   */
  idFactory?: () => string;
}

/**
 * Best-effort, async, JSONL trace logger for the model refresh
 * pipeline. The logger is intentionally NOT a sink — it owns
 * serialization, redaction, summarization, and timing so adapters can
 * emit trace points with a single `trace()` or `error()` call.
 *
 * Contract:
 *   - NEVER throws (failures inside the sink are absorbed).
 *   - NEVER blocks the caller (writes are kicked off and resolved
 *     asynchronously).
 *   - NEVER mutates the event payload.
 *   - NEVER logs raw provider arrays/objects; summarization collapses
 *     them to `{ length, sample }` so the log stays small.
 */
export class ModelRefreshTraceLogger {
  private readonly sink: TraceSink;
  private readonly clock: () => Date;
  private readonly idFactory: () => string;
  private pending: Promise<void> = Promise.resolve();

  constructor(options: ModelRefreshTraceLoggerOptions = {}) {
    this.sink = options.sink ?? new FileTraceSink({ filePath: defaultTracePath() });
    this.clock = options.clock ?? (() => new Date());
    this.idFactory = options.idFactory ?? (() => randomUUID());
  }

  /** Mint a correlation id without allowing tracing infrastructure to throw. */
  newCorrelationId(): string {
    try {
      const value = this.idFactory();
      if (typeof value === "string" && value.length > 0) return value;
    } catch {
      // Fall through to the runtime generator.
    }
    try {
      return randomUUID();
    } catch {
      return `trace-${Date.now()}`;
    }
  }

  /**
   * Queue a trace event. No event field is read, walked, or serialized
   * on the caller's stack; all sanitization and sink I/O run later in
   * the ordered best-effort queue.
   */
  trace(event: TraceEvent): void {
    this.enqueue(event);
  }

  /** Queue a failure event without synchronously spreading a hostile value. */
  error(event: Omit<TraceEvent, "status">): void {
    this.enqueue(event, "failure");
  }

  /** Wait for queued writes. Intended for deterministic tests and shutdown hooks. */
  async flush(): Promise<void> {
    try {
      await this.pending;
    } catch {
      // The queue absorbs failures, but flush remains defensive.
    }
  }

  startStage(correlationId: string, stage: string, details?: unknown): {
    success: (extraDetails?: unknown) => void;
    failure: (error: unknown, extraDetails?: unknown) => void;
  } {
    this.trace({ correlationId, stage, status: "start", details });
    const startedAt = this.safeNow();
    return {
      success: (extraDetails?: unknown) => {
        this.trace({
          correlationId,
          stage,
          status: "success",
          durationMs: Math.max(0, this.safeNow() - startedAt),
          details: extraDetails,
        });
      },
      failure: (error: unknown, extraDetails?: unknown) => {
        this.error({
          correlationId,
          stage,
          durationMs: Math.max(0, this.safeNow() - startedAt),
          details: extraDetails,
          error,
        });
      },
    };
  }

  private enqueue(
    event: TraceEvent | Omit<TraceEvent, "status">,
    forcedStatus?: TraceEvent["status"],
  ): void {
    try {
      const next = this.pending.then(async () => {
        try {
          const line = serializeEvent(event, this.clock, forcedStatus);
          await this.sink.write(line);
        } catch {
          // Serialization and sink failures must never affect refresh behavior.
        }
      });
      this.pending = next.catch(() => undefined);
    } catch {
      // Even queue setup remains best-effort.
    }
  }

  private safeNow(): number {
    try {
      const value = this.clock().getTime();
      return Number.isFinite(value) ? value : Date.now();
    } catch {
      return Date.now();
    }
  }
}

const TRACE_STATUSES = new Set<TraceEvent["status"]>([
  "start",
  "success",
  "failure",
  "request",
  "response",
]);

function safeTimestamp(clock: () => Date): string {
  try {
    const value = clock();
    if (value instanceof Date && Number.isFinite(value.getTime())) {
      return value.toISOString();
    }
  } catch {
    // Use a runtime timestamp below.
  }
  return new Date().toISOString();
}

function sanitizedString(
  value: unknown,
  state: SanitizeState,
  fallback: string,
  maxChars: number,
): string {
  const sanitized = sanitizeValue(value, state, 0, maxChars);
  return typeof sanitized === "string" ? sanitized : fallback;
}

function safeJsonStringify(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

/** Produce one valid, redacted JSONL line with a hard whole-event byte cap. */
function serializeEvent(
  event: TraceEvent | Omit<TraceEvent, "status">,
  clock: () => Date,
  forcedStatus?: TraceEvent["status"],
): string {
  try {
    const source = event !== null && typeof event === "object" ? event : {};
    const state = createSanitizeState();
    const rawStatus = forcedStatus ?? safeRead(source, "status");
    const status =
      typeof rawStatus === "string" && TRACE_STATUSES.has(rawStatus as TraceEvent["status"])
        ? (rawStatus as TraceEvent["status"])
        : "failure";
    const payload: Record<string, unknown> = {
      timestamp: safeTimestamp(clock),
      correlationId: sanitizedString(
        safeRead(source, "correlationId"),
        state,
        "trace-unavailable",
        200,
      ),
      stage: sanitizedString(safeRead(source, "stage"), state, "trace.unavailable", 200),
      status,
    };

    const durationMs = safeRead(source, "durationMs");
    if (typeof durationMs === "number" && Number.isFinite(durationMs)) {
      payload.durationMs = durationMs;
    }

    const message = safeRead(source, "message");
    if (message !== undefined) {
      payload.message = sanitizeValue(message, state, 0, MAX_MESSAGE_CHARS);
    }
    const details = safeRead(source, "details");
    if (details !== undefined) {
      payload.details = sanitizeValue(details, state);
    }
    const error = safeRead(source, "error");
    if (error !== undefined) {
      payload.error = sanitizeValue(error, state);
    }

    const serialized = safeJsonStringify(payload);
    if (
      serialized !== undefined &&
      Buffer.byteLength(serialized, "utf8") <= MAX_TRACE_LINE_BYTES
    ) {
      return serialized;
    }

    const boundedFallback = {
      timestamp: payload.timestamp,
      correlationId: payload.correlationId,
      stage: payload.stage,
      status: payload.status,
      truncated: true,
      reason: "event-byte-cap",
    };
    const fallbackLine = safeJsonStringify(boundedFallback);
    if (fallbackLine !== undefined) return fallbackLine;
  } catch {
    // Return the constant fallback below.
  }

  return '{"timestamp":"1970-01-01T00:00:00.000Z","correlationId":"trace-unavailable","stage":"trace.unavailable","status":"failure","truncated":true}';
}
