/**
 * Persisted routing handshake — the consumer-side read path for boot
 * credentials.
 *
 * The supervisor distributes the bootIdentity and HMAC signing key
 * through process env vars, which only reach the supervisor process
 * itself and its supervised `opencode serve` child. An interactive
 * OpenCode started outside the supervisor never inherits them, so
 * deterministic routing would fail closed with ROUTING_NOT_CONFIGURED
 * even while a healthy supervisor is running.
 *
 * To close that gap the supervisor publishes
 * `.opencode/sdd-model-routing/handshake.json` when the boot reaches
 * `ready` (mode 0o600, ACL'd to the current user, removed on
 * stop/failure). This module is the ONLY supported read path:
 *
 *   - the handshake must parse and carry a non-empty bootIdentity and
 *     a 64-char hex signing key;
 *   - the handshake bootIdentity MUST equal the live attestation's
 *     bootIdentity, binding the secrets to the supervisor's current
 *     boot so a stale file from a dead supervisor can never sign;
 *   - any failure returns null and the caller fails closed.
 *
 * The attestation TTL/expiry is enforced downstream by
 * ModelRouteReadiness.verify(); this module only establishes that the
 * handshake and the attestation belong to the same boot.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

export const ROUTING_HANDSHAKE_FILENAME = "handshake.json";
const ATTESTATION_FILENAME = "attestation.json";
const SIGNING_KEY_HEX_REGEX = /^[0-9a-f]{64}$/i;

export interface RoutingHandshake {
  readonly bootIdentity: string;
  readonly signingKey: string;
}

/**
 * Default on-disk location of the handshake artifact for a workspace.
 */
export function handshakePathFor(workspaceRoot: string): string {
  return path.join(path.resolve(workspaceRoot), ".opencode", "sdd-model-routing", ROUTING_HANDSHAKE_FILENAME);
}

/**
 * Read and validate the persisted handshake for a workspace. Returns
 * null — never throws — when the handshake is missing, corrupt, has
 * an invalid key shape, or disagrees with the live attestation.
 */
export function readRoutingHandshake(workspaceRoot: string): RoutingHandshake | null {
  const routingDir = path.join(path.resolve(workspaceRoot), ".opencode", "sdd-model-routing");

  let handshake: Record<string, unknown>;
  try {
    handshake = JSON.parse(readFileSync(path.join(routingDir, ROUTING_HANDSHAKE_FILENAME), "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }

  const bootIdentity = handshake["bootIdentity"];
  if (typeof bootIdentity !== "string" || bootIdentity.length === 0) return null;
  const signingKey = handshake["signingKey"];
  if (typeof signingKey !== "string" || !SIGNING_KEY_HEX_REGEX.test(signingKey)) return null;

  let attestation: Record<string, unknown>;
  try {
    attestation = JSON.parse(readFileSync(path.join(routingDir, ATTESTATION_FILENAME), "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (attestation["bootIdentity"] !== bootIdentity) return null;

  return { bootIdentity, signingKey };
}
