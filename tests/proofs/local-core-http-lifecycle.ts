#!/usr/bin/env bun

/**
 * Manual, local-only proof of the public control API -> Core -> HTTP runner
 * lifecycle. The immutable SourceSnapshot is seeded from a real archive; Git
 * fetch, login, install coordination, durable DB, and hosted execution are not
 * exercised here.
 */
import { strict as assert } from "node:assert";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createDockerCommandFailure } from "../helpers/deploy-control/docker_command_failure.ts";
import { ACCOUNT_SESSION_COOKIE_NAME } from "../../accounts/service/src/account-session.ts";
import { genericOpenTofuVariableContractDigest } from "../../accounts/service/src/control/generic-opentofu-variable-contract.ts";
import { handleControlRoute } from "../../accounts/service/src/control-routes.ts";
import { InMemoryAccountsStore } from "../../accounts/service/src/store.ts";
import { ObjectKeyArtifactReferenceAllocator } from "../../core/adapters/storage/artifact-references.ts";
import { PartitionedSecretBoundaryCrypto } from "../../core/adapters/secret-store/memory.ts";
import { createTakosumiService } from "../../core/bootstrap.ts";
import { InMemoryOpenTofuControlStore } from "../../core/domains/deploy-control/store.ts";
import type { OpenTofuControlStore } from "../../core/domains/deploy-control/store.ts";
import {
  assertSavedPlanMatchesState,
  parseOpenTofuStateMetadata,
  type OpenTofuStateMetadata,
} from "../../core/shared/open-tofu-state-metadata.ts";
import {
  createFileOpenTofuStateArtifactStore,
  createFileSourceArchiveStore,
  createHttpOpenTofuRunner,
  createLocalOpenTofuRunnerProfile,
  type LocalOpenTofuStateArtifact,
} from "../../deploy/node-postgres/src/local-opentofu-runner.ts";
import {
  FIXTURE_EXECUTION_EVIDENCE_AUTHORITY,
  seedCapsuleModel,
} from "../helpers/deploy-control/model_fixture.ts";
import type { CapsuleCompatibilityReport } from "takosumi-contract/capsules";
import type { SourceSnapshot } from "takosumi-contract/sources";
import type { PublicStateVersion, StateVersion } from "takosumi-contract/state-versions";

const IMAGE_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const ORIGIN = "https://local-proof.example.test";
const ACTOR = "tsub_local_core_http";
const FOREIGN_ACTOR = "tsub_foreign_core_http";
const MAX_COMMAND_OUTPUT = 4096;
const COMMAND_TIMEOUT_MS = 10_000;
const HTTP_TIMEOUT_MS = 25_000;
const MAX_RUNNER_RESPONSE_BYTES = 256 * 1024;
const MAX_RUNNER_ARTIFACT_BYTES = 8 * 1024 * 1024;
const OWNER_LABEL = "takosumi.local-core-http-proof.owner";
const SAFE_PROOF_ERROR_NAMES = new Set([
  "AbortError",
  "AggregateError",
  "AssertionError",
  "Error",
  "NativePostgresCoreHttpFailure",
  "RangeError",
  "TimeoutError",
  "TypeError",
]);

export type LocalCoreHttpProofPhase =
  | "preflight"
  | "docker startup"
  | "public control lifecycle"
  | "cleanup";
export type LocalCoreHttpCleanupPhase = "runner.cleanup" | "proof.cleanup";

export class LocalCoreHttpCleanupFailure extends AggregateError {
  constructor(
    primaryFailure: unknown,
    cleanupFailure: unknown,
    readonly cleanupPhase: LocalCoreHttpCleanupPhase,
  ) {
    super(
      [primaryFailure, cleanupFailure],
      "proof work and cleanup both failed",
      { cause: primaryFailure },
    );
    this.name = "LocalCoreHttpCleanupFailure";
  }
}

export const RUNNER_HTTP_PROOF_LABELS = [
  "runner.health",
  "runner.dispatch",
  "runner.run-read",
  "runner.plan-metadata",
  "runner.state-read",
  "runner.state-write",
  "runner.plan-artifact-read",
  "runner.plan-artifact-write",
  "runner.source-archive-read",
  "runner.source-archive-write",
  "runner.lockfile-read",
  "runner.lockfile-write",
  "runner.completion-read",
  "runner.mutation-reservation",
  "runner.provider-lock-restore",
  "runner.source-archive-restore",
  "runner.other",
] as const;
export type RunnerHttpProofLabel = (typeof RUNNER_HTTP_PROOF_LABELS)[number];

export type RunnerHttpProofEventPhase = "start" | "completed" | "failed";
export type RunnerHttpProofObserver = (
  label: RunnerHttpProofLabel,
  phase: RunnerHttpProofEventPhase,
  cause?: unknown,
) => void;

