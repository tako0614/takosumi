import {
  stableJsonDigest,
  stableStringify,
} from "../../adapters/source/digest.ts";
import { log } from "../../shared/log.ts";
import type { ActivityRecorder } from "../activity/mod.ts";
import { NOOP_ACTIVITY_RECORDER } from "../activity/mod.ts";
import {
  CapsuleLeaseBusyError,
  type CapsuleCoordination,
  type LeaseHandle,
  withCapsuleLease,
} from "../deploy-control/capsule_lease.ts";
import {
  capsuleInterfaceMaterializationWorkItemAt,
  type CapsuleInterfaceMaterializationIntent,
  type CapsuleInterfaceMaterializationWorkItem,
} from "../deploy-control/interface_materialization_intent.ts";
import type {
  OpenTofuControlStore,
  SettleCapsuleInterfaceMaterializationIntentOutcome,
  SettleCapsuleInterfaceMaterializationIntentResult,
} from "../deploy-control/store.ts";
import type { ObservabilitySink } from "../observability/mod.ts";
import {
  InterfaceService,
  InterfaceServiceError,
  type InterfaceAuthorityWriteFence,
} from "./service.ts";

const DEFAULT_INTENT_LEASE_MS = 5 * 60 * 1000;
const DEFAULT_CAPSULE_LEASE_MS = 15 * 60 * 1000;
const DEFAULT_RETRY_BASE_MS = 30 * 1000;
const MAX_RETRY_MS = 60 * 60 * 1000;
const MAX_DRAIN_LIMIT = 100;
const DEFAULT_MAX_ITEMS_PER_CLAIM = 8;
const MAX_ITEMS_PER_CLAIM = 32;
const DEFAULT_DRAIN_WORK_ITEMS = 64;
const MAX_DRAIN_WORK_ITEMS = 256;
const DEFAULT_DRAIN_TIME_BUDGET_MS = 20_000;
const MAX_DRAIN_TIME_BUDGET_MS = 50_000;

export type CapsuleInterfaceMaterializationTargetResult =
  | { readonly kind: "materialized" }
  | { readonly kind: "retry"; readonly code: string }
  | { readonly kind: "dead-letter"; readonly code: string };

/**
 * Narrow internal port for the canonical Interface/Binding writer. The intent
 * drainer owns claim/fencing/terminal receipts; the target owns only
 * idempotent, provenance-checked Interface materialization.
 */
export interface CapsuleInterfaceMaterializationTarget {
  materializeItem(input: {
    readonly intentId: string;
    readonly workspaceId: string;
    readonly capsuleId: string;
    readonly blueprintsDigest: string;
    readonly itemIndex: number;
    readonly item: CapsuleInterfaceMaterializationWorkItem;
    readonly authorityFence: InterfaceAuthorityWriteFence;
  }): Promise<CapsuleInterfaceMaterializationTargetResult>;
}

