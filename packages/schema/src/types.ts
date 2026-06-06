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
