import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { promisify } from "node:util";
import { join } from "node:path";

import { Pool } from "pg";

import {
  createDockerCommandFailure,
  isExactDockerInspectNotFound,
} from "./docker_command_failure.ts";

import {
  wrapPgResult,
  type PgResultLike,
} from "../../../core/adapters/storage/pg_result.ts";
import type {
  SqlClient,
  SqlParameters,
  SqlTransaction,
} from "../../../core/adapters/storage/sql.ts";

const execFileAsync = promisify(execFile);
const POSTGRES_IMAGE =
  "postgres@sha256:16bc17c64a573ef34162af9298258d1aec548232985b33ed7b1eac33ba35c229";
const OPT_IN_ENV = "TAKOSUMI_TEST_NATIVE_POSTGRES_RESTART";
const CONTAINER_OWNER_LABEL = "io.takosumi.test.owner";
const CONTAINER_PURPOSE_LABEL = "io.takosumi.test.purpose";
const CONTAINER_DATA_LABEL = "io.takosumi.test.pgdata";
const PGDATA_CONTAINER_PATH = "/var/lib/postgresql/data";
const DEFAULT_DATA_ROOT = "/root/hdd/takos-dev";
const DOCKER_INSPECTION_FORMAT = [
  '{"Id":{{json .Id}},"Name":{{json .Name}},',
  '"Config":{"Image":{{json .Config.Image}},"Labels":{',
  '"io.takosumi.test.owner":{{json (index .Config.Labels "io.takosumi.test.owner")}},',
  '"io.takosumi.test.purpose":{{json (index .Config.Labels "io.takosumi.test.purpose")}},',
  '"io.takosumi.test.pgdata":{{json (index .Config.Labels "io.takosumi.test.pgdata")}}}},',
  '"State":{"Running":{{json .State.Running}},"Status":{{json .State.Status}},',
  '"Pid":{{json .State.Pid}},"Health":{"Status":{{json .State.Health.Status}}}},',
  '"NetworkSettings":{"Ports":{',
  '"5432/tcp":{{json (index .NetworkSettings.Ports "5432/tcp")}}}},',
  '"Mounts":{{json .Mounts}}}',
].join("");

interface DockerInspection {
  readonly Id: string;
  readonly Name: string;
  readonly Config?: {
    readonly Image?: string;
    readonly Labels?: Readonly<Record<string, string>>;
  };
  readonly State?: {
    readonly Running?: boolean;
    readonly Status?: string;
    readonly Pid?: number;
    readonly Health?: { readonly Status?: string };
  };
  readonly NetworkSettings?: {
    readonly Ports?: Readonly<
      Record<string, readonly { readonly HostIp: string; readonly HostPort: string }[] | null>
    >;
  };
  readonly Mounts?: readonly {
    readonly Type?: string;
    readonly Source?: string;
    readonly Destination?: string;
    readonly RW?: boolean;
  }[];
}

interface RunOwnership {
  readonly runId: string;
  readonly containerName: string;
  readonly runRoot: string;
  readonly environmentFile: string;
  readonly dataDirectory: string;
}

export interface NativePostgresRestartOptions {
  /** Public helper seam for bounded fault tests. Defaults to the local Docker CLI. */
  readonly runDocker?: (args: readonly string[]) => Promise<string>;
  /** Test-only root override. The default is the dedicated local HDD root. */
  readonly dataRoot?: string;
  /** Test-only mapped-TCP query seam. Native runs use a real PostgreSQL query. */
  readonly verifyMappedTcp?: (databaseUrl: string) => Promise<string>;
  /** Test-only outage seam. Native runs require the mapped TCP query to fail while stopped. */
  readonly verifyDatabaseUnavailable?: (databaseUrl: string) => Promise<void>;
}

export interface NativePostgresRestartEvidence {
  readonly stoppedAndUnavailable: true;
  readonly previousPostmasterHostPid: number;
  readonly newPostmasterHostPid: number;
  readonly previousPostmasterStartTime: string;
  readonly newPostmasterStartTime: string;
}