/** Canonical Interface/Binding adapter used by the production drainer. */
export class InterfaceServiceCapsuleMaterializationTarget
  implements CapsuleInterfaceMaterializationTarget
{
  constructor(readonly interfaces: InterfaceService) {}

  async materializeItem(input: {
    readonly intentId: string;
    readonly workspaceId: string;
    readonly capsuleId: string;
    readonly blueprintsDigest: string;
    readonly itemIndex: number;
    readonly item: CapsuleInterfaceMaterializationWorkItem;
    readonly authorityFence: InterfaceAuthorityWriteFence;
  }): Promise<CapsuleInterfaceMaterializationTargetResult> {
    try {
      const blueprint = input.item.blueprint;
      const materialized = await this.interfaces.ensureCapsuleBlueprints(
        {
          workspaceId: input.workspaceId,
          capsuleId: input.capsuleId,
          blueprints: [
            {
              ...blueprint,
              bindings:
                input.item.kind === "binding" ? [input.item.binding] : [],
            },
          ],
        },
        input.authorityFence,
      );
      const candidate = materialized[0];
      if (!candidate) return deadLetter("interface_materialization_missing");
      const iface = await this.interfaces.reconcile(candidate.metadata.id, {
        authorityFence: input.authorityFence,
      });
      if (
        iface.metadata.workspaceId !== input.workspaceId ||
        iface.metadata.ownerRef.kind !== "Capsule" ||
        iface.metadata.ownerRef.id !== input.capsuleId ||
        iface.metadata.materializedFrom?.source !== "capsule_blueprint" ||
        iface.metadata.materializedFrom.key !== blueprint.key
      ) {
        return deadLetter("interface_provenance_conflict");
      }
      if (iface.status.phase === "Retired") {
        return deadLetter("interface_authority_retired");
      }
      if (iface.status.phase !== "Resolved") {
        return retryOrDeadLetterForInterface(iface.status.conditions ?? []);
      }
      if (input.item.kind === "interface") return { kind: "materialized" };
      const proposal = input.item.binding;
      if (!("subjectRef" in proposal) || !proposal.subjectRef) {
        return deadLetter("interface_declaration_invalid");
      }
      const bindings = await this.interfaces.listBindings(iface.metadata.id);
      const binding = bindings.find(
        (candidateBinding) =>
          candidateBinding.metadata.materializedFrom?.source ===
            "capsule_blueprint" &&
          candidateBinding.metadata.materializedFrom.interfaceKey ===
            blueprint.key &&
          candidateBinding.metadata.materializedFrom.key === proposal.key,
      );
      if (!binding) {
        const subjectConflict = bindings.some(
          (candidateBinding) =>
            candidateBinding.spec.subjectRef.kind === proposal.subjectRef.kind &&
            candidateBinding.spec.subjectRef.id === proposal.subjectRef.id,
        );
        return subjectConflict
          ? deadLetter("binding_authority_conflict")
          : retry("binding_materialization_missing");
      }
      if (
        binding.spec.subjectRef.kind !== proposal.subjectRef.kind ||
        binding.spec.subjectRef.id !== proposal.subjectRef.id ||
        stableStringify([...binding.spec.permissions].sort()) !==
          stableStringify([...proposal.permissions].sort()) ||
        stableStringify(binding.spec.delivery) !==
          stableStringify(proposal.delivery)
      ) {
        return deadLetter("binding_authority_conflict");
      }
      if (binding.status.phase === "Revoked") {
        return deadLetter("binding_authority_revoked");
      }
      if (binding.status.phase !== "Ready") {
        return retryOrDeadLetterForBinding(
          binding.status.conditions ?? [],
          binding.spec.delivery.type,
        );
      }
      return { kind: "materialized" };
    } catch (error) {
      if (error instanceof CapsuleInterfaceMaterializationFenceError) {
        throw error;
      }
      if (error instanceof InterfaceServiceError) {
        if (error.code === "conflict" || error.code === "not_found") {
          return retry("interface_materialization_concurrent");
        }
        return deadLetter("interface_declaration_conflict");
      }
      if (error instanceof TypeError) {
        return deadLetter("interface_declaration_invalid");
      }
      return retry("interface_materialization_unavailable");
    }
  }
}

export interface CapsuleInterfaceMaterializationDrainResult {
  readonly claimed: number;
  readonly completed: number;
  readonly progressed: number;
  readonly workItemsCompleted: number;
  readonly retried: number;
  readonly deadLettered: number;
  readonly leaseLost: number;
}

export interface CapsuleInterfaceMaterializationIntentDrainerOptions {
  readonly store: OpenTofuControlStore;
  readonly coordination: CapsuleCoordination;
  readonly target: CapsuleInterfaceMaterializationTarget;
  readonly now?: () => string;
  readonly newLeaseToken?: () => string;
  readonly intentLeaseMs?: number;
  readonly capsuleLeaseMs?: number;
  readonly retryBaseMs?: number;
  readonly maxItemsPerClaim?: number;
  readonly monotonicNow?: () => number;
  readonly activity?: ActivityRecorder;
  readonly observability?: Pick<ObservabilitySink, "recordMetric">;
}

class CapsuleInterfaceMaterializationFenceError extends Error {
  constructor(
    readonly target:
      | "intent_lease"
      | "capsule_lease"
      | "lineage"
      | "deadline",
  ) {
    super(`Capsule Interface materialization ${target} lost`);
    this.name = "CapsuleInterfaceMaterializationFenceError";
  }
}

/**
 * Bounded recovery owner for durable Capsule Interface materialization.
 *
 * The store lease elects one claimant globally. The existing Capsule
 * coordination lease then serializes the lineage check and Interface writes
 * with Apply/Destroy, so a newer generation cannot overtake an admitted
 * materialization. Only the elected store lease token may record the durable
 * receipt or retry/dead-letter outcome.
 */
