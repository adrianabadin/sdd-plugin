# Foreign Agent Provenance Guard Rev 3 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fail closed before fleet mutation, readiness, or routing whenever a reserved `sdd-mr-v1-` agent has foreign observable provenance or its merged OpenCode definition differs from the generated canonical definition.

**Architecture:** A pure source resolver and scanner inspect every observable OpenCode configuration source without following links. A separate in-process guard observes the already-merged `cfg.agent` through a strictly read-only `Hooks.config` callback and compares it with the manifest-backed canonical fleet immediately and again before each dispatch. The existing boot manager, disk generator, signed readiness attestation, and task hook keep ownership of lifecycle and routing; the config hook never registers or mutates agents.

**Tech Stack:** TypeScript ESM, Node >=24, `@opencode-ai/plugin` 1.18.9 runtime contract, `yaml` for Markdown frontmatter, `jsonc-parser` for JSON/JSONC, plain `tsx` + `node:assert/strict` tests.

**Canonical design:** `docs/plans/2026-07-31-foreign-agent-provenance-guard-design.md` (approved rev 3).

**Canonical specification:** `docs/plans/2026-07-31-foreign-agent-provenance-guard-spec.md` (REQ-1..REQ-13; PMC memory `0ea11a80-4b99-4432-9d07-572b22fd05c7`). The rev 2 document under `docs/superpowers/specs/` is historical only.

---

## Execution rules

- Run this plan in an isolated worktree. Do not implement on a dirty `main` checkout.
- Execute pre-change safety-net test execution before any modifications.
- Use @test-driven-development for every task (match RED commands to all new tests created, and collect apply-progress TDD evidence) and @verification-before-completion before the final claim.
- Keep every guard synchronous after source resolution so no routing rewrite can race ahead of validation.
- All comparisons of reserved names are case-insensitive; all paths are canonical absolute paths.
- Never log raw `OPENCODE_CONFIG_CONTENT`, config bodies, prompts, credentials, or unrestricted paths. Errors expose source kind, a sanitized source label, and the colliding agent name only.
- Tests must override home/XDG/config/managed roots with temporary directories. Never scan the developer machine's real configuration.
- Preserve the architectural decision: `Hooks.config` may observe and validate only. It must not assign to `cfg`, `cfg.agent`, or any nested member; register/generate agents; select routes; issue readiness; or replace boot/canary/attestation checks.

### Task 0: Empirically resolve the `cfg.agent` merged-shape spike (blocking)

**Files:**
- Create: `docs/plans/2026-07-31-foreign-agent-provenance-guard-spike-notes.md`

**Step 1: Run a real OpenCode 1.18.9 host with at least one generated routed
agent present under `.opencode/agents/`.**

Register a temporary diagnostic plugin whose `config` hook logs (to a local
file, never to a shared log) a sanitized shape summary for the reserved entries
in `cfg.agent` for a known generated `hostName`. Never persist a raw entry,
prompt, config body, secret, or environment payload. Record key names, own
enumerable property names, property-descriptor kind, value types, equality
booleans, and SHA-256 digests where byte equality matters. Confirm:

1. Whether the entry exists at all in `cfg.agent`.
2. Whether `hidden` is present and `true`.
3. Whether `permission.task["*"]` is present and `"deny"`.
4. Which other fields from the generated frontmatter (`description`, `model`,
   `mode`) survive verbatim.
5. Whether OpenCode injects additional keys/defaults, accessors, or changes the
   actual reserved map-key casing.

**Step 2: Record the result**

Write the findings to `docs/plans/2026-07-31-foreign-agent-provenance-guard-spike-notes.md`
and state which branch of design §7.0 applies: full canonical projection,
or the observed-field projection fallback. If the shape is completely unsupported
and unobservable, stop apply and revise design/spec. List the exact observable fields
and safe host-added defaults for the latter; it is not a presence-only check.
Do not proceed to Task 5 or 6 until this file exists and states a conclusion.

**Step 3: Commit**

```bash
git add docs/plans/2026-07-31-foreign-agent-provenance-guard-spike-notes.md
git commit -m "docs(routing): record cfg.agent merged-shape spike result"
```

### Task 1: Declare parser dependencies and pin the loader contract

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `tests/foreign-agent-parser-dependencies.test.ts`

**Step 1: Write the failing dependency test**

Create a plain-script test that reads `package.json`, asserts `yaml` and `jsonc-parser` are direct production dependencies, imports both packages, parses a YAML mapping and a commented JSONC object, and prints `OK foreign-agent-parser-dependencies`.

```ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { parse as parseJsonc } from "jsonc-parser";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
assert.equal(typeof pkg.dependencies?.yaml, "string");
assert.equal(typeof pkg.dependencies?.["jsonc-parser"], "string");
assert.deepEqual(parseYaml("name: sdd-mr-v1-test\n"), { name: "sdd-mr-v1-test" });
assert.deepEqual(parseJsonc('{ // comment\n "agent": {},\n}'), { agent: {} });
console.log("OK foreign-agent-parser-dependencies");
```

