# Foreign Agent Provenance Guard — Design

> Historical rev 2 artifact. Superseded by the user-approved rev 3 design at
> `docs/plans/2026-07-31-foreign-agent-provenance-guard-design.md`. Do not use
> this revision as an implementation source of truth.

Date: 2026-07-31 (rev 2: post-review gap resolution)
Status: Superseded. See the rev 3 implementation plan for the authoritative
task list: `docs/plans/2026-07-31-foreign-agent-provenance-guard-implementation.md`.

## 1. Problem

The model-routing fleet generator (`src/infrastructure/opencode/disk-agent-generator.ts`)
owns and verifies exactly one set of files: `<workspaceRoot>/.opencode/agents/sdd-mr-v1-<hash>.md`
and their paired command descriptors. `ModelRouteReadiness.assertCurrentState()`
already re-hashes those owned files on every `issue()`/`verify()` call, so tampering
with the plugin's own generated files is caught.

That verification only covers files the plugin itself wrote. OpenCode resolves
agent configuration from multiple sources (global user config, ancestor
project directories in a monorepo, `opencode.json`, other plugins). If any of
those sources defines an agent with the same reserved name
(`sdd-mr-v1-<hash>`) as one this plugin generated, the plugin has no way to
know — from inside its own process — whether OpenCode will actually dispatch
to the file it verified, or to the foreign one. `ModelRouteTaskHook` rewrites
`output.args.subagent_type` to the trusted `hostName` and hands control back
to the OpenCode engine; from that point on the plugin cannot observe which
definition is used.

## 2. Guarantee

The plugin cannot determine, from inside its own process, which of two
same-named agent definitions OpenCode's internal resolver would pick. It also
does not attempt to. Instead: **detect and fail closed**. Before any
generation or any dispatch, the plugin scans a set of watched candidate
locations for definitions that collide with its reserved naming and are not
the plugin's own canonical files. Two definition shapes are covered:

1. **Markdown agent files** in watched directories whose entry name
   (case-normalized) starts with the reserved prefix (`sdd-mr-v1-`).
2. **Inline agent definitions** in watched `opencode.json` / `opencode.jsonc`
   files whose top-level `agent` object contains a key that (case-normalized)
   starts with the reserved prefix.

If any such definition exists, generation/dispatch is refused with a typed
error until the operator resolves the ambiguity manually.

Note on coverage: every manifest `hostName` starts with
`ROUTE_AGENT_PREFIX` by construction (`ROUTED_HOST_NAME_PREFIX ===
"sdd-mr-v1-"`, `src/domain/model-routing/model-route-host-naming.ts:8`), so
the prefix match subsumes an exact-`hostName` match; there is no separate
exact-name rule.

This is deliberately conservative: a false positive (an unrelated file that
happens to collide, an unparseable config, or a permissions error on a
watched path) blocks routing rather than silently risking a wrong-agent
dispatch.

Not covered (declared residual risk, see §8): agents registered
programmatically at runtime by other OpenCode plugins, which leave no
filesystem trace to scan.

## 3. Watched paths

