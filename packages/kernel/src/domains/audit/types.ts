import type { ActorContext, JsonObject } from "takosumi-contract";
import type { IsoTimestamp } from "../../shared/time.ts";

export type AuditEventId = string;
export type AuditEventClass = "security" | "compliance" | "irreversible-action";
export type AuditSeverity = "info" | "warning" | "critical";

export interface AuditEvent {
  readonly id: AuditEventId;
  readonly eventClass: AuditEventClass;
  readonly type: string;
  readonly severity: AuditSeverity;
  readonly actor?: ActorContext;
  readonly spaceId?: string;
  readonly groupId?: string;
  readonly targetType: string;
  readonly targetId?: string;
  readonly payload: JsonObject;
  readonly occurredAt: IsoTimestamp;
  readonly requestId?: string;
  readonly correlationId?: string;
}

export interface AuditEventQuery {
  readonly spaceId?: string;
  readonly groupId?: string;
  readonly targetType?: string;
  readonly targetId?: string;
  readonly type?: string;
  readonly since?: IsoTimestamp;
  readonly until?: IsoTimestamp;
}
