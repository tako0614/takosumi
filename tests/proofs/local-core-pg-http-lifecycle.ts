#!/usr/bin/env bun

/**
 * Opt-in local proof composing SQL-backed Core, native PostgreSQL daemon
 * restart, and the existing real HTTP/OpenTofu runner lifecycle.
 */
import { strict as assert } from "node:assert";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { createTakosumiService } from "../../core/bootstrap.ts";
import { ObjectKeyArtifactReferenceAllocator } from "../../core/adapters/storage/artifact-references.ts";
import { StorageMigrationRunner } from "../../core/adapters/storage/migration-runner/mod.ts";
import { createHttpOpenTofuRunner } from "../../deploy/node-postgres/src/local-opentofu-runner.ts";
import { SqlOpenTofuControlStore } from "../../core/domains/deploy-control/store_sql.ts";
import { FIXTURE_EXECUTION_EVIDENCE_AUTHORITY } from "../helpers/deploy-control/model_fixture.ts";
import {
  cleanupNativePostgresResources,
  createNativePostgresRestartContainer,
  isNativePostgresPhase,
  NativePostgresPhaseFailure,
  openNativePostgresSqlClient,
  runNativePostgresPhase,
  type NativePostgresRestartEvidence,
} from "../helpers/deploy-control/native_postgres_restart.ts";
import {
  RUNNER_HTTP_PROOF_LABELS,
  LocalCoreHttpCleanupFailure,
  prove as proveCoreHttpLifecycle,
  type RunnerHttpProofEventPhase,
  type RunnerHttpProofLabel,
  parseProofArgs,
  runAndEmitAfterCleanup,
  withLocalCoreHttpRunner,
} from "./local-core-http-lifecycle.ts";

const NATIVE_POSTGRES_OPT_IN = "TAKOSUMI_TEST_NATIVE_POSTGRES_RESTART";
const SAFE_ERROR_CLASS_NAMES = new Set([
  "AbortError",
  "AggregateError",
  "AssertionError",
  "DockerCommandError",
  "Error",
  "RangeError",
  "TimeoutError",
  "TypeError",
]);

type NativePostgresProofPhase = "postgres.fixture.create";

export interface RunnerHttpProofTrace {
  attempted?: RunnerHttpProofLabel;
  completed?: RunnerHttpProofLabel;
  failed?: RunnerHttpProofLabel;
}

export function recordRunnerHttpProofEvent(
  trace: RunnerHttpProofTrace,
  label: RunnerHttpProofLabel,
  phase: RunnerHttpProofEventPhase,
): void {
  if (phase === "start") {
    trace.attempted = label;
  } else if (phase === "completed") {
    trace.completed = label;
  } else {
    trace.failed = label;
  }
}

class NativePostgresProofPhaseFailure extends Error {
  constructor(
    readonly phase: NativePostgresProofPhase,
    cause: unknown,
  ) {
    super("native PostgreSQL proof phase failed", { cause });
    this.name = "NativePostgresProofPhaseFailure";
  }
}

export class NativePostgresCoreHttpFailure extends Error {
  constructor(
    readonly trace: RunnerHttpProofTrace,
    cause: unknown,
  ) {
    super("native PostgreSQL plus HTTP proof lifecycle failed", { cause });
    this.name = "NativePostgresCoreHttpFailure";
  }
}

class NativePostgresLifecycleCleanupFailure extends AggregateError {
  constructor(
    readonly primaryFailurePresent: boolean,
    readonly primaryFailure: unknown,
    readonly cleanupFailure: unknown,
  ) {
    super(
      primaryFailurePresent
        ? [primaryFailure, cleanupFailure]
        : [cleanupFailure],
      "native PostgreSQL lifecycle cleanup failed",
      { cause: primaryFailurePresent ? primaryFailure : cleanupFailure },
    );
    this.name = "NativePostgresLifecycleCleanupFailure";
  }
}

