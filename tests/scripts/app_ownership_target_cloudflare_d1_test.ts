import { expect, test } from "bun:test";
import type { Capsule } from "../../contract/capsules.ts";
import type { ProviderConnection } from "../../contract/connections.ts";
import type { UsageEvent } from "../../contract/billing.ts";
import type { Workspace, WorkspaceMember } from "../../contract/workspaces.ts";
import { D1AppOwnershipStore } from "../../core/domains/app-ownership/store.ts";
import type { OpenTofuControlStore } from "../../core/domains/deploy-control/store.ts";
import { CloudflareD1OpenTofuControlStore, ensureD1OpenTofuLedgerSchema } from "../../worker/src/d1_opentofu_store.ts";
import type { D1PreparedStatement } from "../../worker/src/bindings.ts";
import { SqliteFakeD1 } from "../helpers/deploy-control/sqlite_fake_d1.ts";
import {
  isOwnershipTargetRead, isOwnershipTargetWrite, openCloudflareD1OwnershipTarget,
  OwnershipTargetRefusal, ownershipTargetSqlShape,
} from "../../scripts/app-ownership-target-cloudflare-d1.ts";
import { runAppOwnershipBackfill } from "../../scripts/backfill-app-ownership.ts";
import { runAppAccessCutoverVerification } from "../../scripts/verify-app-access-cutover.ts";

const now = "2026-10-29T00:00:00.000Z";
const ACCOUNT = "acct_fixture";
const DATABASE = "db_fixture_control";
const TOKEN = "token-value-that-must-never-leak";
const VERSION = "11111111-2222-4333-8444-555555555555";
const AUTH_VERSION = "66666666-7777-4888-8999-aaaaaaaaaaaa";

type Binding = Record<string, unknown>;
interface FakeWorker { versions: { version_id: string; percentage: number }[]; bindings: Map<string, Binding[]> }

