import { expect, test } from "bun:test";

import { InMemoryOpenTofuDeploymentStore } from "./store.ts";
import { SqlOpenTofuDeploymentStore } from "./store_sql.ts";
import type {
  SqlClient,
  SqlParameters,
  SqlQueryResult,
} from "../../adapters/storage/sql.ts";
import type {
  App,
  DeploymentProfile,
  Environment,
  InstallProfile,
} from "takosumi-contract/lanes";
import type { OpenTofuDeploymentStore } from "./store.ts";

/**
 * Minimal in-memory SQL client that interprets exactly the lane statements the
 * {@link SqlOpenTofuDeploymentStore} emits (insert...on conflict, select-by-id,
 * select-by-filter with order, delete). Keyed per logical table by the first
 * column param. Lets the SQL store run its real SQL paths without a Postgres.
 */
class LaneSqlClient implements SqlClient {
  // table -> id -> { json, [filterColumn]: value }
  readonly #tables = new Map<string, Map<string, Record<string, unknown>>>();

  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    parameters?: SqlParameters,
  ): Promise<SqlQueryResult<Row>> {
    const lower = sql.trim().toLowerCase();
    const params = (parameters ?? []) as readonly unknown[];
    const table = tableName(lower);
    const rows = this.#table(table);
    const cast = (value: {
      rows: readonly unknown[];
      rowCount: number;
    }): SqlQueryResult<Row> => value as unknown as SqlQueryResult<Row>;

    if (lower.startsWith("insert into")) {
      // Column order matches the store: id is $1 and the json blob the last text
      // param. Store the whole param row keyed by id; index helpers read params.
      const id = String(params[0]);
      const json = params.find((p) => typeof p === "string" && p.startsWith("{"));
      rows.set(id, { id, json: json ?? "{}", params });
      return Promise.resolve(cast({ rows: [], rowCount: 1 }));
    }
    if (lower.startsWith("delete from")) {
      // Lane deletes: `where id = $1`, or `where environment_id = $1 and id <> $2`.
      if (lower.includes("and id <>")) {
        const envId = String(params[0]);
        const keepId = String(params[1]);
        let removed = 0;
        for (const [key, row] of rows) {
          if (laneEnvId(row) === envId && key !== keepId) {
            rows.delete(key);
            removed += 1;
          }
        }
        return Promise.resolve(cast({ rows: [], rowCount: removed }));
      }
      const id = String(params[0]);
      const existed = rows.delete(id);
      return Promise.resolve(cast({ rows: [], rowCount: existed ? 1 : 0 }));
    }
    if (lower.startsWith("select")) {
      const result = this.#select(lower, params, rows);
      return Promise.resolve(cast({ rows: result, rowCount: result.length }));
    }
    throw new Error(`unhandled SQL: ${sql}`);
  }

  #select(
    lower: string,
    params: readonly unknown[],
    rows: Map<string, Record<string, unknown>>,
  ): { json: unknown }[] {
    const all = Array.from(rows.values());
    // select ... where id = $1
    if (lower.includes("where id = $1")) {
      const id = String(params[0]);
      const row = rows.get(id);
      return row ? [{ json: row.json }] : [];
    }
    // select ... where environment_id = $1 ...
    if (lower.includes("where environment_id = $1")) {
      const envId = String(params[0]);
      const match = all.filter((r) => laneEnvId(r) === envId);
      return match.map((r) => ({ json: r.json }));
    }
    // select ... where space_id = $1 ...
    if (lower.includes("where space_id = $1")) {
      const spaceId = String(params[0]);
      return all
        .filter((r) => laneCol(r, "space_id") === spaceId)
        .map((r) => ({ json: r.json }));
    }
    // select ... where app_id = $1 ...
    if (lower.includes("where app_id = $1")) {
      const appId = String(params[0]);
      return all
        .filter((r) => laneCol(r, "app_id") === appId)
        .map((r) => ({ json: r.json }));
    }
    // unfiltered list
    return all.map((r) => ({ json: r.json }));
  }

  #table(name: string): Map<string, Record<string, unknown>> {
    let table = this.#tables.get(name);
    if (!table) {
      table = new Map();
      this.#tables.set(name, table);
    }
    return table;
  }
}

/**
 * Reads a column value out of a stored insert param row by parsing the json blob
 * (every lane row stores the full object as its json blob, so the column values
 * are reachable there without tracking positional params per table).
 */
function laneCol(row: Record<string, unknown>, column: string): string | undefined {
  const obj = parsedJson(row);
  if (!obj) return undefined;
  const camel = column.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
  const value = obj[camel];
  return typeof value === "string" ? value : undefined;
}

function laneEnvId(row: Record<string, unknown>): string | undefined {
  return laneCol(row, "environment_id");
}

