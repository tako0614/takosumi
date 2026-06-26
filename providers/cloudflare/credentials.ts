/**
 * Cloudflare credential driver (token-vending mint + verify).
 *
 * This is the provider-specific credential implementation the provider runtime
 * registry (`@takosumi/providers`) refers to. It is a self-contained,
 * dependency-light extraction of the Cloudflare logic that lives inline in the
 * in-process vault (`core/adapters/vault/mod.ts`): the API token-vending
 * mint (`POST /user/tokens`) and the token verify (`GET /user/tokens/verify`).
 *
 * Boundary: this driver NEVER opens sealed secret blobs and NEVER touches the
 * secret-boundary crypto. The vault opens the connection's sealed values (the
 * bootstrap CF API token + any static env) and hands the already-decrypted
 * values to this driver; the driver only mints a short-lived scoped token from
 * Cloudflare and returns the resulting env map / verify result. Crypto and
 * secret-opening stay in core.
 *
 * The logic here is byte-identical to the inline vault behavior so this can be
 * delegated to without a behavior change.
 */
import type {
  CloudflareTokenVendingConfig,
  Connection,
} from "takosumi-contract/connections";
import type { ProviderCredentialMintEvidence } from "takosumi-contract/security";

/** Cloudflare API origin for the token endpoints. */
const CLOUDFLARE_API_TOKENS_URL =
  "https://api.cloudflare.com/client/v4/user/tokens";
const CLOUDFLARE_API_TOKEN_VERIFY_URL =
  "https://api.cloudflare.com/client/v4/user/tokens/verify";
const CLOUDFLARE_ACCOUNTS_URL =
  "https://api.cloudflare.com/client/v4/accounts";

/**
 * Injected fetch seam so the driver is unit-testable without real network.
 * Mirrors the vault's `VaultFetch` shape.
 */
export type CloudflareFetch = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

/**
 * A typed driver error. The vault re-wraps this into its own
 * `ConnectionVaultError("failed_precondition", …)` when delegating, so the
 * `message` text is the load-bearing contract and is kept byte-identical.
 */
export class CloudflareCredentialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CloudflareCredentialError";
  }
}

/** A minted short-lived Cloudflare API token (token-vending result). */
export interface MintedCloudflareToken {
  readonly token: string;
  readonly expiresAt: string;
  readonly ttlSeconds: number;
}

/** Token-vending mint input. The vault supplies the already-opened values. */
export interface MintCloudflareApiTokenInput {
  /** The connection row (for id, scopeHints.cloudflareTokenVending). */
  readonly connection: Connection;
  /**
   * The decrypted bootstrap CF API token (from
   * `values.CLOUDFLARE_API_TOKEN ?? values.CF_API_TOKEN`), opened by the vault.
   */
  readonly bootstrapToken: string;
  /** Injected fetch + clock so the driver stays unit-testable. */
  readonly fetch: CloudflareFetch;
  readonly now: () => Date;
}

/** Verify input. The vault supplies the already-opened token. */
export interface VerifyCloudflareTokenInput {
  /** The decrypted CF API token to verify. */
  readonly token: string;
  /** Optional account id used to verify Wrangler OAuth bearer access. */
  readonly accountId?: string;
  readonly fetch: CloudflareFetch;
}

export interface CloudflareVerifyResult {
  readonly ok: boolean;
  readonly detail?: string;
}

/** Output of {@link mintCloudflareProviderValues}: env map + mint evidence. */
export interface CloudflareMintedProviderValues {
  readonly values: Readonly<Record<string, string>>;
  readonly evidence: ProviderCredentialMintEvidence;
}

/**
 * Whether this connection is a Cloudflare token-vending mint (vs. a plain
 * static-secret Cloudflare token connection). Token-vending requires the
 * `scopeHints.cloudflareTokenVending` config. The vault gates on this to decide
 * whether to delegate the mint to this driver.
 */
export function isCloudflareTokenVending(connection: Connection): boolean {
  return Boolean(connection.scopeHints?.cloudflareTokenVending);
}

/**
 * Mints a Cloudflare provider env map for a token-vending connection. Given the
 * already-opened static values and the bootstrap token, mints a short-lived
 * scoped token and returns the values with `CLOUDFLARE_API_TOKEN` replaced by
 * the minted token, plus the mint evidence.
 *
 * `delivery` is threaded from the vault (`provider_env` for the legacy
 * provider-mint path, `generated_root_variable` for the per-alias path) so the
 * evidence's `rootOnly` flag is preserved byte-identically.
 */
