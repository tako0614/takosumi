import type { ResourceShapeKind } from "./resource-shape.ts";

/**
 * Public integrity envelope for one immutable host-backed artifact.
 *
 * `ref` is intentionally opaque. Only the selected host adapter may interpret
 * it; callers persist it as desired-state input and must keep `digest` beside
 * it. Artifact bytes and credentials are never projected through Run, Output,
 * or Interface records.
 */
export interface ResourceArtifactPointer {
  readonly purpose: string;
  readonly ref: string;
  readonly digest: `sha256:${string}`;
  readonly sizeBytes: number;
}

/** Canonical response from Resource-owned immutable artifact staging. */
export interface ResourceArtifactRun {
  readonly id: string;
  readonly workspaceId: string;
  readonly subject: { readonly kind: "resource"; readonly id: string };
  readonly resourceOperation: "artifact";
  readonly type: "artifact";
  readonly status: "succeeded";
  readonly createdBy: string;
  readonly createdAt: string;
  readonly startedAt?: string;
  readonly finishedAt: string;
}

export interface ResourceArtifactStageResponse {
  readonly artifact: ResourceArtifactPointer;
  /** Narrow public projection of the canonical Run; internal CAS evidence is absent. */
  readonly run: ResourceArtifactRun;
  /** True when the idempotency key resolved to an already canonical Run. */
  readonly replayed: boolean;
}

/** Non-secret scope passed to the host artifact storage adapter. */
export interface ResourceArtifactWriteScope {
  readonly workspaceId: string;
  readonly resourceId: string;
  readonly resourceKind: ResourceShapeKind;
  readonly resourceName: string;
  readonly actorAccountId: string;
  readonly purpose: string;
  readonly contentType: string;
}

export interface ResourceArtifactWriteAdmission {
  /** Exact request-body ceiling for this scope. Hosts must also enforce it. */
  readonly maxBytes: number;
}

export interface ResourceArtifactWriteInput extends ResourceArtifactWriteScope {
  /** Canonical Run id; host writes must be idempotent for this key. */
  readonly runId: string;
  readonly expectedDigest: `sha256:${string}`;
  readonly bytes: Uint8Array;
}

/**
 * Host composition port for immutable artifact bytes.
 *
 * OSS owns authorization, digest verification, the Run and ArtifactRecord
 * ledgers, and replay fencing. A host owns physical storage and returns only
 * an opaque immutable reference. `write` MUST return the same canonical
 * pointer when retried with the same `runId` and bytes.
 */
export interface ResourceArtifactWriter {
  prepare(
    scope: ResourceArtifactWriteScope,
  ):
    | ResourceArtifactWriteAdmission
    | undefined
    | Promise<ResourceArtifactWriteAdmission | undefined>;
  write(input: ResourceArtifactWriteInput): Promise<ResourceArtifactPointer>;
}