/** Runs owned cleanup without replacing an earlier lifecycle failure. */
export async function runWithNativePostgresCleanup<T>(
  work: () => Promise<T>,
  cleanup: () => Promise<void>,
): Promise<T> {
  let value: T | undefined;
  let primaryFailure: unknown;
  let primaryFailurePresent = false;
  try {
    value = await work();
  } catch (error) {
    primaryFailure = error;
    primaryFailurePresent = true;
  }

  let cleanupFailure: unknown;
  let cleanupFailurePresent = false;
  try {
    await cleanup();
  } catch (error) {
    cleanupFailure = error;
    cleanupFailurePresent = true;
  }

  if (cleanupFailurePresent) {
    throw new NativePostgresLifecycleCleanupFailure(
      primaryFailurePresent,
      primaryFailure,
      cleanupFailure,
    );
  }
  if (primaryFailurePresent) throw primaryFailure;
  return value as T;
}

function safeErrorClass(error: unknown): string {
  if (!(error instanceof Error)) return "UnknownError";
  return SAFE_ERROR_CLASS_NAMES.has(error.name) ? error.name : "OtherError";
}

function safeSourceLocation(error: unknown): string {
  if (!(error instanceof Error) || !error.stack) return "source-location-unavailable";
  if (error.message.includes("\n") || error.message.includes("\r")) {
    return "source-location-unavailable";
  }
  for (const frame of error.stack.split("\n").slice(1)) {
    if (!/^\s+at\b/u.test(frame)) continue;
    const match = /^\s+at\b.*?((?:native_postgres_restart|local-core-pg-http-lifecycle)\.ts):([1-9][0-9]{0,5}):[1-9][0-9]{0,5}\)?$/u.exec(
      frame,
    );
    if (match) return `${match[1]}:${match[2]}`;
  }
  return "source-location-unavailable";
}

function nativePhaseFailures(error: unknown): readonly NativePostgresPhaseFailure[] {
  const candidates = error instanceof AggregateError
    ? error.errors.slice(0, 4)
    : [error];
  return candidates.filter((candidate): candidate is NativePostgresPhaseFailure =>
    candidate instanceof NativePostgresPhaseFailure && isNativePostgresPhase(candidate.phase)
  );
}

function safeFailureClassAndLocation(error: unknown): string {
  if (error instanceof NativePostgresPhaseFailure && isNativePostgresPhase(error.phase)) {
    return `${safeErrorClass(error.cause)}@${safeSourceLocation(error.cause)}`;
  }
  return `${safeErrorClass(error)}@${safeSourceLocation(error)}`;
}

function safePhaseFields(label: string, error: unknown): readonly string[] {
  const phases = nativePhaseFailures(error).map(({ phase }) => phase);
  if (phases.length === 1) return [`${label}-phase=${phases[0]}`];
  if (phases.length > 1) return [`${label}-phases=${phases.join(",")}`];
  return [];
}

function nativeCleanupPhaseFailures(error: unknown): readonly string[] {
  const phases: string[] = [];
  const visited = new Set<object>();
  let visitedCount = 0;

  const visit = (candidate: unknown, depth: number): void => {
    if (
      depth > 8 ||
      visitedCount >= 16 ||
      !(candidate instanceof NativePostgresPhaseFailure || candidate instanceof AggregateError) ||
      visited.has(candidate)
    ) {
      return;
    }
    visited.add(candidate);
    visitedCount += 1;

    if (candidate instanceof NativePostgresPhaseFailure) {
      let phase: unknown;
      try {
        phase = candidate.phase;
      } catch {
        return;
      }

      if (
        typeof phase !== "string" ||
        !isNativePostgresPhase(phase) ||
        (phase !== "container.cleanup" && !phase.startsWith("cleanup."))
      ) {
        return;
      }
      if (!phases.includes(phase)) phases.push(phase);

      let cause: unknown;
      try {
        cause = candidate.cause;
      } catch {
        return;
      }
      if (cause instanceof NativePostgresPhaseFailure || cause instanceof AggregateError) {
        visit(cause, depth + 1);
      }
      return;
    }

    let nestedErrors: unknown[];
    try {
      const errors: unknown = candidate.errors;
      if (!Array.isArray(errors)) return;
      nestedErrors = errors.slice(0, 4);
    } catch {
      return;
    }

    for (const nested of nestedErrors) {
      if (nested instanceof NativePostgresPhaseFailure || nested instanceof AggregateError) {
        visit(nested, depth + 1);
      }
    }
  };

  visit(error, 0);
  return phases;
}