export class CapsuleInterfaceMaterializationIntentDrainer {
  readonly #store: OpenTofuControlStore;
  readonly #coordination: CapsuleCoordination;
  readonly #target: CapsuleInterfaceMaterializationTarget;
  readonly #now: () => string;
  readonly #newLeaseToken: () => string;
  readonly #intentLeaseMs: number;
  readonly #capsuleLeaseMs: number;
  readonly #retryBaseMs: number;
  readonly #maxItemsPerClaim: number;
  readonly #monotonicNow: () => number;
  readonly #activity: ActivityRecorder;
  readonly #observability?: Pick<ObservabilitySink, "recordMetric">;

  constructor(options: CapsuleInterfaceMaterializationIntentDrainerOptions) {
    this.#store = options.store;
    this.#coordination = options.coordination;
    this.#target = options.target;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#newLeaseToken =
      options.newLeaseToken ??
      (() => `ciml_${crypto.randomUUID().replaceAll("-", "")}`);
    this.#intentLeaseMs = positiveDuration(
      options.intentLeaseMs,
      DEFAULT_INTENT_LEASE_MS,
      "intentLeaseMs",
    );
    this.#capsuleLeaseMs = positiveDuration(
      options.capsuleLeaseMs,
      DEFAULT_CAPSULE_LEASE_MS,
      "capsuleLeaseMs",
    );
    this.#retryBaseMs = positiveDuration(
      options.retryBaseMs,
      DEFAULT_RETRY_BASE_MS,
      "retryBaseMs",
    );
    this.#maxItemsPerClaim = boundedInteger(
      options.maxItemsPerClaim,
      DEFAULT_MAX_ITEMS_PER_CLAIM,
      1,
      MAX_ITEMS_PER_CLAIM,
      "maxItemsPerClaim",
    );
    this.#monotonicNow = options.monotonicNow ?? (() => Date.now());
    this.#activity = options.activity ?? NOOP_ACTIVITY_RECORDER;
    this.#observability = options.observability;
  }

  async drain(
    options: {
      readonly limit?: number;
      readonly maxWorkItems?: number;
      readonly timeBudgetMs?: number;
    } = {},
  ): Promise<CapsuleInterfaceMaterializationDrainResult> {
    const limit = drainLimit(options.limit);
    const maxWorkItems = boundedInteger(
      options.maxWorkItems,
      DEFAULT_DRAIN_WORK_ITEMS,
      1,
      MAX_DRAIN_WORK_ITEMS,
      "maxWorkItems",
    );
    const timeBudgetMs = boundedInteger(
      options.timeBudgetMs,
      DEFAULT_DRAIN_TIME_BUDGET_MS,
      1,
      MAX_DRAIN_TIME_BUDGET_MS,
      "timeBudgetMs",
    );
    const deadline = this.#monotonicNow() + timeBudgetMs;
    const result = {
      claimed: 0,
      completed: 0,
      progressed: 0,
      workItemsCompleted: 0,
      retried: 0,
      deadLettered: 0,
      leaseLost: 0,
    };
    for (
      let index = 0;
      index < limit &&
      result.workItemsCompleted < maxWorkItems &&
      this.#monotonicNow() < deadline;
      index += 1
    ) {
      const claimedAt = requiredTimestamp(this.#now(), "now");
      const leaseToken = requiredText(this.#newLeaseToken(), "leaseToken");
      const intent =
        await this.#store.claimCapsuleInterfaceMaterializationIntent({
          leaseToken,
          claimedAt,
          leaseExpiresAt: new Date(
            Date.parse(claimedAt) + this.#intentLeaseMs,
          ).toISOString(),
        });
      if (!intent) break;
      result.claimed += 1;
      const outcome = await this.#process(
        intent,
        leaseToken,
        Math.min(
          this.#maxItemsPerClaim,
          maxWorkItems - result.workItemsCompleted,
        ),
        deadline,
      );
      result.workItemsCompleted += outcome.workItemsCompleted;
      if (outcome.kind === "completed") result.completed += 1;
      else if (outcome.kind === "progressed") result.progressed += 1;
      else if (outcome.kind === "retried") result.retried += 1;
      else if (outcome.kind === "dead-lettered") result.deadLettered += 1;
      else result.leaseLost += 1;
    }
    return result;
  }

  async #process(
    intent: CapsuleInterfaceMaterializationIntent,
    leaseToken: string,
    itemBudget: number,
    deadline: number,
  ): Promise<{
    readonly kind:
      | "completed"
      | "progressed"
      | "retried"
      | "dead-lettered"
      | "lease-lost";
    readonly workItemsCompleted: number;
  }> {
    let settlementCursor = intent;
    let completedBeforeError = 0;
    try {
      const capsule = await this.#store.getCapsule(intent.capsuleId);
      const immediateDisposition = lineageDisposition(intent, capsule);
      if (immediateDisposition) {
        const settled = await this.#settle(intent, leaseToken, {
          kind: "completed",
          disposition: immediateDisposition,
        });
        return {
          kind: settlementKind(settled, {
            kind: "completed",
            disposition: immediateDisposition,
          }),
          workItemsCompleted: 0,
        };
      }
      return await withCapsuleLease(
        this.#coordination,
        {
          capsuleId: capsule!.id,
          environment: capsule!.environment,
          holderId: `interface-materialization:${intent.id}:${leaseToken}`,
          ttlMs: this.#capsuleLeaseMs,
        },
        async (capsuleLease) => {
          const current = await this.#store.getCapsule(intent.capsuleId);
          const disposition = lineageDisposition(intent, current);
          if (disposition) {
            const outcome = { kind: "completed", disposition } as const;
            return {
              kind: settlementKind(
                await this.#settle(intent, leaseToken, outcome),
                outcome,
              ),
              workItemsCompleted: 0,
            };
          }
          let cursor = intent;
          let workItemsCompleted = 0;
          const authorityFence = this.#authorityFence(
            capsuleLease,
            deadline,
            leaseToken,
            () => cursor,
            (renewed) => {
              cursor = renewed;
              settlementCursor = renewed;
            },
          );
          try {
            while (workItemsCompleted < itemBudget) {
              const item = capsuleInterfaceMaterializationWorkItemAt(
                cursor.blueprints,
                cursor.nextItemIndex,
              );
              await authorityFence.assertCurrent();
              let targetResult: CapsuleInterfaceMaterializationTargetResult;
              try {
                targetResult = await this.#target.materializeItem({
                  intentId: cursor.id,
                  workspaceId: cursor.workspaceId,
                  capsuleId: cursor.capsuleId,
                  blueprintsDigest: cursor.blueprintsDigest,
                  itemIndex: cursor.nextItemIndex,
                  item,
                  authorityFence,
                });
              } catch (error) {
                if (
                  error instanceof
                  CapsuleInterfaceMaterializationFenceError
                ) {
                  throw error;
                }
                await authorityFence.assertCurrent();
                return {
                  kind: await this.#settleFailure(
                    cursor,
                    leaseToken,
                    "retry",
                    "interface_materialization_unavailable",
                  ),
                  workItemsCompleted,
                };
              }
              await authorityFence.assertCurrent();
              if (targetResult.kind !== "materialized") {
                return {
                  kind: await this.#settleFailure(
                    cursor,
                    leaseToken,
                    targetResult.kind,
                    targetResult.code,
                  ),
                  workItemsCompleted,
                };
              }
              workItemsCompleted += 1;
              const nextItemIndex = cursor.nextItemIndex + 1;
              if (nextItemIndex === cursor.totalItems) {
                const outcome = {
                  kind: "completed",
                  disposition: "materialized",
                } as const;
                return {
                  kind: settlementKind(
                    await this.#settle(cursor, leaseToken, outcome),
                    outcome,
                  ),
                  workItemsCompleted,
                };
              }
              const releaseLease =
                workItemsCompleted >= itemBudget ||
                this.#monotonicNow() >= deadline;
              const settledAt = requiredTimestamp(this.#now(), "now");
              const outcome: SettleCapsuleInterfaceMaterializationIntentOutcome = {
                kind: "progress",
                nextItemIndex,
                releaseLease,
                ...(releaseLease ? { nextRetryAt: settledAt } : {}),
              };
              const checkpoint =
                await this.#store.settleCapsuleInterfaceMaterializationIntent({
                  id: cursor.id,
                  leaseToken,
                  expectedNextItemIndex: cursor.nextItemIndex,
                  settledAt,
                  outcome,
                });
              if (checkpoint.kind !== "updated") {
                return { kind: "lease-lost", workItemsCompleted };
              }
              cursor = checkpoint.intent;
              settlementCursor = cursor;
              completedBeforeError = workItemsCompleted;
              if (releaseLease) {
                return { kind: "progressed", workItemsCompleted };
              }
            }
            return {
              kind: "lease-lost",
              workItemsCompleted,
            };
          } finally {
            authorityFence.dispose();
          }
        },
      );
    } catch (error) {
      if (error instanceof CapsuleInterfaceMaterializationFenceError) {
        if (error.target === "deadline") {
          return {
            kind: await this.#settleFailure(
              settlementCursor,
              leaseToken,
              "retry",
              "interface_materialization_budget_exhausted",
            ),
            workItemsCompleted: completedBeforeError,
          };
        }
        return { kind: "lease-lost", workItemsCompleted: completedBeforeError };
      }
      return {
        kind: await this.#settleFailure(
          settlementCursor,
          leaseToken,
          "retry",
          error instanceof CapsuleLeaseBusyError
            ? "capsule_lifecycle_busy"
            : "interface_materialization_unavailable",
        ),
        workItemsCompleted: completedBeforeError,
      };
    }
  }

  #authorityFence(
    capsuleLease: LeaseHandle,
    deadline: number,
    leaseToken: string,
    intent: () => CapsuleInterfaceMaterializationIntent,
    updateIntent: (intent: CapsuleInterfaceMaterializationIntent) => void,
  ): InterfaceAuthorityWriteFence & { readonly dispose: () => void } {
    const abortController = new AbortController();
    const abort = (
      target: CapsuleInterfaceMaterializationFenceError["target"],
    ): void => {
      if (abortController.signal.aborted) return;
      abortController.abort(
        new CapsuleInterfaceMaterializationFenceError(target),
      );
    };
    const lose = (
      target: CapsuleInterfaceMaterializationFenceError["target"],
    ): never => {
      abort(target);
      throw abortController.signal.reason;
    };
    const deadlineTimer = setTimeout(
      () => abort("deadline"),
      Math.max(0, deadline - this.#monotonicNow()),
    );
    (deadlineTimer as { unref?: () => void }).unref?.();
    return {
      signal: abortController.signal,
      dispose: () => clearTimeout(deadlineTimer),
      assertCurrent: async () => {
        if (abortController.signal.aborted) {
          throw abortController.signal.reason;
        }
        if (this.#monotonicNow() >= deadline) return lose("deadline");
        let renewedCapsuleLease: Awaited<ReturnType<LeaseHandle["renew"]>>;
        try {
          renewedCapsuleLease = await capsuleLease.renew(this.#capsuleLeaseMs);
        } catch {
          return lose("capsule_lease");
        }
        if (abortController.signal.aborted) {
          throw abortController.signal.reason;
        }
        if (!renewedCapsuleLease.acquired) return lose("capsule_lease");
        if (this.#monotonicNow() >= deadline) return lose("deadline");

        const currentIntent = intent();
        if (currentIntent.leaseToken !== leaseToken) {
          return lose("intent_lease");
        }
        const renewedAt = requiredTimestamp(this.#now(), "now");
        const currentIntentExpiry = Date.parse(
          currentIntent.leaseExpiresAt ?? renewedAt,
        );
        const requestedExpiry = Math.max(
          currentIntentExpiry + 1,
          Date.parse(renewedAt) + this.#intentLeaseMs,
        );
        const renewedIntent =
          await this.#store.renewCapsuleInterfaceMaterializationIntentLease({
            id: currentIntent.id,
            leaseToken,
            expectedNextItemIndex: currentIntent.nextItemIndex,
            renewedAt,
            leaseExpiresAt: new Date(requestedExpiry).toISOString(),
          });
        if (abortController.signal.aborted) {
          throw abortController.signal.reason;
        }
        if (renewedIntent.kind !== "updated") return lose("intent_lease");
        updateIntent(renewedIntent.intent);
        if (this.#monotonicNow() >= deadline) return lose("deadline");

        const capsule = await this.#store.getCapsule(currentIntent.capsuleId);
        if (abortController.signal.aborted) {
          throw abortController.signal.reason;
        }
        if (this.#monotonicNow() >= deadline) return lose("deadline");
        if (lineageDisposition(renewedIntent.intent, capsule)) {
          return lose("lineage");
        }
        return {
          intentId: renewedIntent.intent.id,
          leaseToken,
          expectedNextItemIndex: renewedIntent.intent.nextItemIndex,
          workspaceId: renewedIntent.intent.workspaceId,
          capsuleId: renewedIntent.intent.capsuleId,
          installConfigId: renewedIntent.intent.installConfigId,
          stateVersionId: renewedIntent.intent.stateVersionId,
          outputId: renewedIntent.intent.outputId,
          stateGeneration: renewedIntent.intent.stateGeneration,
        };
      },
    };
  }

  async #settleFailure(
    intent: CapsuleInterfaceMaterializationIntent,
    leaseToken: string,
    kind: "retry" | "dead-letter",
    code: string,
  ): Promise<"retried" | "dead-lettered" | "lease-lost"> {
    const settledAt = requiredTimestamp(this.#now(), "now");
    const normalizedCode = errorCode(code);
    const detailDigest = await stableJsonDigest({ code: normalizedCode });
    const outcome: SettleCapsuleInterfaceMaterializationIntentOutcome =
      kind === "retry"
        ? {
            kind: "retry",
            code: normalizedCode,
            detailDigest,
            nextRetryAt: new Date(
              Date.parse(settledAt) + this.#retryDelay(intent.attempts),
            ).toISOString(),
          }
        : {
            kind: "dead-letter",
            code: normalizedCode,
            detailDigest,
          };
    const settlement = await this.#settle(intent, leaseToken, outcome);
    const settled = settlementKind(settlement, outcome);
    if (
      kind === "dead-letter" &&
      settlement.kind === "updated" &&
      settled === "dead-lettered"
    ) {
      await this.#reportDeadLetter(settlement.intent);
    }
    if (settled === "completed" || settled === "progressed") {
      throw new TypeError("non-completion settlement returned completed");
    }
    return settled;
  }

  async #reportDeadLetter(
    intent: CapsuleInterfaceMaterializationIntent,
  ): Promise<void> {
    try {
      await this.#activity.record({
        workspaceId: intent.workspaceId,
        action: "interface_materialization.dead_lettered",
        targetType: "capsule_interface_materialization_intent",
        targetId: intent.id,
        metadata: {
          capsuleId: intent.capsuleId,
          stateVersionId: intent.stateVersionId,
          stateGeneration: intent.stateGeneration,
          blueprintsDigest: intent.blueprintsDigest,
          errorCode: intent.error?.code ?? "unknown",
          detailDigest: intent.error?.detailDigest ?? "unknown",
          nextItemIndex: intent.nextItemIndex,
          totalItems: intent.totalItems,
        },
      });
    } catch (error) {
      log.warn("interface_materialization.activity_record_failed", {
        action: "interface_materialization.dead_lettered",
        errorName: error instanceof Error ? error.name : "unknown",
      });
    }
    if (!this.#observability) return;
    try {
      await this.#observability.recordMetric({
        id: `metric_${crypto.randomUUID().replaceAll("-", "")}`,
        name: "takosumi.interface_materialization.dead_lettered",
        kind: "counter",
        value: 1,
        workspaceId: intent.workspaceId,
        tags: { error_code: intent.error?.code ?? "unknown" },
        observedAt: intent.deadLetteredAt ?? intent.updatedAt,
      });
    } catch (error) {
      log.warn("interface_materialization.metric_record_failed", {
        metric: "takosumi.interface_materialization.dead_lettered",
        errorName: error instanceof Error ? error.name : "unknown",
      });
    }
  }

  async #settle(
    intent: CapsuleInterfaceMaterializationIntent,
    leaseToken: string,
    outcome: SettleCapsuleInterfaceMaterializationIntentOutcome,
  ): Promise<SettleCapsuleInterfaceMaterializationIntentResult> {
    return await this.#store.settleCapsuleInterfaceMaterializationIntent({
      id: intent.id,
      leaseToken,
      expectedNextItemIndex: intent.nextItemIndex,
      settledAt: requiredTimestamp(this.#now(), "now"),
      outcome,
    });
  }

  #retryDelay(attempts: number): number {
    const exponent = Math.max(0, Math.min(attempts - 1, 10));
    return Math.min(this.#retryBaseMs * 2 ** exponent, MAX_RETRY_MS);
  }
}

