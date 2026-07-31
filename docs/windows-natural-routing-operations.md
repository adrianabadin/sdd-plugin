# Windows Natural Model Routing Operations

This guide covers the WU5 operator workflow for deterministic model routing.
The production contract requires OpenCode `1.18.9`, a generated manifest, a
live catalog readback, a startup canary, and a fresh readiness attestation.

## Prerequisites

- Windows host with OpenCode `1.18.9` installed and available as `opencode.cmd`.
- A project workspace containing `.opencode/`.
- A configured `config/model-routing/routes.json` whitelist.
- A dedicated SQLite database initialized by the plugin.

Generate the owned route descriptors from the repository root:

```powershell
npm run generate:model-routes -- $workspaceRoot config/model-routing/routes.json
```

The generator writes only under `$workspaceRoot/.opencode/sdd-model-routing/`.
Review `manifest.json` before booting; its `requiredOpenCodeVersion` must be
`1.18.9`.

## Boot, status, and stop

The supervisor is long-lived and keeps the boot identity/signing key in the
supervised process environment only:

```powershell
npx tsx src/cli/model-route-boot.ts start $workspaceRoot
npx tsx src/cli/model-route-boot.ts status $workspaceRoot
npx tsx src/cli/model-route-boot.ts stop $workspaceRoot
```

`start` must reach `ready`. `status` is read-only and reports the attestation,
expiry, and lock state. Use `stop` for an operator restart or recovery; do not
delete `attestation.json`, `generator.lock`, or `boot-control.json` manually
while a supervisor may still be alive.

Exit codes identify the first failure boundary:

- `3`: routes.json validation error or catalog readback missing a manifest route.
- `4`: path safety / disk safety / modified-owned-file error or startup canary failed.
- `5`: generator lock contention / stale lock unrecoverable or manifest missing/invalid.
- `6`: manifest invalid.
- `7`: descriptor budget exceeded or stale lock cannot be safely recovered.
- `8`: sweep incomplete error (owned file deletion failed during pre-generation sweep).
- `1`: database/audit initialization failure or unexpected failure.

## Fleet Agent Regeneration & Cold-Start Semantics

Fleet agent regeneration runs pre-spawn during manual CLI execution (`generate:model-routes`) and supervised boot (`model-route-boot start`):

1. **Persisted-Catalog Semantics**:
   - Pre-spawn route filtering queries the **persistent database catalog** (`existsCanonical`), NOT a live un-started host catalog.
   - Routes not yet present in the database catalog (or never synchronized) are excluded as `NOT_CONNECTED`.

2. **Cold-Start & Fleet Convergence**:
   - On a fresh install with an empty database catalog, pre-spawn filtering excludes disconnected routes and converges to a valid **empty fleet manifest** (`routes: []`).
   - `generation.fleet.empty` warning audit event is recorded with `excludedCount` and `durationMs` (no detail field).
   - Post-spawn catalog sync populates the database during boot, but does **not** mutate the fleet during the same boot.
   - The operator must **restart the supervised boot** after initial sync to generate newly connected routed agents from the populated catalog.

3. **Quarantine & Audit Contract**:
   - Permanent quarantines (`provider`, `model`, `modelProvider`) exclude affected routes at generation time as `PERMANENTLY_QUARANTINED` with warning audit events (`generation.route.excluded`).
   - TTL-only quarantines remain included at generation time and are enforced dynamically at dispatch time.
   - Pre-generation sweep validates previous manifest hashes and unconditionally sweeps owned prefix files (`.opencode/agents/sdd-mr-v1-*.md` and `.opencode/commands/sdd-mr-canary-v1-*.md`).


## Real-host canary evidence

Synthetic attestations are not release evidence. With a real OpenCode host
running on `127.0.0.1:4096`, provide explicit non-sentinel values:

```powershell
$env:OPENCODE_CANARY_REAL = "1"
$env:OPENCODE_CANARY_URL = "http://127.0.0.1:4096"
$env:OPENCODE_CANARY_BOOT_ID = "<fresh-boot-id>"
$env:OPENCODE_CANARY_SIGNING_KEY = "<ephemeral-shared-secret>"
$env:OPENCODE_CANARY_PARENT_MODELS = '{"provider/model":"distinct-parent/model"}'
npm run canary:model-routes:real
```

The canary must report `status: "ATTESTED"`, the exact OpenCode version, and
evidence for every manifest route. Record that JSON output and the attestation
path in PMC as WU5 evidence. If the gate variables are absent, the command
must remain blocked; that is an expected safe outcome.

## Full real-host routing E2E

Only run this after the canary has issued `attestation.json`:

```powershell
$env:OPENCODE_E2E_ROUTING = "1"
$env:OPENCODE_E2E_URL = "http://127.0.0.1:4096"
$env:OPENCODE_E2E_BOOT_ID = "<same-live-boot-id>"
$env:OPENCODE_E2E_SIGNING_KEY = "<same-live-signing-secret>"
$env:OPENCODE_E2E_DB_PATH = "<dedicated-db-path>"
$env:OPENCODE_E2E_WORKSPACE = "<workspace-root>"
npm run e2e:model-routes
```

The test must report `status: "ATTESTED"` and the expected owned
`subagent_type`. A missing host, wrong version, missing manifest, or missing
real attestation is a block, not a pass.

## Rollback

For an emergency rollback, stop the supervisor first, disable natural routing
in the deployment wrapper with `SDD_NATURAL_ROUTING=off`, and restart the host:

```powershell
npx tsx src/cli/model-route-boot.ts stop $workspaceRoot
$env:SDD_NATURAL_ROUTING = "off"
```

The current bootstrap contract fails closed when routing credentials are
missing; the `SDD_NATURAL_ROUTING` switch is therefore a deployment/operator
rollback marker and must be enforced by the host wrapper/configuration. It is
not treated as proof that a routing call succeeded. Re-enable only after
regenerating descriptors and obtaining fresh real-host canary evidence.

## Incident handling

Preserve the routing directory, audit log, and supervisor output for review.
Never copy boot identities or signing keys into tickets, audit entries, `.env`
files, or PMC. If boot fails after catalog sync or canarying, use `status`,
inspect the reported error code, and restart only after the host/catalog issue
is corrected.
