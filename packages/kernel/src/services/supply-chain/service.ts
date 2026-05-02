import { conflict } from "../../shared/errors.ts";
import type { IsoTimestamp } from "../../shared/time.ts";
import {
  type ArtifactMirrorPolicy,
  type Digest,
  type MirroredArtifactRef,
  type PreparedArtifact,
  type PreparedArtifactReuseExpectation,
  type PreparedArtifactReuseRejectionReason,
  type PreparedArtifactReuseValidation,
  type PreparedArtifactStore,
  type ProtectedReference,
  type ProtectedReferenceStore,
  type SupplyChainRecord,
  type SupplyChainRecordStore,
  validatePreparedArtifactReuse,
} from "../../domains/supply-chain/mod.ts";

export interface SupplyChainServiceStores {
  records: SupplyChainRecordStore;
  artifacts: PreparedArtifactStore;
  protectedReferences: ProtectedReferenceStore;
}

export interface SupplyChainServiceOptions {
  stores: SupplyChainServiceStores;
  idFactory?: () => string;
  clock?: () => Date;
}

export interface ArtifactReuseCheckResult {
  artifact?: PreparedArtifact;
  validation: PreparedArtifactReuseValidation;
}

export interface PreparedArtifactPreApplyValidationInput
  extends PreparedArtifactReuseExpectation {
  readonly deploymentId?: string;
}

export interface PreparedArtifactPreApplyValidationResult {
  readonly artifact: PreparedArtifact;
  readonly validation: PreparedArtifactReuseValidation;
}

export interface PrepareArtifactRequestInput {
  artifactId?: string;
  recordId?: string;
  storageRef: string;
  expiresAt: IsoTimestamp;
  sourceDigest: Digest;
  buildInputDigest: Digest;
  buildEnvironmentDigest: Digest;
  resolvedGraphDigest: Digest;
  packageResolutionDigest: Digest;
  artifactDigest: Digest;
  providerPackageDigests?: readonly Digest[];
  resourceContractPackageDigests?: readonly Digest[];
  dataContractPackageDigests?: readonly Digest[];
  nativeSchemaDigests?: readonly Digest[];
  provenanceRef?: string;
  signatureRef?: string;
  signatureRefs?: readonly string[];
  createdAt?: IsoTimestamp;
  readSetValid?: boolean;
  approvalStateValid?: boolean;
  mirror?: DecideArtifactMirrorInput;
  protection?: RegisterProtectedArtifactWindowsInput;
}

export interface PrepareArtifactRequestResult {
  artifact: PreparedArtifact;
  supplyChainRecord: SupplyChainRecord;
  reuse: ArtifactReuseCheckResult;
  mirror?: MirroredArtifactRef;
  protectedReferences: readonly ProtectedReference[];
  reused: boolean;
}

export interface DecideArtifactMirrorInput {
  sourceArtifactRef: string;
  sourceArtifactDigest: Digest;
  packageResolutionDigest: Digest;
  policy: ArtifactMirrorPolicy;
  retentionDeadline?: IsoTimestamp;
  provenanceRef?: string;
}

export interface RegisterProtectedArtifactWindowsInput {
  artifactId?: string;
  activationId: string;
  activeExpiresAt?: IsoTimestamp;
  rollbackExpiresAt?: IsoTimestamp;
  createdAt?: IsoTimestamp;
}

export class SupplyChainService {
  readonly #stores: SupplyChainServiceStores;
  readonly #idFactory: () => string;
  readonly #clock: () => Date;

  constructor(options: SupplyChainServiceOptions) {
    this.#stores = options.stores;
    this.#idFactory = options.idFactory ?? crypto.randomUUID;
    this.#clock = options.clock ?? (() => new Date());
  }