/** Cloudflare REST API fake backed by the same SQLite engine the D1 fixtures use. */
class FakeCloudflare {
  readonly d1 = new SqliteFakeD1();
  readonly requests: { method: string; path: string; body?: Record<string, unknown> }[] = [];
  readonly workers = new Map<string, FakeWorker>();
  databaseName = "takosumi-fixture-control";
  readonly fetch: typeof fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = new URL(String(input));
    expect(url.toString()).not.toContain(TOKEN);
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${TOKEN}`);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    this.requests.push({ method, path: url.pathname, ...(body ? { body } : {}) });
    const prefix = `/client/v4/accounts/${ACCOUNT}`;
    const path = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : "";
    try {
      if (method === "POST" && path === `/d1/database/${DATABASE}/query`) return ok(await this.query(body!));
      if (method === "POST" && path === `/d1/database/${DATABASE}/raw`) {
        const [columns, ...rows] = await this.statement(body!).raw<unknown[]>({ columnNames: true } as never);
        return ok([{ success: true, results: { columns, rows }, meta: {} }]);
      }
      if (method === "GET" && path === `/d1/database/${DATABASE}`) return ok({ uuid: DATABASE, name: this.databaseName });
      if (method === "GET" && path === "/workers/scripts") return ok([...this.workers.keys()].map((id) => ({ id })));
      const deployments = /^\/workers\/scripts\/([^/]+)\/deployments$/u.exec(path);
      if (method === "GET" && deployments) {
        const worker = this.workers.get(decodeURIComponent(deployments[1]!));
        return worker ? ok({ deployments: worker.versions.length ? [{ id: "deployment", versions: worker.versions }] : [] }) : notFound();
      }
      const version = /^\/workers\/scripts\/([^/]+)\/versions\/([^/]+)$/u.exec(path);
      if (method === "GET" && version) {
        const bindings = this.workers.get(decodeURIComponent(version[1]!))?.bindings.get(decodeURIComponent(version[2]!));
        return bindings ? ok({ id: version[2], resources: { bindings } }) : notFound();
      }
      return notFound();
    } catch (error) {
      return Response.json({ success: false, errors: [{ code: 7500, message: String(error) }] }, { status: 400 });
    }
  }) as typeof fetch;

  statement(body: Record<string, unknown>): D1PreparedStatement & { raw<T>(options?: unknown): Promise<T[]> } {
    const prepared = this.d1.prepare(String(body.sql));
    const params = (body.params ?? []) as unknown[];
    return (params.length ? prepared.bind(...params) : prepared) as D1PreparedStatement & { raw<T>(options?: unknown): Promise<T[]> };
  }

  async query(body: Record<string, unknown>) {
    const one = async (query: Record<string, unknown>) => {
      const statement = this.statement(query);
      if (/^\s*(?:select|with|pragma)\b/iu.test(String(query.sql))) {
        return { success: true, results: (await statement.all()).results ?? [], meta: {} };
      }
      const result = await statement.run();
      return { success: true, results: [], meta: result.meta ?? {} };
    };
    if (Array.isArray(body.batch)) {
      const statements = (body.batch as Record<string, unknown>[]).map((query) => this.statement(query));
      const results = await this.d1.batch(statements);
      return results.map((result) => ({ success: true, results: result.results ?? [], meta: result.meta ?? {} }));
    }
    return [await one(body)];
  }

  setWorker(script: string, versionId: string, bindings: Binding[], versions = [{ version_id: versionId, percentage: 100 }]) {
    this.workers.set(script, { versions, bindings: new Map([[versionId, bindings]]) });
  }

  d1Writes() {
    return this.requests.filter((request) => request.path.endsWith("/query")).flatMap((request) =>
      (Array.isArray(request.body?.batch) ? request.body!.batch as Record<string, unknown>[] : [request.body!])
        .map((query) => String(query.sql)).filter((sql) => !/^\s*(?:select|with|pragma)\b/iu.test(sql)));
  }
}

/** Drizzle wraps a driver error as the `cause` of its query error. */
function refusalCode(error: unknown): string | undefined {
  for (let current = error; current instanceof Error; current = (current as Error & { cause?: unknown }).cause) {
    if (current instanceof OwnershipTargetRefusal) return current.code;
  }
  return undefined;
}
const rejection = (promise: Promise<unknown>) => promise.then(() => undefined, (error: unknown) => error);

const ok = (result: unknown) => Response.json({ success: true, errors: [], messages: [], result });
const notFound = () => Response.json({ success: false, errors: [{ code: 10007, message: "not found" }] }, { status: 404 });
const controlBinding = { type: "d1", name: "TAKOSUMI_CONTROL_DB", id: DATABASE, database_id: DATABASE };

async function seeded(): Promise<FakeCloudflare> {
  const cloudflare = new FakeCloudflare();
  await ensureD1OpenTofuLedgerSchema(cloudflare.d1);
  const control = new CloudflareD1OpenTofuControlStore(cloudflare.d1);
  const workspaces: Workspace[] = [
    { id: "personal", handle: "personal", displayName: "Personal", type: "personal", ownerUserId: "owner", createdAt: now, updatedAt: now },
    { id: "organization", handle: "organization", displayName: "Team", type: "organization", ownerUserId: "owner", createdAt: now, updatedAt: now },
  ];
  for (const workspace of workspaces) await control.putWorkspace(workspace);
  const members: WorkspaceMember[] = [
    { id: "m1", workspaceId: "personal", accountId: "owner", roles: ["owner"], status: "active", createdAt: now, updatedAt: now },
    { id: "m2", workspaceId: "organization", accountId: "owner", roles: ["owner"], status: "active", createdAt: now, updatedAt: now },
    { id: "m3", workspaceId: "organization", accountId: "admin", roles: ["admin"], status: "active", createdAt: now, updatedAt: now },
  ];
  for (const member of members) await control.putWorkspaceMember(member);
  for (const workspaceId of ["personal", "organization"]) {
    await control.putCapsule({
      id: `cap-${workspaceId}`, workspaceId, projectId: `prj-${workspaceId}`, name: workspaceId, slug: workspaceId,
      sourceId: `src-${workspaceId}`, installConfigId: `cfg-${workspaceId}`, environment: "production", status: "active",
      currentStateGeneration: 0, createdAt: now, updatedAt: now,
    } as Capsule);
  }
  await control.putConnection({ id: "connection", workspaceId: "organization", provider: "example", scope: "workspace",
    status: "verified", createdAt: now, updatedAt: now } as ProviderConnection);
  await control.putUsageEvent({ id: "usage", workspaceId: "organization", capsuleId: "cap-organization", kind: "runner_minute",
    quantity: 1, usdMicros: 0, ratingStatus: "unrated", source: "runner", idempotencyKey: "usage", createdAt: now } as UsageEvent);
  // Retained pre-expand rows: no owner/payer columns yet.
  await cloudflare.d1.prepare("update usage_events set payer_account_id=null").run();
  await cloudflare.d1.prepare("update connections set owner_account_id=null, connection_json=json_remove(connection_json, '$.ownerAccountId')").run();
  cloudflare.setWorker("takosumi-fixture", VERSION, [controlBinding, { type: "plain_text", name: "TAKOSUMI_ACCOUNTS_WORKSPACE_MUTATIONS_FROZEN", text: "true" }]);
  cloudflare.setWorker("takosumi-auth-fixture", AUTH_VERSION, [controlBinding]);
  cloudflare.setWorker("unrelated-fixture", "99999999-8888-4777-8666-555555555555", [{ type: "d1", name: "OTHER", id: "db_other" }]);
  return cloudflare;
}

function env(extra: Record<string, string> = {}) {
  return {
    TAKOSUMI_OWNERSHIP_D1_ACCOUNT_ID: ACCOUNT,
    TAKOSUMI_OWNERSHIP_D1_DATABASE_ID: DATABASE,
    TAKOSUMI_OWNERSHIP_D1_API_TOKEN_FILE: "/operator/private/cloudflare-token",
    ...extra,
  };
}
const files = { "/operator/private/cloudflare-token": `${TOKEN}\n` } as Record<string, string>;
const readFile = (path: string) => {
  const value = files[path];
  if (value === undefined) throw new Error("ENOENT");
  return value;
};
const freezeWorkers = JSON.stringify([
  { script: "takosumi-fixture", versionId: VERSION },
  { script: "takosumi-auth-fixture", versionId: AUTH_VERSION },
]);

test("statement policy admits reads and the backfill's column-scoped ownership writes only", () => {
  const read = (sql: string) => isOwnershipTargetRead(ownershipTargetSqlShape(sql));
  const write = (sql: string) => isOwnershipTargetWrite(ownershipTargetSqlShape(sql));
  for (const sql of [
    "select * from capsules where id = ?",
    "WITH x AS (select 1) SELECT * FROM x",
    "select 'delete from capsules; drop table x' as text",
    "select \"release\" from t",
    "pragma table_info(capsules)",
    `pragma index_list("capsules")`,
    "pragma table_xinfo('capsules')",
    "select json_group_array(name) from pragma_table_xinfo('capsules')",
  ]) expect(read(sql), sql).toBe(true);
  for (const sql of [
    "update capsules set owner_account_id=? where id=?",
    "with x as (select 1) delete from capsules",
    "select 1; delete from capsules",
    "select 1 -- comment\n; drop table capsules",
    "select 1 /* hidden */; drop table capsules",
    "pragma writable_schema = 1",
    "pragma foreign_keys = off",
    "insert into capsules values (1)",
    "select 'unterminated",
    "begin",
  ]) expect(read(sql), sql).toBe(false);
  for (const sql of [
    "update capsules set owner_account_id=?,ownership_epoch=?,management_state=?,management_epoch=?,storage_root=?\n where id=? and owner_account_id is null",
    "update connections set owner_account_id=? where id=? and owner_account_id is null and json_extract(connection_json, '$.scope')='workspace'",
    "update usage_events set payer_account_id=? where id=? and payer_account_id is null",
    "insert into capsule_members (capsule_id,account_id,status,added_by,created_at,updated_at) select ?,?,?,?,?,? where exists(select 1 from capsules where id=?) on conflict (capsule_id,account_id) do update set status=excluded.status",
    "insert into account_billing_bindings (account_id,billing_authority,billing_ref,organization_ref,created_at,updated_at) values (?,?,?,?,?,?)",
    "delete from capsule_members where capsule_id=? and account_id=? and changes()=1",
  ]) expect(write(sql), sql).toBe(true);
  for (const sql of [
    "update capsules set status=? where id=?",
    "update capsules set owner_account_id=?, record_json=? where id=?",
    "update capsules set owner_account_id=?",
    "update workspaces set handle=? where id=?",
    "delete from capsules where id=?",
    "insert into workspaces (id) values (?)",
    "drop table capsule_members",
    "update usage_events set payer_account_id=? where id=?; drop table usage_events",
    "insert into capsule_members (capsule_id) values (?); pragma foreign_keys=off",
  ]) expect(write(sql), sql).toBe(false);
});

test("read-only adapter runs the cutover verifier and backfill dry-run over the D1 REST API with no write", async () => {
  const cloudflare = await seeded();
  const direct = new CloudflareD1OpenTofuControlStore(cloudflare.d1) as OpenTofuControlStore;
  const expected = {
    report: await runAppAccessCutoverVerification({ control: direct, ownership: new D1AppOwnershipStore(cloudflare.d1, direct) }),
    plan: await runAppOwnershipBackfill({ control: direct, ownership: new D1AppOwnershipStore(cloudflare.d1, direct) }, {}),
  };
  const logs: string[] = [];
  const context = await openCloudflareD1OwnershipTarget({ env: env(), fetch: cloudflare.fetch, readFile, log: (line) => logs.push(line) });
  expect("workspaceMutationsFrozen" in context).toBe(false);
  const report = await runAppAccessCutoverVerification(context);
  const plan = await runAppOwnershipBackfill(context, {});
  expect(report).toEqual(expected.report);
  expect(plan).toEqual(expected.plan);
  expect(plan.writes.length).toBeGreaterThan(0);
  expect(cloudflare.requests.some((request) => request.path.endsWith("/raw"))).toBe(true);
  expect(cloudflare.requests.every((request) => request.method === "POST" && request.path.includes(`/d1/database/${DATABASE}/`))).toBe(true);
  expect(cloudflare.d1Writes()).toEqual([]);
  // The backfill apply path refuses a read-only target before any write.
  await expect(runAppOwnershipBackfill(context, { apply: true, expectedDigest: plan.digest })).rejects.toThrow("workspaceMutationsFrozen");
  await expect(context.ownership.setUsagePayerIfMissing("usage", "owner")).rejects.toMatchObject({ code: "ownership_target_read_only_refused" });
  expect(refusalCode(await rejection(context.control.putWorkspace({ id: "x", handle: "x", displayName: "x", type: "personal",
    ownerUserId: "x", createdAt: now, updatedAt: now })))).toBe("ownership_target_read_only_refused");
  expect(cloudflare.d1Writes()).toEqual([]);
  await context.close();
  expect(logs).toHaveLength(1);
  expect(JSON.parse(logs[0]!)).toMatchObject({ kind: "takosumi.app-ownership-target@v1", mode: "read-only", writes: 0 });
  expect(JSON.parse(logs[0]!).refused).toBeGreaterThanOrEqual(2);
  expect(logs.join("\n")).not.toContain(TOKEN);
  expect(logs.join("\n")).not.toContain(DATABASE);
});

test("apply adapter proves the freeze from Cloudflare, writes only ownership rows and completes the backfill", async () => {
  const cloudflare = await seeded();
  let clock = 0;
  const context = await openCloudflareD1OwnershipTarget({
    env: env({ TAKOSUMI_OWNERSHIP_TARGET_MODE: "apply", TAKOSUMI_OWNERSHIP_FREEZE_WORKERS: freezeWorkers,
      TAKOSUMI_OWNERSHIP_D1_DATABASE_NAME: "takosumi-fixture-control" }),
    fetch: cloudflare.fetch, readFile, now: () => clock, log: () => {},
  });
  expect(context.workspaceMutationsFrozen).toBe(true);
  const dryRun = await runAppOwnershipBackfill(context, {});
  expect(dryRun.writes.map((write) => write.kind).sort()).toEqual(["connection", "member", "ownership", "ownership", "usage"]);
  expect(cloudflare.d1Writes()).toEqual([]);
  const applied = await runAppOwnershipBackfill(context, { apply: true, expectedDigest: dryRun.digest });
  expect(applied).toMatchObject({ mode: "apply", applied: dryRun.writes.length });
  const writes = cloudflare.d1Writes();
  expect(writes.length).toBeGreaterThan(0);
  expect(writes.every((sql) => isOwnershipTargetWrite(ownershipTargetSqlShape(sql)))).toBe(true);
  expect((await runAppOwnershipBackfill(context, {})).writes).toEqual([]);
  expect(await cloudflare.d1.prepare("select id,owner_account_id from capsules order by id").all()).toMatchObject({
    results: [{ id: "cap-organization", owner_account_id: "owner" }, { id: "cap-personal", owner_account_id: "owner" }],
  });
  expect(await cloudflare.d1.prepare("select capsule_id,account_id,status from capsule_members").all()).toMatchObject({
    results: [{ capsule_id: "cap-organization", account_id: "admin", status: "active" }],
  });
  expect(await cloudflare.d1.prepare("select payer_account_id from usage_events").first()).toEqual({ payer_account_id: "owner" });
  const report = await runAppAccessCutoverVerification(context);
  // The migrated Workspace admin is an app member: by design it loses only owner-only actions.
  expect(report).toMatchObject({ capsulesChecked: 2, capsulesProjectedFromBackfill: 0, differenceCount: 1,
    differences: [{ capsuleId: "cap-organization", accountId: "admin", accessClass: "owner_only", reason: "workspace_manager_not_app_owner" }] });
  // The Control store stays read-only even in apply mode.
  expect(refusalCode(await rejection(context.control.putWorkspace({ id: "x", handle: "x", displayName: "x", type: "personal",
    ownerUserId: "x", createdAt: now, updatedAt: now })))).toBe("ownership_target_read_only_refused");
  await context.close();
});

test("apply adapter re-proves a stale freeze before writing and stops when the freeze was lifted", async () => {
  const cloudflare = await seeded();
  let clock = 0;
  const context = await openCloudflareD1OwnershipTarget({
    env: env({ TAKOSUMI_OWNERSHIP_TARGET_MODE: "apply", TAKOSUMI_OWNERSHIP_FREEZE_WORKERS: freezeWorkers }),
    fetch: cloudflare.fetch, readFile, now: () => clock, log: () => {},
  });
  const plan = await runAppOwnershipBackfill(context, {});
  cloudflare.setWorker("takosumi-fixture", VERSION, [controlBinding, { type: "plain_text", name: "TAKOSUMI_ACCOUNTS_WORKSPACE_MUTATIONS_FROZEN", text: "false" }]);
  clock = 30_000;
  expect(refusalCode(await rejection(runAppOwnershipBackfill(context, { apply: true, expectedDigest: plan.digest }))))
    .toBe("ownership_freeze_not_frozen:takosumi-fixture");
  expect(cloudflare.d1Writes()).toEqual([]);
  expect(await cloudflare.d1.prepare("select count(*) as count from capsules where owner_account_id is not null").first()).toEqual({ count: 0 });
});

for (const [label, mutate, code] of [
  ["a split deployment", (cloudflare: FakeCloudflare) => cloudflare.setWorker("takosumi-fixture", VERSION, [controlBinding],
    [{ version_id: VERSION, percentage: 90 }, { version_id: AUTH_VERSION, percentage: 10 }]), "ownership_freeze_version_mismatch:takosumi-fixture"],
  ["a different serving Version", (cloudflare: FakeCloudflare) => cloudflare.setWorker("takosumi-fixture", AUTH_VERSION, [controlBinding]),
    "ownership_freeze_version_mismatch:takosumi-fixture"],
  ["an unfrozen Worker", (cloudflare: FakeCloudflare) => cloudflare.setWorker("takosumi-auth-fixture", AUTH_VERSION,
    [controlBinding, { type: "plain_text", name: "TAKOSUMI_ACCOUNTS_WORKSPACE_MUTATIONS_FROZEN", text: "off" }]), "ownership_freeze_not_frozen:takosumi-auth-fixture"],
  ["an invalid freeze value", (cloudflare: FakeCloudflare) => cloudflare.setWorker("takosumi-auth-fixture", AUTH_VERSION,
    [controlBinding, { type: "plain_text", name: "TAKOSUMI_ACCOUNTS_WORKSPACE_MUTATIONS_FROZEN", text: "maybe" }]), "ownership_freeze_variable_invalid:takosumi-auth-fixture"],
  ["an unreadable secret freeze value", (cloudflare: FakeCloudflare) => cloudflare.setWorker("takosumi-auth-fixture", AUTH_VERSION,
    [controlBinding, { type: "secret_text", name: "TAKOSUMI_ACCOUNTS_WORKSPACE_MUTATIONS_FROZEN" }]), "ownership_freeze_variable_invalid:takosumi-auth-fixture"],
  ["a listed Worker on another database", (cloudflare: FakeCloudflare) => cloudflare.setWorker("takosumi-auth-fixture", AUTH_VERSION,
    [{ type: "d1", name: "TAKOSUMI_CONTROL_DB", id: "db_other" }]), "ownership_freeze_worker_not_bound:takosumi-auth-fixture"],
  ["an unlisted Worker bound to this database", (cloudflare: FakeCloudflare) => cloudflare.setWorker("forgotten-fixture",
    "12121212-3434-4565-8787-989898989898", [controlBinding]), "ownership_freeze_unlisted_worker:forgotten-fixture"],
] as const) {
  test(`apply adapter refuses ${label} before any D1 request`, async () => {
    const cloudflare = await seeded();
    mutate(cloudflare);
    await expect(openCloudflareD1OwnershipTarget({
      env: env({ TAKOSUMI_OWNERSHIP_TARGET_MODE: "apply", TAKOSUMI_OWNERSHIP_FREEZE_WORKERS: freezeWorkers }),
      fetch: cloudflare.fetch, readFile, log: () => {},
    })).rejects.toMatchObject({ code });
    expect(cloudflare.requests.some((request) => request.path.includes("/d1/database/"))).toBe(false);
  });
}

test("adapter configuration fails closed without echoing credentials", async () => {
  const cloudflare = await seeded();
  const open = (values: Record<string, string>) => openCloudflareD1OwnershipTarget({ env: values, fetch: cloudflare.fetch, readFile, log: () => {} });
  for (const [values, code] of [
    [{ ...env(), TAKOSUMI_OWNERSHIP_TARGET_MODE: "write" }, "ownership_target_mode_invalid"],
    [{ ...env(), TAKOSUMI_OWNERSHIP_D1_API_TOKEN: TOKEN }, "ownership_target_config_ambiguous:TAKOSUMI_OWNERSHIP_D1_API_TOKEN"],
    [{ ...env(), TAKOSUMI_OWNERSHIP_D1_API_TOKEN_FILE: "relative/token" }, "ownership_target_config_path_not_absolute:TAKOSUMI_OWNERSHIP_D1_API_TOKEN"],
    [{ ...env(), TAKOSUMI_OWNERSHIP_D1_API_TOKEN_FILE: "/operator/private/missing" }, "ownership_target_config_unreadable:TAKOSUMI_OWNERSHIP_D1_API_TOKEN"],
    [{ TAKOSUMI_OWNERSHIP_D1_ACCOUNT_ID: ACCOUNT, TAKOSUMI_OWNERSHIP_D1_API_TOKEN_FILE: "/operator/private/cloudflare-token" }, "ownership_target_config_missing:TAKOSUMI_OWNERSHIP_D1_DATABASE_ID"],
    [{ ...env(), TAKOSUMI_OWNERSHIP_TARGET_MODE: "apply" }, "ownership_target_config_missing:TAKOSUMI_OWNERSHIP_FREEZE_WORKERS"],
    [{ ...env(), TAKOSUMI_OWNERSHIP_TARGET_MODE: "apply", TAKOSUMI_OWNERSHIP_FREEZE_WORKERS: "[]" }, "ownership_freeze_workers_invalid"],
    [{ ...env(), TAKOSUMI_OWNERSHIP_TARGET_MODE: "apply", TAKOSUMI_OWNERSHIP_FREEZE_WORKERS: JSON.stringify([{ script: "takosumi-fixture", versionId: "latest" }]) }, "ownership_freeze_workers_invalid"],
    [{ ...env(), TAKOSUMI_OWNERSHIP_D1_DATABASE_NAME: "takosumi-production-control" }, "ownership_target_database_name_mismatch"],
  ] as const) {
    const error = await open(values as Record<string, string>).then(() => undefined, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(OwnershipTargetRefusal);
    expect((error as OwnershipTargetRefusal).code).toBe(code);
    expect(String((error as Error).message)).not.toContain(TOKEN);
  }
  expect(cloudflare.d1Writes()).toEqual([]);
});

test("reads retry on 429/5xx while an unacknowledged write is never retried", async () => {
  const cloudflare = await seeded();
  const failures = { read: 1, write: 1 };
  const flaky: typeof fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    const sql = String((Array.isArray(body?.batch) ? (body!.batch as Record<string, unknown>[])[0]?.sql : body?.sql) ?? "");
    const isWrite = String(input).includes("/d1/database/") && sql !== "" && !/^\s*(?:select|with|pragma)\b/iu.test(sql);
    if (String(input).endsWith("/raw") && failures.read > 0) {
      failures.read--;
      return Response.json({ success: false }, { status: 429 });
    }
    if (isWrite && failures.write > 0) {
      failures.write--;
      cloudflare.requests.push({ method: "POST", path: "unacknowledged-write" });
      return Response.json({ success: false }, { status: 503 });
    }
    return await cloudflare.fetch(input, init);
  }) as typeof fetch;
  const sleeps: number[] = [];
  const context = await openCloudflareD1OwnershipTarget({
    env: env({ TAKOSUMI_OWNERSHIP_TARGET_MODE: "apply", TAKOSUMI_OWNERSHIP_FREEZE_WORKERS: freezeWorkers }),
    fetch: flaky, readFile, log: () => {}, sleep: async (milliseconds) => { sleeps.push(milliseconds); },
  });
  const plan = await runAppOwnershipBackfill(context, {});
  expect(failures.read).toBe(0);
  expect(sleeps).toContain(500);
  await expect(runAppOwnershipBackfill(context, { apply: true, expectedDigest: plan.digest })).rejects.toThrow();
  expect(cloudflare.requests.filter((request) => request.path === "unacknowledged-write")).toHaveLength(1);
  expect(cloudflare.d1Writes()).toEqual([]);
  // A new dry-run reconciles: nothing was applied, so the same plan is still pending.
  expect((await runAppOwnershipBackfill(context, {})).digest).toBe(plan.digest);
});
