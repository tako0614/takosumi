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
  ResourceAdapter,
} from "./adapter.ts";
import { parseResourceShapeId, type ResourceShapeRecord } from "./records.ts";

export type HostRuntimeMaterializationResolver = (input: {
  readonly owner: ResourceOwner | undefined;
  /** Canonical Resource this operation belongs to. */
  readonly resourceId?: string;
  /** Canonical validated spec of that Resource, when the operation has one. */
  readonly validatedSpec?: Readonly<Record<string, unknown>>;
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
  /**
   * Reports whether an exact canonical Resource revision still owns retained
   * host runtime state that must be retired even when the provider object is
   * already absent. Implementations must fail closed on identity mismatch.
   */
  retirementRequired(input: {
    readonly resourceId: string;
    readonly resourceGeneration: number;
    readonly resourceRevisionId: string;
  }): Promise<boolean>;
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
  const declared =
    typeof connection.resource === "string" ? connection.resource : "";
  // A portable Form may name the target by canonical id or by the exact
  // same-Workspace `EdgeWorker/name` shorthand; both spell one identity.
  const shorthand = /^EdgeWorker\/(.+)$/u.exec(declared);
  const resourceId = shorthand
    ? `tkrn:${input.request.workspaceId}:EdgeWorker:${shorthand[1]}`
    : declared;
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
  return async ({ owner, resourceId, validatedSpec }) => {
    if (owner === undefined) {
      // A form-host Resource has no Capsule owner; its own portable Form
      // application is the authorization act for its declared connections.
      return resourceId && validatedSpec
        ? formHostRuntimeMaterializationRequest({ resourceId, validatedSpec })
        : undefined;
    }
    if (!isResourceCapsuleOwner(owner)) return undefined;
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
 * Resource binding projections a portable Form may declare on an EdgeWorker.
 * Each one becomes exactly one host-materialized Resource binding; the host
 * never invents a binding an author did not declare.
 */
const FORM_HOST_RESOURCE_BINDING_PROJECTIONS = new Set([
  "sql.binding.v1",
  "keyvalue.binding.v1",
  "object.binding.v1",
  "queue.binding.v1",
]);
const FORM_HOST_RESOURCE_BINDING_PERMISSION = "takosumi.resource.bind";

/**
 * Derives runtime requirements for a form-host EdgeWorker that has no Capsule.
 *
 * A portable Form application is the whole authorization act here: the exact
 * `spec.connections` the author declared, and nothing else, become Resource
 * binding requirements. There is no InstallConfig to add secrets, OIDC, or
 * background activations, so those remain unavailable to this path.
 */
export function formHostRuntimeMaterializationRequest(input: {
  readonly resourceId: string;
  readonly validatedSpec: Readonly<Record<string, unknown>>;
}): HostRuntimeMaterializationRequest | undefined {
  const identity = /^tkrn:([^:]+):EdgeWorker:(.+)$/u.exec(input.resourceId);
  if (!identity?.[1] || !identity[2]) return undefined;
  const workspaceId = identity[1];
  const connections = input.validatedSpec.connections;
  if (!connections || typeof connections !== "object") return undefined;
  const requirements = Object.entries(
    connections as Record<string, unknown>,
  )
    .filter(([, value]) => {
      const projection = record(value).projection;
      return (
        typeof projection === "string" &&
        FORM_HOST_RESOURCE_BINDING_PROJECTIONS.has(projection)
      );
    })
    .map(([alias]) => ({
      kind: "resource_binding" as const,
      binding: alias,
      connectionAlias: alias,
      requiredPermission: FORM_HOST_RESOURCE_BINDING_PERMISSION,
    }))
    .sort((left, right) => left.binding.localeCompare(right.binding));
  if (requirements.length === 0) return undefined;
  return {
    contract: HOST_RUNTIME_MATERIALIZATION_CONTRACT,
    // A form-host Resource is its own installation authority: the applying
    // portable identity is the Resource itself, not a Capsule installer.
    installConfigId: input.resourceId,
    workspaceId,
    capsuleId: input.resourceId,
    installingPrincipalId: input.resourceId,
    requirements,
  };
}

/**
 * Decorates one selected adapter without giving it access to Capsule or
 * InstallConfig stores. Mutating operations that construct runtime state get
 * a fresh exact resolution; read-only and teardown operations receive no
 * runtime envelope from callers or the current InstallConfig.
 */
export function withDbOwnedHostRuntimeMaterialization(
  adapter: ResourceAdapter,
  resolve: HostRuntimeMaterializationResolver,
  lifecycle?: HostRuntimeResourceLifecycle,
): ResourceAdapter {
  const materializeInput = async <T extends AdapterApplyInput>(
    input: T,
  ): Promise<T> => {
    const materialization = await resolve({
      owner: input.owner,
      resourceId: input.resourceId,
      ...(input.plan?.validatedSpec
        ? { validatedSpec: input.plan.validatedSpec }
        : {}),
    });
    const {
      hostRuntimeMaterialization: _untrustedMaterialization,
      ...canonicalInput
    } = input;
    return {
      ...canonicalInput,
      ...(materialization
        ? { hostRuntimeMaterialization: materialization }
        : {}),
    } as T;
  };
  const stripUntrustedMaterialization = <T extends {
    readonly hostRuntimeMaterialization?: unknown;
  }>(input: T): Omit<T, "hostRuntimeMaterialization"> => {
    const {
      hostRuntimeMaterialization: _untrustedMaterialization,
      ...canonicalInput
    } = input;
    return canonicalInput;
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
      return await adapter.preview(await materializeInput(input));
    },
    async apply(input) {
      return await adapter.apply(await materializeInput(input));
    },
    async importResource(input) {
      return await adapter.importResource(await materializeInput(input));
    },
    async observe(input) {
      const canonicalInput = stripUntrustedMaterialization(input);
      const observation = await adapter.observe(canonicalInput);
      if (!lifecycle || observation.status !== "missing") return observation;
      const canonicalKind = parseResourceShapeId(input.resourceId)?.kind;
      if (
        canonicalKind !== "EdgeWorker" &&
        input.plan?.shape !== "EdgeWorker"
      ) {
        return observation;
      }
      if (
        canonicalKind !== "EdgeWorker" ||
        input.plan?.shape !== "EdgeWorker"
      ) {
        throw new Error(
          `host runtime lifecycle observe identity does not match EdgeWorker ${input.resourceId}`,
        );
      }
      // Provider-native/module-backed plans have no retained host runtime.
      if (input.plan.requiresAdapterPlugin !== true) return observation;
      if (!input.resourceRevisionId) {
        throw new Error(
          `host runtime lifecycle has no canonical backend revision for ${input.resourceId}`,
        );
      }
      if (
        !(await lifecycle.retirementRequired({
          resourceId: input.resourceId,
          resourceGeneration: input.resourceGeneration,
          resourceRevisionId: input.resourceRevisionId,
        }))
      ) {
        return observation;
      }
      return {
        ...observation,
        status: "drifted",
        summary:
          "provider resource is missing but retained host runtime requires retirement",
      };
    },
    async refresh(input) {
      return await adapter.refresh(stripUntrustedMaterialization(input));
    },
    async delete(input) {
      const canonicalInput = stripUntrustedMaterialization(input);
      const canonicalKind = parseResourceShapeId(input.resourceId)?.kind;
      if (
        lifecycle &&
        (canonicalKind === "EdgeWorker" || input.plan?.shape === "EdgeWorker")
      ) {
        if (canonicalKind !== "EdgeWorker" || input.plan?.shape !== "EdgeWorker") {
          throw new Error(
            `host runtime lifecycle delete identity does not match EdgeWorker ${input.resourceId}`,
          );
        }
        // Provider-native/module-backed plans have no retained host runtime;
        // their delete may legitimately have no direct-plugin revision.
        if (input.plan.requiresAdapterPlugin !== true) {
          await adapter.delete(canonicalInput);
          return;
        }
        if (!input.resourceRevisionId) {
          throw new Error(
            `host runtime lifecycle has no canonical backend revision for ${input.resourceId}`,
          );
        }
        await lifecycle.retire({
          resourceId: input.resourceId,
          resourceGeneration: input.resourceGeneration,
          resourceRevisionId: input.resourceRevisionId,
        });
      }
      await adapter.delete(canonicalInput);
    },
    ...(adapter.migrate
      ? {
          migrate: async (input) => {
            return await adapter.migrate!({
              ...stripUntrustedMaterialization(input),
              migration: input.migration,
            });
          },
        }
      : {}),
  };
}