function parsedJson(row: Record<string, unknown>): Record<string, unknown> | undefined {
  const raw = row.json;
  if (typeof raw !== "string") return undefined;
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function tableName(lower: string): string {
  const match = lower.match(/(?:into|from)\s+(takosumi_[a-z_]+)/);
  if (!match) throw new Error(`no table in SQL: ${lower}`);
  return match[1];
}

function app(over: Partial<App> = {}): App {
  return {
    id: "app_1",
    spaceId: "space_1",
    name: "shop",
    sourceId: "src_1",
    installType: "opentofu_module",
    createdAt: "2026-06-06T00:00:00.000Z",
    updatedAt: "2026-06-06T00:00:00.000Z",
    ...over,
  };
}

function environment(over: Partial<Environment> = {}): Environment {
  return {
    id: "env_1",
    appId: "app_1",
    name: "production",
    ref: "main",
    path: ".",
    autoSync: true,
    autoPlan: true,
    autoApply: false,
    requireApproval: true,
    createdAt: "2026-06-06T00:00:00.000Z",
    updatedAt: "2026-06-06T00:00:00.000Z",
    ...over,
  };
}

function installProfile(over: Partial<InstallProfile> = {}): InstallProfile {
  return {
    id: "profile_1",
    name: "Cloudflare R2",
    installType: "opentofu_module",
    trustLevel: "official",
    variableMapping: {},
    outputAllowlist: {},
    policyId: "policy_1",
    createdAt: "2026-06-06T00:00:00.000Z",
    updatedAt: "2026-06-06T00:00:00.000Z",
    ...over,
  };
}

function deploymentProfile(over: Partial<DeploymentProfile> = {}): DeploymentProfile {
  return {
    id: "dpf_1",
    environmentId: "env_1",
    bindings: { compute: { mode: "service", connectionId: "conn_1" } },
    createdAt: "2026-06-06T00:00:00.000Z",
    updatedAt: "2026-06-06T00:00:00.000Z",
    ...over,
  };
}

// Run the same assertions against both store implementations so the in-memory
// dev/test store and the SQL production store stay symmetric.
function bothStores(): readonly [string, OpenTofuDeploymentStore][] {
  return [
    ["in-memory", new InMemoryOpenTofuDeploymentStore()],
    ["sql", new SqlOpenTofuDeploymentStore({ client: new LaneSqlClient() })],
  ];
}

test("App store: put/get/list-by-space/delete are symmetric", async () => {
  for (const [label, store] of bothStores()) {
    await store.putApp(app({ id: "app_a", spaceId: "space_1" }));
    await store.putApp(app({ id: "app_b", spaceId: "space_2", name: "blog" }));

    expect((await store.getApp("app_a"))?.name, label).toBe("shop");
    expect(await store.getApp("missing"), label).toBeUndefined();

    const spaceOne = await store.listApps("space_1");
    expect(spaceOne.map((a) => a.id), label).toEqual(["app_a"]);
    expect((await store.listApps()).length, label).toBe(2);

    expect(await store.deleteApp("app_a"), label).toBe(true);
    expect(await store.deleteApp("app_a"), label).toBe(false);
    expect((await store.listApps()).length, label).toBe(1);
  }
});

test("Environment store: put/get/list-by-app/delete are symmetric", async () => {
  for (const [label, store] of bothStores()) {
    await store.putEnvironment(environment({ id: "env_a", appId: "app_1" }));
    await store.putEnvironment(
      environment({ id: "env_b", appId: "app_1", name: "preview" }),
    );
    await store.putEnvironment(environment({ id: "env_c", appId: "app_2" }));

    expect((await store.getEnvironment("env_a"))?.name, label).toBe("production");
    const appOne = await store.listEnvironments("app_1");
    expect(appOne.map((e) => e.id).sort(), label).toEqual(["env_a", "env_b"]);

    expect(await store.deleteEnvironment("env_a"), label).toBe(true);
    expect((await store.listEnvironments("app_1")).map((e) => e.id), label)
      .toEqual(["env_b"]);
  }
});

test("InstallProfile store: put/get/list are symmetric", async () => {
  for (const [label, store] of bothStores()) {
    await store.putInstallProfile(installProfile({ id: "profile_b" }));
    await store.putInstallProfile(installProfile({ id: "profile_a" }));

    expect((await store.getInstallProfile("profile_a"))?.trustLevel, label)
      .toBe("official");
    expect((await store.listInstallProfiles()).map((p) => p.id).sort(), label)
      .toEqual(["profile_a", "profile_b"]);
  }
});

test("DeploymentProfile store: upsert keyed by environment is symmetric", async () => {
  for (const [label, store] of bothStores()) {
    await store.putDeploymentProfile(deploymentProfile({ id: "dpf_a" }));
    // A second profile for the SAME environment replaces the first (one per env).
    await store.putDeploymentProfile(
      deploymentProfile({
        id: "dpf_b",
        bindings: { dns: { mode: "customer", connectionId: "conn_dns" } },
      }),
    );
    const current = await store.getDeploymentProfileByEnvironment("env_1");
    expect(current?.id, label).toBe("dpf_b");
    expect(current?.bindings.dns?.connectionId, label).toBe("conn_dns");
    expect(current?.bindings.compute, label).toBeUndefined();

    expect(
      await store.getDeploymentProfileByEnvironment("env_missing"),
      label,
    ).toBeUndefined();
  }
});
