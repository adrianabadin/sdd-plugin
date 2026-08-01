# Foreign Agent Provenance Guard — Specification

Date: 2026-07-31
Status: Approved (design rev 3, gap-corrected; spec gap-review round 3 applied 2026-08-01)
Derives from: `docs/plans/2026-07-31-foreign-agent-provenance-guard-design.md` (rev 3)
Implemented by: `docs/plans/2026-07-31-foreign-agent-provenance-guard-implementation.md`
Canonical PMC record: `0ea11a80-4b99-4432-9d07-572b22fd05c7`
(`decision/foreign-agent-provenance-guard-spec-approved-2026-07-31`).

This document formalizes rev 3's guarantees as testable requirements. It adds
no new architecture; every REQ below traces to a design section. Task 0's
spike (design §7.0) may narrow the runtime-observation parts of
REQ-6/REQ-7/REQ-8 — see the note there.

## Requirements

**REQ-1 (Filesystem provenance scan).** Before any fleet-descriptor write
and before any readiness `issue()`/`verify()`, the system MUST scan every
observable OpenCode configuration source (design §5) for a definition whose
name, case-insensitively, starts with the reserved prefix `sdd-mr-v1-`, and
MUST treat any such definition found outside the manifest's own allowlisted
files as a blocking finding. Allowlist membership requires both the canonical
relative path and the recorded SHA-256; a same-path workspace file whose hash
no longer matches is the scanner's `owned-definition-mismatch` finding and is
likewise blocking. Ordered error precedence is part of the contract: generation
reports the existing `ModifiedOwnedFileError`; readiness `issue()`/`verify()`
reports the existing `AttestationMismatchError`; a standalone scanner
assertion reports `ForeignAgentDefinitionError` (design §9). Source: design
§5, §6, §9; gap-review B1, C1.

**REQ-2 (Fail-closed on inspection failure).** Any source-inspection error
other than "source does not exist" (permission errors, unparseable JSON/
JSONC, unreadable Markdown frontmatter, symlink/junction/reparse-point
encountered) MUST be treated as a blocking finding, never silently skipped.
Source: design §6.3.

**REQ-3 (Generation gate).** `DiskAgentGenerator.generate()` MUST run the
provenance scan (REQ-1/REQ-2) after verifying previously-owned file hashes
and before the unconditional sweep, and MUST write or delete no descriptor
and commit no manifest if the scan finds anything. The generator lock MUST
still be released. Source: design §8.1; gap-review B2.

**REQ-4 (Readiness gate).** `ModelRouteReadiness.assertCurrentState()` MUST
run the same provenance scan, uncached, on every `issue()` and every
`verify()` call — including both boot-manager call sites
(`WindowsModelRouteBootManager.runStart()` and `.renewAttestation()`) and
both `ModelRouteTaskHook` call sites — and MUST block issuance/verification
on any finding. Source: design §8.2; gap-review A6 (boot-manager plumbing).

**REQ-5 (Dispatch gate ordering).** `ModelRouteTaskHook` MUST preserve this
exact gate order on both the explicit-grammar and natural-intent paths:
parse → resolve → quarantine → manifest membership → readiness (REQ-4,
which itself enforces REQ-1/REQ-2) → merged-definition validation (REQ-7) →
audit → `subagent_type` rewrite. No provenance or merged-definition error may
be downgraded to `AttestationUnavailableError`; each MUST be audited and
rethrown with its own error class. Source: design §8.3; gap-review B3.

**REQ-6 (Canonical generated-agent contract).** Exactly one shared module
MUST define the canonical routed-agent definition (description, `mode:
subagent`, `hidden: true`, `model`, `permission.task["*"]: deny`, exact
prompt), and MUST be the single source both the generator's descriptor writer
and the merged-config comparator (REQ-7) use — no duplicated literal
templates. The generated descriptor contract is always exact. The agent name
is the manifest `hostName` represented by the Markdown path / `cfg.agent` map
key, not an extra runtime-entry field. Runtime comparison MUST reject
unexpected behavior-changing keys, but it MUST use Task 0's confirmed
full-canonical or observed-field projection so host-injected defaults are not
misclassified as foreign behavior. Source: design §4/§7.0; gap-review B4, C2.

**REQ-7 (Merged runtime-config validation — conditional on Task 0).**
`SddPlugin` MUST register a `config` hook that observes `cfg.agent` and
groups its reserved-prefixed entries case-insensitively against the manifest's
canonical definitions (REQ-6). Each normalized manifest name MUST resolve to
exactly one actual key, and that key MUST equal the manifest `hostName`
byte-for-byte; case normalization detects variants/duplicates but does not
make a differently-cased key dispatchable. The hook MUST NOT mutate
`cfg`/`cfg.agent`,
MUST NOT
generate agents, select routes, or issue readiness, and MUST NOT reject its
own promise on a mismatch (see REQ-8). Task 0 MUST record a sanitized
observation contract. If the host exposes the full canonical projection,
reserved-set equality and exact field comparison apply. Otherwise, every
reserved entry that is present MUST match every field the spike confirms is
observable, while absence of all reserved entries is not itself a mismatch.
This fallback is observed-field validation, not presence-only validation.
Source: design §7; gap-review C2.

