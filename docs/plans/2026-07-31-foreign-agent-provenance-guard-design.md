# Foreign Agent Provenance Guard — Design rev 3

Date: 2026-07-31
Status: Approved by user
Supersedes: `docs/superpowers/specs/2026-07-31-foreign-agent-provenance-guard-design.md` rev 2
PMC decision (this project persists decisions in PMC, not Engram):
`decision/foreign-agent-provenance-guard-design-approved-2026-07-31`
(PMC memory `8137f8f5-fc1f-4d34-9c2b-03798e261a64`), which cross-references
both `architecture/model-routing-boot-attestation-decision` and the archived
`plan/config-hook-fleet-agents` plan.

## 1. Problem

The deterministic routing plugin generates one hidden OpenCode subagent per
curated model route under `.opencode/agents/sdd-mr-v1-<hash>.md`. The manifest
and readiness attestation hash those owned files, but OpenCode can merge agent
definitions from several other sources. A foreign definition using the
reserved `sdd-mr-v1-` namespace could therefore alter the effective agent that
OpenCode dispatches after `ModelRouteTaskHook` rewrites `subagent_type`.

The plugin must detect foreign definitions from observable configuration
sources and fail closed before fleet mutation, readiness issuance, readiness
verification, or routing dispatch. It must also verify that OpenCode's merged
runtime definition remains equivalent to the generated canonical agent.

## 2. Scope and guarantee

The guard protects the provenance and effective definition of agents in the
reserved `sdd-mr-v1-` namespace.

It guarantees that:

1. Observable filesystem and environment configuration sources contain no
   foreign reserved definition.
2. The workspace-owned reserved Markdown files are exactly the files declared
   by the manifest and retain their recorded hashes.
3. OpenCode's merged `cfg.agent` contains exactly the manifest's reserved agent
   names and each reserved entry matches the generated canonical definition.
4. Any inspection failure or mismatch blocks before the routing rewrite.

The guarantee is fail-closed. The plugin never auto-remediates foreign files or
configuration outside its owned workspace paths.

The use or subsequent mutation of these agents by another plugin is explicitly
outside this plugin's responsibility. A later plugin hook that rewrites a task
after this plugin has completed is likewise outside scope.

## 3. Existing architecture remains authoritative

This design extends, and does not replace, the existing disk-based supervised
boot architecture:

- `DiskAgentGenerator` remains the only fleet generator.
- `WindowsModelRouteBootManager` remains responsible for process lifecycle,
  exact OpenCode version, live catalog synchronization, canonical readback,
  canaries, secret rotation, and readiness issuance.
- `ModelRouteReadiness` and its signed attestation remain mandatory.
- `ModelRouteTaskHook` remains the only component that resolves a route and
  rewrites `subagent_type`.

The active PMC decision `architecture/model-routing-boot-attestation-decision`
(`273e2255-3202-49df-9b89-48e108bfcdb6`), which archived the
`plan/config-hook-fleet-agents` plan (`57e4ff34-ea6d-4b62-b695-cb7cdad2c1de`)
and requires any new plan to coexist with the boot manager + signed
attestation rather than replace it, remains in force. That prior plan's
config-hook approach could not reproduce the attestation guarantees because
it used the hook to *route*. This design imposes stricter, self-contained
constraints on top of that decision: `Hooks.config` here is a strictly
narrower, read-only observation and validation boundary that never routes,
never issues readiness, and never replaces attestation (see §7.0 for the
full distinction):

- It MUST NOT add, remove, or mutate `cfg.agent`.
- It MUST NOT generate agents, select models, resolve routes, rewrite tasks,
  issue readiness, or replace the signed attestation.
- It MUST NOT introduce an in-memory routing path.
- Filesystem generation, the boot manager, canaries, and attestation remain the
  authoritative gates.

## 4. Generated-agent invariants

Every generated routed agent must retain the complete canonical definition:

- `name`: manifest `hostName`.
- `mode: subagent`.
- `hidden: true`.
- `model`: exact canonical `providerId/modelId`.
- Exact generated description and prompt.
- `permission.task["*"]: deny`.
- No unexpected behavior-changing fields such as `disable`, `tools`,
  `maxSteps`, `temperature`, `top_p`, `color`, or any key not listed above.

`hidden: true` removes the agent from user-facing autocomplete. It is not an
access-control mechanism. `mode: subagent` is the invariant that prevents
`opencode run --agent <hostName>` from selecting the routed agent as a primary
CLI agent. Both fields are required and runtime-verified.

## 5. Observable configuration sources

A new provenance module resolves sources from an explicit environment snapshot
and canonical `workspaceRoot`.