The watched locations follow OpenCode's **documented** config conventions
(<https://opencode.ai/docs/agents/>, <https://opencode.ai/docs/config/>):
agents load from markdown files in global and project `.opencode/agent(s)/`
directories, config resolves by proximity (project-local, then parent
directories, then global), and `opencode.json` can define agents inline
under the top-level `agent` key. These are public interface, not
undocumented internals.

Computed from `workspaceRoot`:

- **Ancestors**: every directory from `workspaceRoot`'s parent up to the
  filesystem root, each checked at `<ancestor>/.opencode/agents/` and
  `<ancestor>/.opencode/agent/` (singular included for forward
  compatibility), plus the sibling config files `<ancestor>/opencode.json`
  and `<ancestor>/opencode.jsonc`. `workspaceRoot` itself is excluded —
  it is the owner. This exclusion is sound because a same-named file in the
  owner's own agents directory IS the canonical file (same path), whose
  content is already hash-verified by `assertCurrentState()`, and stale
  prefix-matching files there are swept by the generator's existing
  `checkAndSweepDir` pass (`disk-agent-generator.ts:886`).
- **User global config**: `${XDG_CONFIG_HOME || homedir()+"/.config"}/opencode/`,
  checked at `agent/` and `agents/` plus the `opencode.json` /
  `opencode.jsonc` files inside it. This path is **not** platform-branched:
  OpenCode's docs specify `~/.config/opencode` on every platform including
  Windows. It deliberately does NOT mirror the platform-aware resolution in
  `src/infrastructure/runtime/database-path.ts` (which branches to
  `%LOCALAPPDATA%` on Windows), because that function resolves the plugin's
  own data directory while this path mirrors OpenCode's config convention.
- **Operator-extensible**: an optional `additionalWatchedAgentDirs: string[]`
  field on `DiskAgentGeneratorOptions` and `ModelRouteReadinessOptions`, for
  installations with nonstandard OpenCode config locations. Configuration
  surface: a new env var `SDD_MODEL_ROUTING_EXTRA_WATCHED_AGENT_DIRS`
  (`path.delimiter`-separated absolute directories), resolved by a new
  `resolveAdditionalWatchedAgentDirs()` helper in `src/bootstrap/index.ts`
  next to `resolveRoutingBootIdentity()` / `resolveRoutingSigningKey()`
  (`bootstrap/index.ts:98-118`), and plumbed to both consumers (see §5.3).

## 4. Detection mechanism

New pure function, e.g. `scanForForeignAgentDefinitions(watchedDirs, watchedConfigFiles)`:

**Directory scan** — for each watched directory that exists: `readdirSync`;
any entry whose name, lowercased, starts with the reserved prefix
(`ROUTE_AGENT_PREFIX`, `sdd-mr-v1-`) is foreign. Lowercasing makes the match
case-insensitive on every platform, so a case-variant entry
(`SDD-MR-V1-….md`) on a case-insensitive filesystem (Windows, default
macOS) cannot slip past. The match is intentionally extension- and
type-agnostic: files, directories, symlinks/junctions, and suffixes like
`.md.disabled` are all flagged — a fail-closed false positive the operator
dismisses by renaming, never a silent pass.

**Inline config scan** — for each watched `opencode.json` / `opencode.jsonc`
that exists: read, normalize JSONC (strip comments and trailing commas),
parse, and inspect the top-level `agent` object's keys. Any key that,
lowercased, starts with the reserved prefix is foreign. A file that exists
but cannot be parsed is a blocking finding (fail closed — the plugin does
not guess what a malformed config might define).

**Common rules**:

- Entry missing (`ENOENT`) → skip, not foreign. Applies to both directories
  and config files.
- Any other `readdirSync`/`lstatSync`/`readFileSync` failure (permissions,
  `ENOTDIR` because a watched directory path is a regular file, etc.) →
  treated as a blocking finding (fail closed, not fail open).
- A foreign entry that is also a symlink/junction is still reported (and is
  more suspicious, not less).
- Read-only: never writes, deletes, or follows symlinks outside
  `workspaceRoot`.

New error: `ForeignAgentDefinitionError extends Error`, defined in
`src/infrastructure/opencode/model-route-readiness.ts` alongside
`AttestationExpiredError` / `AttestationMismatchError` (that module's error
taxonomy is plain-`Error` subclasses; `disk-agent-generator.ts` already
imports from `model-route-readiness.ts`, so the generator reuses the class
without a new dependency direction). Code `FOREIGN_AGENT_DEFINITION`,
carrying the offending path, the colliding name, and the source kind
(`directory-entry` | `inline-config-key` | `unreadable-path`). It must NOT
extend `DiskAgentGeneratorError`: nothing branches on that base class, and
readiness throwing a generator-class error would invert the existing module
dependency for no functional gain.

## 5. Integration points

1. **`DiskAgentGenerator.generate()`**: after computing `newRoutes` (so the
   candidate `hostName`s are known) and before any `atomicWriteDescriptor`
   call (and before the sweep pass). On collision: abort, release the lock,
   write nothing.
2. **`ModelRouteReadiness.assertCurrentState()`**: called from both
   `issue()` and `verify()`, i.e. on every `ModelRouteTaskHook.execute()`
   dispatch (both the explicit-grammar and natural-intent paths). Scans
   using the current manifest's `hostName`s. On collision: throws
   `ForeignAgentDefinitionError` (a distinct class from
   `AttestationMismatchError`, so audit logs don't obscure the real cause).
3. **`ModelRouteTaskHook` + bootstrap plumbing (required, not automatic)**:
   the hook's existing catch blocks do NOT pick the new error up as-is.
   Both sites — `routeFromGrammar` (`model-route-task-hook.ts:316-323`) and
   `routeFromIntent` (`model-route-task-hook.ts:444-459`) — map any
   non-`Attestation*` error to `errorClass: "AttestationUnavailableError"`
   and rethrow it wrapped in `AttestationUnavailableError`, which would lose
   the typed error and mislabel the audit entry. Both sites must be changed:
   add `ForeignAgentDefinitionError` to the `errorClass` ternary and to the
   `instanceof` rethrow condition so it propagates unwrapped, like the
   attestation errors. Additionally:
   - The hook constructs `ModelRouteReadiness` inline at both sites
     (`:306-309`, `:434-437`); it must forward
     `additionalWatchedAgentDirs` there, accepting it as a new
     `ModelRouteTaskHook` option.
   - `src/bootstrap/index.ts` must resolve
     `SDD_MODEL_ROUTING_EXTRA_WATCHED_AGENT_DIRS` and pass it at both hook
     construction sites (`:277-285`, `:351-359`), and the fleet regeneration
     path must pass it to `DiskAgentGenerator`
     (`src/application/regenerate-fleet-agents/regenerate-fleet-agents.use-case.ts:82`).

No caching: the scan runs on every dispatch, uncached, matching the existing
per-call hash verification already paid on this path. Cost is a handful of
local `readdirSync`/`readFileSync` calls against small directories and
config files.

## 6. Error handling and observability

- Propagates like `AttestationMismatchError` today: blocks the `Task` call,
  audited via `routing.blocked` / `routing.natural.blocked` with
  `errorClass: "ForeignAgentDefinitionError"` (requires the §5.3 hook
  changes; without them the entry would be mislabeled
  `"AttestationUnavailableError"`).
- Error message includes the full path of the foreign definition, the
  colliding name, and the source kind, so the operator can locate and
  investigate/remove it.
- No auto-remediation: the plugin never deletes or modifies anything outside
  `workspaceRoot`. Foreign-path findings are read-only.

## 7. Testing

Per this project's Strict TDD mode:

- Unit tests for `scanForForeignAgentDefinitions`:
  - Directory scan: collision present, collision absent, missing directory
    (`ENOENT` → skip), symlink collision, case-variant collision
    (`SDD-MR-V1-….md` → foreign), non-`.md` entry with the prefix → foreign
    (fail-closed), watched path that is a regular file (`ENOTDIR` →
    blocking finding). A real `EACCES` permission test may be added as a
    platform-gated extra, but `ENOTDIR` is the portable surrogate for the
    "unreadable path → blocking" branch (POSIX ACL simulation is unreliable
    on Windows CI).
  - Inline config scan: `agent` key collision in global and ancestor
    `opencode.json`, same in `opencode.jsonc` with comments/trailing
    commas, missing config file → skip, malformed JSON → blocking finding.
- Integration tests for `DiskAgentGenerator.generate()`: aborts and writes
  nothing when a collision is present in a watched ancestor/global path.
- Integration tests for `ModelRouteReadiness.issue()` / `.verify()`: refuses
  to issue/verify attestation on collision (directory and inline-config
  variants).
- Hook tests for both `routeFromGrammar` and `routeFromIntent`:
  `ForeignAgentDefinitionError` from `verify()` is rethrown UNWRAPPED (not
  as `AttestationUnavailableError`) and the audit entry carries
  `errorClass: "ForeignAgentDefinitionError"`.
- End-to-end test for `ModelRouteTaskHook.execute()`: confirms the `Task`
  call is blocked and the audit entry carries
  `errorClass: "ForeignAgentDefinitionError"`.
- Bootstrap plumbing test: `SDD_MODEL_ROUTING_EXTRA_WATCHED_AGENT_DIRS` is
  parsed on `path.delimiter` and reaches both the hook (→ readiness) and
  the generator options.

## 8. Explicitly out of scope

- Determining which of two same-named definitions OpenCode would actually
  execute (not observable from this process). OpenCode's agent-resolution
  **precedence** internals remain un-researched by design; the watched
  locations themselves come from OpenCode's documented public config
  conventions (see §3), not from this repo's own layout.
- **Residual risk, declared**: agents registered programmatically at runtime
  by other OpenCode plugins leave no filesystem trace and cannot be detected
  by this guard. The guarantee in §2 covers filesystem-observable
  definitions only.
- Auto-deleting or modifying foreign files.
