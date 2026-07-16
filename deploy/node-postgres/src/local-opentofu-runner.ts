import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type {
  OpenTofuApplyJob,
  OpenTofuApplyResult,
  OpenTofuCapsuleSourceFile,
  OpenTofuCapsuleSourceFilesJob,
  OpenTofuDestroyJob,
  OpenTofuDestroyResult,
  OpenTofuPlanJob,
  OpenTofuPlanResult,
  OpenTofuRunner,
  OpenTofuSourceSyncJob,
  OpenTofuSourceSyncResult,
  ProviderInstallationEvidence,
  ReleaseCommandRunJob,
  ReleaseCommandRunResult,
} from "../../../core/domains/deploy-control/mod.ts";
import { DEFAULT_OPENTOFU_RUNNER_EXECUTOR_ID } from "../../../core/domains/deploy-control/mod.ts";
import { OpenTofuRunnerExecutionError } from "../../../core/domains/deploy-control/errors.ts";
import { normalizePlanResourceScope } from "takosumi-contract";
import type {
  OpenTofuPlanArtifact,
  PlanResourceChange,
  RunnerProfile,
  RunDiagnostic,
} from "@takosumi/internal/deploy-control-api";
import { handleRunnerRequest } from "../../../runner/entrypoint.ts";

export const LOCAL_OPENTOFU_RUNNER_PROFILE_ID = "local-opentofu";

interface RunnerTransport {
  fetch(path: string, init?: RequestInit): Promise<Response>;
}

export interface SourceArchiveStore {
  write(key: string, bytes: Uint8Array): Promise<void>;
  read(key: string): Promise<Uint8Array>;
}

export function createFileSourceArchiveStore(root: string): SourceArchiveStore {
  const normalizedRoot = resolve(root);
  return {
    write: async (key, bytes) => {
      const path = archivePath(normalizedRoot, key);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, bytes);
    },
    read: async (key) =>
      new Uint8Array(await readFile(archivePath(normalizedRoot, key))),
  };
}

export function createLocalOpenTofuRunner(input: {
  readonly archiveStore: SourceArchiveStore;
}): OpenTofuRunner {
  return new LocalOpenTofuRunner(input.archiveStore, inProcessRunnerTransport);
}

export function createHttpOpenTofuRunner(input: {
  readonly archiveStore: SourceArchiveStore;
  readonly baseUrl: string;
}): OpenTofuRunner {
  return new LocalOpenTofuRunner(
    input.archiveStore,
    httpRunnerTransport(input.baseUrl),
  );
}

export function createLocalOpenTofuRunnerProfile(
  now = Date.now(),
): RunnerProfile {
  return {
    id: LOCAL_OPENTOFU_RUNNER_PROFILE_ID,
    name: "Local OpenTofu",
    substrate: "local",
    executorId: DEFAULT_OPENTOFU_RUNNER_EXECUTOR_ID,
    lifecycle: { state: "active" },
    availability: { state: "available" },
    description:
      "Local-substrate OpenTofu runner for provider-free smoke deployments.",
    tofuVersion: "operator-managed",
    stateBackend: {
      kind: "local",
      ref: "state://local-substrate/opentofu",
      lock: { kind: "operator", ref: "lock://local-substrate/opentofu" },
    },
    allowedProviders: [],
    resourceLimits: {
      maxRunSeconds: 300,
      maxSourceArchiveBytes: 64 * 1024 * 1024,
      maxSourceDecompressedBytes: 512 * 1024 * 1024,
      cpu: "1",
      memoryMb: 1024,
    },
    networkPolicy: { mode: "default-deny" },
    secretExposurePolicy: {
      providerCredentials: "runner-only",
      tenantWorkerOperatorSecrets: "forbidden",
      redactLogs: true,
      blockSensitiveOutputs: true,
    },
    labels: { environment: "local-substrate" },
    createdAt: now,
  };
}

