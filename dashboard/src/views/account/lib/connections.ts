/**
 * Connections RPC for the account plane.
 *
 * A Connection registers provider credentials (a Cloudflare API token, etc.)
 * for a Space. The deploy-control plane owns the secret blob; this client only
 * talks to the same-origin account-plane proxy (`/v1/connections`, session
 * cookie auth). Secret `values` are write-only: they are sent on create and
 * NEVER returned — the {@link Connection} type has no value fields, and the
 * caller must clear any in-memory secret right after submit.
 *
 * Same transport + path conventions as installations.ts (apiFetch / paths).
 */
import { apiFetch, qs } from "./http.ts";
import * as paths from "./paths.ts";

export type ConnectionAuthMethod = "static_secret";
export type ConnectionOwner = "service" | "customer";
export type ConnectionStatus =
  | "pending"
  | "verified"
  | "revoked"
  | "expired"
  | "error";

export interface ConnectionScope {
  readonly accountId?: string;
  readonly zoneId?: string;
}

/**
 * Public Connection projection — mirrors the deploy-control public type. NO
 * secret values are ever present (the proxy forwards the upstream response
 * verbatim and the upstream never echoes `values`).
 */
export interface Connection {
  readonly id: string;
  readonly spaceId: string;
  readonly provider: string;
  readonly owner: ConnectionOwner;
  readonly authMethod: ConnectionAuthMethod;
  readonly displayName?: string;
  readonly status: ConnectionStatus;
  readonly scope?: ConnectionScope;
  readonly envNames: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly verifiedAt?: string;
  readonly expiresAt?: string;
}

export interface ConnectionTestResult {
  readonly status: "verified" | "pending" | "expired";
  readonly detail?: string;
}

/**
 * One env-name field a provider exposes in the register form. `secret: true`
 * fields render as `type=password`. The cloudflare field set is hardcoded here
 * for Phase 1 (the only supported provider); later providers extend the map.
 */
export interface ProviderEnvField {
  readonly envName: string;
  readonly label: string;
  readonly required: boolean;
  readonly secret: boolean;
  readonly placeholder?: string;
}

export interface ProviderDescriptor {
  readonly provider: string;
  readonly label: string;
  readonly fields: readonly ProviderEnvField[];
}

/**
 * Supported providers + their credential field sets. Cloudflare only for Phase
 * 1: CLOUDFLARE_API_TOKEN (required, secret) + CLOUDFLARE_ACCOUNT_ID (optional).
 */
export const PROVIDERS: readonly ProviderDescriptor[] = [
  {
    provider: "cloudflare",
    label: "Cloudflare",
    fields: [
      {
        envName: "CLOUDFLARE_API_TOKEN",
        label: "API トークン",
        required: true,
        secret: true,
        placeholder: "cloudflare API token",
      },
      {
        envName: "CLOUDFLARE_ACCOUNT_ID",
        label: "アカウント ID（任意）",
        required: false,
        secret: false,
        placeholder: "0123abcd...",
      },
    ],
  },
];

export function providerDescriptor(
  provider: string,
): ProviderDescriptor | undefined {
  return PROVIDERS.find((p) => p.provider === provider);
}

interface ListResponse {
  readonly connections?: readonly Connection[];
}

export async function listConnections(
  spaceId: string,
): Promise<readonly Connection[]> {
  const body = await apiFetch<ListResponse>(
    paths.CONNECTIONS + qs({ spaceId }),
  );
  return body.connections ?? [];
}

export interface CreateConnectionInput {
  readonly spaceId: string;
  readonly provider: string;
  readonly displayName?: string;
  readonly scope?: ConnectionScope;
  /** Write-only credential material, keyed by env name. Cleared after submit. */
  readonly values: Readonly<Record<string, string>>;
}

export async function createConnection(
  input: CreateConnectionInput,
): Promise<Connection> {
  return await apiFetch<Connection>(paths.CONNECTIONS, {
    method: "POST",
    body: {
      spaceId: input.spaceId,
      provider: input.provider,
      authMethod: "static_secret",
      ...(input.displayName ? { displayName: input.displayName } : {}),
      ...(input.scope ? { scope: input.scope } : {}),
      values: input.values,
    },
  });
}

export async function testConnection(
  id: string,
): Promise<ConnectionTestResult> {
  return await apiFetch<ConnectionTestResult>(paths.connectionTest(id), {
    method: "POST",
  });
}

export async function removeConnection(id: string): Promise<void> {
  await apiFetch<unknown>(paths.connection(id), { method: "DELETE" });
}
