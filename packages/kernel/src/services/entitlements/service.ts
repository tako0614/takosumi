import type { SpaceMembershipStore } from "../../domains/core/mod.ts";
import { permissionDenied } from "../../shared/errors.ts";
import type {
  EffectiveEntitlements,
  EffectiveEntitlementsQuery,
  EntitlementCapability,
  EntitlementDecision,
  EntitlementLimits,
  LocalEntitlementPolicyConfigDto,
  MutationBoundaryCheckInput,
  PolicyGrantDto,
  PolicyOverlayDto,
} from "./types.ts";

export interface EntitlementPolicyServiceOptions {
  readonly memberships: SpaceMembershipStore;
  readonly policy?: LocalEntitlementPolicyConfigDto;
}

const ALL_CAPABILITIES: readonly EntitlementCapability[] = [
  "deploy.read",
  "deploy.plan",
  "deploy.apply",
  "deploy.rollback",
  "resource.read",
  "resource.create",
  "resource.update",
  "resource.delete",
  "resource.bind",
  "resource.migrate",
  "resource.restore",
  "runtime.read",
  "runtime.scale",
  "runtime.restart",
  "runtime-agent.read",
  "runtime-agent.enqueue",
  "runtime-agent.register",
  "runtime-agent.drain",
  "runtime-agent.revoke",
];

export const DEFAULT_LOCAL_ENTITLEMENT_POLICY = Object.freeze(
  {
    defaults: {
      capabilities: ["deploy.read", "resource.read", "runtime.read"],
      limits: {
        deploysPerDay: 0,
        resourceInstances: 0,
        runtimeServices: 0,
        runtimeAgentConcurrentLeases: 0,
      },
    },
    roles: {
      owner: {
        capabilities: ALL_CAPABILITIES,
        limits: {
          deploysPerDay: 1000,
          resourceInstances: 1000,
          runtimeServices: 500,
          runtimeAgentConcurrentLeases: 100,
        },
      },
      admin: {
        capabilities: ALL_CAPABILITIES.filter((capability) =>
          capability !== "runtime-agent.revoke"
        ),
        limits: {
          deploysPerDay: 250,
          resourceInstances: 250,
          runtimeServices: 100,
          runtimeAgentConcurrentLeases: 50,
        },
      },
      member: {
        capabilities: [
          "deploy.read",
          "deploy.plan",
          "resource.read",
          "runtime.read",
          "runtime-agent.read",
        ],
        limits: {
          deploysPerDay: 25,
          resourceInstances: 25,
          runtimeServices: 10,
          runtimeAgentConcurrentLeases: 5,
        },
      },
      viewer: {
        capabilities: [
          "deploy.read",
          "resource.read",
          "runtime.read",
          "runtime-agent.read",
        ],
        limits: {
          deploysPerDay: 0,
          resourceInstances: 0,
          runtimeServices: 0,
          runtimeAgentConcurrentLeases: 0,
        },
      },
    },
  } satisfies LocalEntitlementPolicyConfigDto,
);

export class EntitlementPolicyService {
  readonly #memberships: SpaceMembershipStore;
  readonly #policy: LocalEntitlementPolicyConfigDto;

  constructor(options: EntitlementPolicyServiceOptions) {
    this.#memberships = options.memberships;
    this.#policy = mergePolicy(
      DEFAULT_LOCAL_ENTITLEMENT_POLICY,
      options.policy,
    );
  }

  async getEffectiveEntitlements(
    query: EffectiveEntitlementsQuery,
  ): Promise<EffectiveEntitlements | undefined> {
    const membership = await this.#memberships.get(
      query.spaceId,
      query.accountId,
    );
    if (!membership || membership.status !== "active") return undefined;

    const capabilitySet = new Set<EntitlementCapability>(
      this.#policy.defaults?.capabilities ?? [],
    );
    const limits: EntitlementLimits = {
      ...(this.#policy.defaults?.limits ?? {}),
    };

    for (const role of membership.roles) {
      applyGrant(capabilitySet, limits, this.#policy.roles?.[role]);
    }

    applyOverlay(capabilitySet, limits, this.#policy.spaces?.[query.spaceId]);
    if (query.groupId) {
      applyOverlay(
        capabilitySet,
        limits,
        this.#policy.groups?.[`${query.spaceId}:${query.groupId}`],
      );
    }

    return Object.freeze({
      spaceId: query.spaceId,
      groupId: query.groupId,
      accountId: query.accountId,
      roles: [...membership.roles],
      capabilities: [...capabilitySet].sort(),
      limits: Object.freeze({ ...limits }),
    });
  }

  async decideMutationBoundary(
    input: MutationBoundaryCheckInput,
  ): Promise<EntitlementDecision> {
    const entitlements = await this.getEffectiveEntitlements(input);
    if (!entitlements) {
      return {
        allowed: false,
        capability: input.operation,
        reason: "no active membership",
      };
    }

    if (!entitlements.capabilities.includes(input.operation)) {
      return {
        allowed: false,
        capability: input.operation,
        reason: `missing capability: ${input.operation}`,
        entitlements,
      };
    }

    return {
      allowed: true,
      capability: input.operation,
      reason: `capability granted: ${input.operation}`,
      entitlements,
    };
  }

  async requireMutationBoundary(
    input: MutationBoundaryCheckInput,
  ): Promise<EffectiveEntitlements> {
    const decision = await this.decideMutationBoundary(input);
    if (!decision.allowed || !decision.entitlements) {
      throw permissionDenied(decision.reason, {
        spaceId: input.spaceId,
        groupId: input.groupId,
        accountId: input.accountId,
        capability: input.operation,
      });
    }
    return decision.entitlements;
  }
}

function mergePolicy(
  base: LocalEntitlementPolicyConfigDto,
  override: LocalEntitlementPolicyConfigDto | undefined,
): LocalEntitlementPolicyConfigDto {
  if (!override) return base;
  return {
    defaults: mergeGrant(base.defaults, override.defaults),
    roles: { ...base.roles, ...override.roles },
    spaces: { ...base.spaces, ...override.spaces },
    groups: { ...base.groups, ...override.groups },
  };
}

function mergeGrant(
  base: PolicyGrantDto | undefined,
  override: PolicyGrantDto | undefined,
): PolicyGrantDto | undefined {
  if (!base) return override;
  if (!override) return base;
  return {
    capabilities: override.capabilities ?? base.capabilities,
    limits: { ...base.limits, ...override.limits },
  };
}

function applyGrant(
  capabilitySet: Set<EntitlementCapability>,
  limits: EntitlementLimits,
  grant: PolicyGrantDto | undefined,
): void {
  if (!grant) return;
  for (const capability of grant.capabilities ?? []) {
    capabilitySet.add(capability);
  }
  Object.assign(limits, grant.limits ?? {});
}

function applyOverlay(
  capabilitySet: Set<EntitlementCapability>,
  limits: EntitlementLimits,
  overlay: PolicyOverlayDto | undefined,
): void {
  if (!overlay) return;
  applyGrant(capabilitySet, limits, overlay);
  for (const capability of overlay.addCapabilities ?? []) {
    capabilitySet.add(capability);
  }
  for (const capability of overlay.removeCapabilities ?? []) {
    capabilitySet.delete(capability);
  }
}