function lineageDisposition(
  intent: CapsuleInterfaceMaterializationIntent,
  capsule: Awaited<ReturnType<OpenTofuControlStore["getCapsule"]>>,
): "retired_before_materialization" | "superseded_before_materialization" | undefined {
  if (
    !capsule ||
    capsule.workspaceId !== intent.workspaceId ||
    capsule.status === "destroyed"
  ) {
    return "retired_before_materialization";
  }
  if (
    capsule.currentStateGeneration !== intent.stateGeneration ||
    capsule.currentStateVersionId !== intent.stateVersionId ||
    capsule.currentOutputId !== intent.outputId
  ) {
    return "superseded_before_materialization";
  }
  return undefined;
}

function settlementKind(
  result: SettleCapsuleInterfaceMaterializationIntentResult,
  outcome: SettleCapsuleInterfaceMaterializationIntentOutcome,
): "completed" | "progressed" | "retried" | "dead-lettered" | "lease-lost" {
  if (result.kind !== "updated") return "lease-lost";
  if (outcome.kind === "completed") return "completed";
  if (outcome.kind === "progress") return "progressed";
  return outcome.kind === "retry" ? "retried" : "dead-lettered";
}

function drainLimit(value: number | undefined): number {
  const limit = value ?? 25;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_DRAIN_LIMIT) {
    throw new TypeError(`limit must be an integer from 1 to ${MAX_DRAIN_LIMIT}`);
  }
  return limit;
}

