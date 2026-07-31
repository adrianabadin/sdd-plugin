# Foreign Agent Provenance Guard — Design rev 3

Date: 2026-07-31
Status: Approved by user
Supersedes: `docs/superpowers/specs/2026-07-31-foreign-agent-provenance-guard-design.md` rev 2
PMC decision: `decision/foreign-agent-provenance-guard-design-approved-2026-07-31`

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

The active PMC decision that rejected `plan/config-hook-fleet-agents` remains
in force. `Hooks.config` is permitted here only as a read-only observation and
validation boundary:

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
- No unexpected behavior-changing fields such as `disable`, `tools`, `steps`,
  `temperature`, `top_p`, `variant`, or provider-specific options.

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
- OpenCode's documented managed configuration root for the current platform;
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
  foreign reserved definition was found.
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
- auto-remediation of foreign configuration.

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