function safeCleanupPhaseFields(label: string, error: unknown): readonly string[] {
  const phases = nativeCleanupPhaseFailures(error);
  if (phases.length === 1) return [`${label}-phase=${phases[0]}`];
  if (phases.length > 1) return [`${label}-phases=${phases.join(",")}`];
  return [];
}

/** Safe diagnostic: fixed phase, error classes, and allowlisted source locations only. */
export function formatNativePostgresProofFailure(
  phase: string,
  error: unknown,
): string {
  const safePhase = isNativePostgresPhase(phase) ? phase : "postgres.lifecycle";
  const setupFailure = error instanceof NativePostgresPhaseFailure && error.phase === "fixture.create"
    ? error.cause
    : error;
  if (
    setupFailure instanceof AggregateError &&
    setupFailure.errors.length === 2 &&
    setupFailure.errors.some((candidate) =>
      nativePhaseFailures(candidate).some(({ phase: candidatePhase }) =>
        candidatePhase.startsWith("container.setup.")
      )
    )
  ) {
    const [setupError, cleanupError] = setupFailure.errors;
    return [
      `phase=${safePhase}`,
      "failure=setup-and-cleanup",
      ...safePhaseFields("setup", setupError),
      `setup=${safeFailureClassAndLocation(setupError)}`,
      ...safePhaseFields("cleanup", cleanupError),
      `cleanup=${safeFailureClassAndLocation(cleanupError)}`,
    ].join(" ");
  }
  return [
    `phase=${safePhase}`,
    ...safePhaseFields("failure", error),
    `failure=${safeFailureClassAndLocation(error)}`,
  ].join(" ");
}

/** Reports the lifecycle failure and cleanup failure independently, without messages. */
export function formatNativePostgresLifecycleFailure(error: unknown): string {
  if (error instanceof LocalCoreHttpCleanupFailure) {
    return [
      `phase=${error.cleanupPhase}`,
      "failure=primary-and-outer-cleanup",
      `primary-diagnostic=[${formatNativePostgresPrimaryFailure(error.errors[0])}]`,
      ...safeCleanupPhaseFields("cleanup-operation", error.errors[1]),
      `cleanup-phase=${error.cleanupPhase} cleanup=${safeFailureClassAndLocation(error.errors[1])}`,
    ].join(" ");
  }
  if (!(error instanceof NativePostgresLifecycleCleanupFailure)) {
    const phase = error instanceof NativePostgresPhaseFailure && isNativePostgresPhase(error.phase)
      ? error.phase
      : "postgres.lifecycle";
    return [
      `phase=${phase}`,
      ...safePhaseFields("failure", error),
      `failure=${safeFailureClassAndLocation(error)}`,
    ].join(" ");
  }

  if (!error.primaryFailurePresent) {
    return [
      "phase=postgres.cleanup",
      "failure=cleanup-only",
      ...safeCleanupPhaseFields("cleanup-operation", error.cleanupFailure),
      `cleanup=${safeFailureClassAndLocation(error.cleanupFailure)}`,
    ].join(" ");
  }

  const primary = error.primaryFailure;
  if (primary instanceof NativePostgresCoreHttpFailure) {
    const context = formatCoreHttpLifecycleFailure(primary.trace, primary.cause)
      .replace(/^phase=core\.http-lifecycle /u, "")
      .replace(/ failure=[^ ]+$/u, "");
    return [
      "phase=core.http-lifecycle",
      "failure=primary-and-cleanup",
      ...safePhaseFields("primary", primary.cause),
      `primary=${safeFailureClassAndLocation(primary.cause)}`,
      context,
      ...safeCleanupPhaseFields("cleanup-operation", error.cleanupFailure),
      `cleanup-phase=postgres.cleanup cleanup=${safeFailureClassAndLocation(error.cleanupFailure)}`,
    ].join(" ");
  }
  if (primary instanceof NativePostgresProofPhaseFailure) {
    return [
      `phase=${primary.phase}`,
      "failure=primary-and-cleanup",
      ...safePhaseFields("primary", primary.cause),
      `primary=${safeFailureClassAndLocation(primary.cause)}`,
      ...safeCleanupPhaseFields("cleanup-operation", error.cleanupFailure),
      `cleanup-phase=postgres.cleanup cleanup=${safeFailureClassAndLocation(error.cleanupFailure)}`,
    ].join(" ");
  }
  if (primary instanceof NativePostgresPhaseFailure) {
    return [
      `phase=${isNativePostgresPhase(primary.phase) ? primary.phase : "postgres.lifecycle"}`,
      "failure=primary-and-cleanup",
      `primary=${safeFailureClassAndLocation(primary)}`,
      ...safeCleanupPhaseFields("cleanup-operation", error.cleanupFailure),
      `cleanup-phase=postgres.cleanup cleanup=${safeFailureClassAndLocation(error.cleanupFailure)}`,
    ].join(" ");
  }
  return [
    "phase=postgres.lifecycle",
    "failure=primary-and-cleanup",
    ...safePhaseFields("primary", primary),
    `primary=${safeFailureClassAndLocation(primary)}`,
    ...safeCleanupPhaseFields("cleanup-operation", error.cleanupFailure),
    `cleanup-phase=postgres.cleanup cleanup=${safeFailureClassAndLocation(error.cleanupFailure)}`,
  ].join(" ");
}