function positiveDuration(
  value: number | undefined,
  fallback: number,
  field: string,
): number {
  const duration = value ?? fallback;
  if (!Number.isSafeInteger(duration) || duration < 1) {
    throw new TypeError(`${field} must be a positive safe integer`);
  }
  return duration;
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  field: string,
): number {
  const candidate = value ?? fallback;
  if (
    !Number.isSafeInteger(candidate) ||
    candidate < minimum ||
    candidate > maximum
  ) {
    throw new TypeError(
      `${field} must be an integer from ${minimum} to ${maximum}`,
    );
  }
  return candidate;
}

function requiredTimestamp(value: string, field: string): string {
  requiredText(value, field);
  if (!Number.isFinite(Date.parse(value))) {
    throw new TypeError(`${field} must be a timestamp`);
  }
  return value;
}

function requiredText(value: string, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value;
}

function errorCode(value: string): string {
  const code = requiredText(value, "error code");
  if (!/^[a-z][a-z0-9_]{0,127}$/u.test(code)) {
    throw new TypeError("error code must be lower snake_case");
  }
  return code;
}

function retry(
  code: string,
): Extract<CapsuleInterfaceMaterializationTargetResult, { kind: "retry" }> {
  return { kind: "retry", code };
}

function deadLetter(
  code: string,
): Extract<
  CapsuleInterfaceMaterializationTargetResult,
  { kind: "dead-letter" }