export interface NativePostgresRestartContainer {
  readonly databaseUrl: string;
  readonly containerId: string;
  readonly dataDirectory: string;
  restartPostgresDaemon(): Promise<NativePostgresRestartEvidence>;
  close(): Promise<void>;
}

export interface NativePostgresSqlClient {
  readonly client: SqlClient;
  close(): Promise<void>;
}

export const NATIVE_POSTGRES_PHASES = [
  "cleanup.all",
  "cleanup.container-close",
  "cleanup.container.readback-after-stop",
  "cleanup.container.readback-before-remove",
  "cleanup.container.readback-before-stop",
  "cleanup.container.remove",
  "cleanup.container.stop",
  "cleanup.pool-close",
  "cleanup.readback.container-id",
  "cleanup.readback.container-name",
  "cleanup.run-root.remove",
  "container.cleanup",
  "container.create",
  "container.create.readback",
  "container.preflight.engine",
  "container.preflight.image",
  "container.setup.cleanup",
  "container.setup.resolve-cleanup",
  "container.setup.root-cleanup",
  "container.startup.health",
  "core.apply",
  "core.bootstrap.first",
  "core.bootstrap.restarted",
  "core.lineage.after-restart",
  "core.lineage.before-restart",
  "core.plan",
  "core.replay",
  "daemon.before.readback",
  "daemon.postmaster.after.host-pid",
  "daemon.postmaster.before.host-pid",
  "daemon.postmaster.before.start-time",
  "daemon.postmaster.start-time.pool-close",
  "daemon.postmaster.start-time.query",
  "daemon.restart",
  "daemon.restart-lifecycle",
  "daemon.start.command",
  "daemon.start.health",
  "daemon.start.port-readback",
  "daemon.stop.command",
  "daemon.stop.readback",
  "daemon.unavailable.pool-close",
  "daemon.unavailable.probe",
  "daemon.unavailable.query",
  "fixture.create",
  "migration.apply-pending",
  "migration.verify-after-restart",
  "migration.verify-current",
  "pool.first.close",
  "pool.first.open",
  "pool.fresh.open",
  "pool.restarted.open",
  "postgres.fixture.create",
  "seed.fixture",
] as const;

const nativePostgresPhaseSet: ReadonlySet<string> = new Set(NATIVE_POSTGRES_PHASES);

export function isNativePostgresPhase(value: string): value is typeof NATIVE_POSTGRES_PHASES[number] {
  return nativePostgresPhaseSet.has(value);
}

export class NativePostgresPhaseFailure extends Error {
  constructor(
    readonly phase: string,
    cause: unknown,
  ) {
    super("native PostgreSQL phase failed", { cause });
    this.name = "NativePostgresPhaseFailure";
  }
}

function emitNativePostgresPhaseProgress(
  phase: typeof NATIVE_POSTGRES_PHASES[number],
  status: "start" | "ok" | "failed",
  elapsedMs: number,
): void {
  try {
    console.info(
      `[native-postgres-phase] ${phase} ${status} elapsed_ms=${Math.max(0, Math.round(elapsedMs))}`,
    );
  } catch {
    // Optional diagnostics must never change fixture or cleanup behavior.
  }
}

/** Keeps test lifecycle phase boundaries explicit without logging fixture details. */
export async function runNativePostgresPhase<T>(
  phase: string,
  operation: () => T | Promise<T>,
): Promise<T> {
  const knownPhase = isNativePostgresPhase(phase) ? phase : undefined;
  const reportProgress =
    knownPhase !== undefined && process.env[OPT_IN_ENV] === "1";
  const startedAt = reportProgress ? performance.now() : 0;
  if (reportProgress) {
    emitNativePostgresPhaseProgress(knownPhase, "start", 0);
  }
  try {
    const result = await operation();
    if (reportProgress) {
      emitNativePostgresPhaseProgress(
        knownPhase,
        "ok",
        performance.now() - startedAt,
      );
    }
    return result;
  } catch (cause) {
    if (reportProgress) {
      emitNativePostgresPhaseProgress(
        knownPhase,
        "failed",
        performance.now() - startedAt,
      );
    }
    if (cause instanceof NativePostgresPhaseFailure || !isNativePostgresPhase(phase)) {
      throw cause;
    }
    throw new NativePostgresPhaseFailure(phase, cause);
  }
}

