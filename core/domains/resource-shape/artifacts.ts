import type {
  ActorContext,
  JsonValue,
  ResourceArtifactPointer,
  ResourceArtifactRun,
  ResourceArtifactStageResponse,
  ResourceArtifactWriter,
  ResourceArtifactWriteScope,
  ResourceShapeKind,
} from "takosumi-contract";
import type { ArtifactRecord } from "takosumi-contract/runs";
import type { ActivityLedger } from "../activity/mod.ts";
import type {
  OpenTofuControlStore,
  ResourceOperationRun,
} from "../deploy-control/store.ts";
import {
  sha256HexAsync,
  sha256HexOfStringAsync,
} from "../../shared/runtime/hash.ts";
import { formatResourceShapeId } from "./records.ts";

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const PURPOSE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const CONTENT_TYPE_PATTERN = /^[\x21-\x7e]{1,255}$/u;
const MAX_HOST_ARTIFACT_BYTES = 100 * 1024 * 1024;

type ResourceArtifactLedger = Pick<
  OpenTofuControlStore,
  | "beginResourceOperationRun"
  | "getResourceOperationRun"
  | "transitionResourceOperationRun"
  | "putArtifactRecord"
>;

export type ResourceArtifactServiceErrorCode =
  | "artifact_invalid"
  | "artifact_not_supported"
  | "artifact_too_large"
  | "artifact_digest_mismatch"
  | "artifact_idempotency_conflict"
  | "artifact_writer_failed"
  | "artifact_writer_invalid";

export type ResourceArtifactServiceResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: ResourceArtifactServiceErrorCode;
        readonly message: string;
      };
    };

export interface ResourceArtifactStageInput {
  readonly actor: ActorContext;
  readonly space: string;
  readonly kind: ResourceShapeKind;
  readonly name: string;
  readonly purpose: string;
  readonly contentType: string;
  readonly expectedDigest: `sha256:${string}`;
  readonly idempotencyKey: string;
  readonly bytes: Uint8Array;
}

export interface ResourceArtifactServiceDependencies {
  readonly store: ResourceArtifactLedger;
  readonly activity: ActivityLedger;
  readonly writer: ResourceArtifactWriter;
  readonly now?: () => string;
}

/**
 * Canonical immutable artifact ingress for Resource desired state.
 *
 * This service deliberately never reads or mutates Resource, ResolutionLock,
 * NativeResource, Output, or Interface rows. Staging becomes useful only when
 * a later explicit preview/apply references the returned ref and digest.
 */
export class ResourceArtifactService {
  readonly #store: ResourceArtifactLedger;
  readonly #activity: ActivityLedger;
  readonly #writer: ResourceArtifactWriter;
  readonly #now: () => string;

  constructor(deps: ResourceArtifactServiceDependencies) {
    this.#store = deps.store;
    this.#activity = deps.activity;
    this.#writer = deps.writer;
    this.#now = deps.now ?? (() => new Date().toISOString());
  }

  async maximumBytes(
    scope: ResourceArtifactWriteScope,
  ): Promise<ResourceArtifactServiceResult<number>> {
    let admission;
    try {
      admission = await this.#writer.prepare(scope);
    } catch {
      return failure(
        "artifact_writer_failed",
        "artifact storage admission is temporarily unavailable",
      );
    }
    if (!admission) {
      return failure(
        "artifact_not_supported",
        `artifact staging is not installed for ${scope.resourceKind}`,
      );
    }
    if (
      !Number.isSafeInteger(admission.maxBytes) ||
      admission.maxBytes < 1 ||
      admission.maxBytes > MAX_HOST_ARTIFACT_BYTES
    ) {
      return failure(
        "artifact_writer_invalid",
        "artifact storage returned an invalid request size limit",
      );
    }
    return { ok: true, value: admission.maxBytes };
  }

