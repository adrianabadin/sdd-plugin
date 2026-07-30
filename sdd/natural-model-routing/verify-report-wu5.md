# SDD Verification Report — WU5 `natural-model-routing`

## Verification Report

**Change**: `natural-model-routing` (WU5 scope only)
**Version**: 1.0.0 (OpenCode 1.18.9 SUT)
**Mode**: Strict TDD

### Completeness
| Metric | Value |
|--------|-------|
| Tasks total | 4 (5.1–5.4) |
| Tasks complete | 2 (5.3 Operator Guide, 5.4 Rollback Plan) |
| Tasks incomplete / blocked | 2 (5.1 Real-host E2E, 5.2 PMC Attestation evidence) |

*Note: `tasks.md` claims checkboxes `[x] 5.1` and `[x] 5.2`, but `apply-progress.md` and `wu5apply.md` explicitly confirm the live run failed closed with HTTP 500 (`CANARY_FAILED`) due to missing provider API credentials on the host. Per decision D1 and precondition 2, 5.1 and 5.2 remain BLOCKED and are NOT a PASS.*

### Build & Tests Execution
**Build**: ✅ Passed
```text
> sdd-plugin2@1.0.0 build
> tsc && tsup --config tsup.tui.config.ts
ESM dist/tui.js 175.96 KB
Build success in 107ms
```

**Tests**: ✅ All hermetic unit & integration suites passed / ❌ Real-host live E2E BLOCKED
```text
npm run test:typecheck:strict -> exit 0
npm run test:model-routes -> all 7 suites passed
npx tsx tests/natural-routing-security-failures.test.ts -> 10/10 sections passed
npx tsx tests/windows-boot-manager.test.ts -> 16/16 assertions passed
npx tsx tests/natural-model-routing-task-hook.test.ts -> 13/13 assertions passed
npx tsx tests/natural-model-intent.test.ts -> 21/21 assertions passed
Task 0 Hermetic Gating Checks -> 4/4 passed (all exited closed with exit 1/2 and BLOCKED status)

Real-host live execution:
npm run canary:model-routes:real -> FAILED CLOSED (HTTP 500 CANARY_FAILED: POST /session/.../command)
Reason: Host OpenCode 1.18.9 instance lacks configured provider API credentials (OPENAI_API_KEY, etc.)
```

**Coverage**: ➖ Changed file coverage analysis: 100% (0 production files modified in WU5).

---

### TDD Compliance
| Check | Result | Details |
|-------|--------|---------|
| TDD Evidence reported | ✅ | Found in `apply-progress.md` and `wu5apply.md` |
| All tasks have tests | ⚠️ | 5.3/5.4 are operator docs (N/A); 5.1/5.2 have gated integration test scripts |
| RED confirmed (tests exist) | ✅ | Gated harnesses exist and fail closed when gate vars / attestations are missing |
| GREEN confirmed (tests pass) | ❌ | Live real-host execution failed closed (HTTP 500) due to missing host credentials |
| Triangulation adequate | ✅ | Harnesses test multi-route distinct-parent canary and E2E rewrite |
| Safety Net for modified files | ✅ | Zero production files modified in WU5; full regression suite green |

---

### Test Layer Distribution
| Layer | Tests | Files | Tools |
|-------|-------|-------|-------|
| Unit | 50+ | 6 | Node / tsx |
| Integration | 10 | 2 | Node / tsx |
| Real-Host E2E | 2 (gated) | 2 | `model-route-real-host-canary.integration.ts`, `model-route-routing-e2e.test.ts` |
| **Total** | **62+** | **10** | |

---

### Changed File Coverage
| File | Line % | Branch % | Uncovered Lines | Rating |
|------|--------|----------|-----------------|--------|
| (No production files changed in WU5) | N/A | N/A | — | ✅ N/A |

---

### Assertion Quality
| File | Line | Assertion | Issue | Severity |
|------|------|-----------|-------|----------|
| — | — | — | None — all test assertions verify real behavior | ✅ OK |

**Assertion quality**: ✅ All assertions verify real behavior

---

### Quality Metrics
**Linter**: ➖ Not configured  
**Type Checker**: ✅ `npm run test:typecheck:strict` passed with 0 errors  

---

