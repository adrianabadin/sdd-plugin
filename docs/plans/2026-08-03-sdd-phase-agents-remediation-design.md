# SDD Phase-Agents Remediation Design

## Context

Fresh verification at `d10b292` found that the seven SDD MCP tools exist but
do not yet implement the durable lifecycle required by the phase. Existing
helper tests and build gates pass, but persistence, locking, fingerprinting,
and checkpoint concurrency are not wired through the live tool boundary.

The historic RED/GREEN evidence for the 131 already-completed tasks is absent.
It must be reported as unavailable, not recreated or inferred. This design
requires a new Strict-TDD cycle only for the corrective work.

## Scope

This remediation closes these verified gaps:

- Persist and reconstruct SDD change state, artifacts, locks, and fingerprints
  through the configured agent-memory contract.
- Make checkpoint optimistic concurrency atomic in the production SQLite path.
- Connect worktree fingerprint capture and fail-closed comparison to the real
  compose and save operations.
- Make the seven registered tools exercise the durable lifecycle rather than
  accepting caller-supplied state.
- Add live integration coverage for registered tools and an explicit corrective
  TDD attestation.

Model-routing worktree changes and the known `model-route-cli.test.ts`
environmental failure are out of scope.

## Architecture

### Durable state boundary

Extend the SDD artifact-store port so tool handlers obtain change-scoped state
from a single persistence boundary. The port owns artifact readback, active
lock state, and stored fingerprints. Tool parameters identify a project and
change; they do not carry trusted locks, prior artifacts, or fingerprints.

The SQLite implementation remains an adapter behind that port. Its operations
must preserve the agent-memory MCP tool contract rather than exposing private
schema behavior to application code.

### Atomic checkpoints

Checkpoint writes use one conditional statement or one transaction that checks
the expected version and updates it atomically. A version mismatch returns a
conflict without changing the stored checkpoint. The implementation must be
tested with two independent clients interleaved at the read/write boundary.

### Tool lifecycle

- `sdd_status` discovers changes when no change is selected and reports the
  persisted in-flight phase when one exists.
- Compose acquires a durable change lock, reads the persisted artifacts and
  required skills, and captures the baseline fingerprint.
- Save recomputes the current fingerprint, rejects a changed or failed probe,
  persists the artifact, and clears the lock only after a successful write.
- Recovery/status reads the persisted lock so a crashed caller remains visible.

### Integration coverage

Add a disposable persistence-backed harness that calls the actual registered
tool definitions. It must cover discovery, concurrent lock rejection, process
recovery visibility, compose-to-save fingerprint verification, artifact
readback, and atomic checkpoint conflict behavior.

## Strict-TDD Evidence

Each corrective slice starts with a failing behavioral test, followed by a
passing implementation, triangulation against a distinct failure mode, and a
safety-net run. The resulting apply-progress artifact records commands and
results per slice. It explicitly distinguishes this new evidence from the
unavailable historical evidence for the previous 131 tasks.

## Delivery

Deliver as feature-branch-chain PRs, keeping each vertical contract slice
reviewable and independently tested:

1. Atomic checkpoint persistence.
2. Durable SDD state and lock lifecycle.
3. Live fingerprint and artifact lifecycle wiring.
4. Registered-tool integration harness and TDD attestation.

Each slice is verified before the next starts. A final fresh SDD verification
must pass before archiving.