class LocalOpenTofuRunner implements OpenTofuRunner {
  constructor(
    private readonly archiveStore: SourceArchiveStore,
    private readonly transport: RunnerTransport,
  ) {}

  async plan(job: OpenTofuPlanJob): Promise<OpenTofuPlanResult> {
    assertNoObjectStoreStateAdoption(job);
    await this.restoreSourceArchive(job.planRun.id, job.sourceArchive);
    const result = await runRunner(this.transport, "plan", job.planRun.id, job);
    const planDigest = requiredString(result, "planDigest");
    return {
      planDigest,
      planArtifact: parsePlanArtifact(result, job.planRun.id, planDigest),
      ...(stringArray(result, "requiredProviders")
        ? { requiredProviders: stringArray(result, "requiredProviders") }
        : {}),
      ...(stringValue(result, "sourceCommit")
        ? { sourceCommit: stringValue(result, "sourceCommit") }
        : {}),
      ...(stringValue(result, "providerLockDigest")
        ? { providerLockDigest: stringValue(result, "providerLockDigest") }
        : {}),
      ...(providerInstallation(result)
        ? { providerInstallation: providerInstallation(result) }
        : {}),
      ...(recordValue(result, "summary")
        ? {
            summary: recordValue(
              result,
              "summary",
            ) as OpenTofuPlanResult["summary"],
          }
        : {}),
      ...(planResourceChanges(result)
        ? { planResourceChanges: planResourceChanges(result) }
        : {}),
      diagnostics: diagnostics(result),
    };
  }

  async apply(job: OpenTofuApplyJob): Promise<OpenTofuApplyResult> {
    assertNoObjectStoreStateAdoption(job);
    await this.restoreSourceArchive(job.applyRun.id, job.sourceArchive);
    await copyRunnerLocalPlanArtifact(
      this.transport,
      job.applyRun.id,
      job.planRun.id,
      job.planArtifact,
    );
    const result = await runRunner(
      this.transport,
      "apply",
      job.applyRun.id,
      job,
    );
    return {
      ...(recordValue(result, "outputs")
        ? {
            outputs: recordValue(
              result,
              "outputs",
            ) as OpenTofuApplyResult["outputs"],
          }
        : {}),
      ...(stringValue(result, "stateDigest")
        ? { stateDigest: stringValue(result, "stateDigest") }
        : {}),
      ...(stringValue(result, "rawOutputRef")
        ? { rawOutputRef: stringValue(result, "rawOutputRef") }
        : {}),
      ...(providerInstallation(result)
        ? { providerInstallation: providerInstallation(result) }
        : {}),
      diagnostics: diagnostics(result),
    };
  }

  async destroy(job: OpenTofuDestroyJob): Promise<OpenTofuDestroyResult> {
    assertNoObjectStoreStateAdoption(job);
    await this.restoreSourceArchive(job.applyRun.id, job.sourceArchive);
    await copyRunnerLocalPlanArtifact(
      this.transport,
      job.applyRun.id,
      job.planRun.id,
      job.planArtifact,
    );
    const result = await runRunner(
      this.transport,
      "destroy",
      job.applyRun.id,
      job,
    );
    return {
      ...(providerInstallation(result)
        ? { providerInstallation: providerInstallation(result) }
        : {}),
      diagnostics: diagnostics(result),
    };
  }

  async release(job: ReleaseCommandRunJob): Promise<ReleaseCommandRunResult> {
    await this.restoreSourceArchive(job.runId, {
      ref: job.sourceSnapshot.archiveRef,
      digest: job.sourceSnapshot.archiveDigest,
    });
    const result = await runRunner(this.transport, "release", job.runId, {
      release: { commands: job.commands },
      outputs: job.nonSensitiveOutputs,
      ...(job.credentials ? { credentials: job.credentials } : {}),
      activation: {
        applyRunId: job.applyRunId,
        ...(job.workspaceId ? { workspaceId: job.workspaceId } : {}),
        capsuleId: job.capsuleId,
        stateVersionId: job.stateVersionId,
      },
    });
    return {
      status: "succeeded",
      runId: stringValue(result, "runId") ?? job.runId,
      commandCount: numberValue(result, "commandCount") ?? job.commands.length,
      ...(stringValue(result, "stdout")
        ? { stdout: stringValue(result, "stdout") }
        : {}),
    };
  }

