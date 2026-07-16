export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | {
      [key: string]: JsonValue;
    };
export type JsonObject = { [key: string]: JsonValue };

export type IsoTimestamp = string;
export type Digest = string;
export type PrincipalKind = "account" | "service" | "agent" | "system";

export interface ActorContext {
  actorAccountId: string;
  workspaceId?: string;
  roles: string[];
  requestId: string;
  principalKind?: PrincipalKind;
  serviceId?: string;
  agentId?: string;
  sessionId?: string;
  scopes?: string[];
  traceId?: string;
  /**
   * Capsule scope of a run-ambient credential. This is set only after a host
   * verifies a Capsule-scoped run token and is carried inside the trusted
   * internal actor context, never a client-forgeable scope header.
   */
  capsuleId?: string;
  /**
   * Whether the Capsule run may mutate its own module-declared Interfaces.
   * Apply/destroy runs set true; plan/drift/refresh runs are read-only.
   */
  capsuleRunMutable?: boolean;
}

export interface DomainEvent<TPayload extends JsonObject = JsonObject> {
  id: string;
  type: string;
  aggregateType: string;
  aggregateId: string;
  workspaceId?: string;
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

export interface SpaceCreateRequest {
  actor: ActorContext;
  name: string;
  slug?: string;
  metadata?: JsonObject;
}

export interface SpaceUpdateRequest {
  actor: ActorContext;
  workspaceId: string;
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
  workspaceId: string;
  name: string;
  envName?: string;
  metadata?: JsonObject;
}

export interface GroupUpdateRequest {
  actor: ActorContext;
  workspaceId: string;
  groupId: string;
  name?: string;
  envName?: string;
  metadata?: JsonObject;
}

export interface GroupSummary {
  id: string;
  workspaceId: string;
  name: string;
  envName?: string;
  status: GroupSummaryStatus;
  generation: number;
  currentStateVersionId?: string | null;
  conditions?: Condition[];
  updatedAt?: IsoTimestamp;
  metadata?: JsonObject;
}
