/**
 * Persistence-unavailable state must travel through the production path:
 * `tui()` -> host `dialog.replace` render -> `ModelControlCenter` -> visible
 * model-detail Save notice. No hand-built component props are used here.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { testRender } from "@opentui/solid";
import { jsx } from "@opentui/solid/jsx-runtime";
import type { JSX } from "@opentui/solid";
import type { TuiPluginApi } from "@opencode-ai/plugin/tui";

import { createPersistenceContext } from "../src/infrastructure/runtime/persistence-context.js";
import { tui } from "../src/tui.js";

console.log("--- Finding 8: production persistence-unavailable dialog wiring ---");

const env = {
  SDD_PLUGIN_DB_PATH: process.env.SDD_PLUGIN_DB_PATH,
  SDD_PLUGIN_DATA_DIR: process.env.SDD_PLUGIN_DATA_DIR,
  SDD_PLUGIN_LEGACY_DB_PATH: process.env.SDD_PLUGIN_LEGACY_DB_PATH,
};
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sdd-unavailable-"));

function restoreEnvironment(): void {
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

type RegisteredLayer = {
  priority?: number;
  commands?: Array<{ name?: string; run?: () => void }>;
};

async function run(): Promise<void> {
  assert.ok(
    typeof (globalThis as { Bun?: unknown }).Bun !== "undefined",
    "OpenTUI production render regression must run under Bun",
  );

  const brokenDb = path.join(tmpDir, "broken", "opencode-models.db");
  fs.mkdirSync(path.dirname(brokenDb), { recursive: true });
  fs.writeFileSync(brokenDb, Buffer.from("SQLite format 3\0 not really a database", "utf8"));

  process.env.SDD_PLUGIN_DB_PATH = brokenDb;
  process.env.SDD_PLUGIN_LEGACY_DB_PATH = path.join(tmpDir, "missing", "nope.db");
  delete process.env.SDD_PLUGIN_DATA_DIR;

  let thrown: unknown = null;
  try {
    await createPersistenceContext();
  } catch (err) {
    thrown = err;
  }
  assert.ok(thrown instanceof Error, "createPersistenceContext rejects unusable persistence");
  assert.match(
    thrown.message,
    /Persistence initialization failed|invalid or missing required schema/i,
    "composition error explains the persistence failure",
  );

  const layers: RegisteredLayer[] = [];
  const lifecycleCallbacks: Array<() => void | Promise<void>> = [];
  let capturedRender: (() => JSX.Element) | null = null;
  let capturedOnClose: (() => void) | null = null;

  const api: TuiPluginApi = {
    app: { version: "1.18.5" },
    attention: {} as never,
    keys: {} as never,
    keymap: {
      registerLayer: (layer: unknown) => {
        layers.push(layer as RegisteredLayer);
        return () => {};
      },
    } as never,
    route: { register: () => () => {}, navigate: () => {}, current: { name: "home" } },
    mode: { current: () => "base", push: () => () => {} },
    ui: {
      DialogAlert: ((props: { title?: string; message?: string }): JSX.Element =>
        jsx("box", {
          children: [
            jsx("text", { children: props.title ?? "" }),
            jsx("text", { children: props.message ?? "" }),
          ],
        })) as never,
      Dialog: (() => null) as never,
      DialogConfirm: (() => null) as never,
      DialogPrompt: (() => null) as never,
      DialogSelect: (() => null) as never,
      Slot: (() => null) as never,
      Prompt: (() => null) as never,
      toast: () => {},
      dialog: {
        replace: (render: () => JSX.Element, onClose?: () => void) => {
          capturedRender = render;
          capturedOnClose = onClose ?? null;
        },
        clear: () => {},
        setSize: () => {},
        get size() { return "medium" as const; },
        get depth() { return 1; },
        get open() { return true; },
      },
    },
    tuiConfig: {} as never,
    kv: {} as never,
    state: {} as never,
    theme: {} as never,
    client: {
      config: {
        providers: async () => ({
          data: {
            providers: [{
              id: "openai",
              name: "OpenAI",
              models: { "gpt-4o": { id: "gpt-4o", name: "GPT-4o" } },
            }],
          },
        }),
      },
    } as never,
    event: {} as never,
    renderer: {} as never,
    slots: {} as never,
    plugins: {} as never,
    lifecycle: {
      signal: new AbortController().signal,
      onDispose: (callback) => {
        lifecycleCallbacks.push(callback);
        return () => {};
      },
    },
  };

  await tui(api);
  const open = layers[0]?.commands?.find((command) => command.name === "model-control-center.open");
  assert.ok(open?.run, "tui() registers the production dialog-open command");
  open.run();
  assert.ok(capturedRender, "production open command registers a host dialog render callback");

  const setup = await testRender(() => capturedRender!(), { width: 240, height: 40 });
  try {
    await setup.waitForFrame((frame) => frame.includes("Model Control Center"));
    const componentLayer = layers.find((layer) => layer.priority === 200);
    assert.ok(componentLayer, "production ModelControlCenter registers its keymap layer");
    const command = (name: string) => {
      const entry = componentLayer.commands?.find((candidate) => candidate.name === name);
      assert.ok(entry?.run, `ModelControlCenter registers ${name}`);
      entry.run();
    };

    command("mcc.nav.activate");
    await setup.waitForFrame((frame) => frame.includes("openai (1 models)"));
    command("mcc.nav.activate");
    await setup.waitForFrame((frame) => frame.includes("GPT-4o"));
    command("mcc.nav.activate");
    await setup.waitForFrame((frame) => frame.includes("Model Detail"));
    command("mcc.form.save");

    const unavailableFrame = await setup.waitForFrame((frame) =>
      frame.includes("Persistence unavailable:"),
    );
    assert.ok(
      unavailableFrame.includes(thrown.message),
      `actual ModelControlCenter Save notice must include normalized reason: ${thrown.message}\n${unavailableFrame}`,
    );
    assert.ok(
      unavailableFrame.includes("Save is disabled"),
      "actual ModelControlCenter blocks Save when persistence is unavailable",
    );
    console.log(`  pass: production dialog rendered normalized reason: "${thrown.message}"`);
  } finally {
    setup.renderer.destroy();
    (capturedOnClose as (() => void) | null)?.();
    await Promise.all(lifecycleCallbacks.map((callback) => Promise.resolve(callback())));
  }

  const stillBroken = fs.readFileSync(brokenDb).toString("utf8");
  assert.ok(
    stillBroken.startsWith("SQLite format 3"),
    "the unusable database is not replaced by fabricated state",
  );
}

run()
  .then(() => {
    console.log("All persistence-unavailable assertions passed!");
  })
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    restoreEnvironment();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
