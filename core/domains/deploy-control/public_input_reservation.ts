import type {
  ApplyRun,
  PlanRun,
} from "@takosumi/internal/deploy-control-api";
import {
  installExperiencePublicEndpoint,
  type JsonValue,
} from "takosumi-contract";
import { canonicalRunCredentialSettings } from "takosumi-contract/connections";
import type { InstallConfig } from "takosumi-contract/install-configs";
import type {
  CredentialRecipeDriverPublicInputOwner,
  CredentialRecipeDriverPublicInputReleaseResult,
  CredentialRecipeDriverPublicInputs,
} from "takosumi-contract/credential-recipe-host";

import type {
  CapsuleProviderBindingMintEntry,
  PublicInputReservationDriverPort,
} from "../../adapters/vault/mod.ts";
import {
  stableJsonDigest,
  stableStringify,
} from "../../adapters/source/digest.ts";
import { OpenTofuControllerError } from "./errors.ts";
import type { OpenTofuControlStore } from "./store.ts";

const OPENTOFU_VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/u;
const CLIENT_KEY_DOMAIN =
  "takosumi.public-input.http-endpoint-client-key/v1";
const RESERVATION_LIFECYCLE_NONCE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const INTENT_KIND =
  "takosumi.public-input-reservation-intent@v1" as const;
const RECEIPT_KIND =
  "takosumi.public-input-reservation-receipt@v1" as const;
const LIFECYCLE_KIND =
  "takosumi.public-input-reservation-lifecycle@v2" as const;
const PLAN_DECISION_KIND =
  "takosumi.public-input-reservation-plan-decision@v1" as const;
const EFFECT_CLAIM_TTL_MS = 30_000;
export const PUBLIC_INPUT_RESERVATION_MAX_RETIRING = 64;
/** Store adapters use this only to discover pre-v2 rows without rewriting them. */
export const PUBLIC_INPUT_RESERVATION_LEGACY_INTENT_KIND = INTENT_KIND;

export interface PublicInputReservationRequirementFields {
  readonly workspaceId: string;
  readonly capsuleId: string;
  readonly installConfigId: string;
  readonly capsuleExecutionAuthorityEpoch: number;
  readonly sourceSnapshotId: string;
  readonly repositoryInstallUxDigest: string;
  readonly targetVariable: string;
  readonly subdomainVariable: string;
  readonly requestedSubdomain: string;
  readonly owner: CredentialRecipeDriverPublicInputOwner;
}

interface PublicInputReservationAuthorityFields
  extends PublicInputReservationRequirementFields {
  /** Private lifecycle entropy. Never sent to a provider or public ledger. */
  readonly reservationLifecycleNonce: string;
  readonly clientIdempotencyKey: string;
}

/** Durable before-effect record. It contains no provider allocation identity. */
export interface PublicInputReservationIntent
  extends PublicInputReservationAuthorityFields {
  readonly kind: typeof INTENT_KIND;
  readonly digest: `sha256:${string}`;
}

/** Provider-owned opaque reference plus immutable compiled repository pin. */
export interface PublicInputReservationReceipt
  extends PublicInputReservationAuthorityFields {
  readonly kind: typeof RECEIPT_KIND;
  readonly reservationRef: string;
  readonly httpEndpointUrl: string;
  readonly digest: `sha256:${string}`;
}

export type PublicInputReservationLegacyRecord =
  | PublicInputReservationIntent
  | PublicInputReservationReceipt;

export interface PublicInputReservationCandidate {
  /** Missing only while decoding an unbound v1 intent written by old code. */
  readonly planRunId?: string;
  /** Explicit only after old unbound work is claimed by a current Plan. */
  readonly purpose?: "plan" | "legacy_repair";
  readonly stagedAt: number;
  /** Durable slot ownership precedes private nonce generation/provider effect. */
  readonly requirement: PublicInputReservationRequirementFields;
  readonly reservation?: PublicInputReservationLegacyRecord;
  /** Short durable lease: exactly one caller may create/replay provider state. */
  readonly effectClaim?: {
    readonly token: string;
    readonly claimedAt: number;
  };
}

export interface PublicInputReservationRetirement {
  readonly cleanupRunId: string;
  readonly enqueuedAt: number;
  readonly receipt: PublicInputReservationReceipt;
}

/**
 * The one private Capsule-owned reservation lifecycle. `applied` remains live
 * until an Apply/Destroy commit promotes or removes it; Plan work is isolated
 * in `candidate`, and every post-commit provider release is durable in
 * `retiring`.
 */
export interface PublicInputReservationLifecycle {
  readonly kind: typeof LIFECYCLE_KIND;
  readonly applied?: PublicInputReservationReceipt;
  readonly candidate?: PublicInputReservationCandidate;
  readonly retiring: readonly PublicInputReservationRetirement[];
  readonly digest: `sha256:${string}`;
}

export type PublicInputReservationStoredValue =
  | PublicInputReservationLegacyRecord
  | PublicInputReservationLifecycle;

export interface PublicInputReservationPlanDecision {
  readonly kind: typeof PLAN_DECISION_KIND;
  readonly planRunId: string;
  readonly workspaceId: string;
  readonly capsuleId: string;
  readonly installConfigId: string;
  readonly capsuleExecutionAuthorityEpoch: number;
  readonly sourceSnapshotId: string;
  readonly operation: "present" | "absent" | "destroy";
  readonly source?: "applied" | "candidate";
  readonly expectedLifecycleDigest?: string;
  readonly expectedAppliedReceiptDigest?: string;
  readonly receipt?: PublicInputReservationReceipt;
  readonly digest: `sha256:${string}`;
}

export interface PublicInputReservationLifecycleTransition {
  readonly capsuleId: string;
  readonly expectedLifecycleDigest: string;
  readonly lifecycle?: PublicInputReservationLifecycle;
}

export interface PublicInputReservationCleanupProjection {
  readonly runId: string;
  readonly enqueuedAt: number;
}

export interface PublicInputReservationApplyGuard {
  readonly decision: PublicInputReservationPlanDecision;
  readonly lifecycle: PublicInputReservationLifecycle;
}

export interface PreparedPublicInputReservation {
  readonly variables: Readonly<Record<string, JsonValue>>;
  readonly decision?: PublicInputReservationPlanDecision;
}

export interface PublicInputReservationStorePort
  extends Pick<
    OpenTofuControlStore,
    | "adoptCapsulePublicInputReservationRecord"
    | "claimCapsulePublicInputReservationLegacyCandidate"
    | "deleteCapsulePublicInputReservationRecord"
    | "getApplyRun"
    | "getCapsule"
    | "getCapsuleExecutionAuthorityEpoch"
    | "getCapsulePublicInputReservationRecord"
    | "getInstallConfig"
    | "getPlanRun"
    | "replaceCapsulePublicInputReservationRecord"
    | "settleCapsulePublicInputReservationLifecycle"
  > {}

interface PublicInputReservationCapsuleAuthority {
  readonly workspaceId: string;
  readonly capsuleId: string;
  readonly installConfigId: string;
  readonly installConfig?: InstallConfig;
  readonly epoch: number;
  readonly sourceSnapshotId: string;
}

interface PublicInputReservationAuthority
  extends PublicInputReservationCapsuleAuthority {
  readonly target: string;
  readonly subdomainVariable: string;
  readonly requestedSubdomain: string;
  readonly repositoryInstallUxDigest: string;
}

export class PublicInputReservationService {
  readonly #store: PublicInputReservationStorePort;
  readonly #driver: PublicInputReservationDriverPort;
  readonly #newReservationLifecycleNonce: () => string;
  readonly #newEffectClaimToken: () => string;
  readonly #now: () => number;

  constructor(input: {
    readonly store: PublicInputReservationStorePort;
    readonly driver: PublicInputReservationDriverPort;
    readonly newReservationLifecycleNonce?: () => string;
    readonly newEffectClaimToken?: () => string;
    readonly now?: () => number;
  }) {
    this.#store = input.store;
    this.#driver = input.driver;
    this.#newReservationLifecycleNonce =
      input.newReservationLifecycleNonce ?? (() => crypto.randomUUID());
    this.#newEffectClaimToken =
      input.newEffectClaimToken ?? (() => crypto.randomUUID());
    this.#now = input.now ?? (() => Date.now());
  }

  /**
   * Stages one Plan-owned candidate while keeping the applied reservation live.
   * Drift and Destroy use lookup-only branches and can never allocate here.
   */
  async preparePlan(input: {
    readonly planRun: PlanRun;
    readonly providerBindings: readonly CapsuleProviderBindingMintEntry[];
    readonly variables: Readonly<Record<string, JsonValue>>;
  }): Promise<PreparedPublicInputReservation> {
    const capsuleAuthority = await this.#capsuleAuthority(input.planRun);
    if (!capsuleAuthority) return frozenVariables(input.variables);
    const authority = this.#endpointAuthority(
      capsuleAuthority,
      input.variables,
    );
    let lifecycle = await this.#lifecycle(capsuleAuthority.capsuleId);

