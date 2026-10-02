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
import { ACCOUNT_SESSION_COOKIE_NAME } from "../../accounts/service/src/account-session.ts";
import { genericOpenTofuVariableContractDigest } from "../../accounts/service/src/control/generic-opentofu-variable-contract.ts";
import { handleControlRoute } from "../../accounts/service/src/control-routes.ts";
import { InMemoryAccountsStore } from "../../accounts/service/src/store.ts";
import { ObjectKeyArtifactReferenceAllocator } from "../../core/adapters/storage/artifact-references.ts";
import { PartitionedSecretBoundaryCrypto } from "../../core/adapters/secret-store/memory.ts";
import { createTakosumiService } from "../../core/bootstrap.ts";
import { InMemoryOpenTofuControlStore } from "../../core/domains/deploy-control/store.ts";
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
    throw new Error("usage: bun run opentofu:core-http-local-proof -- --image sha256:<64 lowercase hex>");
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
): typeof fetch {
  const runnerOrigin = new URL(baseUrl).origin;
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== runnerOrigin) throw new Error("local proof refused an external HTTP destination");
    const signals = [AbortSignal.timeout(HTTP_TIMEOUT_MS)];
    if (init?.signal) signals.push(init.signal);
    if (signal) signals.push(signal);
    const response = await originalFetch(input, {
      ...init,
      signal: AbortSignal.any(signals),
    });
    const maxBytes = url.pathname.includes("/artifacts/")
      ? MAX_RUNNER_ARTIFACT_BYTES
      : MAX_RUNNER_RESPONSE_BYTES;
    const declaredLength = response.headers.get("content-length");
    if (declaredLength !== null && Number(declaredLength) > maxBytes) {
      await response.body?.cancel();
      throw new Error("runner response exceeded local proof byte cap");
    }
    const bytes = await readCappedBytes(response.body, maxBytes);
    const metadataRoute = /^\/runs\/([^/]+)\/plan-state-metadata$/u.exec(url.pathname);
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
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
    return new Response(response.status === 204 || response.status === 304 ? null : new Uint8Array(bytes), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
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
  const timeout = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs ?? COMMAND_TIMEOUT_MS);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      readCapped(child.stdout),
      readCapped(child.stderr),
      child.exited,
    ]);
    if (exitCode !== 0) {
      // Docker and tar diagnostics can include paths or environment details.
      throw new Error(`${argv[0]} exited ${exitCode}; stderr bytes=${stderr.length}`);
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

type Operations = Awaited<ReturnType<typeof createTakosumiService>>["operations"];

async function control<T>(
  operations: Operations,
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
  const response = await handleControlRoute({ request, url, store: accounts, operations });
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
  globalThis.fetch = boundedRunnerFetch(
    baseUrl,
    originalFetch,
    signal,
    (receipt) => { metadataReceipts.push(receipt); },
  );
  try {
    const store = new InMemoryOpenTofuControlStore();
    const accounts = new InMemoryAccountsStore();
    const now = Date.now();
    accounts.saveAccount({
      subject: ACTOR,
      email: "local-core-http@example.test",
      displayName: "Local Core HTTP Proof",
      createdAt: now,
      updatedAt: now,
    });
    const sessionId = `sess_local_core_http_${randomUUID().replaceAll("-", "")}`;
    accounts.saveAccountSession({
      sessionId,
      subject: ACTOR,
      createdAt: now,
      expiresAt: now + 180_000,
    });
    const cookie = `${ACCOUNT_SESSION_COOKIE_NAME}=${sessionId}`;
    const cryptoBoundary = new PartitionedSecretBoundaryCrypto({
      globalPassphrase: randomUUID() + randomUUID(),
    });
    const archiveStore = createFileSourceArchiveStore(join(root, "archives"));
    const stateStore = createFileOpenTofuStateArtifactStore(join(root, "state"), cryptoBoundary);
    const profile = createLocalOpenTofuRunnerProfile();
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
      operations, accounts, cookie, "POST", `/api/v1/capsules/${cap}/plan`, 201,
    );
    assert.equal(planned.run.status, "succeeded");
    assert.match(planned.run.planDigest ?? "", IMAGE_PATTERN);
    const before = await control<{ output: unknown }>(
      operations, accounts, cookie, "GET", `/api/v1/capsules/${cap}/outputs`, 200,
    );
    assert.equal(before.output, null);

    // Negative control: a foreign Workspace session cannot apply this Plan.
    accounts.saveAccount({
      subject: FOREIGN_ACTOR,
      email: "foreign-core-http@example.test",
      displayName: "Foreign Proof User",
      createdAt: now,
      updatedAt: now,
    });
    const foreignSessionId = `sess_foreign_core_http_${randomUUID().replaceAll("-", "")}`;
    accounts.saveAccountSession({
      sessionId: foreignSessionId,
      subject: FOREIGN_ACTOR,
      createdAt: now,
      expiresAt: now + 180_000,
    });
    await control(
      operations, accounts, `${ACCOUNT_SESSION_COOKIE_NAME}=${foreignSessionId}`,
      "POST", `/api/v1/runs/${planned.run.id}/apply`, 403,
    );
    assert.equal((await store.getCapsule(cap))?.currentStateGeneration, 0);
    const first = await control<{ run: { id: string; status: string } }>(
      operations, accounts, cookie, "POST", `/api/v1/runs/${planned.run.id}/apply`, 201,
    );
    if (first.run.status !== "succeeded") {
      throw new Error(`first apply ended with ${first.run.status}`);
    }
    assert.equal(first.run.status, "succeeded");
    const firstState = await control<{ stateVersions: Array<Pick<PublicStateVersion, "id" | "createdByRunId" | "generation">> }>(
      operations, accounts, cookie, "GET", `/api/v1/capsules/${cap}/state-versions`, 200,
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
      operations, accounts, cookie, "GET", `/api/v1/capsules/${cap}/outputs`, 200,
    );
    assert.equal(firstOutput.output.publicOutputs.launch_url, "https://first.example.test");

    const detail = await control<{ installConfigReAdoption: { authorityGuard: string } }>(
      operations, accounts, cookie, "GET", `/api/v1/capsules/${cap}`, 200,
    );
    const bindingSet = await operations.capsules.getProviderBindingSetByCapsule(cap, seeded.capsule.environment);
    assert(bindingSet);
    const updated = await control<{ configurationPlan: { planRunId: string } }>(
      operations, accounts, cookie, "POST", `/api/v1/capsules/${cap}/configuration-plans`, 201,
      {
        variablePatch: { set: { message: "second" }, remove: [] },
        providerBindings: bindingSet.bindings,
        interfaceBlueprints: [],
        expected: { authorityGuard: detail.installConfigReAdoption.authorityGuard },
      },
      { "idempotency-key": "local-core-http-update" },
    );
    const unchanged = await control<{ output: { publicOutputs: Record<string, unknown> } }>(
      operations, accounts, cookie, "GET", `/api/v1/capsules/${cap}/outputs`, 200,
    );
    assert.equal(unchanged.output.publicOutputs.launch_url, "https://first.example.test");
    assert.equal((await store.getCapsule(cap))?.currentStateGeneration, 1);
    const second = await control<{ run: { id: string; status: string } }>(
      operations, accounts, cookie, "POST",
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
      operations, accounts, cookie, "GET", `/api/v1/capsules/${cap}/outputs`, 200,
    );
    assert.equal(secondOutput.output.publicOutputs.launch_url, "https://second.example.test");
    const secondState = await control<{ stateVersions: Array<Pick<PublicStateVersion, "id" | "createdByRunId" | "generation">> }>(
      operations, accounts, cookie, "GET", `/api/v1/capsules/${cap}/state-versions`, 200,
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
      operations, accounts, cookie, "POST", `/api/v1/capsules/${cap}/destroy-plan`, 201,
    );
    assert.equal(destroyPlan.run.status, "waiting_approval");
    const approved = await control<PublicRun>(
      operations, accounts, cookie, "POST", `/api/v1/runs/${destroyPlan.run.id}/approve`, 200,
      { reason: "local provider-free proof" },
    );
    assert.equal(approved.run.status, "succeeded");
    const destroyed = await control<{ run: { id: string; status: string } }>(
      operations, accounts, cookie, "POST", `/api/v1/runs/${destroyPlan.run.id}/apply`, 201,
    );
    assert.equal(destroyed.run.status, "succeeded");
    const finalOutput = await control<{ output: unknown }>(
      operations, accounts, cookie, "GET", `/api/v1/capsules/${cap}/outputs`, 200,
    );
    assert.equal(finalOutput.output, null);
    const finalCapsule = await store.getCapsule(cap);
    assert.equal(finalCapsule?.status, "destroyed");
    assert.equal(finalCapsule?.currentStateGeneration, 3);
    const finalState = await control<{
      stateVersions: Array<Pick<PublicStateVersion, "id" | "createdByRunId" | "generation">>;
    }>(operations, accounts, cookie, "GET", `/api/v1/capsules/${cap}/state-versions`, 200);
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
  let result: T;
  try {
    result = await work();
  } finally {
    await cleanup();
  }
  emit(result);
}

async function main(): Promise<void> {
  const { image } = parseProofArgs(Bun.argv.slice(2));
  const root = await mkdtemp("/dev/shm/takosumi-core-http-");
  await chmod(root, 0o700);
  const containerName = `takosumi-core-http-${process.pid}-${randomUUID().slice(0, 8)}`;
  const ownerNonce = randomUUID();
  const runAbort = new AbortController();
  let containerAttempted = false;
  let phase = "preflight";
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
    const location = error instanceof Error
      ? error.stack?.match(/local-core-http-lifecycle\.ts:[0-9]+:[0-9]+/u)?.[0]
      : undefined;
    console.error(
      `local Core HTTP proof failed at ${phase}: ${error instanceof Error ? error.name : "unknown error"}${location ? ` (${location})` : ""}`,
    );
    process.exitCode = 1;
  } finally {
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
  }
}

if (import.meta.main) await main();
