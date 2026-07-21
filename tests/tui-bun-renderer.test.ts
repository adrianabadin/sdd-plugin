/**
 * Real OpenTUI renderer test using @opentui/solid testRender.
 * Must be executed under Bun runtime (which OpenCode uses in production).
 */
import { testRender } from "@opentui/solid";
import { createComponent } from "solid-js/web";
import { renderPlaceholderRoute } from "../src/tui.js";
import type { TuiPluginApi } from "@opencode-ai/plugin/tui";

async function main(): Promise<void> {
  console.log("\n--- Real OpenTUI Bun Renderer Test ---");

  // Verify runtime is Bun
  if (typeof (globalThis as unknown as { Bun?: unknown }).Bun === "undefined") {
    console.error(
      "FAIL: OpenTUI testRender requires Bun runtime (native FFI). Current runtime is Node.js (" +
        process.version +
        ")."
    );
    console.error("Execute with 'bun tests/tui-bun-renderer.test.ts' or 'npm run test:tui:bun' under Bun.");
    process.exit(1);
  }

  console.log("Bun runtime detected. Initializing real OpenTUI testRender...");

  const mockApi: TuiPluginApi = {
    app: { version: "1.18.4" },
    attention: {} as never,
    keys: {} as never,
    keymap: { registerLayer: () => () => {} } as never,
    route: { register: () => () => {}, navigate: () => {}, current: { name: "home" } },
    mode: { current: () => "base", push: () => () => {} },
    ui: {
      DialogAlert: (props) => {
        return createComponent(
          (p: { title?: string; message?: string }) => {
            return createComponent("box" as never, {
              border: true,
              children: [
                createComponent("text" as never, { children: p.title }),
                createComponent("text" as never, { children: p.message }),
              ],
            });
          },
          props
        );
      },
      Dialog: (() => null) as never,
      DialogConfirm: (() => null) as never,
      DialogPrompt: (() => null) as never,
      DialogSelect: (() => null) as never,
      Slot: (() => null) as never,
      Prompt: (() => null) as never,
      toast: () => {},
      dialog: {} as never,
    },
    tuiConfig: {} as never,
    kv: {} as never,
    state: {} as never,
    theme: {} as never,
    client: {} as never,
    event: {} as never,
    renderer: {} as never,
    slots: {} as never,
    plugins: {} as never,
    lifecycle: {
      signal: new AbortController().signal,
      onDispose: () => () => {},
    },
  };

  const testSetup = await testRender(() => renderPlaceholderRoute(mockApi));

  if (!testSetup || !testSetup.renderer) {
    console.error("FAIL: testRender returned invalid TestRendererSetup");
    process.exit(1);
  }

  console.log("Real OpenTUI testRender mounted component tree successfully.");

  if (typeof testSetup.destroy === "function") {
    testSetup.destroy();
  } else if (testSetup.renderer && typeof testSetup.renderer.destroy === "function") {
    testSetup.renderer.destroy();
  }

  console.log("All real OpenTUI renderer assertions passed.");
  process.exit(0);
}

main().catch((err) => {
  console.error("Bun renderer test crashed:", err);
  process.exit(1);
});
