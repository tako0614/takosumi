import type {
  EgressReport,
  EgressReportId,
  RuntimeNetworkPolicy,
  RuntimeNetworkPolicyId,
  ServiceGrant,
  ServiceGrantId,
  WorkloadIdentity,
  WorkloadIdentityId,
} from "./types.ts";

export interface RuntimeNetworkPolicyStore {
  put(policy: RuntimeNetworkPolicy): Promise<RuntimeNetworkPolicy>;
  get(id: RuntimeNetworkPolicyId): Promise<RuntimeNetworkPolicy | undefined>;
  listByGroup(
    spaceId: string,
    groupId: string,
  ): Promise<readonly RuntimeNetworkPolicy[]>;
}

export interface WorkloadIdentityStore {
  put(identity: WorkloadIdentity): Promise<WorkloadIdentity>;
  get(id: WorkloadIdentityId): Promise<WorkloadIdentity | undefined>;
  findByComponent(
    spaceId: string,
    groupId: string,
    componentName: string,
  ): Promise<WorkloadIdentity | undefined>;
}

export interface ServiceGrantStore {
  put(grant: ServiceGrant): Promise<ServiceGrant>;
  get(id: ServiceGrantId): Promise<ServiceGrant | undefined>;
  listByIdentity(
    identityId: WorkloadIdentityId,
  ): Promise<readonly ServiceGrant[]>;
}

export interface EgressReportStore {
  put(report: EgressReport): Promise<EgressReport>;
  get(id: EgressReportId): Promise<EgressReport | undefined>;
  latestForGroup(
    spaceId: string,
    groupId: string,
  ): Promise<EgressReport | undefined>;
}

export class InMemoryRuntimeNetworkPolicyStore
  implements RuntimeNetworkPolicyStore {
  readonly #policies = new Map<RuntimeNetworkPolicyId, RuntimeNetworkPolicy>();
  put(policy: RuntimeNetworkPolicy): Promise<RuntimeNetworkPolicy> {
    const frozen = deepFreeze(structuredClone(policy));
    this.#policies.set(frozen.id, frozen);
    return Promise.resolve(frozen);
  }
  get(id: RuntimeNetworkPolicyId): Promise<RuntimeNetworkPolicy | undefined> {
    return Promise.resolve(this.#policies.get(id));
  }
  listByGroup(
    spaceId: string,
    groupId: string,
  ): Promise<readonly RuntimeNetworkPolicy[]> {
    return Promise.resolve(
      [...this.#policies.values()].filter((policy) =>
        policy.spaceId === spaceId && policy.groupId === groupId
      ),
    );
  }
}

export class InMemoryWorkloadIdentityStore implements WorkloadIdentityStore {
  readonly #identities = new Map<WorkloadIdentityId, WorkloadIdentity>();
  put(identity: WorkloadIdentity): Promise<WorkloadIdentity> {
    const frozen = deepFreeze(structuredClone(identity));
    this.#identities.set(frozen.id, frozen);
    return Promise.resolve(frozen);
  }
  get(id: WorkloadIdentityId): Promise<WorkloadIdentity | undefined> {
    return Promise.resolve(this.#identities.get(id));
  }
  findByComponent(
    spaceId: string,
    groupId: string,
    componentName: string,
  ): Promise<WorkloadIdentity | undefined> {
    for (const identity of this.#identities.values()) {
      if (
        identity.spaceId === spaceId && identity.groupId === groupId &&
        identity.componentName === componentName
      ) return Promise.resolve(identity);
    }
    return Promise.resolve(undefined);
  }
}

export class InMemoryServiceGrantStore implements ServiceGrantStore {
  readonly #grants = new Map<ServiceGrantId, ServiceGrant>();
  put(grant: ServiceGrant): Promise<ServiceGrant> {
    const frozen = deepFreeze(structuredClone(grant));
    this.#grants.set(frozen.id, frozen);
    return Promise.resolve(frozen);
  }
  get(id: ServiceGrantId): Promise<ServiceGrant | undefined> {
    return Promise.resolve(this.#grants.get(id));
  }
  listByIdentity(
    identityId: WorkloadIdentityId,
  ): Promise<readonly ServiceGrant[]> {
    return Promise.resolve(
      [...this.#grants.values()].filter((grant) =>
        grant.fromIdentityId === identityId
      ),
    );
  }
}

export class InMemoryEgressReportStore implements EgressReportStore {
  readonly #reports = new Map<EgressReportId, EgressReport>();
  put(report: EgressReport): Promise<EgressReport> {
    const frozen = deepFreeze(structuredClone(report));
    this.#reports.set(frozen.id, frozen);
    return Promise.resolve(frozen);
  }
  get(id: EgressReportId): Promise<EgressReport | undefined> {
    return Promise.resolve(this.#reports.get(id));
  }
  latestForGroup(
    spaceId: string,
    groupId: string,
  ): Promise<EgressReport | undefined> {
    const reports = [...this.#reports.values()]
      .filter((report) =>
        report.spaceId === spaceId && report.groupId === groupId
      )
      .sort((a, b) => b.generatedAt.localeCompare(a.generatedAt));
    return Promise.resolve(reports[0]);
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
  }
  return value;
}