  async sourceSync(
    job: OpenTofuSourceSyncJob,
  ): Promise<OpenTofuSourceSyncResult> {
    const result = await runRunner(this.transport, "source_sync", job.runId, {
      action: "source_sync",
      runId: job.runId,
      source: job.source,
      archiveRef: job.archiveRef,
      ...(job.reuseSnapshot ? { reuseSnapshot: job.reuseSnapshot } : {}),
      ...(job.credentials ? { credentials: job.credentials } : {}),
    });
    const archive = recordValue(result, "sourceArchive");
    const archiveDigest =
      stringValue(result, "archiveDigest") ??
      (archive ? stringValue(archive, "digest") : undefined);
    const archiveSizeBytes =
      numberValue(result, "archiveSizeBytes") ??
      (archive ? numberValue(archive, "sizeBytes") : undefined);
    const archiveRef =
      stringValue(result, "archiveRef") ??
      (archive ? stringValue(archive, "ref") : undefined);
    const repositoryInstallMetadata =
      repositoryInstallMetadataFromRunnerResult(result);
    const resolvedCommit = requiredString(result, "resolvedCommit");
    if (!archiveDigest || archiveSizeBytes === undefined) {
      throw new Error(`source_sync ${job.runId} returned no archive metadata`);
    }
    const bytes = await fetchRunnerArtifact(
      this.transport,
      job.runId,
      `/runs/${encodeURIComponent(job.runId)}/artifacts/source-archive`,
    );
    await assertDigest(bytes, archiveDigest, "source_sync archive");
    await this.archiveStore.write(job.archiveRef, bytes);
    const phaseTimings = phaseTimingsFromRunnerResult(result);
    return {
      resolvedCommit,
      archiveDigest,
      archiveSizeBytes,
      ...(repositoryInstallMetadata ? { repositoryInstallMetadata } : {}),
      ...(archiveRef ? { archiveRef } : {}),
      ...(phaseTimings ? { phaseTimings } : {}),
    };
  }

  async readCapsuleSourceFiles(
    job: OpenTofuCapsuleSourceFilesJob,
  ): Promise<readonly OpenTofuCapsuleSourceFile[]> {
    await this.restoreSourceArchive(job.runId, {
      ref: job.sourceSnapshot.archiveRef,
      digest: job.sourceSnapshot.archiveDigest,
    });
    const result = await runRunner(
      this.transport,
      "compatibility_check",
      job.runId,
      {
        source: {
          ...(job.modulePath ? { modulePath: job.modulePath } : {}),
        },
      },
    );
    const files = result.files;
    if (!Array.isArray(files)) {
      throw new Error(`compatibility_check ${job.runId} returned no files`);
    }
    return files.map((entry) => {
      if (!isRecord(entry)) {
        throw new Error("compatibility_check file entry must be an object");
      }
      const path = requiredString(entry, "path");
      const text = requiredString(entry, "text");
      return { path, text };
    });
  }

  private async restoreSourceArchive(
    runId: string,
    sourceArchive: OpenTofuPlanJob["sourceArchive"],
  ): Promise<void> {
    if (!sourceArchive) return;
    const bytes = await this.archiveStore.read(sourceArchive.ref);
    await assertDigest(bytes, sourceArchive.digest, "source archive");
    const response = await this.transport.fetch(
      `/runs/${encodeURIComponent(runId)}/source-archive/restore`,
      {
        method: "PUT",
        headers: { "content-type": "application/zstd" },
        body: arrayBufferFromBytes(bytes),
      },
    );
    if (!response.ok) {
      throw new Error(
        `OpenTofu runner failed to restore source archive for ${runId}: ${await response.text()}`,
      );
    }
  }
}

