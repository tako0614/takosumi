export type RuntimeNetworkPolicyId = string;
export type WorkloadIdentityId = string;
export type NetworkServiceGrantId = string;
export type NetworkProtocol = "http" | "https" | "tcp" | "udp" | string;
export type EgressDecision = "allowed" | "denied" | "unknown";

export interface WorkloadSelector {
  readonly componentNames?: readonly string[];
  readonly labels?: Record<string, string>;
}

export interface NetworkPeer {
  readonly workloadSelector?: WorkloadSelector;
  readonly cidr?: string;
  readonly host?: string;
  readonly service?: string;
}

export interface NetworkRule {
  readonly peers: readonly NetworkPeer[];
  readonly ports?: readonly number[];
  readonly protocol?: NetworkProtocol;
}

export interface RuntimeNetworkPolicy {
  readonly id: RuntimeNetworkPolicyId;
  readonly spaceId: string;
  readonly groupId: string;
  readonly activationId?: string;
  readonly name: string;
  readonly selector: WorkloadSelector;
  readonly ingress: readonly NetworkRule[];
  readonly egress: readonly NetworkRule[];
  readonly defaultEgress: EgressDecision;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface WorkloadIdentity {
  readonly id: WorkloadIdentityId;
  readonly spaceId: string;
  readonly groupId: string;
  readonly activationId?: string;
  readonly componentName: string;
  readonly subject: string;
  readonly claims: Record<string, string>;
  readonly issuedAt: string;
}

export interface NetworkServiceGrant {
  readonly id: NetworkServiceGrantId;
  readonly spaceId: string;
  readonly groupId: string;
  readonly fromIdentityId: WorkloadIdentityId;
  readonly toService: string;
  readonly permissions: readonly string[];
  readonly createdAt: string;
  readonly expiresAt?: string;
}