**Step 2: Verify RED**

Run: `npx tsx tests/foreign-agent-parser-dependencies.test.ts`

Expected: FAIL because the packages are not direct declared dependencies/importable by contract.

**Step 3: Add direct dependencies**

Run: `npm install yaml jsonc-parser`

Do not hand-roll comment stripping or YAML frontmatter parsing. Use a locally-scoped instance of the loader to ensure it cannot affect global runtime parsing.

**Step 4: Verify GREEN and typecheck**

Run: `npx tsx tests/foreign-agent-parser-dependencies.test.ts && npm run test:typecheck:strict`

Expected: PASS.

**Step 5: Commit**

```bash
git add package.json package-lock.json tests/foreign-agent-parser-dependencies.test.ts
git commit -m "build(routing): declare provenance parser dependencies"
```

### Task 2: Resolve all observable OpenCode definition sources

**Files:**
- Create: `src/infrastructure/opencode/foreign-agent-sources.ts`
- Create: `tests/foreign-agent-sources.test.ts`

**Step 1: Write failing table-driven tests**

Cover these sources with injected `env`, `homeDir`, `platform`, and `managedConfigFiles` so tests are hermetic:

1. Workspace `opencode.json` and `opencode.jsonc` are included as foreign-capable config files.
2. Workspace `.opencode/agent(s)` are classified `workspace-owned-candidate`; workspace `.opencode/mode(s)` are foreign-capable.
3. Every ancestor contributes `opencode.json/jsonc` and `.opencode/{agent,agents,mode,modes}`.
4. XDG/global config contributes its config files and four definition directories.
5. `OPENCODE_CONFIG` contributes its exact file only; it does not invent
   sibling definition roots that the design/OpenCode contract does not name.
6. `OPENCODE_CONFIG_DIR` contributes config files and four definition directories.
7. `OPENCODE_CONFIG_CONTENT` contributes an inline source label, never its raw value.
8. Injected managed config files and `SDD_MODEL_ROUTING_EXTRA_WATCHED_CONFIG_ROOTS` config-root entries are included.
9. Duplicate canonical paths collapse to one source; source ordering is
   stable. The canonical workspace agent trees retain
   `workspace-owned-candidate` classification when rediscovered through an
   env/custom root, so physical ownership remains path+hash based; no other
   path may acquire that classification through deduplication.
10. Relative custom paths resolve against the supplied process cwd.

Run: `npx tsx tests/foreign-agent-sources.test.ts`

Expected: FAIL with module-not-found.

**Step 2: Implement the source model**

Use these public contracts:

```ts
export type AgentDefinitionDirectoryKind = "agent" | "mode";
export type AgentSourceOwnership = "workspace-owned-candidate" | "foreign";

export type ObservableAgentSource =
  | { readonly kind: "definition-directory"; readonly path: string; readonly directoryKind: AgentDefinitionDirectoryKind; readonly ownership: AgentSourceOwnership; readonly label: string }
  | { readonly kind: "config-file"; readonly path: string; readonly ownership: "foreign"; readonly label: string }
  | { readonly kind: "inline-config"; readonly raw: string; readonly ownership: "foreign"; readonly label: "OPENCODE_CONFIG_CONTENT" };

export type AbsolutePath = string & { readonly __brand: unique symbol };

export interface ResolveForeignAgentSourcesOptions {
  readonly workspaceRoot: AbsolutePath | string;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly homeDir?: string;
  readonly platform?: NodeJS.Platform;
  readonly managedConfigFiles?: readonly string[];
  readonly additionalConfigRoots?: readonly string[];
}

export function resolveForeignAgentSources(
  options: ResolveForeignAgentSourcesOptions,
): readonly ObservableAgentSource[];
```

Implement small helpers `addConfigRoot`, `addDefinitionRoot`, `walkAncestors`, and `dedupeByCanonicalPath`. `SDD_MODEL_ROUTING_EXTRA_WATCHED_CONFIG_ROOTS` is path-delimiter-separated and each entry names a config root. Exact managed files enter only through `managedConfigFiles`. Do not retain the rev 2 `...AGENT_DIRS` variable.

`managedConfigFiles` defaults to an empty array in production when omitted — this repository has no verified, documented set of per-platform OpenCode-managed config paths for 1.18.9 to hardcode (design §5.3/§10, declared residual limitation). The option exists so embedding callers/tests can inject exact managed files. Operator env entries are config roots; do not reinterpret `SDD_MODEL_ROUTING_EXTRA_WATCHED_CONFIG_ROOTS` entries as exact files or agent directories, and do not invent default paths.

Remote `.well-known` configuration is not emitted as a filesystem source; rev 3 covers its effective result through the merged-config guard.

**Step 3: Verify GREEN**

Run: `npx tsx tests/foreign-agent-sources.test.ts`

Expected: PASS.

**Step 4: Commit**

