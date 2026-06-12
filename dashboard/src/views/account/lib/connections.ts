/**
 * Connections RPC for the dashboard.
 *
 * A Connection registers provider credentials (a Cloudflare API token, etc.)
 * for a Space. The deploy-control plane owns the secret blob; this client talks
 * to the same-origin, session-authed control surface (`/api/v1/connections`,
 * served in-process by control-routes via the typed operations facade). Secret
 * `values` are write-only: they are sent on create and NEVER returned — the
 * {@link Connection} type has no value fields, and the caller must clear any
 * in-memory secret right after submit.
 *
 * Same transport conventions as installations.ts (apiFetch / qs).
 */
import { apiFetch, qs } from "./http.ts";

/**
 * The session-authed control surface that owns the Connection resource. The
 * account plane no longer carries a `/v1/connections` edge — list / create /
 * test / revoke are all served here under one prefix.
 */
const CONNECTIONS_BASE = "/api/v1/connections";

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

/**
 * A guided credential-creation helper for a provider. The point is to remove
 * the "I don't know what to create" wall: we deep-link the user to the
 * provider's OWN token-creation screen (pre-filled where possible), they click
 * through on the provider's site, then paste the resulting token back. No fake
 * OAuth — this is just a guided link plus the existing paste. The token still
 * arrives via the same write-only {@link CreateConnectionInput.values} path.
 */
export interface ProviderTokenHelper {
  /** The env name the pasted credential is stored under. */
  readonly envName: string;
  /** Deep-link to the provider's own "create token" screen. */
  readonly createTokenUrl: string;
  /** Plain-language, numbered steps shown next to the deep-link button. */
  readonly steps: readonly string[];
}

export interface ProviderDescriptor {
  readonly provider: string;
  readonly label: string;
  readonly fields: readonly ProviderEnvField[];
  /**
   * Optional guided-token helper. When present, the connections screen leads
   * with "<provider> に接続" → deep-link → paste, and demotes the raw field
   * form to an advanced "詳細設定" fallback. Absent providers keep the plain
   * field form as the only path.
   */
  readonly tokenHelper?: ProviderTokenHelper;
  /**
   * Whether a real third-party OAuth helper MIGHT be available for this
   * provider (operator-gated). The screen probes the backend before showing an
   * OAuth button; this only marks which providers are worth probing.
   */
  readonly oauthCandidate?: boolean;
}

/**
 * Cloudflare "Create API Token" deep-link. Cloudflare's dashboard accepts a
 * `permissionGroupKeys` query on the custom-token screen to pre-tick permission
 * rows, so the user lands on a screen already scoped to what an OpenTofu deploy
 * needs (Workers / DNS / R2 edit) instead of a blank custom token. This opens
 * Cloudflare's OWN screen — the user creates the token there and pastes it
 * back; we never see their dashboard credentials.
 */
export const CLOUDFLARE_CREATE_TOKEN_URL =
  "https://dash.cloudflare.com/profile/api-tokens?" +
  new URLSearchParams({
    // Cloudflare reads this to pre-select permission rows on the custom-token
    // screen. Unknown keys are ignored by Cloudflare, so this degrades to a
    // plain custom-token screen if the format changes — never a broken link.
    permissionGroupKeys: JSON.stringify([
      { key: "workers_scripts", type: "edit" },
      { key: "workers_kv_storage", type: "edit" },
      { key: "workers_r2", type: "edit" },
      { key: "dns_records", type: "edit" },
      { key: "zone", type: "read" },
    ]),
    name: "Takosumi deploy",
  }).toString();

/**
 * Supported providers + their credential field sets. Cloudflare only for Phase
 * 1: CLOUDFLARE_API_TOKEN (required, secret) + CLOUDFLARE_ACCOUNT_ID (optional).
 */
export const PROVIDERS: readonly ProviderDescriptor[] = [
  {
    provider: "cloudflare",
    label: "Cloudflare",
    oauthCandidate: true,
    tokenHelper: {
      envName: "CLOUDFLARE_API_TOKEN",
      createTokenUrl: CLOUDFLARE_CREATE_TOKEN_URL,
      steps: [
        "下のボタンで Cloudflare のトークン作成画面を開きます。",
        "Cloudflare の画面で「概要に進む」→「トークンを作成」を押します（権限はあらかじめ選ばれています）。",
        "表示されたトークンをコピーして、ここに貼り付けます。",
      ],
    },
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
    CONNECTIONS_BASE + qs({ spaceId }),
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
  // The control surface forces `scope: "space"` server-side and answers with the
  // `{ connection }` envelope (the public projection — never secret values).
  const body = await apiFetch<{ connection: Connection }>(CONNECTIONS_BASE, {
    method: "POST",
    body: {
      spaceId: input.spaceId,
      provider: input.provider,
      ...(input.displayName ? { displayName: input.displayName } : {}),
      ...(input.scope ? { scopeHints: input.scope } : {}),
      values: input.values,
    },
  });
  return body.connection;
}

export async function testConnection(
  id: string,
): Promise<ConnectionTestResult> {
  return await apiFetch<ConnectionTestResult>(
    `${CONNECTIONS_BASE}/${encodeURIComponent(id)}/test`,
    { method: "POST" },
  );
}

export async function removeConnection(id: string): Promise<void> {
  await apiFetch<unknown>(
    `${CONNECTIONS_BASE}/${encodeURIComponent(id)}/revoke`,
    { method: "POST" },
  );
}