function assertNativeOptIn(): void {
  if (process.env[OPT_IN_ENV] !== "1") {
    throw new Error(
      `native PostgreSQL restart requires explicit ${OPT_IN_ENV}=1 opt-in`,
    );
  }
}

async function runLocalDocker(args: readonly string[]): Promise<string> {
  try {
    const result = await execFileAsync("docker", [...args], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      timeout: 30_000,
    });
    return result.stdout.trim();
  } catch (error) {
    const failure = error as Error & {
      readonly code?: unknown;
      readonly killed?: boolean;
      readonly signal?: string | null;
      readonly stderr?: string;
    };
    const exitCode = typeof failure.code === "number" ? failure.code : -1;
    throw createDockerCommandFailure(
      ["docker", ...args],
      exitCode,
      failure.stderr ?? "",
      {
        timedOut: failure.code === "ETIMEDOUT",
        killed: failure.killed,
        signal: failure.signal,
      },
    );
  }
}

function isExactNotFound(error: unknown, reference: string): boolean {
  return isExactDockerInspectNotFound(error, reference);
}

async function inspectContainer(
  runDocker: (args: readonly string[]) => Promise<string>,
  reference: string,
): Promise<DockerInspection> {
  const output = await runDocker([
    "inspect",
    "--format",
    DOCKER_INSPECTION_FORMAT,
    reference,
  ]);
  const parsed: unknown = JSON.parse(output);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Docker returned an invalid container inspection result");
  }
  return parsed as DockerInspection;
}

async function readContainer(
  runDocker: (args: readonly string[]) => Promise<string>,
  reference: string,
): Promise<{ readonly kind: "present"; readonly inspection: DockerInspection } | { readonly kind: "absent" }> {
  try {
    return { kind: "present", inspection: await inspectContainer(runDocker, reference) };
  } catch (error) {
    if (isExactNotFound(error, reference)) return { kind: "absent" };
    throw error;
  }
}

function assertOwnedContainer(
  inspection: DockerInspection,
  ownership: RunOwnership,
  expectedId?: string,
): void {
  const labels = inspection.Config?.Labels;
  const mounts = inspection.Mounts ?? [];
  if (
    !/^[0-9a-f]{64}$/u.test(inspection.Id) ||
    (expectedId !== undefined && inspection.Id !== expectedId) ||
    inspection.Name !== `/${ownership.containerName}` ||
    labels?.[CONTAINER_OWNER_LABEL] !== ownership.runId ||
    labels?.[CONTAINER_PURPOSE_LABEL] !== "native-postgres-restart-test" ||
    labels?.[CONTAINER_DATA_LABEL] !== ownership.dataDirectory ||
    inspection.Config?.Image !== POSTGRES_IMAGE ||
    mounts.length !== 1 ||
    mounts[0]?.Type !== "bind" ||
    mounts[0]?.Source !== ownership.dataDirectory ||
    mounts[0]?.Destination !== PGDATA_CONTAINER_PATH ||
    mounts[0]?.RW !== true
  ) {
    throw custodyError(
      "Docker readback did not prove exact native PostgreSQL run ownership",
      ownership,
      expectedId,
    );
  }
}

function recoveryDetails(ownership: RunOwnership, id?: string): string {
  const exactReference = id ?? ownership.containerName;
  return `operator recovery path: inspect exact Docker reference ${exactReference}, owner label ${ownership.runId}, and PGDATA ${ownership.dataDirectory}; preserve run root ${ownership.runRoot} and env file ${ownership.environmentFile} until the exact container is proven absent`;
}

