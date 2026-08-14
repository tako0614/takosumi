import type {
  InstalledFormReference,
  JsonObject,
  NativeResourceRef,
  ResourceCapsuleOwner,
  ResourceManagedBy,
  ResourceShapeKind,
  TakoformNativeIdentity,
  TakoformResourceFormTransitionEvidence,
} from "takosumi-contract";
import {
  installedFormReferenceKey,
  isInstalledFormReference,
  shapeKindForPortableType,
  TAKOFORM_RESOURCE_FORM_TRANSITION_EVIDENCE_FORMAT,
  TAKOFORM_RESOURCE_FORM_TRANSITION_OPERATION_FORMAT,
  TAKOFORM_RESOURCE_FORM_TRANSITION_REQUEST_FORMAT,
} from "takosumi-contract";
import { canonicalJsonBytes } from "../../adapters/takoform/canonical_json.ts";
import { sha256HexAsync } from "../../shared/runtime/hash.ts";
import type { SpaceId } from "../../shared/ids.ts";
import type {
  OpenTofuControlStore,
  ResourceFormTransitionRunEvidence,
  ResourceOperationRun,
} from "../deploy-control/store.ts";
import type {
  ResolutionLockRecord,
  ResourceIdentityFenceRecord,
  ResourceShapeRecord,
  ResourceShapeRecordId,
} from "./records.ts";
import {
  bindNativeResourceFormIdentity,
  formatResourceShapeId,
  resourceFormIdentitiesEqual,
} from "./records.ts";
import type { ResourceShapeStores } from "./stores.ts";
import { secretLikeJsonPath } from "./secret_guard.ts";
import {
  consumeResourceIdentityFence,
  matchesApplyLock,
  matchesResourceIdentityFence,
  resourceRecordRevision,
} from "./stores.ts";

const OPERATION_ID_RE = /^formtx_[0-9a-f]{64}$/u;
const EVIDENCE_MARKER_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const HOST_REJECTION_CODE_RE = /^[a-z][a-z0-9_]{0,63}$/u;
const SHA256_RE = /^sha256:[0-9a-f]{64}$/u;
const RESOURCE_VERSION_MAX = String(Number.MAX_SAFE_INTEGER);

export type ResourceFormTransitionErrorCode =
  | "invalid_request"
  | "resource_not_found"
  | "operation_not_found"
  | "ownership_conflict"
  | "resource_not_ready"
  | "form_identity_conflict"
  | "form_not_retained"
  | "transition_not_allowed"
  | "resource_version_conflict"
  | "native_identity_conflict"
  | "operation_conflict"
  | "canonical_conflict"
  | "backend_unavailable";

export class ResourceFormTransitionError extends Error {
  constructor(
    readonly code: ResourceFormTransitionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ResourceFormTransitionError";
  }
}

export interface ResourceFormTransitionRequest {
  readonly workspaceId: string;
  readonly spaceId: SpaceId;
  readonly kind: ResourceShapeKind;
  readonly name: string;
  readonly actorId: string;
  readonly owner: ResourceCapsuleOwner;
  readonly operationId: string;
  readonly fromForm: InstalledFormReference;
  readonly toForm: InstalledFormReference;
  readonly desiredSpec: JsonObject;
  readonly expected: {
    readonly resourceVersion: string;
    readonly nativeIdentity?: TakoformNativeIdentity;
  };
  readonly transitionEvidence: TakoformResourceFormTransitionEvidence;
}

export interface ResourceFormTransitionReadbackRequest {
  readonly workspaceId: string;
  readonly spaceId: SpaceId;
  readonly kind: ResourceShapeKind;
  readonly name: string;
  readonly owner: ResourceCapsuleOwner;
  readonly operationId: string;
}

export interface ResourceFormTransitionHostProof {
  readonly operationId: string;
  readonly fromForm: InstalledFormReference;
  readonly toForm: InstalledFormReference;
  /** Committed desired generation (the stored precondition generation + 1). */
  readonly resourceGeneration: number;
  /** Echo of the canonical old revision id recorded before host dispatch. */
  readonly expectedResourceRevisionId: string;
  readonly observedSpecDigest: `sha256:${string}`;
  readonly transitionEvidenceDigest: `sha256:${string}`;
  readonly nativeResources: readonly NativeResourceRef[];
  readonly committed: true;
}

export interface ResourceFormTransitionHostInput {
  readonly operationId: string;
  readonly workspaceId: string;
  readonly resourceId: ResourceShapeRecordId;
  readonly expectedResourceGeneration: number;
  readonly expectedResourceRevision: number;
  readonly expectedResourceRevisionId: string;
  readonly owner: ResourceCapsuleOwner;
  readonly fromForm: InstalledFormReference;
  readonly toForm: InstalledFormReference;
  readonly desiredSpec: JsonObject;
  readonly desiredSpecDigest: `sha256:${string}`;
  readonly transitionEvidence: TakoformResourceFormTransitionEvidence;
  readonly resolutionLock: ResolutionLockRecord;
  readonly identityFence: ResourceIdentityFenceRecord | null;
}

export interface ResourceFormTransitionHost {
  dispatch(
    input: ResourceFormTransitionHostInput,
  ): Promise<
    | {
        readonly status: "committed";
        readonly proof: ResourceFormTransitionHostProof;
        readonly observedSpec: JsonObject;
      }
    | { readonly status: "rejected"; readonly code: string }
  >;
  readback(input: {
    readonly operationId: string;
    readonly workspaceId: string;
    readonly resourceId: ResourceShapeRecordId;
  }): Promise<
    | {
        readonly status: "committed";
        readonly proof: ResourceFormTransitionHostProof;
        readonly observedSpec: JsonObject;
      }
    | { readonly status: "absent" }
    | { readonly status: "rejected"; readonly code: string }
  >;
}

export interface ResourceFormTransitionEvidenceAuthority {
  authorize(input: {
    readonly workspaceId: string;
    readonly owner: ResourceCapsuleOwner;
    readonly resourceId: ResourceShapeRecordId;
    readonly fromForm: InstalledFormReference;
    readonly toForm: InstalledFormReference;
    readonly transitionEvidence: TakoformResourceFormTransitionEvidence;
  }): Promise<boolean>;
}

interface ResourceFormTransitionResultBase {
  readonly operationId: string;
  readonly requestDigest: `sha256:${string}`;
}

export type ResourceFormTransitionResult =
  | (ResourceFormTransitionResultBase & {
      readonly status: "prepared";
      /** Exact durable dispatch fence; false is the sole POST resume grant. */
      readonly dispatchAttempted: false;
    })
  | (ResourceFormTransitionResultBase & {
      readonly status: "indeterminate";
      readonly dispatchAttempted: true;
    })
  | (ResourceFormTransitionResultBase & {
      readonly status: "committed";
      readonly resource: ResourceShapeRecord;
      readonly lock: ResolutionLockRecord;
      readonly proof: ResourceFormTransitionHostProof;
    })
  | (ResourceFormTransitionResultBase & {
      readonly status: "rejected";
      readonly rejectionCode: string;
    });