    if (input.planRun.driftCheck === true) {
      return await this.#prepareDrift({ ...input, authority, lifecycle });
    }
    if (input.planRun.operation === "destroy") {
      return await this.#prepareDestroy({
        ...input,
        capsuleAuthority,
        lifecycle,
      });
    }
    if (!authority) {
      if (unboundLegacyCandidate(lifecycle?.candidate)) {
        await this.#claimLegacyCandidate(
          lifecycle!,
          capsuleAuthority,
          input.planRun,
          "legacy_repair",
        );
        throw reservationError(
          "legacy endpoint reservation repair was scheduled; retry after cleanup",
        );
      }
      if (lifecycle?.candidate) {
        throw reservationError(
          "another Plan still owns a staged endpoint reservation",
        );
      }
      if (!lifecycle?.applied) return frozenVariables(input.variables);
      return {
        variables: Object.freeze({ ...input.variables }),
        decision: await createPublicInputReservationPlanDecision({
          planRun: input.planRun,
          capsuleAuthority,
          operation: "absent",
          lifecycle,
          applied: lifecycle.applied,
        }),
      };
    }
    if (Object.prototype.hasOwnProperty.call(input.variables, authority.target)) {
      throw reservationError(
        `the compiled endpoint target ${authority.target} is already populated`,
      );
    }
    let owner: CredentialRecipeDriverPublicInputOwner;
    try {
      owner = await this.#selectOwner(
        authority.workspaceId,
        input.providerBindings,
      );
    } catch (error) {
      if (!unboundLegacyCandidate(lifecycle?.candidate)) throw error;
      await this.#claimLegacyCandidate(
        lifecycle!,
        capsuleAuthority,
        input.planRun,
        "legacy_repair",
      );
      throw reservationError(
        "legacy endpoint reservation repair was scheduled; retry after cleanup",
      );
    }

    if (unboundLegacyCandidate(lifecycle?.candidate)) {
      const exactRetry = candidateMatchesRequirement(
        lifecycle!.candidate!,
        authority,
        owner,
      );
      lifecycle = await this.#claimLegacyCandidate(
        lifecycle!,
        capsuleAuthority,
        input.planRun,
        exactRetry ? "plan" : "legacy_repair",
      );
      if (!exactRetry) {
        throw reservationError(
          "legacy endpoint reservation repair was scheduled; retry after cleanup",
        );
      }
    }

    if (lifecycle?.candidate?.purpose === "legacy_repair") {
      throw reservationError(
        "legacy endpoint reservation repair is pending",
      );
    }

    if (lifecycle?.candidate &&
      lifecycle.candidate.planRunId !== input.planRun.id) {
      throw reservationError(
        "another Plan still owns a staged endpoint reservation",
      );
    }

    if (!lifecycle?.candidate && lifecycle?.applied &&
      sameRequirement(lifecycle.applied, authority, owner)) {
      const planned = await this.#rereadAppliedReceipt(
        lifecycle.applied,
        authority,
        owner,
      );
      const decision = await createPublicInputReservationPlanDecision({
        planRun: input.planRun,
        capsuleAuthority,
        operation: "present",
        source: "applied",
        lifecycle,
        applied: lifecycle.applied,
        receipt: planned,
      });
      return overlayDecision(input.variables, decision);
    }

    let staged = lifecycle ?? await createPublicInputReservationLifecycle({
      retiring: [],
    });
    if (!staged.candidate) {
      staged = await this.#stageCandidateSlot(staged, authority, owner, input.planRun);
    }
    if (!candidateMatchesRequirement(staged.candidate!, authority, owner) ||
      staged.candidate!.planRunId !== input.planRun.id) {
      throw reservationError("the staged reservation authority changed");
    }
    const intent = await this.#ensureCandidateIntent(staged, authority, owner);
    staged = await this.#ensureCandidateReceipt(
      intent.lifecycle,
      authority,
      owner,
      intent.effectClaimToken,
    );
    const receipt = staged.candidate?.reservation;
    if (!receipt || receipt.kind !== RECEIPT_KIND) {
      throw reservationError("the staged reservation receipt is unavailable");
    }
    const decision = await createPublicInputReservationPlanDecision({
      planRun: input.planRun,
      capsuleAuthority,
      operation: "present",
      source: "candidate",
      lifecycle: staged,
      applied: staged.applied,
      receipt,
    });
    return overlayDecision(input.variables, decision);
  }

  /** Apply re-read. It returns an immutable guard consumed by commitRunState. */
  async revalidate(input: {
    readonly planRun: PlanRun;
    readonly providerBindings: readonly CapsuleProviderBindingMintEntry[];
    readonly variables: Readonly<Record<string, JsonValue>>;
    readonly expected: PublicInputReservationPlanDecision | undefined;
  }): Promise<PublicInputReservationApplyGuard | undefined> {
    const capsuleAuthority = await this.#capsuleAuthority(input.planRun);
    if (!capsuleAuthority && !input.expected) return undefined;
    if (!capsuleAuthority || !input.expected) {
      throw reservationError("the Plan endpoint reservation decision is missing");
    }
    const decision = await assertPublicInputReservationPlanDecisionDigest(
      input.expected,
    );
    if (!decisionMatchesCapsuleAuthority(decision, capsuleAuthority, input.planRun)) {
      throw reservationError("the Plan endpoint Capsule authority changed");
    }
    const lifecycle = await this.#lifecycle(capsuleAuthority.capsuleId);
    if (!lifecycle) throw reservationError("the durable endpoint lifecycle is missing");
    assertRetirementCapacityForDecision(decision, lifecycle);

    if (decision.operation === "absent") {
      if (
        capsuleAuthority.installConfig &&
        publicEndpointPreflightProjection(capsuleAuthority.installConfig)
      ) {
        throw reservationError(
          "the compiled endpoint requirement changed since Plan",
        );
      }
      if (lifecycle.candidate || !lifecycle.applied ||
        lifecycle.applied.digest !== decision.expectedAppliedReceiptDigest) {
        throw reservationError("the durable applied endpoint changed");
      }
      await this.#assertExactProviderReceipt(lifecycle.applied);
      return { decision, lifecycle };
    }

    const receipt = decision.receipt;
    if (!receipt) throw reservationError("the Plan endpoint receipt is missing");
    if (
      decision.operation === "present" &&
      !receiptMatchesCurrentEndpointAuthority(
        receipt,
        capsuleAuthority,
        input.variables,
      )
    ) {
      throw reservationError(
        "the compiled endpoint provenance changed since Plan",
      );
    }
    let durableReceipt: PublicInputReservationReceipt | undefined;
    if (decision.operation === "destroy" || decision.source === "applied") {
      durableReceipt = lifecycle.applied;
      if (!durableReceipt ||
        durableReceipt.digest !== decision.expectedAppliedReceiptDigest ||
        (decision.operation !== "destroy" &&
          !sameProviderReservationIdentity(durableReceipt, receipt))) {
        throw reservationError("the durable applied endpoint changed");
      }
    } else {
      const candidate = lifecycle.candidate;
      durableReceipt = candidate?.reservation?.kind === RECEIPT_KIND
        ? candidate.reservation
        : undefined;
      if (candidate?.planRunId !== input.planRun.id ||
        !durableReceipt || durableReceipt.digest !== receipt.digest ||
        lifecycle.applied?.digest !==
          decision.expectedAppliedReceiptDigest) {
        throw reservationError("the durable staged endpoint changed");
      }
      if (lifecycle.applied) {
        await this.#assertExactProviderReceipt(lifecycle.applied);
      }
    }
    const currentOwner = await this.#selectOwner(
      receipt.workspaceId,
      input.providerBindings,
    );
    if (!samePublicInputOwner(currentOwner, receipt.owner)) {
      throw reservationError("the Plan endpoint reservation owner changed");
    }
    await this.#assertExactProviderReceipt(durableReceipt);
    return { decision, lifecycle };
  }

  /** Builds the lifecycle CAS that must join the provider ledger commit. */
  async transitionForApply(input: {
    readonly guard: PublicInputReservationApplyGuard | undefined;
    readonly outcome: "applied" | "provider_failed";
    readonly cleanupRunId: string;
    readonly now: number;
  }): Promise<PublicInputReservationLifecycleTransition | undefined> {
    if (!input.guard) return undefined;
    const { decision, lifecycle } = input.guard;
    assertRetirementCapacityForDecision(decision, lifecycle);
    let applied = lifecycle.applied;
    let candidate = lifecycle.candidate;
    let retiring = [...lifecycle.retiring];
    if (input.outcome === "provider_failed") {
      if (decision.source === "candidate") {
        const receipt = candidate?.reservation;
        if (!receipt || receipt.kind !== RECEIPT_KIND ||
          candidate?.planRunId !== decision.planRunId) {
          throw reservationError("the failed Apply candidate changed");
        }
        retiring = enqueueRetirement(
          retiring,
          receipt,
          input.cleanupRunId,
          input.now,
        );
        candidate = undefined;
      } else {
        return undefined;
      }
    } else if (decision.operation === "present") {
      const receipt = decision.receipt!;
      if (decision.source === "candidate") {
        if (candidate?.planRunId !== decision.planRunId ||
          candidate.reservation?.kind !== RECEIPT_KIND ||
          candidate.reservation.digest !== receipt.digest) {
          throw reservationError("the Apply candidate changed");
        }
        if (applied && !sameProviderReservationIdentity(applied, receipt)) {
          retiring = enqueueRetirement(
            retiring,
            applied,
            input.cleanupRunId,
            input.now,
          );
        }
        candidate = undefined;
      }
      applied = receipt;
    } else {
      if (candidate) throw reservationError("Destroy/absence cannot discard a staged Plan");
      if (applied) {
        retiring = enqueueRetirement(
          retiring,
          applied,
          input.cleanupRunId,
          input.now,
        );
      }
      applied = undefined;
    }
    const next = await createPublicInputReservationLifecycle({
      applied,
      candidate,
      retiring,
    });
    return {
      capsuleId: decision.capsuleId,
      expectedLifecycleDigest: lifecycle.digest,
      lifecycle: next,
    };
  }

  /** Typed provider release only; internal completion stays a lifecycle CAS. */
  async release(
    receiptInput: PublicInputReservationReceipt,
  ): Promise<CredentialRecipeDriverPublicInputReleaseResult> {
    const receipt = assertPublicInputReservationReceipt(receiptInput);
    await assertPublicInputReservationRecordDigest(receipt);
    try {
      return await this.#driver.releasePublicInputReservation(
        receipt.workspaceId,
        receipt.owner,
        Object.freeze({
          httpEndpointUrl: Object.freeze({
            clientIdempotencyKey: receipt.clientIdempotencyKey,
            requestedSubdomain: receipt.requestedSubdomain,
            reservationRef: receipt.reservationRef,
          }),
        }),
      );
    } catch {
      throw reservationError("typed provider reservation release failed");
    }
  }

  /**
   * Releases only work proven unreachable by an applyable Plan. This method is
   * safe for direct completion and global repair redelivery.
   */
  async cleanupForRun(input: {
    readonly capsuleId: string;
    readonly runId: string;
  }): Promise<void> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      let lifecycle = await this.#lifecycle(input.capsuleId);
      if (!lifecycle) return;
      const candidate = lifecycle.candidate;
      if (candidate?.planRunId === input.runId) {
        const plan = await this.#store.getPlanRun(input.runId);
        if (
          !planCandidateCleanupSafe(plan) ||
          plan?.capsuleId !== input.capsuleId ||
          plan.workspaceId !== candidate.requirement.workspaceId
        ) {
          throw reservationError("the staged reservation still has an applyable Plan");
        }
        if (!candidate.reservation) {
          const next = await createPublicInputReservationLifecycle({
            applied: lifecycle.applied,
            retiring: lifecycle.retiring,
          });
          await this.#replaceLifecycleOrRetry(lifecycle, next);
          continue;
        }
        if (candidate.reservation.kind === INTENT_KIND) {
          const resolved = await this.#resolve(
            candidate.reservation.workspaceId,
            candidate.reservation.owner,
            candidate.reservation.clientIdempotencyKey,
            candidate.reservation.requestedSubdomain,
          );
          const receipt = await createPublicInputReservationReceiptFromRecord(
            candidate.reservation,
            resolved,
          );
          const next = await createPublicInputReservationLifecycle({
            applied: lifecycle.applied,
            candidate: { ...candidate, reservation: receipt },
            retiring: lifecycle.retiring,
          });
          await this.#replaceLifecycleOrRetry(lifecycle, next);
          continue;
        }
        if (lifecycle.retiring.length >= PUBLIC_INPUT_RESERVATION_MAX_RETIRING) {
          // Keep the proven receipt in its candidate slot. The value-free
          // projection prioritizes an existing retirement until a slot drains,
          // then global repair redelivers this Run.
          return;
        }
        const next = await createPublicInputReservationLifecycle({
          applied: lifecycle.applied,
          retiring: enqueueRetirement(
            lifecycle.retiring,
            candidate.reservation,
            input.runId,
            this.#now(),
          ),
        });
        await this.#replaceLifecycleOrRetry(lifecycle, next);
        continue;
      }
      const retirement = lifecycle.retiring.find(
        (entry) => entry.cleanupRunId === input.runId,
      );
      if (!retirement) return;
      const run = await this.#store.getApplyRun(input.runId) ??
        await this.#store.getPlanRun(input.runId);
      if (
        !cleanupRunTerminal(run) ||
        run?.capsuleId !== input.capsuleId ||
        run.workspaceId !== retirement.receipt.workspaceId
      ) {
        throw reservationError("the reservation retirement Run is not terminal");
      }
      await this.release(retirement.receipt);
      lifecycle = (await this.#lifecycle(input.capsuleId)) ?? lifecycle;
      if (!lifecycle.retiring.some((entry) =>
        entry.receipt.digest === retirement.receipt.digest &&
        entry.cleanupRunId === retirement.cleanupRunId)) return;
      const nextRetiring = lifecycle.retiring.filter((entry) =>
        entry.receipt.digest !== retirement.receipt.digest ||
        entry.cleanupRunId !== retirement.cleanupRunId);
      if (!lifecycle.applied && !lifecycle.candidate && nextRetiring.length === 0) {
        const deleted = await this.#store.deleteCapsulePublicInputReservationRecord({
          capsuleId: input.capsuleId,
          expectedRecordDigest: lifecycle.digest,
        });
        if (!deleted) continue;
        return;
      }
      const next = await createPublicInputReservationLifecycle({
        applied: lifecycle.applied,
        candidate: lifecycle.candidate,
        retiring: nextRetiring,
      });
      await this.#replaceLifecycleOrRetry(
        lifecycle,
        next,
      );
    }
    throw reservationError("reservation cleanup changed concurrently");
  }

  async #capsuleAuthority(
    planRun: PlanRun,
  ): Promise<PublicInputReservationCapsuleAuthority | undefined> {
    const capsuleId = planRun.capsuleId;
    if (!capsuleId || !planRun.capsuleContext) return undefined;
    const capsule = await this.#store.getCapsule(capsuleId);
    if (
      !capsule ||
      capsule.workspaceId !== planRun.workspaceId ||
      capsule.id !== planRun.capsuleContext.capsuleId
    ) {
      throw reservationError("Capsule authority is unavailable");
    }
    const installConfig = await this.#store.getInstallConfig(
      capsule.installConfigId,
    );
    if (!installConfig && planRun.operation !== "destroy") {
      throw reservationError("InstallConfig authority is unavailable");
    }
    const sourceSnapshotId = planRun.sourceSnapshotId ??
      installConfig?.internal?.sourceSnapshotId;
    if (!sourceSnapshotId) {
      throw reservationError("SourceSnapshot authority is unavailable");
    }
    const epoch = planRun.capsuleExecutionAuthorityEpoch ?? 1;
    if (
      (await this.#store.getCapsuleExecutionAuthorityEpoch(capsule.id)) !== epoch
    ) {
      throw reservationError("Capsule execution authority changed");
    }
    return {
      workspaceId: capsule.workspaceId,
      capsuleId: capsule.id,
      installConfigId: capsule.installConfigId,
      ...(installConfig ? { installConfig } : {}),
      epoch,
      sourceSnapshotId,
    };
  }

  #endpointAuthority(
    capsuleAuthority: PublicInputReservationCapsuleAuthority,
    variables: Readonly<Record<string, JsonValue>>,
  ): PublicInputReservationAuthority | undefined {
    if (!capsuleAuthority.installConfig) return undefined;
    const projection = publicEndpointPreflightProjection(
      capsuleAuthority.installConfig,
    );
    if (!projection) return undefined;
    const requestedSubdomain = variables[projection.subdomainVariable];
    if (!validRequestedSubdomain(requestedSubdomain)) {
      throw reservationError(
        `the compiled endpoint subdomain target ${projection.subdomainVariable} is not Plan-known`,
      );
    }
    return {
      ...capsuleAuthority,
      target: projection.targetVariable,
      subdomainVariable: projection.subdomainVariable,
      requestedSubdomain,
      repositoryInstallUxDigest:
        capsuleAuthority.installConfig.internal!.repositoryInstallUxDigest!,
    };
  }

  async #prepareDrift(input: {
    readonly planRun: PlanRun;
    readonly providerBindings: readonly CapsuleProviderBindingMintEntry[];
    readonly variables: Readonly<Record<string, JsonValue>>;
    readonly authority: PublicInputReservationAuthority | undefined;
    readonly lifecycle: PublicInputReservationLifecycle | undefined;
  }): Promise<PreparedPublicInputReservation> {
    if (!input.authority) {
      if (input.lifecycle?.applied || input.lifecycle?.candidate) {
        throw reservationError(
          "drift endpoint requirement does not match the durable applied receipt",
        );
      }
      return frozenVariables(input.variables);
    }
    if (Object.prototype.hasOwnProperty.call(
      input.variables,
      input.authority.target,
    )) {
      throw reservationError(
        `the compiled endpoint target ${input.authority.target} is already populated`,
      );
    }
    const applied = input.lifecycle?.applied;
    if (!applied) {
      throw reservationError(
        "drift lookup requires a durable applied endpoint receipt",
      );
    }
    const owner = await this.#selectOwner(
      input.authority.workspaceId,
      input.providerBindings,
    );
    if (!sameRequirement(applied, input.authority, owner)) {
      throw reservationError(
        "drift endpoint authority does not match the applied receipt",
      );
    }
    const planned = await this.#rereadAppliedReceipt(
      applied,
      input.authority,
      owner,
    );
    const decision = await createPublicInputReservationPlanDecision({
      planRun: input.planRun,
      capsuleAuthority: input.authority,
      operation: "present",
      source: "applied",
      lifecycle: input.lifecycle!,
      applied,
      receipt: planned,
    });
    return overlayDecision(input.variables, decision);
  }

  async #prepareDestroy(input: {
    readonly planRun: PlanRun;
    readonly providerBindings: readonly CapsuleProviderBindingMintEntry[];
    readonly variables: Readonly<Record<string, JsonValue>>;
    readonly capsuleAuthority: PublicInputReservationCapsuleAuthority;
    readonly lifecycle: PublicInputReservationLifecycle | undefined;
  }): Promise<PreparedPublicInputReservation> {
    if (unboundLegacyCandidate(input.lifecycle?.candidate)) {
      await this.#claimLegacyCandidate(
        input.lifecycle!,
        input.capsuleAuthority,
        input.planRun,
        "legacy_repair",
      );
      throw reservationError(
        "legacy endpoint reservation repair was scheduled; retry Destroy after cleanup",
      );
    }
    if (input.lifecycle?.candidate) {
      throw reservationError(
        "Destroy cannot overtake a staged endpoint reservation Plan",
      );
    }
    const applied = input.lifecycle?.applied;
    if (!applied) return frozenVariables(input.variables);
    const owner = await this.#selectOwner(
      input.capsuleAuthority.workspaceId,
      input.providerBindings,
    );
    if (!samePublicInputOwner(owner, applied.owner)) {
      throw reservationError("the durable Destroy reservation owner changed");
    }
    await this.#assertExactProviderReceipt(applied);
    const decision = await createPublicInputReservationPlanDecision({
      planRun: input.planRun,
      capsuleAuthority: input.capsuleAuthority,
      operation: "destroy",
      lifecycle: input.lifecycle!,
      applied,
      receipt: applied,
    });
    // Destroy is reconstructed from the applied Plan/State provenance, not the
    // current desired manifest. Its durable applied receipt is therefore the
    // exact authority for the old root variable even after the current source
    // or InstallConfig stopped declaring http.endpoint.
    if (!Object.prototype.hasOwnProperty.call(
      input.variables,
      applied.targetVariable,
    )) {
      return overlayDecision(input.variables, decision);
    }
    return { variables: Object.freeze({ ...input.variables }), decision };
  }

  async #stageCandidateSlot(
    observed: PublicInputReservationLifecycle,
    authority: PublicInputReservationAuthority,
    owner: CredentialRecipeDriverPublicInputOwner,
    planRun: PlanRun,
  ): Promise<PublicInputReservationLifecycle> {
    let current = await this.#lifecycle(authority.capsuleId);
    if (!current && observed.applied) current = observed;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      if (current?.candidate) {
        if (
          current.candidate.planRunId === planRun.id &&
          candidateMatchesRequirement(current.candidate, authority, owner)
        ) return current;
        throw reservationError(
          "another Plan still owns a staged endpoint reservation",
        );
      }
      const base = current ?? await createPublicInputReservationLifecycle({
        retiring: [],
      });
      const next = await createPublicInputReservationLifecycle({
        applied: base.applied,
        candidate: {
          planRunId: planRun.id,
          purpose: "plan",
          stagedAt: planRun.updatedAt,
          requirement: reservationRequirementCore({ authority, owner }),
        },
        retiring: base.retiring,
      });
      const result = current
        ? await this.#store.replaceCapsulePublicInputReservationRecord({
            workspaceId: authority.workspaceId,
            capsuleId: authority.capsuleId,
            installConfigId: authority.installConfigId,
            capsuleExecutionAuthorityEpoch: authority.epoch,
            expectedRecordDigest: current.digest,
            record: next,
          })
        : await this.#store.adoptCapsulePublicInputReservationRecord({
            workspaceId: authority.workspaceId,
            capsuleId: authority.capsuleId,
            installConfigId: authority.installConfigId,
            capsuleExecutionAuthorityEpoch: authority.epoch,
            record: next,
          });
      if (result.status === "authority_changed") {
        throw reservationError("Capsule authority changed while staging endpoint work");
      }
      if (result.status === "stored") return result.record;
      current = result.record;
      if (!current) continue;
    }
    throw reservationError("the staged endpoint slot changed concurrently");
  }

  async #ensureCandidateIntent(
    lifecycle: PublicInputReservationLifecycle,
    authority: PublicInputReservationAuthority,
    owner: CredentialRecipeDriverPublicInputOwner,
  ): Promise<{
    readonly lifecycle: PublicInputReservationLifecycle;
    readonly effectClaimToken?: string;
  }> {
    const candidate = lifecycle.candidate!;
    if (candidate.reservation?.kind === RECEIPT_KIND) {
      return { lifecycle };
    }
    const claim = await this.#claimCandidateEffect(lifecycle, authority, owner);
    lifecycle = claim.lifecycle;
    const claimedCandidate = lifecycle.candidate!;
    if (claimedCandidate.reservation?.kind === RECEIPT_KIND) {
      return { lifecycle };
    }
    if (claimedCandidate.reservation?.kind === INTENT_KIND) {
      return { lifecycle, effectClaimToken: claim.token };
    }
    const reservationLifecycleNonce = assertReservationLifecycleNonce(
      this.#newReservationLifecycleNonce(),
    );
    const clientIdempotencyKey = await publicInputClientIdempotencyKey({
      capsuleId: authority.capsuleId,
      targetVariable: authority.target,
      subdomainVariable: authority.subdomainVariable,
      requestedSubdomain: authority.requestedSubdomain,
      reservationLifecycleNonce,
    });
    const intent = await createPublicInputReservationIntent({
      authority,
      owner,
      clientIdempotencyKey,
      reservationLifecycleNonce,
    });
    let current = lifecycle;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const currentCandidate = current.candidate;
      if (
        !currentCandidate ||
        currentCandidate.planRunId !== candidate.planRunId ||
        !candidateMatchesRequirement(currentCandidate, authority, owner)
      ) {
        throw reservationError("the endpoint intent changed concurrently");
      }
      if (currentCandidate.reservation) {
        if (
          currentCandidate.reservation.kind === RECEIPT_KIND ||
          currentCandidate.reservation.digest === intent.digest
        ) {
          return {
            lifecycle: current,
            ...(currentCandidate.reservation.kind === INTENT_KIND &&
                currentCandidate.effectClaim?.token === claim.token
              ? { effectClaimToken: claim.token }
              : {}),
          };
        }
        throw reservationError("the endpoint intent changed concurrently");
      }
      if (currentCandidate.effectClaim?.token !== claim.token) {
        throw reservationError("the endpoint provider effect is owned by another caller");
      }
      const next = await createPublicInputReservationLifecycle({
        applied: current.applied,
        candidate: { ...currentCandidate, reservation: intent },
        retiring: current.retiring,
      });
      const result = await this.#store.replaceCapsulePublicInputReservationRecord({
        workspaceId: authority.workspaceId,
        capsuleId: authority.capsuleId,
        installConfigId: authority.installConfigId,
        capsuleExecutionAuthorityEpoch: authority.epoch,
        expectedRecordDigest: current.digest,
        record: next,
      });
      if (result.status === "authority_changed") {
        throw reservationError("Capsule authority changed before endpoint allocation");
      }
      if (result.status === "stored") {
        return { lifecycle: result.record, effectClaimToken: claim.token };
      }
      if (!result.record) break;
      current = result.record;
    }
    throw reservationError("the endpoint intent changed concurrently");
  }

  async #claimCandidateEffect(
    lifecycle: PublicInputReservationLifecycle,
    authority: PublicInputReservationAuthority,
    owner: CredentialRecipeDriverPublicInputOwner,
  ): Promise<{
    readonly lifecycle: PublicInputReservationLifecycle;
    readonly token?: string;
  }> {
    const candidate = lifecycle.candidate;
    if (!candidate || !candidateMatchesRequirement(candidate, authority, owner)) {
      throw reservationError("the endpoint candidate authority changed");
    }
    if (candidate.reservation?.kind === RECEIPT_KIND) return { lifecycle };
    const now = this.#now();
    if (
      candidate.effectClaim &&
      candidate.effectClaim.claimedAt + EFFECT_CLAIM_TTL_MS > now
    ) {
      throw reservationError("the endpoint provider effect is already in progress");
    }
    const token = assertEffectClaimToken(this.#newEffectClaimToken());
    const next = await createPublicInputReservationLifecycle({
      applied: lifecycle.applied,
      candidate: {
        ...candidate,
        effectClaim: Object.freeze({ token, claimedAt: now }),
      },
      retiring: lifecycle.retiring,
    });
    const result = await this.#store.replaceCapsulePublicInputReservationRecord({
      workspaceId: authority.workspaceId,
      capsuleId: authority.capsuleId,
      installConfigId: authority.installConfigId,
      capsuleExecutionAuthorityEpoch: authority.epoch,
      expectedRecordDigest: lifecycle.digest,
      record: next,
    });
    if (result.status === "authority_changed") {
      throw reservationError("Capsule authority changed before endpoint allocation");
    }
    if (result.status === "stored") return { lifecycle: result.record, token };
    const winner = result.record;
    if (winner?.candidate?.reservation?.kind === RECEIPT_KIND) {
      return { lifecycle: winner };
    }
    if (winner?.candidate?.effectClaim?.token === token) {
      return { lifecycle: winner, token };
    }
    throw reservationError("the endpoint provider effect is already in progress");
  }

  async #clearCandidateEffectClaim(
    lifecycle: PublicInputReservationLifecycle,
    token: string,
  ): Promise<void> {
    const candidate = lifecycle.candidate;
    if (!candidate || candidate.effectClaim?.token !== token) return;
    const next = await createPublicInputReservationLifecycle({
      applied: lifecycle.applied,
      candidate: {
        ...(candidate.planRunId ? { planRunId: candidate.planRunId } : {}),
        ...(candidate.purpose ? { purpose: candidate.purpose } : {}),
        stagedAt: candidate.stagedAt,
        requirement: candidate.requirement,
        ...(candidate.reservation
          ? { reservation: candidate.reservation }
          : {}),
      },
      retiring: lifecycle.retiring,
    });
    await this.#store.settleCapsulePublicInputReservationLifecycle({
      capsuleId: lifecycleCapsuleId(lifecycle),
      expectedRecordDigest: lifecycle.digest,
      record: next,
    });
  }

  async #ensureCandidateReceipt(
    lifecycle: PublicInputReservationLifecycle,
    authority: PublicInputReservationAuthority,
    owner: CredentialRecipeDriverPublicInputOwner,
    effectClaimToken?: string,
  ): Promise<PublicInputReservationLifecycle> {
    const candidate = lifecycle.candidate!;
    const reservation = candidate.reservation;
    if (!reservation) throw reservationError("the endpoint intent is missing");
    if (
      reservation.kind === INTENT_KIND &&
      (!effectClaimToken || candidate.effectClaim?.token !== effectClaimToken)
    ) {
      throw reservationError("the endpoint provider effect is owned by another caller");
    }
    let resolved: CredentialRecipeDriverPublicInputs;
    try {
      resolved = await this.#resolve(
        reservation.workspaceId,
        reservation.owner,
        reservation.clientIdempotencyKey,
        reservation.requestedSubdomain,
        reservation.kind === RECEIPT_KIND
          ? reservation.reservationRef
          : undefined,
      );
    } catch (error) {
      if (reservation.kind === INTENT_KIND && effectClaimToken) {
        await this.#clearCandidateEffectClaim(
          lifecycle,
          effectClaimToken,
        );
      }
      throw error;
    }
    const receipt = await createPublicInputReservationReceipt({
      authority,
      owner,
      clientIdempotencyKey: reservation.clientIdempotencyKey,
      reservationLifecycleNonce: reservation.reservationLifecycleNonce,
      publicInputs: resolved,
    });
    if (reservation.kind === RECEIPT_KIND) {
      if (!sameProviderReservationResult(reservation, receipt)) {
        throw reservationError(
          "the provider returned a different result for the same idempotency key",
        );
      }
      return lifecycle;
    }
    let current = lifecycle;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const currentCandidate = current.candidate;
      if (
        !currentCandidate ||
        currentCandidate.planRunId !== candidate.planRunId ||
        !candidateMatchesRequirement(currentCandidate, authority, owner)
      ) {
        throw reservationError("the endpoint receipt changed concurrently");
      }
      if (currentCandidate.reservation?.kind === RECEIPT_KIND) {
        if (sameReservationResult(currentCandidate.reservation, receipt)) {
          return current;
        }
        throw reservationError("the endpoint receipt changed concurrently");
      }
      if (
        currentCandidate.reservation?.kind !== INTENT_KIND ||
        currentCandidate.reservation.digest !== reservation.digest ||
        currentCandidate.effectClaim?.token !== effectClaimToken
      ) {
        throw reservationError("the endpoint receipt changed concurrently");
      }
      const next = await createPublicInputReservationLifecycle({
        applied: current.applied,
        candidate: {
          planRunId: currentCandidate.planRunId,
          ...(currentCandidate.purpose
            ? { purpose: currentCandidate.purpose }
            : {}),
          stagedAt: currentCandidate.stagedAt,
          requirement: currentCandidate.requirement,
          reservation: receipt,
        },
        retiring: current.retiring,
      });
      const result = await this.#store.replaceCapsulePublicInputReservationRecord({
        workspaceId: authority.workspaceId,
        capsuleId: authority.capsuleId,
        installConfigId: authority.installConfigId,
        capsuleExecutionAuthorityEpoch: authority.epoch,
        expectedRecordDigest: current.digest,
        record: next,
      });
      if (result.status === "authority_changed") {
        throw reservationError("Capsule authority changed while pinning endpoint receipt");
      }
      if (result.status === "stored") return result.record;
      if (!result.record) break;
      current = result.record;
    }
    throw reservationError("the endpoint receipt changed concurrently");
  }

  async #rereadAppliedReceipt(
    applied: PublicInputReservationReceipt,
    authority: PublicInputReservationAuthority,
    owner: CredentialRecipeDriverPublicInputOwner,
  ): Promise<PublicInputReservationReceipt> {
    const live = await this.#resolve(
      applied.workspaceId,
      applied.owner,
      applied.clientIdempotencyKey,
      applied.requestedSubdomain,
      applied.reservationRef,
    );
    const planned = await createPublicInputReservationReceipt({
      authority,
      owner,
      clientIdempotencyKey: applied.clientIdempotencyKey,
      reservationLifecycleNonce: applied.reservationLifecycleNonce,
      publicInputs: live,
    });
    if (!sameProviderReservationIdentity(applied, planned)) {
      throw reservationError("the endpoint reservation changed since Apply");
    }
    return planned;
  }

  async #assertExactProviderReceipt(
    receipt: PublicInputReservationReceipt,
  ): Promise<void> {
    const live = await this.#resolve(
      receipt.workspaceId,
      receipt.owner,
      receipt.clientIdempotencyKey,
      receipt.requestedSubdomain,
      receipt.reservationRef,
    );
    if (
      live.reservationRef !== receipt.reservationRef ||
      live.httpEndpointUrl !== receipt.httpEndpointUrl
    ) {
      throw reservationError("the endpoint reservation changed since Plan");
    }
  }

  async #replaceLifecycleOrRetry(
    current: PublicInputReservationLifecycle,
    next: PublicInputReservationLifecycle,
  ): Promise<boolean> {
    return await this.#store.settleCapsulePublicInputReservationLifecycle({
      capsuleId: lifecycleCapsuleId(current),
      expectedRecordDigest: current.digest,
      record: next,
    });
  }

  async #claimLegacyCandidate(
    lifecycle: PublicInputReservationLifecycle,
    authority: PublicInputReservationCapsuleAuthority,
    planRun: PlanRun,
    purpose: "plan" | "legacy_repair",
  ): Promise<PublicInputReservationLifecycle> {
    const candidate = lifecycle.candidate;
    if (!unboundLegacyCandidate(candidate)) {
      throw reservationError("the legacy endpoint intent changed concurrently");
    }
    const next = await createPublicInputReservationLifecycle({
      applied: lifecycle.applied,
      candidate: {
        planRunId: planRun.id,
        purpose,
        stagedAt: planRun.updatedAt,
        requirement: candidate.requirement,
        reservation: candidate.reservation,
      },
      retiring: lifecycle.retiring,
    });
    const result = await this.#store
      .claimCapsulePublicInputReservationLegacyCandidate({
        workspaceId: authority.workspaceId,
        capsuleId: authority.capsuleId,
        installConfigId: authority.installConfigId,
        capsuleExecutionAuthorityEpoch: authority.epoch,
        expectedRecordDigest: lifecycle.digest,
        record: next,
      });
    if (result.status === "authority_changed") {
      throw reservationError(
        "Capsule authority changed while claiming legacy endpoint work",
      );
    }
    if (result.status === "stored") return result.record;
    const winner = result.record;
    if (
      winner?.candidate?.planRunId === planRun.id &&
      winner.candidate.purpose === purpose &&
      stableStringify(winner.candidate.requirement) ===
        stableStringify(candidate.requirement) &&
      winner.candidate.reservation?.digest === candidate.reservation.digest
    ) {
      return winner;
    }
    throw reservationError("the legacy endpoint intent changed concurrently");
  }

  async #lifecycle(
    capsuleId: string,
  ): Promise<PublicInputReservationLifecycle | undefined> {
    return await this.#store.getCapsulePublicInputReservationRecord(capsuleId);
  }

  async #selectOwner(
    workspaceId: string,
    providerBindings: readonly CapsuleProviderBindingMintEntry[],
  ): Promise<CredentialRecipeDriverPublicInputOwner> {
    try {
      return await this.#driver.selectPublicInputReservationOwner(
        workspaceId,
        providerBindings,
      );
    } catch {
      throw reservationError(
        "exact trusted provider reservation owner is unavailable or ambiguous",
      );
    }
  }

  async #resolve(
    workspaceId: string,
    owner: CredentialRecipeDriverPublicInputOwner,
    clientIdempotencyKey: string,
    requestedSubdomain: string,
    reservationRef?: string,
  ): Promise<CredentialRecipeDriverPublicInputs> {
    try {
      return await this.#driver.resolvePublicInputReservation(
        workspaceId,
        owner,
        Object.freeze({
          httpEndpointUrl: Object.freeze({
            clientIdempotencyKey,
            requestedSubdomain,
            ...(reservationRef ? { reservationRef } : {}),
          }),
        }),
      );
    } catch {
      throw reservationError("the trusted provider reservation read failed");
    }
  }
}