```bash
git add src/infrastructure/opencode/foreign-agent-sources.ts tests/foreign-agent-sources.test.ts
git commit -m "feat(routing): resolve observable OpenCode agent sources"
```

### Task 3: Scan config, Markdown, modes, names, and links fail-closed

**Files:**
- Create: `src/infrastructure/opencode/foreign-agent-scan.ts`
- Create: `tests/foreign-agent-scan.test.ts`

**Step 1: Write failing scanner tests**

Create deep temporary workspaces and cover:

- Recursive `{agent,agents,mode,modes}/**/*.md` discovery.
- OpenCode's path-derived name and a YAML `name:` override; either may collide.
- Reserved names match case-insensitively.
- Workspace-owned agent files are allowed only when their canonical relative path and SHA-256 are present in the manifest allowlist.
- A reserved workspace mode, unlisted workspace agent, ancestor/global/custom agent, or inline top-level `agent` key is a finding. Inline `mode` is not added without a verified OpenCode 1.18.9 contract; mode directories remain covered.
- JSONC comments and trailing commas parse with `jsonc-parser`; strings containing `https://` remain intact.
- YAML aliases, arrays, non-string `name`, duplicate keys, malformed frontmatter, malformed JSON/JSONC, unreadable paths, and ambiguous source types produce inspection findings rather than being ignored.
- Directory symlinks/junctions and file symlinks are blocking findings and are never traversed. Add explicit symlink/junction test cases.
- Missing optional sources (`ENOENT`) are ignored.
- Findings are deterministic and contain no raw config content.

**Step 2: Verify RED**

Run: `npx tsx tests/foreign-agent-scan.test.ts`

Expected: FAIL with module-not-found.

**Step 3: Implement the pure scanner**

Use these public contracts:

```ts
export type ForeignAgentFindingKind =
  | "foreign-reserved-definition"
  | "owned-definition-mismatch"
  | "inspection-failure";

export interface ForeignAgentFinding {
  readonly kind: ForeignAgentFindingKind;
  readonly sourceLabel: string;
  readonly collidingName?: string;
  readonly reason: string;
}

export interface OwnedAgentFile {
  readonly relativePath: string;
  readonly sha256: string;
}

export function scanForForeignAgentDefinitions(input: {
  readonly workspaceRoot: AbsolutePath | string;
  readonly sources: readonly ObservableAgentSource[];
  readonly ownedAgentFiles: readonly OwnedAgentFile[];
  readonly reservedPrefix: string;
}): readonly ForeignAgentFinding[];
```

Implementation rules:

- Specify lexical absolute normalization followed by component-by-component lstat check for no-follow canonicalization before any realpath/read. Reject `isSymbolicLink()` and Windows junction/reparse behavior surfaced as a link.
- Use `readdirSync(..., { withFileTypes: true })`, sort names before recursion, and inspect only regular `.md` files while treating reserved-looking non-regular entries as foreign.
- Derive the OpenCode name from the relative Markdown path exactly as v1.18.9 does, then overlay a parsed string frontmatter `name` when present.
- Parse frontmatter between the first pair of `---` delimiters with `yaml.parseDocument` using a conservative schema and unique keys. Report parser errors.
- Parse both JSON and JSONC with `jsonc-parser.parse(raw, errors, { allowTrailingComma: true, disallowComments: false })`; inspect the top-level `agent` map. Do not invent an inline `mode` map contract.
- Hash workspace-owned candidates before allowlisting. A same-path hash mismatch is `owned-definition-mismatch`.
- Never write, delete, chmod, or repair a source.

**Step 4: Verify GREEN**

Run: `npx tsx tests/foreign-agent-scan.test.ts`

Expected: PASS.

**Step 5: Commit**

```bash
git add src/infrastructure/opencode/foreign-agent-scan.ts tests/foreign-agent-scan.test.ts
git commit -m "feat(routing): scan foreign agent provenance fail closed"
```

### Task 4: Add typed provenance and resolved-config failures

**Files:**
- Create: `src/infrastructure/opencode/foreign-agent-errors.ts`
- Create: `tests/foreign-agent-errors.test.ts`

**Step 1: Write failing tests**

Assert stable `name`, `code`, safe message, structured fields, and `instanceof Error` for:

```ts
ForeignAgentDefinitionError       // FOREIGN_AGENT_DEFINITION
ForeignAgentInspectionError       // FOREIGN_AGENT_INSPECTION
RoutedAgentDefinitionMismatchError // ROUTED_AGENT_DEFINITION_MISMATCH
ResolvedAgentConfigUnavailableError // RESOLVED_AGENT_CONFIG_UNAVAILABLE
```

Also assert messages do not contain supplied raw config bodies or prompt text.

**Step 2: Verify RED**

Run: `npx tsx tests/foreign-agent-errors.test.ts`

Expected: FAIL with module-not-found.

**Step 3: Implement minimal typed errors**

Store sanitized findings/mismatch keys as readonly structured properties. Split scanner findings so `inspection-failure` maps to `ForeignAgentInspectionError`; collisions and owned mismatches map to `ForeignAgentDefinitionError`. Do not place these classes in readiness: the scanner, generator, readiness, config observer, and task hook all depend on them.