  async stage(
    input: ResourceArtifactStageInput,
  ): Promise<ResourceArtifactServiceResult<ResourceArtifactStageResponse>> {
    const valid = validateStageInput(input);
    if (!valid.ok) return valid;
    const resourceId = formatResourceShapeId(
      input.space,
      input.kind,
      input.name,
    );
    const scope: ResourceArtifactWriteScope = {
      workspaceId: input.space,
      resourceId,
      resourceKind: input.kind,
      resourceName: input.name,
      actorAccountId: input.actor.actorAccountId,
      purpose: input.purpose,
      contentType: input.contentType,
    };
    const admitted = await this.maximumBytes(scope);
    if (!admitted.ok) return admitted;
    if (input.bytes.byteLength > admitted.value) {
      return failure(
        "artifact_too_large",
        `artifact exceeds the host limit of ${admitted.value} bytes`,
      );
    }
    const actualDigest = `sha256:${await sha256HexAsync(input.bytes)}` as const;
    if (actualDigest !== input.expectedDigest) {
      return failure(
        "artifact_digest_mismatch",
        "artifact bytes do not match X-Takosumi-Artifact-Sha256",
      );
    }

    const runIdentity = {
      apiVersion: "takosumi.resource-artifact-run/v1",
      workspaceId: input.space,
      resourceId,
      actorAccountId: input.actor.actorAccountId,
      idempotencyKey: input.idempotencyKey,
    };
    const runIdHash = await canonicalSha256(runIdentity);
    const runId = `run_artifact_${runIdHash.slice(0, 32)}`;
    const operationKey = `sha256:${await sha256HexOfStringAsync(
      canonicalJson({
        ...runIdentity,
        purpose: input.purpose,
        contentType: input.contentType,
        digest: input.expectedDigest,
        sizeBytes: input.bytes.byteLength,
      }),
    )}`;
    const createdAt = this.#now();
    const candidate: ResourceOperationRun = {
      id: runId,
      workspaceId: input.space,
      subject: { kind: "resource", id: resourceId },
      resourceOperation: "artifact",
      resourceOperationKey: operationKey,
      resourceOperationVersion: 1,
      type: "artifact",
      status: "running",
      createdBy: input.actor.actorAccountId,
      createdAt,
      startedAt: createdAt,
    };
    const begun = await this.#store.beginResourceOperationRun(candidate);
    if (begun.status === "conflict") {
      return failure(
        "artifact_idempotency_conflict",
        "Idempotency-Key is already bound to different artifact input",
      );
    }
    let run = begun.run;
    const replayed = begun.status === "existing";

    if (run.status === "succeeded") {
      const pointer = artifactPointerFromRun(run, input.purpose);
      if (!pointer.ok) return pointer;
      await this.#ensureArtifactRecord(run, pointer.value);
      run = await this.#repairAudit(run);
      return {
        ok: true,
        value: { artifact: pointer.value, run: publicRun(run), replayed: true },
      };
    }
    if (run.status !== "running") {
      return failure(
        "artifact_idempotency_conflict",
        `canonical artifact Run is terminal ${run.status}`,
      );
    }

    let written: ResourceArtifactPointer;
    try {
      written = await this.#writer.write({
        ...scope,
        runId,
        expectedDigest: input.expectedDigest,
        bytes: input.bytes,
      });
    } catch {
      // The running Run is intentionally retained. A caller holding the same
      // bytes and idempotency key can safely retry the host write.
      return failure(
        "artifact_writer_failed",
        "artifact storage write is temporarily unavailable",
      );
    }
    const pointerValidation = validateWriterPointer(
      written,
      input.purpose,
      input.expectedDigest,
      input.bytes.byteLength,
    );
    if (!pointerValidation.ok) return pointerValidation;
    const pointer = pointerValidation.value;
    const audit = {
      status: "pending" as const,
      eventId: `act_${runId}`,
      action: "resource.artifact.staged",
      metadata: {
        purpose: pointer.purpose,
        digest: pointer.digest,
        sizeBytes: pointer.sizeBytes,
        resourceKind: input.kind,
      } satisfies Readonly<Record<string, JsonValue>>,
      createdAt: this.#now(),
    };
    const completed: ResourceOperationRun = {
      ...run,
      status: "succeeded",
      finishedAt: this.#now(),
      resourceOperationResult: {
        summary: `staged ${pointer.purpose} artifact`,
        artifact: {
          kind: pointer.purpose,
          ref: pointer.ref,
          digest: pointer.digest,
          sizeBytes: pointer.sizeBytes,
        },
      },
      resourceOperationAudit: audit,
      resourceOperationVersion: run.resourceOperationVersion + 1,
    };
    const transitioned = await this.#store.transitionResourceOperationRun({
      id: run.id,
      operationKey: run.resourceOperationKey,
      expectedVersion: run.resourceOperationVersion,
      expectFrom: ["running"],
      run: completed,
    });
    if (transitioned.won && transitioned.run) {
      run = transitioned.run;
    } else if (transitioned.run?.status === "succeeded") {
      const canonical = artifactPointerFromRun(transitioned.run, input.purpose);
      if (!canonical.ok) return canonical;
      if (!samePointer(canonical.value, pointer)) {
        return failure(
          "artifact_writer_invalid",
          "artifact writer returned a non-idempotent reference for this Run",
        );
      }
      run = transitioned.run;
    } else {
      return failure(
        "artifact_idempotency_conflict",
        "canonical artifact Run changed before it could be completed",
      );
    }

    const canonicalPointer = artifactPointerFromRun(run, input.purpose);
    if (!canonicalPointer.ok) return canonicalPointer;
    await this.#ensureArtifactRecord(run, canonicalPointer.value);
    run = await this.#repairAudit(run);
    return {
      ok: true,
      value: {
        artifact: canonicalPointer.value,
        run: publicRun(run),
        replayed,
      },
    };
  }

  async #ensureArtifactRecord(
    run: ResourceOperationRun,
    pointer: ResourceArtifactPointer,
  ): Promise<void> {
    const record: ArtifactRecord = {
      id: `artifact_${run.id.slice("run_".length)}`,
      runId: run.id,
      kind: pointer.purpose,
      ref: pointer.ref,
      digest: pointer.digest,
      sizeBytes: pointer.sizeBytes,
      createdAt: run.finishedAt ?? run.createdAt,
    };
    await this.#store.putArtifactRecord(record);
  }

  async #repairAudit(run: ResourceOperationRun): Promise<ResourceOperationRun> {
    const audit = run.resourceOperationAudit;
    if (!audit || audit.status === "completed" || run.status !== "succeeded") {
      return run;
    }
    const persisted = await this.#activity.recordIdempotent(
      audit.eventId,
      audit.createdAt,
      {
        workspaceId: run.workspaceId,
        actorId: run.createdBy,
        action: audit.action,
        targetType: "resource",
        targetId: run.subject.id,
        runId: run.id,
        metadata: { ...audit.metadata },
      },
    );
    if (!persisted) return run;
    const acknowledged: ResourceOperationRun = {
      ...run,
      resourceOperationAudit: { ...audit, status: "completed" },
      resourceOperationVersion: run.resourceOperationVersion + 1,
    };
    const transition = await this.#store.transitionResourceOperationRun({
      id: run.id,
      operationKey: run.resourceOperationKey,
      expectedVersion: run.resourceOperationVersion,
      expectFrom: ["succeeded"],
      run: acknowledged,
    });
    return transition.run ?? run;
  }
}