export interface ResourceFormTransitionServiceOptions {
  readonly stores: ResourceShapeStores;
  readonly operations: Pick<
    OpenTofuControlStore,
    | "beginResourceOperationRun"
    | "getResourceOperationRun"
    | "getResourceFormTransitionRun"
    | "transitionResourceOperationRun"
  >;
  readonly forms: {
    getRetainedIdentity(identity: InstalledFormReference): Promise<unknown>;
    validateDesiredState(
      identity: InstalledFormReference,
      spec: unknown,
    ): Promise<string | undefined>;
  };
  readonly evidence: ResourceFormTransitionEvidenceAuthority;
  readonly host: ResourceFormTransitionHost;
  readonly now?: () => string;
}

/**
 * Exact Resource Form transition saga. Normal Resource apply never calls this
 * module, so its immutable Form identity rejection remains unchanged.
 */
export class ResourceFormTransitionService {
  readonly #stores: ResourceShapeStores;
  readonly #operations: ResourceFormTransitionServiceOptions["operations"];
  readonly #forms: ResourceFormTransitionServiceOptions["forms"];
  readonly #evidence: ResourceFormTransitionEvidenceAuthority;
  readonly #host: ResourceFormTransitionHost;
  readonly #now: () => string;

  constructor(options: ResourceFormTransitionServiceOptions) {
    this.#stores = options.stores;
    this.#operations = options.operations;
    this.#forms = options.forms;
    this.#evidence = options.evidence;
    this.#host = options.host;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  async transition(
    request: ResourceFormTransitionRequest,
  ): Promise<ResourceFormTransitionResult> {
    validateRequest(request);
    const resourceId = formatResourceShapeId(
      request.spaceId,
      request.kind,
      request.name,
    );

    const prior = await this.#operations.getResourceFormTransitionRun({
      workspaceId: request.workspaceId,
      resourceId,
      operationId: request.operationId,
    });
    if (prior) {
      await this.#assertReplayRequest(prior, request);
      return await this.#resumeOrReturn(prior, request);
    }

    const [resource, lock, identityFence] =
      await this.#readCanonicalAggregate(resourceId);
    this.#assertCanonicalPreconditions(request, resource, lock, identityFence);
    const desiredSpecDigest = await resourceFormTransitionDesiredSpecDigest(
      request.desiredSpec,
    );
    const operationId = await resourceFormTransitionOperationId({
      space: request.spaceId,
      kind: request.kind,
      name: request.name,
      fromForm: request.fromForm,
      toForm: request.toForm,
      desiredSpecDigest,
      expected: request.expected,
      transitionEvidence: request.transitionEvidence,
    });
    if (operationId !== request.operationId) {
      throw error(
        "invalid_request",
        "operation id does not bind the exact canonical transition input",
      );
    }
    const requestDigest = await resourceFormTransitionRequestDigest({
      operationId: request.operationId,
      fromForm: request.fromForm,
      toForm: request.toForm,
      desiredSpecDigest,
      expected: request.expected,
      transitionEvidence: request.transitionEvidence,
    });
    await this.#assertInstalledAndAuthorized(request, resourceId);

    // Re-read after every external evidence lookup. The immutable snapshot put
    // into the ledger must be one coherent current aggregate, not a stale pair.
    const [current, currentLock, currentIdentityFence] =
      await this.#readCanonicalAggregate(resourceId);
    this.#assertCanonicalPreconditions(
      request,
      current,
      currentLock,
      currentIdentityFence,
    );
    if (
      resourceRecordRevision(current) !== resourceRecordRevision(resource) ||
      !matchesApplyLock(currentLock, lock) ||
      !sameIdentityFence(currentIdentityFence, identityFence)
    ) {
      const winner = await this.#operations.getResourceFormTransitionRun({
        workspaceId: request.workspaceId,
        resourceId,
        operationId: request.operationId,
      });
      if (winner) {
        await this.#assertReplayRequest(winner, request);
        return await this.#resumeOrReturn(winner, request);
      }
      throw error("canonical_conflict", "Resource or ResolutionLock changed during transition admission");
    }

    const revision = resourceRecordRevision(current);
    if (revision === Number.MAX_SAFE_INTEGER) {
      throw error(
        "canonical_conflict",
        "Resource revision is exhausted before transition admission",
      );
    }
    const revisionId = resourceRevisionId(current);
    const claimAt = nextTransitionTimestamp(this.#now(), current.updatedAt);
    const snapshot: ResourceFormTransitionRunEvidence = {
      operationId: request.operationId,
      requestDigest,
      desiredSpecDigest,
      fromForm: request.fromForm,
      toForm: request.toForm,
      transitionEvidence: request.transitionEvidence,
      expected: request.expected,
      resource: {
        id: current.id,
        workspaceId: current.spaceId,
        kind: current.kind,
        name: current.name,
        managedBy: current.managedBy,
        owner: request.owner,
        phase: current.phase,
        generation: current.generation,
        revision,
        observedGeneration: current.observedGeneration,
        createdAt: current.createdAt,
        updatedAt: current.updatedAt,
        revisionId,
      },
      claim: {
        updatedAt: claimAt,
        revision: revision + 1,
      },
      identityFence: currentIdentityFence,
      resolutionLock: structuredClone(currentLock),
    };
    const started: ResourceOperationRun = {
      id: transitionRunId(request.operationId),
      workspaceId: request.workspaceId,
      subject: { kind: "resource", id: resourceId },
      resourceOperation: "form_transition",
      resourceForm: request.fromForm,
      resourceOperationKey: request.operationId,
      resourceOperationVersion: 1,
      resourceFormTransition: snapshot,
      type: "apply",
      status: "running",
      createdBy: request.actorId,
      createdAt: this.#now(),
      startedAt: this.#now(),
    };
    const begun = await this.#operations.beginResourceOperationRun(started);
    if (begun.status === "conflict") {
      throw error("operation_conflict", "operation id is already bound to another request");
    }
    if (begun.status === "existing") {
      await this.#assertReplayRequest(begun.run, request);
      return await this.#resumeOrReturn(begun.run, request);
    }
    return await this.#resumeOrReturn(begun.run, request);
  }

  /**
   * A prepared operation may be resumed only by the exact same POST body. The
   * Resource claim and dispatch fence are independent CAS steps, so a crash at
   * either boundary remains live while every race still elects one dispatcher.
   */
  async #resumeOrReturn(
    run: ResourceOperationRun,
    request: ResourceFormTransitionRequest,
  ): Promise<ResourceFormTransitionResult> {
    if (run.status !== "running" || run.resourceFormTransitionDispatch) {
      return await this.#resultFromExisting(run, request, false);
    }
    const claimed = await this.#claimCanonicalResource(run);
    if (!claimed) {
      const failed = await this.#terminalize(
        run,
        "failed",
        "canonical_transition_claim_conflict",
      );
      if (failed.status !== "failed") {
        return unresolvedResult(run, true);
      }
      return {
        status: "rejected",
        operationId: run.resourceOperationKey,
        requestDigest: requiredSnapshot(run).requestDigest,
        rejectionCode: "canonical_transition_claim_conflict",
      };
    }

    const attempted: ResourceOperationRun = {
      ...run,
      resourceOperationVersion: run.resourceOperationVersion + 1,
      resourceFormTransitionDispatch: {
        status: "attempted",
        attemptedAt: this.#now(),
      },
    };
    const fenced = await this.#operations.transitionResourceOperationRun({
      id: run.id,
      operationKey: run.resourceOperationKey,
      expectedVersion: run.resourceOperationVersion,
      expectFrom: ["running"],
      run: attempted,
    });
    if (!fenced.won || !fenced.run?.resourceFormTransitionDispatch) {
      const current = fenced.run ?? run;
      return current.resourceFormTransitionDispatch
        ? unresolvedResult(current, true)
        : unresolvedResult(current, false);
    }
    const dispatchRun = fenced.run;
    const snapshot = requiredSnapshot(dispatchRun);
    let hostResult;
    try {
      hostResult = await this.#host.dispatch({
        operationId: snapshot.operationId,
        workspaceId: dispatchRun.workspaceId,
        resourceId: dispatchRun.subject.id,
        expectedResourceGeneration: snapshot.resource.generation,
        expectedResourceRevision: snapshot.resource.revision,
        expectedResourceRevisionId: snapshot.resource.revisionId,
        owner: snapshot.resource.owner,
        fromForm: snapshot.fromForm,
        toForm: snapshot.toForm,
        desiredSpec: structuredClone(request.desiredSpec),
        desiredSpecDigest: snapshot.desiredSpecDigest,
        transitionEvidence: snapshot.transitionEvidence,
        resolutionLock: structuredClone(snapshot.resolutionLock),
        identityFence: structuredClone(snapshot.identityFence),
      });
    } catch {
      return unresolvedResult(dispatchRun, true);
    }
    if (hostResult.status === "rejected") {
      return await this.#rejectProvenUncommitted(
        dispatchRun,
        stableHostRejectionCode(hostResult.code),
      );
    }
    return await this.#commitProvenTransition(
      dispatchRun,
      hostResult.observedSpec,
      hostResult.proof,
    );
  }

  /**
   * Exact operation readback. It never dispatches. Its only writes are bounded
   * recovery of this operation's own terminal result: canonical forward-repair
   * after an exact committed host proof, or release of a claim after a durable
   * definitive-rejection receipt.
   */
  async readback(
    request: ResourceFormTransitionReadbackRequest,
  ): Promise<ResourceFormTransitionResult> {
    validateReadbackRequest(request);
    const resourceId = formatResourceShapeId(
      request.spaceId,
      request.kind,
      request.name,
    );
    const run = await this.#operations.getResourceFormTransitionRun({
      workspaceId: request.workspaceId,
      resourceId,
      operationId: request.operationId,
    });
    if (!run?.resourceFormTransition) {
      throw error("operation_not_found", "exact transition operation does not exist");
    }
    assertOwner(request.owner, run.resourceFormTransition.resource.owner);
    return await this.#resultFromExisting(run, undefined, true);
  }

  async #resultFromExisting(
    run: ResourceOperationRun,
    request: ResourceFormTransitionRequest | undefined,
    allowHostReadback: boolean,
  ): Promise<ResourceFormTransitionResult> {
    if (run.status === "succeeded") {
      const snapshot = requiredSnapshot(run);
      const proof = proofFromResult(run);
      assertProof(proof, snapshot);
      let observedSpec = request?.desiredSpec;
      if (observedSpec === undefined) {
        const [currentResource, currentLock, currentIdentityFence] =
          await this.#readCanonicalAggregateOrUndefined(run.subject.id);
        if (
          currentResource &&
          currentLock &&
          (await canonicalTransitionCommitMatches(
            currentResource,
            currentLock,
            currentIdentityFence,
            snapshot,
            proof,
          ))
        ) {
          observedSpec = currentResource.spec;
        } else if (allowHostReadback) {
          let exactReadback;
          try {
            exactReadback = await this.#host.readback({
              operationId: snapshot.operationId,
              workspaceId: run.workspaceId,
              resourceId: run.subject.id,
            });
          } catch {
            return unresolvedResult(run, true);
          }
          if (exactReadback.status !== "committed") {
            return unresolvedResult(run, true);
          }
          assertProof(exactReadback.proof, snapshot);
          observedSpec = exactReadback.observedSpec;
        } else {
          return unresolvedResult(run, true);
        }
      }
      if (
        (await resourceFormTransitionDesiredSpecDigest(observedSpec)) !==
        snapshot.desiredSpecDigest
      ) {
        throw error(
          "canonical_conflict",
          "committed operation receipt does not match its desired spec digest",
        );
      }
      return committedTransitionReceipt(run, observedSpec, proof);
    }
    if (run.status === "failed") {
      // A durable terminal rejection is the no-mutation receipt. Repair the
      // separately persisted Resource claim before exposing the stable failed
      // operation; this can only remove this operation's exact claim and can
      // never dispatch or alter Form/native evidence. A crash between the two
      // writes therefore stays fenced and converges on replay/readback.
      if (!(await this.#releaseCanonicalClaim(run))) {
        return unresolvedResult(run, true);
      }
      return {
        status: "rejected",
        operationId: run.resourceOperationKey,
        requestDigest: requiredSnapshot(run).requestDigest,
        rejectionCode: run.errorCode ?? "host_rejected",
      };
    }
    // A committed host proof is persisted on the exact operation before the
    // canonical N+1 CAS. If only the later terminal Run update was lost, the
    // still-exact aggregate is sufficient to finish without another host
    // lookup. An exact POST replay can likewise supply the original desired
    // state while remaining behind the same operation digest.
    if (run.resourceOperationResult) {
      const snapshot = requiredSnapshot(run);
      const proof = proofFromResult(run);
      assertProof(proof, snapshot);
      const [currentResource, currentLock, currentIdentityFence] =
        await this.#readCanonicalAggregateOrUndefined(run.subject.id);
      if (
        currentResource &&
        currentLock &&
        (await canonicalTransitionCommitMatches(
          currentResource,
          currentLock,
          currentIdentityFence,
          snapshot,
          proof,
        ))
      ) {
        return await this.#commitProvenTransition(
          run,
          currentResource.spec,
          proof,
        );
      }
      if (request) {
        return await this.#commitProvenTransition(run, request.desiredSpec, proof);
      }
    }
    // A prepared operation has no native side effect to reconcile. In
    // particular, GET must expose dispatchAttempted:false without consulting
    // the host so the caller can safely resume the exact POST through the
    // dispatch-attempt CAS. Only an attempted operation may read the host
    // ledger, and neither path dispatches from readback.
    if (!allowHostReadback || !run.resourceFormTransitionDispatch) {
      return unresolvedResult(
        run,
        run.resourceFormTransitionDispatch !== undefined,
      );
    }
    const snapshot = requiredSnapshot(run);
    let readback;
    try {
      readback = await this.#host.readback({
        operationId: snapshot.operationId,
        workspaceId: run.workspaceId,
        resourceId: run.subject.id,
      });
    } catch {
      return unresolvedResult(run, true);
    }
    if (readback.status === "absent") {
      return unresolvedResult(run, true);
    }
    if (readback.status === "rejected") {
      return await this.#rejectProvenUncommitted(
        run,
        stableHostRejectionCode(readback.code),
      );
    }
    return await this.#commitProvenTransition(
      run,
      readback.observedSpec,
      readback.proof,
    );
  }

  async #claimCanonicalResource(run: ResourceOperationRun): Promise<boolean> {
    const snapshot = requiredSnapshot(run);
    const [current, lock, identityFenceValue] = await Promise.all([
      this.#stores.resources.get(run.subject.id),
      this.#stores.locks.get(run.subject.id),
      this.#stores.getResourceIdentityFence(run.subject.id),
    ]);
    if (!current || !lock) return false;
    const identityFence = identityFenceValue ?? null;
    if (transitionClaimMatches(current, run, snapshot)) {
      return (
        matchesApplyLock(lock, snapshot.resolutionLock) &&
        sameIdentityFence(identityFence, snapshot.identityFence)
      );
    }
    if (
      !resourceMatchesTransitionPrecondition(current, snapshot) ||
      !matchesApplyLock(lock, snapshot.resolutionLock) ||
      !sameIdentityFence(identityFence, snapshot.identityFence)
    ) {
      return false;
    }
    const candidate: ResourceShapeRecord = {
      ...current,
      pendingOperation: transitionPendingOperation(run, snapshot),
      updatedAt: snapshot.claim.updatedAt,
    };
    const claimed = await this.#stores.claimResourceAggregate({
      record: candidate,
      expectedResource: snapshotVersion(snapshot),
      expectedLock: snapshot.resolutionLock,
      expectedIdentityFence: snapshot.identityFence,
    });
    if (
      claimed.status === "claimed" &&
      transitionClaimMatches(claimed.record, run, snapshot)
    ) {
      return true;
    }
    const [observed, observedLock, observedIdentityFenceValue] =
      await Promise.all([
        this.#stores.resources.get(run.subject.id),
        this.#stores.locks.get(run.subject.id),
        this.#stores.getResourceIdentityFence(run.subject.id),
      ]);
    return Boolean(
      observed &&
        observedLock &&
        transitionClaimMatches(observed, run, snapshot) &&
        matchesApplyLock(observedLock, snapshot.resolutionLock) &&
        sameIdentityFence(
          observedIdentityFenceValue ?? null,
          snapshot.identityFence,
        ),
    );
  }

  async #releaseCanonicalClaim(run: ResourceOperationRun): Promise<boolean> {
    const snapshot = requiredSnapshot(run);
    const current = await this.#stores.resources.get(run.subject.id);
    // The terminal rejection receipt is already durable at this point. If this
    // operation's claim is absent, there is nothing left to repair: a later
    // reviewed operation may legitimately have advanced or claimed the same
    // Resource. Never turn the first operation's stable failure back into an
    // indeterminate result merely because canonical state moved on.
    if (!current || !transitionClaimBelongsTo(current, run)) return true;
    if (!transitionClaimMatches(current, run, snapshot)) return false;
    const { pendingOperation: _claim, ...unclaimed } = current;
    const candidate: ResourceShapeRecord = {
      ...unclaimed,
      updatedAt: nextTransitionTimestamp(this.#now(), current.updatedAt),
    };
    const released = await this.#stores.resources.compareAndSet(
      candidate,
      claimedSnapshotVersion(snapshot),
    );
    if (released.status === "updated" && !released.record.pendingOperation) {
      return true;
    }
    const observed = await this.#stores.resources.get(run.subject.id);
    return !observed || !transitionClaimBelongsTo(observed, run);
  }

  async #rejectProvenUncommitted(
    run: ResourceOperationRun,
    code: string,
  ): Promise<ResourceFormTransitionResult> {
    // Once an exact committed proof is durable, a contradictory rejection can
    // never release the canonical claim. Preserve the operation for explicit
    // committed readback instead of selecting one host answer by arrival race.
    if (run.resourceOperationResult) return unresolvedResult(run, true);
    // Persist the definitive host rejection before releasing the Resource
    // serialization claim. Reversing these writes creates a crash window in
    // which the same running operation could reclaim and dispatch again.
    const failed = await this.#terminalize(run, "failed", code);
    if (failed.status !== "failed") return unresolvedResult(failed, true);
    if (!(await this.#releaseCanonicalClaim(failed))) {
      return unresolvedResult(failed, true);
    }
    return {
      status: "rejected",
      operationId: failed.resourceOperationKey,
      requestDigest: requiredSnapshot(failed).requestDigest,
      rejectionCode: code,
    };
  }

  async #commitProvenTransition(
    run: ResourceOperationRun,
    desiredSpec: JsonObject | undefined,
    proof: ResourceFormTransitionHostProof,
  ): Promise<ResourceFormTransitionResult> {
    let snapshot = requiredSnapshot(run);
    assertProof(proof, snapshot);
    run = await this.#recordProvenHostCommit(run, proof);
    if (!run.resourceOperationResult || run.status === "failed") {
      return unresolvedResult(run, true);
    }
    snapshot = requiredSnapshot(run);
    const [currentResource, currentLock, currentIdentityFence] =
      await this.#readCanonicalAggregateOrUndefined(run.subject.id);
    if (!currentResource || !currentLock) {
      return unresolvedResult(run, true);
    }
    if (
      await canonicalTransitionCommitMatches(
        currentResource,
        currentLock,
        currentIdentityFence,
        snapshot,
        proof,
      )
    ) {
      const completed = await this.#terminalize(run, "succeeded", undefined, proof);
      if (completed.status !== "succeeded") {
        return unresolvedResult(completed, true);
      }
      return committedTransitionReceipt(
        completed,
        currentResource.spec,
        proofFromResult(completed),
      );
    }
    if (desiredSpec === undefined) {
      throw error("canonical_conflict", "host proof omitted the exact observed desired spec");
    }
    if ((await resourceFormTransitionDesiredSpecDigest(desiredSpec)) !== snapshot.desiredSpecDigest) {
      throw error("canonical_conflict", "host observed spec does not match the stored desired digest");
    }
    if (!transitionClaimMatches(currentResource, run, snapshot)) {
      return unresolvedResult(run, true);
    }
    const committedAt = nextTransitionTimestamp(
      this.#now(),
      currentResource.updatedAt,
    );
    const { pendingOperation: _claim, ...unclaimedCurrent } = currentResource;
    const replacement: ResourceShapeRecord = {
      ...unclaimedCurrent,
      form: snapshot.toForm,
      spec: structuredClone(desiredSpec),
      generation: snapshot.resource.generation + 1,
      observedGeneration: snapshot.resource.generation + 1,
      conditions: formTransitionCommittedConditions(
        currentResource.conditions,
        snapshot.resource.generation + 1,
        committedAt,
      ),
      updatedAt: committedAt,
      lastOperationRunId: run.id,
    };
    const replacementLock: ResolutionLockRecord = {
      ...currentLock,
      form: snapshot.toForm,
      nativeResources: bindNativeResourceFormIdentity(
        proof.nativeResources,
        snapshot.toForm,
      ),
      updatedAt: committedAt,
    };
    const replaced = await this.#stores.replaceResourceAggregate({
      record: replacement,
      lock: replacementLock,
      expectedResource: claimedSnapshotVersion(snapshot),
      expectedLock: snapshot.resolutionLock,
      identityFenceAdvance: { expected: snapshot.identityFence },
    });
    if (replaced.status !== "replaced") {
      return unresolvedResult(run, true);
    }
    const completed = await this.#terminalize(run, "succeeded", undefined, proof);
    if (completed.status !== "succeeded") {
      return unresolvedResult(completed, true);
    }
    return committedTransitionReceipt(
      completed,
      desiredSpec,
      proofFromResult(completed),
    );
  }

  /**
   * Persist the operation-bound committed host proof before clearing the
   * Resource claim in the N+1 aggregate CAS. A crash can therefore never make
   * the canonical commit outlive the evidence needed to terminalize it.
   */
  async #recordProvenHostCommit(
    run: ResourceOperationRun,
    proof: ResourceFormTransitionHostProof,
  ): Promise<ResourceOperationRun> {
    const snapshot = requiredSnapshot(run);
    assertProof(proof, snapshot);
    if (run.resourceOperationResult) {
      if (!transitionProofsEqual(proofFromResult(run), proof)) {
        throw error(
          "canonical_conflict",
          "transition operation is already bound to another committed proof",
        );
      }
      return run;
    }
    if (run.status !== "running") return run;
    const next: ResourceOperationRun = {
      ...run,
      resourceOperationVersion: run.resourceOperationVersion + 1,
      resourceOperationResult: transitionOperationResult(proof),
    };
    const transitioned = await this.#operations.transitionResourceOperationRun({
      id: run.id,
      operationKey: run.resourceOperationKey,
      expectedVersion: run.resourceOperationVersion,
      expectFrom: ["running"],
      run: next,
    });
    const current = transitioned.won && transitioned.run
      ? transitioned.run
      : (transitioned.run ?? run);
    if (
      current.resourceOperationResult &&
      !transitionProofsEqual(proofFromResult(current), proof)
    ) {
      throw error(
        "canonical_conflict",
        "transition operation committed proof changed during persistence",
      );
    }
    return current;
  }

  async #terminalize(
    run: ResourceOperationRun,
    status: "succeeded" | "failed",
    errorCode?: string,
    proof?: ResourceFormTransitionHostProof,
  ): Promise<ResourceOperationRun> {
    if (run.status !== "running") return run;
    const next: ResourceOperationRun = {
      ...run,
      status,
      resourceOperationVersion: run.resourceOperationVersion + 1,
      finishedAt: this.#now(),
      ...(errorCode ? { errorCode } : {}),
      ...(proof
        ? {
            resourceOperationResult:
              run.resourceOperationResult ?? transitionOperationResult(proof),
          }
        : {}),
    };
    const transitioned = await this.#operations.transitionResourceOperationRun({
      id: run.id,
      operationKey: run.resourceOperationKey,
      expectedVersion: run.resourceOperationVersion,
      expectFrom: ["running"],
      run: next,
    });
    if (transitioned.won && transitioned.run) return transitioned.run;
    return transitioned.run ?? run;
  }

  async #assertReplayRequest(
    run: ResourceOperationRun,
    request: ResourceFormTransitionRequest,
  ): Promise<void> {
    const snapshot = requiredSnapshot(run);
    const desiredSpecDigest = await resourceFormTransitionDesiredSpecDigest(
      request.desiredSpec,
    );
    const digest = await resourceFormTransitionRequestDigest({
      operationId: request.operationId,
      fromForm: request.fromForm,
      toForm: request.toForm,
      desiredSpecDigest,
      expected: request.expected,
      transitionEvidence: request.transitionEvidence,
    });
    if (digest !== snapshot.requestDigest) {
      throw error("operation_conflict", "operation id is bound to a different transition request");
    }
    assertOwner(request.owner, snapshot.resource.owner);
  }

  async #readCanonicalAggregate(
    resourceId: ResourceShapeRecordId,
  ): Promise<
    readonly [
      ResourceShapeRecord,
      ResolutionLockRecord,
      ResourceIdentityFenceRecord | null,
    ]
  > {
    const [resource, lock, identityFence] =
      await this.#readCanonicalAggregateOrUndefined(resourceId);
    if (!resource || !lock) {
      throw error(
        "resource_not_found",
        "canonical Resource or ResolutionLock is missing",
      );
    }
    return [resource, lock, identityFence];
  }

  async #readCanonicalAggregateOrUndefined(
    resourceId: ResourceShapeRecordId,
  ): Promise<
    readonly [
      ResourceShapeRecord | undefined,
      ResolutionLockRecord | undefined,
      ResourceIdentityFenceRecord | null,
    ]
  > {
    const [resource, lock, identityFence] = await Promise.all([
      this.#stores.resources.get(resourceId),
      this.#stores.locks.get(resourceId),
      this.#stores.getResourceIdentityFence(resourceId),
    ]);
    return [resource, lock, identityFence ?? null];
  }

  #assertCanonicalPreconditions(
    request: ResourceFormTransitionRequest,
    resource: ResourceShapeRecord,
    lock: ResolutionLockRecord,
    identityFence: ResourceIdentityFenceRecord | null,
  ): void {
    if (request.workspaceId !== request.spaceId || resource.spaceId !== request.spaceId) {
      throw error("ownership_conflict", "transition Workspace/space authority does not match Resource");
    }
    assertOwner(request.owner, resource.owner);
    if (
      resource.kind !== request.kind ||
      resource.name !== request.name ||
      lock.resourceId !== resource.id
    ) {
      throw error("form_identity_conflict", "transition identity does not match canonical Resource");
    }
    if (
      resource.phase !== "Ready" ||
      resource.observedGeneration !== resource.generation ||
      !lock.locked
    ) {
      throw error("resource_not_ready", "Resource and ResolutionLock must be current and locked");
    }
    if (
      identityFence !== null &&
      (identityFence.resourceId !== resource.id ||
        identityFence.lastGeneration !== resource.generation)
    ) {
      throw error(
        "canonical_conflict",
        "Resource identity fence does not match the current desired generation",
      );
    }
    if (
      !resourceFormIdentitiesEqual(resource.form, request.fromForm) ||
      !resourceFormIdentitiesEqual(lock.form, request.fromForm) ||
      shapeKindForPortableType(request.fromForm.type) !== request.kind ||
      shapeKindForPortableType(request.toForm.type) !== request.kind
    ) {
      throw error("form_identity_conflict", "exact from/to FormRef does not match canonical identity");
    }
    for (const native of lock.nativeResources ?? []) {
      if (!resourceFormIdentitiesEqual(native.form, request.fromForm)) {
        throw error("form_identity_conflict", "native evidence has drifted from the exact old FormRef");
      }
    }
    if ((lock.nativeResources ?? []).length !== 1) {
      throw error(
        "native_identity_conflict",
        "the narrow portable Form transition requires one exact native identity",
      );
    }
    if (
      request.expected.resourceVersion !== String(resource.generation)
    ) {
      throw error("resource_version_conflict", "Resource generation changed before transition");
    }
    if (request.expected.nativeIdentity) {
      const native = lock.nativeResources ?? [];
      if (
        native.length !== 1 ||
        native[0]?.type !== request.expected.nativeIdentity.type ||
        native[0]?.id !== request.expected.nativeIdentity.id
      ) {
        throw error("native_identity_conflict", "native identity changed before transition");
      }
    }
    resourceRevisionId(resource);
  }

  async #assertInstalledAndAuthorized(
    request: ResourceFormTransitionRequest,
    resourceId: ResourceShapeRecordId,
  ): Promise<void> {
    const expectedEvidenceDigest = await resourceFormTransitionEvidenceDigest({
      marker: request.transitionEvidence.marker,
      fromForm: request.fromForm,
      toForm: request.toForm,
    });
    if (expectedEvidenceDigest !== request.transitionEvidence.digest) {
      throw error(
        "invalid_request",
        "transition evidence digest does not bind the exact marker and FormRef pair",
      );
    }
    try {
      await Promise.all([
        this.#forms.getRetainedIdentity(request.fromForm),
        this.#forms.getRetainedIdentity(request.toForm),
      ]);
    } catch {
      throw error("form_not_retained", "both exact old and new Forms must be installed and retained");
    }
    const schemaError = await this.#forms.validateDesiredState(
      request.toForm,
      request.desiredSpec,
    );
    if (schemaError) {
      throw error("invalid_request", "desired Resource spec does not satisfy the exact new Form schema");
    }
    const allowed = await this.#evidence.authorize({
      workspaceId: request.workspaceId,
      owner: request.owner,
      resourceId,
      fromForm: request.fromForm,
      toForm: request.toForm,
      transitionEvidence: request.transitionEvidence,
    });
    if (!allowed) {
      throw error("transition_not_allowed", "product/module evidence does not allow this exact pair");
    }
  }
}

