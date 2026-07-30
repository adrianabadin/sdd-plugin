# WU4 Remediation Handoff — natural-model-routing security / failure-mode suite

> Handoff package for the agent that will implement the WU4 remediation.
> Source: PMC/engram `sdd/natural-model-routing/wu4-remediation-design` (#2400) and
> `sdd/natural-model-routing/wu4-gaps` (#2401). Both generated from a fresh Opus 5
> independent re-verification of commit `47dedc2` (WU4 apply), which returned
> **FAIL** (verify-report Engram #2397): 3 CRITICAL, 7 WARNING, 2 SUGGESTION.
>
> STRICT TDD MODE IS ACTIVE for this project. Follow RED → GREEN → REFACTOR for
> every fix below. Test runner (focused): `npx tsx tests/natural-routing-security-failures.test.ts`.
> Also run `npm run test:typecheck:strict` and `npm run build`, plus the 14-suite
> regression sweep listed in "Exit criteria" below.

---

## Part 1 — Gap Catalog (tracking checklist)

Status legend: OPEN = not yet remediated. All 12 entries are OPEN at time of writing.

### C1 — Non-hermetic suite; PATH-dependent `whoami` in production code
- **Severity**: CRITICAL — **Status**: OPEN
- **Where**: `src/infrastructure/opencode/model-route-readiness.ts:250` (`execFileSync("whoami", ["/user"])`), `:254`/`:259`/`:261` (bare `icacls`/`whoami`), rethrow `:264`. **Duplicated** at `src/infrastructure/runtime/windows-model-route-boot-manager.ts:640-656`. Failure surfaces at `tests/natural-routing-security-failures.test.ts:514`.
- **Root cause**: two defects. (a) Bare binary names are resolved by PATH; Git-for-Windows' POSIX `whoami` precedes `C:\Windows\System32` in the repo's default shell and rejects `/user`, so the ACL step throws. (b) The `catch` at `:264` relabels any tooling failure as `AttestationMismatchError` / `ATTESTATION_MISMATCH` — an environment fault masquerading as a security attestation mismatch. Consequence: the suite exits 1 in the default shell (sections 5-8b never run) and only passes with `System32` manually first on PATH.
- **Resolution (D1+D2+D3)**: new `src/infrastructure/runtime/windows-acl.ts` with a single `applyCurrentUserAcl` resolving binaries via `path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", exe)`; both call sites delete their local copy and import it. New `AclRestrictionError { code: "ACL_RESTRICTION_FAILED" }` thrown from the helper, propagating undisguised (fail-closed preserved, only the label changes). Ships inside the WU4 remediation commit as `tasks.md` item `4.4 (WU3 carve-out)`.
- **Acceptance**: `npx tsx tests/natural-routing-security-failures.test.ts` exits 0 in the default Git Bash shell with no PATH manipulation.

### C2 — Tautological assertion (`bootIdentityValue` never inserted)
- **Severity**: CRITICAL — **Status**: OPEN
- **Where**: `tests/natural-routing-security-failures.test.ts:766`; variable declared `:727`; `baseEntry` `:729-751`.
- **Root cause**: the assertion `!entryJson.includes(bootIdentityValue)` cannot fail because the value is never written into the entry. Cited as delivered "no key material" coverage in `tasks.md` 4.1 and apply-progress §8(b).
- **Resolution (D4)**: insert `bootIdentity: bootIdentityValue` and `signingKey: <hex>` into `baseEntry` (goes RED — neither key is in `SENSITIVE_KEYS`), then GREEN with +1 line adding `bootidentity`, `bootid`, `signingkey`, `hmackey` to `SENSITIVE_KEYS` in `src/infrastructure/logging/model-route-audit.logger.ts:78-88`. Chosen over deleting the assertion because it covers a genuine leak vector.

### C3 — Ghost `.env` assertions inside an always-false guard
- **Severity**: CRITICAL — **Status**: OPEN
- **Where**: `tests/natural-routing-security-failures.test.ts:543-548`.
- **Root cause**: `if (existsSync(envFile))` over a fresh `mkdtempSync` workspace that nothing ever writes `.env` into; the two assertions never execute. `tasks.md` 4.1 claims `.env` cleanliness as proven.
- **Resolution (D5)**: seed a benign `.env` (`FOO=bar\n`) in `workspaceRoot` before boot 1, drop the guard, and assert the file exists, is byte-for-byte unchanged, and contains neither `identity1` nor the key hex. Chosen over `assert.equal(existsSync(envFile), false)` because the real risk is production appending secrets to an operator's existing `.env`, not creating one.

### W1 — Line count misreported; ≤800-line budget actually breached
- **Severity**: WARNING — **Status**: OPEN
- **Where**: `tests/natural-routing-security-failures.test.ts` (833 lines per `wc -l`); false `796` figure in commit `47dedc2` message, `sdd/natural-model-routing/tasks.md:69` and `:81`, and `apply-progress.md` (Status, Files Changed, Risk 2, "99.5% of the 800 budget").
- **Root cause**: stale count carried forward after the final refactor; 833 test + 6 logger = 839 real delta.
- **Resolution (D6)**: extract ≈195 lines of shared fixtures to `tests/helpers/model-routing-fixtures.ts` (existing repo convention alongside `init-child-runner.ts`, `temp-database.ts`), projecting ≈695 test / ≈205 helper — both under budget, **no `size:exception` needed**. Replace every `796` with the measured final count (D10).

### W2 — D3 ownership claim overstated (ACL/scrubbing untested)
- **Severity**: WARNING — **Status**: OPEN
- **Where**: `tasks.md:83` and the commit body claim "WU4 solo TESTEA su comportamiento"; `grep -rn "icacls\|scrub"` on the test file matches only the header comment at `:19`.
- **Root cause**: the "do not modify WU3" half of D3 is honored (commit touches exactly 4 files, no WU3 implementation), but zero assertions exist on either behavior; the ACL path is exercised only incidentally — which is how C1 surfaced.
- **Resolution (D7)**: add win32-gated **Section 9** asserting (a) `applyCurrentUserAcl` succeeds and `icacls.exe` shows inheritance removed with only the current user granted, (b) with `SystemRoot` stubbed to an empty dir it throws `AclRestrictionError` / `ACL_RESTRICTION_FAILED` and **not** `AttestationMismatchError`. Attach env scrubbing is **restated honestly** as WU3-verified in `windows-boot-manager.test.ts`, not duplicated.

### W3 — "fsync durable" claimed but never asserted
- **Severity**: WARNING — **Status**: OPEN
- **Where**: `tests/natural-routing-security-failures.test.ts:757` is a bare comment. Production genuinely fsyncs at `src/infrastructure/logging/model-route-audit.logger.ts:176` (inside `append()`, before it resolves) and `:190` (in `close()`).
- **Root cause**: a code comment was counted as coverage in `tasks.md` 4.1, the commit message, and apply-progress.
- **Resolution (D8)**: after `await logger.append(baseEntry)` and **before** `close()`, read via an independent descriptor and assert the complete line + trailing `\n` is present and `statSync(p).size === Buffer.byteLength(raw)`. Documented boundary: Node cannot observe a physical fsync; this is the strongest observable proxy and would fail if `:176` were removed. Monkey-patching `fs.fsyncSync` rejected as brittle.

### W4 — DEL/ESC control-char coverage weaker than claimed
- **Severity**: WARNING — **Status**: OPEN
- **Where**: `tests/natural-routing-security-failures.test.ts:683-696`.
- **Root cause**: `thrown` is declared once at `:686` and reused across NUL/DEL/ESC without reset and without a per-case `instanceof NaturalIntentMalformedError` check. If DEL (`:692`) or ESC (`:695`) stopped throwing, the retained NUL error would still satisfy both assertions. NUL rejection at `:689` is solid and must be preserved.
- **Resolution (D9)**: rewrite as a table-driven loop over `[NUL, DEL, ESC]` with `let thrown: unknown = null` **inside** the body plus a per-case identity assertion before the `CONTROL_CHARACTER` code check. Net ≈ −2 lines.

### W5 — Injection fixtures accept either outcome
- **Severity**: WARNING — **Status**: OPEN
- **Where**: `tests/natural-routing-security-failures.test.ts:313-322` (5 fixtures at `:273-299`).
- **Root cause**: `outcome` may be `rewritten` OR `blocked` per fixture with no per-fixture pin, so a regression flipping a fixture between the two passes silently. The cross-cutting "no adversarial substring in the audit entry" invariant at `:329` remains genuinely strong.
- **Resolution (D9)**: add an `expected: "rewritten" | "blocked"` field to each fixture row and `assert.equal(outcome, expected)` before the branch. True values determined empirically at apply time — **do not guess**.

### W6 — Fabricated precision in evidence counts
- **Severity**: WARNING — **Status**: OPEN
- **Where**: `sdd/natural-model-routing/apply-progress.md` "Verified by" table.
- **Root cause**: WU1 reported `26/26` (actual and `tasks.md`-documented: **21**); WU3 v2 reported `16/16` (actual: **17**). Numbers a reviewer is asked to trust.
- **Resolution (D10)**: correct to `21/21` and `17/17`.

### W7 — "kill -9" label misdescribes the test
- **Severity**: WARNING — **Status**: OPEN
- **Where**: `tests/natural-routing-security-failures.test.ts:524` (`void manager1;`), banner `:495`, header `:11`, log `:572`; env cleanup forced at `:570-571`; also `tasks.md` 4.1 and the commit message.
- **Root cause**: nothing is killed — the reference is merely dropped, so the process, its `process.env` routing vars and the in-memory key all survive, which is precisely why the manual `delete process.env[...]` is needed. The on-disk key-byte walk at `:527-541` is real and valuable; only the framing is wrong.
- **Resolution (D10)**: rename to **"abandoned boot (no `stop()`) — secret non-persistence"** at all five sites plus `tasks.md`/apply-progress; keep deviation 4's honest note. No behavior change.

### S1 — Absolute `whoami.exe` + dedicated ACL error code
- **Severity**: SUGGESTION — **Status**: OPEN (absorbed)
- **Root cause / rationale**: verifier's suggested closure for C1 across every shell, removing a misleading security-sounding error.
- **Resolution**: fully absorbed by D1+D2 under C1. No separate work item.

### S2 — Extract `tests/helpers/model-routing-fixtures.ts`
- **Severity**: SUGGESTION — **Status**: OPEN (absorbed)
- **Where**: `seedManifestAndAttestation` (`:89`) and `seedBootManifest` (`:205`) are near-duplicates; the file is already over budget.
- **Resolution**: fully absorbed by D6 under W1; the two seeders are unified inside the new helper.

### Must-not-break (verified good, do not regress)

| Item | Location |
|---|---|
| `SENSITIVE_KEYS` prompt variants (+6 lines, caught a real bug) | `model-route-audit.logger.ts:82-87` |
| Section 8 greps a real on-disk JSONL sink, not a mock | test `:755`, patterns `:781-794` |
| Sections 2, 3, 4, 6, 7, 8b assert exact error codes | throughout |
| NUL `CONTROL_CHARACTER` rejection | test `:689` |
| `verify()`-path `AttestationMismatchError` assertions | `tests/model-route-canary-readiness.test.ts:261-293` |
| `tests/model-route-cli.test.ts` green | no action |

### Exit criteria for WU4 PASS

All 12 entries CLOSED; suite exits 0 in the **default** shell; `npm run test:typecheck:strict` + `npm run build` green; no regressions across the 14-suite sweep; `tasks.md` / `apply-progress.md` counts and claims match measured reality.

---

## Part 2 — Remediation Design

Inputs: verify-report Engram #2397 (FAIL, 3 CRITICAL / 7 WARNING / 2 SUGGESTION), commit `47dedc2`, live source re-inspection 2026-07-30.

### Source re-confirmation (all findings still hold)

| Finding | Live evidence |
|---|---|
| C1 | `model-route-readiness.ts:250` bare `whoami /user`, `:254`/`:259`/`:261` bare `icacls`/`whoami`, rethrown as `AttestationMismatchError` at `:264`; **duplicated** at `windows-model-route-boot-manager.ts:640-656` with a divergent `WINDOWS_ACL_FAILED` plain-Error shape |
| C2 | `bootIdentityValue` declared `:727`, absent from `baseEntry` `:729-751`, asserted `:766` |
| C3 | `if (existsSync(envFile))` `:544` over a fresh `mkdtempSync` root; assertions `:546-547` never run |
| W1-W7 | Confirmed (`tasks.md:69/81` claim 796; `grep icacls\|scrub` → header only; `:757` fsync is a comment; `:686-695` shared `thrown`; `:313` unpinned outcome; `:524` `void manager1;`) |

### Technical Approach

One remediation commit, three layers: (1) a **WU3 carve-out** that de-duplicates and hardens the Windows ACL helper so WU4's gate becomes hermetic; (2) **real assertions** replacing the tautological/ghost/comment-only ones; (3) **evidence hygiene** (counts, naming, budget). Strict TDD preserved: C2's fix is a genuine RED that forces a 1-line logger GREEN.

### Architecture Decisions

**D1 — PATH-independent SID resolution**
- **Choice**: resolve every Windows binary through `system32(exe) = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", exe)` and call `whoami.exe` / `icacls.exe` by absolute path.
- **Rejected**: PowerShell `WindowsIdentity::GetCurrent().User.Value` (heavier, still PATH-shadowed unless absolutized); a Win32-API native binding (new dependency for a 1-line problem); `%USERDOMAIN%\%USERNAME%` only (yields no SID — that is already the fallback branch).
- **Rationale**: kills the Git-Bash POSIX-`whoami` shadow for every shell and every CI runner, zero new deps.

**D2 — One shared ACL module, one dedicated error code**
- **Choice**: create `src/infrastructure/runtime/windows-acl.ts` exporting `applyCurrentUserAcl(filePath)` and:

```ts
export class AclRestrictionError extends Error {
  readonly code = "ACL_RESTRICTION_FAILED";
  constructor(filePath: string, cause: unknown) {
    super(`ACL_RESTRICTION_FAILED: unable to restrict Windows ACL on ${filePath}: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "AclRestrictionError";
    this.cause = cause;
  }
}
```

  Thrown from the single helper; **not** caught in `atomicPersist` — it propagates distinctly so tooling failure is never confusable with attestation tamper. `model-route-readiness.ts:247-266` and `windows-model-route-boot-manager.ts:640-656` both delete their local copy and import it; the boot manager maps it to state `failed` with reason `ACL_RESTRICTION_FAILED`.
- **Rejected**: patch each copy in place (fixes the same bug twice, keeps two divergent error contracts); downgrade ACL failure to a warning and continue (rejected outright — the attestation file would stay inheritable, destroying the WU3 security property). **Fail-closed is preserved; only the label changes.**
- **Rationale**: two copies of a security-critical helper that already drifted in error shape is the root enabler of C1's mislabel.
- **Blast radius checked**: `model-route-canary-readiness.test.ts:261-293` asserts `AttestationMismatchError` only on the `verify()` path, untouched.

**D3 — Ship the WU3 carve-out inside WU4's remediation**
- **Choice**: ship D1+D2 in the WU4 remediation commit, recorded in `tasks.md` as `4.4 (WU3 carve-out)` with an explicit cross-reference so WU3's own FAIL remediation does not re-fix it.
- **Rejected**: a separate tiny WU3 patch merged first — WU4's gate would stay red behind WU3's unrelated FAIL backlog, and WU3's remediation would then conflict-merge with it.
- **Rationale**: ~40 lines, 3 files, strictly the minimum needed to unblock WU4; anything wider stays out of scope.

**D4 — C2: wire the value in, then close the real leak**
- **Choice**: insert `bootIdentity: bootIdentityValue` **and** `signingKey: <hex>` into `baseEntry`. This goes **RED** — neither key is in `SENSITIVE_KEYS`. GREEN = add `bootidentity`, `bootid`, `signingkey`, `hmackey` to `SENSITIVE_KEYS` (+1 code line, same defense-in-depth pattern as the accepted prompt fix; `isSensitive()` already lowercases and strips non-alnum).
- **Rejected**: delete the dead assertion — cheaper, but discards a genuine leak vector the assertion already *claims* to cover.
- **Rationale**: converts a tautology into a real TDD cycle that finds a real gap, mirroring the one WU4 win that held up.

**D5 — C3: seed a real `.env`, drop the guard**
- **Choice**: write a benign `.env` (`FOO=bar\n`) into `workspaceRoot` before boot 1; remove `if (existsSync(envFile))`; assert the file still exists, is byte-for-byte unchanged, and contains neither `identity1` nor the key hex.
- **Rejected**: `assert.equal(existsSync(envFile), false)` — proves only that nothing created a `.env`, not that production never appends secrets to an operator's existing one (the actual risk).
- **Rationale**: strictly stronger, and the key-byte walk at `:527-541` then legitimately covers `.env` too.

**D6 — W1/S2: extract fixtures, no `size:exception`**
- **Choice**: move lines 44-240 (`sleep`, `cleanupDir`, `sha256`, `writeStrict`, `stubCatalog`, `makeHook`, `seedManifestAndAttestation`, `readAllLines`, `BootStubCatalog`, `BootStubCanary`, `makeBootManager`, `seedBootManifest` ≈195 lines) into `tests/helpers/model-routing-fixtures.ts`, unifying the near-duplicate `seedManifestAndAttestation` / `seedBootManifest`.
- Projected: test ≈640 − shared + ≈55 new ⇒ **≈695**; helper ≈205. Both under 800. Verify `tsconfig.test.json` already covers `tests/helpers/` (it compiles `init-child-runner.ts`, `temp-database.ts` today).
- **Rejected**: record `size:exception` — the breach is real but avoidable, and extraction also closes S2.
- **Rationale**: `tests/helpers/*.ts` is an existing repo convention, not a new one.

**D7 — W2: assert the ACL, restate scrubbing honestly**
- **Choice**: new **Section 9** (win32-only, logged skip elsewhere): (a) `applyCurrentUserAcl(tmpFile)` does not throw and `icacls.exe` (absolute) output shows inheritance removed with only the current user granted; (b) with `SystemRoot` stubbed to an empty dir it throws `AclRestrictionError` with `code === "ACL_RESTRICTION_FAILED"` and **not** `AttestationMismatchError`. For attach env scrubbing, **restate** as "WU3-verified in `windows-boot-manager.test.ts`; WU4 does not cover it" instead of duplicating.
- **Rationale**: the ACL path is what breaks WU4's gate, so it earns real assertions; scrubbing is already proven upstream and duplicating it burns budget for zero new information.

**D8 — W3: observable durability**
- **Choice**: after `await logger.append(baseEntry)` and **before** `close()`, read via an independent descriptor and assert the full line + trailing `\n` is present and `statSync(p).size === Buffer.byteLength(raw)`.
- **Rejected**: monkey-patching `node:fs.fsyncSync` (brittle module interception used nowhere else in this repo).
- **Documented boundary**: Node cannot observe the physical fsync; this asserts the strongest available proxy — bytes are not held in a userland buffer. `append()` fsyncs at `model-route-audit.logger.ts:176` before resolving, so the assertion is meaningful and would fail if that were removed.

**D9 — W4/W5: kill shared state, pin outcomes**
- **W4**: rewrite `7h` as a table-driven loop over `[NUL, DEL, ESC]` with `let thrown: unknown = null` **inside** the body plus a per-case `assert.ok(thrown instanceof NaturalIntentMalformedError)` before the `CONTROL_CHARACTER` code check. Net ≈ −2 lines, hazard gone.
- **W5**: add `expected: "rewritten" | "blocked"` to each of the 5 injection fixture rows and `assert.equal(outcome, expected)` before the branch; determine each row's true value empirically at apply time. The cross-cutting no-adversarial-substring invariant stays.

**D10 — W6/W7: evidence honesty**
- Correct WU1 `26/26`→`21/21` and WU3 v2 `16/16`→`17/17`; replace every `796` with the measured final count. **Do not rewrite `47dedc2`** — add an explicit "Correction to commit 47dedc2" block in `apply-progress.md`; the remediation commit message carries true numbers. Rename Section 5 from "kill -9 simulation" to **"abandoned boot (no `stop()`) — secret non-persistence"** at the test header `:11`, banner `:495`, log `:572`, `tasks.md` 4.1 and apply-progress; keep deviation 4's honest note.

### File Changes

| File | Action | Description |
|---|---|---|
| `src/infrastructure/runtime/windows-acl.ts` | Create | Shared `applyCurrentUserAcl` + `AclRestrictionError`; System32-absolute `whoami.exe`/`icacls.exe` (D1, D2) |
| `src/infrastructure/opencode/model-route-readiness.ts` | Modify | Delete local helper `:247-266`, import shared; ACL failure no longer `AttestationMismatchError` |
| `src/infrastructure/runtime/windows-model-route-boot-manager.ts` | Modify | Delete local helper `:640-656`, import shared; map to `failed` / `ACL_RESTRICTION_FAILED` |
| `src/infrastructure/logging/model-route-audit.logger.ts` | Modify | +1 line: `bootidentity`,`bootid`,`signingkey`,`hmackey` in `SENSITIVE_KEYS` (GREEN for D4). Existing prompt keys untouched |
| `tests/helpers/model-routing-fixtures.ts` | Create | Extracted + de-duplicated fixtures (D6) |
| `tests/natural-routing-security-failures.test.ts` | Modify | C2, C3, W3, W4, W5, W7 + new Section 9; imports from the helper |
| `sdd/natural-model-routing/tasks.md` | Modify | 4.1 sub-items truthful, add 4.4 carve-out, D3 restatement, real line count |
| `sdd/natural-model-routing/apply-progress.md` | Modify | Corrected counts, correction block for `47dedc2`, renamed Section 5 |

### Data Flow (ACL failure, after change)

```
atomicPersist ──→ applyCurrentUserAcl (windows-acl.ts)
                        │ System32\whoami.exe /user → SID
                        │ System32\icacls.exe /inheritance:r /grant:r
                        └─ on failure ─→ AclRestrictionError(ACL_RESTRICTION_FAILED)
                                          │  (fail-closed, propagates undisguised)
                                          └─→ runStart → state=failed(ACL_RESTRICTION_FAILED)
verify() tamper path ──→ AttestationMismatchError(ATTESTATION_MISMATCH)   [unchanged]
```

### Testing Strategy

| Layer | What | How |
|---|---|---|
| Unit | `applyCurrentUserAcl` success + failure taxonomy | Section 9, win32-gated, `SystemRoot` stubbing |
| Unit | Control-char rejection per case | Table-driven 7h with per-case identity assertion |
| Unit | Audit sink secret stripping | RED on `bootIdentity`/`signingKey` → GREEN via `SENSITIVE_KEYS` |
| Integration | Durability | Independent-fd read + size check pre-`close()` |
| E2E | Abandoned-boot secret non-persistence | Existing workspace walk + seeded `.env` |
| Gate | Hermeticity | `npx tsx tests/natural-routing-security-failures.test.ts` must exit 0 **in the default Git Bash shell with no PATH manipulation** — this is the acceptance criterion for C1 |

### Migration / Rollout

No migration. `AclRestrictionError` is a new export; no consumer currently catches ACL failures by type.

### Scope callout

Verifier estimated ~35 lines; this design lands at **≈120 net changed lines across 8 files**, of which the two extractions (ACL module, fixtures helper) are largely moves and are net-neutral-to-negative on total repo lines. Growth is deliberate and confined to the chosen mechanisms for C1/W1/W2/S2. Well inside the 400-line review budget ⇒ **single PR, no chaining, no `size:exception`**.

### Open Questions

- [ ] Which of the 5 injection fixtures are genuinely `blocked` vs `rewritten`? Resolve empirically during apply (D9), do not guess.
- [ ] Does `tsconfig.test.json` include `tests/helpers/**` explicitly or by glob? Confirm before the extraction lands.
- [ ] Should `AclRestrictionError` live in `windows-acl.ts` or be re-exported from `model-route-readiness.ts` for import ergonomics? Prefer the module; re-export only if it churns call sites.

---

## Coordination note

The ACL de-duplication (D1/D2) touches files also referenced by WU3's separate, still-open FAIL remediation track (Engram `sdd/natural-model-routing/verify-report`, #2397 lineage). Whoever implements this must not let WU3's own remediation re-touch `model-route-readiness.ts`'s or `windows-model-route-boot-manager.ts`'s ACL helper independently — coordinate or sequence to avoid a merge conflict / duplicated fix.

## Provenance

- Gap catalog: PMC/engram `sdd/natural-model-routing/wu4-gaps`, observation #2401.
- Remediation design: PMC/engram `sdd/natural-model-routing/wu4-remediation-design`, observation #2400.
- Prior verify report (source of the 12 findings): PMC/engram `sdd/natural-model-routing/verify-report`, #2397.
- Session summary: PMC/engram id `1dd59559-8e4b-49e3-bc2a-8c07637916fc`.