export async function createPublicInputReservationLifecycle(input: {
  readonly applied?: PublicInputReservationReceipt;
  readonly candidate?: PublicInputReservationCandidate;
  readonly retiring: readonly PublicInputReservationRetirement[];
}): Promise<PublicInputReservationLifecycle> {
  const core = {
    kind: LIFECYCLE_KIND,
    ...(input.applied
      ? { applied: assertPublicInputReservationReceipt(input.applied) }
      : {}),
    ...(input.candidate
      ? { candidate: assertPublicInputReservationCandidate(input.candidate) }
      : {}),
    retiring: Object.freeze(
      input.retiring.map(assertPublicInputReservationRetirement),
    ),
  } as const;
  return assertPublicInputReservationLifecycle({
    ...core,
    digest: (await stableJsonDigest(core)) as `sha256:${string}`,
  });
}

/** Value-free scheduler projection; provider identity remains in private JSON. */
export function publicInputReservationCleanupProjection(
  lifecycle: PublicInputReservationLifecycle,
): PublicInputReservationCleanupProjection | undefined {
  const retirements = lifecycle.retiring.map((entry) => ({
      runId: entry.cleanupRunId,
      enqueuedAt: entry.enqueuedAt,
    }));
  const candidates: PublicInputReservationCleanupProjection[] = [
    ...retirements,
    ...(lifecycle.candidate?.planRunId
      ? [{
          runId: lifecycle.candidate.planRunId,
          enqueuedAt: lifecycle.candidate.stagedAt,
        }]
      : []),
  ];
  if (
    lifecycle.retiring.length >= PUBLIC_INPUT_RESERVATION_MAX_RETIRING &&
    retirements.length > 0
  ) {
    return retirements.sort((left, right) =>
      left.enqueuedAt - right.enqueuedAt ||
      left.runId.localeCompare(right.runId)
    )[0];
  }
  return candidates.sort((left, right) =>
    left.enqueuedAt - right.enqueuedAt ||
    left.runId.localeCompare(right.runId)
  )[0];
}

