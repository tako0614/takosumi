#!/usr/bin/env bun

/**
 * Opt-in local proof composing SQL-backed Core, native PostgreSQL daemon
 * restart, and the existing real HTTP/OpenTofu runner lifecycle.
 */
import { strict as assert } from "node:assert";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { InMemoryAccountsStore } from "../../accounts/service/src/store.ts";
import { handleControlRoute } from "../../accounts/service/src/control-routes.ts";
import { createTakosumiService } from "../../core/bootstrap.ts";
import { PartitionedSecretBoundaryCrypto } from "../../core/adapters/secret-store/memory.ts";
import { ObjectKeyArtifactReferenceAllocator } from "../../core/adapters/storage/artifact-references.ts";
import { StorageMigrationRunner } from "../../core/adapters/storage/migration-runner/mod.ts";
import {
  createFileOpenTofuStateArtifactStore,
  createFileSourceArchiveStore,
  createHttpOpenTofuRunner,
  createLocalOpenTofuRunnerProfile,
} from "../../deploy/node-postgres/src/local-opentofu-runner.ts";
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
  createLocalCoreHttpProofAccounts,
  type LocalCoreHttpProofRuntimeInput,
  type RunnerHttpProofEventPhase,
  type RunnerHttpProofLabel,
  type RunnerHttpProofObserver,
  type SavedPlanStateMetadataReceipt,
  boundedRunnerFetch,
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

/** Sends one public Core route request to a proof-owned loopback child host. */
export function createCoreHostHttpControlRequest(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
): (request: Request) => Promise<Response> {
  let childOrigin: URL;
  try {
    childOrigin = new URL(baseUrl);
  } catch {
    throw new Error("Core proof child must use loopback HTTP");
  }
  if (
    childOrigin.protocol !== "http:" ||
    childOrigin.hostname !== "127.0.0.1" ||
    childOrigin.username !== "" ||
    childOrigin.password !== "" ||
    childOrigin.pathname !== "/" ||
    childOrigin.search !== "" ||
    childOrigin.hash !== ""
  ) {
    throw new Error("Core proof child must use loopback HTTP");
  }

  return async (request) => {
    const source = new URL(request.url);
    if (
      source.origin !== "https://local-proof.example.test" ||
      !source.pathname.startsWith("/api/v1/") ||
      source.search !== "" ||
      source.hash !== ""
    ) {
      throw new Error("Core proof refused a non-local control request");
    }

    const headers = new Headers();
    for (const name of ["cookie", "content-type", "idempotency-key"] as const) {
      const value = request.headers.get(name);
      if (value !== null) headers.set(name, value);
    }
    const body = request.method === "GET" || request.method === "HEAD"
      ? undefined
      : await request.arrayBuffer();
    return await fetchImpl(new URL(source.pathname, childOrigin), {
      method: request.method,
      headers,
      body,
      signal: request.signal,
      redirect: "error",
      cache: "no-store",
    });
  };
}

type NativeClient = Awaited<ReturnType<typeof openNativePostgresSqlClient>>;

const CORE_HOST_EVENT_HEADER = "x-takosumi-local-proof-events";
const CORE_HOST_START_TIMEOUT_MS = 15_000;
const CORE_HOST_STOP_TIMEOUT_MS = 15_000;
const CORE_HOST_PROTOCOL_LINE_MAX_BYTES = 16 * 1024;

interface CoreHostChildStartup {
  readonly type: "start-core-host/v1";
  readonly databaseUrl: string;
  readonly runnerBaseUrl: string;
  readonly artifactRoot: string;
  readonly artifactEncryptionPassphrase: string;
  readonly syntheticSessionIds: LocalCoreHttpProofRuntimeInput["syntheticSessionIds"];
}

interface CoreHostEventSnapshot {
  readonly runnerDispatches: readonly string[];
  readonly metadataReceipts: readonly SavedPlanStateMetadataReceipt[];
  readonly runnerEvents: readonly {
    readonly label: RunnerHttpProofLabel;
    readonly phase: RunnerHttpProofEventPhase;
  }[];
}

