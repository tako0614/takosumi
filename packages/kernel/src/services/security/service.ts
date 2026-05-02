import type {
  NetworkPeer,
  NetworkProtocol,
  RuntimeNetworkPolicy,
  RuntimeNetworkPolicyStore,
  ServiceGrant,
  ServiceGrantStore,
  WorkloadIdentity,
  WorkloadIdentityId,
  WorkloadIdentityStore,
} from "../../domains/network/mod.ts";
import { permissionDenied } from "../../shared/errors.ts";

export interface WorkerAuthzStores {
  readonly workloadIdentities: WorkloadIdentityStore;
  readonly serviceGrants: ServiceGrantStore;
  readonly runtimeNetworkPolicies: RuntimeNetworkPolicyStore;
}

export interface WorkerAuthzServiceOptions {
  readonly stores: WorkerAuthzStores;
  readonly clock?: () => Date;
}

export interface AuthorizeInternalServiceCallInput {
  readonly sourceIdentityId?: WorkloadIdentityId;
  readonly targetService: string;
  readonly permission: string;
  readonly spaceId?: string;
  readonly groupId?: string;
}

export interface AuthorizeInternalServiceCallResult {
  readonly allowed: true;
  readonly identity: WorkloadIdentity;
  readonly grant: ServiceGrant;
}

export interface DecideRuntimeEgressInput {
  readonly sourceIdentityId?: WorkloadIdentityId;
  readonly sourceComponentName?: string;
  readonly spaceId: string;
  readonly groupId: string;
  readonly activationId?: string;
  readonly destinationHost?: string;
  readonly destinationCidr?: string;
  readonly destinationService?: string;
  readonly port?: number;
  readonly protocol?: NetworkProtocol;
  readonly enforcement?: "enforced" | "advisory";
}

export interface RuntimeEgressDecisionResult {
  readonly decision: "allowed" | "denied" | "unknown";
  readonly reason: string;
  readonly identity?: WorkloadIdentity;
  readonly policy?: RuntimeNetworkPolicy;
}

export class WorkerAuthzService {
  readonly #stores: WorkerAuthzStores;
  readonly #clock: () => Date;

  constructor(options: WorkerAuthzServiceOptions) {
    this.#stores = options.stores;
    this.#clock = options.clock ?? (() => new Date());
  }

  async authorizeInternalServiceCall(
    input: AuthorizeInternalServiceCallInput,
  ): Promise<AuthorizeInternalServiceCallResult> {
    if (!input.sourceIdentityId) {
      throw permissionDenied("Workload identity is required", {
        targetService: input.targetService,
        permission: input.permission,
      });
    }

    const identity = await this.#stores.workloadIdentities.get(
      input.sourceIdentityId,
    );
    if (!identity) {
      throw permissionDenied("Workload identity is not registered", {
        sourceIdentityId: input.sourceIdentityId,
      });
    }
    if (input.spaceId && identity.spaceId !== input.spaceId) {
      throw permissionDenied("Workload identity space mismatch", {
        sourceIdentityId: identity.id,
        identitySpaceId: identity.spaceId,
        requestedSpaceId: input.spaceId,
      });
    }
    if (input.groupId && identity.groupId !== input.groupId) {
      throw permissionDenied("Workload identity group mismatch", {
        sourceIdentityId: identity.id,
        identityGroupId: identity.groupId,
        requestedGroupId: input.groupId,
      });
    }

    const now = this.#clock();
    const grant = (await this.#stores.serviceGrants.listByIdentity(identity.id))
      .find((candidate) =>
        candidate.spaceId === identity.spaceId &&
        candidate.groupId === identity.groupId &&
        candidate.toService === input.targetService &&
        candidate.permissions.includes(input.permission) &&
        !isExpired(candidate, now)
      );

    if (!grant) {
      throw permissionDenied("Service grant is required", {
        sourceIdentityId: identity.id,
        targetService: input.targetService,
        permission: input.permission,
      });
    }

    return Object.freeze({ allowed: true as const, identity, grant });
  }

