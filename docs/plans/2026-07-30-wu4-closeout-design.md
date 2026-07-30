# WU4 Closeout Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Close the WU4 remediation record and verify the security/failure-mode implementation without changing unrelated behavior.

**Architecture:** Keep the existing WU4 implementation and shared ACL/fixture extraction. Correct the project tracking documents to reflect the measured files and tests. Treat the full-suite build issue as a sequencing/environment diagnostic and only change code if a minimal reproducible regression proves a repository defect.

**Tech Stack:** TypeScript, tsx, npm scripts, tsup, Prisma SQLite test harness, Markdown project tracking.

---

### Task 1: Reconcile WU4 tracking

**Files:** `sdd/natural-model-routing/tasks.md`, `sdd/natural-model-routing/apply-progress.md`

Update WU4 counts, remediation items, test evidence, and known full-suite verification status. Preserve WU5 as deferred.

### Task 2: Verify chained build behavior

**Files:** `package.json`, `test-verification.ts` only if a repository-level cause is proven

Run the failing sequence, inspect process/cwd/path state, and avoid changing production behavior for a sandbox-only transient failure.

### Task 3: Final verification

Run the focused WU4 suite, model-route suite, strict typecheck, build, and full `npm test`. Report exact exit status and any environmental limitation.
