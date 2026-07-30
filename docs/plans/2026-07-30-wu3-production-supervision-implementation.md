# WU3 Production Supervision Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement the complete fail-closed WU3 supervisor and close all nine production gaps from the authoritative review.

**Architecture:** The boot manager owns serve/attach processes, ephemeral secrets, lock/readiness lifecycle, catalog synchronization, canary validation, and cross-process controls. `ModelRouteReadiness` is the sole attestation authority; the CLI composes it and reports the persisted lifecycle state.

**Tech Stack:** TypeScript, Node child processes, OpenCode 1.18.9 HTTP contract, Vitest/tsx, Windows PowerShell/ACLs.

---

### Task 1: Establish RED coverage for the nine gaps

**Files:** `tests/windows-boot-manager.test.ts`, `tests/model-route-canary-readiness.test.ts`, `tests/model-route-cli.test.ts`

Add deterministic tests for serve health/version, stale state, lock lifetime/recovery, mandatory catalog sync, parent read-back, secret scrubbing/non-persistence, TTL/renewal, teardown, status/stop, ACL intent, and cleanup on sync/read-manifest failures. Run the focused suites and record the expected failures.

### Task 2: Harden readiness persistence and lifecycle

**Files:** `src/infrastructure/opencode/model-route-readiness.ts`, `src/infrastructure/runtime/windows-model-route-boot-manager.ts`

Make issue/verify enforce manifest version, journal emptiness, exact canary coverage, nonce, expiry, file hashes, and lock state. Add stale-lock recovery, explicit lock ownership, renewal, atomic cleanup, Windows SID ACL application, and guaranteed secret zeroization/restoration on all error paths.

### Task 3: Implement serve supervision and mandatory catalog sync

**Files:** `src/infrastructure/runtime/windows-model-route-boot-manager.ts`, `src/cli/model-route-boot.ts`

Spawn `opencode serve` with boot identity and key in an isolated child environment, poll health and exact required version, bind the SDK method correctly where applicable, and invoke `SyncConnectedModelsUseCase` before every route read-back. Fail closed on any uncaught catalog or manifest error.

### Task 4: Implement attach, cross-process controls, and cleanup

**Files:** `src/infrastructure/runtime/windows-model-route-boot-manager.ts`, `src/cli/model-route-boot.ts`

Spawn attach with every `SDD_MODEL_ROUTING_*` variable removed, persist only safe PID/control metadata, implement real status/stop against that metadata, stop attach before serve, remove readiness and lock, and handle SIGINT/SIGTERM without leaving child processes or stale state.

### Task 5: Complete canary contract and composition wiring

**Files:** `src/infrastructure/opencode/model-route-canary.ts`, `src/cli/model-route-boot.ts`, related tests

Perform the parent session GET read-back and exact model equality check before issuing commands; wire the production catalog sync and readiness verifier into the CLI composition root; reject synthetic or incomplete evidence.

### Task 6: Verify and update project artifacts

Run focused WU3 tests, strict typecheck, build, and the full test suite. Update `sdd/natural-model-routing/tasks.md` and `apply-progress.md` with evidence, run `pmc refresh-context --enrich` when available, and record the resolved review state in PMC/Engram.
