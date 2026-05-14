// In-memory `DeploymentStore` reference implementation.
//
// Used by tests and local-development bootstrap. Kept separate from the
// `DeploymentService` orchestrator so the deploy/ entry file stays focused
// on the public service surface; this module owns the head-lock /
// precondition / history-mirroring contract for a non-persistent store.

import type {
  Deployment,
  GroupHead,
  ProviderObservation,
} from "takosumi-contract";
import { InMemoryGroupHeadHistoryStore } from "../group_head_history.ts";
import type { GroupHeadHistoryStore } from "../group_head_history.ts";
import type {
  AdvanceGroupHeadInput,
  CommitAppliedDeploymentInput,
  CommitAppliedDeploymentResult,
  DeploymentFilter,
  DeploymentStore,
  GroupHeadRef,
  ProviderObservationFilter,
  RollbackValidators,
} from "../deployment_service.ts";
import { DEFAULT_ROLLBACK_VALIDATORS } from "../deployment_service.ts";
import { deepFreeze } from "./hash.ts";

/** Minimal in-memory `DeploymentStore` implementation. */
export class InMemoryDeploymentStore implements DeploymentStore {
  readonly #deployments = new Map<string, Deployment>();
  readonly #heads = new Map<string, GroupHead>();
  readonly #observations = new Map<string, ProviderObservation>();
  readonly #headLocks = new Map<string, Promise<void>>();
  // Phase 18.3 / M6 — multi-generation rollback history. Append-only;
  // mirrors every `advanceGroupHead` / `commitAppliedDeployment` mutation.
  readonly #history = new InMemoryGroupHeadHistoryStore();

  // deno-lint-ignore require-await
  async getDeployment(id: string): Promise<Deployment | undefined> {
    return this.#deployments.get(id);
  }

  // deno-lint-ignore require-await
  async putDeployment(deployment: Deployment): Promise<Deployment> {
    const frozen = deepFreeze(structuredClone(deployment));
    this.#deployments.set(frozen.id, frozen);
    return frozen;
  }

  // deno-lint-ignore require-await
  async listDeployments(
    filter: DeploymentFilter,
  ): Promise<readonly Deployment[]> {
    const statuses = normalizeStatusFilter(filter.status);
    const matches: Deployment[] = [];
    for (const deployment of this.#deployments.values()) {
      if (filter.spaceId && deployment.space_id !== filter.spaceId) continue;
      if (filter.groupId && deployment.group_id !== filter.groupId) continue;
      if (statuses && !statuses.has(deployment.status)) continue;
      matches.push(deployment);
    }
    matches.sort((a, b) => a.created_at.localeCompare(b.created_at));
    return filter.limit === undefined
      ? matches
      : matches.slice(0, Math.max(0, filter.limit));
  }