export async function resourceFormTransitionEvidenceDigest(input: {
  readonly marker: string;
  readonly fromForm: InstalledFormReference;
  readonly toForm: InstalledFormReference;
}): Promise<`sha256:${string}`> {
  return await digestCanonical({
    format: TAKOFORM_RESOURCE_FORM_TRANSITION_EVIDENCE_FORMAT,
    marker: input.marker,
    fromForm: portableEvidenceForm(input.fromForm),
    toForm: portableEvidenceForm(input.toForm),
  });
}

export async function resourceFormTransitionDesiredSpecDigest(
  spec: JsonObject,
): Promise<`sha256:${string}`> {
  return await digestCanonical(spec);
}

export async function resourceFormTransitionOperationId(input: {
  readonly space: string;
  readonly kind: ResourceShapeKind;
  readonly name: string;
  readonly fromForm: InstalledFormReference;
  readonly toForm: InstalledFormReference;
  readonly desiredSpecDigest: `sha256:${string}`;
  readonly expected: ResourceFormTransitionRequest["expected"];
  readonly transitionEvidence: TakoformResourceFormTransitionEvidence;
}): Promise<string> {
  const digest = await digestCanonical({
    format: TAKOFORM_RESOURCE_FORM_TRANSITION_OPERATION_FORMAT,
    resource: {
      space: input.space,
      kind: input.kind,
      name: input.name,
    },
    fromForm: portableEvidenceForm(input.fromForm),
    toForm: portableEvidenceForm(input.toForm),
    desiredSpecDigest: input.desiredSpecDigest,
    expected: portableExpected(input.expected),
    transitionEvidence: input.transitionEvidence,
  });
  return `formtx_${digest.slice("sha256:".length)}`;
}

