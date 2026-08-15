/**
 * Persisted session lease — ties the supervisor's lifetime to the
 * interactive OpenCode session.
 *
 * Design decision (model-routing/secrets-lifecycle): the supervisor used
 * to run detached and outlive the session. Now any OpenCode process with
 * the plugin loaded renews a lease on a fixed cadence; the supervisor
 * monitors it and stops itself once the lease expires (the owning
 * session(s) are gone). This is portable (no Windows Job Object) and
 * needs no dispose hook — the renewal timer dies with the OpenCode
 * process that owns it.
 *
 * The lease is per-workspace (`.opencode/sdd-model-routing/lease.json`),
 * so each workspace's supervisor is bound to its own session(s). While
 * ANY session renews the lease, the supervisor stays alive.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { applyCurrentUserAcl } from "./windows-acl.js";

export const ROUTING_LEASE_FILENAME = "lease.json";

/** How often an OpenCode session renews the lease. */
export const LEASE_RENEWAL_MS = 30_000;

/** How long the supervisor waits without a renewal before stopping. */
export const LEASE_TTL_MS = 120_000;

/** How often the supervisor checks the lease for expiry. */
export const LEASE_MONITOR_MS = 15_000;

export interface RoutingLease {
  readonly pid: number;
  readonly lastSeen: number;
}

export function leasePathFor(workspaceRoot: string): string {
  return path.join(path.resolve(workspaceRoot), ".opencode", "sdd-model-routing", ROUTING_LEASE_FILENAME);
}

/**
 * Renew the lease with the current timestamp. Best-effort: failures are
 * swallowed so a lease write never breaks the plugin.
 */
export function renewRoutingLease(workspaceRoot: string, pid: number = process.pid): void {
  const target = leasePathFor(workspaceRoot);
  try {
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, JSON.stringify({ pid, lastSeen: Date.now() }), { encoding: "utf8", mode: 0o600 });
    applyCurrentUserAcl(target);
  } catch {
    /* best-effort */
  }
}

/** Read the persisted lease; `null` when missing or malformed. */
export function readRoutingLease(workspaceRoot: string): RoutingLease | null {
  try {
    const parsed = JSON.parse(readFileSync(leasePathFor(workspaceRoot), "utf8")) as Record<string, unknown>;
    const lastSeen = typeof parsed["lastSeen"] === "number" ? parsed["lastSeen"] : NaN;
    const pid = typeof parsed["pid"] === "number" ? parsed["pid"] : 0;
    if (Number.isNaN(lastSeen)) return null;
    return { pid, lastSeen };
  } catch {
    return null;
  }
}
