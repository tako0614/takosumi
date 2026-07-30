import {
  HOST_RUNTIME_MATERIALIZATION_CONTRACT,
  isResourceCapsuleOwner,
  parseInstallConfigHostRuntimeMaterialization,
  type HostRuntimeMaterializationRequest,
  type ResourceOwner,
} from "takosumi-contract";
import type { CapsulesService } from "../capsules/mod.ts";
import type {
  AdapterApplyInput,
  AdapterDeleteInput,
  ResourceAdapter,
} from "./adapter.ts";
import type { ResourceShapeRecord } from "./records.ts";

export type HostRuntimeMaterializationResolver = (input: {
  readonly owner: ResourceOwner | undefined;
}) => Promise<HostRuntimeMaterializationRequest | undefined>;

export interface HostRuntimeResourceLifecycle {
  activate(input: {
    readonly request: HostRuntimeMaterializationRequest;
    readonly resourceId: string;
    readonly resourceGeneration: number;
    readonly resourceRevisionId: string;
  }): Promise<void>;
  /**
   * Runs while the exact Resource row still exists and before provider delete.
   * Implementations must fail closed by retiring dispatch authority first.
   */
  retire(input: {
    readonly request: HostRuntimeMaterializationRequest;
    readonly resourceId: string;
    readonly resourceGeneration: number;
    readonly resourceRevisionId: string;
  }): Promise<void>;
  /**
   * Rebuilds background activation authority for one already-prepared
   * EdgeWorker without replacing its immutable runtime release or secrets.
   * Hosts must atomically replace the full Capsule activation graph so a
   * Schedule update/delete cannot leave a stale revision dispatchable.
   */
  reconcile(input: {
    readonly request: HostRuntimeMaterializationRequest;
    readonly resourceId: string;
    readonly resourceGeneration: number;
    readonly resourceRevisionId: string;
  }): Promise<void>;
}

/**
 * Resolves the consumer of one provider-neutral Schedule source edge.
 *
 * The activation requirement names the alias on the Schedule itself. The
 * Resource graph remains acyclic (`Schedule -> EdgeWorker`), and no
 * repository/provider-specific native cron identity enters the host contract.
 */
export function scheduleHostRuntimeReconcileTarget(input: {
  readonly request: HostRuntimeMaterializationRequest;
  readonly source: Pick<ResourceShapeRecord, "kind" | "owner" | "spec">;
}): string | undefined {
  if (input.source.kind !== "Schedule") return undefined;
  const owner = input.source.owner;
  if (
    !isResourceCapsuleOwner(owner) ||
    owner.id !== input.request.capsuleId ||
    owner.workspaceId !== input.request.workspaceId ||
    owner.installingPrincipalId !== input.request.installingPrincipalId
  ) {
    return undefined;
  }
  const requirements =
    input.request.backgroundActivations?.filter(
      (activation) => activation.sourceResourceKind === "Schedule",
    ) ?? [];
  if (requirements.length === 0) return undefined;
  const connections = record(input.source.spec.connections);
  const entries = Object.entries(connections);
  if (entries.length !== 1) {
    throw new Error(
      "host runtime Schedule must have exactly one consumer connection",
    );
  }
  const [alias, value] = entries[0]!;
  const requirement = requirements.find(
    (candidate) => candidate.sourceConnectionAlias === alias,
  );
  if (!requirement) return undefined;
  const connection = record(value);
  const permissions = connection.permissions;
  if (
    connection.projection !== "schedule.trigger.v1" ||
    !Array.isArray(permissions) ||
    permissions.length !== 1 ||
    permissions[0] !== "invoke"
  ) {
    throw new Error(
      "host runtime Schedule target must be exact schedule.trigger.v1 invoke authority",
    );
  }
  const resourceId =
    typeof connection.resource === "string" ? connection.resource : "";
  const match = /^tkrn:([^:]+):EdgeWorker:(.+)$/u.exec(resourceId);
  if (!match || match[1] !== input.request.workspaceId) {
    throw new Error(
      "host runtime Schedule target must be an EdgeWorker in the same Workspace",
    );
  }
  return resourceId;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("host runtime Schedule connection graph is invalid");
  }
  return value as Record<string, unknown>;
}

