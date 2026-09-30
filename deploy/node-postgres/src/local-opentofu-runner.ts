import {
  link,
  mkdir,
  open,
  readFile,
  unlink,
  writeFile,
} from "node:fs/promises";
import { Buffer } from "node:buffer";
import { constants as fsConstants } from "node:fs";
import { dirname, resolve } from "node:path";
import { ObjectKeyArtifactReferenceAllocator } from "../../../core/adapters/storage/artifact-references.ts";
import type {
  OpenTofuApplyJob,
  OpenTofuApplyResult,
  OpenTofuCapsuleSourceFile,
  OpenTofuCapsuleSourceFilesJob,
  OpenTofuDestroyJob,
  OpenTofuDestroyResult,
  OpenTofuPlanJob,
  OpenTofuPlanResult,
  OpenTofuRestoreAuthority,
  OpenTofuRestoreExecutionControl,
  OpenTofuRestoreJob,
  OpenTofuRestoreResult,
  OpenTofuRestoreSourceState,
  OpenTofuRunner,
  OpenTofuSourceSyncJob,
  OpenTofuSourceSyncResult,
  OpenTofuStableSourceTagResolutionJob,
  OpenTofuStableSourceTagResolutionResult,
  ProviderInstallationEvidence,
  ReleaseCommandRunJob,
  ReleaseCommandRunResult,
  RunExecutionControl,
} from "../../../core/domains/deploy-control/mod.ts";
import { DEFAULT_OPENTOFU_RUNNER_EXECUTOR_ID } from "../../../core/domains/deploy-control/mod.ts";
import {
  OpenTofuRunnerExecutionError,
  OpenTofuRunnerInfrastructureError,
} from "../../../core/domains/deploy-control/errors.ts";
import type { SecretBoundaryCrypto } from "../../../core/adapters/secret-store/memory.ts";
import { normalizePlanResourceScope } from "takosumi-contract";
import {
  parseRepositoryManifestSnapshot,
  parseRepositoryModulesSnapshot,
} from "takosumi-contract/sources";
import type {
  DispatchPriorState,
  DispatchStateScope,
  OpenTofuOutputEnvelope,
  DispatchStateAdoption,
  OpenTofuPlanArtifact,
  PlanResourceChange,
  RunnerProfile,
  RunDiagnostic,
  RunExecutionAuthority,
  RunExecutionCommit,
  RunExecutionEvidence,
} from "@takosumi/internal/deploy-control-api";
import { RUN_EXECUTION_EVIDENCE_CONTRACT } from "../../../contract/runs.ts";
import { assertRunExecutionEvidence } from "../../../contract/runs.ts";
import { handleRunnerRequestWithDependencies } from "../../../runner/entrypoint.ts";
import { readResponseBytesWithCap } from "../../../runner/lib/exec.ts";
import { SAVED_PLAN_PREFLIGHT_MAX_BYTES } from "../../../runner/lib/saved_plan_state_metadata.ts";
import { mutationRequestDigest } from "../../../runner/lib/run_completion.ts";
import {
  ABSENT_OPENTOFU_STATE_METADATA,
  assertSavedPlanMatchesState,
  parseOpenTofuStateMetadata,
} from "../../../core/shared/open-tofu-state-metadata.ts";

const LOCAL_PLAN_STATE_METADATA_MAX_BYTES = 4096;
// A 16 MiB state is base64-encoded inside encrypted JSON, then base64-encoded
// again in the v3 envelope. This cap includes both expansions and metadata.
const LOCAL_RECOVERY_STATE_ENVELOPE_MAX_BYTES = 32 * 1024 * 1024;

export const LOCAL_OPENTOFU_RUNNER_PROFILE_ID = "local-opentofu";
const PROVIDER_LOCKFILE_ARTIFACT_MAX_BYTES = 1024 * 1024;
const PROVIDER_LOCKFILE_CONTENT_TYPE = "application/vnd.opentofu.lock.hcl";

interface RunnerTransport {
  fetch(path: string, init?: RequestInit): Promise<Response>;
  readonly requiresCustodyModeHandshake?: boolean;
}

export interface SourceArchiveStore {
  write(key: string, bytes: Uint8Array): Promise<void>;
  read(key: string): Promise<Uint8Array>;
}

export interface LocalOpenTofuStateArtifact {
  readonly stateRef: string;
  readonly workspaceId: string;
  readonly subject: NonNullable<DispatchStateScope["subject"]>;
  readonly environment: string;
  readonly generation: number;
  readonly createdByRunId: string;
  readonly action: "apply" | "destroy" | "restore";
  readonly stateDigest: string;
  readonly stateBytes: Uint8Array;
  readonly result:
    OpenTofuApplyResult | OpenTofuDestroyResult | OpenTofuRestoreResult;
}

/** State-only recovery custody. No runner result or Apply execution evidence exists. */
export interface LocalOpenTofuRecoveryStateArtifact {
  readonly stateRef: string;
  readonly workspaceId: string;
  readonly subject: { readonly kind: "capsule"; readonly id: string };
  readonly environment: string;
  readonly generation: 1;
  readonly createdByRunId: string;
  readonly action: "state_recovery";
  readonly failedApplyRunId: string;
  readonly custodyEvidenceDigest: string;
  readonly stateDigest: string;
  readonly stateBytes: Uint8Array;
  /** Digest of the actual immutable v3 ciphertext, not a caller assertion. */
  readonly encryptedDigest: string;
  readonly result?: never;
}

export interface LocalOpenTofuRawOutputArtifact {
  readonly rawOutputRef: string;
  readonly workspaceId: string;
  readonly subject: NonNullable<DispatchStateScope["subject"]>;
  readonly environment: string;
  readonly generation: number;
  readonly stateRef: string;
  readonly stateDigest: string;
  readonly createdByRunId: string;
  readonly action: "apply";
  readonly outputDigest: string;
  readonly outputs: OpenTofuOutputEnvelope;
}

/** Private immutable lockfile bytes retained by the local encrypted artifact store. */
export interface LocalOpenTofuProviderLockfileArtifact {
  readonly ref: string;
  readonly runId: string;
  readonly digest: string;
  readonly sizeBytes: number;
  readonly bytes: Uint8Array;
}

/**
 * Durable exact-key authority for local-substrate OpenTofu state. A target ref
 * is immutable: replay by the same ApplyRun adopts it, while a different run
 * is fenced before OpenTofu can execute provider side effects.
 */
export interface LocalOpenTofuStateArtifactStore {
  read(stateRef: string): Promise<LocalOpenTofuStateArtifact | LocalOpenTofuRecoveryStateArtifact | undefined>;
  commit(
    artifact: LocalOpenTofuStateArtifact,
  ): Promise<LocalOpenTofuStateArtifact>;
  readRawOutput(
    rawOutputRef: string,
  ): Promise<LocalOpenTofuRawOutputArtifact | undefined>;
  commitRawOutput(
    artifact: LocalOpenTofuRawOutputArtifact,
  ): Promise<LocalOpenTofuRawOutputArtifact>;
  /** Optional for stores predating lockfile continuity; new provider plans fail closed when absent. */
  readProviderLockfile?(
    ref: string,
  ): Promise<LocalOpenTofuProviderLockfileArtifact | undefined>;
  commitProviderLockfile?(
    artifact: LocalOpenTofuProviderLockfileArtifact,
  ): Promise<LocalOpenTofuProviderLockfileArtifact>;
}

