import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { Miniflare } from "miniflare";

test("native D1 couples cleanup reservation, quota and insert with atomic rollback", async () => {
  const build = await Bun.build({ entrypoints: [resolve(import.meta.dir, "../fixtures/passkey-challenge-workerd.ts")],
    target: "browser", format: "esm", minify: true });
  expect(build.success, build.logs.map(String).join("\n")).toBe(true);
  const runtime = new Miniflare({ compatibilityDate: "2026-07-17", d1Databases: ["FIXTURE_DB"],
    modules: [{ type: "ESModule", path: "passkey-fixture.mjs", contents: await build.outputs[0]!.text() }] });
  try {
    const response = await runtime.dispatchFetch("https://fixture.example.test/");
    expect(response.status).toBe(200);
    const facts = await response.json() as { maxScanned: number };
    expect(facts).toMatchObject({ acceptedOne: true, expiredRemoved: true,
      rollback: true, quotaBound: true, lostAckPreserved: true, staleWindowRefused: true,
      heldPreserved: true, restartProgress: true, ddlAttempts: 0 });
    expect(facts.maxScanned).toBeLessThanOrEqual(64);
  } finally { await runtime.dispose(); }
}, 30_000);