const inProcessRunnerTransport: RunnerTransport = {
  fetch: async (path, init) =>
    await handleRunnerRequest(
      new Request(`https://local-opentofu-runner${path}`, init),
    ),
};

function httpRunnerTransport(baseUrl: string): RunnerTransport {
  const endpoint = normalizeRunnerBaseUrl(baseUrl);
  return {
    fetch: async (path, init) => await fetch(new URL(path, endpoint), init),
  };
}

function normalizeRunnerBaseUrl(baseUrl: string): URL {
  const trimmed = baseUrl.trim();
  if (trimmed.length === 0) {
    throw new Error("OpenTofu runner base URL must not be empty");
  }
  const url = new URL(trimmed);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(
      `unsupported OpenTofu runner URL protocol: ${url.protocol}`,
    );
  }
  if (!url.pathname.endsWith("/")) {
    url.pathname = `${url.pathname}/`;
  }
  return url;
}

async function copyRunnerLocalPlanArtifact(
  transport: RunnerTransport,
  applyRunId: string,
  planRunId: string,
  artifact: OpenTofuPlanArtifact,
): Promise<void> {
  const sourceRunId = runnerLocalPlanRunId(artifact) ?? planRunId;
  const bytes = await fetchRunnerArtifact(
    transport,
    sourceRunId,
    `/runs/${encodeURIComponent(sourceRunId)}/artifacts/tfplan`,
  );
  await assertDigest(bytes, artifact.digest, "plan artifact");
  const response = await transport.fetch(
    `/runs/${encodeURIComponent(applyRunId)}/artifacts/tfplan`,
    {
      method: "PUT",
      headers: { "content-type": "application/vnd.opentofu.plan" },
      body: arrayBufferFromBytes(bytes),
    },
  );
  if (!response.ok) {
    throw new Error(
      `OpenTofu runner failed to restore plan artifact for ${applyRunId}: ${await response.text()}`,
    );
  }
}

function runnerLocalPlanRunId(
  artifact: OpenTofuPlanArtifact,
): string | undefined {
  return /^runner-local:\/\/([^/]+)\/tfplan$/.exec(artifact.ref)?.[1];
}