function custodyError(
  reason: string,
  ownership: RunOwnership,
  id?: string,
): Error {
  return new Error(`native PostgreSQL resource custody unresolved: ${reason}; ${recoveryDetails(ownership, id)}`);
}

async function removeRunRootAfterAbsenceProof(
  runDocker: (args: readonly string[]) => Promise<string>,
  ownership: RunOwnership,
  id?: string,
): Promise<void> {
  if (id !== undefined) {
    const byId = await runNativePostgresPhase(
      "cleanup.readback.container-id",
      () => readContainer(runDocker, id),
    );
    if (byId.kind !== "absent") {
      assertOwnedContainer(byId.inspection, ownership, id);
      throw custodyError("exact container ID still exists after removal", ownership, id);
    }
  }
  const byName = await runNativePostgresPhase(
    "cleanup.readback.container-name",
    () => readContainer(runDocker, ownership.containerName),
  );
  if (byName.kind !== "absent") {
    assertOwnedContainer(byName.inspection, ownership, id);
    throw custodyError("deterministic container name still resolves after removal", ownership, id);
  }
  await runNativePostgresPhase("cleanup.run-root.remove", () =>
    rm(ownership.runRoot, { recursive: true, force: false })
  );
}

async function stopAndRemoveOwnedContainer(
  runDocker: (args: readonly string[]) => Promise<string>,
  ownership: RunOwnership,
  id: string,
): Promise<void> {
  const before = await runNativePostgresPhase(
    "cleanup.container.readback-before-stop",
    () => readContainer(runDocker, id),
  );
  if (before.kind === "absent") {
    await removeRunRootAfterAbsenceProof(runDocker, ownership, id);
    return;
  }
  assertOwnedContainer(before.inspection, ownership, id);

  if (before.inspection.State?.Running) {
    let stopError: unknown;
    try {
      await runNativePostgresPhase("cleanup.container.stop", () =>
        runDocker(["stop", "--time", "15", id])
      );
    } catch (error) {
      stopError = error;
    }
    const afterStop = await runNativePostgresPhase(
      "cleanup.container.readback-after-stop",
      () => readContainer(runDocker, id),
    );
    if (afterStop.kind === "absent") {
      await removeRunRootAfterAbsenceProof(runDocker, ownership, id);
      return;
    }
    assertOwnedContainer(afterStop.inspection, ownership, id);
    if (afterStop.inspection.State?.Running || afterStop.inspection.State?.Pid !== 0) {
      throw custodyError(
        `owned container did not reach stopped state${stopError ? " after stop acknowledgement was lost" : ""}`,
        ownership,
        id,
      );
    }
  }

  const beforeRemove = await runNativePostgresPhase(
    "cleanup.container.readback-before-remove",
    () => readContainer(runDocker, id),
  );
  if (beforeRemove.kind === "absent") {
    await removeRunRootAfterAbsenceProof(runDocker, ownership, id);
    return;
  }
  assertOwnedContainer(beforeRemove.inspection, ownership, id);
  if (beforeRemove.inspection.State?.Running || beforeRemove.inspection.State?.Pid !== 0) {
    throw custodyError("refusing removal before exact container stop is proven", ownership, id);
  }

  let removeError: unknown;
  try {
    await runNativePostgresPhase("cleanup.container.remove", () =>
      runDocker(["rm", id])
    );
  } catch (error) {
    removeError = error;
  }
  try {
    await removeRunRootAfterAbsenceProof(runDocker, ownership, id);
  } catch (readbackError) {
    const summary = removeError instanceof Error
      ? removeError.message.slice(0, 300)
      : "remove acknowledgement unavailable";
    throw new AggregateError(
      [readbackError, ...(removeError ? [removeError] : [])],
      custodyError(`container removal is unconfirmed (${summary})`, ownership, id).message,
    );
  }
}

