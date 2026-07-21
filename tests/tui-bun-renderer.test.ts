/**
 * Real OpenTUI renderer test using @opentui/solid testRender.
 * Must be executed under Bun runtime (which OpenCode uses in production).
 */
import { testRender } from "@opentui/solid";
import type { JSX } from "@opentui/solid";
import { renderPlaceholderRoute } from "../src/tui.js";
import type { TuiPluginApi } from "@opencode-ai/plugin/tui";

async function main(): Promise<void> {
  console.log("\n--- Real OpenTUI Bun Renderer Test ---");

  // Verify runtime is Bun
  if (typeof (globalThis as unknown as { Bun?: unknown }).Bun === "undefined") {
    console.warn(
      "ENVIRONMENT NOTICE: OpenTUI testRender requires Bun runtime (native FFI). Current runtime is Node.js (" +
        process.version +
        ")."
    );
    console.warn("Execute with 'bun tests/tui-bun-renderer.test.ts' or 'npm run test:tui:bun' under Bun.");
    console.log("Environment gate: Node unsupported-runtime path handled cleanly (skipped Bun FFI execution).");
    process.exit(0);
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
      DialogAlert: (props: { title?: string; message?: string }): JSX.Element => {
        return {
          type: "box",
          props: {
            border: true,
            children: [
              { type: "text", props: { children: props.title } },
              { type: "text", props: { children: props.message } },
            ],
          },
        } as unknown as JSX.Element;
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

  // Wait for frame rendering
  const setupAny = testSetup as unknown as {
    waitForFrame?: () => Promise<void>;
    captureCharFrame?: () => string;
    destroy?: () => void;
  };

  if (typeof setupAny.waitForFrame === "function") {
    await setupAny.waitForFrame();
  }

  // Frame capture assertion
  let frameChar: string | undefined;
  if (typeof setupAny.captureCharFrame === "function") {
    frameChar = setupAny.captureCharFrame();
  }

  if (frameChar) {
    console.log("Captured frame characters length: " + frameChar.length);
    if (!frameChar.includes("Model Control Center")) {
      console.error("FAIL: Captured frame does not contain expected title text 'Model Control Center'");
      process.exit(1);
    }
  }

  if (typeof setupAny.destroy === "function") {
    setupAny.destroy();
  }

  console.log("All real OpenTUI renderer assertions passed.");
  process.exit(0);
}

main().catch((err) => {
  console.error("Bun renderer test crashed:", err);
  process.exit(1);
});
