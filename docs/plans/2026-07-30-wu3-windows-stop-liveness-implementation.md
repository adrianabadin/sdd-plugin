# WU3 Windows Stop Liveness Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make cross-process WU3 shutdown reliably signal a live Windows supervisor regardless of lock age and clean every control artifact only when supervisor absence is confirmed.

**Architecture:** Extract stop coordination from the executable CLI into a small runtime module with injected record/process operations for deterministic tests. Record reads distinguish absent (`ENOENT`), malformed/invalid content, and operational failures (`EACCES`, `EIO`). A valid lock wins without reading lower-priority control; otherwise control is the fallback. The module probes a resolved PID with signal `0` and sends `SIGTERM` when alive. It removes attestation, lock, and control records only when no valid PID exists or `ESRCH` confirms process absence. Operational record errors, `EPERM`, and every other non-`ESRCH` process error retain all artifacts and fail closed so a second supervisor cannot start.

**Tech Stack:** TypeScript, Node.js `fs` and `process.kill`, `tsx`, `node:assert/strict`.

---

### Task 1: Add Cross-Process Stop Regression Tests

**Files:**
- Create: `tests/model-route-boot-control.test.ts`
- Create later: `src/infrastructure/runtime/model-route-boot-control.ts`

**Step 1: Write the failing test**

Cover five behaviors with real temporary files and injected process operations:

1. An old lock whose PID is alive is probed and receives `SIGTERM`; files remain for supervisor-owned cleanup.
2. An `ESRCH` probe removes `attestation.json`, `generator.lock`, and `boot-control.json`.
3. An `ESRCH` from `SIGTERM` after a successful probe performs the same cleanup.
4. `EPERM` from either probe or `SIGTERM` retains all artifacts and returns a structured failure.
5. Unknown non-`ESRCH` operational errors also retain all artifacts and fail closed.
6. Lock `EACCES` and fallback-control `EIO` retain every artifact and return a structured read failure.

**Step 2: Run the test to verify RED**

Run: `npx tsx tests/model-route-boot-control.test.ts`

Expected: FAIL because `model-route-boot-control.ts` does not exist.

### Task 2: Implement the Stop Coordinator

**Files:**
- Create: `src/infrastructure/runtime/model-route-boot-control.ts`
- Test: `tests/model-route-boot-control.test.ts`

**Step 1: Implement the minimal API**

Export `stopModelRouteSupervisor(options)` with filesystem paths, `currentPid`, and injectable `readRecord`/`probeProcess`/`signalProcess` callbacks. Resolve the PID from lock first and control record second. Treat malformed/invalid records as unusable fallback candidates, but retain state on operational read failures. Never use lock age as liveness evidence.

**Step 2: Implement conservative deterministic cleanup**

When there is no valid PID, or probe/signaling returns `ESRCH`, remove attestation, lock, and control paths with force semantics and return a structured `cleaned` result. For `EPERM` or any other non-`ESRCH` error, retain every artifact and return a structured `stop-failed` result with the operation, PID, error code, and message.

**Step 3: Run the focused test to verify GREEN**

Run: `npx tsx tests/model-route-boot-control.test.ts`

Expected: all stop-control assertions pass.

### Task 3: Wire the CLI to the Coordinator

**Files:**
- Modify: `src/cli/model-route-boot.ts`
- Test: `tests/model-route-boot-control.test.ts`

**Step 1: Replace local stop logic**

Import `stopModelRouteSupervisor`, add `boot-control.json` to the CLI path set, and delegate the `stop` subcommand. Preserve successful output and make structured stop/cleanup failures actionable on stderr with a non-zero exit code.

**Step 2: Remove obsolete helpers**

Delete the CLI-local lock parser and age-based Windows liveness heuristic.

**Step 3: Re-run the focused test**

Run: `npx tsx tests/model-route-boot-control.test.ts`

Expected: PASS.

### Task 4: Verify WU3 and Regression Gates

**Files:**
- Verify only; no additional source changes expected.

**Step 1: Run focused WU3 tests**

Run: `npx tsx tests/model-route-boot-control.test.ts`

Run: `npx tsx tests/windows-boot-manager.test.ts`

**Step 2: Run model-route regression suite**

Run: `npm run test:model-routes`

**Step 3: Run typecheck and build**

Run: `npm run test:typecheck:strict`

Run: `npm run build`

**Step 4: Inspect final diff**

Run: `git diff --check`

Expected: every command exits 0. No commit is created unless explicitly requested.
