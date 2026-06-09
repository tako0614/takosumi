import type { JsonValue } from "./types.ts";

// Public Connections surface (`/api`, no version prefix). Connection creation
// is split into kind-specific subroutes; the base path is the operator/space
// listing.
export const CONNECTIONS_PATH = "/api/connections" as const;
export const CONNECTIONS_SOURCE_HTTPS_TOKEN_PATH =
  "/api/connections/source/https-token" as const;
export const CONNECTIONS_SOURCE_SSH_KEY_PATH =
  "/api/connections/source/ssh-key" as const;
export const CONNECTIONS_CLOUDFLARE_TOKEN_PATH =
  "/api/connections/cloudflare/token" as const;
export const CONNECTIONS_AWS_ASSUME_ROLE_PATH =
  "/api/connections/aws/assume-role" as const;
export const CONNECTIONS_PROVIDER_ENV_SET_PATH =
  "/api/connections/provider-env-set" as const;
export const CONNECTIONS_CLOUDFLARE_OAUTH_START_PATH =
  "/api/connections/cloudflare/oauth/start" as const;
export const CONNECTIONS_CLOUDFLARE_OAUTH_CALLBACK_PATH =
  "/api/connections/cloudflare/oauth/callback" as const;
export const CONNECTIONS_GCP_OAUTH_START_PATH =
  "/api/connections/gcp/oauth/start" as const;
export const CONNECTIONS_GCP_OAUTH_CALLBACK_PATH =
  "/api/connections/gcp/oauth/callback" as const;
export const CONNECTIONS_GCP_IMPERSONATION_PATH =
  "/api/connections/gcp/impersonation" as const;
export const CONNECTION_PATH = (id: string): string =>
  `/api/connections/${encodeURIComponent(id)}`;
export const CONNECTION_TEST_PATH = (id: string): string =>
  `/api/connections/${encodeURIComponent(id)}/test`;
export const CONNECTION_REVOKE_PATH = (id: string): string =>
  `/api/connections/${encodeURIComponent(id)}/revoke`;

export type ConnectionAuthMethod =
  | "static_secret"
  | "aws_assume_role"
  | "oauth"
  | "impersonation"
  | "api_token"
  | "kubeconfig"
  | "generic_env"
  | "manual";

export type ConnectionScopeKind = "operator" | "space";

export type ConnectionStatus =
  | "pending"
  | "verified"
  | "revoked"
  | "expired"
  | "error";

export interface ConnectionScopeHints {
  readonly accountId?: string;
  readonly zoneId?: string;
  readonly cloudflareTokenVending?: CloudflareTokenVendingConfig;
  readonly username?: string;
  readonly knownHostsEntry?: string;
  readonly awsRoleArn?: string;
  readonly awsExternalId?: string;
  readonly awsRegion?: string;
  readonly gcpServiceAccountEmail?: string;
  readonly gcpProjectId?: string;
  readonly templateId?: string;
}

export interface CloudflareTokenVendingConfig {
  readonly policies: readonly CloudflareTokenPolicy[];
  readonly ttlSeconds?: number;
  readonly namePrefix?: string;
  readonly condition?: Readonly<Record<string, JsonValue>>;
}

export interface CloudflareTokenPolicy {
  readonly id?: string;
  readonly effect: "allow" | "deny";
  readonly permission_groups: readonly CloudflarePermissionGroup[];
  readonly resources: Readonly<Record<string, JsonValue>>;
}

export interface CloudflarePermissionGroup {
  readonly id: string;
  readonly meta?: Readonly<Record<string, string>>;
  readonly name?: string;
}

export interface Connection {
  readonly id: string;
  readonly spaceId?: string;
  readonly provider: string;
  readonly kind?: ConnectionKind;
  readonly scope: ConnectionScopeKind;
  readonly authMethod: ConnectionAuthMethod;
  readonly displayName?: string;
  readonly status: ConnectionStatus;
  readonly scopeHints?: ConnectionScopeHints;
  readonly envNames: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly verifiedAt?: string;
  readonly expiresAt?: string;
}

export type ConnectionKind =
  | "source_git_https_token"
  | "source_git_ssh_key"
  | "cloudflare_oauth"
  | "cloudflare_api_token"
  | "aws_assume_role"
  | "gcp_oauth_bootstrap"
  | "gcp_service_account_impersonation"
  | "static_secret"
  | "provider_env_set"
  | "manual";

export interface CreateConnectionRequest {
  readonly spaceId?: string;
  readonly provider: string;
  readonly kind?: ConnectionKind;
  readonly authMethod: ConnectionAuthMethod;
  readonly displayName?: string;
  readonly scope?: ConnectionScopeKind;
  readonly scopeHints?: ConnectionScopeHints;
  readonly expiresAt?: string;
  readonly values: Readonly<Record<string, string>>;
}

export interface ConnectionOAuthStartRequest {
  readonly spaceId?: string;
  readonly displayName?: string;
  readonly scope?: ConnectionScopeKind;
  readonly scopeHints?: ConnectionScopeHints;
  readonly expiresAt?: string;
  readonly redirectUri?: string;
  readonly successRedirectUri?: string;
}

export interface ConnectionOAuthStartResponse {
  readonly authorizationUrl: string;
  readonly state: string;
  readonly expiresAt?: string;
}

export interface GcpImpersonationConnectionRequest {
  readonly spaceId?: string;
  readonly displayName?: string;
  readonly scope?: ConnectionScopeKind;
  readonly scopeHints: ConnectionScopeHints & {
    readonly gcpServiceAccountEmail: string;
    readonly gcpProjectId: string;
  };
  readonly expiresAt?: string;
  readonly values: Readonly<Record<string, string>>;
}

export interface ConnectionResponse {
  readonly connection: Connection;
}

export interface ListConnectionsResponse {
  readonly connections: readonly Connection[];
}

export interface TestConnectionResponse {
  readonly status: Extract<
    ConnectionStatus,
    "verified" | "pending" | "expired"
  >;
  readonly detail?: string;
}
