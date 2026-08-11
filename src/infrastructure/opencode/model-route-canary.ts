import path from "node:path";

import type { Manifest, ManifestRouteEntry } from "./disk-agent-generator.js";

export type CanaryErrorCode =
  | "CANARY_FAILED"
  | "PARENT_MODEL_UNAVAILABLE"
  | "PARENT_MODEL_MISMATCH"
  | "CHILD_SESSION_MISSING"
  | "CANARY_METADATA_MISMATCH"
  | "CANARY_METADATA_UNOBSERVABLE"
  | "CANARY_TIMEOUT";

export class CanaryBlockedError extends Error {
  constructor(readonly code: CanaryErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "CanaryBlockedError";
  }
}

export interface CanarySession {
  readonly id: string;
  readonly model?: { readonly providerID: string; readonly modelID: string };
}

export interface CanaryHostTransport {
  createSession(input: { parentModel: string }): Promise<CanarySession>;
  /**
   * Read back the persisted session record (GET /session/:id) so the
   * canary can prove the parent session was actually created with the
   * requested `parentModel`. Required to detect hosts that silently
   * override the requested identity; the boot manager treats a
   * mismatch as PARENT_MODEL_MISMATCH and fails closed.
   */
  getSession(sessionId: string): Promise<CanarySession>;
  invokeCommand(input: {
    sessionId: string;
    command: string;
    arguments: string;
    parentModel: string;
  }): Promise<void>;
  listChildren(parentSessionId: string): Promise<ReadonlyArray<CanarySession>>;
  listMessages(childSessionId: string): Promise<ReadonlyArray<unknown>>;
}

export interface CanaryEvidence {
  readonly hostName: string;
  readonly command: string;
  readonly targetCanonicalId: string;
  readonly parentCanonicalId: string;
  readonly parentSessionId: string;
  readonly childSessionId: string;
  readonly observedUserCanonicalId: string;
  readonly observedAssistantCanonicalId: string;
}

export interface CanaryFailure {
  readonly hostName: string;
  readonly targetCanonicalId: string;
  readonly code: CanaryErrorCode;
  readonly message: string;
  readonly attempts: number;
}

export interface CanaryReport {
  readonly proven: ReadonlyArray<CanaryEvidence>;
  readonly blocked: ReadonlyArray<CanaryFailure>;
}

export interface ModelRouteCanaryOptions {
  readonly transport: CanaryHostTransport;
  readonly selectParentModel: (targetCanonicalId: string) => Promise<string | null>;
  readonly timeoutMs?: number;
  readonly canaryRetries?: number;
}

interface MessageIdentity {
  role: "user" | "assistant";
  canonicalId: string;
  completed: boolean;
}

function identityOf(value: unknown): MessageIdentity | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const info = record.info;
  if (!info || typeof info !== "object") return null;
  const infoObj = info as Record<string, unknown>;
  const role = infoObj.role;
  if (role !== "user" && role !== "assistant") return null;

  // OpenCode 1.18.9 metadata is role-aware: user identity is nested under
  // info.model.{providerID,modelID}, assistant identity is direct on
  // info.{providerID,modelID}. Flattened legacy structures (providerID
  // directly on info for user messages; info.model.* for assistant messages)
  // are rejected so we never prove dispatch off a synthetic shape.
  let providerID: unknown;
  let modelID: unknown;
  if (role === "user") {
    const nested = infoObj.model;
    if (!nested || typeof nested !== "object") return null;
    const nestedObj = nested as Record<string, unknown>;
    providerID = nestedObj.providerID;
    modelID = nestedObj.modelID;
  } else {
    providerID = infoObj.providerID;
    modelID = infoObj.modelID;
  }
  if (typeof providerID !== "string" || typeof modelID !== "string") return null;

  // Assistant messages must additionally prove completion via non-empty
  // `finish` and non-empty `time.completed`. User messages are considered
  // complete by construction once their metadata is observable.
  let completed = role === "user";
  if (!completed) {
    const finish = infoObj.finish;
    const time = infoObj.time;
    const completedTs = time && typeof time === "object" ? (time as Record<string, unknown>).completed : undefined;
    completed = typeof finish === "string" && finish.length > 0 && (typeof completedTs === "number" || typeof completedTs === "string") && completedTs !== null && completedTs !== undefined && completedTs !== 0;
  }

  return { role, canonicalId: `${providerID}/${modelID}`, completed };
}

function commandName(route: ManifestRouteEntry): string {
  return path.basename(route.commandFile.relativePath, path.extname(route.commandFile.relativePath));
}

