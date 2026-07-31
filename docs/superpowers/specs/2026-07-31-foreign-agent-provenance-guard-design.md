# Foreign Agent Provenance Guard — Design

Date: 2026-07-31
Status: Approved by user, pending implementation plan

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
directories for files that collide with its reserved naming (prefix
`sdd-mr-v1-` or an exact manifest `hostName`) and are not the plugin's own
canonical file. If any such file exists, generation/dispatch is refused with
a typed error until the operator resolves the ambiguity manually.

This is deliberately conservative: a false positive (an unrelated file that
happens to collide, or a permissions error on a watched path) blocks routing
rather than silently risking a wrong-agent dispatch.

## 3. Watched paths

Computed from `workspaceRoot`, no external OpenCode source-of-truth needed:

- **Ancestors**: every directory from `workspaceRoot`'s parent up to the
  filesystem root, each checked at `<ancestor>/.opencode/agents/` and
  `<ancestor>/.opencode/agent/` (singular included for forward
  compatibility). `workspaceRoot` itself is excluded — it's the owner.
- **User global config**: `${XDG_CONFIG_HOME || homedir()+"/.config"}/opencode/agent/`
  and `.../agents/`, mirroring the existing `XDG_DATA_HOME` pattern already
  used in `src/infrastructure/runtime/database-path.ts`.
- **Operator-extensible**: an optional `additionalWatchedAgentDirs: string[]`
  field on `DiskAgentGeneratorOptions` and `ModelRouteReadinessOptions`, for
  installations with nonstandard OpenCode config locations.

## 4. Detection mechanism

New pure function, e.g. `scanForForeignAgentDefinitions(watchedDirs, reservedNames)`:

- For each watched directory that exists: `readdirSync`; any entry whose name
  starts with the reserved prefix (`ROUTE_AGENT_PREFIX`, `sdd-mr-v1-`) or
  exactly matches the basename of a manifest route's `hostName` is foreign.
- Directory missing (`ENOENT`) → skip, not foreign.
- Any other `readdirSync`/`lstatSync` failure (permissions, etc.) → treated
  as a blocking finding (fail closed, not fail open).
- A foreign entry that is also a symlink/junction is still reported (and is
  more suspicious, not less).
- Read-only: never writes, deletes, or follows symlinks outside
  `workspaceRoot`.

New error: `ForeignAgentDefinitionError extends DiskAgentGeneratorError`,
code `FOREIGN_AGENT_DEFINITION`, carrying the offending path and the
colliding name.

## 5. Integration points

1. **`DiskAgentGenerator.generate()`**: after computing `newRoutes` (so the
   candidate `hostName`s are known) and before any `atomicWriteDescriptor`
   call. On collision: abort, release the lock, write nothing.
2. **`ModelRouteReadiness.assertCurrentState()`**: called from both
   `issue()` and `verify()`, i.e. on every `ModelRouteTaskHook.execute()`
   dispatch (both the explicit-grammar and natural-intent paths). Scans
   using the current manifest's `hostName`s. On collision: throws
   `ForeignAgentDefinitionError` (a distinct class from
   `AttestationMismatchError`, so audit logs don't obscure the real cause).
   The task hook's existing `errorClass` branching in `routeFromGrammar` /
   `routeFromIntent` picks this up the same way it already handles
   `AttestationExpiredError` / `AttestationMismatchError`, and blocks the
   `Task` call before the `subagent_type` rewrite.

No caching: the scan runs on every dispatch, uncached, matching the existing
per-call hash verification already paid on this path. Cost is a handful of
local `readdirSync` calls against small directories.

## 6. Error handling and observability

- Propagates like `AttestationMismatchError` today: blocks the `Task` call,
  audited via `routing.blocked` / `routing.natural.blocked` with
  `errorClass: "ForeignAgentDefinitionError"`.
- Error message includes the full path of the foreign file and the
  colliding name, so the operator can locate and investigate/remove it.
- No auto-remediation: the plugin never deletes or modifies anything outside
  `workspaceRoot`. Foreign-path findings are read-only.

## 7. Testing

Per this project's Strict TDD mode:

- Unit tests for `scanForForeignAgentDefinitions`: collision present,
  collision absent, missing directory (`ENOENT` → skip), symlink collision,
  permission error (→ blocking finding).
- Integration tests for `DiskAgentGenerator.generate()`: aborts and writes
  nothing when a collision is present in a watched ancestor/global path.
- Integration tests for `ModelRouteReadiness.issue()` / `.verify()`: refuses
  to issue/verify attestation on collision.
- End-to-end test for `ModelRouteTaskHook.execute()`: confirms the `Task`
  call is blocked and the audit entry carries
  `errorClass: "ForeignAgentDefinitionError"`.

## 8. Explicitly out of scope

- Determining which of two same-named definitions OpenCode would actually
  execute (not observable from this process).
- Auto-deleting or modifying foreign files.
- Researching OpenCode's internal agent-resolution precedence via external
  docs (this design derives watched paths from this repo's own conventions
  and generation location, not from OpenCode's undocumented internals).