export function assertPublicInputReservationLifecycle(
  value: unknown,
): PublicInputReservationLifecycle {
  const record = closedRecord(
    value,
    ["digest", "kind", "retiring"],
    "public input reservation lifecycle",
    ["applied", "candidate"],
  );
  if (
    record.kind !== LIFECYCLE_KIND ||
    !SHA256_DIGEST.test(String(record.digest)) ||
    !Array.isArray(record.retiring) ||
    record.retiring.length > PUBLIC_INPUT_RESERVATION_MAX_RETIRING
  ) {
    throw new TypeError("public input reservation lifecycle is invalid");
  }
  const applied = record.applied === undefined
    ? undefined
    : assertPublicInputReservationReceipt(record.applied);
  const candidate = record.candidate === undefined
    ? undefined
    : assertPublicInputReservationCandidate(record.candidate);
  const retiring = Object.freeze(
    record.retiring.map(assertPublicInputReservationRetirement),
  );
  const identities = [
    ...(applied ? [applied.capsuleId] : []),
    ...(candidate ? [candidate.requirement.capsuleId] : []),
    ...retiring.map((entry) => entry.receipt.capsuleId),
  ];
  if (new Set(identities).size > 1) {
    throw new TypeError("public input reservation lifecycle mixes Capsules");
  }
  const retirementKeys = retiring.map((entry) =>
    `${entry.cleanupRunId}\u0000${entry.receipt.digest}`
  );
  if (new Set(retirementKeys).size !== retirementKeys.length) {
    throw new TypeError("public input reservation lifecycle repeats retirement work");
  }
  return Object.freeze({
    kind: LIFECYCLE_KIND,
    ...(applied ? { applied } : {}),
    ...(candidate ? { candidate } : {}),
    retiring,
    digest: record.digest as `sha256:${string}`,
  });
}

