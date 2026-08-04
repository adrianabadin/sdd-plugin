# SDD Phase-Agents Remediation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the registered SDD MCP tools enforce a durable, atomic lifecycle and prove each corrective behavior under a new Strict-TDD attestation.

**Architecture:** Preserve the existing port/adapter boundary. First make SQLite checkpoint writes conditionally atomic; then add a small change-state persistence contract for discovery, locks, and fingerprints; finally make compose/save/status use that state through the registered tool definitions. A disposable SQLite integration harness proves live behavior rather than helper-only behavior.

**Tech Stack:** TypeScript, `node:sqlite`, OpenCode tool definitions, PMC/agent-memory port adapters, `tsx` tests.

---

## Rules

- Target only `feat/sdd-phase-agents` at `d10b292` plus this remediation.
- Do not modify the listed model-routing dirty files, `.codex/config.toml`, or unrelated user files.
- Do not claim historical TDD evidence for the 131 original tasks. Create an apply-progress artifact that records this fact and captures only the new corrective cycles.
- For every task below: RED first, then minimal GREEN implementation, then a distinct triangulation case, then its safety-net command.

### Task 1: Make SQLite checkpoint writes atomic

**Files:**
- Modify: `src/infrastructure/pmc/sqlite-mcp-tool-client.adapter.ts:85-190`
- Modify: `tests/sqlite-mcp-tool-client.test.ts:67-113`
- Test: `tests/sdd-checkpoint-use-case.test.ts:403-460`

**Step 1: Write the failing two-client test**

Create two `SqliteMcpToolClient` instances over the same disposable database. Arrange both to write the same checkpoint with `expectedVersion: 0`; coordinate them so both begin before either commit. Assert exactly one returns a version and the other returns a conflict.

**Step 2: Run the RED test**

Run: `npx tsx tests/sqlite-mcp-tool-client.test.ts`

Expected: FAIL because both check-then-upsert paths currently succeed.

**Step 3: Implement one conditional write**

Replace the separate version check and unconditional upsert in `handleStore()` with one transaction or conditional update/insert. The mutation must only succeed when the stored version equals `expectedVersion`; a missing record is version `0`. Return a conflict without writing otherwise.

**Step 4: Run GREEN and triangulation**

Run:
```powershell
npx tsx tests/sqlite-mcp-tool-client.test.ts
npx tsx tests/sdd-checkpoint-use-case.test.ts
```

Add/retain a stale-existing-version test so the atomic implementation covers creation and update conflicts.

**Step 5: Record evidence**

Append RED/GREEN/triangulation/safety-net results for Task 1 to the new apply-progress artifact. Do not commit unless explicitly requested.

### Task 2: Persist change lifecycle state behind the artifact-store port

**Files:**
- Modify: `src/ports/sdd-artifact-store.port.ts:15-40`
- Modify: `src/infrastructure/pmc/pmc-sdd-artifact-store.adapter.ts:24-74`
- Modify: `src/infrastructure/pmc/sqlite-mcp-tool-client.adapter.ts:85-190`
- Modify: `tests/sdd-artifact-store.test.ts`
- Create: `tests/sdd-change-state.test.ts`

**Step 1: Write failing port-level lifecycle tests**

Define a minimal typed `SddChangeState` containing `projectRoot`, `changeName`, artifact index, optional in-flight phase, optional baseline fingerprint, and lock metadata. Test durable create/read, discovery enumeration, lock acquisition conflict, and lock visibility after a new adapter instance is created.

**Step 2: Run RED**

Run: `npx tsx tests/sdd-change-state.test.ts`

Expected: FAIL because the port has no state operations and the adapter cannot enumerate changes or retain locks.

**Step 3: Extend the port and adapters**

Add only these operations: enumerate state by project, read state by project/change, and compare-and-write state. Implement them as structured MCP-tool records using deterministic SDD keys. Keep private SQLite schema access contained in `SqliteMcpToolClient`; application code must only use the port.

**Step 4: Run GREEN and triangulation**

Run:
```powershell
npx tsx tests/sdd-change-state.test.ts
npx tsx tests/sdd-artifact-store.test.ts
npx tsx tests/sdd-discovery-status.test.ts
```

Add a second-adapter readback case and a stale state-version conflict case.

**Step 5: Record evidence**

Append the complete Strict-TDD cycle for Task 2 to the apply-progress artifact.

### Task 3: Wire durable status, lock, and fingerprint lifecycle through tools

