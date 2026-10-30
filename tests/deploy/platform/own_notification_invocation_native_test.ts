import { expect, test } from "bun:test";
import { Miniflare } from "miniflare";
import { resolve } from "node:path";

import {
  attachInvocationWaitUntil,
  invocationWaitUntilAttached,
} from "../../../worker/src/own_notification_dispatch.ts";

// `deploy/platform/worker.ts` (local-substrate and operator deployments) is
// imported by Bun tests, so it reaches `waitUntil` from `cloudflare:workers`
// through a dynamic import instead of the Hosted entry's static one. Prove in
// workerd that importing it attaches the runtime's waitUntil before the first
// request and that a notified event is then delivered after the response.

test("the composed platform worker attaches the runtime waitUntil in workerd", async () => {
  const child = Bun.spawn([process.execPath, "build", "--target", "browser", "--format", "esm",
    "--external", "cloudflare:workers",
    resolve(import.meta.dir, "fixtures", "own-notification-invocation-runtime.ts")], {
    cwd: resolve(import.meta.dir, "../../.."), stdout: "pipe", stderr: "pipe",
  });
  const [exit, source, errors] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  expect(exit, errors).toBe(0);
  expect(source).toContain("cloudflare:workers");

  const runtime = new Miniflare({
    modules: [{ type: "ESModule", path: "own-notification-invocation.mjs", contents: source }],
    compatibilityDate: "2026-07-17",
    compatibilityFlags: ["nodejs_compat"],
  });
  try {
    // The very first request already sees the hookup.
    const first = await runtime.dispatchFetch("http://platform.test/record?id=act_first");
    expect(await first.json()).toEqual({ attached: true });
    const deadline = Date.now() + 10_000;
    let state: { attached: boolean; platformFetch: string; log: string[] };
    for (;;) {
      state = await (await runtime.dispatchFetch("http://platform.test/state")).json() as typeof state;
      if (state.log.includes("done:act_first") || Date.now() > deadline) break;
      await Bun.sleep(25);
    }
    expect(state).toEqual({ attached: true, platformFetch: "function", log: ["done:act_first"] });
  } finally {
    await runtime.dispose();
  }
}, 120_000);

test("outside workerd the dynamic hookup reports that nothing was attached", async () => {
  expect(await attachInvocationWaitUntil(() => import("cloudflare:workers" as string))).toBe(false);
  expect(await attachInvocationWaitUntil(async () => ({}))).toBe(false);
  expect(invocationWaitUntilAttached()).toBe(false);
});
