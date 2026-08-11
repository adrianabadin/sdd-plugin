import { readFileSync, rmSync } from "node:fs";
import process from "node:process";

interface SupervisorRecord {
  readonly pid: number;
  readonly bootIdentity: string;
}

type RecordReadResult =
  | { readonly status: "valid"; readonly record: SupervisorRecord }
  | { readonly status: "unusable" }
  | { readonly status: "failed"; readonly error: unknown };

export interface StopModelRouteSupervisorOptions {
  readonly attestationPath: string;
  readonly lockPath: string;
  readonly controlPath: string;
  /** Optional persisted handshake artifact; cleaned alongside the others when provided. */
  readonly handshakePath?: string;
  readonly currentPid?: number;
  readonly probeProcess?: (pid: number) => void;
  readonly signalProcess?: (pid: number, signal: NodeJS.Signals) => void;
  readonly removeArtifact?: (artifactPath: string) => void;
  readonly readRecord?: (recordPath: string) => string;
}

export type StopModelRouteSupervisorResult =
  | { readonly status: "signaled"; readonly pid: number; readonly bootIdentity: string }
  | {
      readonly status: "cleaned";
      readonly pid: number | null;
      readonly bootIdentity: string;
      readonly signalError?: string;
    }
  | {
      readonly status: "cleanup-failed";
      readonly pid: number | null;
      readonly bootIdentity: string;
      readonly remainingPaths: ReadonlyArray<string>;
      readonly cleanupErrors: ReadonlyArray<string>;
      readonly signalError?: string;
    }
  | {
      readonly status: "stop-failed";
      readonly operation: "read-lock" | "read-control" | "probe" | "signal";
      readonly pid: number | null;
      readonly bootIdentity: string;
      readonly errorCode: string | null;
      readonly errorMessage: string;
    };

export function stopModelRouteSupervisor(
  options: StopModelRouteSupervisorOptions,
): StopModelRouteSupervisorResult {
  const currentPid = options.currentPid ?? process.pid;
  const readRecord = options.readRecord ?? ((recordPath: string) => readFileSync(recordPath, "utf8"));
  const lockResult = readSupervisorRecord(options.lockPath, currentPid, readRecord);
  if (lockResult.status === "failed") return stopFailure("read-lock", null, lockResult.error);

  let record: SupervisorRecord | null = lockResult.status === "valid" ? lockResult.record : null;
  if (record === null) {
    const controlResult = readSupervisorRecord(options.controlPath, currentPid, readRecord);
    if (controlResult.status === "failed") return stopFailure("read-control", null, controlResult.error);
    if (controlResult.status === "valid") record = controlResult.record;
  }
  const probeProcess = options.probeProcess ?? ((pid: number) => { process.kill(pid, 0); });
  const signalProcess = options.signalProcess
    ?? ((pid: number, signal: NodeJS.Signals) => { process.kill(pid, signal); });

  if (record !== null) {
    try {
      probeProcess(record.pid);
    } catch (error) {
      if (isProcessAbsent(error)) return cleanArtifacts(options, record);
      return stopFailure("probe", record, error);
    }

    try {
      signalProcess(record.pid, "SIGTERM");
      return { status: "signaled", pid: record.pid, bootIdentity: record.bootIdentity };
    } catch (error) {
      if (isProcessAbsent(error)) return cleanArtifacts(options, record, errorMessage(error));
      return stopFailure("signal", record, error);
    }
  }

  return cleanArtifacts(options, null);
}

function readSupervisorRecord(
  recordPath: string,
  currentPid: number,
  readRecord: (recordPath: string) => string,
): RecordReadResult {
  let raw: string;
  try {
    raw = readRecord(recordPath);
  } catch (error) {
    return errorCode(error) === "ENOENT" ? { status: "unusable" } : { status: "failed", error };
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const pid = parsed["pid"];
    if (!Number.isInteger(pid) || (pid as number) <= 0 || pid === currentPid) return { status: "unusable" };
    return {
      status: "valid",
      record: {
        pid: pid as number,
        bootIdentity: typeof parsed["bootIdentity"] === "string" ? parsed["bootIdentity"] : "",
      },
    };
  } catch {
    return { status: "unusable" };
  }
}

function cleanArtifacts(
  options: StopModelRouteSupervisorOptions,
  record: SupervisorRecord | null,
  signalError?: string,
): StopModelRouteSupervisorResult {
  const removeArtifact = options.removeArtifact
    ?? ((artifactPath: string) => { rmSync(artifactPath, { force: true }); });
  const remainingPaths: string[] = [];
  const cleanupErrors: string[] = [];
  const artifactPaths = [options.attestationPath, options.lockPath, options.controlPath];
  if (options.handshakePath !== undefined) artifactPaths.push(options.handshakePath);
  for (const artifactPath of artifactPaths) {
    try {
      removeArtifact(artifactPath);
    } catch (error) {
      remainingPaths.push(artifactPath);
      cleanupErrors.push(`${artifactPath}: ${errorMessage(error)}`);
    }
  }
  if (remainingPaths.length > 0) {
    return {
      status: "cleanup-failed",
      pid: record?.pid ?? null,
      bootIdentity: record?.bootIdentity ?? "",
      remainingPaths,
      cleanupErrors,
      ...(signalError === undefined ? {} : { signalError }),
    };
  }
  return {
    status: "cleaned",
    pid: record?.pid ?? null,
    bootIdentity: record?.bootIdentity ?? "",
    ...(signalError === undefined ? {} : { signalError }),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  return typeof error.code === "string" ? error.code : null;
}

function isProcessAbsent(error: unknown): boolean {
  return errorCode(error) === "ESRCH";
}

function stopFailure(
  operation: "read-lock" | "read-control" | "probe" | "signal",
  record: SupervisorRecord | null,
  error: unknown,
): StopModelRouteSupervisorResult {
  return {
    status: "stop-failed",
    operation,
    pid: record?.pid ?? null,
    bootIdentity: record?.bootIdentity ?? "",
    errorCode: errorCode(error),
    errorMessage: errorMessage(error),
  };
}