export async function mintCloudflareProviderValues(input: {
  readonly connection: Connection;
  /** The already-opened static env values for the connection. */
  readonly values: Readonly<Record<string, string>>;
  readonly delivery: ProviderCredentialMintEvidence["delivery"];
  readonly fetch: CloudflareFetch;
  readonly now: () => Date;
}): Promise<CloudflareMintedProviderValues> {
  const { connection, values, delivery } = input;
  const bootstrapToken =
    values.CLOUDFLARE_API_TOKEN ?? values.CF_API_TOKEN ?? "";
  if (!bootstrapToken) {
    throw new CloudflareCredentialError(
      `cloudflare token-vending connection ${connection.id} requires CLOUDFLARE_API_TOKEN or CF_API_TOKEN as the bootstrap credential`,
    );
  }
  const minted = await mintCloudflareApiToken({
    connection,
    bootstrapToken,
    fetch: input.fetch,
    now: input.now,
  });
  return {
    values: {
      ...values,
      CLOUDFLARE_API_TOKEN: minted.token,
    },
    evidence: {
      providerEnvId: connection.id,
      connectionId: connection.id,
      provider: connection.provider,
      delivery,
      rootOnly: delivery === "generated_root_variable",
      temporary: true,
      ttlEnforced: true,
      expiresAt: minted.expiresAt,
      ttlSeconds: minted.ttlSeconds,
      issuer: "cloudflare_api_token_vending",
    },
  };
}

/**
 * Mints a short-lived scoped Cloudflare API token via `POST /user/tokens`,
 * authenticated with the bootstrap token. Byte-identical to the inline vault
 * `#mintCloudflareApiToken`.
 */
