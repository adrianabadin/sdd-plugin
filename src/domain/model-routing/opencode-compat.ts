/**
 * OpenCode compatibility gate for deterministic model routing.
 *
 * Generated disk hosts and their post-restart readiness attestation bind to
 * one audited runtime contract. The gate is a MINIMUM, not an exact pin:
 * the runtime may move forward within the same major (patch and minor
 * releases are transparent), so a routine OpenCode update never forces a
 * supervisor re-boot. A major bump still fails closed: the plugin's SDK
 * surface is only audited inside the bound major.
 */

export const OPENCODE_COMPAT_VERSION = "1.18.17";

export interface OpenCodeVersionParts {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

export class OpenCodeCompatError extends Error {
  readonly runtimeVersion: string;
  readonly requiredVersion: string;
  constructor(runtimeVersion: string, requiredVersion: string) {
    super(
      `OpenCode compatibility gate failed: runtime reports "${runtimeVersion}", required minimum "${requiredVersion}" within the same major. Routing refuses to start.`,
    );
    this.name = "OpenCodeCompatError";
    this.runtimeVersion = runtimeVersion;
    this.requiredVersion = requiredVersion;
  }
}

/**
 * Parse a stable or suffixed semver like `1.18.17` or `1.18.17-rc.1`.
 * Anything else (`latest`, `1.18`, `undefined`) fails closed as `null`.
 */
export function parseOpenCodeVersion(version: string): OpenCodeVersionParts | null {
  if (typeof version !== "string") return null;
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version);
  if (match === null) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

/**
 * True when `runtimeVersion` is supported: same major as the minimum, and
 * at least the minimum patch — i.e. `>= minimum` within one major.
 */
export function isOpenCodeVersionSupported(runtimeVersion: unknown): boolean {
  if (typeof runtimeVersion !== "string" || runtimeVersion.length === 0) return false;
  const min = parseOpenCodeVersion(OPENCODE_COMPAT_VERSION);
  const parts = parseOpenCodeVersion(runtimeVersion);
  if (min === null || parts === null) return false;
  if (parts.major !== min.major) return false;
  return parts.minor > min.minor || (parts.minor === min.minor && parts.patch >= min.patch);
}

/**
 * Assert the runtime OpenCode version satisfies the minimum contract.
 * Rejects downgrades, other majors, and unparsable values fail closed.
 */
export function assertOpenCodeCompatible(runtimeVersion: unknown): void {
  if (!isOpenCodeVersionSupported(runtimeVersion)) {
    throw new OpenCodeCompatError(String(runtimeVersion), OPENCODE_COMPAT_VERSION);
  }
}