**Files:**
- Modify: `src/bootstrap/sdd-tools.ts:44-293`
- Modify: `src/application/sdd/save-artifact.ts:24-61`
- Modify: `src/application/sdd/compute-status.ts:48-153`
- Modify: `src/application/sdd/compute-discovery-status.ts:14-35`
- Modify: `src/application/sdd/worktree-fingerprint.ts:12-103`
- Modify: `tests/sdd-worktree-fingerprint.test.ts`
- Modify: `tests/sdd-status-schema.test.ts`
- Create: `tests/sdd-tools.integration.test.ts`

**Step 1: Write failing real-tool scenarios**

Build the actual `buildSddTools()` definitions with a disposable adapter. Add failing cases for:

- `sdd_status` without a selected change returns discovery data.
- Compose persists a lock and baseline fingerprint; a concurrent compose for the same change is rejected.
- Status after a second process instance reports the persisted in-flight phase.
- Save recaptures the fingerprint before writing; changed or failed Git probes reject and retain the lock.
- A successful save persists the artifact, makes it discoverable/readable, and then clears the lock.

**Step 2: Run RED**

Run: `npx tsx tests/sdd-tools.integration.test.ts`

Expected: FAIL because current tool definitions accept caller-held state and never capture or persist fingerprints.

**Step 3: Implement minimal tool wiring**

Change tool input schemas to require project/change identity, not caller-supplied locks, fingerprints, upstream artifacts, or in-flight phase. In compose, load state/artifacts, acquire a durable lock, capture and save the baseline fingerprint, then compose. In save, recapture and compare before persistence; clear the lock only after write/readback success. In status, load persisted state or return discovery status when no change is named.

**Step 4: Run GREEN and triangulation**

Run:
```powershell
npx tsx tests/sdd-tools.integration.test.ts
npx tsx tests/sdd-worktree-fingerprint.test.ts
npx tsx tests/sdd-status-schema.test.ts
npx tsx tests/sdd-dispatch-lock.test.ts
```

Triangulate with an injected Git probe failure and an artifact-write failure; both must preserve the lock and report a blocked state.

**Step 5: Record evidence**

Append Task 3 evidence with each exact command/result.

### Task 4: Integrate checkpoint operations and bootstrap surface

**Files:**
- Modify: `src/bootstrap/index.ts:228-246`
- Modify: `src/bootstrap/sdd-tools.ts:225-282`
- Modify: `tests/sdd-tools.integration.test.ts`
- Modify: `tests/sdd-executor-contract.test.ts`

**Step 1: Write failing bootstrap-surface test**

Instantiate the bootstrap wiring with disposable persistence and assert all seven tools are registered. Invoke checkpoint writes through the actual definition from two independently constructed clients and assert one conflict. Assert the tool map remains absent only when persistence initialization fails.

**Step 2: Run RED**

Run: `npx tsx tests/sdd-tools.integration.test.ts`

Expected: FAIL because there is currently no test of the bootstrap tool map or its live dependencies.

**Step 3: Implement only required dependency injection**

Expose the smallest bootstrap factory seams needed to construct disposable persistence and fingerprint/skill services in tests. Do not change unrelated OpenCode setup behavior.

**Step 4: Run GREEN and safety net**

Run:
```powershell
npx tsx tests/sdd-tools.integration.test.ts
npx tsx tests/sqlite-mcp-tool-client.test.ts
npm run test:typecheck:strict
npm run test:persistence
npm run build
```

Then run all 14 `tests/sdd-*.test.ts` suites individually and record every result.

**Step 5: Write the corrective TDD attestation**

Create `docs/superpowers/specs/2026-08-03-sdd-phase-agents-remediation-APPLY.md`. State that the original 131 historical cycles are unavailable. Include, for Tasks 1-4, exact RED failure, GREEN command, triangulation, safety-net output, changed files, and known excluded model-route failure.

### Task 5: Fresh verification

**Files:**
- Create: a new dated verification report under `docs/superpowers/specs/`
- Review: `docs/superpowers/specs/2026-08-03-sdd-phase-agents-remediation-APPLY.md`

**Step 1: Run an independent `sdd-verify`**

Verify the final commit from a fresh context. Treat all older verify reports as historical only.

**Step 2: Require runtime evidence**

The verifier must run strict typecheck, persistence, build, all 14 SDD suites, direct SQLite concurrency tests, and registered-tool integration tests. It must separately document but exclude the known `model-route-cli.test.ts` environment failure.

**Step 3: Archive gate**

Archive only on PASS. A failure in a durable lock, fingerprint, atomic checkpoint, or new TDD evidence remains a blocker.
