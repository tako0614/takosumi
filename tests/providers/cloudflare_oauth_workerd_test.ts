import { afterAll, beforeAll, expect, test } from "bun:test";
import { Miniflare } from "miniflare";

let runtime: Miniflare;

beforeAll(async () => {
  const bundle = await Bun.build({
    entrypoints: [new URL("../helpers/providers/cloudflare_oauth_worker.ts", import.meta.url).pathname],
    target: "browser", format: "esm", external: ["cloudflare:workers"],
  });
  if (!bundle.success) throw new AggregateError(bundle.logs, "OAuth workerd fixture build failed");
  runtime = new Miniflare({ compatibilityDate: "2026-04-01", compatibilityFlags: ["nodejs_compat", "enable_request_signal"],
    modules: [{ type: "ESModule", path: "oauth-native.mjs", contents: await bundle.outputs[0]!.text() }] });
}, 30_000);

afterAll(async () => { await runtime?.dispose(); });

interface Result {
  result?: { status: string };
  error?: { reason: string; message: string };
  status?: string;
  refreshes: number;
  calls: { path: string; redirect: string }[];
}

async function run(scenario: string): Promise<Result> {
  return await (await runtime.dispatchFetch(`https://fixture.test/${scenario}`)).json() as Result;
}

test("OAuth account discovery verifies through the real workerd Request API", async () => {
  const result = await run("verify");
  expect(result.error).toBeUndefined();
  expect(result.result?.status).toBe("verified");
  expect(result.calls[0]).toEqual({ path: "/client/v4/accounts", redirect: "manual" });
}, 10_000);

test("OAuth renewal uses the real workerd Request API before verification", async () => {
  const result = await run("refresh");
  expect(result.error).toBeUndefined();
  expect(result.result?.status).toBe("verified");
  expect(result.refreshes).toBe(1);
  expect(result.calls.find((call) => call.path === "/oauth2/token")?.redirect).toBe("manual");
}, 10_000);

test("OAuth discovery rejects redirects without following their destination", async () => {
  const result = await run("account-redirect");
  expect(result.error).toBeUndefined();
  expect(result.result?.status).toBe("pending");
  expect(result.calls).toEqual([{ path: "/client/v4/accounts", redirect: "manual" }]);
}, 10_000);

test("OAuth renewal rejects redirects and never sends a second token request", async () => {
  const result = await run("refresh-redirect");
  expect(result.error?.reason).toBe("provider_connection_setup_required");
  expect(result.status).toBe("pending");
  expect(result.refreshes).toBe(1);
  expect(result.calls.filter((call) => call.path === "/oauth2/token"))
    .toEqual([{ path: "/oauth2/token", redirect: "manual" }]);
}, 10_000);