/** Explicit staging capability; ordinary runner stores need only the mutation port. */
export interface LocalOpenTofuRecoveryCommitStore extends LocalOpenTofuStateArtifactStore {
  /** Bounded exact-object reader; never falls back to a historical v2 result. */
  readRecovery(stateRef: string): Promise<LocalOpenTofuRecoveryStateArtifact | undefined>;
  commitRecovery(
    artifact: Omit<LocalOpenTofuRecoveryStateArtifact, "encryptedDigest">,
  ): Promise<LocalOpenTofuRecoveryStateArtifact>;
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

export function createFileOpenTofuStateArtifactStore(
  root: string,
  cryptoBoundary: SecretBoundaryCrypto,
): LocalOpenTofuRecoveryCommitStore {
  const normalizedRoot = resolve(root);
  const read = async (
    stateRef: string,
  ): Promise<LocalOpenTofuStateArtifact | LocalOpenTofuRecoveryStateArtifact | undefined> => {
    const path = await stateArtifactPath(normalizedRoot, stateRef);
    const text = await readStateArtifactFile(path);
    if (text === undefined) return undefined;
    return await parseStateArtifactEnvelope(text, stateRef, cryptoBoundary);
  };
  const readRecovery = async (stateRef: string): Promise<LocalOpenTofuRecoveryStateArtifact | undefined> => {
    const path = await stateArtifactPath(normalizedRoot, stateRef);
    const text = await readStateArtifactFile(path, true);
    if (text === undefined) return undefined;
    const artifact = await parseStateArtifactEnvelope(text, stateRef, cryptoBoundary);
    if (artifact.action !== "state_recovery") {
      throw new Error(`local OpenTofu recovery target ${stateRef} is occupied by a mutation`);
    }
    return artifact;
  };
  const readRawOutput = async (
    rawOutputRef: string,
  ): Promise<LocalOpenTofuRawOutputArtifact | undefined> => {
    const path = await rawOutputArtifactPath(normalizedRoot, rawOutputRef);
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      if (isErrno(error, "ENOENT")) return undefined;
      throw error;
    }
    return await parseRawOutputArtifactEnvelope(
      text,
      rawOutputRef,
      cryptoBoundary,
    );
  };
  const readProviderLockfile = async (
    ref: string,
  ): Promise<LocalOpenTofuProviderLockfileArtifact | undefined> => {
    const path = await providerLockfileArtifactPath(normalizedRoot, ref);
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      if (isErrno(error, "ENOENT")) return undefined;
      throw error;
    }
    return await parseProviderLockfileArtifactEnvelope(
      text,
      ref,
      cryptoBoundary,
    );
  };
  return {
    read,
    readRecovery,
    commitRecovery: async (artifact) => {
      await assertLocalRecoveryStateArtifact(artifact);
      const path = await stateArtifactPath(normalizedRoot, artifact.stateRef);
      const artifactDirectory = dirname(path);
      await mkdir(normalizedRoot, { recursive: true });
      await syncDirectory(dirname(normalizedRoot));
      await mkdir(artifactDirectory, { recursive: true });
      await syncDirectory(normalizedRoot);
      const temporaryPath = `${path}.${crypto.randomUUID()}.tmp`;
      const metadata = {
        version: 3 as const, kind: "state_recovery" as const,
        stateRef: artifact.stateRef, workspaceId: artifact.workspaceId,
        subject: artifact.subject, environment: artifact.environment,
        generation: 1 as const, createdByRunId: artifact.createdByRunId,
        action: "state_recovery" as const,
        failedApplyRunId: artifact.failedApplyRunId,
        custodyEvidenceDigest: artifact.custodyEvidenceDigest,
        stateDigest: artifact.stateDigest,
      };
      const sealed = await cryptoBoundary.seal(
        JSON.stringify({ stateBase64: Buffer.from(artifact.stateBytes).toString("base64") }),
        "global", localRecoveryStateArtifactAad(metadata),
      );
      const encryptedDigest = await digestBytes(sealed);
      const envelope = `${JSON.stringify({ ...metadata, encryptedDigest,
        ciphertextBase64: Buffer.from(sealed).toString("base64") })}\n`;
      if (Buffer.byteLength(envelope, "utf8") > LOCAL_RECOVERY_STATE_ENVELOPE_MAX_BYTES) {
        throw new Error("local OpenTofu recovery artifact exceeds envelope size limit");
      }
      try {
        const temporary = await open(temporaryPath, "wx", 0o600);
        try {
          await temporary.writeFile(envelope);
          await temporary.sync();
        } finally {
          await temporary.close();
        }
        try {
          await link(temporaryPath, path);
          await syncDirectory(artifactDirectory);
          const committed = await readRecovery(artifact.stateRef);
          if (!committed ||
            committed.encryptedDigest !== encryptedDigest) {
            throw new Error(`local OpenTofu recovery target ${artifact.stateRef} readback is invalid`);
          }
          assertSameRecoveryState(committed, artifact);
          return committed;
        } catch (error) {
          if (!isErrno(error, "EEXIST")) throw error;
          const existing = await readRecovery(artifact.stateRef);
          if (!existing) {
            throw new Error(`local OpenTofu recovery target ${artifact.stateRef} is already owned by a mutation`);
          }
          assertSameRecoveryState(existing, artifact);
          return existing;
        }
      } finally {
        await unlink(temporaryPath).catch((error) => {
          if (!isErrno(error, "ENOENT")) throw error;
        });
      }
    },
    commit: async (artifact) => {
      await assertLocalStateArtifact(artifact);
      const path = await stateArtifactPath(normalizedRoot, artifact.stateRef);
      const artifactDirectory = dirname(path);
      await mkdir(normalizedRoot, { recursive: true });
      await syncDirectory(dirname(normalizedRoot));
      await mkdir(artifactDirectory, { recursive: true });
      await syncDirectory(normalizedRoot);
      const temporaryPath = `${path}.${crypto.randomUUID()}.tmp`;
      const metadata = {
        version: 2,
        stateRef: artifact.stateRef,
        workspaceId: artifact.workspaceId,
        subject: artifact.subject,
        environment: artifact.environment,
        generation: artifact.generation,
        createdByRunId: artifact.createdByRunId,
        action: artifact.action,
        stateDigest: artifact.stateDigest,
      } as const;
      const sealed = await cryptoBoundary.seal(
        JSON.stringify({
          stateBase64: Buffer.from(artifact.stateBytes).toString("base64"),
          result: artifact.result,
        }),
        "global",
        localStateArtifactAad(metadata),
      );
      const envelope = `${JSON.stringify({
        ...metadata,
        ciphertextBase64: Buffer.from(sealed).toString("base64"),
      })}\n`;
      try {
        const temporary = await open(temporaryPath, "wx", 0o600);
        try {
          await temporary.writeFile(envelope);
          await temporary.sync();
        } finally {
          await temporary.close();
        }
        try {
          // link(2) gives us an atomic, no-replace publication fence. rename(2)
          // would silently overwrite a different ApplyRun's committed state.
          await link(temporaryPath, path);
          await syncDirectory(artifactDirectory);
          return artifact;
        } catch (error) {
          if (!isErrno(error, "EEXIST")) throw error;
          const existing = await read(artifact.stateRef);
          if (!existing) {
            throw new Error(
              `local OpenTofu state ${artifact.stateRef} disappeared during immutable commit`,
            );
          }
          if (existing.action === "state_recovery") {
            throw new Error(`local OpenTofu state ${artifact.stateRef} is already owned by recovery custody`);
          }
          assertSameStateMutation(existing, artifact);
          return existing;
        }
      } finally {
        await unlink(temporaryPath).catch((error) => {
          if (!isErrno(error, "ENOENT")) throw error;
        });
      }
    },
    readRawOutput,
    commitRawOutput: async (artifact) => {
      await assertLocalRawOutputArtifact(artifact);
      const path = await rawOutputArtifactPath(
        normalizedRoot,
        artifact.rawOutputRef,
      );
      const rawOutputRoot = resolve(normalizedRoot, "raw-output");
      const artifactDirectory = dirname(path);
      await mkdir(normalizedRoot, { recursive: true });
      await syncDirectory(dirname(normalizedRoot));
      await mkdir(rawOutputRoot, { recursive: true });
      await syncDirectory(normalizedRoot);
      await mkdir(artifactDirectory, { recursive: true });
      await syncDirectory(rawOutputRoot);
      const temporaryPath = `${path}.${crypto.randomUUID()}.tmp`;
      const metadata = {
        version: 1,
        kind: "raw_output" as const,
        rawOutputRef: artifact.rawOutputRef,
        workspaceId: artifact.workspaceId,
        subject: artifact.subject,
        environment: artifact.environment,
        generation: artifact.generation,
        stateRef: artifact.stateRef,
        stateDigest: artifact.stateDigest,
        createdByRunId: artifact.createdByRunId,
        action: artifact.action,
        outputDigest: artifact.outputDigest,
      } as const;
      const sealed = await cryptoBoundary.seal(
        JSON.stringify({ outputs: artifact.outputs }),
        "global",
        localRawOutputArtifactAad(metadata),
      );
      const envelope = `${JSON.stringify({
        ...metadata,
        ciphertextBase64: Buffer.from(sealed).toString("base64"),
      })}\n`;
      try {
        const temporary = await open(temporaryPath, "wx", 0o600);
        try {
          await temporary.writeFile(envelope);
          await temporary.sync();
        } finally {
          await temporary.close();
        }
        try {
          await link(temporaryPath, path);
          await syncDirectory(artifactDirectory);
          return artifact;
        } catch (error) {
          if (!isErrno(error, "EEXIST")) throw error;
          const existing = await readRawOutput(artifact.rawOutputRef);
          if (!existing) {
            throw new Error(
              `local OpenTofu raw output ${artifact.rawOutputRef} disappeared during immutable commit`,
            );
          }
          assertSameRawOutputMutation(existing, artifact);
          return existing;
        }
      } finally {
        await unlink(temporaryPath).catch((error) => {
          if (!isErrno(error, "ENOENT")) throw error;
        });
      }
    },
    readProviderLockfile,
    commitProviderLockfile: async (artifact) => {
      await assertLocalProviderLockfileArtifact(artifact);
      const path = await providerLockfileArtifactPath(
        normalizedRoot,
        artifact.ref,
      );
      const artifactRoot = resolve(normalizedRoot, "provider-lockfile");
      const artifactDirectory = dirname(path);
      await mkdir(normalizedRoot, { recursive: true });
      await syncDirectory(dirname(normalizedRoot));
      await mkdir(artifactRoot, { recursive: true });
      await syncDirectory(normalizedRoot);
      await mkdir(artifactDirectory, { recursive: true });
      await syncDirectory(artifactRoot);
      const temporaryPath = `${path}.${crypto.randomUUID()}.tmp`;
      const metadata = {
        version: 1,
        kind: "provider_lockfile" as const,
        ref: artifact.ref,
        runId: artifact.runId,
        digest: artifact.digest,
        sizeBytes: artifact.sizeBytes,
      } as const;
      const sealed = await cryptoBoundary.seal(
        JSON.stringify({
          bytesBase64: Buffer.from(artifact.bytes).toString("base64"),
        }),
        "global",
        localProviderLockfileArtifactAad(metadata),
      );
      const envelope = `${JSON.stringify({
        ...metadata,
        ciphertextBase64: Buffer.from(sealed).toString("base64"),
      })}\n`;
      try {
        const temporary = await open(temporaryPath, "wx", 0o600);
        try {
          await temporary.writeFile(envelope);
          await temporary.sync();
        } finally {
          await temporary.close();
        }
        try {
          await link(temporaryPath, path);
          await syncDirectory(artifactDirectory);
          return artifact;
        } catch (error) {
          if (!isErrno(error, "EEXIST")) throw error;
          const existing = await readProviderLockfile(artifact.ref);
          if (!existing) {
            throw new Error(
              `local OpenTofu provider lockfile ${artifact.ref} disappeared during immutable commit`,
            );
          }
          assertSameProviderLockfileArtifact(existing, artifact);
          return existing;
        }
      } finally {
        await unlink(temporaryPath).catch((error) => {
          if (!isErrno(error, "ENOENT")) throw error;
        });
      }
    },
  };
}

export function createLocalOpenTofuRunner(input: {
  readonly archiveStore: SourceArchiveStore;
  readonly stateStore: LocalOpenTofuStateArtifactStore;
}): OpenTofuRunner {
  return new LocalOpenTofuRunner(
    input.archiveStore,
    input.stateStore,
    inProcessRunnerTransport,
  );
}

