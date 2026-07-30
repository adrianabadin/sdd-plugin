import path from "node:path";

import type { Manifest, ManifestRouteEntry } from "./disk-agent-generator.js";

export type CanaryErrorCode =
  | "CANARY_FAILED"
  | "PARENT_MODEL_UNAVAILABLE"
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
}

export interface CanaryHostTransport {
  createSession(input: { parentModel: string }): Promise<CanarySession>;
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

export interface ModelRouteCanaryOptions {
  readonly transport: CanaryHostTransport;
  readonly selectParentModel: (targetCanonicalId: string) => Promise<string | null>;
  readonly timeoutMs?: number;
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

export interface OpenCodeHttpCanaryTransportOptions {
  readonly baseUrl: string;
  readonly fetchImpl?: typeof fetch;
}

function responseData(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  return "data" in record ? record.data : value;
}

export class OpenCodeHttpCanaryTransport implements CanaryHostTransport {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenCodeHttpCanaryTransportOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
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
    await this.request(`/session/${encodeURIComponent(input.sessionId)}/command`, {
      method: "POST",
      body: JSON.stringify({ command: input.command, arguments: input.arguments }),
    });
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

  private session(value: unknown): CanarySession {
    const id = value && typeof value === "object" ? (value as Record<string, unknown>).id : undefined;
    if (typeof id !== "string") {
      throw new CanaryBlockedError("CANARY_METADATA_UNOBSERVABLE", "OpenCode session response omitted id");
    }
    return { id };
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

  constructor(private readonly options: ModelRouteCanaryOptions) {
    this.timeoutMs = options.timeoutMs ?? 120_000;
  }

  async verifyEveryRoute(manifest: Manifest): Promise<ReadonlyArray<CanaryEvidence>> {
    const results: CanaryEvidence[] = [];
    for (const route of manifest.routes) results.push(await this.verifyRoute(route));
    if (results.length !== manifest.routes.length) {
      throw new CanaryBlockedError("CANARY_FAILED", "not every manifest route produced evidence");
    }
    return results;
  }

  private async verifyRoute(route: ManifestRouteEntry): Promise<CanaryEvidence> {
    const targetCanonicalId = `${route.providerId}/${route.modelId}`;
    const parentCanonicalId = await bounded(this.options.selectParentModel(targetCanonicalId), this.timeoutMs);
    if (!parentCanonicalId || parentCanonicalId === targetCanonicalId) {
      throw new CanaryBlockedError("PARENT_MODEL_UNAVAILABLE", `no distinct parent model for ${targetCanonicalId}`);
    }
    const parent = await bounded(this.options.transport.createSession({ parentModel: parentCanonicalId }), this.timeoutMs);
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
    for (const child of observable) {
      const identities = (await bounded(this.options.transport.listMessages(child.id), this.timeoutMs))
        .map(identityOf)
        .filter((item): item is MessageIdentity => item !== null);
      const user = identities.find((item) => item.role === "user");
      const assistant = identities.find((item) => item.role === "assistant" && item.completed);
      if (!user || !assistant) continue;
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
    }
    throw new CanaryBlockedError(
      sawObservableMetadata ? "CANARY_METADATA_MISMATCH" : "CANARY_METADATA_UNOBSERVABLE",
      `authoritative child user/completed-assistant metadata did not prove ${targetCanonicalId}`,
    );
  }
}
