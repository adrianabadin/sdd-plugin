/**
 * WU4 remediation (D1+D2) — shared Windows ACL helper for the
 * model-routing attestation + boot manager.
 *
 * The previous implementation lived in two places and used bare
 * binary names ("whoami", "icacls") which are PATH-resolved.
 * On Git-for-Windows the POSIX `whoami` precedes `System32` on
 * PATH and rejects `/user`, so `applyCurrentUserAcl` threw under
 * the default shell — surfaced as `AttestationMismatchError` (a
 * security tamper signal) for what is really an environment fault.
 *
 * This module is the single source of truth. It:
 *   - resolves `whoami.exe` and `icacls.exe` by absolute path under
 *     `process.env.SystemRoot ?? "C:\Windows"` + `\System32\`, so
 *     PATH order cannot shadow them;
 *   - throws a dedicated `AclRestrictionError` (code
 *     `ACL_RESTRICTION_FAILED`) on any tooling failure, so the
 *     dispatch hook + the boot manager can distinguish a tooling
 *     fault from a security tamper (`AttestationMismatchError`,
 *     code `ATTESTATION_MISMATCH`);
 *   - preserves the existing fail-closed contract: an ACL
 *     restriction that cannot be applied is propagated to the
 *     caller, never swallowed.
 *
 * Reference: PMC/Engram #2400 (wu4-remediation-design, D1+D2).
 */

import { execFileSync } from "node:child_process";
import path from "node:path";

/**
 * Thrown when the Windows ACL cannot be restricted to the current
 * user. Distinct from `AttestationMismatchError` (which signals a
 * security tamper on the `verify()` path) so tooling faults and
 * security faults are never confused in audit / error reporting.
 */
export class AclRestrictionError extends Error {
  readonly code = "ACL_RESTRICTION_FAILED";
  readonly filePath: string;
  constructor(filePath: string, cause: unknown) {
    super(
      `ACL_RESTRICTION_FAILED: unable to restrict Windows ACL on ${filePath}: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
    this.name = "AclRestrictionError";
    this.filePath = filePath;
    this.cause = cause;
  }
}

/**
 * Restrict the named file's Windows ACL to the current user only.
 * Removes inheritance and grants the current user's SID (or
 * canonical account name as a fallback for offline Windows
 * sandboxes where the SID is not resolvable by `icacls`).
 *
 * `whoami.exe` and `icacls.exe` are resolved by absolute path
 * under `${SystemRoot}\System32\` so the inherited PATH cannot
 * shadow them with POSIX shims (notably Git-for-Windows'
 * `/usr/bin/whoami`, which rejects `/user` and would otherwise
 * surface as an `AttestationMismatchError` tamper signal).
 *
 * On non-Windows platforms this is a no-op (the rest of the
 * routing stack relies on POSIX 0600 mode bits).
 *
 * On any tooling failure, throws `AclRestrictionError` with
 * `code === "ACL_RESTRICTION_FAILED"`. The caller (boot manager
 * or dispatch hook) decides how to surface it; we never relabel
 * a tooling fault as a security attestation mismatch.
 */
export function applyCurrentUserAcl(filePath: string): void {
  if (process.platform !== "win32") return;
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  const whoami = path.join(systemRoot, "System32", "whoami.exe");
  const icacls = path.join(systemRoot, "System32", "icacls.exe");
  try {
    const output = execFileSync(whoami, ["/user"], { encoding: "utf8", windowsHide: true });
    const sid = output.match(/S-\d-\d+(?:-\d+)+/i)?.[0];
    if (!sid) throw new Error("current user SID unavailable");
    try {
      execFileSync(icacls, [filePath, "/inheritance:r", "/grant:r", `${sid}:F`], { windowsHide: true, stdio: "ignore" });
    } catch {
      // Offline Windows sandboxes can expose a SID which is not resolvable
      // by the local ACL provider. Fall back to the canonical account name;
      // this still grants only the current user and never re-enables inherit.
      const account = execFileSync(whoami, [], { encoding: "utf8", windowsHide: true }).trim();
      if (!account) throw new Error("current user account unavailable");
      execFileSync(icacls, [filePath, "/inheritance:r", "/grant:r", `${account}:F`], { windowsHide: true, stdio: "ignore" });
    }
  } catch (error) {
    if (error instanceof AclRestrictionError) throw error;
    throw new AclRestrictionError(filePath, error);
  }
}