  async checkPreparedArtifactReuse(
    expectation: PreparedArtifactReuseExpectation,
  ): Promise<ArtifactReuseCheckResult> {
    const artifact = await this.#stores.artifacts.findByDigest(
      expectation.artifactDigest,
    );
    if (!artifact) {
      return Object.freeze({
        artifact: undefined,
        validation: Object.freeze({
          reusable: false,
          rejectionReasons: Object.freeze(
            [
              "artifact-digest-mismatch",
            ] satisfies PreparedArtifactReuseRejectionReason[],
          ),
        }),
      });
    }
    return Object.freeze({
      artifact,
      validation: validatePreparedArtifactReuse(artifact, expectation),
    });
  }

  async requirePreparedArtifactForApply(
    input: PreparedArtifactPreApplyValidationInput,
  ): Promise<PreparedArtifactPreApplyValidationResult> {
    const reuse = await this.checkPreparedArtifactReuse(input);
    if (!reuse.artifact || !reuse.validation.reusable) {
      throw conflict("PreparedArtifact pre-Apply validation failed", {
        deploymentId: input.deploymentId,
        artifactDigest: input.artifactDigest,
        rejectionReasons: reuse.validation.rejectionReasons,
      });
    }
    return Object.freeze({
      artifact: reuse.artifact,
      validation: reuse.validation,
    });
  }

  decideArtifactMirror(input: DecideArtifactMirrorInput): MirroredArtifactRef {
    const mirroredArtifactRef = input.policy.mirrorExternalImages
      ? `mirror://${encodeURIComponent(input.sourceArtifactDigest)}`
      : undefined;
    const retentionDeadline = input.policy.retainForRollbackWindow
      ? input.retentionDeadline
      : undefined;
    return Object.freeze({
      sourceArtifactRef: input.sourceArtifactRef,
      sourceArtifactDigest: input.sourceArtifactDigest,
      mirroredArtifactRef,
      retentionDeadline,
      provenanceRef: input.provenanceRef,
      packageResolutionDigest: input.packageResolutionDigest,
    });
  }

  async prepareArtifactRequest(
    input: PrepareArtifactRequestInput,
  ): Promise<PrepareArtifactRequestResult> {
    const createdAt = input.createdAt ?? this.#clock().toISOString();
    const expectation = buildReuseExpectation(input, createdAt);
    const reuse = await this.checkPreparedArtifactReuse(expectation);

    let artifact = reuse.artifact;
    const reused = reuse.validation.reusable && artifact !== undefined;
    if (!artifact) {
      artifact = await this.#stores.artifacts.put({
        id: input.artifactId ?? this.#idFactory(),
        digest: input.artifactDigest,
        storageRef: input.storageRef,
        expiresAt: input.expiresAt,
        sourceDigest: input.sourceDigest,
        buildInputDigest: input.buildInputDigest,
        buildEnvironmentDigest: input.buildEnvironmentDigest,
        resolvedGraphDigest: input.resolvedGraphDigest,
        packageResolutionDigest: input.packageResolutionDigest,
        provenanceRef: input.provenanceRef,
        signatureRef: input.signatureRef,
        createdAt,
      });
    } else if (!reuse.validation.reusable) {
      throw conflict("PreparedArtifact digest exists but cannot be reused", {
        artifactId: artifact.id,
        rejectionReasons: reuse.validation.rejectionReasons,
      });
    }

    const supplyChainRecord = await this.#stores.records.put({
      id: input.recordId ?? this.#idFactory(),
      sourceDigest: input.sourceDigest,
      buildInputDigest: input.buildInputDigest,
      buildEnvironmentDigest: input.buildEnvironmentDigest,
      artifactDigest: input.artifactDigest,
      packageResolutionDigest: input.packageResolutionDigest,
      providerPackageDigests: [...(input.providerPackageDigests ?? [])],
      resourceContractPackageDigests: [
        ...(input.resourceContractPackageDigests ?? []),
      ],
      dataContractPackageDigests: input.dataContractPackageDigests
        ? [...input.dataContractPackageDigests]
        : undefined,
      nativeSchemaDigests: [...(input.nativeSchemaDigests ?? [])],
      provenanceRef: input.provenanceRef,
      signatureRefs: input.signatureRefs ??
        (input.signatureRef ? [input.signatureRef] : undefined),
      createdAt,
    });

    const mirror = input.mirror
      ? this.decideArtifactMirror(input.mirror)
      : undefined;
    const protectedReferences = input.protection
      ? await this.registerProtectedArtifactWindows({
        ...input.protection,
        artifactId: artifact.id,
        createdAt,
      })
      : [];

    return Object.freeze({
      artifact,
      supplyChainRecord,
      reuse,
      mirror,
      protectedReferences: Object.freeze([...protectedReferences]),
      reused,
    });
  }

  async registerProtectedArtifactWindows(
    input: RegisterProtectedArtifactWindowsInput,
  ): Promise<readonly ProtectedReference[]> {
    const artifactId = input.artifactId;
    if (!artifactId) {
      throw new TypeError(
        "artifactId is required to register protected windows",
      );
    }
    const createdAt = input.createdAt ?? this.#clock().toISOString();
    const refs: ProtectedReference[] = [
      {
        id: this.#idFactory(),
        refType: "PreparedArtifact",
        refId: artifactId,
        reason: "current-activation",
        expiresAt: input.activeExpiresAt,
        createdAt,
      },
    ];
    if (input.rollbackExpiresAt) {
      refs.push({
        id: this.#idFactory(),
        refType: "PreparedArtifact",
        refId: artifactId,
        reason: "rollback-window",
        expiresAt: input.rollbackExpiresAt,
        createdAt,
      });
    }
    const stored: ProtectedReference[] = [];
    for (const ref of refs) {
      stored.push(await this.#stores.protectedReferences.put(ref));
    }
    return Object.freeze(stored);
  }
}

function buildReuseExpectation(
  input: PrepareArtifactRequestInput,
  now: IsoTimestamp,
): PreparedArtifactReuseExpectation {
  return {
    sourceDigest: input.sourceDigest,
    buildInputDigest: input.buildInputDigest,
    buildEnvironmentDigest: input.buildEnvironmentDigest,
    resolvedGraphDigest: input.resolvedGraphDigest,
    packageResolutionDigest: input.packageResolutionDigest,
    artifactDigest: input.artifactDigest,
    now,
    readSetValid: input.readSetValid === true,
    approvalStateValid: input.approvalStateValid === true,
  };
}
