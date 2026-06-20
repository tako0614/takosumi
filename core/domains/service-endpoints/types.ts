import type { SpaceId } from "../../shared/ids.ts";

export type { SpaceId };
export type ServiceEndpointId = string;
export type ServiceId = string;
export type ServiceTrustRecordId = string;
export type EndpointServiceGrantId = string;
export type GroupId = string;
export type IsoTimestamp = string;

export type ServiceEndpointProtocol = "http" | "https" | "tcp" | "udp";
export type ServiceEndpointHealthStatus =
  | "unknown"
  | "healthy"
  | "degraded"
  | "unhealthy";
export type ServiceTrustLevel =
  | "platform"
  | "space"
  | "group"
  | "public"
  | "external";
export type ServiceTrustStatus = "active" | "revoked";
export type EndpointServiceGrantEffect = "allow" | "deny";

export interface ServiceEndpointHealth {
  readonly status: ServiceEndpointHealthStatus;
  readonly checkedAt: IsoTimestamp;
  readonly message?: string;
}

export interface ServiceEndpoint {
  readonly id: ServiceEndpointId;
  readonly serviceId: ServiceId;
  readonly spaceId: SpaceId;
  readonly groupId: GroupId;
  readonly name: string;
  readonly protocol: ServiceEndpointProtocol;
  readonly url?: string;
  readonly host?: string;
  readonly port?: number;
  readonly pathPrefix?: string;
  readonly health: ServiceEndpointHealth;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

export interface ServiceTrustRecord {
  readonly id: ServiceTrustRecordId;
  readonly endpointId: ServiceEndpointId;
  readonly serviceId: ServiceId;
  readonly spaceId: SpaceId;
  readonly groupId: GroupId;
  readonly level: ServiceTrustLevel;
  readonly audience: readonly string[];
  readonly issuer?: string;
  readonly status: ServiceTrustStatus;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
  readonly expiresAt?: IsoTimestamp;
  readonly revokedAt?: IsoTimestamp;
  readonly revokedBy?: string;
  readonly revokeReason?: string;
}

export interface EndpointServiceGrantCondition {
  readonly key: string;
  readonly operator: "equals" | "in" | "prefix";
  readonly value: string | readonly string[];
}

export interface EndpointServiceGrant {
  readonly id: EndpointServiceGrantId;
  readonly trustRecordId: ServiceTrustRecordId;
  readonly endpointId: ServiceEndpointId;
  readonly subject: string;
  readonly action: string;
  readonly resource: string;
  readonly effect: EndpointServiceGrantEffect;
  readonly conditions: readonly EndpointServiceGrantCondition[];
  readonly createdAt: IsoTimestamp;
  readonly expiresAt?: IsoTimestamp;
}