export function createHttpOpenTofuRunner(input: {
  readonly archiveStore: SourceArchiveStore;
  readonly stateStore: LocalOpenTofuStateArtifactStore;
  readonly baseUrl: string;
}): OpenTofuRunner {
  return new LocalOpenTofuRunner(
    input.archiveStore,
    input.stateStore,
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
    private readonly stateStore: LocalOpenTofuStateArtifactStore,
    private readonly transport: RunnerTransport,
  ) {}

  async plan(
    job: OpenTofuPlanJob,
    control?: RunExecutionControl,
  ): Promise<OpenTofuPlanResult> {
    await this.restoreSourceArchive(
      job.planRun.id,
      job.sourceArchive,
      control?.signal,
    );
    await this.restorePriorState(job.planRun.id, "plan", job, undefined, control?.signal);
    const result = await runRunner(
      this.transport,
      "plan",
      job.planRun.id,
      job,
      control?.signal,
    );
    const planDigest = requiredString(result, "planDigest");
    const providerLockDigest = stringValue(result, "providerLockDigest");
    const providerLockArtifact = parseProviderLockArtifact(
      result,
      job.planRun.id,
      providerLockDigest,
    );
    const durableProviderLockArtifact = await this.persistProviderLockArtifact(
      job.planRun.id,
      providerLockArtifact,
      control?.signal,
    );
    return {
      planDigest,
      planArtifact: parsePlanArtifact(result, job.planRun.id, planDigest),
      ...(stringArray(result, "requiredProviders")
        ? { requiredProviders: stringArray(result, "requiredProviders") }
        : {}),
      ...(stringValue(result, "sourceCommit")
        ? { sourceCommit: stringValue(result, "sourceCommit") }
        : {}),
      ...(providerLockDigest ? { providerLockDigest } : {}),
      ...(durableProviderLockArtifact !== undefined
        ? { providerLockArtifact: durableProviderLockArtifact }
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

  private async persistProviderLockArtifact(
    runId: string,
    artifact: OpenTofuPlanResult["providerLockArtifact"],
    signal?: AbortSignal,
  ): Promise<OpenTofuPlanResult["providerLockArtifact"]> {
    if (!artifact || artifact.kind !== "runner-local") return artifact;
    const commit = this.stateStore.commitProviderLockfile;
    if (typeof commit !== "function") {
      throw new Error(
        "local OpenTofu state artifact store cannot persist provider lockfile artifact",
      );
    }
    const bytes = await fetchRunnerArtifact(
      this.transport,
      runId,
      `/runs/${encodeURIComponent(runId)}/artifacts/tf-lockfile`,
      signal,
      PROVIDER_LOCKFILE_ARTIFACT_MAX_BYTES,
    );
    if (bytes.byteLength !== artifact.sizeBytes) {
      throw new Error(
        `local OpenTofu provider lockfile size mismatch: expected ${artifact.sizeBytes}, got ${bytes.byteLength}`,
      );
    }
    await assertDigest(bytes, artifact.digest, "provider lockfile artifact");
    const durableRef = `local-opentofu://runs/${runId}/provider-lockfile`;
    const committed = await commit({
      ref: durableRef,
      runId,
      digest: artifact.digest,
      sizeBytes: bytes.byteLength,
      bytes,
    });
    if (
      committed.ref !== durableRef ||
      committed.runId !== runId ||
      committed.digest !== artifact.digest ||
      committed.sizeBytes !== bytes.byteLength
    ) {
      throw new Error(
        "local OpenTofu provider lockfile commit returned mismatched immutable identity",
      );
    }
    await assertDigest(
      committed.bytes,
      artifact.digest,
      "local OpenTofu provider lockfile committed bytes",
    );
    return {
      kind: "local",
      ref: committed.ref,
      digest: committed.digest,
      contentType: PROVIDER_LOCKFILE_CONTENT_TYPE,
      sizeBytes: committed.sizeBytes,
      createdAt: Date.now(),
    };
  }

  private async restoreProviderLockArtifact(
    applyRunId: string,
    planRun: OpenTofuApplyJob["planRun"],
    planArtifact: OpenTofuPlanArtifact,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    const artifact = planRun.providerLockArtifact;
    if (artifact === undefined) return undefined; // Historical PlanRun without a lock artifact.
    if (artifact === null) {
      if (planRun.providerLockDigest) {
        throw new Error("provider-free Plan has an unexpected lock digest");
      }
      return undefined;
    }
    const expectedRef = `local-opentofu://runs/${planRun.id}/provider-lockfile`;
    const expectedDigest = planRun.providerLockDigest;
    const expectedSize = artifact.sizeBytes;
    if (
      artifact.kind !== "local" ||
      artifact.ref !== expectedRef ||
      runnerLocalPlanRunId(planArtifact) !== planRun.id ||
      (planRun.planDigest !== undefined &&
        planArtifact.digest !== planRun.planDigest) ||
      !expectedDigest ||
      !/^sha256:[0-9a-f]{64}$/u.test(expectedDigest) ||
      artifact.digest !== expectedDigest ||
      expectedSize === undefined ||
      !Number.isSafeInteger(expectedSize) ||
      expectedSize < 0 ||
      expectedSize > PROVIDER_LOCKFILE_ARTIFACT_MAX_BYTES ||
      (artifact.contentType !== undefined &&
        artifact.contentType !== PROVIDER_LOCKFILE_CONTENT_TYPE)
    ) {
      throw new Error("local reviewed Plan provider lock authority is invalid");
    }
    const read = this.stateStore.readProviderLockfile;
    if (typeof read !== "function") {
      throw new Error("local provider lockfile artifact store is unavailable");
    }
    const committed = await read.call(this.stateStore, expectedRef);
    if (
      !committed ||
      committed.ref !== expectedRef ||
      committed.runId !== planRun.id ||
      committed.digest !== expectedDigest ||
      committed.sizeBytes !== expectedSize ||
      committed.bytes.byteLength !== expectedSize
    ) {
      throw new Error(
        "local reviewed Plan provider lock immutable identity mismatch",
      );
    }
    await assertDigest(
      committed.bytes,
      expectedDigest,
      "reviewed provider lockfile",
    );
    const response = await this.transport.fetch(
      `/runs/${encodeURIComponent(applyRunId)}/provider-lockfile/restore`,
      {
        method: "PUT",
        headers: { "content-type": PROVIDER_LOCKFILE_CONTENT_TYPE },
        body: arrayBufferFromBytes(committed.bytes),
        ...(signal ? { signal } : {}),
      },
    );
    if (!response.ok) {
      throw new Error(
        `local reviewed Plan provider lock restore failed: ${response.status}`,
      );
    }
    const acknowledged: unknown = JSON.parse(
      new TextDecoder().decode(
        await readResponseBytesWithCap(
          response,
          4096,
          "provider lock restore acknowledgement",
        ),
      ),
    );
    if (
      !isRecord(acknowledged) ||
      acknowledged.digest !== expectedDigest ||
      acknowledged.sizeBytes !== expectedSize
    ) {
      throw new Error(
        "local reviewed Plan provider lock restore acknowledgement mismatch",
      );
    }
    return expectedDigest;
  }

  async apply(
    job: OpenTofuApplyJob,
    control?: RunExecutionControl,
  ): Promise<OpenTofuApplyResult> {
    const replay = await this.adoptCommittedStateMutation(
      job.applyRun.id,
      "apply",
      job.stateScope,
    );
    if (replay) {
      const replayResult = replay.result as OpenTofuApplyResult;
      if (replayResult.providerExecutionFailure) return replayResult;
      return await this.confirmRawOutput(job, replay);
    }
    await assertLocalMutationCustodyMode(this.transport);
    let result = await readLocalMutationCompletionBeforePreparation(
      this.transport,
      "apply",
      job.applyRun.id,
      job,
      expectedRestoredProviderLockDigest(job.planRun),
    );
    if (!result) {
      const prepared = await this.preflightSavedPlan(
        job.applyRun.id,
        job,
        job.planRun.id,
        job.planArtifact,
        control?.signal,
      );
      const reservation = await reserveLocalMutationBeforePreparation(
        this.transport,
        "apply",
        job.applyRun.id,
        job,
        expectedRestoredProviderLockDigest(job.planRun),
      );
      await this.restoreSourceArchive(
        job.applyRun.id,
        job.sourceArchive,
        control?.signal,
      );
      await this.restorePriorState(
        job.applyRun.id,
        "apply",
        job,
        prepared.priorStateBytes,
        control?.signal,
      );
      await restoreRunnerLocalPlanArtifact(
        this.transport,
        job.applyRun.id,
        prepared.planBytes,
        control?.signal,
      );
      const restoredProviderLockDigest = await this.restoreProviderLockArtifact(
        job.applyRun.id,
        job.planRun,
        job.planArtifact,
        control?.signal,
      );
      result = await runLocalMutationWithCustody(
        this.transport,
        "apply",
        job.applyRun.id,
        job,
        control?.signal,
        restoredProviderLockDigest,
        reservation,
      );
    }
    if (runnerProviderExecutionFailed(result)) {
      const stateBytes = await fetchRunnerArtifactIfPresent(
        this.transport,
        job.applyRun.id,
        `/runs/${encodeURIComponent(job.applyRun.id)}/artifacts/tfstate`,
        control?.signal,
      );
      const normalizedFailure = failedProviderExecutionResult(
        result,
        stateBytes ? "persisted" : "unavailable",
        stateBytes ? await digestBytes(stateBytes) : undefined,
        "apply",
      );
      const completionDigest = stringValue(result, "stateDigest");
      if (
        Boolean(completionDigest) !== Boolean(stateBytes) ||
        (stateBytes && completionDigest !== (await digestBytes(stateBytes)))
      ) {
        throw new Error("local runner completion state digest mismatch");
      }
      const failedEvidence = stateBytes
        ? mutationExecutionEvidence(
            job,
            "apply",
            normalizedFailure,
            { stateVersionId: requireStateVersionId(job) },
            "provider_failed_state_persisted",
          )
        : undefined;
      const failureWithEvidence = failedEvidence
        ? { ...normalizedFailure, executionEvidence: failedEvidence }
        : normalizedFailure;
      if (!stateBytes) return failureWithEvidence;
      const committed = await this.commitStateMutation(
        job.applyRun.id,
        "apply",
        job.stateScope,
        stateBytes,
        failureWithEvidence,
      );
      return committed.result as OpenTofuApplyResult;
    }
    const stateBytes = await fetchRunnerArtifact(
      this.transport,
      job.applyRun.id,
      `/runs/${encodeURIComponent(job.applyRun.id)}/artifacts/tfstate`,
      control?.signal,
    );
    const stateDigest = await digestBytes(stateBytes);
    const normalizedProviderInstallation = providerInstallation(result);
    const normalizedResult: OpenTofuApplyResult = {
      ...(recordValue(result, "outputs")
        ? {
            outputs: recordValue(
              result,
              "outputs",
            ) as OpenTofuApplyResult["outputs"],
          }
        : {}),
      stateDigest,
      ...(normalizedProviderInstallation
        ? { providerInstallation: normalizedProviderInstallation }
        : {}),
      diagnostics: diagnostics(result),
      executionEvidence: mutationExecutionEvidence(
        job,
        "apply",
        { providerInstallation: normalizedProviderInstallation },
        job.executionEvidenceCommit,
        "committed",
      ),
    };
    const committed = await this.commitStateMutation(
      job.applyRun.id,
      "apply",
      job.stateScope,
      stateBytes,
      normalizedResult,
    );
    return await this.confirmRawOutput(job, committed);
  }

  async destroy(
    job: OpenTofuDestroyJob,
    control?: RunExecutionControl,
  ): Promise<OpenTofuDestroyResult> {
    const replay = await this.adoptCommittedStateMutation(
      job.applyRun.id,
      "destroy",
      job.stateScope,
    );
    if (replay) return replay.result as OpenTofuDestroyResult;
    await assertLocalMutationCustodyMode(this.transport);
    let result = await readLocalMutationCompletionBeforePreparation(
      this.transport,
      "destroy",
      job.applyRun.id,
      job,
      expectedRestoredProviderLockDigest(job.planRun),
    );
    if (!result) {
      const prepared = await this.preflightSavedPlan(
        job.applyRun.id,
        job,
        job.planRun.id,
        job.planArtifact,
        control?.signal,
      );
      const reservation = await reserveLocalMutationBeforePreparation(
        this.transport,
        "destroy",
        job.applyRun.id,
        job,
        expectedRestoredProviderLockDigest(job.planRun),
      );
      await this.restoreSourceArchive(
        job.applyRun.id,
        job.sourceArchive,
        control?.signal,
      );
      await this.restorePriorState(
        job.applyRun.id,
        "destroy",
        job,
        prepared.priorStateBytes,
        control?.signal,
      );
      await restoreRunnerLocalPlanArtifact(
        this.transport,
        job.applyRun.id,
        prepared.planBytes,
        control?.signal,
      );
      const restoredProviderLockDigest = await this.restoreProviderLockArtifact(
        job.applyRun.id,
        job.planRun,
        job.planArtifact,
        control?.signal,
      );
      result = await runLocalMutationWithCustody(
        this.transport,
        "destroy",
        job.applyRun.id,
        job,
        control?.signal,
        restoredProviderLockDigest,
        reservation,
      );
    }
    if (runnerProviderExecutionFailed(result)) {
      const stateBytes = await fetchRunnerArtifactIfPresent(
        this.transport,
        job.applyRun.id,
        `/runs/${encodeURIComponent(job.applyRun.id)}/artifacts/tfstate`,
        control?.signal,
      );
      const normalizedFailure = failedProviderExecutionResult(
        result,
        stateBytes ? "persisted" : "unavailable",
        stateBytes ? await digestBytes(stateBytes) : undefined,
        "destroy",
      );
      const completionDigest = stringValue(result, "stateDigest");
      if (
        Boolean(completionDigest) !== Boolean(stateBytes) ||
        (stateBytes && completionDigest !== (await digestBytes(stateBytes)))
      ) {
        throw new Error("local runner completion state digest mismatch");
      }
      const failedEvidence = stateBytes
        ? mutationExecutionEvidence(
            job,
            "destroy",
            normalizedFailure,
            { stateVersionId: requireStateVersionId(job) },
            "provider_failed_state_persisted",
          )
        : undefined;
      const failureWithEvidence = failedEvidence
        ? { ...normalizedFailure, executionEvidence: failedEvidence }
        : normalizedFailure;
      if (!stateBytes) return failureWithEvidence as OpenTofuDestroyResult;
      const committed = await this.commitStateMutation(
        job.applyRun.id,
        "destroy",
        job.stateScope,
        stateBytes,
        failureWithEvidence,
      );
      return committed.result as OpenTofuDestroyResult;
    }
    const stateBytes = await fetchRunnerArtifact(
      this.transport,
      job.applyRun.id,
      `/runs/${encodeURIComponent(job.applyRun.id)}/artifacts/tfstate`,
      control?.signal,
    );
    const stateDigest = await digestBytes(stateBytes);
    const normalizedProviderInstallation = providerInstallation(result);
    const normalizedResult: OpenTofuDestroyResult = {
      ...(normalizedProviderInstallation
        ? { providerInstallation: normalizedProviderInstallation }
        : {}),
      diagnostics: diagnostics(result),
      stateDigest,
      executionEvidence: mutationExecutionEvidence(
        job,
        "destroy",
        { providerInstallation: normalizedProviderInstallation },
        job.executionEvidenceCommit,
        "committed",
      ),
    };
    const committed = await this.commitStateMutation(
      job.applyRun.id,
      "destroy",
      job.stateScope,
      stateBytes,
      normalizedResult,
    );
    return committed.result as OpenTofuDestroyResult;
  }

  async restore(
    job: OpenTofuRestoreJob,
    control: OpenTofuRestoreExecutionControl,
  ): Promise<OpenTofuRestoreResult> {
    control?.signal?.throwIfAborted();
    const scope = job.stateScope;
    const subject = requiredStateSubject(scope, job.runId);
    const sourceDescriptor = job.sourceState;
    const sourceAuthority = control?.sourceAuthority;
    if (!sourceAuthority || typeof sourceAuthority.readExact !== "function") {
      throw new Error("local OpenTofu restore requires Core source authority");
    }
    let authoritativeSource: OpenTofuRestoreSourceState | undefined;
    try {
      authoritativeSource = await sourceAuthority.readExact();
    } catch (error) {
      throw new Error(
        "local OpenTofu restore source authority is unavailable",
        { cause: error },
      );
    }
    assertExactRestoreSourceAuthority(authoritativeSource, sourceDescriptor);
    control?.signal?.throwIfAborted();

    const source = await this.stateStore.read(sourceDescriptor.stateRef);
    if (!source) {
      throw new Error(
        `local OpenTofu restore source ${sourceDescriptor.stateRef} was not found`,
      );
    }
    const targetSubject = parseStateSubject(scope.subject);
    if (
      !sourceDescriptor.stateVersionId.trim() ||
      sourceDescriptor.workspaceId !== scope.workspaceId ||
      sourceDescriptor.capsuleId.trim() === "" ||
      sourceDescriptor.environment !== scope.environment ||
      !targetSubject ||
      targetSubject.kind !== "capsule" ||
      targetSubject.id !== sourceDescriptor.capsuleId ||
      sourceDescriptor.generation >= scope.generation ||
      source.workspaceId !== sourceDescriptor.workspaceId ||
      source.subject.kind !== "capsule" ||
      source.subject.id !== sourceDescriptor.capsuleId ||
      source.environment !== sourceDescriptor.environment ||
      source.generation !== sourceDescriptor.generation ||
      source.stateRef !== sourceDescriptor.stateRef ||
      source.stateDigest !== sourceDescriptor.digest ||
      source.createdByRunId !== sourceDescriptor.createdByRunId
    ) {
      throw new Error(
        `local OpenTofu restore source ${job.sourceState.stateRef} does not match the exact StateVersion descriptor and restore scope`,
      );
    }
    if (source.action === "state_recovery") {
      await assertLocalRecoveryStateArtifact(source);
    }
    control?.signal?.throwIfAborted();

    // The host allocates the target reference in the StateScope. The local
    // state store's no-replace commit is the immutable acknowledgement fence;
    // retries of the same Restore adopt this exact record.
    const stateRef = scope.stateRef;
    const restoreAuthority: OpenTofuRestoreAuthority = {
      kind: "takosumi.runner-restore-ack@v1",
      version: 1,
      fence: 1,
      operationId: `local-restore:${job.runId}`,
      // Local state artifacts are addressed by content digest rather than an
      // R2 ETag. Keeping the digest as the opaque tag still lets the shared
      // contract carry an exact immutable-object acknowledgement.
      stateEtag: source.stateDigest,
    };
    const result: OpenTofuRestoreResult = {
      state: {
        generation: scope.generation,
        stateRef,
        logicalTargetStateRef: scope.stateRef,
        digest: source.stateDigest,
        runId: job.runId,
        ciphertextLength: source.stateBytes.byteLength,
        restoreAuthority,
      },
    };
    const candidate: LocalOpenTofuStateArtifact = {
      stateRef,
      workspaceId: scope.workspaceId,
      subject,
      environment: scope.environment,
      generation: scope.generation,
      createdByRunId: job.runId,
      action: "restore",
      stateDigest: source.stateDigest,
      stateBytes: source.stateBytes,
      result,
    };
    const existing = await this.stateStore.read(stateRef);
    if (existing) {
      if (
        existing.action !== "restore" ||
        existing.createdByRunId !== job.runId
      ) {
        throw new Error(
          `local OpenTofu restore target ${stateRef} is already owned by a different mutation`,
        );
      }
      await assertLocalStateArtifact(existing);
      assertSameStateMutation(existing, candidate);
      return existing.result as OpenTofuRestoreResult;
    }
    const committed = await this.stateStore.commit(candidate);
    await assertLocalStateArtifact(committed);
    if (committed.action !== "restore") {
      throw new Error(
        "local OpenTofu restore commit returned a non-restore artifact",
      );
    }
    return committed.result as OpenTofuRestoreResult;
  }

  async release(
    job: ReleaseCommandRunJob,
    control?: RunExecutionControl,
  ): Promise<ReleaseCommandRunResult> {
    await this.restoreSourceArchive(
      job.runId,
      {
        ref: job.sourceSnapshot.archiveRef,
        digest: job.sourceSnapshot.archiveDigest,
      },
      control?.signal,
    );
    const result = await runRunner(
      this.transport,
      "release",
      job.runId,
      {
        release: {
          commands: job.commands,
          ...(job.sourceBuild ? { sourceBuild: job.sourceBuild } : {}),
        },
        outputs: job.nonSensitiveOutputs,
        providerConfigurations: job.providerConfigurations,
        ...(job.credentials ? { credentials: job.credentials } : {}),
        activation: {
          applyRunId: job.applyRunId,
          ...(job.workspaceId ? { workspaceId: job.workspaceId } : {}),
          capsuleId: job.capsuleId,
          stateVersionId: job.stateVersionId,
          sourceSnapshotId: job.sourceSnapshot.id,
          sourceCommit: job.sourceSnapshot.resolvedCommit,
        },
      },
      control?.signal,
    );
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
    const repositoryManifest = parseRepositoryManifestSnapshot(
      result.repositoryManifest,
    );
    const repositoryModules = parseRepositoryModulesSnapshot(
      result.repositoryModules,
    );
    const resolvedCommit = requiredString(result, "resolvedCommit");
    if (
      !archiveDigest ||
      archiveSizeBytes === undefined ||
      !repositoryModules
    ) {
      throw new Error(`source_sync ${job.runId} returned incomplete metadata`);
    }
    if (archive && stringValue(archive, "kind") === "object-storage") {
      assertMatchingReusedSourceArchive(
        result,
        archive,
        job.reuseSnapshot,
        resolvedCommit,
      );
    } else {
      const bytes = await fetchRunnerArtifact(
        this.transport,
        job.runId,
        `/runs/${encodeURIComponent(job.runId)}/artifacts/source-archive`,
      );
      await assertDigest(bytes, archiveDigest, "source_sync archive");
      await this.archiveStore.write(job.archiveRef, bytes);
    }
    const phaseTimings = phaseTimingsFromRunnerResult(result);
    return {
      resolvedCommit,
      archiveDigest,
      archiveSizeBytes,
      ...(repositoryInstallMetadata ? { repositoryInstallMetadata } : {}),
      ...(repositoryManifest ? { repositoryManifest } : {}),
      repositoryModules,
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

  async resolveStableSourceTag(
    job: OpenTofuStableSourceTagResolutionJob,
  ): Promise<OpenTofuStableSourceTagResolutionResult> {
    const result = await runRunner(
      this.transport,
      "stable_semver_tag",
      job.runId,
      { action: "stable_semver_tag", url: job.url },
    );
    return {
      tag: requiredString(result, "tag"),
      commit: requiredString(result, "commit"),
    };
  }

  private async restoreSourceArchive(
    runId: string,
    sourceArchive: OpenTofuPlanJob["sourceArchive"],
    signal?: AbortSignal,
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
        ...(signal ? { signal } : {}),
      },
    );
    if (!response.ok) {
      throw new Error(
        `OpenTofu runner failed to restore source archive for ${runId}: ${await response.text()}`,
      );
    }
  }

  private async restorePriorState(
    runId: string,
    action: "plan" | "apply" | "destroy",
    job: {
      readonly stateScope?: OpenTofuPlanJob["stateScope"];
      readonly priorState?: DispatchPriorState;
      readonly stateAdoption?: DispatchStateAdoption;
    },
    capturedStateBytes?: Uint8Array,
    signal?: AbortSignal,
  ): Promise<void> {
    const prior = canonicalLocalPriorState(job);
    const expectedGeneration =
      action === "plan"
        ? (job.stateScope?.generation ?? 0)
        : Math.max(0, (job.stateScope?.generation ?? 0) - 1);
    if (!prior) {
      if (expectedGeneration > 0) {
        throw new Error(
          `local OpenTofu run ${runId} has generation ${expectedGeneration} without an exact prior state descriptor`,
        );
      }
      return;
    }
    if (prior.generation !== expectedGeneration) {
      throw new Error(
        `local OpenTofu exact prior state generation mismatch: expected ${expectedGeneration}`,
      );
    }
    const artifact = capturedStateBytes
      ? undefined
      : await this.stateStore.read(prior.stateRef);
    if (!capturedStateBytes && !artifact) {
      throw new Error(
        `local OpenTofu exact prior state ${prior.stateRef} was not found`,
      );
    }
    if (
      artifact &&
      (artifact.generation !== prior.generation ||
        (prior.digest !== undefined && artifact.stateDigest !== prior.digest) ||
        (prior.createdByRunId !== undefined &&
          artifact.createdByRunId !== prior.createdByRunId))
    ) {
      throw new Error(
        `local OpenTofu exact prior state ${prior.stateRef} does not match its ledger descriptor`,
      );
    }
    if (artifact?.action === "state_recovery") {
      await assertLocalRecoveryStateArtifact(artifact);
    }
    if (job.stateScope && artifact) {
      assertLocalMutationScope(
        artifact,
        {
          ...job.stateScope,
          generation: prior.generation,
          stateRef: prior.stateRef,
        },
        artifact.createdByRunId,
        artifact.action,
      );
    }
    const stateBytes = capturedStateBytes ?? artifact!.stateBytes;
    const response = await this.transport.fetch(
      `/runs/${encodeURIComponent(runId)}/artifacts/tfstate`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: arrayBufferFromBytes(stateBytes),
        ...(signal ? { signal } : {}),
      },
    );
    if (!response.ok) {
      throw new Error(
        `OpenTofu runner failed to restore exact state for ${runId}: ${await response.text()}`,
      );
    }
  }

  private async preflightSavedPlan(
    runId: string,
    job: {
      readonly stateScope?: OpenTofuPlanJob["stateScope"];
      readonly priorState?: DispatchPriorState;
      readonly stateAdoption?: DispatchStateAdoption;
    },
    planRunId: string,
    planArtifact: OpenTofuPlanArtifact,
    signal?: AbortSignal,
  ): Promise<{ readonly planBytes: Uint8Array; readonly priorStateBytes?: Uint8Array }> {
    const sizeBytes = planArtifact.sizeBytes;
    if (sizeBytes !== undefined &&
        (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0 ||
          sizeBytes > SAVED_PLAN_PREFLIGHT_MAX_BYTES)) {
      throw new Error("local reviewed Plan artifact size is invalid");
    }
    const sourceRunId = runnerLocalPlanRunId(planArtifact) ?? planRunId;
    const planBytes = await fetchRunnerArtifact(
      this.transport,
      sourceRunId,
      `/runs/${encodeURIComponent(sourceRunId)}/artifacts/tfplan`,
      signal,
      sizeBytes ?? SAVED_PLAN_PREFLIGHT_MAX_BYTES,
    );
    if (planBytes.byteLength === 0 ||
        (sizeBytes !== undefined && planBytes.byteLength !== sizeBytes)) {
      throw new Error("local reviewed Plan artifact size mismatch");
    }
    await assertDigest(planBytes, planArtifact.digest, "plan artifact");

    const prior = canonicalLocalPriorState(job);
    const expectedGeneration = Math.max(
      0,
      (job.stateScope?.generation ?? 0) - 1,
    );
    let priorStateBytes: Uint8Array | undefined;
    let stateMetadata = ABSENT_OPENTOFU_STATE_METADATA;
    if (!prior) {
      if (expectedGeneration > 0) {
        throw new Error(
          `local OpenTofu run ${runId} has generation ${expectedGeneration} without an exact prior state descriptor`,
        );
      }
    } else {
      if (prior.generation !== expectedGeneration) {
        throw new Error(
          `local OpenTofu exact prior state generation mismatch: expected ${expectedGeneration}`,
        );
      }
      const artifact = await this.stateStore.read(prior.stateRef);
      if (!artifact) {
        throw new Error(
          `local OpenTofu exact prior state ${prior.stateRef} was not found`,
        );
      }
      if (
        artifact.generation !== prior.generation ||
        (prior.digest !== undefined && artifact.stateDigest !== prior.digest) ||
        (prior.createdByRunId !== undefined &&
          artifact.createdByRunId !== prior.createdByRunId)
      ) {
        throw new Error(
          `local OpenTofu exact prior state ${prior.stateRef} does not match its ledger descriptor`,
        );
      }
      if (artifact.action === "state_recovery") {
        await assertLocalRecoveryStateArtifact(artifact);
      }
      if (job.stateScope) {
        assertLocalMutationScope(
          artifact,
          { ...job.stateScope, generation: prior.generation, stateRef: prior.stateRef },
          artifact.createdByRunId,
          artifact.action,
        );
      }
      // Freeze the validated generation: a mutable store buffer must not turn
      // the pre-reservation comparison into a different post-reservation PUT.
      priorStateBytes = new Uint8Array(artifact.stateBytes);
      await assertDigest(priorStateBytes, artifact.stateDigest, "canonical prior state");
      stateMetadata = parseOpenTofuStateMetadata(priorStateBytes);
    }

    let planMetadata: ReturnType<typeof parseOpenTofuStateMetadata>;
    try {
      const response = await this.transport.fetch(
        `/runs/${encodeURIComponent(runId)}/plan-state-metadata`,
        {
          method: "POST",
          headers: {
            "content-type": "application/vnd.opentofu.plan",
            "x-takosumi-plan-digest": planArtifact.digest,
          },
          body: arrayBufferFromBytes(planBytes),
          ...(signal ? { signal } : {}),
        },
      );
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new Error("metadata endpoint rejected request");
      }
      const body = parseObject(
        new TextDecoder().decode(
          await readResponseBytesWithCap(
            response,
            LOCAL_PLAN_STATE_METADATA_MAX_BYTES,
            "saved Plan state metadata",
          ),
        ),
      );
      if (
        typeof body.lineage !== "string" ||
        !Number.isSafeInteger(body.serial) ||
        (body.serial as number) < 0
      ) {
        throw new Error("metadata response invalid");
      }
      planMetadata = { lineage: body.lineage, serial: body.serial as number };
    } catch {
      throw new Error("local saved Plan metadata preflight failed");
    }
    try {
      assertSavedPlanMatchesState(planMetadata, stateMetadata);
    } catch {
      throw new Error("local saved Plan metadata preflight failed");
    }
    return { planBytes, ...(priorStateBytes ? { priorStateBytes } : {}) };
  }

  private async adoptCommittedStateMutation(
    runId: string,
    action: "apply" | "destroy",
    scope: OpenTofuApplyJob["stateScope"],
  ): Promise<LocalOpenTofuStateArtifact | undefined> {
    if (!scope) {
      throw new Error(
        `local OpenTofu ${action} ${runId} requires a durable stateScope`,
      );
    }
    const existing = await this.stateStore.read(scope.stateRef);
    if (!existing) return undefined;
    if (
      existing.createdByRunId !== runId ||
      existing.generation !== scope.generation ||
      existing.action !== action
    ) {
      throw new Error(
        `local OpenTofu state target ${scope.stateRef} is already owned by ApplyRun ${existing.createdByRunId}`,
      );
    }
    assertLocalMutationScope(existing, scope, runId, action);
    return existing;
  }

  private async commitStateMutation(
    runId: string,
    action: "apply" | "destroy",
    scope: OpenTofuApplyJob["stateScope"],
    stateBytes: Uint8Array,
    result: OpenTofuApplyResult | OpenTofuDestroyResult,
  ): Promise<LocalOpenTofuStateArtifact> {
    if (!scope) {
      throw new Error(
        `local OpenTofu ${action} ${runId} requires a durable stateScope`,
      );
    }
    const stateDigest = await digestBytes(stateBytes);
    return await this.stateStore.commit({
      stateRef: scope.stateRef,
      workspaceId: scope.workspaceId,
      subject: requiredStateSubject(scope, runId),
      environment: scope.environment,
      generation: scope.generation,
      createdByRunId: runId,
      action,
      stateDigest,
      stateBytes,
      result,
    });
  }

  private async confirmRawOutput(
    job: OpenTofuApplyJob,
    state: LocalOpenTofuStateArtifact,
  ): Promise<OpenTofuApplyResult> {
    const scope = job.stateScope;
    const rawOutputRef = job.rawOutputRef?.trim();
    if (!scope || !rawOutputRef) {
      throw new Error(
        `local OpenTofu apply ${job.applyRun.id} requires a durable rawOutputRef`,
      );
    }
    assertLocalMutationScope(state, scope, job.applyRun.id, "apply");
    const result = state.result as OpenTofuApplyResult;
    const outputs = result.outputs ?? {};
    const outputDigest = await digestBytes(
      new TextEncoder().encode(JSON.stringify(outputs)),
    );
    let confirmed: LocalOpenTofuRawOutputArtifact;
    try {
      confirmed = await this.stateStore.commitRawOutput({
        rawOutputRef,
        workspaceId: scope.workspaceId,
        subject: requiredStateSubject(scope, job.applyRun.id),
        environment: scope.environment,
        generation: scope.generation,
        stateRef: state.stateRef,
        stateDigest: state.stateDigest,
        createdByRunId: job.applyRun.id,
        action: "apply",
        outputDigest,
        outputs,
      });
    } catch (error) {
      // State and the replay result are already durable. Mark only this tail as
      // retryable so the consumer redelivers the SAME ApplyRun; replay adopts
      // state and repairs/adopts the exact raw-output coordinate without
      // repeating provider work.
      throw new OpenTofuRunnerInfrastructureError(
        `local OpenTofu apply ${job.applyRun.id} could not confirm durable raw output`,
        {
          reason: "runner_artifact_relay_ambiguous",
          originalError: error,
        },
      );
    }
    return {
      ...result,
      rawOutputRef: confirmed.rawOutputRef,
    };
  }
}

type LocalMutationJob = Pick<
  OpenTofuApplyJob | OpenTofuDestroyJob,
  | "applyRun"
  | "planRun"
  | "planArtifact"
  | "runnerProfile"
  | "executionEvidenceAuthority"
>;

function mutationExecutionEvidence(
  job: LocalMutationJob,
  action: "apply" | "destroy",
  result: OpenTofuApplyResult | OpenTofuDestroyResult | undefined,
  commit: RunExecutionCommit | undefined,
  outcome: "committed" | "provider_failed_state_persisted",
): RunExecutionEvidence {
  const authority = job.executionEvidenceAuthority;
  if (!authority) {
    throw new Error(
      `local OpenTofu ${action} ${job.applyRun.id} requires immutable execution evidence authority`,
    );
  }
  if (!commit) {
    throw new Error(
      `local OpenTofu ${action} ${job.applyRun.id} requires an execution evidence commit coordinate`,
    );
  }
  const providerArtifacts = (result?.providerInstallation ?? [])
    .map((installation) => {
      if (
        installation.attested !== true ||
        !installation.installedDigest ||
        !/^sha256:[0-9a-f]{64}$/u.test(installation.installedDigest)
      ) {
        throw new Error(
          `local OpenTofu ${action} ${job.applyRun.id} lacks immutable provider artifact evidence`,
        );
      }
      return {
        source: installation.provider,
        digest: installation.installedDigest as `sha256:${string}`,
        attested: true as const,
      };
    })
    .sort((left, right) =>
      left.source === right.source
        ? left.digest.localeCompare(right.digest)
        : left.source.localeCompare(right.source),
    );
  const planDigest = job.planRun.planDigest;
  if (
    !planDigest ||
    !/^sha256:[0-9a-f]{64}$/u.test(planDigest) ||
    !/^sha256:[0-9a-f]{64}$/u.test(job.planArtifact.digest)
  ) {
    throw new Error(
      `local OpenTofu ${action} ${job.applyRun.id} lacks immutable plan artifact evidence`,
    );
  }
  return assertRunExecutionEvidence({
    format: RUN_EXECUTION_EVIDENCE_CONTRACT,
    runId: job.applyRun.id,
    planRunId: job.planRun.id,
    action,
    outcome,
    authority: {
      ...authority,
      runnerProfileId: job.runnerProfile.id,
      executorId: job.runnerProfile.executorId,
      providerArtifacts,
    },
    plan: {
      digest: planDigest as `sha256:${string}`,
      artifactDigest: job.planArtifact.digest as `sha256:${string}`,
    },
    commit,
    receipt: { operationId: job.applyRun.id, version: 1, fence: 1 },
    committedAt: new Date().toISOString(),
  });
}

function requireStateVersionId(
  job: Pick<
    OpenTofuApplyJob | OpenTofuDestroyJob,
    "executionEvidenceCommit" | "applyRun"
  >,
): string {
  const commit = job.executionEvidenceCommit;
  if (!commit || !("stateVersionId" in commit) || !commit.stateVersionId) {
    throw new Error(
      `local OpenTofu ${job.applyRun.id} requires a stateVersionId for execution evidence`,
    );
  }
  return commit.stateVersionId;
}

const inProcessRunnerTransport: RunnerTransport = {
  fetch: async (path, init) =>
    await handleRunnerRequestWithDependencies(
      new Request(`https://local-opentofu-runner${path}`, init),
      { mutationCustodyMode: "local-http" },
    ),
};

function httpRunnerTransport(baseUrl: string): RunnerTransport {
  const endpoint = normalizeRunnerBaseUrl(baseUrl);
  return {
    fetch: async (path, init) => await fetch(new URL(path, endpoint), init),
    requiresCustodyModeHandshake: true,
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

async function restoreRunnerLocalPlanArtifact(
  transport: RunnerTransport,
  applyRunId: string,
  bytes: Uint8Array,
  signal?: AbortSignal,
): Promise<void> {
  const response = await transport.fetch(
    `/runs/${encodeURIComponent(applyRunId)}/artifacts/tfplan`,
    {
      method: "PUT",
      headers: { "content-type": "application/vnd.opentofu.plan" },
      body: arrayBufferFromBytes(bytes),
      ...(signal ? { signal } : {}),
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
    | "stable_semver_tag"
    | "release",
  runId: string,
  request: unknown,
  signal?: AbortSignal,
  restoredProviderLockDigest?: string,
  reservation?: string,
): Promise<Record<string, unknown>> {
  const headers = new Headers({ "content-type": "application/json" });
  if (reservation) headers.set("x-takosumi-mutation-reservation", reservation);
  if (restoredProviderLockDigest !== undefined) {
    headers.set(
      "x-takosumi-provider-lock-restore-digest",
      restoredProviderLockDigest,
    );
  }
  const response = await transport.fetch(`/runs/${encodeURIComponent(runId)}`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      kind: "takosumi.opentofu-run@v1",
      action,
      runId,
      requestedAt: new Date().toISOString(),
      request,
    }),
    ...(signal ? { signal } : {}),
  });
  if (
    (!response.ok || response.headers.has("content-type")) &&
    !isJsonResponse(response)
  ) {
    await response.body?.cancel().catch(() => {});
    throw safeRunnerResponseError(action, runId, response.status, false);
  }
  const text = await response.text();
  let body: Record<string, unknown> = {};
  if (text.trim().length > 0) {
    try {
      body = parseObject(text);
    } catch {
      throw safeRunnerResponseError(
        action,
        runId,
        response.status,
        response.ok,
      );
    }
  }
  if (
    !response.ok &&
    !(
      (action === "apply" || action === "destroy") &&
      runnerProviderExecutionFailed(body)
    )
  ) {
    const reason = stringValue(body, "errorCode");
    throw new OpenTofuRunnerExecutionError(
      `OpenTofu runner rejected ${action} run ${runId}: HTTP ${response.status}`,
      {
        reason:
          reason && /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/u.test(reason)
            ? reason
            : "runner_http_error",
        detail: "runner returned a non-success HTTP status",
      },
    );
  }
  return body;
}

/** Fail before workspace preparation if an HTTP runner is not operator-selected
 * for local filesystem custody. Request headers cannot change the mode. */
async function assertLocalMutationCustodyMode(
  transport: RunnerTransport,
): Promise<void> {
  if (!transport.requiresCustodyModeHandshake) return;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await transport.fetch("/healthz", {
      method: "GET",
      signal: controller.signal,
    });
    if (!response.ok || !isJsonResponse(response))
      throw new Error("local runner mutation custody mode mismatch");
    const body = parseObject(
      new TextDecoder().decode(
        await readResponseBytesWithCap(response, 4096, "runner health"),
      ),
    );
    if (body.mutationCustodyMode !== "local-http")
      throw new Error("local runner mutation custody mode mismatch");
  } catch {
    throw new OpenTofuRunnerExecutionError(
      "local runner mutation custody mode mismatch",
      { reason: "runner_mutation_custody_mode_mismatch" },
    );
  } finally {
    clearTimeout(timeout);
  }
}

/** A lost HTTP response is resolved by a read, never a second provider POST. */
async function reserveLocalMutationBeforePreparation(
  transport: RunnerTransport,
  action: "apply" | "destroy",
  runId: string,
  request: unknown,
  restoredProviderLockDigest?: string,
): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await transport.fetch(
      `/runs/${encodeURIComponent(runId)}/mutation-reservation`,
      {
        method: "PUT",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          ...(restoredProviderLockDigest
            ? {
                "x-takosumi-provider-lock-restore-digest":
                  restoredProviderLockDigest,
              }
            : {}),
        },
        body: JSON.stringify({ runId, action, request }),
      },
    );
    if (response.status !== 201 || !isJsonResponse(response))
      throw new Error("local runner mutation reservation is indeterminate");
    const body = parseObject(
      new TextDecoder().decode(
        await readResponseBytesWithCap(
          response,
          1024,
          "local mutation reservation",
        ),
      ),
    );
    if (typeof body.token !== "string" || !/^[0-9a-f-]{36}$/u.test(body.token))
      throw new Error("local runner mutation reservation is indeterminate");
    return body.token;
  } catch {
    throw new OpenTofuRunnerExecutionError(
      "local runner mutation reservation is indeterminate",
      { reason: "runner_mutation_indeterminate" },
    );
  } finally {
    clearTimeout(timeout);
  }
}