async function resolveAndCleanAfterCreateFailure(
  runDocker: (args: readonly string[]) => Promise<string>,
  ownership: RunOwnership,
): Promise<void> {
  const readback = await readContainer(runDocker, ownership.containerName);
  if (readback.kind === "absent") {
    throw custodyError(
      "create was dispatched but exact-name readback is absent, so no-effect is not proven",
      ownership,
    );
  }
  assertOwnedContainer(readback.inspection, ownership);
  await stopAndRemoveOwnedContainer(runDocker, ownership, readback.inspection.Id);
}

async function waitForHealthyContainer(
  runDocker: (args: readonly string[]) => Promise<string>,
  containerId: string,
): Promise<DockerInspection> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const inspection = await inspectContainer(runDocker, containerId);
    if (inspection.State?.Status === "exited" || inspection.State?.Status === "dead") {
      throw new Error(`owned PostgreSQL test container exited during startup (${inspection.State.Status})`);
    }
    if (
      inspection.State?.Running === true &&
      inspection.State.Health?.Status === "healthy"
    ) {
      return inspection;
    }
    await Bun.sleep(500);
  }
  throw new Error("owned PostgreSQL test container did not become healthy in time");
}

function mappedLoopbackPort(inspection: DockerInspection): number {
  const mapping = inspection.NetworkSettings?.Ports?.["5432/tcp"]?.[0];
  if (!mapping || mapping.HostIp !== "127.0.0.1") {
    throw new Error("owned PostgreSQL test container has no loopback-only port mapping");
  }
  const port = Number(mapping.HostPort);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error("Docker returned an invalid ephemeral PostgreSQL host port");
  }
  return port;
}

async function selectAvailableLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("kernel did not return a loopback TCP port");
    }
    return address.port;
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

function normalizeQuery(sql: string, parameters?: SqlParameters): {
  readonly sql: string;
  readonly values: unknown[];
} {
  if (parameters === undefined) return { sql, values: [] };
  if (Array.isArray(parameters)) {
    return { sql, values: [...parameters] as unknown[] };
  }
  const record = parameters as Readonly<Record<string, unknown>>;
  const names: string[] = [];
  const rendered = sql.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, (_match, name: string) => {
    names.push(name);
    return `$${names.length}`;
  });
  return { sql: rendered, values: names.map((name) => record[name]) };
}

interface PgExecutor {
  query(sql: string, values?: unknown[]): Promise<PgResultLike>;
}

export async function openNativePostgresSqlClient(
  connectionString: string,
): Promise<NativePostgresSqlClient> {
  const pool = new Pool({
    connectionString,
    connectionTimeoutMillis: 3_000,
    idleTimeoutMillis: 1_000,
    max: 4,
  });
  const query = async <Row extends Record<string, unknown>>(
    executor: PgExecutor,
    sql: string,
    parameters?: SqlParameters,
  ) => {
    const normalized = normalizeQuery(sql, parameters);
    return wrapPgResult<Row>(
      await executor.query(normalized.sql, normalized.values),
    );
  };
  const client: SqlClient = {
    query: (sql, parameters) =>
      query(pool as unknown as PgExecutor, sql, parameters),
    async transaction<T>(fn: (transaction: SqlTransaction) => T | Promise<T>) {
      const connection = await pool.connect();
      const transaction: SqlTransaction = {
        query: (sql, parameters) =>
          query(connection as unknown as PgExecutor, sql, parameters),
        transaction: (nested) => Promise.resolve(nested(transaction)),
      };
      try {
        await connection.query("begin");
        const result = await fn(transaction);
        await connection.query("commit");
        return result;
      } catch (error) {
        await connection.query("rollback").catch(() => {});
        throw error;
      } finally {
        connection.release();
      }
    },
  };
  return { client, close: () => pool.end() };
}

