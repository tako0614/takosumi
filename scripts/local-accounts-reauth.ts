#!/usr/bin/env bun
/** Offline, local-substrate-only invalidation of opaque Accounts credentials.
 * No service endpoint, migration, signing-key, or production connection path.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const KIND = "takosumi.local-accounts-reauth@v1";
const DB = "takosumi_accounts";
const LOCAL_NETWORK = "local-substrate_takos-local-internal";
const TABLES = [
  "account_sessions",
  "authorization_codes",
  "oauth_access_tokens",
  "oauth_refresh_tokens",
  "personal_access_tokens",
] as const;
type Counts = Record<(typeof TABLES)[number], number>;

export interface ReauthPlan {
  readonly kind: typeof KIND;
  readonly project: string;
  readonly container: string;
  readonly volume: string;
  readonly database: typeof DB;
  readonly databaseOid: string;
  readonly systemIdentifier: string;
  readonly generation: string;
  readonly counts: Counts;
}

export interface ReauthTarget {
  readonly project: string;
  readonly container: string;
  readonly volume: string;
}

type Run = (command: string, args: readonly string[], input?: string) => string;

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function exactName(value: string, label: string): string {
  invariant(
    /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(value),
    `invalid ${label}`,
  );
  return value;
}

function exactContainer(value: string): string {
  invariant(
    /^[a-f0-9]{64}$/.test(value),
    "container must be an exact 64-character Docker ID",
  );
  return value;
}

function parseJson<T>(raw: string, label: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(`invalid ${label} response`);
  }
}

interface DockerContainer {
  Id: string;
  State: { Running: boolean };
  Config: { Image: string; Labels: Record<string, string> };
  Mounts: Array<{ Type: string; Name?: string; Destination: string }>;
  HostConfig: { PortBindings: Record<string, unknown> | null };
  NetworkSettings: { Networks: Record<string, unknown> };
}

interface DockerNetwork {
  Name: string;
  Containers: Record<string, unknown> | null;
}

export function assertLocalTarget(run: Run, target: ReauthTarget): void {
  const project = exactName(target.project, "project");
  const container = exactContainer(target.container);
  const volume = exactName(target.volume, "volume");
  const inspected = parseJson<DockerContainer[]>(
    run("docker", ["inspect", "--type", "container", container]),
    "Docker inspect",
  );
  invariant(inspected.length === 1, "target container is not unique");
  const row = inspected[0]!;
  invariant(
    row.Id === container && row.State.Running,
    "target Postgres container is not running",
  );
  invariant(
    row.Config.Labels["com.docker.compose.project"] === project &&
      row.Config.Labels["com.docker.compose.service"] ===
        "substrate-postgres" &&
      row.Config.Labels["com.docker.compose.oneoff"] === "False" &&
      row.Config.Image === "postgres:16-alpine" &&
      row.Config.Labels["com.docker.compose.project.config_files"]
        ?.split(",")
        .some((path) =>
          path.endsWith("/deploy/local-substrate/compose.substrate.yml"),
        ),
    "container is not the exact local-substrate Postgres service",
  );
  invariant(
    row.Mounts.some(
      (mount) =>
        mount.Type === "volume" &&
        mount.Name === volume &&
        mount.Destination === "/var/lib/postgresql/data",
    ),
    "Postgres data volume identity mismatch",
  );
  invariant(
    !row.HostConfig.PortBindings ||
      Object.keys(row.HostConfig.PortBindings).every(
        (key) => row.HostConfig.PortBindings?.[key] == null,
      ),
    "Postgres has a published host port",
  );
  invariant(
    Object.keys(row.NetworkSettings.Networks).length === 1 &&
      LOCAL_NETWORK in row.NetworkSettings.Networks,
    "Postgres is not attached only to the fixed local-substrate network",
  );
  const networks = parseJson<DockerNetwork[]>(
    run("docker", ["network", "inspect", LOCAL_NETWORK]),
    "Docker network inspect",
  );
  invariant(
    networks.length === 1 && networks[0]!.Name === LOCAL_NETWORK,
    "local-substrate network identity mismatch",
  );
  const attachments = Object.keys(networks[0]!.Containers ?? {});
  invariant(
    attachments.length === 1 && attachments[0] === container,
    "another container is attached to the shared local-substrate network",
  );
  const peers = run("docker", [
    "ps",
    "--filter",
    `label=com.docker.compose.project=${project}`,
    "--filter",
    "status=running",
    "--format",
    "{{.ID}}",
  ]).trim();
  if (peers) {
    const ids = peers.split(/\s+/);
    invariant(
      ids.length === 1 && container.startsWith(ids[0]!),
      "other project containers are running",
    );
  } else {
    throw new Error(
      "target Postgres container is absent from running project containers",
    );
  }
}

const STATE_SQL = `
with state as (
  select
    (select count(*)::int from accounts_v1.account_sessions) as account_sessions,
    (select count(*)::int from accounts_v1.authorization_codes) as authorization_codes,
    (select count(*)::int from accounts_v1.oauth_access_tokens) as oauth_access_tokens,
    (select count(*)::int from accounts_v1.oauth_refresh_tokens) as oauth_refresh_tokens,
    (select count(*)::int from accounts_v1.personal_access_tokens where revoked_at is null) as personal_access_tokens,
    md5(
      coalesce((select string_agg(md5(row_to_json(t)::text), ':' order by session_id) from accounts_v1.account_sessions t), '') || '|' ||
      coalesce((select string_agg(md5(row_to_json(t)::text), ':' order by code_hash) from accounts_v1.authorization_codes t), '') || '|' ||
      coalesce((select string_agg(md5(row_to_json(t)::text), ':' order by token_hash) from accounts_v1.oauth_access_tokens t), '') || '|' ||
      coalesce((select string_agg(md5(row_to_json(t)::text), ':' order by token_hash) from accounts_v1.oauth_refresh_tokens t), '') || '|' ||
      coalesce((select string_agg(md5(row_to_json(t)::text), ':' order by token_id) from accounts_v1.personal_access_tokens t where revoked_at is null), '')
    ) as generation
)
select json_build_object(
  'database', current_database(),
  'databaseOid', (select oid::text from pg_database where datname = current_database()),
  'systemIdentifier', (select system_identifier::text from pg_control_system()),
  'otherClients', (select count(*)::int from pg_stat_activity where backend_type = 'client backend' and pid <> pg_backend_pid()),
  'generation', generation,
  'counts', json_build_object(
    'account_sessions', account_sessions,
    'authorization_codes', authorization_codes,
    'oauth_access_tokens', oauth_access_tokens,
    'oauth_refresh_tokens', oauth_refresh_tokens,
    'personal_access_tokens', personal_access_tokens
  )
) from state`;

export function planSql(): string {
  return `${STATE_SQL};`;
}

interface DbState {
  database: string;
  databaseOid: string;
  systemIdentifier: string;
  otherClients: number;
  generation: string;
  counts: Counts;
}

function psql(run: Run, container: string, sql: string): string {
  return run(
    "docker",
    [
      "exec",
      "-i",
      container,
      "psql",
      "-X",
      "-q",
      "-t",
      "-A",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      "takos",
      "-d",
      DB,
    ],
    `${sql}\n`,
  );
}

function readState(run: Run, container: string): DbState {
  const state = parseJson<DbState>(
    psql(
      run,
      container,
      `begin read only; set local statement_timeout = '30s'; ${planSql()} rollback;`,
    ).trim(),
    "Postgres state",
  );
  invariant(state.database === DB, "wrong database");
  invariant(
    /^\d+$/.test(state.databaseOid) && /^\d+$/.test(state.systemIdentifier),
    "invalid database identity",
  );
  invariant(state.otherClients === 0, "another PostgreSQL client is connected");
  invariant(
    /^[a-f0-9]{32}$/.test(state.generation),
    "invalid state generation",
  );
  invariant(
    TABLES.every(
      (table) =>
        Number.isSafeInteger(state.counts[table]) && state.counts[table] >= 0,
    ),
    "invalid row counts",
  );
  return state;
}

export function planLocalReauth(run: Run, target: ReauthTarget): ReauthPlan {
  assertLocalTarget(run, target);
  const state = readState(run, target.container);
  return {
    kind: KIND,
    project: target.project,
    container: target.container,
    volume: target.volume,
    database: DB,
    databaseOid: state.databaseOid,
    systemIdentifier: state.systemIdentifier,
    generation: state.generation,
    counts: state.counts,
  };
}

export function assertPlan(value: unknown): asserts value is ReauthPlan {
  invariant(value !== null && typeof value === "object", "invalid plan");
  const plan = value as ReauthPlan;
  invariant(
    plan.kind === KIND && plan.database === DB,
    "plan kind or database mismatch",
  );
  exactName(plan.project, "project");
  exactContainer(plan.container);
  exactName(plan.volume, "volume");
  invariant(
    /^\d+$/.test(plan.databaseOid) && /^\d+$/.test(plan.systemIdentifier),
    "invalid plan database identity",
  );
  invariant(/^[a-f0-9]{32}$/.test(plan.generation), "invalid plan generation");
  invariant(
    TABLES.every(
      (table) =>
        Number.isSafeInteger(plan.counts?.[table]) && plan.counts[table] >= 0,
    ),
    "invalid plan counts",
  );
  invariant(
    Object.keys(plan).length === 9 &&
      Object.keys(plan.counts).length === TABLES.length,
    "unexpected plan fields",
  );
}

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function applySql(plan: ReauthPlan): string {
  assertPlan(plan);
  const expectedCounts = JSON.stringify(plan.counts);
  // ACCESS EXCLUSIVE fences writers during the CAS and deletes. No schema is changed.
  return `begin;
set local transaction isolation level serializable;
set local lock_timeout = '5s';
set local statement_timeout = '30s';
lock table ${TABLES.map((table) => `accounts_v1.${table}`).join(", ")} in access exclusive mode;
do $reauth$
declare state jsonb;
begin
  select result::jsonb into state from (${STATE_SQL}) as snapshot(result);
  if state->>'database' <> ${sqlLiteral(DB)}
     or state->>'databaseOid' <> ${sqlLiteral(plan.databaseOid)}
     or state->>'systemIdentifier' <> ${sqlLiteral(plan.systemIdentifier)}
     or (state->>'otherClients')::int <> 0
     or state->>'generation' <> ${sqlLiteral(plan.generation)}
     or state->'counts' <> ${sqlLiteral(expectedCounts)}::jsonb then
    raise exception 'local Accounts reauth plan is stale or database identity changed';
  end if;
end $reauth$;
delete from accounts_v1.account_sessions;
delete from accounts_v1.authorization_codes;
delete from accounts_v1.oauth_access_tokens;
delete from accounts_v1.oauth_refresh_tokens;
update accounts_v1.personal_access_tokens set revoked_at = greatest(clock_timestamp(), created_at) where revoked_at is null;
do $verify$
begin
  if exists (select 1 from accounts_v1.account_sessions)
     or exists (select 1 from accounts_v1.authorization_codes)
     or exists (select 1 from accounts_v1.oauth_access_tokens)
     or exists (select 1 from accounts_v1.oauth_refresh_tokens)
     or exists (select 1 from accounts_v1.personal_access_tokens where revoked_at is null) then
    raise exception 'local Accounts reauth postcondition failed';
  end if;
end $verify$;
commit;
select 'applied' as result;`;
}

export function applyLocalReauth(run: Run, plan: ReauthPlan): ReauthPlan {
  assertPlan(plan);
  assertLocalTarget(run, plan);
  const output = psql(run, plan.container, applySql(plan)).trim();
  invariant(output === "applied", "Postgres did not confirm the transaction");
  const after = planLocalReauth(run, plan);
  invariant(
    TABLES.every((table) => after.counts[table] === 0),
    "post-transaction authentication rows remain",
  );
  invariant(
    after.databaseOid === plan.databaseOid &&
      after.systemIdentifier === plan.systemIdentifier,
    "database identity changed after apply",
  );
  return after;
}

function safeRun(
  command: string,
  args: readonly string[],
  input?: string,
): string {
  const child = spawnSync(command, [...args], {
    ...(input === undefined ? {} : { input }),
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
    timeout: 45_000,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
  });
  // Never forward Docker/psql stdout or stderr; either can contain credentials.
  invariant(child.status === 0 && !child.error, `${command} command failed`);
  return child.stdout;
}

function option(args: string[], name: string): string {
  const index = args.indexOf(name);
  invariant(index >= 0 && args[index + 1], `missing ${name}`);
  const value = args[index + 1]!;
  args.splice(index, 2);
  return value;
}

export function main(argv: string[], run: Run = safeRun): void {
  const args = [...argv];
  const mode = args.shift();
  invariant(
    mode === "plan" || mode === "apply",
    "usage: local-accounts-reauth.ts <plan|apply> --project NAME --container FULL_ID --volume NAME [--generation HEX --system-identifier DECIMAL --database-oid DECIMAL]",
  );
  const target = {
    project: option(args, "--project"),
    container: option(args, "--container"),
    volume: option(args, "--volume"),
  };
  if (mode === "plan") {
    invariant(args.length === 0, "unexpected plan argument");
    console.log(JSON.stringify(planLocalReauth(run, target)));
    return;
  }
  const generation = option(args, "--generation");
  const systemIdentifier = option(args, "--system-identifier");
  const databaseOid = option(args, "--database-oid");
  invariant(args.length === 0, "unexpected apply argument");
  const current = planLocalReauth(run, target);
  invariant(
    current.generation === generation &&
      current.systemIdentifier === systemIdentifier &&
      current.databaseOid === databaseOid,
    "planned generation or database identity differs; inspect a fresh plan",
  );
  console.log(
    JSON.stringify({ result: "applied", ...applyLocalReauth(run, current) }),
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    // Errors are our own fixed strings only; no raw database or Docker output.
    console.error(`local Accounts reauth refused: ${message}`);
    process.exitCode = 1;
  }
}