function expectedRestoredProviderLockDigest(
  planRun: OpenTofuApplyJob["planRun"],
): string | undefined {
  const artifact = planRun.providerLockArtifact;
  if (
    !artifact ||
    !planRun.providerLockDigest ||
    artifact.digest !== planRun.providerLockDigest
  )
    return undefined;
  return planRun.providerLockDigest;
}

async function readLocalMutationCompletionBeforePreparation(
  transport: RunnerTransport,
  action: "apply" | "destroy",
  runId: string,
  request: unknown,
  restoredProviderLockDigest?: string,
): Promise<Record<string, unknown> | undefined> {
  const requestDigest = await mutationRequestDigest(
    runId,
    action,
    request,
    restoredProviderLockDigest,
  );
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  const deadline = new Promise<never>((_, reject) => {
    controller.signal.addEventListener(
      "abort",
      () =>
        reject(new Error("local runner mutation completion deadline exceeded")),
      { once: true },
    );
  });
  const withinDeadline = <T>(promise: Promise<T>): Promise<T> =>
    Promise.race([promise, deadline]);
  try {
    const response = await withinDeadline(
      transport.fetch(`/runs/${encodeURIComponent(runId)}/completion`, {
        method: "GET",
        signal: controller.signal,
        headers: {
          "x-takosumi-mutation-action": action,
          "x-takosumi-mutation-digest": requestDigest,
          ...(restoredProviderLockDigest
            ? {
                "x-takosumi-provider-lock-restore-digest":
                  restoredProviderLockDigest,
              }
            : {}),
        },
      }),
    );
    if (response.status === 404) {
      if (!isJsonResponse(response))
        throw new Error("local runner mutation completion is indeterminate");
      const missing = parseObject(
        new TextDecoder().decode(
          await withinDeadline(
            readResponseBytesWithCap(
              response,
              16 * 1024,
              "local mutation completion",
            ),
          ),
        ),
      );
      if (missing.status === "absent") return undefined;
      throw new Error("local runner mutation completion is indeterminate");
    }
    if (response.status !== 500 || !isJsonResponse(response)) {
      await response.body?.cancel().catch(() => {});
      throw new Error("local runner mutation completion is indeterminate");
    }
    const body = parseObject(
      new TextDecoder().decode(
        await withinDeadline(
          readResponseBytesWithCap(
            response,
            16 * 1024,
            "local mutation completion",
          ),
        ),
      ),
    );
    if (!runnerProviderExecutionFailed(body))
      throw new Error("local runner mutation completion is indeterminate");
    return body;
  } catch {
    throw new OpenTofuRunnerExecutionError(
      "local runner mutation completion is indeterminate",
      { reason: "runner_mutation_indeterminate" },
    );
  } finally {
    clearTimeout(timeout);
  }
}

