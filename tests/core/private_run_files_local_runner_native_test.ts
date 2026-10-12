import { expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { dirname, join } from "node:path";

import { createTakosumiService } from "../../core/bootstrap.ts";
import { PartitionedSecretBoundaryCrypto } from "../../core/adapters/secret-store/memory.ts";
import { StorageMigrationRunner } from "../../core/adapters/storage/migration-runner/mod.ts";
import type { SqlClient } from "../../core/adapters/storage/sql.ts";
import { ObjectKeyArtifactReferenceAllocator } from "../../core/adapters/storage/artifact-references.ts";
import { PRIVATE_RUN_FILE_MAX_BYTES } from "../../core/api/private_run_file_routes.ts";
import { createPrivateRunFileGrantCodec } from "../../core/domains/private-run-files/grant.ts";
import { PRIVATE_RUN_FILE_REFRESH_CAPABILITY } from "../../core/shared/private_run_file_refresh.ts";
import { PostgresPrivateRunFileRepository } from "../../core/domains/private-run-files/repository_sql.ts";
import {
  applyExpectedGuardFromPlanRun,
  type RunnerProfile,
} from "../../core/domains/deploy-control/mod.ts";
import { SqlOpenTofuControlStore } from "../../core/domains/deploy-control/store_sql.ts";
import {
  createFileOpenTofuStateArtifactStore,
  createFileSourceArchiveStore,
  createHttpOpenTofuRunner,
  createLocalOpenTofuRunnerProfile,
} from "../../deploy/node-postgres/src/local-opentofu-runner.ts";
import { createLocalPrivateRunFileBlobStore } from "../../deploy/node-postgres/src/local-private-run-file-blob-store.ts";
import {
  FIXTURE_EXECUTION_EVIDENCE_AUTHORITY,
  seedCapsuleModel,
} from "../helpers/deploy-control/model_fixture.ts";
import {
  createNativePostgresRestartContainer,
  openNativePostgresSqlClient,
} from "../helpers/deploy-control/native_postgres_restart.ts";

const OPT_IN = "TAKOSUMI_TEST_PRIVATE_RUN_FILE_PROVIDER_RUNNER";
const PROVIDER_SOURCE = "registry.terraform.io/tako0614/takoform";
const PROVIDER_VERSION = "5.0.0";
const PROVIDER_COMMIT = "cb5569b76a80bcea0deb79b51b5bb19d186b4888";
const PRIVATE_SLOT = "host-v2-intent";
const STORE_ID = "local-runner-native-proof";
const FORM = "https://edge.forms.takoform.com/forms/ModuleWorker/0.3.0/";
const HOST_API_PATH = "/apis/forms.takoform.com/v2";
const enabled = process.env[OPT_IN] === "1";

interface Receipt {
  readonly version: number;
  readonly digest: string;
  readonly commitId: string;
  readonly expectedVersion: number;
}

interface PrivateFileDispatchEvidence {
  readonly runId: string;
  readonly action: string;
  readonly slot: string;
  readonly endpoint: string;
  readonly grantLength: number;
  readonly grantDigest: string;
}

interface PrivateFileWireEvidence {
  readonly operation: "read" | "commit" | "resolve";
  readonly grantDigest: string;
  readonly commitId?: string;
  readonly receipt?: Receipt;
}

interface PrivateFileRefreshEvidence {
  readonly runId: string;
  readonly sequence: number;
  readonly grantDigest: string;
  readonly status: number;
}

type CustodyEvent =
  | { readonly kind: "lost_commit_ack"; readonly commitId: string; readonly receipt: Receipt }
  | { readonly kind: "resolve_response"; readonly commitId: string; readonly receipt: Receipt }
  | { readonly kind: "host_post" };

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

test("lost-ACK custody rejects a Host POST before the matching resolve response", () => {
  const receipt: Receipt = {
    version: 2,
    digest: "sha256:fixture-digest",
    commitId: "fixture-commit-id-0001",
    expectedVersion: 1,
  };
  const reordered: readonly CustodyEvent[] = [
    { kind: "lost_commit_ack", commitId: receipt.commitId, receipt },
    { kind: "host_post" },
    { kind: "resolve_response", commitId: receipt.commitId, receipt },
  ];
  expect(() => assertLostAckResolvedBeforeHostPost(reordered, receipt))
    .toThrow("matching resolve response must precede the first Host POST");
});

function assertLostAckResolvedBeforeHostPost(
  events: readonly CustodyEvent[],
  expectedReceipt: Receipt,
): void {
  const exactReceipt = (left: Receipt, right: Receipt) =>
    left.version === right.version && left.digest === right.digest &&
    left.commitId === right.commitId && left.expectedVersion === right.expectedVersion;
  const dropped = events
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => event.kind === "lost_commit_ack" &&
      event.commitId === expectedReceipt.commitId && exactReceipt(event.receipt, expectedReceipt));
  const resolved = events
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => event.kind === "resolve_response" &&
      event.commitId === expectedReceipt.commitId && exactReceipt(event.receipt, expectedReceipt));
  const firstHostPost = events.findIndex((event) => event.kind === "host_post");
  if (dropped.length !== 1 || resolved.length !== 1 || firstHostPost < 0 ||
    !(dropped[0]!.index < resolved[0]!.index && resolved[0]!.index < firstHostPost)) {
    throw new Error("matching resolve response must precede the first Host POST");
  }
}

async function waitWithin<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
  return await Promise.race([
    promise,
    Bun.sleep(milliseconds).then(() => { throw new Error(message); }),
  ]);
}

