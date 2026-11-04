import { expect, test } from "bun:test";
import { Miniflare, Response as WorkerResponse } from "miniflare";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("local Runner proxy works in a native DO without enabling Cloudflare Containers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "takosumi-local-runner-native-"));
  let runtime: Miniflare | undefined;
  const outbound: string[] = [];
  try {
    const source = resolve(import.meta.dir, "../../../../worker/src/durable/OpenTofuRunnerObject.ts");
    const entry = join(directory, "entry.ts");
    await writeFile(entry, `
      export { LocalSubstrateOpenTofuRunnerProxyObject } from ${JSON.stringify(source)};
      export default {
        async fetch(request, env) {
          const stub = env.LOCAL.get(env.LOCAL.idFromName("native-proxy-regression"));
          return await stub.fetch(new Request("http://runner/runs/source_ref_missing", request));
        }
      };
    `);
    const bundle = await Bun.build({
      entrypoints: [entry], target: "browser", format: "esm", external: ["cloudflare:workers"],
    });
    if (!bundle.success || bundle.outputs.length !== 1) {
      throw new Error(bundle.logs.map(String).join("\n") || "native proxy fixture bundle failed");
    }
    runtime = new Miniflare({
      modules: [{ type: "ESModule", path: "entry.mjs", contents: await bundle.outputs[0]!.text() }],
      compatibilityDate: "2026-04-15", compatibilityFlags: ["nodejs_compat"],
      durableObjects: {
        LOCAL: { className: "LocalSubstrateOpenTofuRunnerProxyObject", useSQLite: true },
      },
      bindings: {
        LOCAL_SUBSTRATE_TEST_BED: "1",
        TAKOSUMI_LOCAL_OPENTOFU_RUNNER_URL: "http://127.0.0.1:18080/",
      },
      outboundService: async (request) => {
        const url = new URL(request.url);
        expect(url.origin).toBe("http://127.0.0.1:18080");
        outbound.push(`${request.method} ${url.pathname}`);
        if (url.pathname === "/healthz") return WorkerResponse.json({ ok: true });
        expect(request.method).toBe("POST");
        expect(url.pathname).toBe("/runs/source_ref_missing");
        return WorkerResponse.json({ status: "failed", errorCode: "source_ref_not_found" }, { status: 500 });
      },
    });
    await runtime.ready;
    const body = JSON.stringify({
      kind: "takosumi.opentofu-run@v1", action: "source_sync", runId: "source_ref_missing",
      request: { action: "source_sync", archiveRef: "apps/native_proxy/sources/missing/source.tar.zst" },
    });
    const response = await runtime.dispatchFetch("http://proxy.test/local", {
      method: "POST", headers: { "content-type": "application/json" }, body,
    });
    expect(response.status).toBe(500);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({ status: "failed", errorCode: "source_ref_not_found", phase: "source_sync" });
    expect(outbound).toContain("GET /healthz");
    expect(outbound.filter((value) => value.startsWith("POST "))).toEqual(["POST /runs/source_ref_missing"]);
  } finally {
    await runtime?.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);

test("local Runner proxy delivers native alarms to the Restore collector", async () => {
  const directory = await mkdtemp(join(tmpdir(), "takosumi-local-restore-alarm-"));
  let runtime: Miniflare | undefined;
  try {
    const source = resolve(import.meta.dir, "../../../../worker/src/durable/OpenTofuRunnerObject.ts");
    const entry = join(directory, "entry.ts");
    await writeFile(entry, `
      import { LocalSubstrateOpenTofuRunnerProxyObject } from ${JSON.stringify(source)};
      const CURSOR = "runner-restore-stage-collector-cursor@v1";
      export class RestoreAlarmFixture extends LocalSubstrateOpenTofuRunnerProxyObject {
        constructor(ctx, env) { super(ctx, env); this.storage = ctx.storage; }
        async fetch(request) {
          if (request.method === "POST") {
            await this.storage.put(CURSOR, "runner-restore-stage@v1:apps/native_alarm:finished");
            await this.storage.setAlarm(Date.now());
          }
          return Response.json({ cursor: await this.storage.get(CURSOR) ?? null });
        }
      }
      export default {
        async fetch(request, env) {
          return await env.LOCAL.get(env.LOCAL.idFromName("restore-alarm-regression")).fetch(request);
        }
      };
    `);
    const bundle = await Bun.build({
      entrypoints: [entry], target: "browser", format: "esm", external: ["cloudflare:workers"],
    });
    if (!bundle.success || bundle.outputs.length !== 1) {
      throw new Error(bundle.logs.map(String).join("\n") || "native Restore alarm fixture bundle failed");
    }
    runtime = new Miniflare({
      modules: [{ type: "ESModule", path: "entry.mjs", contents: await bundle.outputs[0]!.text() }],
      compatibilityDate: "2026-04-15", compatibilityFlags: ["nodejs_compat"],
      durableObjects: { LOCAL: { className: "RestoreAlarmFixture", useSQLite: true } },
      bindings: {
        LOCAL_SUBSTRATE_TEST_BED: "1",
        TAKOSUMI_LOCAL_OPENTOFU_RUNNER_URL: "http://127.0.0.1:18080/",
      },
      outboundService: () => { throw new Error("native Restore alarm fixture forbids Worker egress"); },
    });
    await runtime.ready;
    const seeded = await runtime.dispatchFetch("http://proxy.test/", { method: "POST" });
    expect(seeded.status).toBe(200);
    const deadline = Date.now() + 5_000;
    let cursor: unknown;
    do {
      const response = await runtime.dispatchFetch("http://proxy.test/");
      expect(response.status).toBe(200);
      cursor = (await response.json() as { cursor: unknown }).cursor;
      if (cursor === null) break;
      await Bun.sleep(50);
    } while (Date.now() < deadline);
    expect(cursor).toBeNull();
  } finally {
    await runtime?.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