**Step 4: Verify GREEN**

Run: `npx tsx tests/foreign-agent-errors.test.ts && npm run test:typecheck:strict`

Expected: PASS.

**Step 5: Commit**

```bash
git add src/infrastructure/opencode/foreign-agent-errors.ts tests/foreign-agent-errors.test.ts
git commit -m "feat(routing): add provenance guard error taxonomy"
```

### Task 5: Define one canonical generated-agent contract

**Precondition:** Read Task 0's spike notes before fixing the runtime
comparison contract. The generated Markdown remains exact in either branch;
only the observable runtime projection is conditional.

**Files:**
- Create: `src/infrastructure/opencode/routed-agent-definition.ts`
- Modify: `src/infrastructure/opencode/disk-agent-generator.ts`
- Create: `tests/routed-agent-definition.test.ts`
- Modify: `tests/model-route-disk-generator.test.ts`

**Step 1: Write failing contract tests**

For a manifest route, assert the canonical runtime definition has exactly:

```ts
{
  description: `Deterministic routed host for provider/model (host).`,
  mode: "subagent",
  hidden: true,
  model: "provider/model",
  permission: { task: { "*": "deny" } },
  prompt: `# host

Routed subagent bound to provider/model.
Do not edit this file directly.
Base Template Provenance: ...`
}
```

Assert rendered Markdown parses back to that object, contains no `name` override, and continues to contain both `mode: subagent` and `hidden: true`. Assert extra keys and alternate scalar types are rejected by the exact generated-descriptor contract. The runtime-comparison assertions must follow Task 0: strict exact projection in the full branch, or every confirmed observable field plus safe host-added defaults in the observed-field branch.

**Step 2: Verify RED**

Run: `npx tsx tests/routed-agent-definition.test.ts`

Expected: FAIL because the shared module does not exist.

**Step 3: Extract the shared contract**

Export:

```ts
export interface CanonicalRoutedAgentDefinition { /* exact fields above */ }
export function buildCanonicalRoutedAgentDefinition(route: ManifestRouteEntry): CanonicalRoutedAgentDefinition;
export function renderCanonicalRoutedAgentMarkdown(route: ManifestRouteEntry): string;
export function compareResolvedAgentDefinition(actual: unknown, expected: CanonicalRoutedAgentDefinition): readonly string[];
```

Move descriptor construction out of `disk-agent-generator.ts` and call the shared renderer. The manifest `hostName` is the map key / derived Markdown name, not a field added to the runtime entry. In the full branch, comparison is exact after documented normalization of plain objects only: no unexpected behavioral keys, no functions/getters, correct primitive types, exact prompt bytes, exact model, `mode === "subagent"`, `hidden === true`, and task wildcard denied. In the observed-field branch, encode the exact field/default projection recorded by Task 0 and compare every observable behavioral field; do not silently degrade to key-presence-only validation.

The `hidden` flag is discoverability only; `mode: subagent` is the direct `opencode run --agent` barrier. Retain and test both.

**Step 4: Verify GREEN and regressions**

Run: `npx tsx tests/routed-agent-definition.test.ts && npx tsx tests/model-route-disk-generator.test.ts`

Expected: PASS with generated bytes unchanged unless the canonical rev 3 spec intentionally requires a correction.

**Step 5: Commit**

```bash
git add src/infrastructure/opencode/routed-agent-definition.ts src/infrastructure/opencode/disk-agent-generator.ts tests/routed-agent-definition.test.ts tests/model-route-disk-generator.test.ts
git commit -m "refactor(routing): share canonical routed agent definition"
```

### Task 6: Implement the read-only merged-config observer

**Precondition:** Task 0's spike notes must state which validation branch
applies (full canonical projection or observed-field projection per design §7.0).
Implement whichever branch the spike confirmed; do not assume full
field-by-field validation is safe without that record.

**Files:**
- Create: `src/infrastructure/opencode/resolved-agent-config-guard.ts`
- Create: `tests/resolved-agent-config-guard.test.ts`

**Step 1: Write failing observer tests**

Cover:

1. Before observation, `assertMatches(manifest)` throws `ResolvedAgentConfigUnavailableError`.
2. Full branch: exact reserved key set and exact canonical definitions pass; observed-field branch: absent reserved keys pass but every present entry matches the recorded projection.
3. In both branches, duplicate-equivalent reserved keys and a sole differently-cased key throw `RoutedAgentDefinitionMismatchError`; the full branch also rejects missing/extra reserved keys.
4. Every field that Task 0 proves observable rejects changed value/type or an unexpected behavior-changing key. Full-branch tests include model, prompt, description, mode, hidden, and permission; observed-field tests include only the confirmed projection and safe host defaults. Add explicit property replacement, deletion, and mutation test coverage.
5. Non-reserved agents are ignored.
6. The observer rereads the live `cfg.agent` reference by accepting a getter (`getAgentConfig: () => unknown`); a replacement/mutation after `observe()` is detected by the next assertion.
7. A deeply frozen config and a write-trapping `Proxy` prove `observe()` and `assertMatches()` perform zero writes.
8. `observe(undefined)` records that the hook ran but remains unavailable for a non-empty manifest.
9. `recordObservationFailure(error)` never throws and returns the normalized/bounded `Error`; the next `assertMatches(manifest)` call throws `RoutedAgentDefinitionMismatchError`, except that a genuinely absent/unusable observation throws `ResolvedAgentConfigUnavailableError`. A newer `observe()` starts a new observation generation, and a passing validation clears the older failure; a failed current generation remains blocking.
10. `recordAuditFailure(error)` never throws and never clears `recordedFailure`; `assertMatches()` still throws the original recorded observation failure regardless of whether an audit failure was also recorded.

**Step 2: Verify RED**

Run: `npx tsx tests/resolved-agent-config-guard.test.ts`

Expected: FAIL with module-not-found.

**Step 3: Implement the guard**

```ts
export class ResolvedAgentConfigGuard {
  private observed = false;
  private getAgents: (() => unknown) | undefined;
  private recordedFailure: Error | undefined;
  private recordedAuditFailure: Error | undefined;

  observe(getAgents: () => unknown): void {
    this.observed = true;
    this.getAgents = getAgents; // retain zero-write getter reference; never clone or mutate
    this.recordedFailure = undefined; // a new generation supersedes stale state
    this.recordedAuditFailure = undefined;
  }

  recordObservationFailure(error: unknown): Error {
    // Called from inside the config hook's catch block. Never throws.
    // Returns the normalized/bounded error so the caller can build a
    // sanitized `routing.config.blocked` audit entry from it without
    // re-deriving normalization logic at the call site.
    const bounded = error instanceof Error ? error : new Error(String(error));
    this.recordedFailure = bounded;
    return bounded;
  }

  recordAuditFailure(error: unknown): void {
    // Called when appending the `routing.config.blocked` audit entry for
    // the current recorded failure itself throws. Never throws. Does not
    // clear `recordedFailure` — dispatch must remain blocked regardless of
    // whether the audit sink is healthy.
    this.recordedAuditFailure = error instanceof Error ? error : new Error(String(error));
  }

  assertMatches(manifest: Manifest): void {
    // If the current generation recorded a failure, throw the bounded guard
    // error for that generation. Otherwise: require observation; validate a
    // plain record; apply Task 0's branch; group reserved keys
    // case-insensitively while requiring the sole actual key to equal the
    // canonical hostName; build expected definitions; compare each entry.
  }
}
```

Use own-property descriptors while reading to reject accessors rather than executing them. Normalize arbitrary config-hook exceptions into bounded `RoutedAgentDefinitionMismatchError` metadata; never rethrow a raw config/parser error that could carry content. The class must have no method that returns a mutable config object.

**Step 4: Verify GREEN**

Run: `npx tsx tests/resolved-agent-config-guard.test.ts && npm run test:typecheck:strict`

Expected: PASS.

**Step 5: Commit**

```bash
git add src/infrastructure/opencode/resolved-agent-config-guard.ts tests/resolved-agent-config-guard.test.ts
git commit -m "feat(routing): validate merged routed agent definitions read only"
```

### Task 7: Gate generation and signed readiness on filesystem provenance

**Files:**
- Modify: `src/infrastructure/opencode/disk-agent-generator.ts`
- Modify: `src/infrastructure/opencode/model-route-readiness.ts`
- Create: `tests/foreign-agent-guard-generator.test.ts`
- Create: `tests/foreign-agent-guard-readiness.test.ts`

**Step 1: Write failing integration tests**

- Generator: a foreign reserved Markdown/config/mode definition blocks before sweep, write, or manifest mutation; removing it permits retry, proving lock release.
- Generator: a workspace reserved file not in the previous manifest blocks; an unchanged manifest-owned file is allowed.
- Readiness `issue()` and `verify()` rescan uncached and throw the typed provenance/inspection error.
- Owned-file tamper is rejected before the new scanner: generation keeps
  `ModifiedOwnedFileError`, readiness keeps `AttestationMismatchError`, and a
  direct standalone `assertNoForeignAgentDefinitions()` call maps the same
  allowlist mismatch to `ForeignAgentDefinitionError`.
- Custom roots and config env sources are forwarded.
- An unreadable or malformed source blocks rather than becoming an attestation mismatch.

**Step 2: Verify RED**

Run: `npx tsx tests/foreign-agent-guard-generator.test.ts && npx tsx tests/foreign-agent-guard-readiness.test.ts`

Expected: FAIL because no integration gate runs.

**Step 3: Add a shared assertion facade**

In `foreign-agent-scan.ts`, export:

```ts
export function assertNoForeignAgentDefinitions(input: ScanInput): void {
  const findings = scanForForeignAgentDefinitions(input);
  const inspection = findings.filter((f) => f.kind === "inspection-failure");
  if (inspection.length) throw new ForeignAgentInspectionError(inspection);
  if (findings.length) throw new ForeignAgentDefinitionError(findings);
}
```

Add `sourceOptions`/`additionalConfigRoots` to generator and readiness options. In `generate()`, call it inside the existing lock after verifying the previous owned hashes and before the unconditional sweep. In readiness, call it from `assertCurrentState()` only after the existing manifest and owned-file hash checks, and before issuing or accepting attestation. Build the workspace allowlist from `manifest.routes[].agentFile` only, not command files. Do not change the existing ordered error class for owned-file tamper.

Because the boot manager already issues readiness through `ModelRouteReadiness`, this preserves boot-manager ownership and guarantees the scan precedes readiness without adding a config-hook lifecycle path.

**Step 4: Verify GREEN and regressions**

Run: `npx tsx tests/foreign-agent-guard-generator.test.ts && npx tsx tests/foreign-agent-guard-readiness.test.ts && npx tsx tests/model-route-disk-generator.test.ts && npx tsx tests/model-route-canary-readiness.test.ts && npx tsx tests/model-route-boot-control.test.ts`

Expected: PASS.

**Step 5: Commit**

```bash
git add src/infrastructure/opencode/disk-agent-generator.ts src/infrastructure/opencode/model-route-readiness.ts src/infrastructure/opencode/foreign-agent-scan.ts tests/foreign-agent-guard-generator.test.ts tests/foreign-agent-guard-readiness.test.ts
git commit -m "feat(routing): gate generation and readiness on provenance"
```

### Task 8: Wire the config observer and per-dispatch validation

**Files:**
- Modify: `src/bootstrap/index.ts`
- Modify: `src/infrastructure/logging/model-route-audit.logger.ts`
- Modify: `src/infrastructure/opencode/model-route-task-hook.ts`
- Modify: `src/infrastructure/runtime/windows-model-route-boot-manager.ts`
- Modify: `src/application/regenerate-fleet-agents/regenerate-fleet-agents.input.ts`
- Modify: `src/application/regenerate-fleet-agents/regenerate-fleet-agents.use-case.ts`
- Modify: `src/cli/model-route-agents.ts`
- Modify: `src/cli/model-route-boot.ts`
- Modify: `tests/bootstrap-clean-startup.test.ts`
- Modify: `tests/model-route-audit.test.ts`
- Modify: `tests/model-route-boot-composition.test.ts`
- Modify: `tests/windows-boot-manager.test.ts`
- Create: `tests/foreign-agent-config-hook.test.ts`
- Create: `tests/foreign-agent-guard-task-hook.test.ts`
- Create: `tests/foreign-agent-guard-bootstrap.test.ts`

**Step 1: Update the obsolete-config-hook regression test, then write failing bootstrap/config-hook tests**

Update `tests/bootstrap-clean-startup.test.ts` per design §7.0: change the
`Object.keys(hooks).sort()` assertion to expect exactly
`["config", "tool.execute.before"]`, and change
`Object.hasOwn(hooks, "config")` to assert `true` with an updated message
explaining this is the read-only provenance-validation hook, not the
rejected routing hook. Leave the `bootstrapSource` pattern assertion
(`/model-route-config-hook|disabled-not-ready|ModelRouteConfigUnsupportedError|OpenCodeConfig/`)
and the `obsoleteProductionFiles` list untouched — those still correctly
guard against reintroducing the rejected *routing* hook and its files, which
this change does not touch.

Then instantiate `SddPlugin`, obtain returned hooks, and assert:

- A `config` callback exists and is limited to
  `resolvedGuard.observe(cfg.agent)`, immediate read-only validation when a
  valid manifest is available, and the bounded audit-on-failure path; it has no
  routing or mutation side effect.
- Passing a frozen/proxied config causes no writes.
- Full branch: exact merged config passes silently. Observed-field branch:
  the confirmed partial projection passes, including an observed map with no
  reserved entries. In both cases the hook's promise resolves.
- A remote/managed/other-plugin effective override with a mismatched reserved entry causes the hook to record the failure via `recordObservationFailure()` (never throw/reject); the *next* `assertMatches()` call — at dispatch — is what throws `RoutedAgentDefinitionMismatchError`.
- No manifest plus a reserved merged entry blocks at dispatch (via the same recorded-failure path); no manifest and no reserved merged entry is not a config-hook failure. If a manifest appears later, dispatch applies the selected Task 0 branch rather than assuming full-set equality.
- A newer valid config observation clears a prior recorded failure; a failed
  current observation remains blocking.
- A failed observation durably appends a sanitized
  `routing.config.blocked` entry. An injected audit append failure never
  rejects the config hook and still leaves dispatch blocked.
- The returned config object is never augmented with fleet agents.

**Step 2: Write failing task-hook tests**

For both explicit grammar and natural-intent paths:

