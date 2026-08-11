# Model Control Center TUI Specification

## Purpose

Define the delivered TUI for model discovery, durable metadata editing, and quarantine control.

## Requirements

### Requirement: Native dialog entry and lifecycle

The plugin MUST bind `model-control-center.open` to base-layer `alt+shift+m`, MUST open a host-native dialog, and MUST NOT bind legacy `ctrl+alt+f`. Dialog and shutdown cleanup MUST be idempotent.

#### Scenario: Open and close
- GIVEN the TUI plugin is initialized
- WHEN `alt+shift+m` is invoked and the dialog closes
- THEN the control center MUST render and dispose its instance once

### Requirement: Catalog browsing and navigation

The TUI MUST offer Models and Quarantines, connected-provider and model lists, cyclic selection, stack-based Escape/Back, and `/` search over the read-only catalog.

#### Scenario: Browse model details
- GIVEN connected catalog entries exist
- WHEN the user selects Models, a provider, and a model
- THEN detail MUST open on Overview for that model

#### Scenario: Escape active search
- GIVEN model search is active
- WHEN Escape is pressed
- THEN search MUST stop before leaving the list

### Requirement: Editable validated details

Detail MUST expose Overview, Benchmarks, Pricing, and Subscription tabs, retain a draft, validate editable fields, and route `Ctrl+S` through durable save.

#### Scenario: Submit valid draft
- GIVEN a changed draft is valid
- WHEN `Ctrl+S` is invoked
- THEN the complete draft and expected envelope hash MUST be submitted

#### Scenario: Reject invalid draft
- GIVEN a benchmark is absent or an editable value is invalid
- WHEN save is requested
- THEN save MUST fail with a validation error

### Requirement: Durable verified save

Save MUST transactionally persist versioned metadata, enforce envelope-hash optimistic concurrency, and record pricing history. It MUST read back committed state; only a matching readback MAY publish to the process-wide model-config registry.

#### Scenario: Verified save applies live
- GIVEN the expected hash is current
- WHEN persistence and readback match
- THEN save MUST report verified and interception MUST observe the configuration

#### Scenario: Readback disagrees
- GIVEN commit succeeds but readback is absent or mismatched
- WHEN verification completes
- THEN committed-unverified guidance MUST be returned and publication MUST NOT occur

#### Scenario: Stale writer
- GIVEN another save changed the envelope
- WHEN the stale draft saves
- THEN it MUST fail without overwriting newer state

### Requirement: Quarantine management and enforcement

The system MUST list, set, and release permanent or positive-TTL quarantines at provider, model, and model-provider levels. Active precedence MUST be provider, model, then model-provider. TTL MUST be inactive at exact expiry. A matching active quarantine MUST block task invocation.

#### Scenario: Highest-precedence match blocks
- GIVEN overlapping active quarantines match a request
- WHEN interception evaluates it
- THEN the highest-precedence quarantine MUST block invocation

#### Scenario: Release or expiry
- GIVEN quarantine is released or reaches expiry
- WHEN interception runs again
- THEN it MUST be inactive, and release MUST clear stored type and expiry

#### Scenario: Invalid quarantine
- GIVEN its target/reason is empty or TTL is invalid
- WHEN creation is requested
- THEN it MUST be rejected without persistence

### Requirement: Durable read-through recovery

SQLite MUST remain authoritative. Missing global registries MUST be recreated and hydrated during interception. Persistence initialization failures MUST be shown as unavailable, never replaced by a clean in-memory baseline.

#### Scenario: Registry loss
- GIVEN persisted state exists but a global registry is absent
- WHEN interception runs
- THEN current database state MUST be hydrated before deciding

### Requirement: Distribution and release safety

Builds MUST expose root and `./tui` entries. CI MUST run build, Node tests, strict typecheck, exports, Bun/OpenTUI rendering, and release-safety checks. Forbidden database, generated, dependency, environment, or build artifacts MUST NOT be staged.

#### Scenario: Forbidden staged artifact
- GIVEN a forbidden artifact is staged
- WHEN release-safety verification runs
- THEN it MUST exit non-zero
