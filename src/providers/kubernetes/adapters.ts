import type { RuntimeAgentRegistry } from "takosumi-contract";
import type { provider, router } from "takosumi-contract";
import type {
  KubernetesProviderClient,
  KubernetesRouterClient,
  KubernetesRuntimeAgentClient,
} from "./clients.ts";

type KubernetesProviderClientLike =
  | KubernetesProviderClient
  | provider.ProviderMaterializer;
type KubernetesRouterClientLike =
  | KubernetesRouterClient
  | router.RouterConfigPort;
type KubernetesRuntimeAgentClientLike =
  | KubernetesRuntimeAgentClient
  | RuntimeAgentRegistry;

export class KubernetesProviderAdapter
  implements provider.ProviderMaterializer {
  constructor(readonly client: KubernetesProviderClientLike) {}

  materialize(
    desiredState: Parameters<provider.ProviderMaterializer["materialize"]>[0],
  ): Promise<provider.ProviderMaterializationPlan> {
    if ("reconcileDesiredState" in this.client) {
      return this.client.reconcileDesiredState(desiredState);
    }
    return this.client.materialize(desiredState);
  }

  listRecordedOperations(): Promise<readonly provider.ProviderOperation[]> {
    if ("listOperations" in this.client) {
      return this.client.listOperations();
    }
    return this.client.listRecordedOperations();
  }

  clearRecordedOperations(): Promise<void> {
    if ("clearOperations" in this.client) {
      return this.client.clearOperations();
    }
    return this.client.clearRecordedOperations();
  }
}

export class KubernetesRouterAdapter implements router.RouterConfigPort {
  constructor(readonly client: KubernetesRouterClientLike) {}

  apply(
    projection: Parameters<router.RouterConfigPort["apply"]>[0],
  ): Promise<router.RouterConfigApplyResult> {
    if ("applyRoutes" in this.client) {
      return this.client.applyRoutes(projection);
    }
    return this.client.apply(projection);
  }
}

export class CompositeRouterConfigAdapter implements router.RouterConfigPort {
  constructor(
    readonly externalRouter: router.RouterConfigPort,
    readonly edgeRouter: router.RouterConfigPort,
    readonly adapterName = "composite-router",
  ) {}

  async apply(
    projection: Parameters<router.RouterConfigPort["apply"]>[0],
  ): Promise<router.RouterConfigApplyResult> {
    const external = await this.externalRouter.apply(projection);
    const edge = await this.edgeRouter.apply(projection);
    return {
      adapter: this.adapterName,
      config: edge.config,
      appliedAt: edge.appliedAt,
      path: edge.path ?? external.path,
      noop: edge.noop === true && external.noop === true,
    };
  }
}

export class KubernetesRuntimeAgentAdapter implements RuntimeAgentRegistry {
  constructor(readonly client: KubernetesRuntimeAgentClientLike) {}

  register(
    input: Parameters<RuntimeAgentRegistry["register"]>[0],
  ): ReturnType<RuntimeAgentRegistry["register"]> {
    if ("registerAgent" in this.client) {
      return this.client.registerAgent(input);
    }
    return this.client.register(input);
  }

  heartbeat(
    input: Parameters<RuntimeAgentRegistry["heartbeat"]>[0],
  ): ReturnType<RuntimeAgentRegistry["heartbeat"]> {
    if ("heartbeatAgent" in this.client) {
      return this.client.heartbeatAgent(input);
    }
    return this.client.heartbeat(input);
  }

  getAgent(
    agentId: Parameters<RuntimeAgentRegistry["getAgent"]>[0],
  ): ReturnType<RuntimeAgentRegistry["getAgent"]> {
    return this.client.getAgent(agentId);
  }

  listAgents(): ReturnType<RuntimeAgentRegistry["listAgents"]> {
    return this.client.listAgents();
  }

  requestDrain(
    agentId: Parameters<RuntimeAgentRegistry["requestDrain"]>[0],
    at?: Parameters<RuntimeAgentRegistry["requestDrain"]>[1],
  ): ReturnType<RuntimeAgentRegistry["requestDrain"]> {
    return this.client.requestDrain(agentId, at);
  }

  revoke(
    agentId: Parameters<RuntimeAgentRegistry["revoke"]>[0],
    at?: Parameters<RuntimeAgentRegistry["revoke"]>[1],
  ): ReturnType<RuntimeAgentRegistry["revoke"]> {
    if ("revokeAgent" in this.client) {
      return this.client.revokeAgent(agentId, at);
    }
    return this.client.revoke(agentId, at);
  }

  enqueueWork(
    input: Parameters<RuntimeAgentRegistry["enqueueWork"]>[0],
  ): ReturnType<RuntimeAgentRegistry["enqueueWork"]> {
    return this.client.enqueueWork(input);
  }

  leaseWork(
    input: Parameters<RuntimeAgentRegistry["leaseWork"]>[0],
  ): ReturnType<RuntimeAgentRegistry["leaseWork"]> {
    return this.client.leaseWork(input);
  }

  completeWork(
    input: Parameters<RuntimeAgentRegistry["completeWork"]>[0],
  ): ReturnType<RuntimeAgentRegistry["completeWork"]> {
    return this.client.completeWork(input);
  }

  failWork(
    input: Parameters<RuntimeAgentRegistry["failWork"]>[0],
  ): ReturnType<RuntimeAgentRegistry["failWork"]> {
    return this.client.failWork(input);
  }

  getWork(
    workId: Parameters<RuntimeAgentRegistry["getWork"]>[0],
  ): ReturnType<RuntimeAgentRegistry["getWork"]> {
    return this.client.getWork(workId);
  }

  listWork(): ReturnType<RuntimeAgentRegistry["listWork"]> {
    return this.client.listWork();
  }

  reportProgress(
    input: Parameters<RuntimeAgentRegistry["reportProgress"]>[0],
  ): ReturnType<RuntimeAgentRegistry["reportProgress"]> {
    if ("reportProgress" in this.client) {
      return this.client.reportProgress(input);
    }
    return Promise.reject(
      new Error(
        "KubernetesRuntimeAgentClient does not implement reportProgress; wire a registry-shaped client",
      ),
    );
  }

  detectStaleAgents(
    input: Parameters<RuntimeAgentRegistry["detectStaleAgents"]>[0],
  ): ReturnType<RuntimeAgentRegistry["detectStaleAgents"]> {
    if ("detectStaleAgents" in this.client) {
      return this.client.detectStaleAgents(input);
    }
    return Promise.reject(
      new Error(
        "KubernetesRuntimeAgentClient does not implement detectStaleAgents; wire a registry-shaped client",
      ),
    );
  }

  enqueueLongRunningOperation(
    input: Parameters<RuntimeAgentRegistry["enqueueLongRunningOperation"]>[0],
  ): ReturnType<RuntimeAgentRegistry["enqueueLongRunningOperation"]> {
    if ("enqueueLongRunningOperation" in this.client) {
      return this.client.enqueueLongRunningOperation(input);
    }
    return this.client.enqueueWork({
      kind: `provider.${input.provider}.${input.descriptor}`,
      provider: input.provider,
      priority: input.priority,
      queuedAt: input.enqueuedAt,
      idempotencyKey: input.idempotencyKey,
      payload: {
        descriptor: input.descriptor,
        desiredStateId: input.desiredStateId,
        targetId: input.targetId,
        ...input.payload,
      },
      metadata: {
        descriptor: input.descriptor,
        desiredStateId: input.desiredStateId,
        ...(input.targetId ? { targetId: input.targetId } : {}),
      },
    });
  }
}