async function runLocalMutationWithCustody(
  transport: RunnerTransport,
  action: "apply" | "destroy",
  runId: string,
  request: unknown,
  signal?: AbortSignal,
  restoredProviderLockDigest?: string,
  reservation?: string,
): Promise<Record<string, unknown>> {
  // The digest is an identity check only. The runner stores neither the raw
  // request nor credential material in its completion record.
  let directResult: Record<string, unknown>;
  try {
    directResult = await runRunner(
      transport,
      action,
      runId,
      request,
      signal,
      restoredProviderLockDigest,
      reservation,
    );
  } catch (originalError) {
    try {
      const result = await readLocalMutationCompletionBeforePreparation(
        transport,
        action,
        runId,
        request,
        restoredProviderLockDigest,
      );
      if (result) return result;
    } catch {
      // No authoritative completion is available after a possible dispatch.
    }
    // Preserve only the finite HTTP classification from our own sanitized
    // error. A transport's raw message may contain provider or credential data.
    const status =
      originalError instanceof OpenTofuRunnerExecutionError
        ? /HTTP ([0-9]{3})$/.exec(originalError.message)?.[1]
        : undefined;
    throw new OpenTofuRunnerExecutionError(
      `local runner mutation dispatch response is indeterminate${status ? `: HTTP ${status}` : ""}`,
      {
        reason: "runner_mutation_indeterminate",
        detail: "provider dispatch may have occurred; authoritative completion is unavailable",
      },
    );
  }
  if (!runnerProviderExecutionFailed(directResult)) return directResult;
  const completion = await readLocalMutationCompletionBeforePreparation(
    transport,
    action,
    runId,
    request,
    restoredProviderLockDigest,
  );
  if (!completion)
    throw new OpenTofuRunnerExecutionError(
      "local runner mutation completion is indeterminate",
      { reason: "runner_mutation_indeterminate" },
    );
  return completion;
}