async function directPrivateRead(endpoint: string, grant: string): Promise<number> {
  const response = await fetch(`${endpoint}/read`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${grant}`,
      "content-type": "application/json",
    },
    body: "{}",
  });
  await response.body?.cancel();
  return response.status;
}

test.skipIf(!enabled)(
  "real local Runner processes recover the Provider intent snapshot through Core PostgreSQL and encrypted blobs",
  async () => {
    const providerRoot = process.env.TAKOSUMI_TEST_PROVIDER_SOURCE_ROOT;
    if (!providerRoot) throw new Error("TAKOSUMI_TEST_PROVIDER_SOURCE_ROOT is required when opted in");
    const proof = await proveLocalRunnerPrivateFiles(providerRoot);
    expect(proof.runnerPids).toHaveLength(3);
    expect(new Set(proof.runnerPids).size).toBe(3);
    expect(proof.planAndApplyUseCurrentGrant).toBe(true);
    expect(proof.applyGrantRenewal.refreshed).toBe(true);
    expect(proof.applyGrantRenewal.sequence).toBe(1);
    expect(proof.applyGrantRenewal.oldGrantRejectedStatus).toBe(401);
    expect(proof.applyGrantRenewal.currentGrantReadStatus).toBe(200);
    expect(proof.applyGrantRenewal.readUsedRenewedGrant).toBe(true);
    expect(proof.applyGrantRenewal.lostAckCommitUsedPreRotationGrant).toBe(true);
    expect(proof.applyGrantRenewal.resolveUsedRenewedGrant).toBe(true);
    expect(proof.slot).toBe(PRIVATE_SLOT);
    expect(proof.droppedAck.exactReceiptResolved).toBe(true);
    expect(proof.droppedAck.resolvedBeforeFirstHostPost).toBe(true);
    expect(proof.droppedAck.applyCommitRequests).toBeGreaterThan(0);
    expect(proof.droppedAck.lostAckCommitAttempts).toBe(1);
    expect(proof.droppedAck.resolveRequests).toBe(1);
    expect(proof.hostMutationsAfterApply).toBe(1);
    expect(proof.hostMutationsAfterDestroy).toBe(2);
    expect(proof.destroyReceivedSameSlot).toBe(true);
    console.info(JSON.stringify(proof));
  },
  120_000,
);

interface ProofReport {
  readonly kind: "takosumi.local-private-run-file-provider-runner-proof/v1";
  readonly status: "passed";
  readonly takosumiCommit: string;
  readonly providerCommit: string;
  readonly providerVersion: string;
  readonly providerBinaryDigest: string;
  readonly sourceArchiveDigest: string;
  readonly providerLockDigest: string;
  readonly tofuVersion: string;
  readonly bunVersion: string;
  readonly goVersion: string;
  readonly runnerPids: readonly number[];
  readonly slot: string;
  readonly planAndApplyUseCurrentGrant: true;
  readonly applyGrantRenewal: {
    readonly refreshed: true;
    readonly sequence: 1;
    readonly oldGrantRejectedStatus: 401;
    readonly currentGrantReadStatus: 200;
    readonly readUsedRenewedGrant: true;
    readonly lostAckCommitUsedPreRotationGrant: true;
    readonly resolveUsedRenewedGrant: true;
  };
  readonly droppedAck: {
    readonly exactReceiptResolved: true;
    readonly resolvedBeforeFirstHostPost: true;
    readonly commitId: string;
    readonly receipt: Receipt;
    readonly applyCommitRequests: number;
    readonly lostAckCommitAttempts: number;
    readonly resolveRequests: 1;
  };
  readonly postgresRestart: {
    readonly stoppedAndUnavailable: true;
    readonly previousPostmasterHostPid: number;
    readonly newPostmasterHostPid: number;
    readonly previousPostmasterStartTime: string;
    readonly newPostmasterStartTime: string;
  };
  readonly hostMutationsAfterApply: 1;
  readonly hostMutationsAfterDestroy: 2;
  readonly destroyReceivedSameSlot: true;
  readonly boundaries: readonly string[];
}

async function proveLocalRunnerPrivateFiles(providerRoot: string): Promise<ProofReport> {
  const tempRoot = await mkdtemp(join("/dev/shm/t", "takosumi-prf-runner-"));
  await chmod(tempRoot, 0o700);
  const runRoot = join(tempRoot, "runner-root");
  const providerMirror = join(tempRoot, "provider-mirror");
  const artifactRoot = join(tempRoot, "core-artifacts");
  const privateBlobRoot = join(tempRoot, "private-blobs");
  const certificatePath = join(tempRoot, "host-cert.pem");
  const keyPath = join(tempRoot, "host-key.pem");
  const providerBinary = join(
    providerMirror,
    "registry.terraform.io/tako0614/takoform",
    PROVIDER_VERSION,
    "linux_amd64",
    `terraform-provider-takoform_v${PROVIDER_VERSION}`,
  );
  const runnerProcesses: RunnerProcess[] = [];
  const servers: Array<{ stop(force?: boolean): void | Promise<void> }> = [];
  let database: Awaited<ReturnType<typeof createNativePostgresRestartContainer>> | undefined;
  let sql: Awaited<ReturnType<typeof openNativePostgresSqlClient>> | undefined;

  try {
    await mkdir(join(tempRoot, "home"), { recursive: true, mode: 0o700 });
    await mkdir(join(tempRoot, "tmp"), { recursive: true, mode: 0o700 });
    const providerSource = await inspectProviderSource(providerRoot);
    const tofuVersion = await commandText("tofu", ["version"]);
    assertIncludes(tofuVersion, "OpenTofu v1.12.3", "pinned OpenTofu 1.12.3 is required");
    const goVersion = (await commandText("go", ["version"])).trim();
    assertIncludes(goVersion, "go1.26.0", "pinned Go 1.26.0 is required");
    await compileProvider(providerRoot, providerBinary);
    const providerBinaryDigest = await digestFile(providerBinary);
    const providerVersionOutput = await commandText(providerBinary, ["-version"]);
    if (providerVersionOutput.trim() !== PROVIDER_VERSION) {
      throw new Error("compiled Provider version differs from the pinned candidate");
    }

    await commandText("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
      "-keyout", keyPath, "-out", certificatePath,
      "-subj", "/CN=127.0.0.1",
      "-addext", "subjectAltName=IP:127.0.0.1",
    ]);
    await chmod(keyPath, 0o600);
    await chmod(certificatePath, 0o600);
    const certificate = await readFile(certificatePath);
    const key = await readFile(keyPath);
    const custodyEvents: CustodyEvent[] = [];
    const host = createFakeV2Host(certificate, key, custodyEvents);
    servers.push(host);
    const hostApiRoot = `${host.url}${HOST_API_PATH}`;

    const wireEvidence: PrivateFileWireEvidence[] = [];
    const refreshEvidence: PrivateFileRefreshEvidence[] = [];
    const applyRefreshArrived = deferred<PrivateFileRefreshEvidence>();
    const applyLostAckCommitArrived = deferred();
    const applyLostAckCommitRelease = deferred();
    let applyInitialGrant: string | undefined;
    let applyRenewedGrant: string | undefined;
    let applyRunId: string | undefined;
    let holdApplyLostAckCommit = false;
    let grantClock = Date.now();
    const grantNow = () => grantClock;
    let dropNextCommitAck = false;
    let droppedCommitReceipt: Receipt | undefined;
    const corePortRef: { port?: number } = {};
    const privateFilesGateway = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const incoming = new URL(request.url);
        const operation = incoming.pathname.slice(`${"/internal/private-run-files/v1/"}`.length);
        if (request.method !== "POST" || !["read", "commit", "resolve"].includes(operation)) {
          return new Response("not found", { status: 404 });
        }
        const bodyText = await request.text();
        let body: Record<string, unknown> = {};
        try {
          body = JSON.parse(bodyText) as Record<string, unknown>;
        } catch {
          return new Response("invalid request", { status: 400 });
        }
        const corePort = corePortRef.port;
        if (!corePort) return new Response("Core unavailable", { status: 503 });
        const headers = new Headers(request.headers);
        headers.delete("host");
        const forwarded = await fetch(`http://127.0.0.1:${corePort}${incoming.pathname}`, {
          method: "POST",
          headers,
          body: bodyText,
        });
        if (!forwarded.ok) return forwarded;
        if (operation === "read") {
          const bearer = request.headers.get("authorization")?.slice("Bearer ".length) ?? "";
          wireEvidence.push({
            operation: "read",
            grantDigest: createHash("sha256").update(bearer).digest("hex"),
          });
          return forwarded;
        }
        const forwardedBody = await forwarded.json() as Record<string, unknown>;
        const commitId = typeof body.commitId === "string" ? body.commitId : undefined;
        const receipt = parseReceipt(forwardedBody.receipt);
        wireEvidence.push({
          operation: operation as "commit" | "resolve",
          grantDigest: createHash("sha256")
            .update(request.headers.get("authorization")?.slice("Bearer ".length) ?? "")
            .digest("hex"),
          ...(commitId ? { commitId } : {}),
          ...(receipt ? { receipt } : {}),
        });
        if (operation === "commit" && dropNextCommitAck) {
          if (!commitId || !receipt) return new Response("missing committed receipt identity", { status: 502 });
          droppedCommitReceipt = receipt;
          if (holdApplyLostAckCommit) {
            holdApplyLostAckCommit = false;
            applyLostAckCommitArrived.resolve();
            await applyLostAckCommitRelease.promise;
          }
          dropNextCommitAck = false;
          custodyEvents.push({ kind: "lost_commit_ack", commitId, receipt });
          return Response.json({ kind: "unavailable" }, { status: 503 });
        }
        if (operation === "resolve" && commitId && receipt) {
          custodyEvents.push({ kind: "resolve_response", commitId, receipt });
        }
        return Response.json(forwardedBody, { status: forwarded.status });
      },
    });
    servers.push(privateFilesGateway);
    const privateEndpoint = `http://127.0.0.1:${privateFilesGateway.port}/internal/private-run-files/v1`;

    const databaseRoot = join(tempRoot, "postgres-data");
    await mkdir(databaseRoot, { recursive: true, mode: 0o700 });
    database = await createNativePostgresRestartContainer({ dataRoot: databaseRoot });
    sql = await openNativePostgresSqlClient(database.databaseUrl);
    await new StorageMigrationRunner(sql.client).applyPending();

    const cryptoBoundary = new PartitionedSecretBoundaryCrypto({
      globalPassphrase: randomUUID() + randomUUID(),
    });
    const artifactCrypto = new PartitionedSecretBoundaryCrypto({
      globalPassphrase: randomUUID() + randomUUID(),
    });
    const privateRunFilesFor = (client: SqlClient) => {
      const codec = createPrivateRunFileGrantCodec({ cryptoBoundary, now: grantNow });
      return {
        endpoint: privateEndpoint,
        maxBytes: PRIVATE_RUN_FILE_MAX_BYTES,
        grants: {
          open: codec.open,
          mint: codec.mint,
        },
        repository: new PostgresPrivateRunFileRepository(client),
        blobs: createLocalPrivateRunFileBlobStore({
          root: privateBlobRoot,
          maxBytes: PRIVATE_RUN_FILE_MAX_BYTES,
          cryptoBoundary,
        }),
        grantNow,
        refreshIntervalMs: 2,
      };
    };

    const runnerDispatches: PrivateFileDispatchEvidence[] = [];
    const runnerHttpEvidence: Array<{ method: string; path: string; status: number; safeError?: string }> = [];
    let activeRunnerUrl: string | undefined;
    const runnerIngress = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const destination = activeRunnerUrl;
        if (!destination) return new Response("Runner unavailable", { status: 503 });
        const incoming = new URL(request.url);
        const isRunDispatch = request.method === "POST" && /^\/runs\/[^/]+$/u.test(incoming.pathname);
        const isPrivateFileRefresh = request.method === "PUT" &&
          /^\/runs\/[^/]+\/private-run-files$/u.test(incoming.pathname);
        const bodyText = isRunDispatch || isPrivateFileRefresh ? await request.text() : undefined;
        const bodyBytes = request.method === "GET" || request.method === "HEAD" || isRunDispatch || isPrivateFileRefresh
          ? undefined
          : new Uint8Array(await request.arrayBuffer());
        if (isRunDispatch && bodyText) {
          const payload = JSON.parse(bodyText) as Record<string, unknown>;
          const job = payload.request as Record<string, unknown> | undefined;
          const files = Array.isArray(job?.privateRunFiles) ? job.privateRunFiles : [];
          for (const item of files) {
            const file = item as Record<string, unknown>;
            if (typeof file.slot !== "string" || typeof file.endpoint !== "string" ||
              typeof file.grant !== "string" || typeof payload.runId !== "string") {
              throw new Error("Core dispatch carried a malformed private-file descriptor");
            }
            runnerDispatches.push({
              runId: payload.runId,
              action: String(payload.action),
              slot: file.slot,
              endpoint: file.endpoint,
              grantLength: file.grant.length,
              grantDigest: createHash("sha256").update(file.grant).digest("hex"),
            });
            if (payload.action === "apply") {
              applyRunId = payload.runId;
              applyInitialGrant = file.grant;
            }
          }
        }
        let refresh: { runId: string; sequence: number; grantDigest: string; grant: string } | undefined;
        if (isPrivateFileRefresh && bodyText) {
          const body = JSON.parse(bodyText) as Record<string, unknown>;
          const files = Array.isArray(body.files) ? body.files : [];
          const file = files[0] as Record<string, unknown> | undefined;
          if (typeof body.runnerRunId !== "string" || !Number.isSafeInteger(body.sequence) ||
            typeof file?.grant !== "string" || typeof file.slot !== "string" ||
            typeof file.endpoint !== "string") {
            throw new Error("Runner private-file refresh carried malformed test evidence");
          }
          refresh = {
            runId: body.runnerRunId,
            sequence: body.sequence as number,
            grant: file.grant,
            grantDigest: createHash("sha256").update(file.grant).digest("hex"),
          };
        }
        const target = new URL(incoming.pathname + incoming.search, destination);
        const headers = new Headers(request.headers);
        headers.delete("host");
        const response = await fetch(target, {
          method: request.method,
          headers,
          ...(bodyText !== undefined ? { body: bodyText } : bodyBytes !== undefined ? { body: bodyBytes } : {}),
        });
        if (refresh) {
          const evidence: PrivateFileRefreshEvidence = {
            runId: refresh.runId,
            sequence: refresh.sequence,
            grantDigest: refresh.grantDigest,
            status: response.status,
          };
          refreshEvidence.push(evidence);
          if (refresh.runId === applyRunId && refresh.sequence === 1 && response.ok) {
            applyRenewedGrant = refresh.grant;
            applyRefreshArrived.resolve(evidence);
          }
        }
        const httpEvidence: { method: string; path: string; status: number; safeError?: string } = {
          method: request.method,
          path: incoming.pathname.replace(/\/runs\/[^/]+/u, "/runs/:runId"),
          status: response.status,
        };
        if (response.status >= 400 && isRunDispatch) {
          try {
            const bodyText = await response.clone().text();
            let safeError: string | undefined;
            try {
              const body = JSON.parse(bodyText) as Record<string, unknown>;
              const stderr = typeof body.stderr === "string" ? redactDiagnostic(body.stderr) : undefined;
              const errorCode = typeof body.errorCode === "string" ? body.errorCode : undefined;
              safeError = [errorCode, stderr].filter(Boolean).join(": ");
            } catch {
              // Bun's fallback page below has no Runner JSON envelope.
            }
            const fallbackJson = /<script id="__bunfallback" type="application\/json">([^<]+)<\/script>/u.exec(bodyText)?.[1];
            let fallback: Record<string, unknown> | undefined;
            if (fallbackJson) {
              try {
                fallback = JSON.parse(fallbackJson) as Record<string, unknown>;
              } catch {
                // Preserve only the normal bounded response text below.
              }
            }
            const fallbackMessage = typeof fallback?.message === "string" ? fallback.message : undefined;
            const fallbackStack = typeof fallback?.stack === "string"
              ? fallback.stack.split("\n").slice(0, 8).join("\n")
              : undefined;
            safeError ??= redactDiagnostic([fallbackMessage, fallbackStack].filter(Boolean).join("\n") || bodyText);
            if (safeError) httpEvidence.safeError = safeError.slice(0, 1500);
          } catch {
            // Status/path remain useful when a Runner error body is not JSON.
          }
        }
        runnerHttpEvidence.push(httpEvidence);
        return response;
      },
    });
    servers.push(runnerIngress);

    const profile = createNativeProviderRunnerProfile(createLocalOpenTofuRunnerProfile());
    const stateStore = createFileOpenTofuStateArtifactStore(
      join(artifactRoot, "state"),
      artifactCrypto,
    );
    const archiveStore = createFileSourceArchiveStore(join(artifactRoot, "archives"));
    const tofuRunner = createHttpOpenTofuRunner({
      archiveStore,
      stateStore,
      baseUrl: `http://127.0.0.1:${runnerIngress.port}`,
    });
    const serviceFor = (client: SqlClient) => createTakosumiService({
      role: "takosumi-api",
      runtimeEnv: { TAKOSUMI_DEV_MODE: "1" },
      sqlClient: client,
      opentofuControlStore: new SqlOpenTofuControlStore({ client }),
      opentofuRunner: tofuRunner,
      runnerProfiles: [profile],
      defaultRunnerProfileId: profile.id,
      artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
      executionEvidenceAuthority: FIXTURE_EXECUTION_EVIDENCE_AUTHORITY,
      privateRunFiles: privateRunFilesFor(client),
    });
    let service = await serviceFor(sql.client);
    const coreServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => service.app.fetch(request),
    });
    servers.push(coreServer);
    corePortRef.port = coreServer.port;

    let store = new SqlOpenTofuControlStore({ client: sql.client });
    const seeded = await seedCapsuleModel(store, {
      workspaceId: `workspace_native_${randomUUID().replaceAll("-", "")}`,
      capsuleId: `capsule_native_${randomUUID().replaceAll("-", "")}`,
      sourceId: `source_native_${randomUUID().replaceAll("-", "")}`,
      snapshotId: `snapshot_native_${randomUUID().replaceAll("-", "")}`,
      installConfigId: `install_native_${randomUUID().replaceAll("-", "")}`,
      name: "provider-remote-snapshot",
      environment: "local-proof",
      withoutSnapshot: true,
      requiredProviders: [],
      installConfig: {
        privateRunFiles: [{ slot: PRIVATE_SLOT }],
        policy: { providerInstallation: { requireMirror: true } },
      },
    });
    const moduleDir = join(tempRoot, "module");
    await mkdir(moduleDir, { recursive: true, mode: 0o700 });
    const mainTf = `terraform {
  required_version = "= 1.12.3"
  required_providers {
    takoform = {
      source  = ${JSON.stringify(PROVIDER_SOURCE)}
      version = "= ${PROVIDER_VERSION}"
    }
  }
}
provider "takoform" {
  alias             = "main"
  endpoint          = ${JSON.stringify(host.url)}
  host_api_root     = ${JSON.stringify(hostApiRoot)}
  token             = "fixture-token"
  store_id          = ${JSON.stringify(STORE_ID)}
  space             = "prod"
  intent_store_slot = ${JSON.stringify(PRIVATE_SLOT)}
}
resource "takoform_module_worker" "app" {
  provider = takoform.main
  name = "app"
}
`;
    await writeFile(join(moduleDir, "main.tf"), mainTf, { mode: 0o600 });
    const archive = await createSourceArchive(tempRoot, moduleDir);
    const snapshot = {
      ...seeded.snapshot,
      archiveDigest: archive.digest,
      archiveSizeBytes: archive.bytes.byteLength,
      repositoryInstallMetadata: { status: "absent" as const },
      repositoryManifest: { status: "absent" as const },
      repositoryModules: {
        status: "ready" as const,
        scopePath: ".",
        modules: [{
          path: ".",
          providerPackages: [{ source: PROVIDER_SOURCE, allowed: true }],
          rootProviderRequirements: [{
            source: PROVIDER_SOURCE,
            moduleLocalName: "takoform",
            version: PROVIDER_VERSION,
          }],
        }],
      },
    };
    await store.putSourceSnapshot(snapshot);
    await archiveStore.write(snapshot.archiveRef, archive.bytes);
    const compatibilityId = `compat_${randomUUID().replaceAll("-", "")}`;
    await store.putCapsuleCompatibilityReport({
      id: compatibilityId,
      sourceId: seeded.source.id,
      sourceSnapshotId: snapshot.id,
      capsuleId: seeded.capsule.id,
      modulePath: ".",
      level: "ready",
      findings: [],
      providerPackages: [{ source: PROVIDER_SOURCE, allowed: true }],
      rootProviderRequirements: [{
        source: PROVIDER_SOURCE,
        moduleLocalName: "takoform",
        version: PROVIDER_VERSION,
      }],
      resources: [],
      dataSources: [],
      provisioners: [],
      rootModuleVariables: [],
      rootModuleVariableDeclarations: [],
      rootModuleOutputs: [],
      createdAt: new Date().toISOString(),
    });
    const capsule = await store.getCapsule(seeded.capsule.id);
    if (!capsule) throw new Error("seeded Capsule disappeared from native PostgreSQL");
    await store.putCapsule({
      ...capsule,
      compatibilityReportId: compatibilityId,
      compatibilityStatus: "ready",
      updatedAt: new Date().toISOString(),
    });

    let controller = service.operations.controller;
    const runnerPids: number[] = [];
    activeRunnerUrl = undefined;
    const planRunner = await startRunnerProcess({
      index: 1,
      tempRoot,
      runRoot,
      providerMirror,
      certificatePath,
    });
    runnerProcesses.push(planRunner);
    runnerPids.push(planRunner.pid);
    activeRunnerUrl = planRunner.baseUrl;
    const plan = await controller.createCapsulePlan(seeded.capsule.id);
    if (plan.planRun.status !== "succeeded") {
      const persistedPlan = await store.getPlanRun(plan.planRun.id);
      const diagnosticCodes = plan.planRun.diagnostics?.map((item) => item.code).filter(Boolean);
      const diagnosticMessages = persistedPlan?.diagnostics?.map((item) => item.message);
      throw new Error(
        `native Provider plan failed with status ${plan.planRun.status}; errorCode=${persistedPlan?.errorCode ?? plan.planRun.errorCode ?? "none"}; policy=${persistedPlan?.policy.status ?? "unknown"}; policyReasons=${JSON.stringify(persistedPlan?.policy.reasons ?? [])}; diagnosticCodes=${JSON.stringify(diagnosticCodes ?? [])}; diagnosticMessages=${JSON.stringify(diagnosticMessages ?? [])}; dispatched=${runnerDispatches.length}; dispatchEvidence=${JSON.stringify(runnerDispatches)}; runnerHttp=${JSON.stringify(runnerHttpEvidence)}; runnerOutput=${JSON.stringify(planRunner.outputTail())}`,
      );
    }
    const providerLockDigest = plan.planRun.providerLockDigest;
    if (!providerLockDigest) throw new Error("OpenTofu Runner did not return a provider lock digest");
    await stopRunnerProcess(planRunner);

    // Reopen Core's SQL adapter after a real PostgreSQL daemon restart. The
    // Plan Run and private-file receipt/blob must still be recoverable before
    // Apply is dispatched by the next Runner process.
    await sql.close();
    const postgresRestart = await database.restartPostgresDaemon();
    sql = await openNativePostgresSqlClient(database.databaseUrl);
    service = await serviceFor(sql.client);
    store = new SqlOpenTofuControlStore({ client: sql.client });
    controller = service.operations.controller;
    const persistedPlan = await store.getPlanRun(plan.planRun.id);
    if (persistedPlan?.status !== "succeeded") {
      throw new Error("Plan Run did not survive PostgreSQL daemon restart");
    }

    const applyRunner = await startRunnerProcess({
      index: 2,
      tempRoot,
      runRoot,
      providerMirror,
      certificatePath,
    });
    runnerProcesses.push(applyRunner);
    runnerPids.push(applyRunner.pid);
    activeRunnerUrl = applyRunner.baseUrl;
    dropNextCommitAck = true;
    holdApplyLostAckCommit = true;
    const applyWireStart = wireEvidence.length;
    const applyPromise = controller.createApplyRun({
      planRunId: plan.planRun.id,
      expected: applyExpectedGuardFromPlanRun(plan.planRun),
    });
    let apply: Awaited<typeof applyPromise>;
    let renewal: PrivateFileRefreshEvidence;
    let oldGrantRejectedStatus: number;
    let currentGrantReadStatus: number;
    try {
      await waitWithin(applyLostAckCommitArrived.promise, 30_000, "Apply did not reach the held lost-ACK commit");
      if (!applyInitialGrant || !applyRunId) {
        throw new Error("Apply dispatch did not capture its initial private-file descriptor");
      }
      // The real Provider's commit is durable at Core, but its exact ACK is
      // held before the proxy returns the injected 503. Advance only the grant
      // clock into the 90-second lead for the actual 360-second TTL.
      grantClock += 280_000;
      renewal = await waitWithin(applyRefreshArrived.promise, 10_000, "Core did not rotate the live Apply grant");
      if (!applyRenewedGrant || renewal.runId !== applyRunId ||
        renewal.sequence !== 1 || renewal.grantDigest === createHash("sha256").update(applyInitialGrant).digest("hex")) {
        throw new Error("Core did not publish a distinct sequence-one Apply grant");
      }
      // The commit was issued with the initial grant; after renewal, expire
      // that token while its ACK remains unknown to Provider. The Core Run is
      // still executing and the exact provider resolve must use the new file.
      grantClock += 81_000;
      const coreEndpoint = `http://127.0.0.1:${corePortRef.port}/internal/private-run-files/v1`;
      oldGrantRejectedStatus = await directPrivateRead(coreEndpoint, applyInitialGrant);
      currentGrantReadStatus = await directPrivateRead(coreEndpoint, applyRenewedGrant);
      if (oldGrantRejectedStatus !== 401 || currentGrantReadStatus !== 200) {
        throw new Error("rotated Core grant did not enforce expiry while retaining the live Run authority");
      }
    } finally {
      applyLostAckCommitRelease.resolve();
    }
    apply = await applyPromise;
    const providerWire = wireEvidence.slice(applyWireStart);
    const renewedDigest = renewal!.grantDigest;
    const applyRefreshes = refreshEvidence.filter((entry) => entry.runId === applyRunId);
    if (applyRefreshes.length !== 1 || applyRefreshes[0]?.sequence !== 1 || !applyRefreshes[0].status) {
      throw new Error("live Apply did not complete exactly one sequence-one Runner descriptor refresh");
    }
    if (!providerWire.some((entry) => entry.operation === "read" && entry.grantDigest === renewedDigest)) {
      throw new Error("compiled Provider did not read through the renewed descriptor");
    }
    if (!providerWire.some((entry) => entry.operation === "commit" &&
      entry.grantDigest === createHash("sha256").update(applyInitialGrant!).digest("hex"))) {
      throw new Error("lost-ACK commit did not use its original grant before renewal");
    }
    if (!providerWire.some((entry) => entry.operation === "resolve" && entry.grantDigest === renewedDigest)) {
      throw new Error("compiled Provider did not resolve the lost ACK through the renewed descriptor");
    }
    if (apply.applyRun.status !== "succeeded") {
      const persistedApply = await store.getApplyRun(apply.applyRun.id);
      throw new Error(
        `native Provider Apply failed with status ${apply.applyRun.status}; diagnostics=${JSON.stringify(persistedApply?.diagnostics?.map((item) => ({ code: item.code, message: item.message })) ?? [])}; runnerHttp=${JSON.stringify(runnerHttpEvidence)}; runnerOutput=${JSON.stringify(applyRunner.outputTail())}; hostMutations=${host.mutations}`,
      );
    }
    if (dropNextCommitAck) throw new Error("native Apply did not reach the injected lost-ACK commit");
    const applyWire = wireEvidence.slice(applyWireStart).filter((entry) => entry.operation !== "read");
    const applyCommits = applyWire.filter((entry) => entry.operation === "commit");
    const applyResolves = applyWire.filter((entry) => entry.operation === "resolve");
    const droppedCommitAttempts = droppedCommitReceipt
      ? applyCommits.filter((entry) => entry.commitId === droppedCommitReceipt?.commitId)
      : [];
    if (applyCommits.length < 1 || droppedCommitAttempts.length !== 1 || applyResolves.length !== 1) {
      throw new Error(
        `expected one lost-ACK commit attempt and one resolve among Apply commits; totalCommits=${applyCommits.length}, lostAckAttempts=${droppedCommitAttempts.length}, resolves=${applyResolves.length}`,
      );
    }
    const resolved = applyResolves[0];
    if (!droppedCommitReceipt || resolved?.commitId !== droppedCommitReceipt.commitId || !resolved?.receipt ||
      JSON.stringify(resolved.receipt) !== JSON.stringify(droppedCommitReceipt)) {
      throw new Error("lost Core ACK was not recovered with the exact original commit receipt");
    }
    assertLostAckResolvedBeforeHostPost(custodyEvents, droppedCommitReceipt);
    if (host.mutations !== 1) throw new Error("lost private-file ACK caused a duplicate Host mutation");
    await stopRunnerProcess(applyRunner);

    const destroyRunner = await startRunnerProcess({
      index: 3,
      tempRoot,
      runRoot,
      providerMirror,
      certificatePath,
    });
    runnerProcesses.push(destroyRunner);
    runnerPids.push(destroyRunner.pid);
    activeRunnerUrl = destroyRunner.baseUrl;
    const destroyPlan = await controller.createCapsuleDestroyPlan(seeded.capsule.id);
    if (destroyPlan.planRun.status !== "waiting_approval") {
      throw new Error(`native destroy plan has unexpected status ${destroyPlan.planRun.status}`);
    }
    await controller.approveRun(destroyPlan.planRun.id);
    const destroy = await controller.createApplyRun({
      planRunId: destroyPlan.planRun.id,
      expected: applyExpectedGuardFromPlanRun(destroyPlan.planRun),
    });
    if (destroy.applyRun.status !== "succeeded") {
      throw new Error(`native Provider Destroy failed with status ${destroy.applyRun.status}`);
    }
    if (host.mutations !== 2) throw new Error("native destroy did not reach the Host exactly once");

    const planDescriptor = runnerDispatches.find((entry) => entry.runId === plan.planRun.id);
    const applyDescriptor = runnerDispatches.find((entry) => entry.runId === apply.applyRun.id);
    const destroyDescriptor = runnerDispatches.find((entry) => entry.runId === destroy.applyRun.id);
    if (!planDescriptor || !applyDescriptor || !destroyDescriptor) {
      throw new Error("Core did not dispatch private-file capability for Plan, Apply, and Destroy");
    }
    if (planDescriptor.slot !== PRIVATE_SLOT || applyDescriptor.slot !== PRIVATE_SLOT ||
      destroyDescriptor.slot !== PRIVATE_SLOT || planDescriptor.grantDigest === applyDescriptor.grantDigest ||
      applyDescriptor.grantDigest === destroyDescriptor.grantDigest) {
      throw new Error("Core did not rotate current private-file grants while preserving the slot");
    }
    if (destroyDescriptor.action !== "destroy") {
      throw new Error("Core did not send the private slot through the Destroy action");
    }

    return {
      kind: "takosumi.local-private-run-file-provider-runner-proof/v1",
      status: "passed",
      takosumiCommit: await commandText("git", ["rev-parse", "HEAD"]),
      providerCommit: providerSource.commit,
      providerVersion: PROVIDER_VERSION,
      providerBinaryDigest,
      sourceArchiveDigest: archive.digest,
      providerLockDigest,
      tofuVersion: tofuVersion.trim().split("\n").slice(0, 2).join(" "),
      bunVersion: Bun.version,
      goVersion: goVersion.trim(),
      runnerPids,
      postgresRestart,
      slot: PRIVATE_SLOT,
      planAndApplyUseCurrentGrant: true,
      applyGrantRenewal: {
        refreshed: true,
        sequence: renewal!.sequence as 1,
        oldGrantRejectedStatus: oldGrantRejectedStatus! as 401,
        currentGrantReadStatus: currentGrantReadStatus! as 200,
        readUsedRenewedGrant: true,
        lostAckCommitUsedPreRotationGrant: true,
        resolveUsedRenewedGrant: true,
      },
      droppedAck: {
        exactReceiptResolved: true,
        resolvedBeforeFirstHostPost: true,
        commitId: droppedCommitReceipt.commitId,
        receipt: droppedCommitReceipt,
        applyCommitRequests: applyCommits.length,
        lostAckCommitAttempts: droppedCommitAttempts.length,
        resolveRequests: 1,
      },
      hostMutationsAfterApply: 1,
      hostMutationsAfterDestroy: 2,
      destroyReceivedSameSlot: true,
      boundaries: [
        "native local PostgreSQL server and application-created encrypted blob files; the PostgreSQL daemon was SIGTERM-stopped/restarted before Apply and Plan Run readback used a fresh SQL pool",
        "real local Runner entrypoint OS processes, OpenTofu CLI, and compiled Provider binary from the pinned source commit",
        "deterministic local HTTPS Host fixture; no production Host or authentication authority",
        "Core Run controller and current-grant minter are real; provider-private commit ACK loss is injected at a loopback HTTP proxy",
        "the original commit uses its pre-rotation grant; refresh completes while its ACK is held, then the exact resolve uses the new descriptor; only the private-file grant clock advances, not Run lease or heartbeat time",
        "no immutable Runner image, Cloud service, or production qualification",
      ],
    };
  } finally {
    for (const runner of runnerProcesses.reverse()) {
      if (!runner.stopped) await stopRunnerProcess(runner).catch(() => {});
    }
    for (const server of servers.reverse()) {
      await server.stop(true);
    }
    await sql?.close();
    await database?.close();
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function inspectProviderSource(root: string): Promise<{ commit: string }> {
  const commit = (await commandText("git", ["rev-parse", "HEAD"], root)).trim();
  if (commit !== PROVIDER_COMMIT) throw new Error("Provider source commit differs from the approved candidate");
  const dirty = (await commandText("git", ["status", "--porcelain"], root)).trim();
  if (dirty) throw new Error("Provider source worktree must be clean for native integration proof");
  return { commit };
}

async function compileProvider(root: string, output: string): Promise<void> {
  await mkdir(dirname(output), { recursive: true, mode: 0o700 });
  const environment = {
    ...process.env,
    GOPROXY: "off",
    GOSUMDB: "off",
    GOTOOLCHAIN: "local",
    GOCACHE: process.env.GOCACHE ?? "/root/hdd/go-cache",
    GOOS: "linux",
    GOARCH: "amd64",
  };
  await runCommand("go", [
    "build", "-mod=readonly", "-trimpath",
    `-ldflags=-X main.version=${PROVIDER_VERSION}`,
    "-o", output, ".",
  ], root, environment);
  await chmod(output, 0o755);
}

interface RunnerProcess {
  readonly pid: number;
  readonly baseUrl: string;
  readonly child: ReturnType<typeof Bun.spawn>;
  readonly recentOutput: string[];
  stopped: boolean;
  outputTail(): readonly string[];
}

async function startRunnerProcess(input: {
  readonly index: number;
  readonly tempRoot: string;
  readonly runRoot: string;
  readonly providerMirror: string;
  readonly certificatePath: string;
}): Promise<RunnerProcess> {
  const port = await reserveLocalPort();
  // The OS process changes, but its dedicated local Runner durable root does
  // not: Apply must restore the exact Plan artifact after process restart.
  const instanceRunRoot = input.runRoot;
  await mkdir(instanceRunRoot, { recursive: true, mode: 0o700 });
  const child = Bun.spawn([
    process.execPath,
    "--no-env-file",
    "runner/entrypoint.ts",
    "--local-preparation-v2-supervisor",
  ], {
    cwd: process.cwd(),
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: join(input.tempRoot, "home"),
      TMPDIR: join(input.tempRoot, "tmp"),
      TMP: join(input.tempRoot, "tmp"),
      TEMP: join(input.tempRoot, "tmp"),
      PORT: String(port),
      TAKOSUMI_RUNNER_MUTATION_CUSTODY_MODE: "local-http",
      TAKOSUMI_OPENTOFU_RUN_ROOT: instanceRunRoot,
      OPENTOFU_PROVIDER_MIRROR: input.providerMirror,
      SSL_CERT_FILE: input.certificatePath,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const recentOutput: string[] = [];
  const capture = (stream: ReadableStream<Uint8Array>) => stream.pipeTo(new WritableStream({
    write(chunk) {
      recentOutput.push(...redactDiagnostic(new TextDecoder().decode(chunk)).split(/\r?\n/u).filter(Boolean));
      if (recentOutput.length > 30) recentOutput.splice(0, recentOutput.length - 30);
    },
  })).catch(() => undefined);
  void capture(child.stdout);
  void capture(child.stderr);
  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error("local Runner entrypoint exited before health readiness");
    try {
      const response = await fetch(`${baseUrl}/healthz`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) {
        const health = await response.json() as { capabilities?: unknown; mutationCustodyMode?: unknown };
        if (health.mutationCustodyMode !== "local-http" ||
          !Array.isArray(health.capabilities) ||
          !health.capabilities.includes("takosumi.local-mutation-preparation@v2") ||
          !health.capabilities.includes(PRIVATE_RUN_FILE_REFRESH_CAPABILITY)) {
          throw new Error("local Runner entrypoint did not expose the expected private preparation capability");
        }
        return {
          pid: child.pid,
          baseUrl,
          child,
          recentOutput,
          stopped: false,
          outputTail: () => recentOutput.slice(-12),
        };
      }
      await response.body?.cancel();
    } catch (error) {
      if (error instanceof Error && error.message.includes("expected private preparation")) throw error;
    }
    await Bun.sleep(100);
  }
  child.kill("SIGTERM");
  await child.exited;
  throw new Error("local Runner entrypoint did not become healthy before the deadline");
}

async function stopRunnerProcess(runner: RunnerProcess): Promise<void> {
  if (runner.stopped) return;
  runner.child.kill("SIGTERM");
  const exitCode = await Promise.race([
    runner.child.exited,
    Bun.sleep(15_000).then(() => undefined),
  ]);
  if (exitCode === undefined) {
    runner.child.kill("SIGKILL");
    await runner.child.exited;
    runner.stopped = true;
    throw new Error("local Runner shutdown required forced termination");
  }
  runner.stopped = true;
  if (exitCode !== 0) throw new Error("local Runner entrypoint did not exit cleanly");
}

function createNativeProviderRunnerProfile(base: RunnerProfile): RunnerProfile {
  return {
    ...base,
    name: "Local native provider integration proof",
    allowedProviders: [PROVIDER_SOURCE],
    labels: { ...base.labels, environment: "local-native-proof" },
  };
}

function createFakeV2Host(cert: Buffer, key: Buffer, custodyEvents: CustodyEvent[]) {
  let resourceExists = false;
  let generation = 0;
  let operationId = "";
  let action: "create" | "delete" = "create";
  let mutations = 0;
  const resourceUid = "uid-local-proof-1";
  const operations = new Map<string, Record<string, unknown>>();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    tls: { cert, key },
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method === "POST" && url.pathname === `${HOST_API_PATH}/resources`) {
        custodyEvents.push({ kind: "host_post" });
      }
      if (url.pathname !== "/.well-known/takoform/v2" &&
        request.headers.get("authorization") !== "Bearer fixture-token") {
        return problem(401, "unauthorized");
      }
      if (request.method === "GET" && url.pathname === "/.well-known/takoform/v2") {
        return Response.json({
          api: "forms.takoform.com/v2",
          // Bun's server URL ends in `/`; resolve from the origin so the
          // advertised API root matches the exact value initialized into the
          // remote intent store (without a doubled slash).
          baseUrl: new URL(HOST_API_PATH, server.url).toString(),
          documentation: "https://host.example.test/docs",
          authentication: { schemes: ["Bearer"], documentation: "https://host.example.test/auth" },
          capabilities: { offerings: false, previews: false, privateInputs: false },
          limits: { maxRequestBytes: 65_536, maxPageSize: 50, replayWindowSeconds: 3600 },
        });
      }
      if (request.method === "GET" && url.pathname === `${HOST_API_PATH}/support`) {
        if (url.searchParams.get("form") !== FORM) return problem(404, "form_unknown");
        return Response.json({ form: FORM, supported: true, operations: ["create", "read", "update", "delete"], privateInputs: false });
      }
      if (request.method === "POST" && url.pathname === `${HOST_API_PATH}/resources`) {
        if (!request.headers.get("idempotency-key") || resourceExists) {
          return problem(409, "name_conflict");
        }
        const body = await request.json() as Record<string, unknown>;
        if (body.form !== FORM || body.space !== "prod" || body.name !== "app") return problem(400, "invalid");
        resourceExists = true;
        generation = 1;
        action = "create";
        mutations += 1;
        operationId = "op-local-create";
        const operation = successfulOperation(operationId, resourceUid, action, generation);
        operations.set(operationId, operation);
        // Provider v2 recognizes only the API's successful mutation statuses
        // (200 or 202); 201 is deliberately not an ACK in its client.
        return operationResponse(operation, 200, new URL(HOST_API_PATH, server.url).toString());
      }
      if (request.method === "GET" && url.pathname.startsWith(`${HOST_API_PATH}/operations/`)) {
        const found = operations.get(url.pathname.slice(`${HOST_API_PATH}/operations/`.length));
        return found
          ? operationResponse(found, 200, new URL(HOST_API_PATH, server.url).toString())
          : problem(404, "operation_not_found");
      }
      if (request.method === "GET" && url.pathname === `${HOST_API_PATH}/resources/${resourceUid}`) {
        if (!resourceExists) return problem(404, "resource_not_found");
        return Response.json({
          uid: resourceUid,
          form: FORM,
          space: "prod",
          name: "app",
          generation,
          observedGeneration: generation,
          observedAt: new Date().toISOString(),
          phase: "idle",
          spec: {},
          observed: {},
          output: {},
          lastOperation: operationId,
        });
      }
      if (request.method === "DELETE" && url.pathname === `${HOST_API_PATH}/resources/${resourceUid}`) {
        if (!resourceExists || !request.headers.get("idempotency-key") ||
          request.headers.get("takoform-expected-generation") !== String(generation)) {
          return problem(409, "generation_conflict");
        }
        resourceExists = false;
        generation += 1;
        action = "delete";
        mutations += 1;
        operationId = "op-local-delete";
        const operation = successfulOperation(operationId, resourceUid, action, generation);
        operations.set(operationId, operation);
        return operationResponse(operation, 200, new URL(HOST_API_PATH, server.url).toString());
      }
      return problem(404, "route_not_found");
    },
  });
  return {
    url: `https://127.0.0.1:${server.port}`,
    get mutations() { return mutations; },
    stop: (force?: boolean) => server.stop(force),
  };
}

