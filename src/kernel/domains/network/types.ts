export type RuntimeNetworkPolicyId = string;
export type WorkloadIdentityId = string;
export type ServiceGrantId = string;
export type EgressReportId = string;
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

export interface ServiceGrant {
  readonly id: ServiceGrantId;
  readonly spaceId: string;
  readonly groupId: string;
  readonly fromIdentityId: WorkloadIdentityId;
  readonly toService: string;
  readonly permissions: readonly string[];
  readonly createdAt: string;
  readonly expiresAt?: string;
}

export interface EgressReportEntry {
  readonly sourceIdentityId?: WorkloadIdentityId;
  readonly sourceComponentName?: string;
  readonly destinationHost?: string;
  readonly destinationCidr?: string;
  readonly port?: number;
  readonly protocol?: NetworkProtocol;
  readonly decision: EgressDecision;
  readonly bytesSent?: number;
  readonly bytesReceived?: number;
  readonly observedAt: string;
}

export interface EgressReportSummary {
  readonly allowedCount: number;
  readonly deniedCount: number;
  readonly unknownCount: number;
  readonly bytesSent: number;
  readonly bytesReceived: number;
}

export interface EgressReport {
  readonly id: EgressReportId;
  readonly spaceId: string;
  readonly groupId: string;
  readonly activationId?: string;
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly generatedAt: string;
  readonly entries: readonly EgressReportEntry[];
  readonly summary: EgressReportSummary;
}