function isJsonResponse(response: Response): boolean {
  return /(?:application|text)\/(?:[a-z0-9.+-]*\+)?json(?:\s*;|$)/iu.test(
    response.headers.get("content-type") ?? "",
  );
}

function safeRunnerResponseError(
  action: string,
  runId: string,
  status: number,
  ok: boolean,
): OpenTofuRunnerExecutionError {
  const responseKind = ok ? "malformed response" : "HTTP error response";
  return new OpenTofuRunnerExecutionError(
    `OpenTofu runner ${responseKind} for ${action} run ${runId}: HTTP ${status}`,
    {
      reason: ok ? "runner_invalid_response" : "runner_http_error",
      detail: ok
        ? "runner response was not a valid JSON object"
        : "runner returned a non-success HTTP status with an invalid response body",
    },
  );
}

function runnerProviderExecutionFailed(
  result: Record<string, unknown>,
): boolean {
  const failure = recordValue(result, "providerExecutionFailure");
  return (
    failure !== undefined &&
    stringValue(failure, "kind") === "provider_execution_failed"
  );
}

function failedProviderExecutionResult(
  result: Record<string, unknown>,
  statePersistence: "persisted" | "unavailable",
  stateDigest: string | undefined,
  action: "apply" | "destroy",
): OpenTofuApplyResult | OpenTofuDestroyResult {
  const errorCode = stringValue(result, "errorCode");
  const failure = {
    providerExecutionFailure: {
      kind: "provider_execution_failed",
      statePersistence,
      ...(errorCode && /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/u.test(errorCode)
        ? { errorCode }
        : {}),
    },
    ...(stateDigest ? { stateDigest } : {}),
    ...(providerInstallation(result)
      ? { providerInstallation: providerInstallation(result) }
      : {}),
    diagnostics: diagnostics(result),
  } as const;
  return action === "apply"
    ? failure
    : {
        ...failure,
      };
}

async function fetchRunnerArtifact(
  transport: RunnerTransport,
  runId: string,
  path: string,
  signal?: AbortSignal,
  maxBytes?: number,
): Promise<Uint8Array> {
  const response = await transport.fetch(path, {
    method: "GET",
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) {
    throw new Error(
      `OpenTofu runner artifact fetch failed for ${runId}: ${response.status}`,
    );
  }
  const declaredLength = response.headers.get("content-length");
  if (maxBytes !== undefined && declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (Number.isSafeInteger(parsedLength) && parsedLength > maxBytes) {
      throw new Error(
        `OpenTofu runner ${path} artifact exceeds ${maxBytes} byte limit`,
      );
    }
  }
  const bytes = maxBytes === undefined
    ? new Uint8Array(await response.arrayBuffer())
    : await readResponseBytesWithCap(response, maxBytes, "OpenTofu runner artifact");
  if (maxBytes !== undefined && bytes.byteLength > maxBytes) {
    throw new Error(
      `OpenTofu runner ${path} artifact exceeds ${maxBytes} byte limit`,
    );
  }
  return bytes;
}

async function fetchRunnerArtifactIfPresent(
  transport: RunnerTransport,
  runId: string,
  path: string,
  signal?: AbortSignal,
): Promise<Uint8Array | undefined> {
  const response = await transport.fetch(path, {
    method: "GET",
    ...(signal ? { signal } : {}),
  });
  if (response.status === 404) return undefined;
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

function parseProviderLockArtifact(
  result: Record<string, unknown>,
  runId: string,
  providerLockDigest: string | undefined,
): OpenTofuPlanResult["providerLockArtifact"] {
  const raw = result.providerLockArtifact;
  if (raw === undefined) return undefined;
  if (raw === null) {
    if (providerLockDigest !== undefined) {
      throw new Error(
        "OpenTofu runner providerLockArtifact is explicitly absent but providerLockDigest is present",
      );
    }
    return null;
  }
  const artifact = recordValue(result, "providerLockArtifact");
  if (!artifact) {
    throw new Error(
      "OpenTofu runner providerLockArtifact must be an object or null",
    );
  }
  const kind = requiredString(artifact, "kind");
  const ref = requiredString(artifact, "ref");
  const digest = requiredString(artifact, "digest");
  const sizeBytes = numberValue(artifact, "sizeBytes");
  if (
    kind !== "runner-local" ||
    !/^sha256:[0-9a-f]{64}$/u.test(digest) ||
    providerLockDigest === undefined ||
    providerLockDigest !== digest ||
    sizeBytes === undefined ||
    !Number.isSafeInteger(sizeBytes) ||
    sizeBytes < 0 ||
    sizeBytes > PROVIDER_LOCKFILE_ARTIFACT_MAX_BYTES ||
    ref !== `runner-local://${runId}/provider-lockfile` ||
    (artifact.contentType !== undefined &&
      artifact.contentType !== PROVIDER_LOCKFILE_CONTENT_TYPE) ||
    (artifact.createdAt !== undefined &&
      (typeof artifact.createdAt !== "number" ||
        !Number.isFinite(artifact.createdAt)))
  ) {
    throw new Error("OpenTofu runner providerLockArtifact metadata is invalid");
  }
  return {
    kind,
    ref,
    digest,
    ...(stringValue(artifact, "contentType")
      ? { contentType: stringValue(artifact, "contentType") }
      : {}),
    sizeBytes,
    ...(typeof artifact.createdAt === "number"
      ? { createdAt: artifact.createdAt }
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
          : stringValue(entry, "attestationMethod") ===
              "runner_observed_installed_artifact"
            ? {
                attestationMethod:
                  "runner_observed_installed_artifact" as const,
              }
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
        ...(entry.importing === true ? { importing: true as const } : {}),
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

function assertMatchingReusedSourceArchive(
  result: Record<string, unknown>,
  archive: Record<string, unknown>,
  reuseSnapshot: OpenTofuSourceSyncJob["reuseSnapshot"],
  resolvedCommit: string,
): void {
  if (
    !reuseSnapshot ||
    resolvedCommit !== reuseSnapshot.resolvedCommit ||
    stringValue(archive, "reusedFromSnapshotId") !== reuseSnapshot.id ||
    stringValue(archive, "ref") !== reuseSnapshot.archiveRef ||
    stringValue(archive, "digest") !== reuseSnapshot.archiveDigest ||
    numberValue(archive, "sizeBytes") !== reuseSnapshot.archiveSizeBytes ||
    stringValue(result, "archiveDigest") !== reuseSnapshot.archiveDigest ||
    numberValue(result, "archiveSizeBytes") !== reuseSnapshot.archiveSizeBytes
  ) {
    throw new Error("source archive reuse does not match reuseSnapshot");
  }
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

async function stateArtifactPath(
  root: string,
  stateRef: string,
): Promise<string> {
  if (!stateRef.trim() || stateRef.includes("\0")) {
    throw new Error("local OpenTofu stateRef must not be empty");
  }
  const key = (await digestBytes(new TextEncoder().encode(stateRef))).slice(
    "sha256:".length,
  );
  return resolve(root, key.slice(0, 2), `${key}.json`);
}

async function readStateArtifactFile(
  path: string,
  recoveryOnly = false,
): Promise<string | undefined> {
  let file: Awaited<ReturnType<typeof open>>;
  try {
    file = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return undefined;
    throw error;
  }
  try {
    const before = await file.stat();
    if (!before.isFile() || !Number.isSafeInteger(before.size) || before.size < 1) {
      throw new Error("local OpenTofu state artifact physical file is invalid");
    }
    // Normal v2 files were written with version first. Preserve their existing
    // size/reader behavior; cap v3 and unrecognized envelopes before allocation.
    const prefix = Buffer.alloc(Math.min(before.size, 32));
    const { bytesRead: prefixRead } = await file.read(prefix, 0, prefix.length, 0);
    if (prefixRead !== prefix.length) {
      throw new Error("local OpenTofu state artifact changed during read");
    }
    const canonicalV2 = prefix.toString("utf8").startsWith('{"version":2,');
    if ((recoveryOnly || !canonicalV2) &&
      before.size > LOCAL_RECOVERY_STATE_ENVELOPE_MAX_BYTES) {
      throw new Error("local OpenTofu recovery artifact exceeds envelope size limit");
    }
    const bytes = Buffer.alloc(before.size);
    for (let offset = 0; offset < bytes.length;) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) throw new Error("local OpenTofu state artifact changed during read");
      offset += bytesRead;
    }
    const after = await file.stat();
    if (after.dev !== before.dev || after.ino !== before.ino ||
      after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
      throw new Error("local OpenTofu state artifact changed during read");
    }
    return bytes.toString("utf8");
  } finally {
    await file.close();
  }
}

async function rawOutputArtifactPath(
  root: string,
  rawOutputRef: string,
): Promise<string> {
  if (!rawOutputRef.trim() || rawOutputRef.includes("\0")) {
    throw new Error("local OpenTofu rawOutputRef must not be empty");
  }
  const key = (await digestBytes(new TextEncoder().encode(rawOutputRef))).slice(
    "sha256:".length,
  );
  return resolve(root, "raw-output", key.slice(0, 2), `${key}.json`);
}

async function providerLockfileArtifactPath(
  root: string,
  ref: string,
): Promise<string> {
  if (
    !ref.startsWith("local-opentofu://runs/") ||
    !ref.endsWith("/provider-lockfile") ||
    ref.includes("..") ||
    ref.includes("\\") ||
    ref.includes("\0")
  ) {
    throw new Error(`unsafe local OpenTofu provider lockfile ref: ${ref}`);
  }
  const runId = ref.slice(
    "local-opentofu://runs/".length,
    -"/provider-lockfile".length,
  );
  if (!runId || runId.includes("/")) {
    throw new Error(`unsafe local OpenTofu provider lockfile ref: ${ref}`);
  }
  const key = (await digestBytes(new TextEncoder().encode(ref))).slice(
    "sha256:".length,
  );
  return resolve(root, "provider-lockfile", key.slice(0, 2), `${key}.json`);
}

async function parseStateArtifactEnvelope(
  text: string,
  expectedStateRef: string,
  cryptoBoundary: SecretBoundaryCrypto,
): Promise<LocalOpenTofuStateArtifact | LocalOpenTofuRecoveryStateArtifact> {
  const envelope = parseObject(text);
  if (envelope.version === 3) {
    return await parseRecoveryStateArtifactEnvelope(envelope, expectedStateRef, cryptoBoundary);
  }
  if (
    envelope.version !== 2 ||
    stringValue(envelope, "stateRef") !== expectedStateRef ||
    !stringValue(envelope, "workspaceId") ||
    !parseStateSubject(envelope.subject) ||
    !stringValue(envelope, "environment") ||
    !Number.isSafeInteger(envelope.generation) ||
    (envelope.generation as number) < 0 ||
    !stringValue(envelope, "createdByRunId") ||
    (envelope.action !== "apply" &&
      envelope.action !== "destroy" &&
      envelope.action !== "restore") ||
    !stringValue(envelope, "stateDigest") ||
    !stringValue(envelope, "ciphertextBase64")
  ) {
    throw new Error(
      `local OpenTofu state artifact ${expectedStateRef} is malformed`,
    );
  }
  const metadata = {
    version: 2,
    stateRef: expectedStateRef,
    workspaceId: requiredString(envelope, "workspaceId"),
    subject: parseStateSubject(envelope.subject)!,
    environment: requiredString(envelope, "environment"),
    generation: envelope.generation as number,
    createdByRunId: requiredString(envelope, "createdByRunId"),
    action: envelope.action,
    stateDigest: requiredString(envelope, "stateDigest"),
  } as const;
  const ciphertext = decodeCanonicalBase64(
    requiredString(envelope, "ciphertextBase64"),
    `local OpenTofu state artifact ${expectedStateRef} ciphertext`,
  );
  const protectedPayload = parseObject(
    await cryptoBoundary.open(
      ciphertext,
      "global",
      localStateArtifactAad(metadata),
    ),
  );
  const stateBytes = decodeCanonicalBase64(
    requiredString(protectedPayload, "stateBase64"),
    `local OpenTofu state artifact ${expectedStateRef} state`,
  );
  const result = recordValue(protectedPayload, "result");
  if (!result) {
    throw new Error(
      `local OpenTofu state artifact ${expectedStateRef} has no protected result`,
    );
  }
  const artifact: LocalOpenTofuStateArtifact = {
    stateRef: expectedStateRef,
    workspaceId: metadata.workspaceId,
    subject: metadata.subject,
    environment: metadata.environment,
    generation: metadata.generation,
    createdByRunId: metadata.createdByRunId,
    action: metadata.action,
    stateDigest: metadata.stateDigest,
    stateBytes,
    result: result as unknown as
      OpenTofuApplyResult | OpenTofuDestroyResult | OpenTofuRestoreResult,
  };
  await assertLocalStateArtifact(artifact);
  return artifact;
}

async function parseRecoveryStateArtifactEnvelope(
  envelope: Record<string, unknown>,
  expectedStateRef: string,
  cryptoBoundary: SecretBoundaryCrypto,
): Promise<LocalOpenTofuRecoveryStateArtifact> {
  const metadata = {
    version: 3 as const,
    kind: "state_recovery" as const,
    stateRef: expectedStateRef,
    workspaceId: requiredString(envelope, "workspaceId"),
    subject: parseStateSubject(envelope.subject),
    environment: requiredString(envelope, "environment"),
    generation: envelope.generation,
    createdByRunId: requiredString(envelope, "createdByRunId"),
    action: "state_recovery" as const,
    failedApplyRunId: requiredString(envelope, "failedApplyRunId"),
    custodyEvidenceDigest: requiredString(envelope, "custodyEvidenceDigest"),
    stateDigest: requiredString(envelope, "stateDigest"),
  };
  if (textKeySet(envelope) !== textKeySet({ ...metadata, encryptedDigest: "", ciphertextBase64: "" }) ||
    envelope.kind !== "state_recovery" || envelope.action !== "state_recovery" ||
    envelope.stateRef !== expectedStateRef || metadata.subject?.kind !== "capsule" ||
    metadata.generation !== 1 || !/^sha256:[0-9a-f]{64}$/u.test(requiredString(envelope, "encryptedDigest")) ||
    !stringValue(envelope, "ciphertextBase64")) {
    throw new Error(`local OpenTofu recovery artifact ${expectedStateRef} is malformed`);
  }
  const exactMetadata = { ...metadata, subject: metadata.subject, generation: 1 as const };
  const ciphertext = decodeCanonicalBase64(requiredString(envelope, "ciphertextBase64"),
    `local OpenTofu recovery artifact ${expectedStateRef} ciphertext`);
  if (await digestBytes(ciphertext) !== envelope.encryptedDigest) {
    throw new Error(`local OpenTofu recovery artifact ${expectedStateRef} encrypted digest mismatch`);
  }
  const payload = parseObject(await cryptoBoundary.open(ciphertext, "global",
    localRecoveryStateArtifactAad(exactMetadata)));
  if (textKeySet(payload) !== "stateBase64") {
    throw new Error(`local OpenTofu recovery artifact ${expectedStateRef} is not resultless`);
  }
  const artifact: LocalOpenTofuRecoveryStateArtifact = {
    stateRef: expectedStateRef, workspaceId: metadata.workspaceId,
    subject: metadata.subject, environment: metadata.environment,
    generation: 1, createdByRunId: metadata.createdByRunId,
    action: "state_recovery", failedApplyRunId: metadata.failedApplyRunId,
    custodyEvidenceDigest: metadata.custodyEvidenceDigest,
    stateDigest: metadata.stateDigest,
    stateBytes: decodeCanonicalBase64(requiredString(payload, "stateBase64"),
      `local OpenTofu recovery artifact ${expectedStateRef} state`),
    encryptedDigest: requiredString(envelope, "encryptedDigest"),
  };
  await assertLocalRecoveryStateArtifact(artifact);
  return artifact;
}

function localRecoveryStateArtifactAad(metadata: {
  readonly version: 3;
  readonly kind: "state_recovery";
  readonly stateRef: string;
  readonly workspaceId: string;
  readonly subject: { readonly kind: "capsule"; readonly id: string };
  readonly environment: string;
  readonly generation: 1;
  readonly createdByRunId: string;
  readonly action: "state_recovery";
  readonly failedApplyRunId: string;
  readonly custodyEvidenceDigest: string;
  readonly stateDigest: string;
}): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({
    domain: "takosumi.local-state-recovery-artifact@v3", ...metadata,
  }));
}

function textKeySet(record: Record<string, unknown>): string {
  return Object.keys(record).sort().join(",");
}

function localStateArtifactAad(metadata: {
  readonly version: 2;
  readonly stateRef: string;
  readonly workspaceId: string;
  readonly subject: NonNullable<DispatchStateScope["subject"]>;
  readonly environment: string;
  readonly generation: number;
  readonly createdByRunId: string;
  readonly action: "apply" | "destroy" | "restore";
  readonly stateDigest: string;
}): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(metadata));
}