export async function resourceFormTransitionRequestDigest(input: {
  readonly operationId: string;
  readonly fromForm: InstalledFormReference;
  readonly toForm: InstalledFormReference;
  readonly desiredSpecDigest: `sha256:${string}`;
  readonly expected: ResourceFormTransitionRequest["expected"];
  readonly transitionEvidence: TakoformResourceFormTransitionEvidence;
}): Promise<`sha256:${string}`> {
  return await digestCanonical({
    format: TAKOFORM_RESOURCE_FORM_TRANSITION_REQUEST_FORMAT,
    operationId: input.operationId,
    fromForm: portableEvidenceForm(input.fromForm),
    toForm: portableEvidenceForm(input.toForm),
    desiredSpecDigest: input.desiredSpecDigest,
    expected: portableExpected(input.expected),
    transitionEvidence: input.transitionEvidence,
  });
}

async function digestCanonical(value: unknown): Promise<`sha256:${string}`> {
  const digest = await sha256HexAsync(canonicalJsonBytes(value as never));
  return `sha256:${digest}`;
}

function portableEvidenceForm(identity: InstalledFormReference) {
  return {
    formRef: {
      apiVersion: "forms.takoform.com/v1alpha1",
      kind: shapeKindForPortableType(identity.type) ?? "",
      definitionVersion: identity.version,
      schemaDigest: identity.schemaDigest,
    },
    packageDigest: identity.packageDigest,
  };
}