interface CoreHostReadyMessage {
  readonly type: "ready-core-host/v1";
  readonly pid: number;
  readonly port: number;
}

interface CoreHostFailedMessage {
  readonly type: "failed-core-host/v1";
  readonly errorClass: string;
}

interface CoreHostProcess {
  readonly pid: number;
  readonly controlRequest: (request: Request) => Promise<Response>;
  close(): Promise<void>;
}

export function parseCoreHostReadyMessage(
  line: string,
  expectedPid: number,
): { readonly pid: number; readonly port: number } {
  let message: CoreHostReadyMessage | CoreHostFailedMessage;
  try {
    message = JSON.parse(line) as CoreHostReadyMessage | CoreHostFailedMessage;
  } catch {
    throw new Error("Core child returned an invalid readiness message");
  }
  if (message.type === "failed-core-host/v1") {
    if (!SAFE_ERROR_CLASS_NAMES.has(message.errorClass)) {
      throw new Error("Core child startup failed (OtherError)");
    }
    throw new Error("Core child startup failed (" + message.errorClass + ")");
  }
  if (
    message.type !== "ready-core-host/v1" || message.pid !== expectedPid ||
    !Number.isSafeInteger(message.port) || message.port < 1 || message.port > 65_535
  ) {
    throw new Error("Core child returned invalid readiness evidence");
  }
  return { pid: message.pid, port: message.port };
}

export async function closeCoreHostBeforePostgresRestart<T>(input: {
  readonly closeCoreHost: () => Promise<void>;
  readonly closeObserverSqlClient: () => Promise<void>;
  readonly restartPostgresDaemon: () => Promise<T>;
}): Promise<T> {
  await input.closeCoreHost();
  await input.closeObserverSqlClient();
  return await input.restartPostgresDaemon();
}