function validateStageInput(
  input: ResourceArtifactStageInput,
): ResourceArtifactServiceResult<true> {
  if (
    input.actor.workspaceId !== undefined &&
    input.actor.workspaceId !== input.space
  ) {
    return failure(
      "artifact_invalid",
      "actor Workspace does not match Resource Space",
    );
  }
  if (
    !PURPOSE_PATTERN.test(input.purpose) ||
    !CONTENT_TYPE_PATTERN.test(input.contentType) ||
    !DIGEST_PATTERN.test(input.expectedDigest) ||
    input.idempotencyKey.length < 8 ||
    input.idempotencyKey.length > 128 ||
    /[^\x21-\x7e]/u.test(input.idempotencyKey)
  ) {
    return failure("artifact_invalid", "invalid artifact staging input");
  }
  return { ok: true, value: true };
}

function validateWriterPointer(
  pointer: ResourceArtifactPointer,
  purpose: string,
  digest: `sha256:${string}`,
  sizeBytes: number,
): ResourceArtifactServiceResult<ResourceArtifactPointer> {
  if (
    pointer.purpose !== purpose ||
    pointer.digest !== digest ||
    pointer.sizeBytes !== sizeBytes ||
    !DIGEST_PATTERN.test(pointer.digest) ||
    pointer.ref.length < 1 ||
    pointer.ref.length > 1024 ||
    /[\s\x00-\x1f\x7f]/u.test(pointer.ref)
  ) {
    return failure(
      "artifact_writer_invalid",
      "artifact writer returned invalid or substituted integrity evidence",
    );
  }
  return { ok: true, value: pointer };
}

function artifactPointerFromRun(
  run: ResourceOperationRun,
  purpose: string,
): ResourceArtifactServiceResult<ResourceArtifactPointer> {
  const evidence = run.resourceOperationResult?.artifact;
  if (!evidence) {
    return failure(
      "artifact_writer_invalid",
      "canonical artifact Run is missing immutable artifact evidence",
    );
  }
  return validateWriterPointer(
    {
      purpose: evidence.kind,
      ref: evidence.ref,
      digest: evidence.digest,
      sizeBytes: evidence.sizeBytes,
    },
    purpose,
    evidence.digest,
    evidence.sizeBytes,
  );
}

function publicRun(run: ResourceOperationRun): ResourceArtifactRun {
  if (
    run.status !== "succeeded" ||
    run.finishedAt === undefined ||
    run.resourceOperation !== "artifact" ||
    run.type !== "artifact"
  ) {
    throw new TypeError(
      "artifact Run public projection requires succeeded state",
    );
  }
  return {
    id: run.id,
    workspaceId: run.workspaceId,
    subject: run.subject,
    resourceOperation: "artifact",
    type: "artifact",
    status: "succeeded",
    createdBy: run.createdBy,
    createdAt: run.createdAt,
    ...(run.startedAt === undefined ? {} : { startedAt: run.startedAt }),
    finishedAt: run.finishedAt,
  };
}

function samePointer(
  left: ResourceArtifactPointer,
  right: ResourceArtifactPointer,
): boolean {
  return (
    left.purpose === right.purpose &&
    left.ref === right.ref &&
    left.digest === right.digest &&
    left.sizeBytes === right.sizeBytes
  );
}

async function canonicalSha256(value: unknown): Promise<string> {
  return await sha256HexOfStringAsync(canonicalJson(value));
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record)
    .sort()
    .filter((key) => record[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function failure<T = never>(
  code: ResourceArtifactServiceErrorCode,
  message: string,
): ResourceArtifactServiceResult<T> {
  return { ok: false, error: { code, message } };
}