function runnerHttpProofLabel(method: string, pathname: string): RunnerHttpProofLabel {
  const verb = method.toUpperCase();
  if (verb === "GET" && pathname === "/healthz") return "runner.health";
  if (verb === "POST" && /^\/runs\/[^/]+$/u.test(pathname)) return "runner.dispatch";
  if (verb === "GET" && /^\/runs\/[^/]+$/u.test(pathname)) return "runner.run-read";
  if (!/^\/runs\/[^/]+\//u.test(pathname)) return "runner.other";

  const suffix = pathname.slice(pathname.indexOf("/", "/runs/".length));
  if (suffix === "/plan-state-metadata" && verb === "POST") return "runner.plan-metadata";
  if (suffix === "/completion" && verb === "GET") return "runner.completion-read";
  if (suffix === "/mutation-reservation" && verb === "PUT") return "runner.mutation-reservation";
  if (suffix === "/provider-lockfile/restore" && verb === "PUT") return "runner.provider-lock-restore";
  if (suffix === "/source-archive/restore" && verb === "PUT") return "runner.source-archive-restore";
  if (suffix === "/artifacts/tfstate") {
    return verb === "GET" ? "runner.state-read" : verb === "PUT" ? "runner.state-write" : "runner.other";
  }
  if (suffix === "/artifacts/tfplan") {
    return verb === "GET" ? "runner.plan-artifact-read" : verb === "PUT" ? "runner.plan-artifact-write" : "runner.other";
  }
  if (suffix === "/artifacts/source-archive") {
    return verb === "GET" ? "runner.source-archive-read" : verb === "PUT" ? "runner.source-archive-write" : "runner.other";
  }
  if (suffix === "/artifacts/tf-lockfile") {
    return verb === "GET" ? "runner.lockfile-read" : verb === "PUT" ? "runner.lockfile-write" : "runner.other";
  }
  return "runner.other";
}

function notifyRunnerHttpProofObserver(
  observer: RunnerHttpProofObserver | undefined,
  label: RunnerHttpProofLabel,
  phase: RunnerHttpProofEventPhase,
  cause?: unknown,
): void {
  try {
    observer?.(label, phase, cause);
  } catch {
    // Diagnostic observers must never change the proof's request behavior.
  }
}

async function preserveRunnerHttpFailure<T>(
  operation: Promise<T>,
  observer: RunnerHttpProofObserver | undefined,
  label: RunnerHttpProofLabel,
): Promise<T> {
  try {
    return await operation;
  } catch (cause) {
    notifyRunnerHttpProofObserver(observer, label, "failed", cause);
    throw cause;
  }
}

export interface SavedPlanStateMetadataReceipt {
  /** Run ID used by the runner HTTP metadata route (ApplyRun during preflight). */
  readonly runnerRunId: string;
  readonly planDigest: string;
  readonly lineage: string;
  readonly serial: number;
}

export function assertUpdatePlanStateMetadataReceipt(input: {
  readonly runnerRunId: string;
  readonly applyRunPlanRunId: string;
  readonly planRunId: string;
  readonly planArtifact: { readonly kind: string; readonly ref: string; readonly digest: string } | undefined;
  readonly planDigest: string;
  readonly priorStateBytes: Uint8Array;
  readonly receipt: SavedPlanStateMetadataReceipt | undefined;
}): void {
  const prior = parseOpenTofuStateMetadata(input.priorStateBytes);
  const receipt = input.receipt;
  if (
    !prior.lineage || prior.serial < 1 ||
    input.applyRunPlanRunId !== input.planRunId ||
    !input.planArtifact || input.planArtifact.kind !== "runner-local" ||
    input.planArtifact.ref !== `runner-local://${input.planRunId}/tfplan` ||
    input.planArtifact.digest !== input.planDigest ||
    !receipt || receipt.runnerRunId !== input.runnerRunId ||
    receipt.planDigest !== input.planDigest ||
    !Number.isSafeInteger(receipt.serial) || receipt.serial < 0 ||
    !/^sha256:[a-f0-9]{64}$/u.test(receipt.planDigest)
  ) {
    throw new Error("update Plan metadata receipt did not match its canonical prior State");
  }
  try {
    assertSavedPlanMatchesState(
      { lineage: receipt.lineage, serial: receipt.serial },
      prior,
    );
  } catch {
    throw new Error("update Plan metadata receipt did not match its canonical prior State");
  }
}

export function parseProofArgs(args: readonly string[]): { image: string } {
  const values = args[0] === "--" ? args.slice(1) : args;
  if (values.length !== 2 || values[0] !== "--image" || !IMAGE_PATTERN.test(values[1] ?? "")) {
    throw new Error("usage: bun tests/proofs/local-core-http-lifecycle.ts --image sha256:<64 lowercase hex>");
  }
  return { image: values[1]! };
}

export function requireLocalDockerEndpoint(
  selectedHost: string,
  inherited: NodeJS.ProcessEnv,
): string {
  if (Object.entries(inherited).some(([key, value]) => key.startsWith("DOCKER_") && value)) {
    throw new Error("Docker endpoint/config overrides are not accepted by this local proof");
  }
  if (!selectedHost.startsWith("unix://")) {
    throw new Error("selected Docker endpoint is not a local Unix socket");
  }
  const path = selectedHost.slice("unix://".length);
  if (!path.startsWith("/") || path.includes("..") || path.includes("\0")) {
    throw new Error("selected Docker Unix socket path is invalid");
  }
  return path;
}

export function assertRunnerImageDeclaresNonRootUser(user: string): void {
  const principal = user.split(":", 1)[0] ?? "";
  const numericUid = /^\d+$/u.test(principal) ? Number(principal) : undefined;
  assert(
    principal.length > 0 && principal.toLowerCase() !== "root" &&
      !(numericUid !== undefined && numericUid === 0),
    "runner image must declare a non-root user",
  );
}

export async function assertRunnerContainerRunsAsNonRoot(input: {
  readonly containerId: string;
  readonly imageUser: string;
  readonly runDocker: DockerCommand;
}): Promise<void> {
  assertRunnerImageDeclaresNonRootUser(input.imageUser);
  const uidText = await input.runDocker("exec", input.containerId, "id", "-u");
  assert(/^\d+$/u.test(uidText), "runner container effective UID could not be verified");
  const uid = Number(uidText);
  assert(Number.isSafeInteger(uid) && uid > 0, "runner container must execute as a non-root UID");
}

export function assertStateVersionArtifactContinuity(input: {
  readonly listedStateVersion: Pick<PublicStateVersion, "id" | "createdByRunId" | "generation">;
  readonly stateVersion: StateVersion | undefined;
  readonly artifact: Pick<LocalOpenTofuStateArtifact, "stateRef" | "workspaceId" | "environment" | "generation" | "createdByRunId" | "stateDigest" | "stateBytes" | "action"> | undefined;
  readonly expectedRunId: string;
  readonly expectedGeneration: number;
  readonly expectedAction: "apply" | "destroy";
}): void {
  const stateVersion = input.stateVersion;
  const artifact = input.artifact;
  assert(stateVersion, "ledger StateVersion is missing");
  assert.equal(input.listedStateVersion.id, stateVersion.id, "public StateVersion ID differs from ledger ID");
  assert.equal(input.listedStateVersion.createdByRunId, input.expectedRunId);
  assert.equal(input.listedStateVersion.generation, input.expectedGeneration);
  assert.equal(stateVersion.createdByRunId, input.expectedRunId);
  assert.equal(stateVersion.generation, input.expectedGeneration);
  assert.match(stateVersion.digest, IMAGE_PATTERN, "ledger StateVersion digest is invalid");
  assert(artifact && "stateBytes" in artifact, "stored state artifact is missing");
  assert.equal(artifact.stateRef, stateVersion.stateRef, "stored artifact ref differs from ledger");
  assert.equal(artifact.workspaceId, stateVersion.workspaceId);
  assert.equal(artifact.environment, stateVersion.environment);
  assert.equal(artifact.generation, stateVersion.generation);
  assert.equal(artifact.createdByRunId, stateVersion.createdByRunId);
  assert.equal(artifact.stateDigest, stateVersion.digest, "stored artifact digest differs from ledger");
  assert.equal(artifact.action, input.expectedAction, "stored artifact action differs from lifecycle Run");
  const metadata = parseOpenTofuStateMetadata(artifact.stateBytes);
  assert(metadata.lineage.length > 0, "stored artifact has no OpenTofu lineage");
  assert(Number.isSafeInteger(metadata.serial) && metadata.serial > 0, "stored artifact has no valid serial");
}

function childEnv(): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: "/nonexistent",
    LC_ALL: "C",
  };
}

let verifiedDockerHost: string | undefined;
let activeChild: ReturnType<typeof Bun.spawn> | undefined;

async function readCappedBytes(
  stream: ReadableStream<Uint8Array> | null,
  cap: number,
): Promise<Uint8Array> {
  if (!stream) return new Uint8Array();
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > cap) {
        await reader.cancel();
        throw new Error("response exceeded local proof byte cap");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return new Uint8Array(Buffer.concat(chunks));
}

async function readCapped(
  stream: ReadableStream<Uint8Array> | null,
  cap = MAX_COMMAND_OUTPUT,
): Promise<string> {
  return new TextDecoder().decode(await readCappedBytes(stream, cap));
}