async function* readProtocolLines(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      pending += decoder.decode(value, { stream: !done });
      let newline = pending.indexOf("\n");
      while (newline >= 0) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (new TextEncoder().encode(line).byteLength > CORE_HOST_PROTOCOL_LINE_MAX_BYTES) {
          throw new Error("Core child protocol line exceeded the local size bound");
        }
        yield line;
        newline = pending.indexOf("\n");
      }
      if (pending.length > CORE_HOST_PROTOCOL_LINE_MAX_BYTES || done) {
        if (done && pending.length > 0) throw new Error("Core child protocol ended mid-message");
        return;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function parseCoreHostEvents(headers: Headers): CoreHostEventSnapshot {
  const encoded = headers.get(CORE_HOST_EVENT_HEADER);
  if (!encoded || encoded.length > CORE_HOST_PROTOCOL_LINE_MAX_BYTES) {
    throw new Error("Core child omitted bounded proof event data");
  }
  try {
    const value: unknown = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    if (!value || typeof value !== "object") throw new Error();
    const candidate = value as Record<string, unknown>;
    if (
      !Array.isArray(candidate.runnerDispatches) || candidate.runnerDispatches.length > 256 ||
      !candidate.runnerDispatches.every((id) => typeof id === "string" && id.length <= 128) ||
      !Array.isArray(candidate.metadataReceipts) || candidate.metadataReceipts.length > 256 ||
      !Array.isArray(candidate.runnerEvents) || candidate.runnerEvents.length > 512
    ) {
      throw new Error();
    }
    const metadataReceipts = candidate.metadataReceipts as SavedPlanStateMetadataReceipt[];
    if (!metadataReceipts.every((receipt) =>
      receipt && typeof receipt.runnerRunId === "string" && receipt.runnerRunId.length <= 128 &&
      typeof receipt.planDigest === "string" && receipt.planDigest.length <= 80 &&
      typeof receipt.lineage === "string" && receipt.lineage.length <= 128 &&
      Number.isSafeInteger(receipt.serial) && receipt.serial >= 0
    )) {
      throw new Error();
    }
    const runnerEvents = candidate.runnerEvents as CoreHostEventSnapshot["runnerEvents"];
    if (!runnerEvents.every((event) =>
      event && RUNNER_HTTP_PROOF_LABELS.includes(event.label) &&
      (event.phase === "start" || event.phase === "completed" || event.phase === "failed")
    )) {
      throw new Error();
    }
    return {
      runnerDispatches: candidate.runnerDispatches as string[],
      metadataReceipts,
      runnerEvents,
    };
  } catch {
    throw new Error("Core child returned invalid bounded proof event data");
  }
}

async function waitForChildExit(
  child: ReturnType<typeof Bun.spawn>,
  timeoutMs: number,
): Promise<number> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      child.exited,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("Core child exit exceeded the local deadline")), timeoutMs);
      }),
    ]);
    return result;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function startCoreHostProcess(
  input: LocalCoreHttpProofRuntimeInput,
  databaseUrl: string,
  onChildSpawn: (child: ReturnType<typeof Bun.spawn>) => void,
): Promise<CoreHostProcess> {
  if (!process.argv[1]) throw new Error("Core child entrypoint is unavailable");
  const child = Bun.spawn([
    process.execPath,
    "--no-env-file",
    process.argv[1],
    "--core-host-child",
  ], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: process.env.HOME ?? "/nonexistent",
      LC_ALL: "C",
    },
  });
  onChildSpawn(child);
  void child.stderr.pipeTo(new WritableStream({ write() {} })).catch(() => undefined);
  const lines = readProtocolLines(child.stdout)[Symbol.asyncIterator]();
  let exitConfirmed = false;
  try {
    const startup: CoreHostChildStartup = {
      type: "start-core-host/v1",
      databaseUrl,
      runnerBaseUrl: input.baseUrl,
      artifactRoot: input.artifactRoot,
      artifactEncryptionPassphrase: input.artifactEncryptionPassphrase,
      syntheticSessionIds: input.syntheticSessionIds,
    };
    child.stdin.write(JSON.stringify(startup) + "\n");
    await child.stdin.flush();

    let timeout: ReturnType<typeof setTimeout> | undefined;
    let firstLine: IteratorResult<string>;
    try {
      firstLine = await Promise.race([
        lines.next(),
        child.exited.then(() => { throw new Error("Core child exited before readiness"); }),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error("Core child readiness exceeded the local deadline")),
            CORE_HOST_START_TIMEOUT_MS,
          );
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
    if (firstLine.done) throw new Error("Core child exited before readiness");

    const ready = parseCoreHostReadyMessage(firstLine.value, child.pid);
    const baseUrl = "http://127.0.0.1:" + ready.port;
    const send = createCoreHostHttpControlRequest(baseUrl, input.fetchImpl);
    let dispatchCount = 0;
    let receiptCount = 0;
    let eventCount = 0;
    let closed = false;
    return {
      pid: child.pid,
      async controlRequest(request: Request): Promise<Response> {
        if (closed) throw new Error("Core child is already closed");
        const response = await send(request);
        const events = parseCoreHostEvents(response.headers);
        if (
          events.runnerDispatches.length < dispatchCount ||
          events.metadataReceipts.length < receiptCount ||
          events.runnerEvents.length < eventCount
        ) {
          throw new Error("Core child proof event sequence regressed");
        }
        for (const runId of events.runnerDispatches.slice(dispatchCount)) input.onRunDispatch(runId);
        for (const receipt of events.metadataReceipts.slice(receiptCount)) {
          input.onSavedPlanMetadataReceipt(receipt);
        }
        for (const event of events.runnerEvents.slice(eventCount)) {
          input.observeRunnerHttp(event.label, event.phase);
        }
        dispatchCount = events.runnerDispatches.length;
        receiptCount = events.metadataReceipts.length;
        eventCount = events.runnerEvents.length;
        const headers = new Headers(response.headers);
        headers.delete(CORE_HOST_EVENT_HEADER);
        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
      },
      async close(): Promise<void> {
        if (closed) return;
        if (child.exitCode !== null) {
          exitConfirmed = true;
          closed = true;
          throw new Error("Core child exited before owned shutdown");
        }
        child.stdin.write("{\"type\":\"shutdown-core-host/v1\"}\n");
        await child.stdin.flush();
        child.stdin.end();
        let exitCode: number;
        try {
          exitCode = await waitForChildExit(child, CORE_HOST_STOP_TIMEOUT_MS);
        } catch {
          child.kill("SIGTERM");
          try {
            exitCode = await waitForChildExit(child, CORE_HOST_STOP_TIMEOUT_MS);
          } catch {
            throw new Error("Core child exit remains unconfirmed; PostgreSQL custody is retained");
          }
          exitConfirmed = true;
          closed = true;
          throw new Error("Core child exceeded its graceful shutdown deadline");
        }
        exitConfirmed = true;
        closed = true;
        if (exitCode !== 0) throw new Error("Core child did not exit cleanly");
      },
    };
  } catch (error) {
    if (!exitConfirmed && child.exitCode === null) {
      child.kill("SIGTERM");
      try {
        await waitForChildExit(child, CORE_HOST_STOP_TIMEOUT_MS);
        exitConfirmed = true;
      } catch {
        throw new AggregateError(
          [error],
          "Core child startup failed and owned child exit is unconfirmed",
        );
      }
    }
    throw new Error("Core child startup failed (" + safeErrorClass(error) + ")");
  }
}