> {
  return { kind: "dead-letter", code };
}

function retryOrDeadLetterForInterface(
  conditions: readonly {
    readonly type: string;
    readonly reason?: string;
  }[],
): CapsuleInterfaceMaterializationTargetResult {
  const reason = readyReason(conditions);
  if (
    reason === "OwnerNotReady" ||
    reason === "CapsuleNotReady" ||
    reason === "OwnerDestroyQueued" ||
    reason === "RunLedgerUnsafe"
  ) {
    return retry("capsule_authority_unavailable");
  }
  return deadLetter("interface_resolution_failed");
}

function retryOrDeadLetterForBinding(
  conditions: readonly {
    readonly type: string;
    readonly reason?: string;
  }[],
  deliveryType: string,
): CapsuleInterfaceMaterializationTargetResult {
  const reason = readyReason(conditions);
  if (reason === "OAuthResourceConflict") {
    return deadLetter("binding_authority_conflict");
  }
  if (deliveryType === "oauth2") {
    return retry("oauth_authority_unavailable");
  }
  return retry("binding_authority_unavailable");
}

function readyReason(
  conditions: readonly {
    readonly type: string;
    readonly reason?: string;
  }[],
): string | undefined {
  return conditions.find((condition) => condition.type === "Ready")?.reason;
}