export function boundedRunnerFetch(
  baseUrl: string,
  originalFetch: typeof fetch,
  signal?: AbortSignal,
  onSavedPlanMetadataReceipt?: (receipt: SavedPlanStateMetadataReceipt) => void,
  onRunDispatch?: (runId: string) => void,
  onProofEvent?: RunnerHttpProofObserver,
): typeof fetch {
  const runnerOrigin = new URL(baseUrl).origin;
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== runnerOrigin) throw new Error("local proof refused an external HTTP destination");
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const label = runnerHttpProofLabel(method, url.pathname);
    notifyRunnerHttpProofObserver(onProofEvent, label, "start");
    const runDispatch = /^\/runs\/([^/]+)$/u.exec(url.pathname);
    if (method.toUpperCase() === "POST" && runDispatch && onRunDispatch) {
      onRunDispatch(decodeURIComponent(runDispatch[1]!));
    }
    const signals = [AbortSignal.timeout(HTTP_TIMEOUT_MS)];
    if (init?.signal) signals.push(init.signal);
    if (signal) signals.push(signal);
    const response = await preserveRunnerHttpFailure(
      originalFetch(input, {
        ...init,
        signal: AbortSignal.any(signals),
      }),
      onProofEvent,
      label,
    );
    const maxBytes = url.pathname.includes("/artifacts/")
      ? MAX_RUNNER_ARTIFACT_BYTES
      : MAX_RUNNER_RESPONSE_BYTES;
    const declaredLength = response.headers.get("content-length");
    if (declaredLength !== null && Number(declaredLength) > maxBytes) {
      if (response.body) {
        await preserveRunnerHttpFailure(response.body.cancel(), onProofEvent, label);
      }
      const cause = new Error("runner response exceeded local proof byte cap");
      notifyRunnerHttpProofObserver(onProofEvent, label, "failed", cause);
      throw cause;
    }
    const bytes = await preserveRunnerHttpFailure(
      readCappedBytes(response.body, maxBytes),
      onProofEvent,
      label,
    );
    const metadataRoute = /^\/runs\/([^/]+)\/plan-state-metadata$/u.exec(url.pathname);
    if (method.toUpperCase() === "POST" && response.ok && metadataRoute && onSavedPlanMetadataReceipt) {
      try {
        const headers = new Headers(input instanceof Request ? input.headers : undefined);
        new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
        const value = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
        const planDigest = headers.get("x-takosumi-plan-digest");
        if (
          typeof value.lineage === "string" &&
          Number.isSafeInteger(value.serial) &&
          (value.serial as number) >= 0 &&
          typeof planDigest === "string"
        ) {
          onSavedPlanMetadataReceipt({
            runnerRunId: decodeURIComponent(metadataRoute[1]!),
            planDigest,
            lineage: value.lineage,
            serial: value.serial as number,
          });
        }
      } catch {
        // The runner adapter remains responsible for rejecting invalid receipts.
        // A missing captured receipt makes the proof fail its explicit assertion.
      }
    }
    const boundedResponse = new Response(response.status === 204 || response.status === 304 ? null : new Uint8Array(bytes), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
    notifyRunnerHttpProofObserver(onProofEvent, label, "completed");
    return boundedResponse;
  }) as typeof fetch;
}

async function command(
  argv: readonly string[],
  options: { cwd?: string; timeoutMs?: number; env?: Record<string, string> } = {},
): Promise<string> {
  const child = Bun.spawn([...argv], {
    cwd: options.cwd,
    env: options.env ?? childEnv(),
    stdout: "pipe",
    stderr: "pipe",
  });
  activeChild = child;
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, options.timeoutMs ?? COMMAND_TIMEOUT_MS);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      readCapped(child.stdout),
      readCapped(child.stderr),
      child.exited,
    ]);
    if (exitCode !== 0) {
      // Docker and tar diagnostics can include paths or environment details.
      throw createDockerCommandFailure(argv, exitCode, stderr, { timedOut });
    }
    return stdout.trim();
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null) {
      child.kill("SIGKILL");
      await child.exited;
    }
    if (activeChild === child) activeChild = undefined;
  }
}

async function docker(...args: string[]): Promise<string> {
  assert(verifiedDockerHost, "Docker endpoint must be verified first");
  return await command(["docker", ...args], {
    env: { ...childEnv(), DOCKER_HOST: verifiedDockerHost },
  });
}

type DockerCommand = (...args: string[]) => Promise<string>;

async function containerIdAtName(name: string, runDocker: DockerCommand): Promise<string | undefined> {
  const observed = await runDocker(
    "ps", "--all", "--filter", `name=^/${name}$`, "--format", "{{.ID}}",
  );
  if (!observed) return undefined;
  const ids = observed.split("\n");
  if (ids.length !== 1 || !/^[a-f0-9]{12,64}$/u.test(ids[0]!)) {
    throw new Error("proof container name resolves ambiguously");
  }
  return ids[0];
}

/** Resolve name only for discovery; mutation always uses the inspected ID. */
async function ownedContainerId(input: {
  name: string;
  ownerNonce: string;
  image: string;
  runDocker: DockerCommand;
}): Promise<string | undefined> {
  const candidate = await containerIdAtName(input.name, input.runDocker);
  if (!candidate) return undefined;
  const record = await input.runDocker(
    "container", "inspect", candidate,
    "--format", `{{.Id}}|{{.Image}}|{{index .Config.Labels "${OWNER_LABEL}"}}|{{.Name}}`,
  );
  const [id, image, ownerNonce, name, extra] = record.split("|");
  if (
    extra !== undefined || !/^[a-f0-9]{64}$/u.test(id ?? "") ||
    image !== input.image || ownerNonce !== input.ownerNonce ||
    name !== `/${input.name}` || !id?.startsWith(candidate)
  ) {
    throw new Error("proof container name belongs to another owner; refusing removal");
  }
  return id;
}

export async function cleanupOwnedContainer(input: {
  name: string;
  ownerNonce: string;
  image: string;
  runDocker: DockerCommand;
}): Promise<void> {
  const id = await ownedContainerId(input);
  if (!id) return;
  await input.runDocker("rm", "--force", id);
  const remaining = await containerIdAtName(input.name, input.runDocker);
  if (remaining) throw new Error("owned proof container survived cleanup");
}

