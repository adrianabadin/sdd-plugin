import { defineConfig } from "tsup";

/**
 * Dedicated TUI bundle config.
 *
 * The package's main build (`tsc`) emits `.tsx` as `.jsx` (because
 * `tsconfig.json` uses `jsx: preserve`), but the emitted `dist/tui.js`
 * still imports `./tui/ModelControlCenter.js` (because source files use
 * `.js` extensions with `moduleResolution: nodenext`). Node ESM does not
 * auto-resolve `.jsx` for `.js` specifiers, so the built artifact fails
 * with `ERR_MODULE_NOT_FOUND` at runtime.
 *
 * This dedicated tsup pass bundles `src/tui.ts` into a single flat
 * `dist/tui.js` with internal imports rewritten to chunk files. It runs
 * AFTER `tsc` and only overwrites `dist/tui.js` (plus its source-map);
 * `clean: false` is required so the rest of the package build (bootstrap,
 * application layers, declarations) is preserved.
 *
 * Externalized: `@opencode-ai/plugin` (peer dep) and `@opentui/solid`
 * (runtime dep, kept external so the bundler does not inline a JSX
 * runtime that would conflict with OpenCode's host runtime).
 */
export default defineConfig({
  entry: { tui: "src/tui.ts" },
  format: ["esm"],
  outDir: "dist",
  bundle: true,
  splitting: false,
  clean: false,
  dts: false,
  sourcemap: true,
  minify: false,
  external: ["@opencode-ai/plugin", "@opentui/solid"],
});