function portableExpected(
  expected: ResourceFormTransitionRequest["expected"],
) {
  return {
    resourceVersion: expected.resourceVersion,
    ...(expected.nativeIdentity
      ? { nativeIdentity: expected.nativeIdentity }
      : {}),
  };
}

function validateRequest(request: ResourceFormTransitionRequest): void {
  validateReadbackRequest(request);
  if (
    !isInstalledFormReference(request.fromForm) ||
    !isInstalledFormReference(request.toForm) ||
    resourceFormIdentitiesEqual(request.fromForm, request.toForm)
  ) {
    throw error("invalid_request", "transition requires distinct exact old/new FormRefs");
  }
  const evidence = request.transitionEvidence;
  if (
    evidence.format !== TAKOFORM_RESOURCE_FORM_TRANSITION_EVIDENCE_FORMAT ||
    !EVIDENCE_MARKER_RE.test(evidence.marker) ||
    !SHA256_RE.test(evidence.digest)
  ) {
    throw error("invalid_request", "transition evidence marker/digest is invalid");
  }
  if (!validResourceVersion(request.expected.resourceVersion)) {
    throw error(
      "invalid_request",
      "expected.resourceVersion must be one exact positive safe generation",
    );
  }
  const nativeIdentity = request.expected.nativeIdentity;
  if (
    nativeIdentity &&
    (!boundedIdentity(nativeIdentity.type) || !boundedIdentity(nativeIdentity.id))
  ) {
    throw error("invalid_request", "expected native identity is invalid");
  }
  const secretPath = secretLikeJsonPath(
    request.desiredSpec,
    "resource.spec",
  );
  if (secretPath) {
    throw error(
      "invalid_request",
      `${secretPath} is secret-looking; transition desired state must be non-secret`,
    );
  }
}