function formatNativePostgresPrimaryFailure(error: unknown): string {
  if (error instanceof NativePostgresCoreHttpFailure) {
    return formatCoreHttpLifecycleFailure(error.trace, error.cause);
  }
  if (error instanceof NativePostgresProofPhaseFailure) {
    return formatNativePostgresProofFailure(error.phase, error.cause);
  }
  if (error instanceof NativePostgresPhaseFailure) {
    return formatNativePostgresProofFailure(error.phase, error.cause);
  }
  if (
    error instanceof NativePostgresLifecycleCleanupFailure ||
    error instanceof LocalCoreHttpCleanupFailure
  ) {
    return formatNativePostgresLifecycleFailure(error);
  }
  return `phase=postgres.lifecycle failure=${safeFailureClassAndLocation(error)}`;
}

/** Emits the Core proof failure and separately labels runner HTTP history as context. */
export function formatCoreHttpLifecycleFailure(
  trace: RunnerHttpProofTrace,
  error: unknown,
): string {
  const label = (candidate: RunnerHttpProofLabel | undefined) =>
    candidate && RUNNER_HTTP_PROOF_LABELS.includes(candidate) ? candidate : "none";
  return [
    "phase=core.http-lifecycle",
    `runner-http-last-attempted=${label(trace.attempted)}`,
    `runner-http-last-completed=${label(trace.completed)}`,
    `runner-http-last-observed-failure=${label(trace.failed)}`,
    ...safePhaseFields("failure", error),
    `failure=${safeFailureClassAndLocation(error)}`,
  ].join(" ");
}

export function parsePgHttpProofArgs(
  args: readonly string[],
  inherited: NodeJS.ProcessEnv,
): { readonly image: string } {
  if (inherited[NATIVE_POSTGRES_OPT_IN] !== "1") {
    throw new Error(
      `native PostgreSQL plus HTTP proof requires explicit ${NATIVE_POSTGRES_OPT_IN}=1 opt-in`,
    );
  }
  return parseProofArgs(args);
}

type NativeClient = Awaited<ReturnType<typeof openNativePostgresSqlClient>>;