async function startRunner(
  image: string,
  name: string,
  ownerNonce: string,
  onStarting: () => void,
  signal: AbortSignal,
  localPreparationV2 = false,
): Promise<string> {
  // Inspect the user's selected context without connecting to a daemon. All
  // subsequent Docker calls use only the verified local Unix endpoint.
  const contextEnv = { ...childEnv(), HOME: process.env.HOME ?? "/nonexistent" };
  const selectedContext = await command(["docker", "context", "show"], { env: contextEnv });
  const selectedHost = await command([
    "docker", "context", "inspect", selectedContext,
    "--format", "{{.Endpoints.docker.Host}}",
  ], { env: contextEnv });
  const socket = requireLocalDockerEndpoint(selectedHost, process.env);
  assert((await stat(socket)).isSocket(), "selected Docker endpoint must be a Unix socket");
  verifiedDockerHost = selectedHost;

  const inspected = await docker("image", "inspect", image, "--format", "{{.Id}} {{.Config.User}}");
  const [actualId, user] = inspected.split(" ");
  assert.equal(actualId, image, "local image ID differs from explicit --image");
  assertRunnerImageDeclaresNonRootUser(user ?? "");
  assert.equal(await containerIdAtName(name, docker), undefined, "proof container name is occupied");

  onStarting();
  const launchedId = await docker(
    "run", "--detach", "--pull=never", "--name", name,
    "--label", `${OWNER_LABEL}=${ownerNonce}`,
    "--publish", "127.0.0.1::8080",
    "--network", "bridge",
    "--read-only",
    "--tmpfs", "/tmp:rw,nosuid,nodev,mode=1777,size=128m",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--pids-limit", "128",
    "--memory", "512m",
    "--cpus", "1",
    "--env", "TAKOSUMI_RUNNER_MUTATION_CUSTODY_MODE=local-http",
    image,
    ...(localPreparationV2 ? ["--local-preparation-v2-supervisor"] : []),
  );
  assert.match(launchedId, /^[a-f0-9]{64}$/u, "Docker run did not return an immutable ID");
  assert.equal(
    await ownedContainerId({ name, ownerNonce, image, runDocker: docker }),
    launchedId,
    "Docker run returned an unowned or changed container",
  );
  await assertRunnerContainerRunsAsNonRoot({
    containerId: launchedId,
    imageUser: user!,
    runDocker: docker,
  });
  const binding = await docker("port", name, "8080/tcp");
  assert.match(binding, /^127\.0\.0\.1:[0-9]+$/u, "runner port must bind loopback only");
  const baseUrl = `http://${binding}`;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (signal.aborted) throw new Error("runner startup interrupted");
    try {
      const response = await fetch(`${baseUrl}/healthz`, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(2_000)]),
      });
      if (response.ok) return baseUrl;
      await response.body?.cancel();
    } catch {
      // Startup is bounded by the deadline below.
    }
    await Bun.sleep(250);
  }
  throw new Error("runner health did not become ready within 20 seconds");
}

export interface LocalCoreHttpRunnerHandle {
  readonly baseUrl: string;
  /** Same verified local Docker endpoint used to own the HTTP runner container. */
  readonly runDocker: (args: readonly string[]) => Promise<string>;
}

/** Reuses the proof's exact runner-image, endpoint, ownership, and cleanup boundary. */
export async function withLocalCoreHttpRunner<T>(input: {
  readonly image: string;
  readonly signal: AbortSignal;
  /** Selects only the existing private-v2 supervisor entrypoint for this proof. */
  readonly localPreparationV2?: boolean;
  readonly run: (runner: LocalCoreHttpRunnerHandle) => Promise<T>;
}): Promise<T> {
  const containerName = `takosumi-core-http-${process.pid}-${randomUUID().slice(0, 8)}`;
  const ownerNonce = randomUUID();
  let containerAttempted = false;
  return await runWithCleanup(
    async () => {
      const baseUrl = await startRunner(
        input.image,
        containerName,
        ownerNonce,
        () => { containerAttempted = true; },
        input.signal,
        input.localPreparationV2 ?? false,
      );
      return await input.run({
        baseUrl,
        runDocker: (args) => docker(...args),
      });
    },
    async () => {
      if (containerAttempted) {
        await cleanupOwnedContainer({
          name: containerName,
          ownerNonce,
          image: input.image,
          runDocker: docker,
        });
      }
    },
    "runner.cleanup",
  );
}

type Operations = Awaited<ReturnType<typeof createTakosumiService>>["operations"];

export interface LocalCoreHttpProofRuntime {
  readonly store: OpenTofuControlStore;
  readonly operations?: Operations;
  readonly controlRequest?: (request: Request) => Promise<Response>;
}

export interface LocalCoreHttpProofRuntimeInput {
  readonly baseUrl: string;
  readonly archiveStore: ReturnType<typeof createFileSourceArchiveStore>;
  readonly stateStore: ReturnType<typeof createFileOpenTofuStateArtifactStore>;
  readonly profile: ReturnType<typeof createLocalOpenTofuRunnerProfile>;
  readonly artifactRoot: string;
  readonly artifactEncryptionPassphrase: string;
  readonly syntheticSessionIds: LocalCoreHttpProofSyntheticSessions;
  readonly fetchImpl: typeof fetch;
  readonly onRunDispatch: (runId: string) => void;
  readonly onSavedPlanMetadataReceipt: (receipt: SavedPlanStateMetadataReceipt) => void;
  readonly observeRunnerHttp: RunnerHttpProofObserver;
}

export interface LocalCoreHttpProofSyntheticSessions {
  readonly actor: string;
  readonly foreignActor: string;
  readonly createdAt: number;
  readonly expiresAt: number;
}

/** Recreates only the explicitly synthetic in-memory identities for a proof process. */
export function createLocalCoreHttpProofAccounts(
  sessions: LocalCoreHttpProofSyntheticSessions,
  includeForeignActor = true,
): InMemoryAccountsStore {
  const accounts = new InMemoryAccountsStore();
  accounts.saveAccount({
    subject: ACTOR,
    email: "local-core-http@example.test",
    displayName: "Local Core HTTP Proof",
    createdAt: sessions.createdAt,
    updatedAt: sessions.createdAt,
  });
  accounts.saveAccountSession({
    sessionId: sessions.actor,
    subject: ACTOR,
    createdAt: sessions.createdAt,
    expiresAt: sessions.expiresAt,
  });
  if (includeForeignActor) {
    accounts.saveAccount({
      subject: FOREIGN_ACTOR,
      email: "foreign-core-http@example.test",
      displayName: "Foreign Proof User",
      createdAt: sessions.createdAt,
      updatedAt: sessions.createdAt,
    });
    accounts.saveAccountSession({
      sessionId: sessions.foreignActor,
      subject: FOREIGN_ACTOR,
      createdAt: sessions.createdAt,
      expiresAt: sessions.expiresAt,
    });
  }
  return accounts;
}

export interface LocalCoreHttpProofHooks {
  /** Creates a fresh Core runtime after the caller's restart boundary. */
  readonly createRuntime: (
    input: LocalCoreHttpProofRuntimeInput,
  ) => Promise<LocalCoreHttpProofRuntime>;
  /** Called after generation one is fully observed, before reopening Core. */
  readonly afterInitialApply: () => Promise<void>;
  /** Optional fixed-label request events; never receives URL, request data, or IDs. */
  readonly observeRunnerHttp?: RunnerHttpProofObserver;
}

/** The next Core factory is reached only after the current SQL boundary closes and restarts. */
export async function reopenCoreRuntimeAfterRestart<T>(input: {
  readonly afterInitialApply: () => Promise<void>;
  readonly createRuntime: () => Promise<T>;
}): Promise<T> {
  await input.afterInitialApply();
  return await input.createRuntime();
}

