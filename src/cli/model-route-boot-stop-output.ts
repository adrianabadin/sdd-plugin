import type { StopModelRouteSupervisorResult } from "../infrastructure/runtime/model-route-boot-control.js";

export interface ModelRouteStopOutput {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export function mapModelRouteStopResult(result: StopModelRouteSupervisorResult): ModelRouteStopOutput {
  if (result.status === "signaled") {
    return {
      code: 0,
      stdout: `boot: sent SIGTERM to pid=${result.pid} bootIdentity=${result.bootIdentity}\n`,
      stderr: "",
    };
  }
  if (result.status === "stop-failed") {
    return {
      code: 1,
      stdout: "",
      stderr:
        `boot: stop failed during ${result.operation} for pid=${result.pid}: ` +
        `${result.errorCode ?? "UNKNOWN"} ${result.errorMessage}; artifacts retained\n`,
    };
  }

  const signalError = result.signalError !== undefined && result.pid !== null
    ? `boot: failed to signal pid=${result.pid}: ${result.signalError}\n`
    : "";
  if (result.status === "cleanup-failed") {
    return {
      code: 1,
      stdout: "",
      stderr:
        signalError +
        `boot: cleanup failed; remaining paths: ${result.remainingPaths.join(", ")}; ` +
        `errors: ${result.cleanupErrors.join("; ")}\n`,
    };
  }
  return {
    code: 0,
    stdout: "boot: state=idle (cleaned stale attestation + lock)\n",
    stderr: signalError,
  };
}
