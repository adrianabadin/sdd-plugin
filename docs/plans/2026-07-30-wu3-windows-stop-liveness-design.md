# WU3 Windows Stop Liveness Design

## Problem

The Windows `model-route-boot stop` path treats a lifecycle lock older than
30 seconds as dead without checking whether its supervisor PID is still alive.
A healthy long-running supervisor is therefore not signaled; only its disk
state is removed while the supervisor, `opencode serve`, and `attach` continue
running.

## Decision

Extract cross-process stop behavior into a small testable runtime module. The
module will:

1. Read the lifecycle lock and optional `boot-control.json` record. `ENOENT`
   means absent, while malformed or invalid content means no valid PID. An
   operational read error such as `EACCES` or `EIO` is indeterminate and must
   retain all artifacts.
2. Probe the supervisor PID with `process.kill(pid, 0)` on every platform.
3. Send `SIGTERM` when the PID is alive, regardless of lock age.
4. Remove attestation, lock, and control records only when no valid PID exists
   or process absence is confirmed by `ESRCH` during the probe or `SIGTERM`.
5. Retain every artifact and return a structured failure when probing or
   signaling fails with `EPERM` or any non-`ESRCH` operational error. An
   indeterminate process must be treated as potentially alive to prevent a
   second supervisor from starting.

The CLI remains a thin adapter that supplies filesystem paths and delegates to
the runtime module.

## Alternatives Rejected

- Exporting `runStop` directly from the CLI would require import-time main
  guards and would couple tests to the executable entrypoint.
- A real-process-only test would be slower and less deterministic on Windows
  CI. Real-host verification remains useful later, but it is not the smallest
  regression guard for this bug.

## Testing

Use strict RED-GREEN-REFACTOR:

- An old lock with a live PID must receive `SIGTERM` and retain control files
  until the supervisor performs its own shutdown.
- An `ESRCH` probe must remove attestation, lock, and control records.
- An `ESRCH` signaling race after a successful probe must perform the same
  complete cleanup.
- `EPERM` and unknown probe/signaling errors must retain all artifacts and
  return a structured failure.
- Lock `EACCES` and control `EIO` after an absent/invalid lock must retain all
  artifacts; a valid higher-priority lock does not require reading control.
- Existing WU3, model-route, typecheck, and build gates must remain green.

## Scope

This change fixes only cross-process stop/liveness and control-record cleanup.
It does not change serve/attach startup, canary semantics, catalog sync,
readiness signing, or WU4/WU5 behavior.
