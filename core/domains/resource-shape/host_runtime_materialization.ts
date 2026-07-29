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