function successfulOperation(
  id: string,
  uid: string,
  action: "create" | "delete",
  generation: number,
): Record<string, unknown> {
  const now = new Date().toISOString();
  return {
    id,
    resourceUid: uid,
    action,
    generation,
    status: "succeeded",
    effect: "complete",
    createdAt: now,
    updatedAt: now,
    retainUntil: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
  };
}

function operationResponse(value: Record<string, unknown>, status: number, apiRoot: string): Response {
  return Response.json(value, {
    status,
    headers: { location: `${apiRoot}/operations/${value.id}` },
  });
}

function problem(status: number, code: string): Response {
  return Response.json({ type: "about:blank", title: code, status, code }, {
    status,
    headers: { "content-type": "application/problem+json" },
  });
}

async function createSourceArchive(
  root: string,
  moduleDir: string,
): Promise<{ bytes: Uint8Array; digest: string }> {
  const path = join(root, "source.tar.zst");
  await runCommand("tar", [
    "--sort=name", "--mtime=@0", "--owner=0", "--group=0", "--numeric-owner",
    "--zstd", "-cf", path, "-C", moduleDir, ".",
  ]);
  await commandText("zstd", ["--test", path]);
  await commandText("tar", ["-t", "--zstd", "-f", path]);
  const bytes = new Uint8Array(await readFile(path));
  if (!bytes.byteLength || bytes.byteLength > 1024 * 1024) throw new Error("source archive is empty or oversized");
  return {
    bytes,
    digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
  };
}