async function proveWithDatabase(input: {
  readonly baseUrl: string;
  readonly image: string;
  readonly root: string;
  readonly signal: AbortSignal;
  readonly runDocker: (args: readonly string[]) => Promise<string>;
}): Promise<{
  readonly kind: "takosumi.local-core-pg-http-lifecycle-proof/v1";
  readonly status: "passed";
  readonly runnerImage: string;
  readonly restart: NativePostgresRestartEvidence;
  readonly stateGenerations: readonly number[];
  readonly lifecycle: readonly ["plan", "apply-gen1", "restart-replay-gen1", "update-apply-gen2", "approved-destroy-gen3"];
  readonly limits: readonly string[];
}> {
  let database: Awaited<ReturnType<typeof createNativePostgresRestartContainer>>;
  try {
    database = await runNativePostgresPhase(
      "fixture.create",
      () => createNativePostgresRestartContainer({ runDocker: input.runDocker }),
    );
  } catch (cause) {
    throw new NativePostgresProofPhaseFailure("postgres.fixture.create", cause);
  }
  const clients: NativeClient[] = [];
  const closed = new Set<NativeClient>();
  let currentClient: NativeClient | undefined;
  let restart: NativePostgresRestartEvidence | undefined;

  const openClient = async (): Promise<NativeClient> => {
    const client = await runNativePostgresPhase(
      clients.length === 0 ? "pool.first.open" : "pool.fresh.open",
      () => openNativePostgresSqlClient(database.databaseUrl),
    );
    clients.push(client);
    currentClient = client;
    return client;
  };
  const closeClient = async (client: NativeClient): Promise<void> => {
    if (closed.has(client)) return;
    await client.close();
    closed.add(client);
  };

  return await runWithNativePostgresCleanup(async () => {
    currentClient = await openClient();
    const initialMigrations = new StorageMigrationRunner(currentClient.client);
    const migrationResult = await runNativePostgresPhase(
      "migration.apply-pending",
      () => initialMigrations.applyPending(),
    );
    assert(migrationResult.appliedNow.length > 0, "fresh native PostgreSQL fixture had no pending migrations");
    const initialMigrationStatus = await runNativePostgresPhase(
      "migration.verify-current",
      () => initialMigrations.verifyCurrent(),
    );
    assert.deepEqual(initialMigrationStatus.pending, []);

    const runnerHttpTrace: {
      attempted?: RunnerHttpProofLabel;
      completed?: RunnerHttpProofLabel;
      failed?: RunnerHttpProofLabel;
    } = {};
    const proof = await proveCoreHttpLifecycle(
      input.baseUrl,
      input.image,
      input.root,
      input.signal,
      {
        currentSqlClient: () => {
          if (!currentClient || closed.has(currentClient)) {
            throw new Error("fresh SQL client is not open for Core construction");
          }
          return currentClient.client;
        },
        createRuntime: async ({ baseUrl, archiveStore, stateStore, profile, sqlClient }) => {
          const store = new SqlOpenTofuControlStore({ client: sqlClient });
          const { operations } = await createTakosumiService({
            role: "takosumi-api",
            runtimeEnv: { TAKOSUMI_DEV_MODE: "1" },
            sqlClient,
            opentofuControlStore: store,
            opentofuRunner: createHttpOpenTofuRunner({ archiveStore, stateStore, baseUrl }),
            runnerProfiles: [profile],
            defaultRunnerProfileId: profile.id,
            artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
            executionEvidenceAuthority: FIXTURE_EXECUTION_EVIDENCE_AUTHORITY,
          });
          return { store, operations };
        },
        afterInitialApply: async () => {
          assert(currentClient, "initial SQL client is missing at the restart boundary");
          await runNativePostgresPhase("pool.first.close", () => closeClient(currentClient!));
          restart = await runNativePostgresPhase(
            "daemon.restart",
            () => database.restartPostgresDaemon(),
          );
          currentClient = await openClient();
          const freshMigrationStatus = await runNativePostgresPhase(
            "migration.verify-after-restart",
            () => new StorageMigrationRunner(currentClient!.client).verifyCurrent(),
          );
          assert.deepEqual(freshMigrationStatus.pending, []);
          assert.deepEqual(
            freshMigrationStatus.applied,
            initialMigrationStatus.applied,
            "fresh Core database connection observed a changed migration ledger",
          );
        },
        observeRunnerHttp: (label, phase) => recordRunnerHttpProofEvent(runnerHttpTrace, label, phase),
      },
    ).catch((cause: unknown) => {
      throw new NativePostgresCoreHttpFailure(runnerHttpTrace, cause);
    });

    assert.equal(proof.status, "passed");
    assert.deepEqual(proof.stateGenerations, [1, 2, 3]);
    assert(restart, "proof returned without crossing the PostgreSQL restart boundary");
    return {
      kind: "takosumi.local-core-pg-http-lifecycle-proof/v1",
      status: "passed",
      runnerImage: input.image,
      restart,
      stateGenerations: proof.stateGenerations,
      lifecycle: ["plan", "apply-gen1", "restart-replay-gen1", "update-apply-gen2", "approved-destroy-gen3"],
      limits: [
        "synthetic in-memory Accounts/session fixture; real login and authentication persistence are not exercised",
        "provider-free local SourceSnapshot archive; Git fetch/install coordination is not exercised",
        "the existing real local HTTP/OpenTofu runner executes the provider-free configuration; no cloud provider mutation is exercised",
        "native PostgreSQL daemon restart is local and run-owned; Core is rebuilt in the same proof process, not an OS-process restart",
        "not production or Takosumi Hosted qualification",
      ],
    };
  }, async () => {
    await cleanupNativePostgresResources(
      clients.map((client) => () => closeClient(client)),
      () => database.close(),
    );
  });
}