async function runRunner(
  transport: RunnerTransport,
  action:
    | "plan"
    | "apply"
    | "destroy"
    | "compatibility_check"
    | "source_sync"
    | "release",
  runId: string,
  request: unknown,
): Promise<Record<string, unknown>> {
  const response = await transport.fetch(`/runs/${encodeURIComponent(runId)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      kind: "takosumi.opentofu-run@v1",
      action,
      runId,
      requestedAt: new Date().toISOString(),
      request,
    }),
  });
  const text = await response.text();
  const body = text.trim().length > 0 ? parseObject(text) : {};
  if (!response.ok) {
    const reason = stringValue(body, "errorCode");
    const detail =
      stringValue(body, "detail") ??
      stringValue(body, "error") ??
      stringValue(body, "stderr") ??
      text.slice(0, 500);
    throw new OpenTofuRunnerExecutionError(
      `OpenTofu runner rejected ${action} run ${runId}: ${response.status}${detail ? ` (${detail})` : ""}`,
      { ...(reason ? { reason } : {}) },
    );
  }
  return body;
}

async function fetchRunnerArtifact(
  transport: RunnerTransport,
  runId: string,
  path: string,
): Promise<Uint8Array> {
  const response = await transport.fetch(path, { method: "GET" });
  if (!response.ok) {
    throw new Error(
      `OpenTofu runner artifact fetch failed for ${runId}: ${response.status} ${await response.text()}`,
    );
  }
  return new Uint8Array(await response.arrayBuffer());
}

function parsePlanArtifact(
  result: Record<string, unknown>,
  runId: string,
  planDigest: string,
): OpenTofuPlanArtifact {
  const artifact = recordValue(result, "planArtifact");
  if (!artifact) {
    throw new Error(`OpenTofu runner plan ${runId} returned no planArtifact`);
  }
  const kind = requiredString(artifact, "kind");
  const ref = requiredString(artifact, "ref");
  const digest = requiredString(artifact, "digest");
  if (digest !== planDigest) {
    throw new Error(
      `OpenTofu runner plan ${runId} returned a planArtifact digest that does not match planDigest`,
    );
  }
  return {
    kind,
    ref,
    digest,
    ...(stringValue(artifact, "contentType")
      ? { contentType: stringValue(artifact, "contentType") }
      : {}),
    ...(numberValue(artifact, "sizeBytes") !== undefined
      ? { sizeBytes: numberValue(artifact, "sizeBytes") }
      : {}),
    ...(numberValue(artifact, "createdAt") !== undefined
      ? { createdAt: numberValue(artifact, "createdAt") }
      : {}),
  };
}

function providerInstallation(
  result: Record<string, unknown>,
): OpenTofuPlanResult["providerInstallation"] | undefined {
  const value = result.providerInstallation;
  if (!Array.isArray(value)) return undefined;
  const rows = value.flatMap((entry): ProviderInstallationEvidence[] => {
    if (!isRecord(entry)) return [];
    const provider = stringValue(entry, "provider");
    const method = stringValue(entry, "installationMethod");
    if (
      !provider ||
      (method !== "filesystem_mirror" &&
        method !== "direct" &&
        method !== "unknown")
    ) {
      return [];
    }
    return [
      {
        provider,
        mirrored: entry.mirrored === true,
        installationMethod: method,
        ...(stringValue(entry, "mirrorPath")
          ? { mirrorPath: stringValue(entry, "mirrorPath") }
          : {}),
        ...(entry.attested === true ? { attested: true } : {}),
        ...(stringValue(entry, "attestationMethod") ===
        "forced_filesystem_mirror_init"
          ? { attestationMethod: "forced_filesystem_mirror_init" as const }
          : {}),
        ...(stringValue(entry, "cliConfigDigest")
          ? { cliConfigDigest: stringValue(entry, "cliConfigDigest") }
          : {}),
        ...(stringValue(entry, "installedPath")
          ? { installedPath: stringValue(entry, "installedPath") }
          : {}),
        ...(stringValue(entry, "installedDigest")
          ? { installedDigest: stringValue(entry, "installedDigest") }
          : {}),
      },
    ];
  });
  return rows.length > 0 ? rows : undefined;
}

function planResourceChanges(
  result: Record<string, unknown>,
): readonly PlanResourceChange[] | undefined {
  const value = result.planResourceChanges;
  if (!Array.isArray(value)) return undefined;
  const rows = value.flatMap((entry): PlanResourceChange[] => {
    if (!isRecord(entry)) return [];
    const address = stringValue(entry, "address");
    const type = stringValue(entry, "type");
    const actions = stringArray(entry, "actions");
    if (!address || !type || !actions) return [];
    const scope = recordValue(entry, "scope");
    const projectedScope = normalizePlanResourceScope(scope);
    return [
      {
        address,
        type,
        actions,
        ...(projectedScope ? { scope: projectedScope } : {}),
      },
    ];
  });
  return rows.length > 0 ? rows : undefined;
}

function diagnostics(
  result: Record<string, unknown>,
): readonly RunDiagnostic[] {
  const stderr = stringValue(result, "stderr");
  return stderr && stderr.trim().length > 0
    ? [{ severity: "warning", message: stderr }]
    : [];
}

function repositoryInstallMetadataFromRunnerResult(
  result: Record<string, unknown>,
): OpenTofuSourceSyncResult["repositoryInstallMetadata"] | undefined {
  const value = recordValue(result, "repositoryInstallMetadata");
  if (!value) return undefined;
  const status = stringValue(value, "status");
  if (status === "absent") return { status };
  if (status === "present") {
    const text = stringValue(value, "text");
    return text === undefined ? undefined : { status, text };
  }
  if (status === "invalid") {
    const reason = stringValue(value, "reason");
    if (reason === "not_regular_file" || reason === "too_large") {
      return { status, reason };
    }
  }
  return undefined;
}

function phaseTimingsFromRunnerResult(
  result: Record<string, unknown>,
): NonNullable<OpenTofuSourceSyncResult["phaseTimings"]> | undefined {
  const value = result.phaseTimings;
  if (!Array.isArray(value)) return undefined;
  const timings = value.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const phase = stringValue(entry, "phase");
    const startedAt = stringValue(entry, "startedAt");
    const finishedAt = stringValue(entry, "finishedAt");
    const durationMs = numberValue(entry, "durationMs");
    if (!phase || !/^[a-z][a-z0-9_]{0,63}$/u.test(phase)) return [];
    if (!startedAt || !Number.isFinite(Date.parse(startedAt))) return [];
    if (!finishedAt || !Number.isFinite(Date.parse(finishedAt))) return [];
    if (durationMs === undefined || durationMs < 0) return [];
    return [{ phase, startedAt, finishedAt, durationMs }];
  });
  return timings.length > 0 ? timings : undefined;
}

async function assertDigest(
  bytes: Uint8Array,
  expected: string,
  label: string,
): Promise<void> {
  const digest = await digestBytes(bytes);
  if (digest !== expected) {
    throw new Error(
      `${label} digest mismatch: expected ${expected}, got ${digest}`,
    );
  }
}

async function digestBytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    arrayBufferFromBytes(bytes),
  );
  return `sha256:${Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}

function arrayBufferFromBytes(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

function archivePath(root: string, key: string): string {
  if (
    key.length === 0 ||
    key.startsWith("/") ||
    key.includes("\\") ||
    key.includes("\0") ||
    key.split("/").some((segment) => segment === "..") ||
    key.startsWith("workspaces/") === false
  ) {
    throw new Error(`unsafe source archive key: ${key}`);
  }
  const path = resolve(root, key);
  if (path !== root && !path.startsWith(`${root}/`)) {
    throw new Error(`source archive key escapes root: ${key}`);
  }
  return path;
}

function assertNoObjectStoreStateAdoption(job: {
  readonly stateAdoption?: unknown;
}): void {
  if (job.stateAdoption !== undefined) {
    throw new Error(
      "confirmed legacy state adoption requires an object-storage runner; the local runner refuses to start from empty state",
    );
  }
}

function parseObject(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  if (!isRecord(value)) throw new Error("runner response must be an object");
  return value;
}

function requiredString(value: Record<string, unknown>, key: string): string {
  const out = stringValue(value, key);
  if (!out) throw new Error(`${key} is required`);
  return out;
}

function stringValue(
  value: Record<string, unknown>,
  key: string,
): string | undefined {
  const field = value[key];
  return typeof field === "string" && field.length > 0 ? field : undefined;
}

function numberValue(
  value: Record<string, unknown>,
  key: string,
): number | undefined {
  const field = value[key];
  return typeof field === "number" && Number.isFinite(field)
    ? field
    : undefined;
}

function recordValue(
  value: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const field = value[key];
  return isRecord(field) ? field : undefined;
}

function stringArray(
  value: Record<string, unknown>,
  key: string,
): readonly string[] | undefined {
  const field = value[key];
  if (!Array.isArray(field)) return undefined;
  const strings = field.filter(
    (entry): entry is string => typeof entry === "string" && entry.length > 0,
  );
  return strings.length > 0 ? strings : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