async function readPostmasterStartTime(databaseUrl: string): Promise<string> {
  const pool = new Pool({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 3_000,
    max: 1,
  });
  try {
    const result = await runNativePostgresPhase(
      "daemon.postmaster.start-time.query",
      () => pool.query<{ readonly started_at: Date | string }>(
        "select pg_postmaster_start_time() as started_at",
      ),
    );
    const startedAt = result.rows[0]?.started_at;
    if (!startedAt) throw new Error("PostgreSQL returned no postmaster start time");
    return new Date(startedAt).toISOString();
  } finally {
    await runNativePostgresPhase(
      "daemon.postmaster.start-time.pool-close",
      () => pool.end(),
    );
  }
}

async function waitForMappedTcpDatabase(
  databaseUrl: string,
  verifyMappedTcp: (url: string) => Promise<string>,
): Promise<string> {
  const deadline = Date.now() + 30_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return await verifyMappedTcp(databaseUrl);
    } catch (error) {
      lastError = error;
      await Bun.sleep(250);
    }
  }
  throw new Error(
    "owned PostgreSQL did not accept a query over its mapped loopback TCP port",
    { cause: lastError },
  );
}

async function readPostmasterHostPid(
  runDocker: (args: readonly string[]) => Promise<string>,
  containerId: string,
  inspection: DockerInspection,
): Promise<number> {
  const pid = inspection.State?.Pid ?? 0;
  if (pid <= 0) throw new Error("PostgreSQL container has no running host PID");
  const processName = await runDocker(["exec", containerId, "cat", "/proc/1/comm"]);
  if (processName !== "postgres") {
    throw new Error("the PostgreSQL postmaster is not the owned container's PID 1");
  }
  return pid;
}

async function assertDatabaseUnavailable(databaseUrl: string): Promise<void> {
  const pool = new Pool({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 1_000,
    idleTimeoutMillis: 250,
    max: 1,
  });
  let connected = false;
  try {
    await runNativePostgresPhase("daemon.unavailable.query", () =>
      pool.query("select 1")
    );
    connected = true;
  } catch {
    // Expected only while the exact owned container is stopped.
  } finally {
    await runNativePostgresPhase("daemon.unavailable.pool-close", () =>
      pool.end()
    );
  }
  if (connected) {
    throw new Error("PostgreSQL remained queryable after the owned daemon stopped");
  }
}

export async function cleanupNativePostgresResources(
  poolClosers: readonly (() => Promise<void>)[],
  closeContainer: () => Promise<void>,
): Promise<void> {
  const poolResults = await Promise.allSettled(
    poolClosers.map((close) =>
      Promise.resolve().then(() =>
        runNativePostgresPhase("cleanup.pool-close", close)
      )
    ),
  );
  const containerResult = await Promise.resolve()
    .then(() =>
      runNativePostgresPhase("cleanup.container-close", closeContainer)
    )
    .then(() => ({ status: "fulfilled" as const }))
    .catch((reason: unknown) => ({ status: "rejected" as const, reason }));
  const failures = [
    ...poolResults.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : []
    ),
    ...(containerResult.status === "rejected" ? [containerResult.reason] : []),
  ];
  if (failures.length > 0) {
    throw new AggregateError(failures, "native PostgreSQL resource cleanup failed");
  }
}