  async decideRuntimeEgress(
    input: DecideRuntimeEgressInput,
  ): Promise<RuntimeEgressDecisionResult> {
    const identity = await this.#resolveEgressIdentity(input);
    const componentName = input.sourceComponentName ?? identity?.componentName;
    const activationId = input.activationId ?? identity?.activationId;
    const policies = (await this.#stores.runtimeNetworkPolicies.listByGroup(
      input.spaceId,
      input.groupId,
    )).filter((policy) =>
      (!policy.activationId || policy.activationId === activationId) &&
      (!componentName || selectorMatchesComponent(policy, componentName))
    );

    for (const policy of policies) {
      const matchingRule = policy.egress.find((rule) =>
        (!rule.protocol || !input.protocol ||
          rule.protocol === input.protocol) &&
        (!rule.ports || input.port === undefined ||
          rule.ports.includes(input.port)) &&
        rule.peers.some((peer) => peerMatchesDestination(peer, input))
      );
      if (matchingRule) {
        return Object.freeze({
          decision: "allowed" as const,
          reason: "runtime network policy egress rule matched",
          identity,
          policy,
        });
      }
    }

    const denyingPolicy = policies.find((policy) =>
      policy.defaultEgress === "denied"
    );
    if (denyingPolicy) {
      if (input.enforcement === "advisory") {
        return Object.freeze({
          decision: "unknown" as const,
          reason:
            "advisory egress policy would deny; provider enforcement not required",
          identity,
          policy: denyingPolicy,
        });
      }
      return Object.freeze({
        decision: "denied" as const,
        reason: isPrivateDestination(input)
          ? "private egress blocked by runtime network policy"
          : "egress blocked by runtime network policy default",
        identity,
        policy: denyingPolicy,
      });
    }

    const allowingPolicy = policies.find((policy) =>
      policy.defaultEgress === "allowed"
    );
    if (allowingPolicy) {
      return Object.freeze({
        decision: "allowed" as const,
        reason: "runtime network policy default allows egress",
        identity,
        policy: allowingPolicy,
      });
    }

    return Object.freeze({
      decision: "unknown" as const,
      reason: "no runtime network policy matched source workload",
      identity,
    });
  }

  async #resolveEgressIdentity(
    input: DecideRuntimeEgressInput,
  ): Promise<WorkloadIdentity | undefined> {
    if (input.sourceIdentityId) {
      const identity = await this.#stores.workloadIdentities.get(
        input.sourceIdentityId,
      );
      if (
        identity?.spaceId === input.spaceId &&
        identity.groupId === input.groupId &&
        (!input.activationId || !identity.activationId ||
          identity.activationId === input.activationId)
      ) {
        return identity;
      }
      return undefined;
    }
    if (input.sourceComponentName) {
      return await this.#stores.workloadIdentities.findByComponent(
        input.spaceId,
        input.groupId,
        input.sourceComponentName,
      );
    }
    return undefined;
  }
}

function isExpired(grant: ServiceGrant, now: Date): boolean {
  return grant.expiresAt !== undefined &&
    Date.parse(grant.expiresAt) <= now.getTime();
}

function selectorMatchesComponent(
  policy: RuntimeNetworkPolicy,
  componentName: string,
): boolean {
  const names = policy.selector.componentNames;
  return !names || names.includes(componentName);
}

function peerMatchesDestination(
  peer: NetworkPeer,
  input: DecideRuntimeEgressInput,
): boolean {
  if (peer.host && input.destinationHost) {
    return peer.host === input.destinationHost;
  }
  if (peer.cidr && input.destinationCidr) {
    return peer.cidr === input.destinationCidr;
  }
  if (peer.service && input.destinationService) {
    return peer.service === input.destinationService;
  }
  return false;
}

function isPrivateDestination(input: DecideRuntimeEgressInput): boolean {
  const value = input.destinationCidr ?? input.destinationHost;
  if (!value) return false;
  const address = value.split("/")[0];
  const parts = address.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) {
    return false;
  }
  const [a, b] = parts;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || a === 127 || (a === 169 && b === 254);
}