export async function assertPublicInputReservationLifecycleDigest(
  value: PublicInputReservationLifecycle,
): Promise<PublicInputReservationLifecycle> {
  const lifecycle = assertPublicInputReservationLifecycle(value);
  const { digest, ...core } = lifecycle;
  await Promise.all([
    ...(lifecycle.applied
      ? [assertPublicInputReservationRecordDigest(lifecycle.applied)]
      : []),
    ...(lifecycle.candidate?.reservation
      ? [assertPublicInputReservationRecordDigest(
          lifecycle.candidate.reservation,
        )]
      : []),
    ...lifecycle.retiring.map((entry) =>
      assertPublicInputReservationRecordDigest(entry.receipt)
    ),
  ]);
  if ((await stableJsonDigest(core)) !== digest) {
    throw reservationError("the durable endpoint lifecycle digest is invalid");
  }
  return lifecycle;
}

/** Runtime compatibility only: no durable row is rewritten merely by reading. */
export async function decodePublicInputReservationLifecycle(
  value: unknown,
): Promise<PublicInputReservationLifecycle> {
  if (isRecord(value) && value.kind === LIFECYCLE_KIND) {
    return await assertPublicInputReservationLifecycleDigest(
      assertPublicInputReservationLifecycle(value),
    );
  }
  const legacy = assertPublicInputReservationRecord(value);
  await assertPublicInputReservationRecordDigest(legacy);
  if (legacy.kind === RECEIPT_KIND) {
    return await createPublicInputReservationLifecycle({
      applied: legacy,
      retiring: [],
    });
  }
  return await createPublicInputReservationLifecycle({
    candidate: {
      stagedAt: 0,
      requirement: reservationRequirementFromRecord(legacy),
      reservation: legacy,
    },
    retiring: [],
  });
}

/**
 * Store-side transition proof for the only authority-mismatched lifecycle CAS.
 * It may bind an unowned v1 intent to a current Plan, but cannot alter the
 * intent, applied receipt, retirement work, or provider-effect claim.
 */
export function isPublicInputReservationLegacyCandidateClaim(
  current: PublicInputReservationLifecycle,
  next: PublicInputReservationLifecycle,
): boolean {
  const previousCandidate = current.candidate;
  const claimedCandidate = next.candidate;
  if (
    !unboundLegacyCandidate(previousCandidate) ||
    !claimedCandidate?.planRunId ||
    (claimedCandidate.purpose !== "plan" &&
      claimedCandidate.purpose !== "legacy_repair") ||
    claimedCandidate.effectClaim !== undefined ||
    claimedCandidate.reservation?.kind !== INTENT_KIND
  ) {
    return false;
  }
  return stableStringify(current.applied) === stableStringify(next.applied) &&
    stableStringify(current.retiring) === stableStringify(next.retiring) &&
    stableStringify(previousCandidate.requirement) ===
      stableStringify(claimedCandidate.requirement) &&
    previousCandidate.reservation.digest ===
      claimedCandidate.reservation.digest &&
    claimedCandidate.stagedAt >= previousCandidate.stagedAt;
}

/**
 * Builds the only scheduler-owned repair binding for an unprojected v1 intent.
 * The selected Plan is merely a durable terminal cleanup carrier; the provider
 * receipt is still established later by exact idempotency-key readback.
 */
