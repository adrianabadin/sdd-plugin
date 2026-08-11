/**
 * Package entry point for the OpenCode plugin (`exports["."]`).
 *
 * HOST CONTRACT — this module must export NOTHING but the plugin function.
 *
 * OpenCode loads a plugin module by iterating EVERY export and treating each
 * one as a plugin factory. That has two consequences, both verified against a
 * real host:
 *
 *   1. A single non-function export (a constant, an object) aborts the whole
 *      module with "Plugin export is not a function" — the plugin is dropped
 *      and its tool surface silently never registers.
 *   2. Every exported function is INVOKED with the plugin context. Exporting
 *      internal helpers such as `getPrismaClient` or
 *      `disposeBootstrapPersistence` would have the host call them at startup.
 *
 * `src/bootstrap/index.ts` legitimately exports constants and lifecycle
 * helpers for tests and internal callers, so it cannot itself be the entry
 * point. This module is the narrow, host-safe boundary: `SddPlugin` and the
 * default export are the SAME function reference, which the host deduplicates.
 *
 * Do not add exports here.
 */
import { SddPlugin } from "./bootstrap/index.js";

export { SddPlugin };
export default SddPlugin;