async function parseRawOutputArtifactEnvelope(
  text: string,
  expectedRawOutputRef: string,
  cryptoBoundary: SecretBoundaryCrypto,
): Promise<LocalOpenTofuRawOutputArtifact> {
  const envelope = parseObject(text);
  const subject = parseStateSubject(envelope.subject);
  if (
    envelope.version !== 1 ||
    envelope.kind !== "raw_output" ||
    stringValue(envelope, "rawOutputRef") !== expectedRawOutputRef ||
    !stringValue(envelope, "workspaceId") ||
    !subject ||
    !stringValue(envelope, "environment") ||
    !Number.isSafeInteger(envelope.generation) ||
    (envelope.generation as number) < 0 ||
    !stringValue(envelope, "stateRef") ||
    !stringValue(envelope, "stateDigest") ||
    !stringValue(envelope, "createdByRunId") ||
    envelope.action !== "apply" ||
    !stringValue(envelope, "outputDigest") ||
    !stringValue(envelope, "ciphertextBase64")
  ) {
    throw new Error(
      `local OpenTofu raw output artifact ${expectedRawOutputRef} is malformed`,
    );
  }
  const metadata = {
    version: 1,
    kind: "raw_output" as const,
    rawOutputRef: expectedRawOutputRef,
    workspaceId: requiredString(envelope, "workspaceId"),
    subject,
    environment: requiredString(envelope, "environment"),
    generation: envelope.generation as number,
    stateRef: requiredString(envelope, "stateRef"),
    stateDigest: requiredString(envelope, "stateDigest"),
    createdByRunId: requiredString(envelope, "createdByRunId"),
    action: "apply" as const,
    outputDigest: requiredString(envelope, "outputDigest"),
  } as const;
  const protectedPayload = parseObject(
    await cryptoBoundary.open(
      decodeCanonicalBase64(
        requiredString(envelope, "ciphertextBase64"),
        `local OpenTofu raw output artifact ${expectedRawOutputRef} ciphertext`,
      ),
      "global",
      localRawOutputArtifactAad(metadata),
    ),
  );
  const outputs = recordValue(protectedPayload, "outputs");
  if (!outputs) {
    throw new Error(
      `local OpenTofu raw output artifact ${expectedRawOutputRef} has no protected outputs`,
    );
  }
  const artifact: LocalOpenTofuRawOutputArtifact = {
    ...metadata,
    outputs: outputs as OpenTofuOutputEnvelope,
  };
  await assertLocalRawOutputArtifact(artifact);
  return artifact;
}

async function parseProviderLockfileArtifactEnvelope(
  text: string,
  expectedRef: string,
  cryptoBoundary: SecretBoundaryCrypto,
): Promise<LocalOpenTofuProviderLockfileArtifact> {
  const envelope = parseObject(text);
  if (
    envelope.version !== 1 ||
    envelope.kind !== "provider_lockfile" ||
    stringValue(envelope, "ref") !== expectedRef ||
    !stringValue(envelope, "runId") ||
    !stringValue(envelope, "digest") ||
    !Number.isSafeInteger(envelope.sizeBytes) ||
    (envelope.sizeBytes as number) < 0 ||
    (envelope.sizeBytes as number) > PROVIDER_LOCKFILE_ARTIFACT_MAX_BYTES ||
    !stringValue(envelope, "ciphertextBase64")
  ) {
    throw new Error(
      `local OpenTofu provider lockfile ${expectedRef} is malformed`,
    );
  }
  const metadata = {
    version: 1,
    kind: "provider_lockfile" as const,
    ref: expectedRef,
    runId: requiredString(envelope, "runId"),
    digest: requiredString(envelope, "digest"),
    sizeBytes: envelope.sizeBytes as number,
  } as const;
  const protectedPayload = parseObject(
    await cryptoBoundary.open(
      decodeCanonicalBase64(
        requiredString(envelope, "ciphertextBase64"),
        `local OpenTofu provider lockfile ${expectedRef} ciphertext`,
      ),
      "global",
      localProviderLockfileArtifactAad(metadata),
    ),
  );
  const encodedBytes = protectedPayload.bytesBase64;
  if (typeof encodedBytes !== "string") {
    throw new Error(
      `local OpenTofu provider lockfile ${expectedRef} bytes are malformed`,
    );
  }
  const bytes = decodeCanonicalBase64(
    encodedBytes,
    `local OpenTofu provider lockfile ${expectedRef} bytes`,
  );
  const artifact: LocalOpenTofuProviderLockfileArtifact = {
    ...metadata,
    bytes,
  };
  await assertLocalProviderLockfileArtifact(artifact);
  return artifact;
}

function localProviderLockfileArtifactAad(metadata: {
  readonly version: 1;
  readonly kind: "provider_lockfile";
  readonly ref: string;
  readonly runId: string;
  readonly digest: string;
  readonly sizeBytes: number;
}): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(metadata));
}

function localRawOutputArtifactAad(metadata: {
  readonly version: 1;
  readonly kind: "raw_output";
  readonly rawOutputRef: string;
  readonly workspaceId: string;
  readonly subject: NonNullable<DispatchStateScope["subject"]>;
  readonly environment: string;
  readonly generation: number;
  readonly stateRef: string;
  readonly stateDigest: string;
  readonly createdByRunId: string;
  readonly action: "apply";
  readonly outputDigest: string;
}): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(metadata));
}

function decodeCanonicalBase64(value: string, label: string): Uint8Array {
  const bytes = new Uint8Array(Buffer.from(value, "base64"));
  if (Buffer.from(bytes).toString("base64") !== value) {
    throw new Error(`${label} has invalid base64`);
  }
  return bytes;
}

async function assertLocalStateArtifact(
  artifact: LocalOpenTofuStateArtifact,
): Promise<void> {
  if (
    !artifact.stateRef.trim() ||
    !artifact.workspaceId.trim() ||
    !artifact.environment.trim() ||
    !parseStateSubject(artifact.subject) ||
    !Number.isSafeInteger(artifact.generation) ||
    artifact.generation < 0 ||
    !artifact.createdByRunId.trim() ||
    !artifact.stateDigest.trim() ||
    (artifact.action !== "apply" && artifact.action !== "destroy" && artifact.action !== "restore") ||
    !artifact.result || typeof artifact.result !== "object" || Array.isArray(artifact.result)
  ) {
    throw new Error("local OpenTofu state artifact metadata is invalid");
  }
  if (artifact.action === "restore") {
    assertLocalRestoreResult(artifact);
  }
  const resultDigest =
    artifact.action === "restore"
      ? (artifact.result as OpenTofuRestoreResult).state.digest
      : (artifact.result as OpenTofuApplyResult | OpenTofuDestroyResult)
          .stateDigest;
  if (resultDigest !== artifact.stateDigest) {
    throw new Error(
      `local OpenTofu state artifact ${artifact.stateRef} result digest does not match its state`,
    );
  }
  await assertDigest(
    artifact.stateBytes,
    artifact.stateDigest,
    `local OpenTofu state ${artifact.stateRef}`,
  );
}

async function assertLocalRecoveryStateArtifact(
  artifact: Omit<LocalOpenTofuRecoveryStateArtifact, "encryptedDigest"> & { readonly encryptedDigest?: string },
): Promise<void> {
  const safeSegment = (value: unknown): value is string =>
    typeof value === "string" && /^[A-Za-z0-9._-]{1,128}$/u.test(value) && !value.includes("..");
  if (artifact.action !== "state_recovery" || Object.hasOwn(artifact, "result") ||
    artifact.subject?.kind !== "capsule" || artifact.generation !== 1 ||
    !safeSegment(artifact.workspaceId) || !safeSegment(artifact.subject.id) ||
    !safeSegment(artifact.environment) || !safeSegment(artifact.createdByRunId) ||
    !safeSegment(artifact.failedApplyRunId) ||
    !/^sha256:[0-9a-f]{64}$/u.test(artifact.stateDigest) ||
    !/^sha256:[0-9a-f]{64}$/u.test(artifact.custodyEvidenceDigest) ||
    (artifact.encryptedDigest !== undefined &&
      !/^sha256:[0-9a-f]{64}$/u.test(artifact.encryptedDigest)) ||
    !(artifact.stateBytes instanceof Uint8Array) ||
    artifact.stateBytes.byteLength === 0 ||
    artifact.stateBytes.byteLength > 16 * 1024 * 1024 ||
    !validLocalRecoveryStateBytes(artifact.stateBytes) ||
    artifact.stateRef !== new ObjectKeyArtifactReferenceAllocator().allocate({
      kind: "state", workspaceId: artifact.workspaceId,
      subject: artifact.subject, environment: artifact.environment,
      generation: 1,
    })) {
    throw new Error("local OpenTofu recovery artifact scope or custody is invalid");
  }
  await assertDigest(artifact.stateBytes, artifact.stateDigest,
    `local OpenTofu recovery state ${artifact.stateRef}`);
}