function validateCoreHostChildStartup(value: unknown): CoreHostChildStartup {
  if (!value || typeof value !== "object") throw new Error("invalid Core child startup input");
  const candidate = value as Record<string, unknown>;
  if (
    candidate.type !== "start-core-host/v1" ||
    typeof candidate.databaseUrl !== "string" ||
    typeof candidate.runnerBaseUrl !== "string" ||
    typeof candidate.artifactRoot !== "string" ||
    typeof candidate.artifactEncryptionPassphrase !== "string" ||
    !candidate.syntheticSessionIds || typeof candidate.syntheticSessionIds !== "object"
  ) {
    throw new Error("invalid Core child startup input");
  }
  let databaseUrl: URL;
  let runnerBaseUrl: URL;
  try {
    databaseUrl = new URL(candidate.databaseUrl);
    runnerBaseUrl = new URL(candidate.runnerBaseUrl);
  } catch {
    throw new Error("invalid local Core child endpoint");
  }
  const sessions = candidate.syntheticSessionIds as Record<string, unknown>;
  if (
    !["postgres:", "postgresql:"].includes(databaseUrl.protocol) ||
    databaseUrl.hostname !== "127.0.0.1" || !databaseUrl.port ||
    runnerBaseUrl.protocol !== "http:" || runnerBaseUrl.hostname !== "127.0.0.1" ||
    !runnerBaseUrl.port || !candidate.artifactRoot.startsWith("/") ||
    candidate.artifactEncryptionPassphrase.length < 32 ||
    candidate.artifactEncryptionPassphrase.length > 512 ||
    typeof sessions.actor !== "string" ||
    !/^sess_local_core_http_[a-f0-9]{32}$/u.test(sessions.actor) ||
    typeof sessions.foreignActor !== "string" ||
    !/^sess_foreign_core_http_[a-f0-9]{32}$/u.test(sessions.foreignActor) ||
    !Number.isSafeInteger(sessions.createdAt) ||
    !Number.isSafeInteger(sessions.expiresAt) ||
    (sessions.expiresAt as number) <= (sessions.createdAt as number)
  ) {
    throw new Error("invalid local Core child startup input");
  }
  return value as CoreHostChildStartup;
}