async function main(): Promise<void> {
  const { image } = parsePgHttpProofArgs(Bun.argv.slice(2), process.env);
  const root = await mkdtemp("/dev/shm/takosumi-pg-http-");
  const runAbort = new AbortController();
  const timeout = setTimeout(() => runAbort.abort(), 300_000);
  const onSignal = () => runAbort.abort();
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  try {
    await runAndEmitAfterCleanup(
      async () => {
        await chmod(root, 0o700);
        return await withLocalCoreHttpRunner({
          image,
          signal: runAbort.signal,
          run: async ({ baseUrl, runDocker }) =>
            await proveWithDatabase({ baseUrl, image, root, signal: runAbort.signal, runDocker }),
        });
      },
      () => rm(root, { recursive: true, force: false }),
      (result) => {
        if (runAbort.signal.aborted) throw new Error("local Core PostgreSQL HTTP proof was interrupted");
        console.log(JSON.stringify(result));
      },
    );
  } catch (error) {
    if (error instanceof NativePostgresProofPhaseFailure) {
      console.error(
        `local Core PostgreSQL HTTP proof failed: ${formatNativePostgresProofFailure(error.phase, error.cause)}`,
      );
      process.exitCode = 1;
      return;
    }
    if (error instanceof NativePostgresPhaseFailure) {
      console.error(
        `local Core PostgreSQL HTTP proof failed: ${formatNativePostgresProofFailure(error.phase, error.cause)}`,
      );
      process.exitCode = 1;
      return;
    }
    if (error instanceof NativePostgresCoreHttpFailure) {
      console.error(
        `local Core PostgreSQL HTTP proof failed: ${formatCoreHttpLifecycleFailure(error.trace, error.cause)}`,
      );
      process.exitCode = 1;
      return;
    }
    if (
      error instanceof NativePostgresLifecycleCleanupFailure ||
      error instanceof LocalCoreHttpCleanupFailure
    ) {
      console.error(
        `local Core PostgreSQL HTTP proof failed: ${formatNativePostgresLifecycleFailure(error)}`,
      );
      process.exitCode = 1;
      return;
    }
    const location = error instanceof Error
      ? error.stack?.match(/local-core-pg-http-lifecycle\.ts:[0-9]+:[0-9]+/u)?.[0]
      : undefined;
    console.error(
      `local Core PostgreSQL HTTP proof failed: ${error instanceof Error ? error.name : "unknown error"}${location ? ` (${location})` : ""}`,
    );
    process.exitCode = 1;
  } finally {
    clearTimeout(timeout);
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}

if (import.meta.main) await main();