async function bounded<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new CanaryBlockedError("CANARY_TIMEOUT", `operation exceeded ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function waitForEvidenceInterval(timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, Math.min(100, timeoutMs)));
}

export interface OpenCodeHttpCanaryTransportOptions {
  readonly baseUrl: string;
  readonly fetchImpl?: typeof fetch;
  readonly commandAckTimeoutMs?: number;
}

const DEFAULT_COMMAND_ACK_TIMEOUT_MS = 15_000;

function responseData(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  return "data" in record ? record.data : value;
}

export class OpenCodeHttpCanaryTransport implements CanaryHostTransport {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly commandAckTimeoutMs: number;

  constructor(options: OpenCodeHttpCanaryTransportOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.commandAckTimeoutMs = options.commandAckTimeoutMs ?? DEFAULT_COMMAND_ACK_TIMEOUT_MS;
  }

  async createSession(input: { parentModel: string }): Promise<CanarySession> {
    const segments = input.parentModel.split("/");
    if (segments.length !== 2 || segments.some((segment) => segment.length === 0)) {
      throw new CanaryBlockedError("PARENT_MODEL_UNAVAILABLE", `invalid parent model ${input.parentModel}; expected provider/id`);
    }
    const [providerID, id] = segments;
    const result = await this.request("/session", {
      method: "POST",
      body: JSON.stringify({
        title: `sdd model routing canary (${input.parentModel})`,
        model: { providerID, id },
      }),
    });
    return this.session(responseData(result));
  }

  async invokeCommand(input: { sessionId: string; command: string; arguments: string; parentModel: string }): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.commandAckTimeoutMs);
    try {
      await this.request(`/session/${encodeURIComponent(input.sessionId)}/command`, {
        method: "POST",
        body: JSON.stringify({ command: input.command, arguments: input.arguments }),
        signal: controller.signal,
      });
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async listChildren(parentSessionId: string): Promise<ReadonlyArray<CanarySession>> {
    const result = responseData(await this.request(`/session/${encodeURIComponent(parentSessionId)}/children`));
    if (!Array.isArray(result)) return [];
    return result.map((value) => this.session(value));
  }

  async listMessages(childSessionId: string): Promise<ReadonlyArray<unknown>> {
    const result = responseData(await this.request(`/session/${encodeURIComponent(childSessionId)}/message`));
    return Array.isArray(result) ? result : [];
  }

  /**
   * Read back the parent session record (GET /session/:id). The
   * response carries the session's `model` so the canary can prove
   * the host created the parent with the requested `parentModel`
   * and did not silently override it. Returns `{ id }` when the host
   * does not surface a `model` object; the canary treats that as
   * a host that does not support the read-back contract.
   */
  async getSession(sessionId: string): Promise<CanarySession> {
    const result = responseData(await this.request(`/session/${encodeURIComponent(sessionId)}`));
    if (!result || typeof result !== "object") {
      throw new CanaryBlockedError("CANARY_METADATA_UNOBSERVABLE", `OpenCode session ${sessionId} response is not an object`);
    }
    return this.session(result);
  }

  private session(value: unknown): CanarySession {
    if (!value || typeof value !== "object") {
      throw new CanaryBlockedError("CANARY_METADATA_UNOBSERVABLE", "OpenCode session response is not an object");
    }
    const record = value as Record<string, unknown>;
    const id = record["id"];
    if (typeof id !== "string") {
      throw new CanaryBlockedError("CANARY_METADATA_UNOBSERVABLE", "OpenCode session response omitted id");
    }
    const modelRaw = record["model"];
    let model: { providerID: string; modelID: string } | undefined;
    if (modelRaw && typeof modelRaw === "object") {
      const modelRecord = modelRaw as Record<string, unknown>;
      const providerID = modelRecord["providerID"];
      const modelID = modelRecord["modelID"] ?? modelRecord["id"];
      if (typeof providerID === "string" && typeof modelID === "string") {
        model = { providerID, modelID };
      }
    }
    return model === undefined ? { id } : { id, model };
  }

  private async request(endpoint: string, init?: RequestInit): Promise<unknown> {
    const response = await this.fetchImpl(`${this.baseUrl}${endpoint}`, {
      ...init,
      headers: { "content-type": "application/json", ...init?.headers },
    });
    if (!response.ok) throw new CanaryBlockedError("CANARY_FAILED", `${init?.method ?? "GET"} ${endpoint} returned ${response.status}`);
    return response.json();
  }
}

export class ModelRouteCanary {
  private readonly timeoutMs: number;
  private readonly canaryRetries: number;

  constructor(private readonly options: ModelRouteCanaryOptions) {
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.canaryRetries = Math.max(0, options.canaryRetries ?? 1);
  }

  async verifyRoutes(manifest: Manifest): Promise<CanaryReport> {
    const proven: CanaryEvidence[] = [];
    const blocked: CanaryFailure[] = [];
    for (const route of manifest.routes) {
      const targetCanonicalId = `${route.providerId}/${route.modelId}`;
      const maxAttempts = 1 + this.canaryRetries;
      let lastError: CanaryBlockedError | null = null;
      let attempts = 0;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        attempts = attempt;
        try {
          proven.push(await this.verifyRoute(route));
          lastError = null;
          break;
        } catch (error) {
          if (error instanceof CanaryBlockedError) {
            lastError = error;
            continue;
          }
          throw error;
        }
      }
      if (lastError) {
        blocked.push({
          hostName: route.hostName,
          targetCanonicalId,
          code: lastError.code,
          message: lastError.message,
          attempts,
        });
      }
    }
    return { proven, blocked };
  }

  async verifyEveryRoute(manifest: Manifest): Promise<ReadonlyArray<CanaryEvidence>> {
    const report = await this.verifyRoutes(manifest);
    if (report.blocked.length > 0) {
      const first = report.blocked[0]!;
      throw new CanaryBlockedError(first.code, first.message);
    }
    return report.proven;
  }

  private async verifyRoute(route: ManifestRouteEntry): Promise<CanaryEvidence> {
    const targetCanonicalId = `${route.providerId}/${route.modelId}`;
    const parentCanonicalId = await bounded(this.options.selectParentModel(targetCanonicalId), this.timeoutMs);
    if (!parentCanonicalId || parentCanonicalId === targetCanonicalId) {
      throw new CanaryBlockedError("PARENT_MODEL_UNAVAILABLE", `no distinct parent model for ${targetCanonicalId}`);
    }
    const parent = await bounded(this.options.transport.createSession({ parentModel: parentCanonicalId }), this.timeoutMs);
    // Authoritative read-back: GET /session/:id must report the
    // parent model we requested. A host that creates the session
    // under a different canonical is silently overriding us, which
    // the dispatch path must never trust.
    const readback = await bounded(this.options.transport.getSession(parent.id), this.timeoutMs);
    if (!readback.model) {
      throw new CanaryBlockedError(
        "PARENT_MODEL_MISMATCH",
        `parent session ${parent.id} read-back omitted model; refusing to trust host override`,
      );
    }
    const observedParentCanonicalId = `${readback.model.providerID}/${readback.model.modelID}`;
    if (observedParentCanonicalId !== parentCanonicalId) {
      throw new CanaryBlockedError(
        "PARENT_MODEL_MISMATCH",
        `parent session ${parent.id} was created with model ${observedParentCanonicalId}, expected ${parentCanonicalId}`,
      );
    }
    const before = new Set((await bounded(this.options.transport.listChildren(parent.id), this.timeoutMs)).map((child) => child.id));
    const command = commandName(route);
    await bounded(this.options.transport.invokeCommand({
      sessionId: parent.id,
      command,
      arguments: `sdd-model-routing-canary:${route.hostName}`,
      parentModel: parentCanonicalId,
    }), this.timeoutMs);
    const after = await bounded(this.options.transport.listChildren(parent.id), this.timeoutMs);
    const observable = after.filter((child) => !before.has(child.id));
    if (observable.length === 0) throw new CanaryBlockedError("CHILD_SESSION_MISSING", `no new child created for ${route.hostName}`);

    let sawObservableMetadata = false;
    const deadline = Date.now() + this.timeoutMs;
    while (Date.now() < deadline) {
      let pendingMetadata = false;
      let sawMismatch = false;
      let sawMalformedMetadata = false;
      for (const child of observable) {
        const remaining = Math.max(1, deadline - Date.now());
        const identities = (await bounded(this.options.transport.listMessages(child.id), remaining))
          .map(identityOf)
          .filter((item): item is MessageIdentity => item !== null);
        const user = identities.find((item) => item.role === "user");
        const assistant = identities.find((item) => item.role === "assistant" && item.completed);
        if (!user || !assistant) {
          if (user && !assistant) pendingMetadata = true;
          else sawMalformedMetadata = true;
          continue;
        }
        sawObservableMetadata = true;
        if (user.canonicalId === targetCanonicalId && assistant.canonicalId === targetCanonicalId) {
          return {
            hostName: route.hostName,
            command,
            targetCanonicalId,
            parentCanonicalId,
            parentSessionId: parent.id,
            childSessionId: child.id,
            observedUserCanonicalId: user.canonicalId,
            observedAssistantCanonicalId: assistant.canonicalId,
          };
        }
        sawMismatch = true;
      }
      if (sawMismatch && !pendingMetadata) {
        throw new CanaryBlockedError(
          "CANARY_METADATA_MISMATCH",
          `authoritative child user/completed-assistant metadata did not prove ${targetCanonicalId}`,
        );
      }
      if (sawMalformedMetadata && !pendingMetadata && !sawMismatch) {
        throw new CanaryBlockedError(
          "CANARY_METADATA_UNOBSERVABLE",
          `authoritative child metadata did not expose a user/completed-assistant pair for ${targetCanonicalId}`,
        );
      }
      const remaining = deadline - Date.now();
      if (remaining > 0) await waitForEvidenceInterval(remaining);
    }
    throw new CanaryBlockedError(
      sawObservableMetadata ? "CANARY_METADATA_MISMATCH" : "CANARY_METADATA_UNOBSERVABLE",
      `authoritative child user/completed-assistant metadata did not prove ${targetCanonicalId}`,
    );
  }
}