- `ResolvedAgentConfigUnavailableError` blocks before `output.args.subagent_type` changes.
- A merged definition mismatch blocks and records its original error class.
- Exact merged config passes after signed readiness.
- A live-map mutation between config observation and dispatch is detected.
- Filesystem provenance/inspection errors remain typed and are not wrapped as `AttestationUnavailableError`.
- The config-observer mismatch surfaces as
  `RoutedAgentDefinitionMismatchError` (or
  `ResolvedAgentConfigUnavailableError` for no usable observation), never as
  an arbitrary raw parser/config exception.

**Step 3: Verify RED**

Run: `npx tsx tests/foreign-agent-config-hook.test.ts && npx tsx tests/foreign-agent-guard-task-hook.test.ts`

Expected: FAIL.

**Step 4: Implement strictly read-only wiring**

Create one `ResolvedAgentConfigGuard` in the `SddPlugin` closure. Return a config hook shaped as:

```ts
config: async (cfg) => {
  try {
    resolvedAgentGuard.observe(() => cfg.agent);
    assertResolvedFleetIfManifestExists(workspaceRoot, resolvedAgentGuard);
  } catch (error) {
    const bounded = resolvedAgentGuard.recordObservationFailure(error);
    try {
      await configAuditLogger.append(toConfigBlockedAuditEntry(bounded));
    } catch (auditError) {
      resolvedAgentGuard.recordAuditFailure(auditError);
    }
    // Never rethrow: neither validation nor audit I/O may reject this hook.
  }
},
```

The exact helper names may differ, but the behavior may not. Extend
`ModelRouteAuditEntry` with a dedicated bounded `routing.config.blocked` shape
and add logger redaction/bounding tests. The helper may read the manifest but
must never generate it or issue readiness. `recordObservationFailure()`
normalizes arbitrary exceptions to a safe guard error; an unusable observation
remains `ResolvedAgentConfigUnavailableError`, every other config mismatch is
`RoutedAgentDefinitionMismatchError`. A new `observe()` generation supersedes
the previous recorded state. `observe()` and both record methods never throw.
Pass the same guard into both `ModelRouteTaskHook` construction sites. In each
task-hook route path, keep signed readiness verification and
`resolvedAgentGuard.assertMatches(manifest)` inside the same guarded
try/catch, with the assertion after readiness and before success audit/rewrite.
This is where the current config-hook failure surfaces and blocks the `Task`
call while still producing the correct blocked audit entry.

Extend both catch sites to preserve and audit all four provenance error classes. Never downgrade them to `AttestationUnavailableError`.

Add `resolveAdditionalWatchedConfigRoots()` for `SDD_MODEL_ROUTING_EXTRA_WATCHED_CONFIG_ROOTS` and forward roots through bootstrap, regeneration input/use case, CLI generator, task hook, readiness, and the production boot composition in `src/cli/model-route-boot.ts`. Each entry is a config root. Delete/avoid any rev 2 `SDD_MODEL_ROUTING_EXTRA_WATCHED_AGENT_DIRS` plumbing.

Readiness is issued and renewed in production exclusively by
`WindowsModelRouteBootManager` (`runStart()` calling `issue()` at
`windows-model-route-boot-manager.ts:441`, and `renewAttestation()` calling
`issue()` at `:517`) — not only by the task hook's `verify()` calls. Forward
`additionalConfigRoots` to both `new ModelRouteReadiness` construction sites
inside the boot manager as well, or operator-configured extra roots are
silently ignored on the exact path that mints the signed attestation.
Add the option to `WindowsModelRouteBootManagerOptions`, preserve it on the
manager, pass it to both readiness constructions, and prove in
`tests/model-route-boot-composition.test.ts` that the production CLI resolves
and forwards the env roots. A manager-only unit test is insufficient because
the real production constructor lives in `src/cli/model-route-boot.ts`.

**Step 5: Verify GREEN and ordering**

Run: `npx tsx tests/foreign-agent-config-hook.test.ts && npx tsx tests/foreign-agent-guard-task-hook.test.ts && npx tsx tests/foreign-agent-guard-bootstrap.test.ts && npx tsx tests/model-route-audit.test.ts && npx tsx tests/model-route-boot-composition.test.ts && npx tsx tests/windows-boot-manager.test.ts && npx tsx tests/model-route-task-hook.test.ts && npx tsx tests/natural-model-routing-task-hook.test.ts && npx tsx tests/fleet-agent-regeneration.test.ts && npx tsx tests/model-route-cli.test.ts`

Expected: PASS. Tests explicitly assert the output rewrite is the final operation after both readiness and merged-definition validation.

**Step 6: Commit**

```bash
git add src/bootstrap/index.ts src/infrastructure/logging/model-route-audit.logger.ts src/infrastructure/opencode/model-route-task-hook.ts src/infrastructure/runtime/windows-model-route-boot-manager.ts src/application/regenerate-fleet-agents src/cli/model-route-agents.ts src/cli/model-route-boot.ts tests/bootstrap-clean-startup.test.ts tests/model-route-audit.test.ts tests/model-route-boot-composition.test.ts tests/windows-boot-manager.test.ts tests/foreign-agent-config-hook.test.ts tests/foreign-agent-guard-task-hook.test.ts tests/foreign-agent-guard-bootstrap.test.ts
git commit -m "feat(routing): enforce merged agent provenance before dispatch"
```