**REQ-8 (Config-hook failure semantics).** A mismatch or inspection failure
detected by the `config` hook MUST be recorded (not thrown) so the hook's
promise always resolves; when recording a failed observation the hook MUST
emit a `routing.config.blocked` audit entry with bounded metadata and no raw
configuration; and the *next* `ModelRouteTaskHook.assertMatches()` call at
dispatch time MUST throw `RoutedAgentDefinitionMismatchError` (or
`ResolvedAgentConfigUnavailableError` if no observation exists yet) before
the `subagent_type` rewrite. A newer successful observation MUST clear an
older recorded failure; a failed current observation remains blocking. If the
durable config-audit append fails, the hook still MUST resolve and MUST record
that failure in the current blocking observation; it MUST NOT claim the event
was durably emitted or allow dispatch. Source: design §7/§9; gap-review A3,
B5, C3.

**REQ-9 (Regression-test coexistence).** `tests/bootstrap-clean-startup.test.ts`
MUST be updated, not deleted or weakened beyond this scope: it MUST continue
asserting no reintroduction of the previously-rejected *routing* config hook
(the `obsoleteProductionFiles` list and the
`model-route-config-hook|disabled-not-ready|ModelRouteConfigUnsupportedError|OpenCodeConfig`
source-pattern check stay unchanged), while its hook-key assertion is
narrowed to permit exactly `["config", "tool.execute.before"]`. Source:
design §7.0; gap-review A1.

**REQ-10 (New guard error taxonomy).** The system MUST expose exactly these
four new typed errors, each `instanceof Error`, each with a stable
`name`/`code`, and none containing raw config bodies, prompts, or environment
payloads:
`ForeignAgentDefinitionError` (`FOREIGN_AGENT_DEFINITION`),
`ForeignAgentInspectionError` (`FOREIGN_AGENT_INSPECTION`),
`RoutedAgentDefinitionMismatchError` (`ROUTED_AGENT_DEFINITION_MISMATCH`),
`ResolvedAgentConfigUnavailableError` (`RESOLVED_AGENT_CONFIG_UNAVAILABLE`).
Scanner findings map deterministically onto this taxonomy:
`inspection-failure` findings raise `ForeignAgentInspectionError`;
`foreign-reserved-definition` and `owned-definition-mismatch` findings raise
`ForeignAgentDefinitionError` when the standalone scanner assertion maps
them. Existing ordered integration errors retain the REQ-1 precedence.
Source: design §9; gap-review B1, C1.

**REQ-11 (CLI-selection barrier proof).** A real-host integration test MUST
prove `opencode run --agent <hostName>` refuses to select a routed host as a
primary agent, empirically grounding the `mode: subagent` claim in REQ-6. The assertion logic MUST use explicit non-empty verification so that empty output or missing logs cannot result in a false pass.
Source: design §4/§11.4; gap-review A4.

**REQ-12 (Operator-extensible watched roots).** An env var
`SDD_MODEL_ROUTING_EXTRA_WATCHED_CONFIG_ROOTS` (path-delimiter-separated)
MUST extend the watched sources at every production provenance-scan call
site — generation (REQ-3, including the CLI regeneration path) and every
call site listed in REQ-4, including both `ModelRouteReadiness` construction
sites inside `WindowsModelRouteBootManager` and the production boot CLI that
constructs that manager — not only at dispatch time. Each env entry denotes a
config root; exact managed files use the separate `managedConfigFiles`
injection contract. Source: design §5.3; gap-review A6, B6, C4.

**REQ-13 (Declared residual limitations, not silent gaps).** The following
MUST be explicitly documented as out of scope rather than silently unhandled:
platform-managed OpenCode config roots (no verified per-platform path set
exists in this repo — operators inject via `managedConfigFiles`/REQ-12
instead of a computed default); another plugin invoking a valid routed agent
or rewriting `subagent_type` after this plugin's hook; runtime registrations
that bypass `cfg.agent` and leave no observable source; proving the origin of
a remote definition whose merged result is byte-identical to canonical; the
filesystem TOCTOU window between the last scan and OpenCode's child creation;
and explicit no-auto-remediation behavior (invalid definitions block silently and wait for manual removal, instead of auto-deleting files). An automated documentation contract test MUST verify these statements are present. Source: design §10;
gap-review B6.

## Out of scope

Everything design §10 and §2 mark out of scope remains out of scope here.
This spec does not authorize computing default platform-managed-config paths
without a verified source for them (see REQ-13).

## Acceptance criteria

- All REQ-1 through REQ-13 have at least one automated test per the
  implementation plan's task list (Tasks 0–9).
- `npm run test:model-routes`, `npm run test:typecheck:strict`, and
  `npm run build` pass with zero errors.
- `tests/bootstrap-clean-startup.test.ts` passes with the narrowed assertion
  (REQ-9) and its obsolete-routing-hook guards intact.
- `tests/model-route-real-host-canary.integration.ts` passes with the new
  `opencode run --agent` assertion (REQ-11).
- Task 0's spike notes file exists and states which REQ-7 branch applies
  before Task 6/8 are considered complete; it contains only sanitized
  keys/types/equality evidence, never raw prompt or config values.
- The explicitly gated real-host command for
  `tests/model-route-real-host-canary.integration.ts` has run against OpenCode
  1.18.9 and produced observable evidence for REQ-11; a skipped/gated result
  does not satisfy acceptance.
