/**
 * Exact OpenCode compatibility gate for deterministic model routing.
 *
 * Generated disk hosts and their post-restart readiness attestation bind to
 * one audited runtime contract. Keeping the comparison as a pure helper lets
 * those later boundaries reject version drift without depending on synthetic
 * Config or effective Agent shapes.
 */

export const OPENCODE_COMPAT_VERSION = "1.18.9";

export class OpenCodeCompatError extends Error {
  readonly runtimeVersion: string;
  readonly requiredVersion: typeof OPENCODE_COMPAT_VERSION;
  constructor(runtimeVersion: string, requiredVersion: typeof OPENCODE_COMPAT_VERSION) {
    super(
      `OpenCode compatibility gate failed: runtime reports "${runtimeVersion}", required exact "${requiredVersion}". Routing refuses to start.`,
    );
    this.name = "OpenCodeCompatError";
    this.runtimeVersion = runtimeVersion;
    this.requiredVersion = requiredVersion;
  }
}

/**
 * Assert the runtime OpenCode version matches the exact pin. Anything
 * else — `>=1.18.4`, `1.18.4-rc.1`, `latest`, `undefined` — fails closed.
 */
export function assertOpenCodeCompatible(runtimeVersion: unknown): void {
  if (typeof runtimeVersion !== "string" || runtimeVersion.length === 0) {
    throw new OpenCodeCompatError(String(runtimeVersion), OPENCODE_COMPAT_VERSION);
  }
  if (runtimeVersion !== OPENCODE_COMPAT_VERSION) {
    throw new OpenCodeCompatError(runtimeVersion, OPENCODE_COMPAT_VERSION);
  }
}