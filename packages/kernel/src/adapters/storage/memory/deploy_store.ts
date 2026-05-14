// In-memory implementation of `DeploymentStore`. Owns the deployment
// record map, the group-head map, and the (in-memory) provider
// observation map for a single transaction.

import type {
  Deployment,
  GroupHead,
  ProviderObservation as CoreProviderObservation,
} from "takosumi-contract";
import type {
  AdvanceGroupHeadInput,
  CommitAppliedDeploymentInput,
  CommitAppliedDeploymentResult,
  DeploymentFilter,
  DeploymentStore,
  GroupHeadRef,
} from "../../../domains/deploy/store.ts";
import {
  assertDeploymentHeadScope,
  groupHeadKey,
  immutable,
  normalizeDeploymentStatusFilter,
} from "./helpers.ts";
import type { MemoryDeployState } from "./state.ts";

export class MemoryDeploymentStore implements DeploymentStore {
  constructor(private readonly deploy: MemoryDeployState) {}

  getDeployment(id: string): Promise<Deployment | undefined> {
    return Promise.resolve(this.deploy.deployments.get(id));
  }

  putDeployment(deployment: Deployment): Promise<Deployment> {
    const value = immutable(deployment);
    this.deploy.deployments.set(value.id, value);
    return Promise.resolve(value);
  }

  listDeployments(filter: DeploymentFilter): Promise<readonly Deployment[]> {
    const statuses = normalizeDeploymentStatusFilter(filter.status);
    const deployments = [...this.deploy.deployments.values()].filter(
      (deployment) =>
        (!filter.spaceId || deployment.space_id === filter.spaceId) &&
        (!filter.groupId || deployment.group_id === filter.groupId) &&
        (!statuses || statuses.has(deployment.status)),
    );
    deployments.sort((left, right) =>
      left.created_at.localeCompare(right.created_at)
    );
    return Promise.resolve(
      filter.limit === undefined
        ? deployments
        : deployments.slice(0, Math.max(0, filter.limit)),
    );
  }

  getGroupHead(input: GroupHeadRef): Promise<GroupHead | undefined>;
  getGroupHead(groupId: string): Promise<GroupHead | undefined>;
  getGroupHead(input: GroupHeadRef | string): Promise<GroupHead | undefined> {
    if (typeof input === "string") {
      const matches = [...this.deploy.groupHeads.values()].filter((head) =>
        head.group_id === input
      );
      return Promise.resolve(matches.length === 1 ? matches[0] : undefined);
    }
    return Promise.resolve(
      this.deploy.groupHeads.get(groupHeadKey(input.spaceId, input.groupId)),
    );
  }

  advanceGroupHead(input: AdvanceGroupHeadInput): Promise<GroupHead> {
    const deployment = this.deploy.deployments.get(input.currentDeploymentId);
    if (!deployment) {
      throw new Error(`unknown deployment: ${input.currentDeploymentId}`);
    }
    assertDeploymentHeadScope(input, deployment);
    const key = groupHeadKey(input.spaceId, input.groupId);
    const previous = this.deploy.groupHeads.get(key);
    if (
      input.expectedCurrentDeploymentId !== undefined &&
      previous?.current_deployment_id !== input.expectedCurrentDeploymentId
    ) {
      throw new Error(
        `stale group head: expected deployment ${
          input.expectedCurrentDeploymentId ?? "<none>"
        } but found ${previous?.current_deployment_id ?? "<none>"}`,
      );
    }
    if (
      input.expectedGeneration !== undefined &&
      (previous?.generation ?? 0) !== input.expectedGeneration
    ) {
      throw new Error(
        `stale group head: expected generation ${input.expectedGeneration} but found ${
          previous?.generation ?? 0
        }`,
      );
    }
    const head = immutable({
      space_id: input.spaceId,
      group_id: input.groupId,
      current_deployment_id: input.currentDeploymentId,
      previous_deployment_id: previous?.current_deployment_id ?? null,
      generation: (previous?.generation ?? 0) + 1,
      advanced_at: input.advancedAt ?? new Date().toISOString(),
    });
    this.deploy.groupHeads.set(key, head);
    return Promise.resolve(head);
  }

  commitAppliedDeployment(
    input: CommitAppliedDeploymentInput,
  ): Promise<CommitAppliedDeploymentResult> {
    assertDeploymentHeadScope(input, input.deployment);
    if (input.deployment.id !== input.currentDeploymentId) {
      throw new Error(
        `commit deployment id ${input.deployment.id} does not match head target ${input.currentDeploymentId}`,
      );
    }
    const key = groupHeadKey(input.spaceId, input.groupId);
    const previous = this.deploy.groupHeads.get(key);
    if (
      input.expectedCurrentDeploymentId !== undefined &&
      previous?.current_deployment_id !== input.expectedCurrentDeploymentId
    ) {
      throw new Error(
        `stale group head: expected deployment ${
          input.expectedCurrentDeploymentId ?? "<none>"
        } but found ${previous?.current_deployment_id ?? "<none>"}`,
      );
    }
    if (
      input.expectedGeneration !== undefined &&
      (previous?.generation ?? 0) !== input.expectedGeneration
    ) {
      throw new Error(
        `stale group head: expected generation ${input.expectedGeneration} but found ${
          previous?.generation ?? 0
        }`,
      );
    }
    const deployment = immutable(input.deployment);
    const head = immutable({
      space_id: input.spaceId,
      group_id: input.groupId,
      current_deployment_id: input.currentDeploymentId,
      previous_deployment_id: previous?.current_deployment_id ?? null,
      generation: (previous?.generation ?? 0) + 1,
      advanced_at: input.advancedAt ?? new Date().toISOString(),
    });
    this.deploy.deployments.set(deployment.id, deployment);
    this.deploy.groupHeads.set(key, head);
    return Promise.resolve({ deployment, head });
  }

  recordObservation(
    observation: CoreProviderObservation,
  ): Promise<CoreProviderObservation> {
    const value = immutable(observation);
    this.deploy.providerObservations.set(value.id, value);
    return Promise.resolve(value);
  }
}