/**
 * Resolves runtime requirements only from the exact Capsule and its DB-owned
 * InstallConfig. Matching string ids, OpenTofu outputs, and Resource labels are
 * deliberately not authority.
 */
export function createDbOwnedHostRuntimeMaterializationResolver(
  capsules: Pick<CapsulesService, "getCapsule" | "getInstallConfig">,
): HostRuntimeMaterializationResolver {
  return async ({ owner }) => {
    if (owner === undefined || !isResourceCapsuleOwner(owner)) {
      return undefined;
    }
    const capsule = await capsules.getCapsule(owner.id);
    if (
      capsule.workspaceId !== owner.workspaceId ||
      capsule.installingPrincipalId !== owner.installingPrincipalId ||
      capsule.status === "destroyed"
    ) {
      throw new Error(
        "host runtime materialization owner does not match the canonical Capsule",
      );
    }
    const config = await capsules.getInstallConfig(capsule.installConfigId);
    if (config.workspaceId !== capsule.workspaceId) {
      throw new Error(
        "host runtime materialization requires the Capsule's Workspace-scoped InstallConfig",
      );
    }
    if (config.hostRuntimeMaterialization === undefined) return undefined;
    const parsed = parseInstallConfigHostRuntimeMaterialization(
      config.hostRuntimeMaterialization,
    );
    return {
      contract: HOST_RUNTIME_MATERIALIZATION_CONTRACT,
      installConfigId: config.id,
      workspaceId: capsule.workspaceId,
      capsuleId: capsule.id,
      installingPrincipalId: owner.installingPrincipalId,
      requirements: parsed.requirements,
      ...(parsed.backgroundActivations
        ? { backgroundActivations: parsed.backgroundActivations }
        : {}),
    };
  };
}

/**
 * Decorates one selected adapter without giving it access to Capsule or
 * InstallConfig stores. Every operation gets a fresh exact resolution, so a
 * stale config or owner change fails before the provider adapter is called.
 */
export function withDbOwnedHostRuntimeMaterialization(
  adapter: ResourceAdapter,
  resolve: HostRuntimeMaterializationResolver,
): ResourceAdapter {
  const applyInput = async (
    input: AdapterApplyInput,
  ): Promise<AdapterApplyInput> => {
    const materialization = await resolve({ owner: input.owner });
    const {
      hostRuntimeMaterialization: _untrustedMaterialization,
      ...canonicalInput
    } = input;
    return {
      ...canonicalInput,
      ...(materialization
        ? { hostRuntimeMaterialization: materialization }
        : {}),
    };
  };
  const deleteInput = async (
    input: AdapterDeleteInput,
  ): Promise<AdapterDeleteInput> => {
    const materialization = await resolve({ owner: input.owner });
    const {
      hostRuntimeMaterialization: _untrustedMaterialization,
      ...canonicalInput
    } = input;
    return {
      ...canonicalInput,
      ...(materialization
        ? { hostRuntimeMaterialization: materialization }
        : {}),
    };
  };
  return {
    id: adapter.id,
    ...(adapter.availabilityForImplementation
      ? {
          availabilityForImplementation: (implementation) =>
            adapter.availabilityForImplementation!(implementation),
        }
      : {}),
    async preview(input) {
      return await adapter.preview(await applyInput(input));
    },
    async apply(input) {
      return await adapter.apply(await applyInput(input));
    },
    async importResource(input) {
      const materialization = await resolve({ owner: input.owner });
      const {
        hostRuntimeMaterialization: _untrustedMaterialization,
        ...canonicalInput
      } = input;
      return await adapter.importResource({
        ...canonicalInput,
        ...(materialization
          ? { hostRuntimeMaterialization: materialization }
          : {}),
      });
    },
    async observe(input) {
      return await adapter.observe(await applyInput(input));
    },
    async refresh(input) {
      return await adapter.refresh(await applyInput(input));
    },
    async delete(input) {
      await adapter.delete(await deleteInput(input));
    },
  };
}
