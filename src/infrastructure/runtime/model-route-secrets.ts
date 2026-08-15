/**
 * Persisted routing secrets — the stable, workspace-scoped credentials
 * for deterministic model routing.
 *
 * Design decision (model-routing/secrets-lifecycle): the boot manager
 * no longer rotates a fresh `bootIdentity` + HMAC `signingKey` on every
 * `start()`. Instead the pair is generated ONCE and persisted to
 * `.opencode/sdd-model-routing/secrets.json` (mode 0o600, ACL'd to the
 * current user), then reused across restarts. Rotation is explicit only
 * (`rotateRoutingSecrets`).
 *
 * Why: interactive OpenCode sessions are not children of the supervisor
 * and never inherit its process env. They read credentials from disk. A
 * per-boot rotation made that read race against the supervisor's
 * attestation (a stale key → `invalid attestation signature` → the
 * dispatch never fired). A stable key removes the race: any session,
 * started before or after the supervisor, reads the SAME key the
 * attestation was signed with.
 *
 * Security tradeoff (accepted): the HMAC key now lives on disk instead
 * of process memory only. Mitigations: 0o600 + current-user ACL, and the
 * key only signs model-routing attestations (no provider credentials).
 * For a stronger guarantee, migrate to DPAPI/Credential Manager later;
 * the read surface is this module only.
 */

import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { applyCurrentUserAcl } from "./windows-acl.js";

export const ROUTING_SECRETS_FILENAME = "secrets.json";
export const ROUTING_SECRETS_VERSION = 1;

const SIGNING_KEY_HEX_REGEX = /^[0-9a-f]{64}$/i;
const BOOT_IDENTITY_UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface RoutingSecrets {
  readonly version: number;
  readonly bootIdentity: string;
  /** 64-char hex-encoded 256-bit HMAC key. */
  readonly signingKey: string;
  readonly createdAt: number;
}

/** Default on-disk location of the secrets artifact for a workspace. */
export function secretsPathFor(workspaceRoot: string): string {
  return path.join(path.resolve(workspaceRoot), ".opencode", "sdd-model-routing", ROUTING_SECRETS_FILENAME);
}

/**
 * Read and validate the persisted secrets. Returns `null` — never throws
 * — when the file is missing, corrupt, or has an invalid shape.
 */
export function readRoutingSecrets(workspaceRoot: string): RoutingSecrets | null {
  let raw: string;
  try {
    raw = readFileSync(secretsPathFor(workspaceRoot), "utf8");
  } catch {
    return null;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }

  const bootIdentity = parsed["bootIdentity"];
  const signingKey = parsed["signingKey"];
  if (typeof bootIdentity !== "string" || !BOOT_IDENTITY_UUID_V4_REGEX.test(bootIdentity)) return null;
  if (typeof signingKey !== "string" || !SIGNING_KEY_HEX_REGEX.test(signingKey)) return null;

  const version = typeof parsed["version"] === "number" ? parsed["version"] : 0;
  const createdAt = typeof parsed["createdAt"] === "number" ? parsed["createdAt"] : 0;
  return { version, bootIdentity, signingKey, createdAt };
}

function generateRoutingSecrets(): RoutingSecrets {
  return {
    version: ROUTING_SECRETS_VERSION,
    bootIdentity: randomUUID(),
    signingKey: randomBytes(32).toString("hex"),
    createdAt: Date.now(),
  };
}

function writeRoutingSecrets(workspaceRoot: string, secrets: RoutingSecrets): void {
  const target = secretsPathFor(workspaceRoot);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, JSON.stringify(secrets, null, 2), { encoding: "utf8", mode: 0o600 });
  applyCurrentUserAcl(target);
}

/**
 * Load the persisted secrets, or generate + persist them on first use.
 * Idempotent and safe to call from both the supervisor and interactive
 * sessions: whoever arrives first creates, the rest converge on the same
 * stable pair.
 */
export function loadOrCreateRoutingSecrets(workspaceRoot: string): RoutingSecrets {
  const existing = readRoutingSecrets(workspaceRoot);
  if (existing !== null) return existing;
  const fresh = generateRoutingSecrets();
  writeRoutingSecrets(workspaceRoot, fresh);
  return fresh;
}

/**
 * Explicit rotation: generate a fresh pair and overwrite the persisted
 * secrets. Any attestation signed with the previous key becomes invalid
 * (fail-closed) until the next supervised boot reissues it.
 */
export function rotateRoutingSecrets(workspaceRoot: string): RoutingSecrets {
  const fresh = generateRoutingSecrets();
  writeRoutingSecrets(workspaceRoot, fresh);
  return fresh;
}