### Task 9: Wire suites, document the boundary, and verify end to end

**Files:**
- Modify: `package.json`
- Modify: `README.md`
- Modify: `tests/model-route-real-host-canary.integration.ts`
- Modify: `docs/plans/2026-07-31-foreign-agent-provenance-guard-design.md` only if implementation exposes a factual correction

**Step 1: Add every new test to `test:model-routes`**

Append every new focused script from Tasks 1-8 (`foreign-agent-parser-dependencies`,
`foreign-agent-sources`, `foreign-agent-scan`, `foreign-agent-errors`,
`routed-agent-definition`, `resolved-agent-config-guard`, both generator/readiness
integrations, config-hook, task-hook, and bootstrap). Keep the existing routing
tests unchanged.

**Step 2: Document operator behavior**

Add a concise README section covering:

- Reserved `sdd-mr-v1-` provenance is enforced fail-closed.
- Generated agents remain `hidden: true` and `mode: subagent`; hidden affects discovery, subagent mode blocks direct primary-agent CLI selection.
- `SDD_MODEL_ROUTING_EXTRA_WATCHED_CONFIG_ROOTS` extends observable roots.
- Other plugins invoking a valid routed agent are outside this plugin's responsibility, but merged overrides of reserved definitions are blocked. This includes runtime registrations that bypass `cfg.agent` config structures.
- Explicit no-auto-remediation behavior: invalid definitions block silently and wait for manual removal, instead of auto-deleting files.
- `Hooks.config` is a read-only validator and does not replace external boot manager + signed attestation. Add an automated documentation contract test for this statement.

**Step 2b: Extend the real-host CLI-selection test**

Extend `tests/model-route-real-host-canary.integration.ts` to assert
`opencode run --agent <hostName>` refuses to select a routed host as a
primary agent (design §11.4). This is the only test that empirically proves
`mode: subagent` is the actual CLI-selection barrier §4 relies on. Accept
either an explicit CLI rejection or an independently observed selected-agent
identity that is not `hostName`; do not pass on a message substring alone. Ensure non-empty assertion logic is used so the test cannot falsely pass if output is empty.

**Step 3: Run the gated real-host proof**

Run `npm run canary:model-routes:real` with the explicit OpenCode 1.18.9 host,
boot nonce, signing key, parent-model map, and workspace variables required by
the harness. A gated/skipped exit or unavailable host leaves REQ-11 and Task 9
blocked; it is not a passing result.

**Step 4: Run focused verification**

Run: `npm run test:model-routes && npm run test:typecheck:strict && npm run build`

Expected: all PASS, zero TypeScript errors.

**Step 5: Run full regression suite**

Run: `npm run test:all`

Expected: PASS.

**Step 6: Inspect the final diff**

Run: `git diff --check && git status --short && git log --oneline -10`

Expected: no whitespace errors; only intended implementation files remain changed; each task has its own commit.

**Step 7: Commit suite/docs wiring**

```bash
git add package.json README.md tests/model-route-real-host-canary.integration.ts docs/plans/2026-07-31-foreign-agent-provenance-guard-design.md docs/plans/2026-07-31-foreign-agent-provenance-guard-spec.md
git commit -m "test(routing): verify foreign agent provenance guard rev 3"
```

**Step 8: Refresh and sync PMC**

Run: `pmc refresh-context --enrich` followed by `pmc sync-context`.

Update the canonical specification memory
`0ea11a80-4b99-4432-9d07-572b22fd05c7` only after all checks pass, recording
Task 0's selected branch, implementation commits, real-host evidence, and
residual risks. Keep topic key
`decision/foreign-agent-provenance-guard-spec-approved-2026-07-31` active and
materialize/update its topic alias. Update design memory
`8137f8f5-fc1f-4d34-9c2b-03798e261a64` only if implementation produced a
factual design correction; it is no longer the canonical implementation
completion record.

---

## Required residual-risk statement

The completed implementation must state, without overstating the guarantee:

- Remote and managed source provenance may be unobservable as raw files. Their effective reserved definitions are covered by full merged-config equality only in the full Task 0 branch; the observed-field branch covers every field and entry the pinned host actually exposes and must state that narrower guarantee.
- A later plugin mutation after this plugin's last validation remains an OpenCode hook-ordering boundary; retaining the live map and validating immediately before rewrite minimizes but cannot eliminate a post-validation mutation.
- Direct filesystem changes after the final pre-dispatch scan are a TOCTOU boundary; readiness hashes and uncached scans narrow it.
- Calls made independently by other plugins are outside scope by explicit product decision.
- `hidden` is not authorization. `mode: subagent` is the direct CLI-selection barrier in the pinned OpenCode contract.