export async function createNativePostgresRestartContainer(
  options: NativePostgresRestartOptions = {},
): Promise<NativePostgresRestartContainer> {
  if (!options.runDocker) assertNativeOptIn();
  const runDocker = options.runDocker ?? runLocalDocker;
  const dataRoot = options.dataRoot ?? DEFAULT_DATA_ROOT;

  // `docker image inspect` is local-only; `--pull=never` prevents any registry fetch.
  await runNativePostgresPhase("container.preflight.image", () =>
    runDocker(["image", "inspect", POSTGRES_IMAGE, "--format", "{{.Id}}"])
  );
  await runNativePostgresPhase("container.preflight.engine", () =>
    runDocker(["version", "--format", "{{.Server.Version}}"])
  );

  const runId = crypto.randomUUID();
  const containerName = `takosumi-pg-restart-${runId}`;
  const runRoot = await mkdtemp(join(dataRoot, "takosumi-pg-restart-run-"));
  const environmentFile = join(runRoot, "postgres.env");
  const dataDirectory = join(runRoot, "pgdata");
  const ownership: RunOwnership = {
    runId,
    containerName,
    runRoot,
    environmentFile,
    dataDirectory,
  };
  const password = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
  const verifyMappedTcp = options.verifyMappedTcp ?? readPostmasterStartTime;
  const verifyDatabaseUnavailable =
    options.verifyDatabaseUnavailable ?? assertDatabaseUnavailable;
  let createDispatched = false;
  let containerId: string | undefined;
  let closed = false;

  try {
    await chmod(runRoot, 0o700);
    await mkdir(dataDirectory, { mode: 0o700 });
    await chmod(dataDirectory, 0o700);
    await writeFile(
      environmentFile,
      `POSTGRES_DB=native_restart\nPOSTGRES_USER=native_restart\nPOSTGRES_PASSWORD=${password}\nPGDATA=${PGDATA_CONTAINER_PATH}\n`,
      { mode: 0o600, flag: "wx" },
    );

    // The temporary socket is released before Docker binds the selected port. If
    // another process wins that narrow race, the single Docker create must fail;
    // do not retry with a different externally visible database endpoint.
    const publishedHostPort = await selectAvailableLoopbackPort();
    createDispatched = true;
    const runResult = await runNativePostgresPhase(
      "container.create",
      () => runDocker([
        "run",
        "--detach",
        "--pull=never",
        "--name",
        containerName,
        "--restart=no",
        "--label",
        `${CONTAINER_OWNER_LABEL}=${runId}`,
        "--label",
        `${CONTAINER_PURPOSE_LABEL}=native-postgres-restart-test`,
        "--label",
        `${CONTAINER_DATA_LABEL}=${dataDirectory}`,
        "--env-file",
        environmentFile,
        "--mount",
        `type=bind,source=${dataDirectory},target=${PGDATA_CONTAINER_PATH}`,
        "--publish",
        `127.0.0.1:${publishedHostPort}:5432`,
        "--health-cmd",
        "pg_isready -h 127.0.0.1 -U native_restart -d native_restart",
        "--health-interval",
        "1s",
        "--health-timeout",
        "3s",
        "--health-retries",
        "30",
        POSTGRES_IMAGE,
      ]),
    );
    if (!/^[0-9a-f]{64}$/u.test(runResult)) {
      throw new Error("Docker create returned no exact container ID");
    }
    const exactContainerId = runResult;
    containerId = exactContainerId;
    const readback = await runNativePostgresPhase(
      "container.create.readback",
      () => readContainer(runDocker, exactContainerId),
    );
    if (readback.kind !== "present") {
      throw custodyError("created container ID is absent during readback", ownership, exactContainerId);
    }
    assertOwnedContainer(readback.inspection, ownership, exactContainerId);
    const healthy = await runNativePostgresPhase(
      "container.startup.health",
      () => waitForHealthyContainer(runDocker, exactContainerId),
    );
    assertOwnedContainer(healthy, ownership, exactContainerId);
    const port = mappedLoopbackPort(healthy);
    if (port !== publishedHostPort) {
      throw new Error("Docker mapped a different loopback host port than requested");
    }
    await readPostmasterHostPid(runDocker, exactContainerId, healthy);
    const databaseUrl =
      `postgres://native_restart:${password}@127.0.0.1:${port}/native_restart`;
    await waitForMappedTcpDatabase(databaseUrl, verifyMappedTcp);

    return {
      databaseUrl,
      containerId: exactContainerId,
      dataDirectory,
      async restartPostgresDaemon() {
        if (closed) throw new Error("owned PostgreSQL test fixture is already closed");
        const beforeReadback = await runNativePostgresPhase(
          "daemon.before.readback",
          () => readContainer(runDocker, exactContainerId),
        );
        if (beforeReadback.kind !== "present") {
          throw custodyError("owned PostgreSQL container is absent before restart", ownership, exactContainerId);
        }
        const before = beforeReadback.inspection;
        assertOwnedContainer(before, ownership, exactContainerId);
        if (!before.State?.Running) {
          throw new Error("owned PostgreSQL daemon was not running before restart");
        }
        const previousPostmasterHostPid = await runNativePostgresPhase(
          "daemon.postmaster.before.host-pid",
          () => readPostmasterHostPid(runDocker, exactContainerId, before),
        );
        const previousPostmasterStartTime = await runNativePostgresPhase(
          "daemon.postmaster.before.start-time",
          () => verifyMappedTcp(databaseUrl),
        );

        await runNativePostgresPhase("daemon.stop.command", () =>
          runDocker(["stop", "--time", "15", exactContainerId])
        );
        const stoppedReadback = await runNativePostgresPhase(
          "daemon.stop.readback",
          () => readContainer(runDocker, exactContainerId),
        );
        if (stoppedReadback.kind !== "present") {
          throw custodyError("container disappeared during daemon stop", ownership, exactContainerId);
        }
        const stopped = stoppedReadback.inspection;
        assertOwnedContainer(stopped, ownership, exactContainerId);
        if (stopped.State?.Running || stopped.State?.Pid !== 0) {
          throw new Error("owned PostgreSQL container did not fully stop");
        }
        await runNativePostgresPhase("daemon.unavailable.probe", () =>
          verifyDatabaseUnavailable(databaseUrl)
        );

        await runNativePostgresPhase("daemon.start.command", () =>
          runDocker(["start", exactContainerId])
        );
        const restarted = await runNativePostgresPhase(
          "daemon.start.health",
          () => waitForHealthyContainer(runDocker, exactContainerId),
        );
        assertOwnedContainer(restarted, ownership, exactContainerId);
        const restartedPort = await runNativePostgresPhase(
          "daemon.start.port-readback",
          () => mappedLoopbackPort(restarted),
        );
        if (restartedPort !== port) {
          throw new Error("owned PostgreSQL loopback port mapping changed during daemon restart");
        }
        const newPostmasterStartTime = await waitForMappedTcpDatabase(
          databaseUrl,
          verifyMappedTcp,
        );
        const newPostmasterHostPid = await runNativePostgresPhase(
          "daemon.postmaster.after.host-pid",
          () => readPostmasterHostPid(runDocker, exactContainerId, restarted),
        );
        if (newPostmasterHostPid === previousPostmasterHostPid) {
          throw new Error("PostgreSQL container did not start a distinct host process after stop");
        }
        if (newPostmasterStartTime === previousPostmasterStartTime) {
          throw new Error("PostgreSQL postmaster start time did not change after restart");
        }
        return {
          stoppedAndUnavailable: true,
          previousPostmasterHostPid,
          newPostmasterHostPid,
          previousPostmasterStartTime,
          newPostmasterStartTime,
        };
      },
      async close() {
        if (closed) return;
        await runNativePostgresPhase("container.cleanup", () =>
          stopAndRemoveOwnedContainer(runDocker, ownership, exactContainerId)
        );
        closed = true;
      },
    };
  } catch (error) {
    try {
      if (createDispatched) {
        if (containerId) {
          await runNativePostgresPhase("container.setup.cleanup", () =>
            stopAndRemoveOwnedContainer(runDocker, ownership, containerId!)
          );
        } else {
          await runNativePostgresPhase(
            "container.setup.resolve-cleanup",
            () => resolveAndCleanAfterCreateFailure(runDocker, ownership),
          );
        }
      } else {
        await runNativePostgresPhase("container.setup.root-cleanup", () =>
          rm(runRoot, { recursive: true, force: false })
        );
      }
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `native PostgreSQL setup failed; custody is retained; ${recoveryDetails(ownership, containerId)}`,
      );
    }
    throw error;
  }
}
