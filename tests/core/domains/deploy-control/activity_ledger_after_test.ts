import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import type { ActivityEvent } from "takosumi-contract/activity";

import {
  InMemoryOpenTofuControlStore,
  type OpenTofuControlStore,
} from "../../../../core/domains/deploy-control/store.ts";
import { SqlOpenTofuControlStore } from "../../../../core/domains/deploy-control/store_sql.ts";
import { CloudflareD1OpenTofuControlStore } from "../../../../worker/src/d1_opentofu_store.ts";
import { PGliteSqlClient } from "../../../helpers/deploy-control/pglite_sql_client.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";

setDefaultTimeout(60_000);

const clients: PGliteSqlClient[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

async function stores(): Promise<readonly [string, OpenTofuControlStore][]> {
  const pg = await PGliteSqlClient.create();
  clients.push(pg);
  return [
    ["memory", new InMemoryOpenTofuControlStore()],
    ["postgres", new SqlOpenTofuControlStore({ client: pg })],
    ["d1", new CloudflareD1OpenTofuControlStore(new SqliteFakeD1())],
  ];
}

function event(id: string, createdAt: string, workspaceId = "workspace_a"): ActivityEvent {
  return {
    id,
    workspaceId,
    action: "run.failed",
    targetType: "run",
    targetId: `run_${id}`,
    metadata: { capsuleId: "cap_1" },
    createdAt,
  };
}

test("the whole ledger reads oldest first after a (createdAt, id) cursor, bounded above", async () => {
  for (const [name, store] of await stores()) {
    // Two Workspaces, a tie on createdAt broken by bytewise id order
    // (uppercase sorts before lowercase), and one event after the bound.
    const rows = [
      event("act_b", "2026-10-30T00:00:01.000Z", "workspace_b"),
      event("act_a", "2026-10-30T00:00:01.000Z"),
      event("act_Z", "2026-10-30T00:00:01.000Z"),
      event("act_0", "2026-10-30T00:00:00.500Z", "workspace_b"),
      event("act_late", "2026-10-30T00:00:05.000Z"),
    ];
    for (const row of rows) await store.putActivityEvent(row);
    const until = "2026-10-30T00:00:02.000Z";
    const first = await store.listActivityEventsAfter({ untilCreatedAt: until, limit: 2 });
    expect({ name, ids: first.map((row) => row.id) }).toEqual({ name, ids: ["act_0", "act_Z"] });
    const second = await store.listActivityEventsAfter({
      after: { createdAt: first[1]!.createdAt, id: first[1]!.id },
      untilCreatedAt: until,
      limit: 10,
    });
    expect({ name, ids: second.map((row) => row.id) }).toEqual({ name, ids: ["act_a", "act_b"] });
    expect(second[0]).toEqual(rows[1]!);
    const done = await store.listActivityEventsAfter({
      after: { createdAt: second[1]!.createdAt, id: second[1]!.id },
      untilCreatedAt: until,
      limit: 10,
    });
    expect({ name, ids: done }).toEqual({ name, ids: [] });
    const later = await store.listActivityEventsAfter({
      after: { createdAt: second[1]!.createdAt, id: second[1]!.id },
      untilCreatedAt: "2026-10-30T00:00:05.000Z",
      limit: 1000,
    });
    expect({ name, ids: later.map((row) => row.id) }).toEqual({ name, ids: ["act_late"] });
  }
});
