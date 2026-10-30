import { afterAll, beforeAll, expect, test } from "bun:test";
import { Miniflare } from "miniflare";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// The immediate own-notification path in real workerd: the platform entry
// passes `waitUntil` from `cloudflare:workers` once, and each recorded event
// is attached to whichever invocation (request or Durable Object) records it.
// Delivery is replaced by a timer so the test sees only scheduling: no
// invocation waits for another's delivery, a Durable Object returns before its
// delivery ends, and nothing is left behind when an object is reset.

const OBSERVER = JSON.stringify(
  fileURLToPath(new URL("../../../worker/src/own_notification_dispatch.ts", import.meta.url)),
);

const WORKER = `
import { DurableObject, waitUntil } from "cloudflare:workers";
import { ownNotificationActivityObserver, useInvocationWaitUntil } from ${OBSERVER};

useInvocationWaitUntil(waitUntil);

const log = [];
// The delivery stands in for the real one: it takes as long as the event asks.
const observe = ownNotificationActivityObserver(() => ({}), {
  deliver: async (_target, event) => {
    log.push("start:" + event.id);
    await scheduler.wait(Number(event.metadata.delayMs));
    log.push("done:" + event.id);
  },
});

function record(id, delayMs) {
  observe({
    id, workspaceId: "ws", action: "run.approval_required", targetType: "run", targetId: "run_" + id,
    runId: "run_" + id, metadata: { capsuleId: "cap_1", delayMs }, createdAt: new Date().toISOString(),
  });
}

export class Recorder extends DurableObject {
  async fetch(request) {
    const url = new URL(request.url);
    record(url.searchParams.get("id"), url.searchParams.get("delay"));
    if (url.searchParams.get("reset") === "1") this.ctx.abort("reset");
    return Response.json({ ok: true });
  }
  async alarm() {}
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/log") return Response.json(log);
    if (url.pathname === "/do") {
      const stub = env.RECORDER.get(env.RECORDER.idFromName(url.searchParams.get("object") ?? "a"));
      return stub.fetch("https://recorder/" + url.search);
    }
    record(url.searchParams.get("id"), url.searchParams.get("delay"));
    return Response.json({ ok: true });
  },
};
`;

let root: string;
let mf: Miniflare;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "takosumi-own-notification-immediate-"));
  const entry = join(root, "worker.ts");
  await writeFile(entry, WORKER);
  const result = await Bun.build({
    entrypoints: [entry],
    target: "browser",
    format: "esm",
    external: ["cloudflare:workers"],
    write: false,
  });
  if (!result.success || result.outputs.length !== 1) {
    throw new Error(`own notification worker bundle failed: ${result.logs.join("\n")}`);
  }
  mf = new Miniflare({
    modules: true,
    script: await result.outputs[0]!.text(),
    compatibilityDate: "2026-04-01",
    compatibilityFlags: ["nodejs_compat"],
    durableObjects: { RECORDER: "Recorder" },
  });
  await mf.ready;
}, 180_000);

afterAll(async () => {
  await mf?.dispose();
  if (root) await rm(root, { recursive: true, force: true });
});

async function log(): Promise<string[]> {
  return await (await mf.dispatchFetch("http://worker.test/log")).json() as string[];
}

async function until(predicate: (entries: string[]) => boolean, timeoutMs = 10_000): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const entries = await log();
    if (predicate(entries)) return entries;
    if (Date.now() > deadline) throw new Error(`timed out; log: ${JSON.stringify(entries)}`);
    await Bun.sleep(25);
  }
}

async function timed(path: string): Promise<{ status: number; ms: number }> {
  const started = Date.now();
  const response = await mf.dispatchFetch(`http://worker.test${path}`);
  await response.arrayBuffer();
  return { status: response.status, ms: Date.now() - started };
}

test("two concurrent requests in one isolate never wait for each other's delivery", async () => {
  const [slow, fast] = await Promise.all([
    timed("/?id=req_slow&delay=2000"),
    timed("/?id=req_fast&delay=0"),
  ]);
  // Both responses return before any delivery ends.
  expect(slow).toMatchObject({ status: 200 });
  expect(fast).toMatchObject({ status: 200 });
  expect(slow.ms).toBeLessThan(1_500);
  // The fast one is delivered while the slow one is still running.
  const entries = await until((entries) => entries.includes("done:req_fast"));
  expect(entries).toContain("start:req_slow");
  expect(entries).not.toContain("done:req_slow");
  // The slow one still completes after its response, under its own waitUntil.
  await until((entries) => entries.includes("done:req_slow"));
}, 60_000);

test("a Durable Object that records an event returns without waiting for the delivery", async () => {
  const response = await timed("/do?object=a&id=do_slow&delay=2000");
  expect(response.status).toBe(200);
  expect(response.ms).toBeLessThan(1_500);
  expect(await log()).not.toContain("done:do_slow");
  await until((entries) => entries.includes("done:do_slow"));
}, 60_000);

test("a request and a Durable Object deliver concurrently without blocking each other", async () => {
  const [request, object] = await Promise.all([
    timed("/?id=mix_req&delay=2000"),
    timed("/do?object=b&id=mix_do&delay=0"),
  ]);
  expect(request.status).toBe(200);
  expect(object.status).toBe(200);
  const entries = await until((entries) => entries.includes("done:mix_do"));
  expect(entries).not.toContain("done:mix_req");
  await until((entries) => entries.includes("done:mix_req"));

  const [object2, request2] = await Promise.all([
    timed("/do?object=b&id=mix_do_slow&delay=2000"),
    timed("/?id=mix_req_fast&delay=0"),
  ]);
  expect(object2.status).toBe(200);
  expect(request2.status).toBe(200);
  const later = await until((entries) => entries.includes("done:mix_req_fast"));
  expect(later).not.toContain("done:mix_do_slow");
  await until((entries) => entries.includes("done:mix_do_slow"));
}, 60_000);

test("a reset Durable Object leaves nothing that holds back later deliveries", async () => {
  // The object records an event and is reset in the same invocation.
  await mf.dispatchFetch("http://worker.test/do?object=c&id=reset_one&delay=0&reset=1").then((response) => response.arrayBuffer());
  // A fresh instance of the same object, and a plain request, still deliver.
  const again = await timed("/do?object=c&id=reset_two&delay=0");
  expect(again.status).toBe(200);
  await timed("/?id=reset_req&delay=0");
  await until((entries) => entries.includes("done:reset_two") && entries.includes("done:reset_req"));
}, 60_000);