export async function claimPublicInputReservationLegacyCandidateForCleanup(
  lifecycle: PublicInputReservationLifecycle,
  plan: PlanRun,
  claimedAt: number,
): Promise<PublicInputReservationLifecycle | undefined> {
  const candidate = lifecycle.candidate;
  if (
    !unboundLegacyCandidate(candidate) ||
    candidate.reservation?.kind !== INTENT_KIND ||
    !planCandidateCleanupSafe(plan) ||
    plan.workspaceId !== candidate.requirement.workspaceId ||
    plan.capsuleId !== candidate.requirement.capsuleId ||
    !Number.isFinite(claimedAt) ||
    claimedAt <= 0
  ) {
    return undefined;
  }
  return await createPublicInputReservationLifecycle({
    applied: lifecycle.applied,
    candidate: {
      ...candidate,
      planRunId: plan.id,
      purpose: "legacy_repair",
      stagedAt: Math.max(candidate.stagedAt, Math.floor(claimedAt)),
    },
    retiring: lifecycle.retiring,
  });
}

function assertPublicInputReservationCandidate(
  value: unknown,
): PublicInputReservationCandidate {
  const record = closedRecord(
    value,
    ["requirement", "stagedAt"],
    "public input reservation candidate",
    ["effectClaim", "planRunId", "purpose", "reservation"],
  );
  const requirement = assertPublicInputReservationRequirement(record.requirement);
  const reservation = record.reservation === undefined
    ? undefined
    : assertPublicInputReservationRecord(record.reservation);
  const effectClaim = record.effectClaim === undefined
    ? undefined
    : closedRecord(
        record.effectClaim,
        ["claimedAt", "token"],
        "public input reservation effect claim",
      );
  if (
    !Number.isSafeInteger(record.stagedAt) ||
    (record.stagedAt as number) < 0 ||
    (record.planRunId !== undefined && !boundedText(record.planRunId, 256)) ||
    (record.purpose !== undefined &&
      !["plan", "legacy_repair"].includes(String(record.purpose))) ||
    (record.purpose !== undefined && record.planRunId === undefined) ||
    (record.purpose === "legacy_repair" && effectClaim !== undefined) ||
    (effectClaim !== undefined &&
      (!Number.isSafeInteger(effectClaim.claimedAt) ||
        (effectClaim.claimedAt as number) < 0 ||
        !RESERVATION_LIFECYCLE_NONCE.test(String(effectClaim.token)))) ||
    (reservation?.kind === RECEIPT_KIND && effectClaim !== undefined) ||
    (reservation &&
      stableStringify(reservationRequirementFromRecord(reservation)) !==
        stableStringify(requirement))
  ) {
    throw new TypeError("public input reservation candidate is invalid");
  }
  return Object.freeze({
    ...(record.planRunId ? { planRunId: String(record.planRunId) } : {}),
    ...(record.purpose
      ? { purpose: record.purpose as PublicInputReservationCandidate["purpose"] }
      : {}),
    stagedAt: record.stagedAt as number,
    requirement,
    ...(reservation ? { reservation } : {}),
    ...(effectClaim
      ? {
          effectClaim: Object.freeze({
            token: effectClaim.token as string,
            claimedAt: effectClaim.claimedAt as number,
          }),
        }
      : {}),
  });
}

function assertPublicInputReservationRetirement(
  value: unknown,
): PublicInputReservationRetirement {
  const record = closedRecord(
    value,
    ["cleanupRunId", "enqueuedAt", "receipt"],
    "public input reservation retirement",
  );
  if (
    !boundedText(record.cleanupRunId, 256) ||
    !Number.isSafeInteger(record.enqueuedAt) ||
    (record.enqueuedAt as number) < 0
  ) {
    throw new TypeError("public input reservation retirement is invalid");
  }
  return Object.freeze({
    cleanupRunId: record.cleanupRunId,
    enqueuedAt: record.enqueuedAt as number,
    receipt: assertPublicInputReservationReceipt(record.receipt),
  });
}

function assertPublicInputReservationRequirement(
  value: unknown,
): PublicInputReservationRequirementFields {
  const record = closedRecord(
    value,
    [
      "capsuleExecutionAuthorityEpoch",
      "capsuleId",
      "installConfigId",
      "owner",
      "repositoryInstallUxDigest",
      "requestedSubdomain",
      "sourceSnapshotId",
      "subdomainVariable",
      "targetVariable",
      "workspaceId",
    ],
    "public input reservation requirement",
  );
  const synthetic = {
    ...record,
    kind: INTENT_KIND,
    reservationLifecycleNonce: "00000000-0000-4000-8000-000000000000",
    clientIdempotencyKey: `endpoint_request_${"0".repeat(64)}`,
    digest: `sha256:${"0".repeat(64)}`,
  };
  const validated = assertReservationAuthorityShape(synthetic, INTENT_KIND, []);
  return Object.freeze({
    workspaceId: validated.workspaceId as string,
    capsuleId: validated.capsuleId as string,
    installConfigId: validated.installConfigId as string,
    capsuleExecutionAuthorityEpoch:
      validated.capsuleExecutionAuthorityEpoch as number,
    sourceSnapshotId: validated.sourceSnapshotId as string,
    repositoryInstallUxDigest:
      validated.repositoryInstallUxDigest as string,
    targetVariable: validated.targetVariable as string,
    subdomainVariable: validated.subdomainVariable as string,
    requestedSubdomain: validated.requestedSubdomain as string,
    owner: Object.freeze({
      ...(validated.owner as CredentialRecipeDriverPublicInputOwner),
    }),
  });
}

async function createPublicInputReservationPlanDecision(input: {
  readonly planRun: PlanRun;
  readonly capsuleAuthority: PublicInputReservationCapsuleAuthority;
  readonly operation: PublicInputReservationPlanDecision["operation"];
  readonly source?: PublicInputReservationPlanDecision["source"];
  readonly lifecycle: PublicInputReservationLifecycle;
  readonly applied?: PublicInputReservationReceipt;
  readonly receipt?: PublicInputReservationReceipt;
}): Promise<PublicInputReservationPlanDecision> {
  const core = {
    kind: PLAN_DECISION_KIND,
    planRunId: input.planRun.id,
    workspaceId: input.capsuleAuthority.workspaceId,
    capsuleId: input.capsuleAuthority.capsuleId,
    installConfigId: input.capsuleAuthority.installConfigId,
    capsuleExecutionAuthorityEpoch: input.capsuleAuthority.epoch,
    sourceSnapshotId: input.capsuleAuthority.sourceSnapshotId,
    operation: input.operation,
    ...(input.source ? { source: input.source } : {}),
    expectedLifecycleDigest: input.lifecycle.digest,
    ...(input.applied
      ? { expectedAppliedReceiptDigest: input.applied.digest }
      : {}),
    ...(input.receipt ? { receipt: input.receipt } : {}),
  } as const;
  return assertPublicInputReservationPlanDecision({
    ...core,
    digest: (await stableJsonDigest(core)) as `sha256:${string}`,
  });
}

export function assertPublicInputReservationPlanDecision(
  value: unknown,
): PublicInputReservationPlanDecision {
  const record = closedRecord(
    value,
    [
      "capsuleExecutionAuthorityEpoch",
      "capsuleId",
      "digest",
      "installConfigId",
      "kind",
      "operation",
      "planRunId",
      "sourceSnapshotId",
      "workspaceId",
    ],
    "public input reservation Plan decision",
    [
      "expectedAppliedReceiptDigest",
      "expectedLifecycleDigest",
      "receipt",
      "source",
    ],
  );
  const operation = record.operation;
  const source = record.source;
  const receipt = record.receipt === undefined
    ? undefined
    : assertPublicInputReservationReceipt(record.receipt);
  if (
    record.kind !== PLAN_DECISION_KIND ||
    !boundedText(record.planRunId, 256) ||
    !boundedText(record.workspaceId, 256) ||
    !boundedText(record.capsuleId, 256) ||
    !boundedText(record.installConfigId, 256) ||
    !Number.isSafeInteger(record.capsuleExecutionAuthorityEpoch) ||
    (record.capsuleExecutionAuthorityEpoch as number) < 1 ||
    !boundedText(record.sourceSnapshotId, 256) ||
    !["present", "absent", "destroy"].includes(String(operation)) ||
    !SHA256_DIGEST.test(String(record.digest)) ||
    !SHA256_DIGEST.test(String(record.expectedLifecycleDigest)) ||
    (record.expectedAppliedReceiptDigest !== undefined &&
      !SHA256_DIGEST.test(String(record.expectedAppliedReceiptDigest))) ||
    (operation === "present" &&
      (receipt === undefined || !["applied", "candidate"].includes(String(source)))) ||
    (operation === "present" && source === "applied" &&
      record.expectedAppliedReceiptDigest === undefined) ||
    (operation === "absent" && (receipt !== undefined || source !== undefined)) ||
    (operation === "absent" &&
      record.expectedAppliedReceiptDigest === undefined) ||
    (operation === "destroy" && (receipt === undefined || source !== undefined)) ||
    (operation === "destroy" &&
      record.expectedAppliedReceiptDigest === undefined)
  ) {
    throw new TypeError("public input reservation Plan decision is invalid");
  }
  return Object.freeze({
    kind: PLAN_DECISION_KIND,
    planRunId: record.planRunId as string,
    workspaceId: record.workspaceId as string,
    capsuleId: record.capsuleId as string,
    installConfigId: record.installConfigId as string,
    capsuleExecutionAuthorityEpoch:
      record.capsuleExecutionAuthorityEpoch as number,
    sourceSnapshotId: record.sourceSnapshotId as string,
    operation: operation as PublicInputReservationPlanDecision["operation"],
    ...(source
      ? { source: source as PublicInputReservationPlanDecision["source"] }
      : {}),
    ...(record.expectedLifecycleDigest
      ? { expectedLifecycleDigest: record.expectedLifecycleDigest as string }
      : {}),
    ...(record.expectedAppliedReceiptDigest
      ? {
          expectedAppliedReceiptDigest:
            record.expectedAppliedReceiptDigest as string,
        }
      : {}),
    ...(receipt ? { receipt } : {}),
    digest: record.digest as `sha256:${string}`,
  });
}

export async function assertPublicInputReservationPlanDecisionDigest(
  value: PublicInputReservationPlanDecision,
): Promise<PublicInputReservationPlanDecision> {
  const decision = assertPublicInputReservationPlanDecision(value);
  const { digest, ...core } = decision;
  if ((await stableJsonDigest(core)) !== digest) {
    throw reservationError("the Plan endpoint decision digest is invalid");
  }
  if (decision.receipt) {
    await assertPublicInputReservationRecordDigest(decision.receipt);
  }
  return decision;
}

