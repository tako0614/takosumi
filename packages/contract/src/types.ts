export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | {
  [key: string]: JsonValue;
};
export type JsonObject = { [key: string]: JsonValue };

export type IsoTimestamp = string;
export type Digest = string;
export type PrincipalKind = "account" | "service" | "agent" | "system";

export interface ActorContext {
  actorAccountId: string;
  spaceId?: string;
  roles: string[];
  requestId: string;
  principalKind?: PrincipalKind;
  serviceId?: string;
  agentId?: string;
  sessionId?: string;
  scopes?: string[];
  traceId?: string;
}

export interface SourceSnapshot {
  kind: "git" | "manifest" | "archive" | "inline";
  ref: string;
  digest: Digest;
  repositoryUrl?: string;
  commitSha?: string;
  path?: string;
  manifest?: JsonObject;
  capturedAt: IsoTimestamp;
}

export interface DomainEvent<TPayload extends JsonObject = JsonObject> {
  id: string;
  type: string;
  aggregateType: string;
  aggregateId: string;
  spaceId?: string;
  groupId?: string;
  actor?: ActorContext;
  payload: TPayload;
  occurredAt: IsoTimestamp;
  causationId?: string;
  correlationId?: string;
}

export type ConditionStatus = "true" | "false" | "unknown";

export interface Condition {
  type: string;
  status: ConditionStatus;
  reason?: string;
  message?: string;
  observedGeneration?: number;
  lastTransitionAt?: IsoTimestamp;
}

export type GroupSummaryStatus =
  | "empty"
  | "planning"
  | "applying"
  | "active"
  | "degraded"
  | "outage"
  | "recovering"
  | "failed"
  | "suspended"
  | "deleted";

export type ServiceEndpointProtocol = "http" | "https" | "tcp" | "udp";
export type TrustLevel = "platform" | "space" | "group" | "public" | "external";
export type GrantEffect = "allow" | "deny";

export interface ServiceEndpoint {
  id: string;
  serviceId: string;
  name: string;
  protocol: ServiceEndpointProtocol;
  url?: string;
  host?: string;
  port?: number;
  pathPrefix?: string;
  trust?: ServiceEndpointTrust;
}

export interface ServiceEndpointTrust {
  level: TrustLevel;
  audience?: string[];
  issuer?: string;
  expiresAt?: IsoTimestamp;
}

export interface ServiceGrant {
  id: string;
  subject: string;
  action: string;
  resource: string;
  effect: GrantEffect;
  conditions?: Condition[];
  expiresAt?: IsoTimestamp;
}

export interface SpaceCreateRequest {
  actor: ActorContext;
  name: string;
  slug?: string;
  metadata?: JsonObject;
}

export interface SpaceUpdateRequest {
  actor: ActorContext;
  spaceId: string;
  name?: string;
  slug?: string;
  metadata?: JsonObject;
}

export interface SpaceSummary {
  id: string;
  name: string;
  slug?: string;
  ownerAccountId?: string;
  createdAt?: IsoTimestamp;
  updatedAt?: IsoTimestamp;
  metadata?: JsonObject;
}

export interface GroupCreateRequest {
  actor: ActorContext;
  spaceId: string;
  name: string;
  envName?: string;
  metadata?: JsonObject;
}

export interface GroupUpdateRequest {
  actor: ActorContext;
  spaceId: string;
  groupId: string;
  name?: string;
  envName?: string;
  metadata?: JsonObject;
}

export interface GroupSummary {
  id: string;
  spaceId: string;
  name: string;
  envName?: string;
  status: GroupSummaryStatus;
  generation: number;
  currentDeploymentId?: string | null;
  conditions?: Condition[];
  updatedAt?: IsoTimestamp;
  metadata?: JsonObject;
}

export interface AppSpec {
  name: string;
  version?: string;
  source: SourceSnapshot;
  services?: ServiceSpec[];
  resources?: ResourceSpec[];
  env?: Record<string, string>;
  metadata?: JsonObject;
}

export interface ServiceSpec {
  name: string;
  runtime?: string;
  command?: string[];
  image?: string;
  endpoints?: Omit<ServiceEndpoint, "id" | "serviceId">[];
  env?: Record<string, string>;
}

export interface EnvSpec {
  name: string;
  variables?: Record<string, string>;
  secrets?: Record<string, string>;
  endpoints?: ServiceEndpoint[];
  networkPolicy?: RuntimeNetworkPolicy;
}

export interface PolicySpec {
  approvals?: ApprovalRequirement[];
  grants?: ServiceGrant[];
  network?: RuntimeNetworkPolicy;
  rollout?: RolloutPolicy;
}

export interface ApprovalRequirement {
  kind: "none" | "manual" | "role";
  role?: string;
  reason?: string;
}

export interface RolloutPolicy {
  strategy: "replace" | "blue_green" | "canary";
  maxUnavailable?: number;
  steps?: Array<{ weight: number; durationSeconds?: number }>;
}

export interface ResourceSpec {
  name: string;
  type: string;
  provider?: string;
  properties?: JsonObject;
}

export interface ResourceInstance {
  id: string;
  spaceId: string;
  groupId: string;
  name: string;
  type: string;
  provider: string;
  providerResourceId?: string;
  status: "pending" | "ready" | "degraded" | "failed" | "deleted";
  properties?: JsonObject;
  conditions?: Condition[];
  createdAt?: IsoTimestamp;
  updatedAt?: IsoTimestamp;
}

export interface ProviderMaterialization {
  id: string;
  provider: string;
  packageRef: string;
  packageDigest: Digest;
  inputs: JsonObject;
  outputs?: JsonObject;
  resourceInstanceIds?: string[];
  createdAt: IsoTimestamp;
}

export interface RuntimeNetworkPolicy {
  id?: string;
  defaultIngress?: GrantEffect;
  defaultEgress?: GrantEffect;
  ingress?: NetworkRule[];
  egress?: NetworkRule[];
}

export interface NetworkRule {
  effect: GrantEffect;
  protocol?: ServiceEndpointProtocol;
  from?: NetworkPeer[];
  to?: NetworkPeer[];
  ports?: number[];
}

export interface NetworkPeer {
  kind: "service" | "group" | "space" | "cidr" | "internet";
  id?: string;
  cidr?: string;
}
