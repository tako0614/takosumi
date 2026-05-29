import { assert, assertEquals } from "jsr:@std/assert@^1.0.0";
import {
  currentRuntime,
  denoRuntime,
  isDeno,
  resetRuntimeForTesting,
  setRuntimeForTesting,
} from "./index.ts";
import { nodeRuntime } from "./node.ts";

Deno.test("currentRuntime detects Deno when running on Deno", () => {
  resetRuntimeForTesting();
  assert(isDeno());
  const runtime = currentRuntime();
  assertEquals(runtime.kind, "deno");
});

Deno.test("denoRuntime env reader returns process env", () => {
  const sentinel = "TAKOSUMI_RUNTIME_ADAPTER_TEST";
  Deno.env.set(sentinel, "1");
  try {
    assertEquals(denoRuntime.env.get(sentinel), "1");
    assert(denoRuntime.env.toObject()[sentinel] === "1");
  } finally {
    Deno.env.delete(sentinel);
  }
});

Deno.test("denoRuntime fs.isNotFoundError recognises Deno.errors.NotFound", () => {
  const error = new Deno.errors.NotFound("missing");
  assert(denoRuntime.fs.isNotFoundError(error));
  assert(!denoRuntime.fs.isNotFoundError(new Error("other")));
});

Deno.test("setRuntimeForTesting overrides detection", () => {
  const fakeAdapter = { ...denoRuntime, kind: "node" as const };
  setRuntimeForTesting(fakeAdapter);
  try {
    assertEquals(currentRuntime().kind, "node");
  } finally {
    resetRuntimeForTesting();
  }
});

Deno.test("nodeRuntime fs.readTextFileSync works without a global require (createRequire warm-up)", async () => {
  // Under Deno's node-compat shim (and pure-ESM Node) there is no
  // `globalThis.require`. The sync read must still work via the `require`
  // pre-warmed from `node:module#createRequire(import.meta.url)`. Yield to the
  // microtask/event loop so the warm-up `import("node:module")` has resolved.
  assertEquals(
    typeof (globalThis as { require?: unknown }).require,
    "undefined",
  );
  await new Promise((resolve) => setTimeout(resolve, 0));

  const file = await Deno.makeTempFile({ suffix: ".json" });
  try {
    await Deno.writeTextFile(file, '{"ok":true}');
    const text = nodeRuntime.fs.readTextFileSync(file);
    assertEquals(JSON.parse(text).ok, true);
  } finally {
    await Deno.remove(file);
  }
});

Deno.test("denoRuntime serveHttp serves a fetch handler and shuts down", async () => {
  const handler = (req: Request): Response => {
    return new Response(`hello ${new URL(req.url).pathname}`, { status: 200 });
  };
  const handle = denoRuntime.serveHttp(handler, {
    port: 0,
    hostname: "127.0.0.1",
  });
  await handle.shutdown();
});
