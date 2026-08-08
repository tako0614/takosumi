import { afterEach, expect, test } from "bun:test";

import type { StateVersion } from "@takosumi/internal/deploy-control-api";
import { CapsuleQuery } from "../../../../core/domains/deploy-control/capsule_query.ts";
import {
  InMemoryOpenTofuControlStore,
  type OpenTofuControlStore,
} from "../../../../core/domains/deploy-control/store.ts";
import { SqlOpenTofuControlStore } from "../../../../core/domains/deploy-control/store_sql.ts";
import { CloudflareD1OpenTofuControlStore } from "../../../../worker/src/d1_opentofu_store.ts";
import { PGliteSqlClient } from "../../../helpers/deploy-control/pglite_sql_client.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";

const TS = "2026-07-29T00:00:00.000Z";
const pgClients: PGliteSqlClient[] = [];

afterEach(async () => {
  await Promise.all(pgClients.splice(0).map((client) => client.close()));
});

function stateVersion(id: string, generation: number): StateVersion {
  return {
    id,
    workspaceId: "workspace_bulk",
    capsuleId: "capsule_bulk",
    environment: "production",
    generation,
    stateRef: `state/${id}`,
    digest: `sha256:${id}`,
    createdByRunId: `run_${id}`,
    createdAt: TS,
  };
}

async function stores(): Promise<readonly [string, OpenTofuControlStore][]> {
  const pgClient = await PGliteSqlClient.create();
  pgClients.push(pgClient);
  return [
    ["memory", new InMemoryOpenTofuControlStore()],
    ["postgres", new SqlOpenTofuControlStore({ client: pgClient })],
    ["d1", new CloudflareD1OpenTofuControlStore(new SqliteFakeD1())],
  ];
}

test("StateVersion bulk lookup preserves caller order and duplicates while omitting missing ids", async () => {
  for (const [label, store] of await stores()) {
    const first = stateVersion("state_bulk_first", 1);
    const second = stateVersion("state_bulk_second", 2);
    await store.putStateVersion(first);
    await store.putStateVersion(second);

    expect(
      (
        await store.getStateVersionsByIds([
          second.id,
          "state_bulk_missing",
          first.id,
          second.id,
        ])
      ).map((row) => row.id),
      label,
    ).toEqual([second.id, first.id, second.id]);
    expect(await store.getStateVersionsByIds([]), label).toEqual([]);
  }
});

test("Capsule query performs one bulk read and preserves its unique first-seen semantics", async () => {
  class ObservedStore extends InMemoryOpenTofuControlStore {
    bulkReads = 0;
    individualReads = 0;

    override getStateVersion(id: string): Promise<StateVersion | undefined> {
      this.individualReads += 1;
      return super.getStateVersion(id);
    }

    override getStateVersionsByIds(
      ids: readonly string[],
    ): Promise<readonly StateVersion[]> {
      this.bulkReads += 1;
      return super.getStateVersionsByIds(ids);
    }
  }

  const store = new ObservedStore();
  const first = stateVersion("state_query_first", 1);
  const second = stateVersion("state_query_second", 2);
  await store.putStateVersion(first);
  await store.putStateVersion(second);
  const query = new CapsuleQuery(store, (capsule) => capsule);

  expect(
    (
      await query.listStateVersionsByIds([
        second.id,
        "",
        "state_query_missing",
        first.id,
        second.id,
      ])
    ).map((row) => row.id),
  ).toEqual([second.id, first.id]);
  expect(store.bulkReads).toBe(1);
  expect(store.individualReads).toBe(0);
});
