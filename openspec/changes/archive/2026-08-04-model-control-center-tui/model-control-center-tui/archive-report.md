# Archive Report — `model-control-center-tui`

**Artifact mode**: OpenSpec (native files)
**OpenSpec config**: `strict_tdd: true`, `delivery_strategy: auto-forecast`, `rules.archive: [warn before merging destructive deltas]`
**Archive date**: 2026-08-04 (ISO date)
**Change folder**: `openspec/changes/model-control-center-tui/`
**Archive folder**: `openspec/changes/archive/2026-08-04-model-control-center-tui/`
**Source-of-truth spec**: `openspec/specs/model-control-center-tui/spec.md` (new — does not pre-exist)
**PMC compact context**: requested; no structural entry for the change (no source-level symbols tagged with the change name).

## Status Snapshot (at archive time)

| Metric | Value |
|---|---|
| Verification verdict | **PASS** |
| CRITICAL / WARNING / SUGGESTION | None / None / None |
| Tasks total | 18 |
| Tasks checked | 18 |
| Tasks unchecked | 0 |
| Spec compliance (scenarios) | 13/13 compliant |
| TDD compliance checks | 6/6 passed |
| Gates green | `npm test`, `npm run build`, `npm run test:tui:bun`, `npm run verify:release-safety` |
| `application/octet-stream` blocks | 0 (delta is a full spec, no destructive merge) |

## Spec Sync Action

The change ships a **full spec** (it has no `## ADDED Requirements / ## MODIFIED Requirements / ## REMOVED Requirements / ## RENAMED Requirements` sections); the canonical source-of-truth spec at `openspec/specs/model-control-center-tui/spec.md` did **not** exist. The delta spec was therefore copied verbatim to the main spec directory.

| Domain | Action | Source | Destination | Bytes (SHA-256) |
|---|---|---|---|---|
| `model-control-center-tui` | Created (delta is a full spec) | `openspec/changes/model-control-center-tui/specs/model-control-center-tui/spec.md` | `openspec/specs/model-control-center-tui/spec.md` | `5419EB7EDE5F9B1E6FFC169306CC2916B5ACB6A5642841C6BFCD0CCC19471257` |

Hashes match between source and destination — byte-identical copy. No other main specs were touched; the unrelated `openspec/specs/foreign-agent-provenance-guard-spec.md` was left untouched.

## Archive Contents

```
openspec/changes/archive/2026-08-04-model-control-center-tui/
└── model-control-center-tui/        ← original change folder preserved
    ├── proposal.md
    ├── design.md
    ├── tasks.md                     (18/18 checked)
    ├── verify-report.md             (PASS)
    ├── apply-progress.md
    ├── task-2-design.md
    ├── task-3-design.md
    ├── task-4-design.md
    ├── task-5-design.md
    ├── task-6-design.md
    ├── task-7-design.md
    └── specs/
        └── model-control-center-tui/
            └── spec.md              (delta spec preserved for audit)
```

## Verification on Archive

- [x] Main spec updated correctly (`openspec/specs/model-control-center-tui/spec.md` written; SHA-256 equals delta spec).
- [x] Change folder moved to `openspec/changes/archive/2026-08-04-model-control-center-tui/`.
- [x] Archive contains all artifacts: proposal, specs, design, tasks, verify-report, apply-progress, six task design notes.
- [x] Archived `tasks.md` has 18/18 checked implementation tasks, zero unchecked.
- [x] Active `openspec/changes/` directory no longer contains `model-control-center-tui/` (only `archive/`).
- [x] No unrelated workspace changes modified. The pre-existing `openspec/specs/foreign-agent-provenance-guard-spec.md` and the `openspec/changes/archive/2026-07-31-foreign-agent-provenance-guard/` folder are untouched.

## Specs Synced (Source of Truth Reflects New Behavior)

| Domain | Path | Requirements |
|---|---|---|
| `model-control-center-tui` | `openspec/specs/model-control-center-tui/spec.md` | 7 (Native dialog entry/lifecycle; Catalog browsing/navigation; Editable validated details; Durable verified save; Quarantine management/enforcement; Durable read-through recovery; Distribution and release safety) — 13 scenarios total |

## SDD Cycle Complete

The change has been fully planned, implemented, verified, and archived. The next SDD cycle can begin by creating a new change via `sdd-new` or the orchestrator.

## Residual Risks

- **Pricing history growth (low, documented)**: each verified save appends a pricing row; pruning is not scheduled. Acceptable for archive; flagged in proposal question round item 5.
- **OpenCode host keymap collision (low, deferred)**: `alt+shift+m` is currently free; release-notes check per OpenCode upgrade is the mitigation. Flagged in proposal question round item 4.
- **Task 2 wording drift (cosmetic)**: an intermediate Task 2 design note described a route/mode scheme that was superseded by the canonical native-dialog implementation. The canonical `design.md` and `verify-report.md` (Design Coherence §) explicitly mark the Task 2 wording as superseded. No deviation in the delivered code — recorded for historical audit.
- **Coverage tooling (not configured)**: `coverage.available: false` in `openspec/config.yaml`; coverage analysis was skipped per `verify-report.md`. Not blocking for archive.
- **Allowed edit roots**: Executed archive operations were scoped to `openspec/`. No edits outside this root. The unrelated `openspec/specs/foreign-agent-provenance-guard-spec.md` and the `2026-07-31-foreign-agent-provenance-guard/` archive were not touched.