### Spec Compliance Matrix
| Requirement | Scenario | Test | Result |
|-------------|----------|------|--------|
| Bounded explicit intent | Spanish trigger & verbatim prompt integrity | `tests/natural-model-routing-task-hook.test.ts` | ✅ COMPLIANT (Hermetic) |
| Ordered security gates | Real-host natural intent route E2E (T2, T3) | `tests/model-route-routing-e2e.test.ts` | ❌ FAILING / BLOCKED (Missing host credentials) |
| Windows boot lifecycle | Real-host canary ATTESTED with 1.18.9 (T1, T4) | `tests/model-route-real-host-canary.integration.ts` | ❌ FAILING / BLOCKED (HTTP 500 on command execution) |
| Actionable errors & rollback | Rollback switch `SDD_NATURAL_ROUTING=off` documented (T5) | `docs/windows-natural-routing-operations.md` | ✅ COMPLIANT |
| Attestation evidence | Attestation evidence in PMC without secrets (T6, T7) | PMC memory `sdd/natural-model-routing/wu5-attestation-evidence` | ⚠️ PARTIAL (Evidence recorded, but status is `BLOCKED`) |

**Compliance summary**: 2/5 scenarios compliant (3/5 blocked by missing provider credentials on live host).

---

### Correctness (Static Evidence)
| Requirement | Status | Notes |
|------------|--------|-------|
| Task 0 — Hermetic Gating Checks | ✅ Implemented | All 4 gating checks exit 1/2 closed when env vars / attestations are missing. |
| Task 1 — Real-Host E2E | ❌ Blocked | OpenCode 1.18.9 running on 127.0.0.1:4096; canary POST command returned HTTP 500 due to missing API keys. |
| Task 2 — Attestation Evidence in PMC | ⚠️ Partial | Recorded BLOCKED status in PMC memory `sdd/natural-model-routing/wu5-attestation-evidence`; zero secret leakage (T7 pass). |
| Task 3 — Operator Guide | ✅ Implemented | `docs/windows-natural-routing-operations.md` matches codebase CLI and exit codes. |
| Task 4 — Repo Verification | ✅ Implemented | Typecheck, build, `test:model-routes`, security failure suite, and release safety tests pass 100%. |

---

### Coherence (Design)
| Decision | Followed? | Notes |
|----------|-----------|-------|
| D1 — Zero synthetic evidence | ✅ Yes | No synthetic attestations manufactured when live host failed closed. |
| D2 — Secrecy boundary | ✅ Yes | `bootIdentity` preserved; signing key zeroed and excluded from logs/PMC/disk. |
| D3 — No production mutations in WU5 | ✅ Yes | No production files modified in WU5. |
| D4 — Canary precedes E2E | ✅ Yes | Order preserved in operator docs and harness checks. |

---

### Issues Found

**CRITICAL**:
1. **Real-Host Attestation & E2E Blocked (Tasks 5.1 & 5.2)**: Live execution of `canary:model-routes:real` against OpenCode 1.18.9 on `127.0.0.1:4096` failed closed with `CANARY_FAILED` (HTTP 500) during POST `/session/.../command` because provider API credentials (e.g. `OPENAI_API_KEY`) are missing on the host environment.
2. **Task Progress Premature Checkbox Claim**: `sdd/natural-model-routing/tasks.md` has `[x] 5.1` and `[x] 5.2` checked, but implementation logs in `apply-progress.md` and `wu5apply.md` confirm 5.1/5.2 remained BLOCKED. Per `wu5apply.md` rules, missing host credentials means 5.1/5.2 are NOT PASS and WU5 remains incomplete.

**WARNING**:
1. PMC Attestation Memory records `BLOCKED` status rather than an `ATTESTED` state because the live host could not issue an attestation without provider credentials.

**SUGGESTION**:
1. Uncheck `5.1` and `5.2` in `sdd/natural-model-routing/tasks.md` until valid provider API credentials are provided on the OpenCode 1.18.9 host and `canary:model-routes:real` returns `status: "ATTESTED"`.

---

### Verdict
**FAIL**

**Reason**: Real-host canary and E2E verification (Tasks 5.1 and 5.2) failed closed with HTTP 500 due to missing provider API credentials on the live OpenCode 1.18.9 host, preventing the issuance of a real readiness attestation. Per decision D1 and precondition 2, no synthetic evidence was generated.

**Archive Readiness**: ❌ **NOT READY**  
**Can Flow Continue to Archive?**: ❌ **NO**. WU5 must remain OPEN until live provider credentials allow real-host attestation.
