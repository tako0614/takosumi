export type UsageOwnerKind = "deploy" | "runtime" | "resource" | "agent";
export type UsageUnit = "count" | "millisecond" | "byte" | "cpu_millisecond";

export type DeployUsageMetric =
  | "deploy.apply"
  | "deploy.rollback"
  | "deploy.artifact_bytes";
export type RuntimeUsageMetric =
  | "runtime.worker_milliseconds"
  | "runtime.service_milliseconds"
  | "runtime.cpu_milliseconds"
  | "runtime.bandwidth_bytes";
export type ResourceUsageMetric =
  | "resource.instance_hours"
  | "resource.storage_bytes"
  | "resource.operation";
export type AgentUsageMetric =
  | "agent.run"
  | "agent.step"
  | "agent.token";
export type UsageMetric =
  | DeployUsageMetric
  | RuntimeUsageMetric
  | ResourceUsageMetric
  | AgentUsageMetric;

export interface UsageDimensions {
  readonly region?: string;
  readonly provider?: string;
  readonly sku?: string;
  readonly labels?: Readonly<Record<string, string>>;
}

export interface UsageEventBaseDto {
  readonly id: string;
  readonly spaceId: string;
  readonly groupId?: string;
  readonly occurredAt: string;
  readonly quantity: number;
  readonly unit: UsageUnit;
  readonly dimensions?: UsageDimensions;
}

export interface DeployUsageEventDto extends UsageEventBaseDto {
  readonly kind: "deploy";
  readonly metric: DeployUsageMetric;
  readonly deployId: string;
  readonly releaseId?: string;
}

export interface RuntimeUsageEventDto extends UsageEventBaseDto {
  readonly kind: "runtime";
  readonly metric: RuntimeUsageMetric;
  readonly runtimeId: string;
  readonly workloadId?: string;
}

export interface ResourceUsageEventDto extends UsageEventBaseDto {
  readonly kind: "resource";
  readonly metric: ResourceUsageMetric;
  readonly resourceInstanceId: string;
  readonly resourceContract?: string;
}

export interface AgentUsageEventDto extends UsageEventBaseDto {
  readonly kind: "agent";
  readonly metric: AgentUsageMetric;
  readonly agentRunId: string;
  readonly agentId?: string;
}

export type UsageEventDto =
  | DeployUsageEventDto
  | RuntimeUsageEventDto
  | ResourceUsageEventDto
  | AgentUsageEventDto;

export interface UsageAggregateKey {
  readonly spaceId: string;
  readonly groupId?: string;
  readonly ownerKind: UsageOwnerKind;
  readonly metric: UsageMetric;
  readonly unit: UsageUnit;
}

export interface UsageAggregate extends UsageAggregateKey {
  readonly id: string;
  readonly quantity: number;
  readonly eventCount: number;
  readonly firstOccurredAt: string;
  readonly lastOccurredAt: string;
  readonly updatedAt: string;
}

export interface UsageProjectionResult {
  readonly event: UsageEventDto;
  readonly aggregate: UsageAggregate;
  readonly billingForwarded: boolean;
  readonly quotaDecision?: UsageQuotaDecision;
}

export type UsageQuotaKey =
  | "cpuMilliseconds"
  | "storageBytes"
  | "bandwidthBytes";

export type UsageQuotaLimits = Partial<Record<UsageQuotaKey, number>>;

export interface UsageQuotaTierAssignment {
  readonly tierId: string;
  readonly limits: UsageQuotaLimits;
}

export interface UsageQuotaDecision {
  readonly allowed: boolean;
  readonly key: UsageQuotaKey;
  readonly tierId: string;
  readonly quantity: number;
  readonly limit?: number;
  readonly reason: string;
}