function validLocalRecoveryStateBytes(bytes: Uint8Array): boolean {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch { return false; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const state = value as Record<string, unknown>;
  if (state.version !== 4 || !Number.isSafeInteger(state.serial) ||
    (state.serial as number) < 0 ||
    typeof state.lineage !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(state.lineage) ||
    typeof state.terraform_version !== "string" ||
    !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(state.terraform_version) ||
    !state.outputs || typeof state.outputs !== "object" || Array.isArray(state.outputs) ||
    !Array.isArray(state.resources)) return false;
  return state.resources.every((resource) => {
    if (!resource || typeof resource !== "object" || Array.isArray(resource)) return false;
    const row = resource as Record<string, unknown>;
    return (row.module === undefined || typeof row.module === "string") &&
      (row.mode === "managed" || row.mode === "data") &&
      typeof row.type === "string" && row.type.length > 0 &&
      typeof row.name === "string" && row.name.length > 0 &&
      typeof row.provider === "string" && row.provider.length > 0 &&
      Array.isArray(row.instances) && row.instances.every((instance: unknown) => {
        if (!instance || typeof instance !== "object" || Array.isArray(instance)) return false;
        const item = instance as Record<string, unknown>;
        return item.attributes !== null && typeof item.attributes === "object" &&
          !Array.isArray(item.attributes) && Number.isSafeInteger(item.schema_version) &&
          (item.schema_version as number) >= 0;
      });
  });
}

function assertSameRecoveryState(
  existing: LocalOpenTofuRecoveryStateArtifact,
  candidate: Omit<LocalOpenTofuRecoveryStateArtifact, "encryptedDigest">,
): void {
  if (existing.stateRef !== candidate.stateRef ||
    existing.workspaceId !== candidate.workspaceId ||
    !sameStateSubject(existing.subject, candidate.subject) ||
    existing.environment !== candidate.environment ||
    existing.generation !== candidate.generation ||
    existing.createdByRunId !== candidate.createdByRunId ||
    existing.failedApplyRunId !== candidate.failedApplyRunId ||
    existing.custodyEvidenceDigest !== candidate.custodyEvidenceDigest ||
    existing.stateDigest !== candidate.stateDigest) {
    throw new Error(`local OpenTofu recovery target ${candidate.stateRef} is already committed by another custody identity`);
  }
}

function assertLocalRestoreResult(artifact: LocalOpenTofuStateArtifact): void {
  const state = (artifact.result as OpenTofuRestoreResult).state;
  const authority = state?.restoreAuthority;
  if (
    !state ||
    state.generation !== artifact.generation ||
    state.stateRef !== artifact.stateRef ||
    typeof state.logicalTargetStateRef !== "string" ||
    state.logicalTargetStateRef.trim().length === 0 ||
    typeof state.digest !== "string" ||
    state.digest !== artifact.stateDigest ||
    state.runId !== artifact.createdByRunId ||
    !Number.isSafeInteger(state.ciphertextLength) ||
    state.ciphertextLength < 0 ||
    authority?.kind !== "takosumi.runner-restore-ack@v1" ||
    !Number.isSafeInteger(authority.version) ||
    authority.version <= 0 ||
    !Number.isSafeInteger(authority.fence) ||
    authority.fence <= 0 ||
    typeof authority.operationId !== "string" ||
    authority.operationId.trim().length === 0 ||
    typeof authority.stateEtag !== "string" ||
    authority.stateEtag !== artifact.stateDigest
  ) {
    throw new Error(
      `local OpenTofu restore artifact ${artifact.stateRef} acknowledgement is malformed`,
    );
  }
}

function assertExactRestoreSourceAuthority(
  actual: OpenTofuRestoreSourceState | undefined,
  expected: OpenTofuRestoreSourceState,
): asserts actual is OpenTofuRestoreSourceState {
  if (
    !actual ||
    typeof actual.stateVersionId !== "string" ||
    typeof actual.workspaceId !== "string" ||
    typeof actual.capsuleId !== "string" ||
    typeof actual.environment !== "string" ||
    !Number.isSafeInteger(actual.generation) ||
    typeof actual.stateRef !== "string" ||
    typeof actual.digest !== "string" ||
    typeof actual.createdByRunId !== "string" ||
    actual.stateVersionId !== expected.stateVersionId ||
    actual.workspaceId !== expected.workspaceId ||
    actual.capsuleId !== expected.capsuleId ||
    actual.environment !== expected.environment ||
    actual.generation !== expected.generation ||
    actual.stateRef !== expected.stateRef ||
    actual.digest !== expected.digest ||
    actual.createdByRunId !== expected.createdByRunId
  ) {
    throw new Error(
      `local OpenTofu restore source ${expected.stateRef} is not authorized by the exact Core StateVersion authority`,
    );
  }
}

async function assertLocalRawOutputArtifact(
  artifact: LocalOpenTofuRawOutputArtifact,
): Promise<void> {
  if (
    !artifact.rawOutputRef.trim() ||
    !artifact.workspaceId.trim() ||
    !artifact.environment.trim() ||
    !parseStateSubject(artifact.subject) ||
    !Number.isSafeInteger(artifact.generation) ||
    artifact.generation < 0 ||
    !artifact.stateRef.trim() ||
    !artifact.stateDigest.trim() ||
    !artifact.createdByRunId.trim() ||
    !artifact.outputDigest.trim()
  ) {
    throw new Error("local OpenTofu raw output artifact metadata is invalid");
  }
  const digest = await digestBytes(
    new TextEncoder().encode(JSON.stringify(artifact.outputs)),
  );
  if (digest !== artifact.outputDigest) {
    throw new Error(
      `local OpenTofu raw output artifact ${artifact.rawOutputRef} digest mismatch`,
    );
  }
}

async function assertLocalProviderLockfileArtifact(
  artifact: LocalOpenTofuProviderLockfileArtifact,
): Promise<void> {
  if (
    !artifact.ref.startsWith("local-opentofu://runs/") ||
    !artifact.ref.endsWith("/provider-lockfile") ||
    artifact.ref.includes("..") ||
    artifact.ref.includes("\\") ||
    artifact.ref.includes("\0") ||
    !artifact.runId.trim() ||
    !Number.isSafeInteger(artifact.sizeBytes) ||
    artifact.sizeBytes < 0 ||
    artifact.sizeBytes > PROVIDER_LOCKFILE_ARTIFACT_MAX_BYTES ||
    artifact.bytes.byteLength !== artifact.sizeBytes ||
    !/^sha256:[0-9a-f]{64}$/u.test(artifact.digest)
  ) {
    throw new Error(
      "local OpenTofu provider lockfile artifact metadata is invalid",
    );
  }
  const refRunId = artifact.ref.slice(
    "local-opentofu://runs/".length,
    -"/provider-lockfile".length,
  );
  if (!refRunId || refRunId !== artifact.runId || refRunId.includes("/")) {
    throw new Error(
      "local OpenTofu provider lockfile artifact ref does not match runId",
    );
  }
  await assertDigest(
    artifact.bytes,
    artifact.digest,
    `local OpenTofu provider lockfile ${artifact.ref}`,
  );
}

function assertSameStateMutation(
  existing: LocalOpenTofuStateArtifact,
  candidate: LocalOpenTofuStateArtifact,
): void {
  if (
    existing.createdByRunId !== candidate.createdByRunId ||
    existing.workspaceId !== candidate.workspaceId ||
    !sameStateSubject(existing.subject, candidate.subject) ||
    existing.environment !== candidate.environment ||
    existing.generation !== candidate.generation ||
    existing.action !== candidate.action ||
    existing.stateDigest !== candidate.stateDigest ||
    (existing.action === "restore" &&
      JSON.stringify(existing.result) !== JSON.stringify(candidate.result))
  ) {
    throw new Error(
      `local OpenTofu state target ${candidate.stateRef} is already committed by a different mutation`,
    );
  }
}

function assertSameRawOutputMutation(
  existing: LocalOpenTofuRawOutputArtifact,
  candidate: LocalOpenTofuRawOutputArtifact,
): void {
  if (
    existing.createdByRunId !== candidate.createdByRunId ||
    existing.workspaceId !== candidate.workspaceId ||
    !sameStateSubject(existing.subject, candidate.subject) ||
    existing.environment !== candidate.environment ||
    existing.generation !== candidate.generation ||
    existing.stateRef !== candidate.stateRef ||
    existing.stateDigest !== candidate.stateDigest ||
    existing.action !== candidate.action ||
    existing.outputDigest !== candidate.outputDigest
  ) {
    throw new Error(
      `local OpenTofu raw output target ${candidate.rawOutputRef} is already committed by a different mutation`,
    );
  }
}

function assertSameProviderLockfileArtifact(
  existing: LocalOpenTofuProviderLockfileArtifact,
  candidate: LocalOpenTofuProviderLockfileArtifact,
): void {
  if (
    existing.runId !== candidate.runId ||
    existing.ref !== candidate.ref ||
    existing.digest !== candidate.digest ||
    existing.sizeBytes !== candidate.sizeBytes
  ) {
    throw new Error(
      `local OpenTofu provider lockfile target ${candidate.ref} is already committed by a different run`,
    );
  }
}

function requiredStateSubject(
  scope: DispatchStateScope,
  runId: string,
): NonNullable<DispatchStateScope["subject"]> {
  const subject = parseStateSubject(scope.subject);
  if (!subject) {
    throw new Error(
      `local OpenTofu run ${runId} requires an exact state subject`,
    );
  }
  return subject;
}

function parseStateSubject(
  value: unknown,
): NonNullable<DispatchStateScope["subject"]> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const subject = value as { readonly kind?: unknown; readonly id?: unknown };
  if (
    (subject.kind !== "capsule" && subject.kind !== "resource") ||
    typeof subject.id !== "string" ||
    subject.id.trim().length === 0
  ) {
    return undefined;
  }
  return { kind: subject.kind, id: subject.id };
}

function sameStateSubject(
  left: NonNullable<DispatchStateScope["subject"]>,
  right: NonNullable<DispatchStateScope["subject"]>,
): boolean {
  return left.kind === right.kind && left.id === right.id;
}

function assertLocalMutationScope(
  artifact: LocalOpenTofuStateArtifact | LocalOpenTofuRecoveryStateArtifact,
  scope: DispatchStateScope,
  runId: string,
  action: "apply" | "destroy" | "restore" | "state_recovery",
): void {
  const subject = requiredStateSubject(scope, runId);
  if (
    artifact.stateRef !== scope.stateRef ||
    artifact.workspaceId !== scope.workspaceId ||
    !sameStateSubject(artifact.subject, subject) ||
    artifact.environment !== scope.environment ||
    artifact.generation !== scope.generation ||
    artifact.createdByRunId !== runId ||
    artifact.action !== action
  ) {
    throw new Error(
      `local OpenTofu state ${scope.stateRef} does not match its exact workspace, subject, environment, action, generation, and ApplyRun authority`,
    );
  }
}

function canonicalLocalPriorState(job: {
  readonly stateScope?: OpenTofuPlanJob["stateScope"];
  readonly priorState?: DispatchPriorState;
  readonly stateAdoption?: DispatchStateAdoption;
}):
  | {
      readonly stateRef: string;
      readonly generation: number;
      readonly digest?: string;
      readonly legacyDigestMissing?: true;
      readonly createdByRunId?: string;
    }
  | undefined {
  const scoped = job.stateScope?.priorState;
  const direct = job.priorState;
  if (scoped && direct && !samePriorStateDescriptor(scoped, direct)) {
    throw new Error("local OpenTofu prior state descriptors disagree");
  }
  const prior = scoped ?? direct;
  if (prior) {
    if (job.stateAdoption) {
      throw new Error(
        "local OpenTofu state adoption cannot replace canonical prior state",
      );
    }
    if (
      Boolean(prior.digest?.trim()) ===
      (prior.legacyDigestMissing === true)
    ) {
      throw new Error(
        "local OpenTofu prior state requires exactly one of digest or legacyDigestMissing",
      );
    }
    return prior;
  }
  const adoption = job.stateAdoption;
  return adoption
    ? {
        stateRef: adoption.stateRef,
        generation: adoption.stateGeneration,
        digest: adoption.stateDigest,
      }
    : undefined;
}

function samePriorStateDescriptor(
  left: DispatchPriorState,
  right: DispatchPriorState,
): boolean {
  return (
    left.generation === right.generation &&
    left.stateRef === right.stateRef &&
    left.digest === right.digest &&
    left.legacyDigestMissing === right.legacyDigestMissing &&
    left.createdByRunId === right.createdByRunId
  );
}

function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code
  );
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
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