### 5.1 Workspace sources

- `<workspaceRoot>/opencode.json` and `opencode.jsonc` are scanned for inline
  reserved keys. They are not excluded merely because the workspace owns the
  generated Markdown directory.
- `<workspaceRoot>/.opencode/agents` and `agent` are inspected against a strict
  allowlist derived from the manifest. Only canonical owned files with recorded
  hashes may define reserved names.
- `<workspaceRoot>/.opencode/modes` and `mode` are foreign sources. The plugin
  owns no routed mode files.

### 5.2 Project ancestry

Every directory from `workspaceRoot`'s parent to the filesystem root is checked
for:

- `.opencode/agent` and `.opencode/agents`;
- `.opencode/mode` and `.opencode/modes`;
- sibling `opencode.json` and `opencode.jsonc`.

### 5.3 Global, custom, inline, and managed sources

The resolver includes:

- `${XDG_CONFIG_HOME || homedir()/.config}/opencode`;
- the file named by `OPENCODE_CONFIG`;
- the config root named by `OPENCODE_CONFIG_DIR`, including its
  `opencode.json(c)`, `agent(s)`, and `mode(s)` entries;
- JSON supplied through `OPENCODE_CONFIG_CONTENT` without logging its raw
  content;
- an injectable `managedConfigFiles` list, for platform-managed configuration
  roots. Production wiring does not compute these automatically: this
  repository has no verified, documented set of per-platform managed-config
  paths for OpenCode 1.18.9 to code against (see §10). The option exists so
  an operator or a future correction can supply them explicitly once known;
  until then, coverage of managed roots is a declared residual limitation,
  not a silent gap;
- operator roots from
  `SDD_MODEL_ROUTING_EXTRA_WATCHED_CONFIG_ROOTS`, split using
  `path.delimiter`. Each entry is a config root, not merely an agent directory.

The rev 2 variable `SDD_MODEL_ROUTING_EXTRA_WATCHED_AGENT_DIRS` was never
implemented and is replaced rather than retained as an alias.

### 5.4 Remote configuration

OpenCode remote or organization configuration has no public per-agent source
metadata in the plugin SDK. The guard cannot prove raw provenance for an
identical remote override. The read-only merged-config validation still blocks
any remote definition that changes the reserved set or any canonical field.
An indistinguishable, byte-equivalent effective definition is a declared
residual limitation because it changes no routed behavior.

## 6. Provenance scan

The provenance module exposes deterministic, read-only operations:

- `resolveForeignAgentSources(...)` computes normalized, deduplicated sources.
- `scanForForeignAgentDefinitions(...)` returns all findings in stable path and
  name order.
- `assertNoForeignAgentDefinitions(...)` maps findings to typed errors.

### 6.1 Markdown sources

OpenCode 1.18.9 loads `{agent,agents}/**/*.md` recursively and also loads
`{mode,modes}/*.md` as agent definitions. For every candidate Markdown file,
the guard checks:

- the OpenCode-derived entry name from its relative path;
- a frontmatter `name` override;
- case-normalized membership in the reserved namespace.

YAML frontmatter is parsed with a declared parser dependency. No regex-only
frontmatter parser is accepted. Because OpenCode follows symlinks during agent
discovery, the provenance guard does not silently skip them: any symlink,
junction, or reparse point encountered in a watched configuration tree is a
blocking inspection finding. The guard never follows it.

### 6.2 JSON and JSONC sources

JSON and JSONC are parsed with a declared standards-based JSONC parser. The rev
2 hand-written comment/trailing-comma normalizer is removed. The guard inspects
top-level `agent` keys case-insensitively and treats any reserved key as a
foreign definition unless it is the canonical runtime representation verified
separately.

### 6.3 Failure policy

- Missing optional source (`ENOENT`) is skipped.
- Any other read, traversal, parse, or canonicalization failure is blocking.
- Findings contain bounded metadata only: source kind, watched source,
  offending path or environment-source label, colliding name when known, and
  a sanitized reason.
- Raw config contents, prompts, environment payloads, and secrets are never
  copied into errors or audit logs.

## 7. Runtime merged-definition validation

### 7.0 Prerequisite spike (blocking)

Before Task 6/8 implementation proceeds, empirically confirm against a real
OpenCode 1.18.9 host whether `.opencode/agents/*.md` definitions appear in the
`Config.agent` map passed to a plugin's `config` hook, and whether `hidden`
and `permission.task` survive normalization into that map.
`@opencode-ai/sdk`'s `AgentConfig` type declares neither field (only
`disable?: boolean` and `permission` without a `task` key), so this cannot be
assumed from the SDK types alone.