async function runCoreHostChild(): Promise<void> {
  let client: NativeClient | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;
  const originalFetch = globalThis.fetch;
  let exitCode = 0;
  try {
    const lines = readProtocolLines(Bun.stdin.stream())[Symbol.asyncIterator]();
    const first = await lines.next();
    if (first.done) throw new Error("Core child startup input is absent");
    const startup = validateCoreHostChildStartup(JSON.parse(first.value));
    client = await openNativePostgresSqlClient(startup.databaseUrl);
    const profile = createLocalOpenTofuRunnerProfile();
    const store = new SqlOpenTofuControlStore({ client: client.client });
    const archiveStore = createFileSourceArchiveStore(join(startup.artifactRoot, "archives"));
    const stateStore = createFileOpenTofuStateArtifactStore(
      join(startup.artifactRoot, "state"),
      new PartitionedSecretBoundaryCrypto({
        globalPassphrase: startup.artifactEncryptionPassphrase,
      }),
    );
    const { operations } = await createTakosumiService({
      role: "takosumi-api",
      runtimeEnv: { TAKOSUMI_DEV_MODE: "1" },
      sqlClient: client.client,
      opentofuControlStore: store,
      opentofuRunner: createHttpOpenTofuRunner({
        archiveStore,
        stateStore,
        baseUrl: startup.runnerBaseUrl,
      }),
      runnerProfiles: [profile],
      defaultRunnerProfileId: profile.id,
      artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
      executionEvidenceAuthority: FIXTURE_EXECUTION_EVIDENCE_AUTHORITY,
    });
    const accounts = createLocalCoreHttpProofAccounts(startup.syntheticSessionIds);
    const runnerDispatches: string[] = [];
    const metadataReceipts: SavedPlanStateMetadataReceipt[] = [];
    const runnerEvents: CoreHostEventSnapshot["runnerEvents"][number][] = [];
    globalThis.fetch = boundedRunnerFetch(
      startup.runnerBaseUrl,
      originalFetch,
      undefined,
      (receipt) => { metadataReceipts.push(receipt); },
      (runId) => { runnerDispatches.push(runId); },
      (label, phase) => {
        recordRunnerHttpProofEvent(runnerHttpTrace, label, phase);
        runnerEvents.push({ label, phase });
      },
    );
    const runnerHttpTrace: RunnerHttpProofTrace = {};
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        let response: Response;
        if (
          url.hostname !== "127.0.0.1" ||
          url.search !== "" || url.hash !== "" ||
          !url.pathname.startsWith("/api/v1/")
        ) {
          response = new Response("{\"error\":{\"code\":\"local_proof_route_rejected\"}}", {
            status: 404,
            headers: { "content-type": "application/json" },
          });
        } else {
          try {
            response = await handleControlRoute({
              request,
              url,
              store: accounts,
              operations,
            }) ?? new Response(null, { status: 404 });
          } catch {
            response = new Response("{\"error\":{\"code\":\"local_proof_request_failed\"}}", {
              status: 500,
              headers: { "content-type": "application/json" },
            });
          }
        }
        const eventData = Buffer.from(JSON.stringify({
          runnerDispatches,
          metadataReceipts,
          runnerEvents,
        })).toString("base64url");
        if (eventData.length > CORE_HOST_PROTOCOL_LINE_MAX_BYTES) {
          return new Response("{\"error\":{\"code\":\"local_proof_event_limit\"}}", {
            status: 500,
            headers: { "content-type": "application/json" },
          });
        }
        const headers = new Headers(response.headers);
        headers.set(CORE_HOST_EVENT_HEADER, eventData);
        return new Response(
          response.status === 204 || response.status === 304 ? null : response.body,
          { status: response.status, statusText: response.statusText, headers },
        );
      },
    });
    process.stdout.write(JSON.stringify({
      type: "ready-core-host/v1",
      pid: process.pid,
      port: server.port,
    }) + "\n");

    const shutdown = await lines.next();
    if (shutdown.done) throw new Error("Core child shutdown request is absent");
    const command: unknown = JSON.parse(shutdown.value);
    if (
      !command || typeof command !== "object" ||
      (command as Record<string, unknown>).type !== "shutdown-core-host/v1"
    ) {
      throw new Error("invalid Core child shutdown request");
    }
  } catch (error) {
    process.stdout.write(JSON.stringify({
      type: "failed-core-host/v1",
      errorClass: safeErrorClass(error),
    }) + "\n");
    exitCode = 1;
  } finally {
    globalThis.fetch = originalFetch;
    if (server) {
      try {
        await server.stop(true);
      } catch {
        exitCode = 1;
      }
    }
    if (client) {
      try {
        await client.close();
      } catch {
        exitCode = 1;
      }
    }
  }
  process.exitCode = exitCode;
}

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
  readonly coreHostRestart: {
    readonly processCount: 2;
    readonly distinctProcessIds: true;
  };
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
  let activeCoreHost: CoreHostProcess | undefined;
  let startingCoreHostChild: ReturnType<typeof Bun.spawn> | undefined;
  const coreHostProcessIds: number[] = [];

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
        createRuntime: async (runtimeInput) => {
          const observerStore = new SqlOpenTofuControlStore({ client: currentClient!.client });
          const child = await startCoreHostProcess(
            runtimeInput,
            database.databaseUrl,
            (spawned) => { startingCoreHostChild = spawned; },
          );
          startingCoreHostChild = undefined;
          activeCoreHost = child;
          coreHostProcessIds.push(child.pid);
          return {
            store: observerStore,
            controlRequest: child.controlRequest,
          };
        },
        afterInitialApply: async () => {
          assert(currentClient, "initial SQL client is missing at the restart boundary");
          assert(activeCoreHost, "initial Core Host process is missing at the restart boundary");
          restart = await closeCoreHostBeforePostgresRestart({
            closeCoreHost: () => runNativePostgresPhase("core-host.first.close", async () => {
              await activeCoreHost!.close();
              activeCoreHost = undefined;
            }),
            closeObserverSqlClient: () => runNativePostgresPhase(
              "pool.first.close",
              () => closeClient(currentClient!),
            ),
            restartPostgresDaemon: () => runNativePostgresPhase(
              "daemon.restart",
              () => database.restartPostgresDaemon(),
            ),
          });
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
    assert(activeCoreHost, "fresh Core Host process is missing after the restart lifecycle");
    await runNativePostgresPhase("core-host.fresh.close", async () => {
      await activeCoreHost!.close();
      activeCoreHost = undefined;
    });
    assert.equal(coreHostProcessIds.length, 2, "proof did not start exactly two Core Host processes");
    assert.notEqual(coreHostProcessIds[0], coreHostProcessIds[1], "Core Host process ID was reused across restart");
    return {
      kind: "takosumi.local-core-pg-http-lifecycle-proof/v1",
      status: "passed",
      runnerImage: input.image,
      restart,
      coreHostRestart: { processCount: 2, distinctProcessIds: true },
      stateGenerations: proof.stateGenerations,
      lifecycle: ["plan", "apply-gen1", "restart-replay-gen1", "update-apply-gen2", "approved-destroy-gen3"],
      limits: [
        "synthetic in-memory Accounts/session fixture; real login and authentication persistence are not exercised",
        "provider-free local SourceSnapshot archive; Git fetch/install coordination is not exercised",
        "the existing real local HTTP/OpenTofu runner executes the provider-free configuration; no cloud provider mutation is exercised",
        "native PostgreSQL daemon restart is local and run-owned; two separate Core Host processes are started by the same proof orchestrator",
        "Core process restart is a clean operator-controlled shutdown, not OS reboot or crash-in-flight recovery",
        "not production or Takosumi Hosted qualification",
      ],
    };
  }, async () => {
    if (startingCoreHostChild) {
      if (startingCoreHostChild.exitCode === null) {
        throw new Error("Core child startup exit is unconfirmed; PostgreSQL custody is retained");
      }
      startingCoreHostChild = undefined;
    }
    if (activeCoreHost) {
      await runNativePostgresPhase("core-host.cleanup.close", async () => {
        await activeCoreHost!.close();
        activeCoreHost = undefined;
      });
    }
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

if (import.meta.main) {
  if (Bun.argv[2] === "--core-host-child") await runCoreHostChild();
  else await main();
}