export function assertNoAdditionalRunnerDispatches(
  beforeReplay: readonly string[],
  afterReplay: readonly string[],
): void {
  assert.deepEqual(
    afterReplay,
    beforeReplay,
    "replaying the applied Plan dispatched another real runner execution",
  );
}

async function control<T>(
  runtime: LocalCoreHttpProofRuntime,
  accounts: InMemoryAccountsStore,
  cookie: string,
  method: string,
  path: string,
  expectedStatus: number,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<T> {
  const url = new URL(path, ORIGIN);
  const request = new Request(url, {
    method,
    headers: {
      cookie,
      ...headers,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  const response = runtime.controlRequest
    ? await runtime.controlRequest(request)
    : runtime.operations
    ? await handleControlRoute({ request, url, store: accounts, operations: runtime.operations })
    : undefined;
  assert(response, `no control route for ${method} ${path}`);
  const text = await readCapped(response.body, 64 * 1024);
  const payload = JSON.parse(text) as {
    error?: { code?: string; details?: { reason?: string } };
  };
  if (response.status !== expectedStatus) {
    throw new Error(
      `${method} ${path} returned ${response.status}, expected ${expectedStatus}; code=${payload.error?.code ?? "none"}; reason=${payload.error?.details?.reason ?? "none"}`,
    );
  }
  return payload as T;
}

async function makeArchive(root: string): Promise<{ bytes: Uint8Array; digest: string }> {
  const moduleDir = join(root, "module");
  await command(["mkdir", "-m", "700", moduleDir]);
  await writeFile(join(moduleDir, "main.tf"), `
terraform { required_version = ">= 1.0" }
variable "message" { type = string }
output "launch_url" { value = "https://\${var.message}.example.test" }
`);
  const archive = join(root, "source.tar.zst");
  await command([
    "tar", "--sort=name", "--mtime=@0", "--owner=0", "--group=0",
    "--numeric-owner", "--zstd", "-cf", archive, "-C", moduleDir, ".",
  ]);
  const bytes = new Uint8Array(await readFile(archive));
  assert(bytes.byteLength > 0 && bytes.byteLength < 1024 * 1024);
  return { bytes, digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}` };
}

export async function prove(
  baseUrl: string,
  image: string,
  root: string,
  signal?: AbortSignal,
  hooks?: LocalCoreHttpProofHooks,
): Promise<{
  kind: "takosumi.local-core-http-lifecycle-proof/v2";
  status: "passed";
  image: string;
  source: string;
  publicRouteLifecycle: readonly string[];
  stateGenerations: readonly number[];
  negativeControl: string;
  savedPlanStateMetadata: "passed";
  updatePlanPriorStateMetadata: "matched";
}> {
  const originalFetch = globalThis.fetch;
  const metadataReceipts: SavedPlanStateMetadataReceipt[] = [];
  const runnerDispatches: string[] = [];
  globalThis.fetch = boundedRunnerFetch(
    baseUrl,
    originalFetch,
    signal,
    (receipt) => { metadataReceipts.push(receipt); },
    hooks ? (runId) => { runnerDispatches.push(runId); } : undefined,
    hooks?.observeRunnerHttp,
  );
  try {
    if (Boolean(hooks) !== Boolean(hooks?.createRuntime && hooks.afterInitialApply)) {
      throw new TypeError("local Core HTTP proof restart hooks must be supplied together");
    }
    const now = Date.now();
    const sessionIds: LocalCoreHttpProofSyntheticSessions = {
      actor: `sess_local_core_http_${randomUUID().replaceAll("-", "")}`,
      foreignActor: `sess_foreign_core_http_${randomUUID().replaceAll("-", "")}`,
      createdAt: now,
      expiresAt: now + 180_000,
    };
    const accounts = createLocalCoreHttpProofAccounts(sessionIds, Boolean(hooks));
    const sessionId = sessionIds.actor;
    const foreignSessionId = sessionIds.foreignActor;
    const cookie = `${ACCOUNT_SESSION_COOKIE_NAME}=${sessionId}`;
    const artifactEncryptionPassphrase = randomUUID() + randomUUID();
    const cryptoBoundary = new PartitionedSecretBoundaryCrypto({
      globalPassphrase: artifactEncryptionPassphrase,
    });
    const archiveStore = createFileSourceArchiveStore(join(root, "archives"));
    const stateStore = createFileOpenTofuStateArtifactStore(join(root, "state"), cryptoBoundary);
    const profile = createLocalOpenTofuRunnerProfile();
    const openRuntime = async (): Promise<LocalCoreHttpProofRuntime> => {
      if (hooks) {
        return await hooks.createRuntime({
          baseUrl,
          archiveStore,
          stateStore,
          profile,
          artifactRoot: root,
          artifactEncryptionPassphrase,
          syntheticSessionIds: sessionIds,
          fetchImpl: originalFetch,
          onRunDispatch: (runId) => { runnerDispatches.push(runId); },
          onSavedPlanMetadataReceipt: (receipt) => { metadataReceipts.push(receipt); },
          observeRunnerHttp: hooks.observeRunnerHttp ?? (() => {}),
        });
      }
      const store = new InMemoryOpenTofuControlStore();
      const { operations } = await createTakosumiService({
        role: "takosumi-api",
        runtimeEnv: { TAKOSUMI_DEV_MODE: "1" },
        opentofuControlStore: store,
        opentofuRunner: createHttpOpenTofuRunner({ archiveStore, stateStore, baseUrl }),
        runnerProfiles: [profile],
        defaultRunnerProfileId: profile.id,
        artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
        executionEvidenceAuthority: FIXTURE_EXECUTION_EVIDENCE_AUTHORITY,
      });
      return { store, operations };
    };
    let runtime = await openRuntime();
    let store = runtime.store;
    if (!runtime.operations && !runtime.controlRequest) {
      throw new TypeError("local Core HTTP proof runtime has no route transport");
    }
    const seeded = await seedCapsuleModel(store, {
      workspaceId: "ws_core_http_proof",
      capsuleId: "cap_core_http_proof",
      sourceId: "src_core_http_proof",
      snapshotId: "snap_core_http_proof",
      installConfigId: "icfg_core_http_proof",
      name: "core-http-proof",
      installConfig: {
        variableMapping: { message: "first" },
        outputAllowlist: { launch_url: { from: "launch_url", type: "url" } },
        internal: {
          reason: "per_install_overrides",
          genericOpenTofuSourceSnapshotId: "snap_core_http_proof",
          genericOpenTofuVariableContractDigest:
            await genericOpenTofuVariableContractDigest({
              modulePath: ".",
              declarations: [{ name: "message", type: "string", hasDefault: false }],
            }),
        },
      },
    });
    await store.putWorkspace({ ...seeded.workspace, ownerUserId: ACTOR });
    const archive = await makeArchive(root);
    const snapshot: SourceSnapshot = {
      ...seeded.snapshot,
      archiveRef:
        `workspaces/${seeded.workspace.id}/sources/${seeded.source.id}/snapshots/${seeded.snapshot.id}/source.tar.zst`,
      archiveDigest: archive.digest,
      archiveSizeBytes: archive.bytes.byteLength,
      repositoryInstallMetadata: { status: "absent" },
      repositoryManifest: { status: "absent" },
      repositoryModules: {
        status: "ready",
        scopePath: ".",
        modules: [{ path: ".", providerPackages: [], rootProviderRequirements: [] }],
      },
    };
    await store.putSourceSnapshot(snapshot);
    await archiveStore.write(snapshot.archiveRef, archive.bytes);
    const report: CapsuleCompatibilityReport = {
      id: "caprep_core_http_proof",
      sourceId: seeded.source.id,
      sourceSnapshotId: snapshot.id,
      capsuleId: seeded.capsule.id,
      modulePath: ".",
      level: "ready",
      findings: [],
      providerPackages: [],
      rootProviderRequirements: [],
      resources: [],
      dataSources: [],
      provisioners: [],
      rootModuleVariables: ["message"],
      rootModuleVariableDeclarations: [{ name: "message", type: "string", hasDefault: false }],
      rootModuleOutputs: [{ name: "launch_url", sensitive: false, ephemeral: false }],
      createdAt: new Date().toISOString(),
    };
    await store.putCapsuleCompatibilityReport(report);
    await store.putCapsule({
      ...seeded.capsule,
      compatibilityReportId: report.id,
      compatibilityStatus: "ready",
      installingPrincipalId: ACTOR,
    });
    const cap = seeded.capsule.id;
    type PublicRun = { run: { id: string; status: string; planDigest?: string } };
    const planned = await control<PublicRun>(
      runtime, accounts, cookie, "POST", `/api/v1/capsules/${cap}/plan`, 201,
    );
    assert.equal(planned.run.status, "succeeded");
    assert.match(planned.run.planDigest ?? "", IMAGE_PATTERN);
    const before = await control<{ output: unknown }>(
      runtime, accounts, cookie, "GET", `/api/v1/capsules/${cap}/outputs`, 200,
    );
    assert.equal(before.output, null);

    // Negative control: a foreign Workspace session cannot apply this Plan.
    if (!hooks) {
      accounts.saveAccount({
        subject: FOREIGN_ACTOR,
        email: "foreign-core-http@example.test",
        displayName: "Foreign Proof User",
        createdAt: now,
        updatedAt: now,
      });
      accounts.saveAccountSession({
        sessionId: foreignSessionId,
        subject: FOREIGN_ACTOR,
        createdAt: now,
        expiresAt: sessionIds.expiresAt,
      });
    }
    await control(
      runtime, accounts, `${ACCOUNT_SESSION_COOKIE_NAME}=${foreignSessionId}`,
      "POST", `/api/v1/runs/${planned.run.id}/apply`, 403,
    );
    assert.equal((await store.getCapsule(cap))?.currentStateGeneration, 0);
    const first = await control<{ run: { id: string; status: string } }>(
      runtime, accounts, cookie, "POST", `/api/v1/runs/${planned.run.id}/apply`, 201,
    );
    if (first.run.status !== "succeeded") {
      throw new Error(`first apply ended with ${first.run.status}`);
    }
    assert.equal(first.run.status, "succeeded");
    const firstState = await control<{ stateVersions: Array<Pick<PublicStateVersion, "id" | "createdByRunId" | "generation">> }>(
      runtime, accounts, cookie, "GET", `/api/v1/capsules/${cap}/state-versions`, 200,
    );
    assert.equal(firstState.stateVersions.length, 1);
    const firstListedState = firstState.stateVersions[0]!;
    assert.equal(firstListedState.createdByRunId, first.run.id);
    assert.equal(firstListedState.generation, 1);
    const firstStateVersion = await store.getStateVersion(firstListedState.id);
    assert(firstStateVersion, "generation one is missing from the StateVersion store");
    const firstStateArtifact = await stateStore.read(firstStateVersion.stateRef);
    assertStateVersionArtifactContinuity({
      listedStateVersion: firstListedState,
      stateVersion: firstStateVersion,
      artifact: firstStateArtifact && "stateBytes" in firstStateArtifact && firstStateArtifact.action !== "state_recovery"
        ? firstStateArtifact
        : undefined,
      expectedRunId: first.run.id,
      expectedGeneration: 1,
      expectedAction: "apply",
    });
    assert(firstStateArtifact && "stateBytes" in firstStateArtifact);
    const firstStateMetadata: OpenTofuStateMetadata = parseOpenTofuStateMetadata(
      firstStateArtifact.stateBytes,
    );
    assert(firstStateMetadata.lineage.length > 0);
    assert(firstStateMetadata.serial > 0);
    const firstOutput = await control<{ output: { publicOutputs: Record<string, unknown> } }>(
      runtime, accounts, cookie, "GET", `/api/v1/capsules/${cap}/outputs`, 200,
    );
    assert.equal(firstOutput.output.publicOutputs.launch_url, "https://first.example.test");

    if (hooks) {
      assert.equal(
        runnerDispatches.filter((runId) => runId === first.run.id).length,
        1,
        "generation one did not produce exactly one real runner Apply dispatch",
      );
      runtime = await reopenCoreRuntimeAfterRestart({
        afterInitialApply: hooks.afterInitialApply,
        createRuntime: openRuntime,
      });
      store = runtime.store;

      const dispatchesBeforeReplay = [...runnerDispatches];
      const replay = await control<{ run: { id: string; status: string } }>(
        runtime,
        accounts,
        cookie,
        "POST",
        `/api/v1/runs/${planned.run.id}/apply`,
        201,
      );
      assert.deepEqual(replay.run, first.run, "replayed public Apply changed the original Run result");
      assertNoAdditionalRunnerDispatches(dispatchesBeforeReplay, runnerDispatches);

      const recoveredState = await control<{
        stateVersions: Array<Pick<PublicStateVersion, "id" | "createdByRunId" | "generation">>;
      }>(runtime, accounts, cookie, "GET", `/api/v1/capsules/${cap}/state-versions`, 200);
      assert.deepEqual(recoveredState.stateVersions, firstState.stateVersions);
      const recoveredOutput = await control<{
        output: { publicOutputs: Record<string, unknown> };
      }>(runtime, accounts, cookie, "GET", `/api/v1/capsules/${cap}/outputs`, 200);
      assert.deepEqual(recoveredOutput.output, firstOutput.output);
      const recoveredStateVersion = await store.getStateVersion(firstListedState.id);
      assert(recoveredStateVersion, "fresh Core lost the generation-one StateVersion ledger row");
      assert.equal(recoveredStateVersion.id, firstStateVersion.id);
      assert.equal(recoveredStateVersion.createdByRunId, first.run.id);
      assert.equal(recoveredStateVersion.generation, 1);
      const recoveredArtifact = await stateStore.read(recoveredStateVersion.stateRef);
      assert(recoveredArtifact && "stateBytes" in recoveredArtifact);
      assert.deepEqual(recoveredArtifact.stateBytes, firstStateArtifact.stateBytes);
      assertStateVersionArtifactContinuity({
        listedStateVersion: firstListedState,
        stateVersion: recoveredStateVersion,
        artifact: recoveredArtifact.action !== "state_recovery" ? recoveredArtifact : undefined,
        expectedRunId: first.run.id,
        expectedGeneration: 1,
        expectedAction: "apply",
      });
    }

    const detail = await control<{ installConfigReAdoption: { authorityGuard: string } }>(
      runtime, accounts, cookie, "GET", `/api/v1/capsules/${cap}`, 200,
    );
    const providerBindingSet = await runtime.store.getProviderBindingSetByCapsule(
      cap,
      seeded.capsule.environment,
    );
    assert(providerBindingSet, "provider-free fixture lost its persisted ProviderBindingSet");
    assert.deepEqual(providerBindingSet.bindings, [], "provider-free fixture unexpectedly acquired Provider bindings");
    const updated = await control<{ configurationPlan: { planRunId: string } }>(
      runtime, accounts, cookie, "POST", `/api/v1/capsules/${cap}/configuration-plans`, 201,
      {
        variablePatch: { set: { message: "second" }, remove: [] },
        providerBindings: providerBindingSet.bindings,
        interfaceBlueprints: [],
        expected: { authorityGuard: detail.installConfigReAdoption.authorityGuard },
      },
      { "idempotency-key": "local-core-http-update" },
    );
    const unchanged = await control<{ output: { publicOutputs: Record<string, unknown> } }>(
      runtime, accounts, cookie, "GET", `/api/v1/capsules/${cap}/outputs`, 200,
    );
    assert.equal(unchanged.output.publicOutputs.launch_url, "https://first.example.test");
    assert.equal((await store.getCapsule(cap))?.currentStateGeneration, 1);
    const second = await control<{ run: { id: string; status: string } }>(
      runtime, accounts, cookie, "POST",
      `/api/v1/runs/${updated.configurationPlan.planRunId}/apply`, 201,
    );
    assert.equal(second.run.status, "succeeded");
    const updatePlanRun = await store.getPlanRun(updated.configurationPlan.planRunId);
    assert(updatePlanRun?.planDigest);
    assert.equal(updatePlanRun.id, updated.configurationPlan.planRunId);
    assert(updatePlanRun.planArtifact, "update PlanRun has no saved Plan artifact");
    const updateApplyRun = await store.getApplyRun(second.run.id);
    assert(updateApplyRun, "update ApplyRun is missing from the Core ledger");
    assert.equal(updateApplyRun.planRunId, updatePlanRun.id);
    const updateReceipts = metadataReceipts.filter(
      (receipt) => receipt.runnerRunId === second.run.id,
    );
    assert.equal(updateReceipts.length, 1, "update ApplyRun did not produce exactly one metadata receipt");
    const updateReceipt = updateReceipts[0]!;
    assertUpdatePlanStateMetadataReceipt({
      runnerRunId: second.run.id,
      applyRunPlanRunId: updateApplyRun.planRunId,
      planRunId: updatePlanRun.id,
      planArtifact: updatePlanRun.planArtifact,
      planDigest: updatePlanRun.planDigest,
      priorStateBytes: firstStateArtifact.stateBytes,
      receipt: updateReceipt,
    });
    const secondOutput = await control<{ output: { publicOutputs: Record<string, unknown> } }>(
      runtime, accounts, cookie, "GET", `/api/v1/capsules/${cap}/outputs`, 200,
    );
    assert.equal(secondOutput.output.publicOutputs.launch_url, "https://second.example.test");
    const secondState = await control<{ stateVersions: Array<Pick<PublicStateVersion, "id" | "createdByRunId" | "generation">> }>(
      runtime, accounts, cookie, "GET", `/api/v1/capsules/${cap}/state-versions`, 200,
    );
    assert.equal(secondState.stateVersions.length, 2);
    const secondListedState = secondState.stateVersions.find((state) => state.createdByRunId === second.run.id);
    assert(secondListedState, "generation two is not present in the public StateVersion ledger");
    const secondStateVersion = await store.getStateVersion(secondListedState.id);
    const secondStateArtifact = secondStateVersion
      ? await stateStore.read(secondStateVersion.stateRef)
      : undefined;
    assertStateVersionArtifactContinuity({
      listedStateVersion: secondListedState,
      stateVersion: secondStateVersion,
      artifact: secondStateArtifact && "stateBytes" in secondStateArtifact && secondStateArtifact.action !== "state_recovery"
        ? secondStateArtifact
        : undefined,
      expectedRunId: second.run.id,
      expectedGeneration: 2,
      expectedAction: "apply",
    });

    const destroyPlan = await control<PublicRun>(
      runtime, accounts, cookie, "POST", `/api/v1/capsules/${cap}/destroy-plan`, 201,
    );
    assert.equal(destroyPlan.run.status, "waiting_approval");
    const approved = await control<PublicRun>(
      runtime, accounts, cookie, "POST", `/api/v1/runs/${destroyPlan.run.id}/approve`, 200,
      { reason: "local provider-free proof" },
    );
    assert.equal(approved.run.status, "succeeded");
    const destroyed = await control<{ run: { id: string; status: string } }>(
      runtime, accounts, cookie, "POST", `/api/v1/runs/${destroyPlan.run.id}/apply`, 201,
    );
    assert.equal(destroyed.run.status, "succeeded");
    const finalOutput = await control<{ output: unknown }>(
      runtime, accounts, cookie, "GET", `/api/v1/capsules/${cap}/outputs`, 200,
    );
    assert.equal(finalOutput.output, null);
    const finalCapsule = await store.getCapsule(cap);
    assert.equal(finalCapsule?.status, "destroyed");
    assert.equal(finalCapsule?.currentStateGeneration, 3);
    const finalState = await control<{
      stateVersions: Array<Pick<PublicStateVersion, "id" | "createdByRunId" | "generation">>;
    }>(runtime, accounts, cookie, "GET", `/api/v1/capsules/${cap}/state-versions`, 200);
    assert.equal(finalState.stateVersions.length, 3, "lifecycle did not persist all three StateVersion rows");
    const destroyedListedState = finalState.stateVersions.find(
      (state) => state.createdByRunId === destroyed.run.id,
    );
    assert(destroyedListedState, "destroy StateVersion is not present in the public ledger");
    const destroyedStateVersion = await store.getStateVersion(destroyedListedState.id);
    const destroyedStateArtifact = destroyedStateVersion
      ? await stateStore.read(destroyedStateVersion.stateRef)
      : undefined;
    assertStateVersionArtifactContinuity({
      listedStateVersion: destroyedListedState,
      stateVersion: destroyedStateVersion,
      artifact: destroyedStateArtifact && "stateBytes" in destroyedStateArtifact && destroyedStateArtifact.action !== "state_recovery"
        ? destroyedStateArtifact
        : undefined,
      expectedRunId: destroyed.run.id,
      expectedGeneration: 3,
      expectedAction: "destroy",
    });
    const verifiedStateGenerations = finalState.stateVersions
      .map((state) => state.generation)
      .sort((left, right) => left - right);
    assert.deepEqual(verifiedStateGenerations, [1, 2, 3]);
    assert.deepEqual(
      finalState.stateVersions
        .map(({ id, createdByRunId, generation }) => ({ id, createdByRunId, generation }))
        .sort((left, right) => left.generation - right.generation),
      [
        { id: firstListedState.id, createdByRunId: first.run.id, generation: 1 },
        { id: secondListedState.id, createdByRunId: second.run.id, generation: 2 },
        { id: destroyedListedState.id, createdByRunId: destroyed.run.id, generation: 3 },
      ],
      "final StateVersion ledger identities differ from verified lifecycle Runs",
    );
    const firstPlanRow = await store.getPlanRun(planned.run.id);
    const updatePlanRow = await store.getPlanRun(updated.configurationPlan.planRunId);
    const destroyPlanRow = await store.getPlanRun(destroyPlan.run.id);
    for (const plan of [firstPlanRow, updatePlanRow, destroyPlanRow]) {
      assert.equal(plan?.sourceSnapshotId, snapshot.id);
      assert.match(plan.planDigest ?? "", IMAGE_PATTERN);
    }
    for (const id of [first.run.id, second.run.id, destroyed.run.id]) {
      const applied = await store.getApplyRun(id);
      assert.equal(applied?.status, "succeeded");
      assert((applied?.auditEvents.length ?? 0) > 0, "terminal run has no audit evidence");
    }
    return {
      kind: "takosumi.local-core-http-lifecycle-proof/v2",
      status: "passed",
      image,
      source: "fixture SourceSnapshot with exact local archive; post-source-sync only",
      publicRouteLifecycle: ["plan", "apply", "configuration-plan", "apply", "destroy-plan", "approve", "destroy"],
      stateGenerations: verifiedStateGenerations,
      negativeControl: "foreign-workspace-apply-rejected-before-mutation",
      savedPlanStateMetadata: "passed",
      updatePlanPriorStateMetadata: "matched",
    };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

/** A passing marker is published only after all owned cleanup has succeeded. */
export async function runAndEmitAfterCleanup<T>(
  work: () => Promise<T>,
  cleanup: () => Promise<void>,
  emit: (result: T) => void,
): Promise<void> {
  const result = await runWithCleanup(work, cleanup, "proof.cleanup");
  emit(result);
}

function safeProofErrorName(error: unknown): string {
  if (!(error instanceof Error)) return "UnknownError";
  return SAFE_PROOF_ERROR_NAMES.has(error.name) ? error.name : "OtherError";
}

function safeProofSourceLocation(error: unknown): string {
  if (!(error instanceof Error) || !error.stack) return "source-location-unavailable";
  if (error.message.includes("\n") || error.message.includes("\r")) {
    return "source-location-unavailable";
  }
  for (const frame of error.stack.split("\n").slice(1)) {
    if (!/^\s+at\b/u.test(frame)) continue;
    const match = /^\s+at\b.*?(local-core-http-lifecycle\.ts):([1-9][0-9]{0,5}):[1-9][0-9]{0,5}\)?$/u.exec(frame);
    if (match) return `${match[1]}:${match[2]}`;
  }
  return "source-location-unavailable";
}

function safeProofErrorSummary(error: unknown): string {
  return `${safeProofErrorName(error)}@${safeProofSourceLocation(error)}`;
}

/** Fixed-label CLI diagnostic that never includes error messages or command output. */
export function formatLocalCoreHttpProofFailure(
  phase: LocalCoreHttpProofPhase,
  error: unknown,
): string {
  if (
    error instanceof AggregateError &&
    error.message === "proof work and cleanup both failed" &&
    error.errors.length === 2
  ) {
    return [
      `local Core HTTP proof failed at ${phase}: failure=work-and-cleanup`,
      `primary=${safeProofErrorSummary(error.errors[0])}`,
      `cleanup=${safeProofErrorSummary(error.errors[1])}`,
    ].join(" ");
  }
  const location = safeProofSourceLocation(error);
  return `local Core HTTP proof failed at ${phase}: ${safeProofErrorName(error)}${location === "source-location-unavailable" ? "" : ` (${location})`}`;
}

/** Keeps the work error primary while still retaining an independent cleanup failure. */
async function runWithCleanup<T>(
  work: () => Promise<T>,
  cleanup: () => Promise<void>,
  cleanupPhase: LocalCoreHttpCleanupPhase,
): Promise<T> {
  let result: T | undefined;
  let primaryFailure: unknown;
  let primaryFailurePresent = false;
  try {
    result = await work();
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

  if (primaryFailurePresent && cleanupFailurePresent) {
    throw new LocalCoreHttpCleanupFailure(primaryFailure, cleanupFailure, cleanupPhase);
  }
  if (primaryFailurePresent) throw primaryFailure;
  if (cleanupFailurePresent) throw cleanupFailure;
  return result as T;
}

async function main(): Promise<void> {
  const { image } = parseProofArgs(Bun.argv.slice(2));
  const root = await mkdtemp("/dev/shm/takosumi-core-http-");
  await chmod(root, 0o700);
  const containerName = `takosumi-core-http-${process.pid}-${randomUUID().slice(0, 8)}`;
  const ownerNonce = randomUUID();
  const runAbort = new AbortController();
  let containerAttempted = false;
  let phase: LocalCoreHttpProofPhase = "preflight";
  let cleanupPromise: Promise<void> | undefined;
  const cleanupOnce = (): Promise<void> => cleanupPromise ??= (async () => {
    try {
      const child = activeChild;
      if (child && child.exitCode === null) {
        child.kill("SIGKILL");
        await child.exited;
      }
      if (containerAttempted) {
        await cleanupOwnedContainer({
          name: containerName,
          ownerNonce,
          image,
          runDocker: docker,
        });
      }
    } catch (error) {
      phase = "cleanup";
      throw error;
    } finally {
      try {
        await rm(root, { recursive: true, force: true });
      } catch (error) {
        phase = "cleanup";
        throw error;
      }
    }
  })();
  const workPromise = (async () => {
    phase = "docker startup";
    const baseUrl = await startRunner(
      image, containerName, ownerNonce,
      () => { containerAttempted = true; },
      runAbort.signal,
    );
    phase = "public control lifecycle";
    return await prove(baseUrl, image, root, runAbort.signal);
  })();
  let signalHandled = false;
  const onSignal = () => {
    if (signalHandled) return;
    signalHandled = true;
    runAbort.abort();
    if (activeChild?.exitCode === null) activeChild.kill("SIGKILL");
    void workPromise.catch(() => undefined).then(cleanupOnce).then(
      () => process.exit(124),
      () => process.exit(125),
    );
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
  try {
    await runAndEmitAfterCleanup(
      () => workPromise,
      cleanupOnce,
      (result) => {
        if (runAbort.signal.aborted) throw new Error("proof was interrupted");
        console.log(JSON.stringify(result));
      },
    );
  } catch (error) {
    console.error(formatLocalCoreHttpProofFailure(phase, error));
    process.exitCode = 1;
  } finally {
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
  }
}

if (import.meta.main) await main();