- If markdown agents appear in `cfg.agent` with `hidden`/`permission.task`
  intact: implement §7 as written below.
- If markdown agents are absent from `cfg.agent`, or present but missing
  `hidden`/`permission.task`: §7.1's set-equality rule is replaced by
  "validate only reserved keys that are present in the observed map; absence
  of all reserved keys is not a mismatch", and the field-by-field comparison
  in §7.3 is restricted to whichever fields the spike confirms actually
  survive. Guarantee 3 in §2 is downgraded from unconditional to
  conditional-on-presence in that case.

This repository also carries a deliberate regression test,
`tests/bootstrap-clean-startup.test.ts`, asserting `SddPlugin` returns
exactly `["tool.execute.before"]` from a clean boot and exposes no `config`
key — a guard left over from a previously rejected in-memory config-hook
routing architecture (`plan/config-hook-fleet-agents`; see §3). That
architecture used a config hook to *route* and could not reproduce signed
attestation guarantees. This design's hook is narrower and strictly
read-only: it never assigns to `cfg`/`cfg.agent`, never resolves a route,
never issues readiness, and never replaces the disk-based attestation gate —
it only observes and validates already-decided fleet state. On that basis the
test is intentionally superseded by this design and must be updated in the
same change (Task 8) to assert exactly `["config", "tool.execute.before"]`,
while its obsolete-file and source-pattern assertions (which guard against
reintroducing the *routing* hook, not this validation-only hook) remain
intact and unchanged.

`SddPlugin` registers a read-only `config` hook and stores the latest live
`cfg.agent` reference. The hook validates immediately during configuration
loading and refresh. It never mutates the configuration object.

The runtime guard compares the merged configuration with the current manifest:

1. The set of case-normalized reserved keys must equal the set of manifest
   `hostName` values.
2. Every manifest host must exist exactly once.
3. Each entry's normalized behavioral projection must equal the canonical
   generated definition described in section 4.
4. A missing config observation when routing starts is fail-closed.

`ModelRouteTaskHook` receives a getter for the current read-only observation.
It revalidates the selected host immediately before success audit and rewrite.
Capturing the live reference means mutations performed by earlier/later config
hooks during the same configuration phase are visible at dispatch time, while
remaining outside the routing decision itself.

## 8. Integration and ordering

### 8.1 Generation

Under the existing generator lock:

1. Load and validate routes.
2. Read the previous manifest and verify every previously owned hash.
3. Run provenance inspection before any sweep or descriptor mutation.
4. Perform the existing owned-file convergence sweep.
5. Write canonical descriptors.
6. Commit the manifest last and release the lock.

A provenance failure may create/release the control lock but writes or deletes
no fleet descriptor and commits no manifest.

### 8.2 Boot/readiness

The boot sequence remains:

`regeneration -> boot secrets -> lifecycle lock -> spawn -> health/version ->
live sync -> readback -> canary -> attestation -> attach -> ready`.

`ModelRouteReadiness.assertCurrentState()` runs the observable-source scan from
both `issue()` and `verify()`, in addition to existing manifest and file-hash
checks. Runtime merged-config validation occurs in the OpenCode plugin process
and does not replace readiness.

### 8.3 Dispatch

Both explicit-grammar and natural-intent paths preserve this gate order:

`parse -> resolve -> quarantine -> manifest membership -> readiness/filesystem
provenance -> merged-definition validation -> audit -> subagent_type rewrite`.

Every new guard error is audited with its real error class and rethrown
unwrapped. No mismatch may be converted to `AttestationUnavailableError`.

## 9. Error and audit taxonomy

- `ForeignAgentDefinitionError`, code `FOREIGN_AGENT_DEFINITION`: a concrete
  foreign reserved definition was found, or a workspace-owned reserved file's
  hash no longer matches the manifest allowlist at a scan site that runs the
  new provenance scanner independently of the generator's own hash-verify
  step. At both integration points defined in §8 (generation, readiness),
  the existing `ModifiedOwnedFileError` / owned-hash check already runs
  strictly before the new scan (§8.1 step 2 precedes step 3; readiness's
  existing `assertCurrentState` file-hash pass precedes the new scan call),
  so an owned-file tamper is reported as `ModifiedOwnedFileError` at those
  two call sites in practice. The scanner's own `owned-definition-mismatch`
  finding exists for callers of `scanForForeignAgentDefinitions` outside
  those two ordered integration points, so it fails closed even if used
  standalone.
- `ForeignAgentInspectionError`, code `FOREIGN_AGENT_INSPECTION`: a relevant
  source could not be safely inspected or parsed.