  getGroupHead(input: GroupHeadRef): Promise<GroupHead | undefined>;
  getGroupHead(groupId: string): Promise<GroupHead | undefined>;
  getGroupHead(
    input: GroupHeadRef | string,
  ): Promise<GroupHead | undefined> {
    if (typeof input === "string") {
      return Promise.resolve(findUniqueGroupHeadByGroupId(this.#heads, input));
    }
    return Promise.resolve(
      this.#heads.get(groupHeadKey(input.spaceId, input.groupId)),
    );
  }

  async advanceGroupHead(
    input: AdvanceGroupHeadInput,
  ): Promise<GroupHead> {
    return await this.#withHeadLock(input.spaceId, input.groupId, async () => {
      const deployment = this.#deployments.get(input.currentDeploymentId);
      assertHeadDeploymentScope(input, deployment);
      const key = groupHeadKey(input.spaceId, input.groupId);
      const previous = this.#heads.get(key);
      assertHeadPrecondition(input, previous);
      const advancedAt = input.advancedAt ?? new Date().toISOString();
      const next: GroupHead = deepFreeze({
        space_id: input.spaceId,
        group_id: input.groupId,
        current_deployment_id: input.currentDeploymentId,
        previous_deployment_id: previous?.current_deployment_id ?? null,
        generation: (previous?.generation ?? 0) + 1,
        advanced_at: advancedAt,
      });
      this.#heads.set(key, next);
      // Phase 18.3 / M6 — Append the rollover to the history store under
      // the same head lock so racing writers cannot interleave their
      // history rows. The DB-backed adapter wraps both writes in a single
      // SQL transaction; the in-memory adapter relies on the sequential
      // execution within `#withHeadLock`.
      await this.#history.append({
        spaceId: input.spaceId,
        groupId: input.groupId,
        deploymentId: input.currentDeploymentId,
        previousDeploymentId: previous?.current_deployment_id ?? null,
        sequence: next.generation,
        advancedAt,
      });
      return next;
    });
  }

  async commitAppliedDeployment(
    input: CommitAppliedDeploymentInput,
  ): Promise<CommitAppliedDeploymentResult> {
    return await this.#withHeadLock(input.spaceId, input.groupId, async () => {
      assertHeadDeploymentScope(input, input.deployment);
      if (input.deployment.id !== input.currentDeploymentId) {
        throw new Error(
          `commit deployment id ${input.deployment.id} does not match head target ${input.currentDeploymentId}`,
        );
      }
      const key = groupHeadKey(input.spaceId, input.groupId);
      const previous = this.#heads.get(key);
      assertHeadPrecondition(input, previous);
      const advancedAt = input.advancedAt ?? new Date().toISOString();
      const deployment = deepFreeze(structuredClone(input.deployment));
      const head: GroupHead = deepFreeze({
        space_id: input.spaceId,
        group_id: input.groupId,
        current_deployment_id: input.currentDeploymentId,
        previous_deployment_id: previous?.current_deployment_id ?? null,
        generation: (previous?.generation ?? 0) + 1,
        advanced_at: advancedAt,
      });
      this.#deployments.set(deployment.id, deployment);
      this.#heads.set(key, head);
      // Phase 18.3 / M6 — Append the rollover to the history store under
      // the same head lock (see `advanceGroupHead` for transactional notes).
      await this.#history.append({
        spaceId: input.spaceId,
        groupId: input.groupId,
        deploymentId: input.currentDeploymentId,
        previousDeploymentId: previous?.current_deployment_id ?? null,
        sequence: head.generation,
        advancedAt,
      });
      return { deployment, head };
    });
  }

  // deno-lint-ignore require-await
  async recordObservation(
    observation: ProviderObservation,
  ): Promise<ProviderObservation> {
    const frozen = deepFreeze(structuredClone(observation));
    this.#observations.set(frozen.id, frozen);
    return frozen;
  }

  // deno-lint-ignore require-await
  async listObservations(
    filter: ProviderObservationFilter = {},
  ): Promise<readonly ProviderObservation[]> {
    const matches: ProviderObservation[] = [];
    for (const observation of this.#observations.values()) {
      if (
        filter.deploymentId &&
        observation.deployment_id !== filter.deploymentId
      ) continue;
      if (filter.providerId && observation.provider_id !== filter.providerId) {
        continue;
      }
      matches.push(observation);
    }
    matches.sort((a, b) => a.observed_at.localeCompare(b.observed_at));
    return filter.limit === undefined
      ? matches
      : matches.slice(0, Math.max(0, filter.limit));
  }

  /**
   * H2 — Default rollback validators. The in-memory store has no live
   * provider snapshot, so we delegate to the always-ok defaults. Real stores
   * (D1 / Postgres backed) SHOULD override with stronger checks that consult
   * the live `ProviderObservation` stream.
   */
  getDefaultRollbackValidators(): RollbackValidators {
    return DEFAULT_ROLLBACK_VALIDATORS;
  }

  /**
   * Phase 18.3 / M6 — expose the in-memory history store so
   * `DeploymentService.rollbackGroup` can resolve `--target=` / `--steps=`
   * against any retained generation. Stores backed by a real DB return a
   * `StorageBackedGroupHeadHistoryStore` that runs the queries inside the
   * same connection pool as `group_heads`.
   */
  getGroupHeadHistory(): GroupHeadHistoryStore {
    return this.#history;
  }

  async #withHeadLock<T>(
    spaceId: string,
    groupId: string,
    fn: () => T | Promise<T>,
  ): Promise<T> {
    const lockKey = groupHeadKey(spaceId, groupId);
    const previous = this.#headLocks.get(lockKey) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate, () => gate);
    this.#headLocks.set(lockKey, tail);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.#headLocks.get(lockKey) === tail) {
        this.#headLocks.delete(lockKey);
      }
    }
  }
}

function normalizeStatusFilter(
  status: DeploymentFilter["status"],
): Set<Deployment["status"]> | undefined {
  if (!status) return undefined;
  return new Set(Array.isArray(status) ? status : [status]);
}

function assertHeadPrecondition(
  input: AdvanceGroupHeadInput,
  current: GroupHead | undefined,
): void {
  if ("expectedCurrentDeploymentId" in input) {
    const observed = current?.current_deployment_id;
    if (observed !== input.expectedCurrentDeploymentId) {
      throw new Error(
        `stale group head for ${input.groupId}: expected current ${
          input.expectedCurrentDeploymentId ?? "<none>"
        } but found ${observed ?? "<none>"}`,
      );
    }
  }
  if (input.expectedGeneration !== undefined) {
    const observed = current?.generation ?? 0;
    if (observed !== input.expectedGeneration) {
      throw new Error(
        `stale group head for ${input.groupId}: expected generation ${input.expectedGeneration} but found ${observed}`,
      );
    }
  }
}

function assertHeadDeploymentScope(
  input: AdvanceGroupHeadInput,
  deployment: Deployment | undefined,
): void {
  if (!deployment) {
    throw new Error(`unknown deployment: ${input.currentDeploymentId}`);
  }
  if (deployment.space_id !== input.spaceId) {
    throw new Error(
      `deployment ${deployment.id} belongs to space ${deployment.space_id}, not ${input.spaceId}`,
    );
  }
  if (deployment.group_id !== input.groupId) {
    throw new Error(
      `deployment ${deployment.id} belongs to group ${deployment.group_id}, not ${input.groupId}`,
    );
  }
}

function groupHeadKey(spaceId: string, groupId: string): string {
  return `${spaceId}\u0000${groupId}`;
}

function findUniqueGroupHeadByGroupId(
  heads: ReadonlyMap<string, GroupHead>,
  groupId: string,
): GroupHead | undefined {
  const matches = [...heads.values()].filter((head) =>
    head.group_id === groupId
  );
  return matches.length === 1 ? matches[0] : undefined;
}