function validResourceVersion(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[1-9][0-9]*$/u.test(value) &&
    (value.length < RESOURCE_VERSION_MAX.length ||
      (value.length === RESOURCE_VERSION_MAX.length &&
        value <= RESOURCE_VERSION_MAX))
  );
}

function boundedIdentity(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 256 &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function validateReadbackRequest(request: ResourceFormTransitionReadbackRequest): void {
  if (
    !request.workspaceId.trim() ||
    !request.spaceId.trim() ||
    !request.name.trim() ||
    !OPERATION_ID_RE.test(request.operationId)
  ) {
    throw error("invalid_request", "transition identity and operation id are required");
  }
}

function assertOwner(
  expected: ResourceCapsuleOwner,
  actual: ResourceShapeRecord["owner"] | undefined,
): void {
  if (
    !actual ||
    typeof actual === "string" ||
    expected.kind !== actual.kind ||
    expected.id !== actual.id ||
    expected.workspaceId !== actual.workspaceId ||
    expected.installingPrincipalId !== actual.installingPrincipalId
  ) {
    throw error("ownership_conflict", "authenticated Capsule owner does not match Resource owner");
  }
}

function resourceRevisionId(resource: ResourceShapeRecord): string {
  const value = resource.lastOperationRunId ?? resource.execution?.runId;
  if (!value || value.trim() !== value || value.length > 256) {
    throw error("canonical_conflict", "Resource has no exact current revision id");
  }
  return value;
}

function snapshotVersion(snapshot: ResourceFormTransitionRunEvidence) {
  return {
    generation: snapshot.resource.generation,
    phase: snapshot.resource.phase,
    updatedAt: snapshot.resource.updatedAt,
    revision: snapshot.resource.revision,
  };
}

function claimedSnapshotVersion(snapshot: ResourceFormTransitionRunEvidence) {
  return {
    generation: snapshot.resource.generation,
    phase: snapshot.resource.phase,
    updatedAt: snapshot.claim.updatedAt,
    revision: snapshot.claim.revision,
  };
}

function requiredSnapshot(run: ResourceOperationRun): ResourceFormTransitionRunEvidence {
  if (run.resourceOperation !== "form_transition" || !run.resourceFormTransition) {
    throw error("operation_conflict", "Run is not an exact Form transition operation");
  }
  return run.resourceFormTransition;
}

function assertProof(
  proof: ResourceFormTransitionHostProof,
  snapshot: ResourceFormTransitionRunEvidence,
): void {
  if (
    proof.committed !== true ||
    proof.operationId !== snapshot.operationId ||
    !resourceFormIdentitiesEqual(proof.fromForm, snapshot.fromForm) ||
    !resourceFormIdentitiesEqual(proof.toForm, snapshot.toForm) ||
    proof.resourceGeneration !== snapshot.resource.generation + 1 ||
    proof.expectedResourceRevisionId !== snapshot.resource.revisionId ||
    proof.observedSpecDigest !== snapshot.desiredSpecDigest ||
    proof.transitionEvidenceDigest !== snapshot.transitionEvidence.digest ||
    !nativeIdentitySetsEqual(
      snapshot.resolutionLock.nativeResources,
      proof.nativeResources,
    )
  ) {
    throw error("canonical_conflict", "host proof does not match the stored transition snapshot");
  }
  if (proof.nativeResources.length !== 1) {
    throw error("native_identity_conflict", "host proof must retain one exact native identity");
  }
  for (const native of proof.nativeResources) {
    if (!resourceFormIdentitiesEqual(native.form, snapshot.toForm)) {
      throw error("native_identity_conflict", "host proof changed native identity evidence");
    }
  }
}

function nativeIdentitySetsEqual(
  left: readonly NativeResourceRef[] | undefined,
  right: readonly NativeResourceRef[] | undefined,
): boolean {
  const identity = (values: readonly NativeResourceRef[] | undefined) =>
    [...(values ?? [])]
      .map((value) => `${value.type}\0${value.id}\0${value.ownership ?? ""}`)
      .sort();
  return JSON.stringify(identity(left)) === JSON.stringify(identity(right));
}

function proofFromResult(run: ResourceOperationRun): ResourceFormTransitionHostProof {
  const snapshot = requiredSnapshot(run);
  const result = run.resourceOperationResult;
  const outputs = result?.outputs;
  if (
    !result ||
    !outputs ||
    typeof outputs.observedSpecDigest !== "string" ||
    typeof outputs.resourceGeneration !== "number" ||
    typeof outputs.expectedResourceRevisionId !== "string"
  ) {
    throw error("canonical_conflict", "terminal transition Run is missing exact host proof");
  }
  return {
    operationId: snapshot.operationId,
    fromForm: snapshot.fromForm,
    toForm: snapshot.toForm,
    resourceGeneration: outputs.resourceGeneration,
    expectedResourceRevisionId: outputs.expectedResourceRevisionId,
    observedSpecDigest: outputs.observedSpecDigest as `sha256:${string}`,
    transitionEvidenceDigest: snapshot.transitionEvidence.digest,
    nativeResources: result.nativeResources ?? [],
    committed: true,
  };
}

function transitionOperationResult(
  proof: ResourceFormTransitionHostProof,
): NonNullable<ResourceOperationRun["resourceOperationResult"]> {
  return {
    summary: "exact Resource Form transition committed",
    resourceForm: proof.toForm,
    nativeResources: proof.nativeResources,
    backendOperationId: proof.operationId,
    outputs: {
      observedSpecDigest: proof.observedSpecDigest,
      resourceGeneration: proof.resourceGeneration,
      expectedResourceRevisionId: proof.expectedResourceRevisionId,
    },
  };
}

function transitionProofsEqual(
  left: ResourceFormTransitionHostProof,
  right: ResourceFormTransitionHostProof,
): boolean {
  return (
    left.operationId === right.operationId &&
    resourceFormIdentitiesEqual(left.fromForm, right.fromForm) &&
    resourceFormIdentitiesEqual(left.toForm, right.toForm) &&
    left.resourceGeneration === right.resourceGeneration &&
    left.expectedResourceRevisionId === right.expectedResourceRevisionId &&
    left.observedSpecDigest === right.observedSpecDigest &&
    left.transitionEvidenceDigest === right.transitionEvidenceDigest &&
    nativeIdentitySetsEqual(left.nativeResources, right.nativeResources) &&
    left.committed === right.committed
  );
}

function sameIdentityFence(
  current: ResourceIdentityFenceRecord | null,
  expected: ResourceIdentityFenceRecord | null,
): boolean {
  return expected === null
    ? current === null
    : current !== null && matchesResourceIdentityFence(current, expected);
}

function consumedSnapshotIdentityFence(
  snapshot: ResourceFormTransitionRunEvidence,
): ResourceIdentityFenceRecord {
  return consumeResourceIdentityFence(
    snapshot.resource.id,
    snapshot.resource.generation + 1,
    snapshot.identityFence,
  );
}

async function canonicalTransitionCommitMatches(
  resource: ResourceShapeRecord,
  lock: ResolutionLockRecord,
  identityFence: ResourceIdentityFenceRecord | null,
  snapshot: ResourceFormTransitionRunEvidence,
  proof: ResourceFormTransitionHostProof,
): Promise<boolean> {
  return (
    resourceFormIdentitiesEqual(resource.form, snapshot.toForm) &&
    resourceFormIdentitiesEqual(lock.form, snapshot.toForm) &&
    (await resourceFormTransitionDesiredSpecDigest(resource.spec)) ===
      snapshot.desiredSpecDigest &&
    nativeIdentitySetsEqual(lock.nativeResources, proof.nativeResources) &&
    resource.generation === snapshot.resource.generation + 1 &&
    resource.observedGeneration === snapshot.resource.generation + 1 &&
    resource.pendingOperation === undefined &&
    sameIdentityFence(
      identityFence,
      consumedSnapshotIdentityFence(snapshot),
    )
  );
}

/**
 * Stable value-free terminal receipt projection. Raw desired state comes only
 * from the exact replay body, the still-matching N+1 aggregate, or an exact
 * operation-bound host readback; it is never persisted in the Run ledger.
 */
function committedTransitionReceipt(
  run: ResourceOperationRun,
  desiredSpec: JsonObject,
  proof: ResourceFormTransitionHostProof,
): ResourceFormTransitionResult {
  const snapshot = requiredSnapshot(run);
  const committedAt = run.finishedAt ?? snapshot.claim.updatedAt;
  const generation = snapshot.resource.generation + 1;
  const resource: ResourceShapeRecord = {
    id: snapshot.resource.id as ResourceShapeRecordId,
    spaceId: snapshot.resource.workspaceId as SpaceId,
    kind: snapshot.resource.kind,
    form: snapshot.toForm,
    name: snapshot.resource.name,
    managedBy: snapshot.resource.managedBy,
    owner: snapshot.resource.owner,
    spec: structuredClone(desiredSpec),
    phase: "Ready",
    generation,
    revision: snapshot.claim.revision + 1,
    observedGeneration: generation,
    conditions: formTransitionCommittedConditions(
      undefined,
      generation,
      committedAt,
    ),
    lastOperationRunId: run.id,
    createdAt: snapshot.resource.createdAt as ResourceShapeRecord["createdAt"],
    updatedAt: committedAt as ResourceShapeRecord["updatedAt"],
  };
  const lock: ResolutionLockRecord = {
    ...snapshot.resolutionLock,
    form: snapshot.toForm,
    nativeResources: bindNativeResourceFormIdentity(
      proof.nativeResources,
      snapshot.toForm,
    ),
    updatedAt: committedAt as ResolutionLockRecord["updatedAt"],
  };
  return {
    status: "committed",
    operationId: run.resourceOperationKey,
    requestDigest: snapshot.requestDigest,
    resource,
    lock,
    proof,
  };
}

function formTransitionCommittedConditions(
  current: ResourceShapeRecord["conditions"],
  generation: number,
  at: string,
): NonNullable<ResourceShapeRecord["conditions"]> {
  return [
    ...(current ?? []).filter((condition) => condition.type !== "Ready"),
    {
      type: "Ready",
      status: "true",
      reason: "FormTransitionCommitted",
      observedGeneration: generation,
      lastTransitionAt: at,
    },
  ];
}

function transitionPendingOperation(
  run: ResourceOperationRun,
  snapshot: ResourceFormTransitionRunEvidence,
) {
  return {
    runId: run.id,
    operation: "form_transition" as const,
    operationKey: run.resourceOperationKey,
    authority: "resource_claim" as const,
    identityFenceRevision: snapshot.identityFence?.fenceRevision ?? 0,
  };
}

function transitionClaimMatches(
  current: ResourceShapeRecord,
  run: ResourceOperationRun,
  snapshot: ResourceFormTransitionRunEvidence,
): boolean {
  const pending = current.pendingOperation;
  const expected = transitionPendingOperation(run, snapshot);
  return (
    resourceMatchesTransitionPreconditionIgnoringVersion(current, snapshot) &&
    current.updatedAt === snapshot.claim.updatedAt &&
    resourceRecordRevision(current) === snapshot.claim.revision &&
    pending?.runId === expected.runId &&
    pending.operation === expected.operation &&
    pending.operationKey === expected.operationKey &&
    pending.authority === expected.authority &&
    pending.identityFenceRevision === expected.identityFenceRevision
  );
}

function transitionClaimBelongsTo(
  current: ResourceShapeRecord,
  run: ResourceOperationRun,
): boolean {
  const pending = current.pendingOperation;
  return (
    pending?.runId === run.id &&
    pending.operation === "form_transition" &&
    pending.operationKey === run.resourceOperationKey
  );
}

function resourceMatchesTransitionPrecondition(
  current: ResourceShapeRecord,
  snapshot: ResourceFormTransitionRunEvidence,
): boolean {
  return (
    resourceMatchesTransitionPreconditionIgnoringVersion(current, snapshot) &&
    current.updatedAt === snapshot.resource.updatedAt &&
    resourceRecordRevision(current) === snapshot.resource.revision &&
    current.pendingOperation === undefined
  );
}

function resourceMatchesTransitionPreconditionIgnoringVersion(
  current: ResourceShapeRecord,
  snapshot: ResourceFormTransitionRunEvidence,
): boolean {
  return (
    current.id === snapshot.resource.id &&
    current.spaceId === snapshot.resource.workspaceId &&
    current.kind === snapshot.resource.kind &&
    current.name === snapshot.resource.name &&
    current.managedBy === snapshot.resource.managedBy &&
    current.phase === snapshot.resource.phase &&
    current.generation === snapshot.resource.generation &&
    current.observedGeneration === snapshot.resource.observedGeneration &&
    resourceRevisionId(current) === snapshot.resource.revisionId &&
    resourceFormIdentitiesEqual(current.form, snapshot.fromForm) &&
    sameOwner(current.owner, snapshot.resource.owner)
  );
}

function sameOwner(
  left: ResourceShapeRecord["owner"],
  right: ResourceCapsuleOwner,
): boolean {
  return (
    left !== undefined &&
    typeof left !== "string" &&
    left.kind === right.kind &&
    left.id === right.id &&
    left.workspaceId === right.workspaceId &&
    left.installingPrincipalId === right.installingPrincipalId
  );
}

function unresolvedResult(
  run: ResourceOperationRun,
  dispatchAttempted: boolean,
): ResourceFormTransitionResult {
  const snapshot = requiredSnapshot(run);
  return dispatchAttempted
    ? {
        status: "indeterminate",
        operationId: run.resourceOperationKey,
        requestDigest: snapshot.requestDigest,
        dispatchAttempted: true,
      }
    : {
        status: "prepared",
        operationId: run.resourceOperationKey,
        requestDigest: snapshot.requestDigest,
        dispatchAttempted: false,
      };
}

function nextTransitionTimestamp(now: string, current: string): string {
  if (now > current) return now;
  const millis = Date.parse(current);
  if (!Number.isFinite(millis)) {
    throw error("canonical_conflict", "Resource timestamp is invalid");
  }
  return new Date(millis + 1).toISOString();
}

function transitionRunId(operationId: string): string {
  return `resource-form-transition:${operationId}`;
}

function stableHostRejectionCode(value: string): string {
  return HOST_REJECTION_CODE_RE.test(value) ? value : "host_rejected";
}

function error(
  code: ResourceFormTransitionErrorCode,
  message: string,
): ResourceFormTransitionError {
  return new ResourceFormTransitionError(code, message);
}