- `RoutedAgentDefinitionMismatchError`, code
  `ROUTED_AGENT_DEFINITION_MISMATCH`: merged `cfg.agent` differs from the
  manifest's canonical reserved set or definition.
- `ResolvedAgentConfigUnavailableError`, code
  `RESOLVED_AGENT_CONFIG_UNAVAILABLE`: no read-only config observation exists
  at dispatch time.

Generation errors abort generation. Readiness errors block issue/verify. Task
hook errors emit `routing.blocked` or `routing.natural.blocked` with the exact
class, bounded source metadata, and no raw configuration.

Config-hook failures: a validation failure raised inside the read-only
`config` hook is recorded on the `ResolvedAgentConfigGuard` and re-raised at
dispatch as `RoutedAgentDefinitionMismatchError` (or
`ResolvedAgentConfigUnavailableError` when no observation exists). The hook
itself never rejects its promise, so a provenance failure can never abort
OpenCode configuration loading or host startup — only routing. The hook emits
a `routing.config.blocked` audit entry when it records a failed observation,
in addition to the dispatch-time `routing.blocked` / `routing.natural.blocked`
entry when a route is actually attempted against a bad observation.

## 10. Concurrency and residual limitations

Filesystem inspection is uncached and runs immediately before the existing
critical operations. Runtime config validation uses the latest observed live
configuration. This narrows but cannot eliminate the filesystem TOCTOU window
between the last read and OpenCode's eventual child creation.

The following remain explicitly out of scope:

- another plugin invoking a valid routed agent;
- another plugin rewriting `subagent_type` after this plugin's hook;
- runtime registrations that bypass `cfg.agent` and leave no observable source;
- proving the origin of a remote definition whose merged result is identical
  to the canonical generated definition;
- auto-remediation of foreign configuration;
- platform-managed configuration roots are not scanned automatically in
  production wiring, because this repository has no verified, documented set
  of per-platform managed-config paths for OpenCode 1.18.9 (§5.3). Operators
  with a known managed-config location must supply it via
  `managedConfigFiles`/`SDD_MODEL_ROUTING_EXTRA_WATCHED_CONFIG_ROOTS` until a
  future correction pins the default.

## 11. Testing strategy

Strict RED -> GREEN -> REFACTOR applies.

### 11.1 Source resolver and scanner

- Workspace inline collision and canonical workspace-file allowlist.
- Ancestor and global `agent(s)`, `mode(s)`, JSON, and JSONC sources.
- `OPENCODE_CONFIG`, `OPENCODE_CONFIG_DIR`, and
  `OPENCODE_CONFIG_CONTENT`.
- Platform-managed roots and additional config roots.
- Recursive Markdown discovery, derived names, frontmatter `name`, case
  variants, and non-reserved clean files.
- Symlink/junction/reparse-point blocking without traversal.
- Missing source skip; malformed/unreadable source typed inspection failure.
- Standard JSONC/YAML parsing cases with strings containing comment-like text.

### 11.2 Generator and readiness

- Generator aborts before sweep/descriptors/manifest and releases its lock.
- Existing owned files remain untouched on provenance failure.
- `issue()` and `verify()` block on directory, inline, mode, frontmatter,
  custom-env, managed, and inspection-error cases.
- Existing tamper, canary, TTL, signature, and boot-identity tests remain green.

### 11.3 Runtime config and task hook

- `config` hook never mutates `cfg.agent`.
- Exact canonical set/config passes.
- Extra, missing, case-variant, `hidden: false`, `mode: primary`, wrong model,
  changed prompt/permission, or unexpected behavioral option blocks.
- Missing config observation blocks.
- Both grammar and natural paths propagate each typed error unwrapped and audit
  the exact error class before rewrite.

### 11.4 CLI and real-host contract

- Generated descriptors contain both `mode: subagent` and `hidden: true`.
- The OpenCode 1.18.9 real-host suite verifies a routed host cannot be selected
  as a primary agent with `opencode run --agent`.
- New tests are wired into `test:model-routes`; strict typecheck, build, focused
  suites, and full regression remain mandatory.

## 12. Definition of done

- No rev 2 source-coverage assumption remains untested.
- The read-only `Hooks.config` boundary is proven non-mutating and cannot route.
- Disk generation, boot supervision, canaries, and signed readiness remain
  mandatory and unchanged in authority.
- All typed failures occur before fleet mutation or task rewrite as applicable.
- Focused tests, `npm run test:model-routes`, strict typecheck, build, and full
  regression pass with fresh evidence.
- PMC decision memory and implementation plan point to this rev 3 document.
