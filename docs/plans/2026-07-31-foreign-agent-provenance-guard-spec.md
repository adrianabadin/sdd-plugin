# Foreign Agent Provenance Guard — Specification

Date: 2026-07-31
Status: Approved (design rev 3, gap-corrected)
Derives from: `docs/plans/2026-07-31-foreign-agent-provenance-guard-design.md` (rev 3)
Implemented by: `docs/plans/2026-07-31-foreign-agent-provenance-guard-implementation.md`

This document formalizes rev 3's guarantees as testable requirements. It adds
no new architecture; every REQ below traces to a design section. Task 0's
spike (design §7.0) may narrow REQ-7/REQ-8's scope — see the note there.

## Requirements

**REQ-1 (Filesystem provenance scan).** Before any fleet-descriptor write
and before any readiness `issue()`/`verify()`, the system MUST scan every
observable OpenCode configuration source (design §5) for a definition whose
name, case-insensitively, starts with the reserved prefix `sdd-mr-v1-`, and
MUST treat any such definition found outside the manifest's own allowlisted
files as a blocking finding. Source: design §5, §6.

**REQ-2 (Fail-closed on inspection failure).** Any source-inspection error
other than "source does not exist" (permission errors, unparseable JSON/
JSONC, unreadable Markdown frontmatter, symlink/junction/reparse-point
encountered) MUST be treated as a blocking finding, never silently skipped.
Source: design §6.3.

**REQ-3 (Generation gate).** `DiskAgentGenerator.generate()` MUST run the
provenance scan (REQ-1/REQ-2) after verifying previously-owned file hashes
and before the unconditional sweep, and MUST write no descriptor and commit
no manifest if the scan finds anything. The generator lock MUST still be
released. Source: design §8.1.

**REQ-4 (Readiness gate).** `ModelRouteReadiness.assertCurrentState()` MUST
run the same provenance scan, uncached, on every `issue()` and every
`verify()` call — including both boot-manager call sites
(`WindowsModelRouteBootManager.runStart()` and `.renewAttestation()`) and
both `ModelRouteTaskHook` call sites — and MUST block issuance/verification
on any finding. Source: design §8.2; gap-review A6 (boot-manager plumbing).

**REQ-5 (Dispatch gate ordering).** `ModelRouteTaskHook` MUST preserve this
exact gate order on both the explicit-grammar and natural-intent paths:
parse → resolve → quarantine → manifest membership → readiness (which
includes REQ-1..REQ-4) → merged-definition validation (REQ-7) → audit →
`subagent_type` rewrite. No provenance or merged-definition error may be
downgraded to `AttestationUnavailableError`; each MUST be audited and
rethrown with its own error class. Source: design §8.3.

**REQ-6 (Canonical generated-agent contract).** Exactly one shared module
MUST define the canonical routed-agent definition (description, `mode:
subagent`, `hidden: true`, `model`, `permission.task["*"]: deny`, exact
prompt) and MUST be the single source both the generator's descriptor writer
and the merged-config comparator (REQ-7) use — no duplicated literal
templates. Source: design §4.

**REQ-7 (Merged runtime-config validation — conditional on Task 0).**
`SddPlugin` MUST register a `config` hook that observes `cfg.agent` and
compares its reserved-prefixed entries against the manifest's canonical
definitions (REQ-6). The hook MUST NOT mutate `cfg`/`cfg.agent`, MUST NOT
generate agents, select routes, or issue readiness, and MUST NOT reject its
own promise on a mismatch (see REQ-8). The exact comparison scope (full
field-by-field vs. presence-only) is determined by Task 0's spike result
(design §7.0) and MUST be recorded before this requirement is implemented.
Source: design §7.

**REQ-8 (Config-hook failure semantics).** A mismatch or inspection failure
detected by the `config` hook MUST be recorded (not thrown) so the hook's
promise always resolves; the *next* `ModelRouteTaskHook.assertMatches()`
call at dispatch time MUST throw `RoutedAgentDefinitionMismatchError` (or
`ResolvedAgentConfigUnavailableError` if no observation exists yet) before
the `subagent_type` rewrite. Source: design §7/§9; gap-review A3.

**REQ-9 (Regression-test coexistence).** `tests/bootstrap-clean-startup.test.ts`
MUST be updated, not deleted or weakened beyond this scope: it MUST continue
asserting no reintroduction of the previously-rejected *routing* config hook
(the `obsoleteProductionFiles` list and the
`model-route-config-hook|disabled-not-ready|ModelRouteConfigUnsupportedError|OpenCodeConfig`
source-pattern check stay unchanged), while its hook-key assertion is
narrowed to permit exactly `["config", "tool.execute.before"]`. Source:
design §7.0; gap-review A1.

**REQ-10 (Error taxonomy).** The system MUST expose exactly these typed
errors, each `instanceof Error`, each with a stable `name`/`code`, and none
containing raw config bodies, prompts, or environment payloads:
`ForeignAgentDefinitionError` (`FOREIGN_AGENT_DEFINITION`),
`ForeignAgentInspectionError` (`FOREIGN_AGENT_INSPECTION`),
`RoutedAgentDefinitionMismatchError` (`ROUTED_AGENT_DEFINITION_MISMATCH`),
`ResolvedAgentConfigUnavailableError` (`RESOLVED_AGENT_CONFIG_UNAVAILABLE`).
Source: design §9.

**REQ-11 (CLI-selection barrier proof).** A real-host integration test MUST
prove `opencode run --agent <hostName>` refuses to select a routed host as a
primary agent, empirically grounding the `mode: subagent` claim in REQ-6.
Source: design §4/§11.4; gap-review A4.

**REQ-12 (Operator-extensible watched roots).** An env var
`SDD_MODEL_ROUTING_EXTRA_WATCHED_CONFIG_ROOTS` (path-delimiter-separated)
MUST extend the watched sources at every production call site listed in
REQ-4, not only at dispatch time. Source: design §5.3; gap-review A6.

**REQ-13 (Declared residual limitations, not silent gaps).** The following
MUST be explicitly documented as out of scope rather than silently unhandled:
platform-managed OpenCode config roots (no verified per-platform path set
exists in this repo — operators inject via `managedConfigFiles`/REQ-12
instead of a computed default); another plugin invoking a valid routed agent
or rewriting `subagent_type` after this plugin's hook; proving the origin of
a remote definition whose merged result is byte-identical to canonical; the
filesystem TOCTOU window between the last scan and OpenCode's child creation;
auto-remediation of any foreign file (never performed). Source: design §10.

## Out of scope

Everything design §10 and §2 mark out of scope remains out of scope here.
This spec does not authorize computing default platform-managed-config paths
without a verified source for them (see REQ-13).

## Acceptance criteria

- All REQ-1 through REQ-13 have at least one automated test per the
  implementation plan's task list (Tasks 0–10).
- `npm run test:model-routes`, `npm run test:typecheck:strict`, and
  `npm run build` pass with zero errors.
- `tests/bootstrap-clean-startup.test.ts` passes with the narrowed assertion
  (REQ-9) and its obsolete-routing-hook guards intact.
- `tests/model-route-real-host-canary.integration.ts` passes with the new
  `opencode run --agent` assertion (REQ-11).
- Task 0's spike notes file exists and states which REQ-7 branch applies
  before Task 6/8 are considered complete.
