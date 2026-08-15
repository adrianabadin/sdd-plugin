import { createHash, createHmac, randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import type { Manifest } from "./disk-agent-generator.js";
import { resolveForeignAgentSources } from "./foreign-agent-sources.js";
import { assertNoForeignAgentDefinitions } from "./foreign-agent-scan.js";
import { ROUTED_HOST_NAME_PREFIX } from "../../domain/model-routing/model-route-host-naming.js";
import type { CanaryEvidence } from "./model-route-canary.js";
import {
  isOpenCodeVersionSupported,
  OPENCODE_COMPAT_VERSION,
  parseOpenCodeVersion,
} from "../../domain/model-routing/opencode-compat.js";
import { applyCurrentUserAcl } from "../runtime/windows-acl.js";

/**
 * Minimum OpenCode runtime the attestation contract is audited against.
 * NOT an exact pin: newer patch/minor versions within the same major are
 * supported (see `isOpenCodeVersionSupported`), so routine runtime updates
 * do not invalidate the supervisor state.
 */
export const REQUIRED_OPENCODE_VERSION = OPENCODE_COMPAT_VERSION;
export const READINESS_VERIFIER_VERSION = "1.0.0";
const ROUTING_DIR = path.join(".opencode", "sdd-model-routing");
const ATTESTATION_FILE = "attestation.json";
const MANIFEST_FILE = "manifest.json";
const LOCK_FILE = "generator.lock";
const JOURNAL_DIR = "journal";

export class AttestationExpiredError extends Error {
  readonly code = "ATTESTATION_EXPIRED";
  constructor() {
    super("ATTESTATION_EXPIRED: readiness attestation has expired");
    this.name = "AttestationExpiredError";
  }
}

export class AttestationMismatchError extends Error {
  readonly code = "ATTESTATION_MISMATCH";
  constructor(message: string) {
    super(`ATTESTATION_MISMATCH: ${message}`);
    this.name = "AttestationMismatchError";
  }
}

export interface ReadinessAttestation {
  readonly schemaVersion: 1;
  readonly verifierVersion: typeof READINESS_VERIFIER_VERSION;
  readonly openCodeVersion: string;
  readonly workspaceIdentity: string;
  readonly generationEpoch: string;
  readonly manifestHash: string;
  readonly fileHashes: ReadonlyArray<string>;
  readonly bootIdentity: string;
  readonly nonce: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly canaries: ReadonlyArray<CanaryEvidence>;
  readonly signature: string;
}

export interface ModelRouteReadinessOptions {
  readonly workspaceRoot: string;
  readonly now?: () => number;
  readonly nonce?: () => string;
  readonly signingKey: Buffer;
  readonly additionalConfigRoots?: readonly string[];
}

export class ReadinessSigningKeyMissingError extends Error {
  readonly code = "READINESS_SIGNING_KEY_MISSING";
  constructor() {
    super("READINESS_SIGNING_KEY_MISSING: explicit HMAC signing key is required (no random/default keys are accepted)");
    this.name = "ReadinessSigningKeyMissingError";
  }
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function unsigned(attestation: ReadinessAttestation): Omit<ReadinessAttestation, "signature"> {
  const { signature: _signature, ...body } = attestation;
  return body;
}

function manifestBody(manifest: Manifest): Omit<Manifest, "manifestHash"> {
  const { manifestHash: _manifestHash, ...body } = manifest;
  return body;
}

function sameArray(left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export class ModelRouteReadiness {
  private readonly root: string;
  private readonly routingDir: string;
  private readonly now: () => number;
  private readonly nonce: () => string;
  private readonly signingKey: Buffer;
  private readonly additionalConfigRoots: readonly string[];

  constructor(options: ModelRouteReadinessOptions) {
    this.root = path.resolve(options.workspaceRoot);
    this.routingDir = path.join(this.root, ROUTING_DIR);
    this.now = options.now ?? Date.now;
    this.nonce = options.nonce ?? (() => randomBytes(24).toString("hex"));
    if (!(options.signingKey instanceof Buffer) || options.signingKey.length === 0) {
      throw new ReadinessSigningKeyMissingError();
    }
    this.signingKey = options.signingKey;
    this.additionalConfigRoots = options.additionalConfigRoots ?? [];
  }

  issue(input: {
    manifest: Manifest;
    evidence: ReadonlyArray<CanaryEvidence>;
    openCodeVersion: string;
    bootIdentity: string;
    ttlMs: number;
  }): ReadinessAttestation {
    if (!isOpenCodeVersionSupported(input.openCodeVersion)) {
      throw new AttestationMismatchError(
        `unsupported OpenCode version ${input.openCodeVersion} (minimum ${REQUIRED_OPENCODE_VERSION} within major ${parseOpenCodeVersion(REQUIRED_OPENCODE_VERSION)?.major ?? "?"})`,
      );
    }
    if (input.ttlMs <= 0 || !Number.isSafeInteger(input.ttlMs)) {
      throw new AttestationMismatchError("ttlMs must be a positive safe integer");
    }
    this.assertCurrentState(input.manifest, input.bootIdentity);
    if ((input.manifest.requiredOpenCodeVersion ?? "") !== REQUIRED_OPENCODE_VERSION) {
      throw new AttestationMismatchError(
        `manifest requiredOpenCodeVersion=${input.manifest.requiredOpenCodeVersion ?? "<missing>"} does not match runtime contract ${REQUIRED_OPENCODE_VERSION}`,
      );
    }
    if (input.evidence.length !== input.manifest.routes.length) {
      throw new AttestationMismatchError("canary evidence does not cover every manifest route");
    }
    const expectedHosts = [...input.manifest.routes.map((route) => route.hostName)].sort();
    const attestedHosts = [...input.evidence.map((item) => item.hostName)].sort();
    if (!sameArray(expectedHosts, attestedHosts)) {
      throw new AttestationMismatchError("canary host coverage differs from manifest");
    }
    const issuedAt = this.now();
    const body: Omit<ReadinessAttestation, "signature"> = {
      schemaVersion: 1,
      verifierVersion: READINESS_VERIFIER_VERSION,
      openCodeVersion: input.openCodeVersion,
      workspaceIdentity: input.manifest.workspaceIdentity,
      generationEpoch: input.manifest.generationEpoch,
      manifestHash: input.manifest.manifestHash,
      fileHashes: [...input.manifest.fileHashes].sort(),
      bootIdentity: input.bootIdentity,
      nonce: this.nonce(),
      issuedAt,
      expiresAt: issuedAt + input.ttlMs,
      canaries: [...input.evidence],
    };
    const attestation: ReadinessAttestation = { ...body, signature: this.sign(body) };
    this.atomicPersist(attestation);
    return attestation;
  }

  verify(input: { manifest: Manifest; openCodeVersion: string; bootIdentity: string }): ReadinessAttestation {
    this.assertCurrentState(input.manifest, input.bootIdentity);
    if ((input.manifest.requiredOpenCodeVersion ?? "") !== REQUIRED_OPENCODE_VERSION) {
      throw new AttestationMismatchError(
        `manifest requiredOpenCodeVersion=${input.manifest.requiredOpenCodeVersion ?? "<missing>"} does not match runtime contract ${REQUIRED_OPENCODE_VERSION}`,
      );
    }
    const attestation = this.read();
    if (this.now() > attestation.expiresAt) throw new AttestationExpiredError();
    // Runtime contract is a MINIMUM, not an exact pin: the attestation stays
    // valid across patch/minor updates within the same major. A major drift
    // between the emitting runtime and the verifying runtime is still fail
    // closed (the plugin's SDK surface is only audited inside one major).
    if (!isOpenCodeVersionSupported(input.openCodeVersion)) {
      throw new AttestationMismatchError(`OpenCode version not supported: ${input.openCodeVersion}`);
    }
    if (!isOpenCodeVersionSupported(attestation.openCodeVersion)) {
      throw new AttestationMismatchError(`attestation was issued for an unsupported OpenCode version ${attestation.openCodeVersion}`);
    }
    const attested = parseOpenCodeVersion(attestation.openCodeVersion);
    const runtime = parseOpenCodeVersion(input.openCodeVersion);
    if (attested !== null && runtime !== null && (attested.major !== runtime.major || attested.minor !== runtime.minor)) {
      throw new AttestationMismatchError(
        `OpenCode version drifted beyond patch: attestation ${attestation.openCodeVersion}, runtime ${input.openCodeVersion}`,
      );
    }
    if (attestation.bootIdentity !== input.bootIdentity) throw new AttestationMismatchError("boot identity changed");
    if (attestation.workspaceIdentity !== input.manifest.workspaceIdentity) throw new AttestationMismatchError("workspace identity changed");
    if (attestation.generationEpoch !== input.manifest.generationEpoch) throw new AttestationMismatchError("generation epoch changed");
    if (attestation.manifestHash !== input.manifest.manifestHash) throw new AttestationMismatchError("manifest hash changed");
    if (!sameArray(attestation.fileHashes, [...input.manifest.fileHashes].sort())) throw new AttestationMismatchError("file hash set changed");
    if (attestation.verifierVersion !== READINESS_VERIFIER_VERSION) throw new AttestationMismatchError("verifier version changed");
    if (attestation.signature !== this.sign(unsigned(attestation))) throw new AttestationMismatchError("invalid attestation signature");
    return attestation;
  }

  private assertCurrentState(manifest: Manifest, expectedBootIdentity?: string): void {
    if (manifest.workspaceIdentity !== this.root) throw new AttestationMismatchError("manifest workspace identity differs from canonical workspace");
    if (manifest.manifestHash !== sha256(JSON.stringify(manifestBody(manifest)))) throw new AttestationMismatchError("manifest digest is invalid");
    const diskManifest = JSON.parse(readFileSync(path.join(this.routingDir, MANIFEST_FILE), "utf8")) as Manifest;
    if (diskManifest.manifestHash !== manifest.manifestHash) throw new AttestationMismatchError("on-disk manifest changed");
    const lockPath = path.join(this.routingDir, LOCK_FILE);
    if (existsSync(lockPath)) {
      let lockBoot = "";
      try {
        const lock = JSON.parse(readFileSync(lockPath, "utf8")) as { bootIdentity?: unknown };
        lockBoot = typeof lock.bootIdentity === "string" ? lock.bootIdentity : "";
      } catch { /* malformed locks remain a mismatch */ }
      if (lockBoot !== expectedBootIdentity) throw new AttestationMismatchError("generator lock belongs to another boot");
    }
    const journal = path.join(this.routingDir, JOURNAL_DIR);
    if (existsSync(journal) && readdirSync(journal).length > 0) throw new AttestationMismatchError("generator journal is not empty");
    const actualHashes = manifest.routes.flatMap((route) => [route.agentFile, route.commandFile]).map((entry) => {
      const absolute = path.resolve(this.root, entry.relativePath);
      if (!absolute.startsWith(this.root + path.sep)) throw new AttestationMismatchError("owned path escapes workspace");
      const stat = lstatSync(absolute);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new AttestationMismatchError(`owned path is not a regular file: ${entry.relativePath}`);
      const digest = sha256(readFileSync(absolute));
      if (digest !== entry.sha256) throw new AttestationMismatchError(`owned file hash changed: ${entry.relativePath}`);
      return digest;
    }).sort();
    if (!sameArray(actualHashes, [...manifest.fileHashes].sort())) throw new AttestationMismatchError("manifest file hash list is invalid");

    const sources = resolveForeignAgentSources({
       workspaceRoot: this.root,
       additionalConfigRoots: this.additionalConfigRoots
    });
    assertNoForeignAgentDefinitions({
       workspaceRoot: this.root,
       sources,
       ownedAgentFiles: manifest.routes.map(r => ({
          relativePath: r.agentFile.relativePath,
          sha256: r.agentFile.sha256
       })),
       reservedPrefix: ROUTED_HOST_NAME_PREFIX
    });
  }

  private sign(body: Omit<ReadinessAttestation, "signature">): string {
    return createHmac("sha256", this.signingKey).update(JSON.stringify(body)).digest("hex");
  }

  private read(): ReadinessAttestation {
    try {
      return JSON.parse(readFileSync(path.join(this.routingDir, ATTESTATION_FILE), "utf8")) as ReadinessAttestation;
    } catch (error) {
      throw new AttestationMismatchError(`attestation unavailable: ${(error as Error).message}`);
    }
  }

  private atomicPersist(attestation: ReadinessAttestation): void {
    mkdirSync(this.routingDir, { recursive: true });
    const finalPath = path.join(this.routingDir, ATTESTATION_FILE);
    const temporary = path.join(this.routingDir, `.${ATTESTATION_FILE}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
    try {
      writeFileSync(temporary, JSON.stringify(attestation, null, 2), { encoding: "utf8", mode: 0o600, flag: "wx" });
      const file = openSync(temporary, "r");
      try {
        try { fsyncSync(file); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
        }
      } finally { closeSync(file); }
      renameSync(temporary, finalPath);
      applyCurrentUserAcl(finalPath);
      const directory = openSync(this.routingDir, "r");
      try {
        try { fsyncSync(directory); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
        }
      } finally { closeSync(directory); }
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  }
}

// applyCurrentUserAcl lives in src/infrastructure/runtime/windows-acl.ts
// (WU4 remediation D2: single source of truth, AclRestrictionError
// instead of the previous misleading AttestationMismatchError label).