export async function mintCloudflareApiToken(
  input: MintCloudflareApiTokenInput,
): Promise<MintedCloudflareToken> {
  const { connection, bootstrapToken } = input;
  const vending = connection.scopeHints?.cloudflareTokenVending;
  if (!vending || !Array.isArray(vending.policies)) {
    throw new CloudflareCredentialError(
      `cloudflare token-vending connection ${connection.id} requires scopeHints.cloudflareTokenVending.policies`,
    );
  }
  const now = input.now();
  const ttlSeconds = cloudflareTokenTtlSeconds(vending.ttlSeconds);
  const expiresAt = new Date(now.getTime() + ttlSeconds * 1000).toISOString();
  const body = {
    name: cloudflareTokenName(connection, now, vending.namePrefix),
    policies: vending.policies,
    expires_on: expiresAt,
    ...(vending.condition ? { condition: vending.condition } : {}),
  };
  let response: Response;
  try {
    response = await input.fetch(CLOUDFLARE_API_TOKENS_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${bootstrapToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch (error) {
    throw new CloudflareCredentialError(
      `cloudflare api token create request failed: ${errorMessage(error)}`,
    );
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new CloudflareCredentialError(
      `cloudflare api token create returned http ${response.status} with non-JSON body`,
    );
  }
  if (!response.ok || !isRecord(payload) || payload.success !== true) {
    throw new CloudflareCredentialError(
      `cloudflare api token create returned http ${response.status}: ${cloudflareApiErrorCode(payload)}`,
    );
  }
  const result = isRecord(payload.result) ? payload.result : undefined;
  const token = typeof result?.value === "string" ? result.value : undefined;
  const returnedExpiresAt =
    typeof result?.expires_on === "string" ? result.expires_on : undefined;
  if (!token) {
    throw new CloudflareCredentialError(
      "cloudflare api token create response did not include a token value",
    );
  }
  if (!returnedExpiresAt) {
    throw new CloudflareCredentialError(
      "cloudflare api token create response did not include expires_on",
    );
  }
  const returnedExpiresAtMs = Date.parse(returnedExpiresAt);
  if (
    !Number.isFinite(returnedExpiresAtMs) ||
    returnedExpiresAtMs <= now.getTime()
  ) {
    throw new CloudflareCredentialError(
      "cloudflare api token create response included an invalid expires_on",
    );
  }
  return {
    token,
    expiresAt: new Date(returnedExpiresAtMs).toISOString(),
    ttlSeconds: Math.floor((returnedExpiresAtMs - now.getTime()) / 1000),
  };
}

/**
 * Verifies a Cloudflare API token via `GET /user/tokens/verify`. Byte-identical
 * to the inline vault `#verifyCloudflareToken`.
 */
export async function verifyCloudflareToken(
  input: VerifyCloudflareTokenInput,
): Promise<CloudflareVerifyResult> {
  let response: Response;
  try {
    response = await input.fetch(CLOUDFLARE_API_TOKEN_VERIFY_URL, {
      method: "GET",
      headers: {
        authorization: `Bearer ${input.token}`,
        "content-type": "application/json",
      },
    });
  } catch (error) {
    return {
      ok: false,
      detail: `token verify request failed: ${errorMessage(error)}`,
    };
  }
  if (!response.ok) {
    const accountId = input.accountId;
    if (accountId) {
      const accountProbe = await verifyCloudflareAccountAccess({
        token: input.token,
        accountId,
        fetch: input.fetch,
      });
      if (accountProbe.ok) return { ok: true };
      return {
        ok: false,
        detail: `token verify returned http ${response.status}; ${accountProbe.detail}`,
      };
    }
    return {
      ok: false,
      detail: `token verify returned http ${response.status}`,
    };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false, detail: "token verify returned non-JSON body" };
  }
  if (isCloudflareVerifyOk(body)) return { ok: true };
  return {
    ok: false,
    detail: "token verify reported the token is not active",
  };
}

async function verifyCloudflareAccountAccess(
  input: VerifyCloudflareTokenInput & { readonly accountId: string },
): Promise<CloudflareVerifyResult> {
  let response: Response;
  try {
    response = await input.fetch(
      `${CLOUDFLARE_ACCOUNTS_URL}/${encodeURIComponent(input.accountId)}`,
      {
        method: "GET",
        headers: {
          authorization: `Bearer ${input.token}`,
          "content-type": "application/json",
        },
      },
    );
  } catch (error) {
    return {
      ok: false,
      detail: `cloudflare account probe failed: ${errorMessage(error)}`,
    };
  }
  if (!response.ok) {
    return {
      ok: false,
      detail: `cloudflare account probe returned http ${response.status}`,
    };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return {
      ok: false,
      detail: "cloudflare account probe returned non-JSON body",
    };
  }
  if (isCloudflareApiSuccess(body)) return { ok: true };
  return {
    ok: false,
    detail: "cloudflare account probe did not confirm account access",
  };
}

// --- internal helpers (byte-identical copies of the inline vault helpers) ---

function cloudflareTokenTtlSeconds(value: unknown): number {
  if (value === undefined) return 3600;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 60 ||
    value > 86400
  ) {
    throw new CloudflareCredentialError(
      "scopeHints.cloudflareTokenVending.ttlSeconds must be an integer between 60 and 86400",
    );
  }
  return value;
}

function cloudflareTokenName(
  connection: Connection,
  now: Date,
  prefix?: string,
): string {
  const safePrefix =
    prefix && prefix.trim().length > 0
      ? prefix
          .trim()
          .replace(/[^A-Za-z0-9_.:-]+/g, "-")
          .slice(0, 80)
      : "takosumi-run";
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  return `${safePrefix}-${connection.id}-${stamp}`.slice(0, 120);
}

function cloudflareApiErrorCode(payload: unknown): string {
  if (!isRecord(payload)) return "unknown_error";
  const errors = payload.errors;
  if (!Array.isArray(errors) || errors.length === 0) return "unknown_error";
  const first = errors[0];
  if (!isRecord(first)) return "unknown_error";
  const code = typeof first.code === "number" ? String(first.code) : undefined;
  const message = typeof first.message === "string" ? first.message : undefined;
  return [code, message].filter(Boolean).join(": ") || "unknown_error";
}

function isCloudflareVerifyOk(body: unknown): boolean {
  if (body === null || typeof body !== "object") return false;
  const record = body as { success?: unknown; result?: unknown };
  if (record.success !== true) return false;
  const result = record.result;
  if (result === null || typeof result !== "object") return false;
  return (result as { status?: unknown }).status === "active";
}

function isCloudflareApiSuccess(body: unknown): boolean {
  return isRecord(body) && body.success === true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Re-export the contract config type so the driver's surface is self-describing
// for importers reaching it by `@takosumi/providers/cloudflare/credentials`.
export type { CloudflareTokenVendingConfig };