function reservationRequirementCore(input: {
  readonly authority: PublicInputReservationAuthority;
  readonly owner: CredentialRecipeDriverPublicInputOwner;
}): PublicInputReservationRequirementFields {
  return Object.freeze({
    workspaceId: input.authority.workspaceId,
    capsuleId: input.authority.capsuleId,
    installConfigId: input.authority.installConfigId,
    capsuleExecutionAuthorityEpoch: input.authority.epoch,
    sourceSnapshotId: input.authority.sourceSnapshotId,
    repositoryInstallUxDigest: input.authority.repositoryInstallUxDigest,
    targetVariable: input.authority.target,
    subdomainVariable: input.authority.subdomainVariable,
    requestedSubdomain: input.authority.requestedSubdomain,
    owner: Object.freeze({ ...input.owner }),
  });
}

function reservationRequirementFromRecord(
  record: PublicInputReservationLegacyRecord,
): PublicInputReservationRequirementFields {
  return Object.freeze({
    workspaceId: record.workspaceId,
    capsuleId: record.capsuleId,
    installConfigId: record.installConfigId,
    capsuleExecutionAuthorityEpoch: record.capsuleExecutionAuthorityEpoch,
    sourceSnapshotId: record.sourceSnapshotId,
    repositoryInstallUxDigest: record.repositoryInstallUxDigest,
    targetVariable: record.targetVariable,
    subdomainVariable: record.subdomainVariable,
    requestedSubdomain: record.requestedSubdomain,
    owner: Object.freeze({ ...record.owner }),
  });
}

function candidateMatchesRequirement(
  candidate: PublicInputReservationCandidate,
  authority: PublicInputReservationAuthority,
  owner: CredentialRecipeDriverPublicInputOwner,
): boolean {
  return stableStringify(candidate.requirement) ===
    stableStringify(reservationRequirementCore({ authority, owner }));
}

function enqueueRetirement(
  current: readonly PublicInputReservationRetirement[],
  receipt: PublicInputReservationReceipt,
  cleanupRunId: string,
  enqueuedAt: number,
): PublicInputReservationRetirement[] {
  if (current.some((entry) =>
    entry.cleanupRunId === cleanupRunId &&
    entry.receipt.digest === receipt.digest)) return [...current];
  if (current.length >= PUBLIC_INPUT_RESERVATION_MAX_RETIRING) {
    throw reservationError(
      "the endpoint retirement queue is full; cleanup must drain before Apply",
    );
  }
  return [
    ...current,
    Object.freeze({ cleanupRunId, enqueuedAt, receipt }),
  ];
}

function unboundLegacyCandidate(
  candidate: PublicInputReservationCandidate | undefined,
): candidate is PublicInputReservationCandidate & {
  readonly reservation: PublicInputReservationIntent;
} {
  return Boolean(
    candidate &&
      candidate.planRunId === undefined &&
      candidate.purpose === undefined &&
      candidate.effectClaim === undefined &&
      candidate.reservation?.kind === INTENT_KIND,
  );
}

function assertRetirementCapacityForDecision(
  decision: PublicInputReservationPlanDecision,
  lifecycle: PublicInputReservationLifecycle,
): void {
  const mayEnqueue = decision.source === "candidate" ||
    ((decision.operation === "absent" || decision.operation === "destroy") &&
      lifecycle.applied !== undefined);
  if (
    mayEnqueue &&
    lifecycle.retiring.length >= PUBLIC_INPUT_RESERVATION_MAX_RETIRING
  ) {
    throw reservationError(
      "the endpoint retirement queue is full; cleanup must drain before Apply",
    );
  }
}

function sameProviderReservationIdentity(
  left: PublicInputReservationReceipt,
  right: PublicInputReservationReceipt,
): boolean {
  return left.clientIdempotencyKey === right.clientIdempotencyKey &&
    left.reservationLifecycleNonce === right.reservationLifecycleNonce &&
    left.reservationRef === right.reservationRef &&
    left.httpEndpointUrl === right.httpEndpointUrl &&
    samePublicInputOwner(left.owner, right.owner) &&
    left.targetVariable === right.targetVariable &&
    left.subdomainVariable === right.subdomainVariable &&
    left.requestedSubdomain === right.requestedSubdomain;
}

function overlayDecision(
  variables: Readonly<Record<string, JsonValue>>,
  decision: PublicInputReservationPlanDecision,
): PreparedPublicInputReservation {
  const receipt = decision.receipt;
  return {
    variables: Object.freeze({
      ...variables,
      ...(receipt ? { [receipt.targetVariable]: receipt.httpEndpointUrl } : {}),
    }),
    decision,
  };
}

function frozenVariables(
  variables: Readonly<Record<string, JsonValue>>,
): PreparedPublicInputReservation {
  return { variables: Object.freeze({ ...variables }) };
}

function decisionMatchesCapsuleAuthority(
  decision: PublicInputReservationPlanDecision,
  authority: PublicInputReservationCapsuleAuthority,
  planRun: PlanRun,
): boolean {
  return decision.planRunId === planRun.id &&
    decision.workspaceId === authority.workspaceId &&
    decision.capsuleId === authority.capsuleId &&
    decision.installConfigId === authority.installConfigId &&
    decision.capsuleExecutionAuthorityEpoch === authority.epoch &&
    decision.sourceSnapshotId === authority.sourceSnapshotId;
}

function planCandidateCleanupSafe(plan: PlanRun | undefined): boolean {
  return Boolean(
    plan &&
      (plan.appliedApplyRunId ||
        plan.status === "failed" ||
        plan.status === "cancelled" ||
        plan.status === "expired"),
  );
}

function cleanupRunTerminal(run: PlanRun | ApplyRun | undefined): boolean {
  return Boolean(
    run &&
      (run.status === "succeeded" ||
        run.status === "failed" ||
        run.status === "cancelled" ||
        run.status === "expired"),
  );
}

function lifecycleCapsuleId(
  lifecycle: PublicInputReservationLifecycle,
): string {
  return lifecycle.applied?.capsuleId ??
    lifecycle.candidate?.requirement.capsuleId ??
    lifecycle.retiring[0]?.receipt.capsuleId ??
    (() => {
      throw reservationError("an empty endpoint lifecycle has no Capsule");
    })();
}

export async function publicInputClientIdempotencyKey(input: {
  readonly capsuleId: string;
  readonly targetVariable: string;
  readonly subdomainVariable: string;
  readonly requestedSubdomain: string;
  readonly reservationLifecycleNonce: string;
}): Promise<string> {
  if (
    !boundedText(input.capsuleId, 256) ||
    !OPENTOFU_VARIABLE_NAME.test(input.targetVariable) ||
    !OPENTOFU_VARIABLE_NAME.test(input.subdomainVariable) ||
    !validRequestedSubdomain(input.requestedSubdomain) ||
    !RESERVATION_LIFECYCLE_NONCE.test(input.reservationLifecycleNonce)
  ) {
    throw reservationError("reservation lifecycle authority is invalid");
  }
  const digest = await stableJsonDigest({
    domain: CLIENT_KEY_DOMAIN,
    capsuleId: input.capsuleId,
    targetVariable: input.targetVariable,
    subdomainVariable: input.subdomainVariable,
    requestedSubdomain: input.requestedSubdomain,
    reservationLifecycleNonce: input.reservationLifecycleNonce,
  });
  return `endpoint_request_${digest.slice("sha256:".length)}`;
}

export async function createPublicInputReservationIntent(input: {
  readonly authority: PublicInputReservationAuthority;
  readonly owner: CredentialRecipeDriverPublicInputOwner;
  readonly clientIdempotencyKey: string;
  readonly reservationLifecycleNonce: string;
}): Promise<PublicInputReservationIntent> {
  const core = reservationAuthorityCore(input);
  const intentCore = { ...core, kind: INTENT_KIND } as const;
  return assertPublicInputReservationIntent({
    ...intentCore,
    digest: (await stableJsonDigest(intentCore)) as `sha256:${string}`,
  });
}

export async function createPublicInputReservationReceipt(input: {
  readonly authority: PublicInputReservationAuthority;
  readonly owner: CredentialRecipeDriverPublicInputOwner;
  readonly clientIdempotencyKey: string;
  readonly reservationLifecycleNonce: string;
  readonly publicInputs: CredentialRecipeDriverPublicInputs;
}): Promise<PublicInputReservationReceipt> {
  const core = reservationAuthorityCore(input);
  const receiptCore = {
    ...core,
    kind: RECEIPT_KIND,
    reservationRef: input.publicInputs.reservationRef,
    httpEndpointUrl: input.publicInputs.httpEndpointUrl,
  } as const;
  return assertPublicInputReservationReceipt({
    ...receiptCore,
    digest: (await stableJsonDigest(receiptCore)) as `sha256:${string}`,
  });
}

async function createPublicInputReservationReceiptFromRecord(
  record: PublicInputReservationLegacyRecord,
  publicInputs: CredentialRecipeDriverPublicInputs,
): Promise<PublicInputReservationReceipt> {
  const { kind: _kind, digest: _digest, ...authority } = record;
  void _kind;
  void _digest;
  const receiptCore = {
    ...authority,
    kind: RECEIPT_KIND,
    reservationRef: publicInputs.reservationRef,
    httpEndpointUrl: publicInputs.httpEndpointUrl,
  } as const;
  return assertPublicInputReservationReceipt({
    ...receiptCore,
    digest: (await stableJsonDigest(receiptCore)) as `sha256:${string}`,
  });
}

function reservationAuthorityCore(input: {
  readonly authority: PublicInputReservationAuthority;
  readonly owner: CredentialRecipeDriverPublicInputOwner;
  readonly clientIdempotencyKey: string;
  readonly reservationLifecycleNonce: string;
}): PublicInputReservationAuthorityFields {
  return {
    workspaceId: input.authority.workspaceId,
    capsuleId: input.authority.capsuleId,
    installConfigId: input.authority.installConfigId,
    capsuleExecutionAuthorityEpoch: input.authority.epoch,
    sourceSnapshotId: input.authority.sourceSnapshotId,
    repositoryInstallUxDigest: input.authority.repositoryInstallUxDigest,
    reservationLifecycleNonce: input.reservationLifecycleNonce,
    clientIdempotencyKey: input.clientIdempotencyKey,
    targetVariable: input.authority.target,
    subdomainVariable: input.authority.subdomainVariable,
    requestedSubdomain: input.authority.requestedSubdomain,
    owner: Object.freeze({ ...input.owner }),
  };
}

export function assertPublicInputReservationRecord(
  value: unknown,
): PublicInputReservationLegacyRecord {
  const kind = isRecord(value) ? value.kind : undefined;
  if (kind === INTENT_KIND) return assertPublicInputReservationIntent(value);
  if (kind === RECEIPT_KIND) return assertPublicInputReservationReceipt(value);
  throw new TypeError("public input reservation record kind is invalid");
}

