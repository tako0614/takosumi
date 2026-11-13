import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { Miniflare } from "miniflare";
import { loadD1AccountsMigrationCatalog } from "../../../../accounts/service/src/d1-migrations.ts";

test("workerd native D1 retains live expiry and replay state while atomically collecting dead rows", async () => {
  const build = await Bun.build({ entrypoints: [resolve(import.meta.dir, "../fixtures/refresh-retention-workerd.ts")],
    target: "browser", format: "esm", minify: true });
  expect(build.success, build.logs.map(String).join("\n")).toBe(true);
  const migration = (await loadD1AccountsMigrationCatalog()).migrations.find(entry => entry.name === "refresh_chain_retention_indexes");
  expect(migration).toBeDefined();
  const runtime = new Miniflare({ compatibilityDate: "2026-07-17",
    modules: [{ type: "ESModule", path: "refresh-retention-workerd.mjs", contents: await build.outputs[0]!.text() }],
    d1Databases: ["ACCOUNTS_TEST_DB"], bindings: { RETENTION_INDEX_SQL: JSON.stringify(migration!.body) } });
  try {
    const response = await runtime.dispatchFetch("https://fixture.example.test/");
    expect(response.status).toBe(200);
    const facts = await response.json() as { scanned: number };
    expect(facts).toMatchObject({ liveLinkRetained: true, residueRootRetained: true,
      markerRetained: true, expiredLinkCollected: true, unknownLinkRetained: true,
      accessRevoked: true, refreshRevoked: true, checkpointAdvanced: true, staleResetRefused: true, atomicRollback: true,
      checkpoint: { generation: 1, cursor: { phase: "chain_links", after: '[1,"native-fixture-cursor"]' } },
      counts: { chainLinks: 1, revokedRoots: 0, consumedCodes: 0, authCodeTokenLinks: 0 } });
    expect(facts.scanned).toBeLessThanOrEqual(20);
  } finally { await runtime.dispose(); }
}, 30_000);