async function reserveLocalPort(): Promise<number> {
  const server = createHttpServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("could not reserve a local Runner port");
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function runCommand(
  executable: string,
  args: readonly string[],
  cwd = process.cwd(),
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  const child = Bun.spawn([executable, ...args], {
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`${executable} exited with ${code}: ${safeOutput(stdout + stderr)}`);
}

async function commandText(executable: string, args: readonly string[], cwd = process.cwd()): Promise<string> {
  const child = Bun.spawn([executable, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`${executable} exited with ${code}: ${safeOutput(stdout + stderr)}`);
  return stdout;
}

function safeOutput(value: string): string {
  return value.replace(/\s+/gu, " ").trim().slice(0, 500);
}

function redactDiagnostic(value: string): string {
  return value
    .replace(/Bearer\s+\S+/giu, "Bearer [redacted]")
    .replace(/fixture-token/giu, "[fixture-token]")
    .replace(/("(?:grant|bytesBase64|privateInputs|token)"\s*:\s*")[^"]+/giu, "$1[redacted]")
    .replace(/(?:eyJ[a-zA-Z0-9_-]{16,}\.)[a-zA-Z0-9_.-]+/gu, "[opaque-grant]");
}

async function digestFile(path: string): Promise<string> {
  const bytes = await readFile(path);
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function parseReceipt(value: unknown): Receipt | undefined {
  if (!value || typeof value !== "object") return undefined;
  const receipt = value as Record<string, unknown>;
  if (typeof receipt.version !== "number" || typeof receipt.digest !== "string" ||
    typeof receipt.commitId !== "string" || typeof receipt.expectedVersion !== "number") return undefined;
  return {
    version: receipt.version,
    digest: receipt.digest,
    commitId: receipt.commitId,
    expectedVersion: receipt.expectedVersion,
  };
}

function assertIncludes(value: string, expected: string, message: string): void {
  if (!value.includes(expected)) throw new Error(message);
}