export function assertPublicInputReservationIntent(
  value: unknown,
): PublicInputReservationIntent {
  const record = assertReservationAuthorityShape(value, INTENT_KIND, []);
  return Object.freeze({
    ...(record as unknown as PublicInputReservationIntent),
    owner: Object.freeze({
      ...(record.owner as CredentialRecipeDriverPublicInputOwner),
    }),
  });
}

export function assertPublicInputReservationReceipt(
  value: unknown,
): PublicInputReservationReceipt {
  const record = assertReservationAuthorityShape(value, RECEIPT_KIND, [
    "httpEndpointUrl",
    "reservationRef",
  ]);
  if (
    !exactHttpsOrigin(record.httpEndpointUrl) ||
    !boundedText(record.reservationRef, 1_024)
  ) {
    throw new TypeError("public input reservation receipt result is invalid");
  }
  return Object.freeze({
    ...(record as unknown as PublicInputReservationReceipt),
    owner: Object.freeze({
      ...(record.owner as CredentialRecipeDriverPublicInputOwner),
    }),
  });
}

function assertReservationAuthorityShape(
  value: unknown,
  kind: typeof INTENT_KIND | typeof RECEIPT_KIND,
  additionalKeys: readonly string[],
): Readonly<Record<string, unknown>> {
  const record = closedRecord(
    value,
    [
      "capsuleExecutionAuthorityEpoch",
      "capsuleId",
      "clientIdempotencyKey",
      "digest",
      ...additionalKeys,
      "installConfigId",
      "kind",
      "owner",
      "reservationLifecycleNonce",
      "repositoryInstallUxDigest",
      "sourceSnapshotId",
      "subdomainVariable",
      "targetVariable",
      "requestedSubdomain",
      "workspaceId",
    ],
    "public input reservation record",
  );
  const owner = closedRecord(
    record.owner,
    ["authMode", "connectionId", "providerSource", "recipeId"],
    "public input reservation owner",
    ["runCredentialSettings"],
  );
  if (
    record.kind !== kind ||
    !boundedText(record.workspaceId, 256) ||
    !boundedText(record.capsuleId, 256) ||
    !boundedText(record.installConfigId, 256) ||
    !Number.isSafeInteger(record.capsuleExecutionAuthorityEpoch) ||
    (record.capsuleExecutionAuthorityEpoch as number) < 1 ||
    !boundedText(record.sourceSnapshotId, 256) ||
    !SHA256_DIGEST.test(String(record.repositoryInstallUxDigest)) ||
    !RESERVATION_LIFECYCLE_NONCE.test(
      String(record.reservationLifecycleNonce),
    ) ||
    !/^endpoint_request_[a-f0-9]{64}$/u.test(
      String(record.clientIdempotencyKey),
    ) ||
    !OPENTOFU_VARIABLE_NAME.test(String(record.targetVariable)) ||
    !OPENTOFU_VARIABLE_NAME.test(String(record.subdomainVariable)) ||
    !validRequestedSubdomain(record.requestedSubdomain) ||
    !SHA256_DIGEST.test(String(record.digest)) ||
    !/^[a-z0-9.-]+\/[a-z0-9_-]+\/[a-z0-9_-]+$/u.test(
      String(owner.providerSource),
    ) ||
    !boundedText(owner.connectionId, 256) ||
    !boundedText(owner.recipeId, 128) ||
    !boundedText(owner.authMode, 128)
  ) {
    throw new TypeError("public input reservation authority is invalid");
  }
  if (owner.runCredentialSettings !== undefined) {
    let canonical;
    try {
      canonical = canonicalRunCredentialSettings(
        owner.runCredentialSettings,
        "public input reservation owner settings",
      );
    } catch {
      throw new TypeError("public input reservation owner settings are invalid");
    }
    if (stableStringify(canonical) !== stableStringify(owner.runCredentialSettings)) {
      throw new TypeError("public input reservation owner settings are invalid");
    }
  }
  return record;
}

export async function assertPublicInputReservationRecordDigest(
  recordInput: PublicInputReservationLegacyRecord,
): Promise<void> {
  const record = assertPublicInputReservationRecord(recordInput);
  const { digest, ...core } = record;
  const expectedClientKey = await publicInputClientIdempotencyKey({
    capsuleId: record.capsuleId,
    targetVariable: record.targetVariable,
    subdomainVariable: record.subdomainVariable,
    requestedSubdomain: record.requestedSubdomain,
    reservationLifecycleNonce: record.reservationLifecycleNonce,
  });
  if (
    record.clientIdempotencyKey !== expectedClientKey ||
    (await stableJsonDigest(core)) !== digest
  ) {
    throw reservationError("the durable endpoint reservation digest is invalid");
  }
}

export function publicEndpointPreflightTargetVariable(
  installConfig: InstallConfig,
): string | undefined {
  return publicEndpointPreflightProjection(installConfig)?.targetVariable;
}

export interface PublicEndpointPreflightProjection {
  readonly targetVariable: string;
  readonly subdomainVariable: string;
}

export function publicEndpointPreflightProjection(
  installConfig: InstallConfig,
): PublicEndpointPreflightProjection | undefined {
  const provenance = installConfig.internal;
  if (
    provenance?.reason !== "per_install_overrides" ||
    provenance.repositoryManifestApiVersion !== "takosumi.com/v2.4" ||
    !boundedText(provenance.sourceSnapshotId, 256) ||
    !SHA256_DIGEST.test(provenance.repositoryInstallUxDigest ?? "") ||
    installConfig.installExperience?.repositoryInstallUx?.status !== "accepted"
  ) {
    return undefined;
  }
  const repositoryTarget = provenance.repositoryHttpEndpointUrlVariable;
  const repositorySubdomainTarget =
    provenance.repositoryHttpEndpointSubdomainVariable;
  if (
    !repositoryTarget ||
    !OPENTOFU_VARIABLE_NAME.test(repositoryTarget) ||
    !repositorySubdomainTarget ||
    !OPENTOFU_VARIABLE_NAME.test(repositorySubdomainTarget) ||
    repositorySubdomainTarget === repositoryTarget
  ) {
    return undefined;
  }
  const effective = installExperiencePublicEndpoint(
    installConfig.installExperience,
  );
  if (
    effective?.urlVariable !== repositoryTarget ||
    effective.subdomainVariable !== repositorySubdomainTarget ||
    Object.prototype.hasOwnProperty.call(
      installConfig.variableMapping ?? {},
      repositoryTarget,
    ) ||
    (installConfig.variablePresentation ?? []).some(
      (entry) => entry.name === repositoryTarget,
    )
  ) {
    return undefined;
  }
  return Object.freeze({
    targetVariable: repositoryTarget,
    subdomainVariable: repositorySubdomainTarget,
  });
}

export function samePublicInputOwner(
  left: CredentialRecipeDriverPublicInputOwner,
  right: CredentialRecipeDriverPublicInputOwner,
): boolean {
  return stableStringify(left) === stableStringify(right);
}

function sameRequirement(
  record: PublicInputReservationLegacyRecord,
  authority: PublicInputReservationAuthority,
  owner: CredentialRecipeDriverPublicInputOwner,
): boolean {
  return (
    record.workspaceId === authority.workspaceId &&
    record.capsuleId === authority.capsuleId &&
    record.targetVariable === authority.target &&
    record.subdomainVariable === authority.subdomainVariable &&
    record.requestedSubdomain === authority.requestedSubdomain &&
    samePublicInputOwner(record.owner, owner)
  );
}

/**
 * Apply-time comparison against the immutable repository projection, not the
 * mutable effective projection alone. This deliberately ignores the durable
 * applied receipt's old adoption coordinates: a same-target re-adoption pins
 * the new coordinates in the Plan receipt while retaining provider identity.
 */
function receiptMatchesCurrentEndpointAuthority(
  receipt: PublicInputReservationReceipt,
  authority: PublicInputReservationCapsuleAuthority,
  variables: Readonly<Record<string, JsonValue>>,
): boolean {
  const installConfig = authority.installConfig;
  if (!installConfig) return false;
  const projection = publicEndpointPreflightProjection(installConfig);
  return Boolean(
    projection &&
      projection.targetVariable === receipt.targetVariable &&
      projection.subdomainVariable === receipt.subdomainVariable &&
      receipt.workspaceId === authority.workspaceId &&
      receipt.capsuleId === authority.capsuleId &&
      receipt.installConfigId === authority.installConfigId &&
      receipt.capsuleExecutionAuthorityEpoch === authority.epoch &&
      receipt.sourceSnapshotId === authority.sourceSnapshotId &&
      receipt.repositoryInstallUxDigest ===
        installConfig.internal?.repositoryInstallUxDigest &&
      variables[receipt.subdomainVariable] === receipt.requestedSubdomain
  );
}

function sameReservationResult(
  left: PublicInputReservationReceipt,
  right: PublicInputReservationReceipt,
): boolean {
  return stableStringify(left) === stableStringify(right);
}

function sameProviderReservationResult(
  left: PublicInputReservationReceipt,
  right: PublicInputReservationReceipt,
): boolean {
  return (
    left.clientIdempotencyKey === right.clientIdempotencyKey &&
    left.reservationRef === right.reservationRef &&
    left.httpEndpointUrl === right.httpEndpointUrl
  );
}

function closedRecord(
  value: unknown,
  required: readonly string[],
  label: string,
  optional: readonly string[] = [],
): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !(key in value)) ||
    Object.keys(value).some((key) => !allowed.has(key))
  ) {
    throw new TypeError(`${label} has unknown or missing fields`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function boundedText(value: unknown, maxBytes: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.trim() === value &&
    new TextEncoder().encode(value).byteLength <= maxBytes &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function assertReservationLifecycleNonce(value: unknown): string {
  if (typeof value !== "string" || !RESERVATION_LIFECYCLE_NONCE.test(value)) {
    throw reservationError("reservation lifecycle nonce factory returned an invalid value");
  }
  return value;
}

function assertEffectClaimToken(value: unknown): string {
  if (typeof value !== "string" || !RESERVATION_LIFECYCLE_NONCE.test(value)) {
    throw reservationError("reservation effect claim factory returned an invalid value");
  }
  return value;
}

function validRequestedSubdomain(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 63 &&
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(value)
  );
}

function exactHttpsOrigin(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      url.origin === value &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}

function reservationError(detail: string): OpenTofuControllerError {
  return new OpenTofuControllerError(
    "failed_precondition",
    `public_input_reservation_failed: ${detail}`,
    { reason: "public_input_reservation_failed" },
  );
}
