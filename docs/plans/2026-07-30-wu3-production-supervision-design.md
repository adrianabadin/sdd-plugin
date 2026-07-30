# WU3 Production Supervision Design

## Goal

Close the nine production gaps identified by the authoritative WU3 FAIL review while preserving fail-closed routing behavior.

## Design

`WindowsModelRouteBootManager` owns the complete lifecycle: acquire a boot lock, remove stale readiness, create an ephemeral boot identity and signing key, spawn `opencode serve` with those values only in the child environment, wait for health and the required OpenCode version, synchronize the live catalog, run the canary, issue `ModelRouteReadiness`, and spawn an attach process with routing secrets scrubbed. The manager persists only non-secret lifecycle metadata and exposes cross-process status/stop through a PID/control record.

Readiness remains the single verification authority. Issue and verify include nonce, expiry, OpenCode/verifier versions, manifest/file hashes, journal and canary coverage checks. Stop and every failure path remove readiness, release locks, restore parent environment state, and zeroize in-memory secrets.

Windows readiness and attestation files receive an ACL restricted to the current user SID. POSIX mode remains best-effort. Catalog synchronization is mandatory and precedes all route existence/read-back checks; any sync or read-back failure is fail-closed.

## Testing

Tests will cover version/health failure, stale lock/readiness recovery, lock lifetime, TTL and renewal, parent model read-back, mandatory sync ordering/failure, secret scrubbing and non-persistence, cross-process stop/status, Windows ACL intent, and cleanup on every failure path. Existing focused suites, strict typecheck, build, and full test suite are required before completion.
