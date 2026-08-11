import assert from "node:assert/strict";
import net from "node:net";
import { test } from "node:test";

import {
  buildServeArgs,
  classify,
  OpenCodeProcessSupervisor,
  PORT_IN_USE_EXIT_CODE,
} from "../src/cli/model-route-boot.js";

/**
 * Bind an ephemeral loopback port and keep it held, so the "port already in
 * use" case is exercised against a real listening socket rather than a stub.
 */
async function listenOnEphemeralPort(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { resolve(); });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected a TCP address for the probe listener");
  }
  return {
    port: address.port,
    close: () => new Promise<void>((resolve) => { server.close(() => { resolve(); }); }),
  };
}

test("serve args bind OpenCode to the supervisor base URL port", () => {
  assert.deepEqual(buildServeArgs("http://127.0.0.1:4096"), [
    "serve",
    "--hostname",
    "127.0.0.1",
    "--port",
    "4096",
  ]);
});

test("preflight fails closed when another process already owns the supervisor port", async () => {
  const listener = await listenOnEphemeralPort();
  try {
    const supervisor = new OpenCodeProcessSupervisor(`http://127.0.0.1:${listener.port}`);
    await assert.rejects(() => supervisor.preflight(), /OPENCODE_PORT_IN_USE/);
  } finally {
    await listener.close();
  }
});

test("preflight resolves when the supervisor port is free", async () => {
  const listener = await listenOnEphemeralPort();
  const { port } = listener;
  await listener.close();

  const supervisor = new OpenCodeProcessSupervisor(`http://127.0.0.1:${port}`);
  await supervisor.preflight();
});

test("a port collision maps to a dedicated CLI exit code, not the generic failure", async () => {
  const listener = await listenOnEphemeralPort();
  try {
    const supervisor = new OpenCodeProcessSupervisor(`http://127.0.0.1:${listener.port}`);
    const raised = await supervisor.preflight().then(
      () => null,
      (err: unknown) => err,
    );
    assert.notEqual(raised, null, "preflight must reject while the port is held");

    const { code, message } = classify(raised);
    assert.equal(code, PORT_IN_USE_EXIT_CODE);
    assert.notEqual(code, 1, "a port collision is diagnosable, so it must not report as an unexpected error");
    assert.match(message, /OPENCODE_PORT_IN_USE/);
  } finally {
    await listener.close();
  }
});

test("health check rejects when its own serve child exits", async () => {
  let exitListener: (() => void) | undefined;
  const child = {
    kill: () => true,
    once: (event: "exit" | "error", listener: (...args: unknown[]) => void) => {
      if (event === "exit") exitListener = listener;
      return child;
    },
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    exitListener?.();
    return new Response(JSON.stringify({ version: "1.18.16" }), { status: 200 });
  };
  try {
    await assert.rejects(
      () => new OpenCodeProcessSupervisor("http://127.0.0.1:4096").waitForHealthy(child),
      /OPENCODE_SERVE_EXITED/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
