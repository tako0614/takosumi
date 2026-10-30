import { expect, test } from "bun:test";
import { Miniflare } from "miniflare";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { D1Database, D1PreparedStatement, D1Result } from "../../../worker/src/bindings.ts";
import {
  CloudflareD1OpenTofuControlStore,
  ensureD1OpenTofuLedgerSchema,
  verifyD1OpenTofuLedgerSchemaPredeployed,
} from "../../../worker/src/d1_opentofu_store.ts";

type NativeDatabase = Awaited<ReturnType<Miniflare["getD1Database"]>>;

// Keep native statements in batch(), while a controllable snapshot boundary
// forces competing sweep instances to read the same old cursor generation.
function databaseBridge(
  native: NativeDatabase,
  onSnapshot: () => Promise<void> = () => Promise.resolve(),
  onLostCas: () => void = () => {},
): D1Database {
  const underlying = new WeakMap<D1PreparedStatement, ReturnType<NativeDatabase["prepare"]>>();
  function statement(value: ReturnType<NativeDatabase["prepare"]>, query: string): D1PreparedStatement {
    const adapter: D1PreparedStatement = {
      bind: (...values) => statement(value.bind(...values), query),
      first: async <T>() => {
        const result = await value.first<T>();
        if (query.includes("select generation, cursor_created_at") && query.includes("from scheduled_sweep_cursors")) {
          await onSnapshot();
        }
        return result;
      },
      all: <T>() => value.all<T>(),
      run: <T>() => value.run<T>(),
    };
    underlying.set(adapter, value);
    return adapter;
  }
  return {
    prepare: (query) => statement(native.prepare(query), query),
    batch: async <T>(statements: readonly D1PreparedStatement[]): Promise<readonly D1Result<T>[]> => {
      const result = await native.batch<T>(statements.map((value) => {
        const actual = underlying.get(value);
        if (!actual) throw new Error("native batch received a foreign statement");
        return actual;
      }));
      if (result.at(-1)?.meta.changes === 0) onLostCas();
      return result;
    },
  };
}

function runtime(root: string): Miniflare {
  return new Miniflare({
    host: "127.0.0.1",
    port: 0,
    compatibilityDate: "2026-07-17",
    modules: [{
      type: "ESModule",
      path: "sweep-cursor-native.mjs",
      contents: "export default {fetch(){return new Response('ok')}}",
    }],
    d1Databases: { CONTROL: "sweep-cursor-native" },
    d1Persist: join(root, "d1"),
  });
}

test("native D1 competing cursor snapshots retry CAS, preserve bounded pages and survive workerd restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "takosumi-sweep-d1-"));
  let worker: Miniflare | undefined;
  try {
    worker = runtime(root);
    const native = await worker.getD1Database("CONTROL");
    let snapshots = 0;
    let lostCas = 0;
    let race = false;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const db = databaseBridge(native, async () => {
      if (!race) return;
      snapshots += 1;
      if (snapshots <= 2) {
        if (snapshots === 2) release();
        await barrier;
      }
    }, () => { if (race) lostCas += 1; });
    await ensureD1OpenTofuLedgerSchema(db);
    await verifyD1OpenTofuLedgerSchemaPredeployed(db);
    const first = new CloudflareD1OpenTofuControlStore(db, { schemaMode: "predeployed" });
    const second = new CloudflareD1OpenTofuControlStore(db, { schemaMode: "predeployed" });
    for (let i = 0; i < 7; i++) {
      const id = `cap_${i}`;
      // Live apps of separate Workspaces, stale and active alike.
      await first.putCapsule({
        id, workspaceId: `ws_${i}`, projectId: `prj_${i}`, name: id, slug: id,
        sourceId: "src_native_sweep", installConfigId: `cfg_${id}`, environment: "production",
        currentStateGeneration: 0, status: i % 2 ? "stale" : "active",
        createdAt: "2026-10-14T00:00:00.000Z", updatedAt: "2026-10-14T00:00:00.000Z",
      });
    }
    race = true;
    const pages = await Promise.all([
      first.listCapsulesForScheduledSweep(2), second.listCapsulesForScheduledSweep(2),
    ]);
    race = false;
    expect(pages.map((page) => page.length)).toEqual([2, 2]);
    expect(pages.flatMap((page) => page.map((row) => row.id)).sort()).toEqual(["cap_0", "cap_1", "cap_2", "cap_3"]);
    expect(snapshots).toBeGreaterThanOrEqual(3);
    expect(lostCas).toBeGreaterThanOrEqual(1);
    const reserved = await db.prepare(
      "select generation, cursor_id, upper_id from scheduled_sweep_cursors where lane = 'active_capsules'",
    ).first<{ generation: number; cursor_id: string; upper_id: string }>();
    expect(reserved).toEqual({ generation: 2, cursor_id: "cap_3", upper_id: "cap_6" });

    // Drop allocated pages without executing their effects, then terminate the
    // actual workerd process. The next worker continues the same durable lap.
    await worker.dispose();
    worker = runtime(root);
    const restarted = new CloudflareD1OpenTofuControlStore(databaseBridge(await worker.getD1Database("CONTROL")));
    expect((await restarted.listCapsulesForScheduledSweep(2)).map((row) => row.id)).toEqual(["cap_4", "cap_5"]);
    expect((await restarted.listCapsulesForScheduledSweep(2)).map((row) => row.id)).toEqual(["cap_6"]);
    expect((await restarted.listCapsulesForScheduledSweep(2)).map((row) => row.id)).toEqual(["cap_0", "cap_1"]);
  } finally {
    if (worker) await worker.dispose();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
