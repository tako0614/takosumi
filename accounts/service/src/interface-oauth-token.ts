import type { TakosumiSubject } from "@takosjp/takosumi-accounts-contract";
import { isValidInterfacePermissionToken } from "takosumi-contract";
import { base64UrlEncodeBytes } from "./encoding.ts";
import type { AccountsStore } from "./store.ts";

export const INTERFACE_OAUTH_ACCESS_TOKEN_MAX_TTL_SECONDS = 60;

export interface IssueInterfaceOAuthAccessTokenInput {
  readonly store: AccountsStore;
  /** Pairwise Accounts subject named by the Principal InterfaceBinding. */
  readonly subject: string;
  readonly takosumiSubject?: TakosumiSubject;
  readonly workspaceId: string;
  readonly capsuleId?: string;
  /** Resolved Interface resource URI; this is the OAuth audience. */
  readonly audience: string;
  /** One exact InterfaceBinding permission, exposed as the OAuth scope. */
  readonly permission: string;
  readonly interfaceId: string;
  readonly bindingId: string;
  readonly interfaceRevision: number;
  readonly ttlSeconds?: number;
  /** Test/host clock seam. */
  readonly now?: number;
}

export interface IssuedInterfaceOAuthAccessToken {
  readonly accessToken: string;
  readonly tokenType: "Bearer";
  readonly expiresIn: number;
  readonly expiresAt: number;
  readonly scope: string;
}

/**
 * Mints one invocation-only OAuth bearer after Interface Core has authorized an
 * exact Principal binding. The opaque token is stored hashed by AccountsStore;
 * neither this function nor its result writes the raw value to logs or ledger
 * metadata. It deliberately issues no refresh token.
 */
export async function issueInterfaceOAuthAccessToken(
  input: IssueInterfaceOAuthAccessTokenInput,
): Promise<IssuedInterfaceOAuthAccessToken> {
  const subject = requiredText(input.subject, "subject", 512);
  const workspaceId = requiredText(input.workspaceId, "workspaceId", 512);
  const capsuleId = optionalText(input.capsuleId, "capsuleId", 512);
  const audience = requiredResourceUri(input.audience);
  const permission = requiredPermission(input.permission);
  const interfaceId = requiredText(input.interfaceId, "interfaceId", 512);
  const interfaceBindingId = requiredText(input.bindingId, "bindingId", 512);
  const interfaceResolvedRevision = positiveSafeInteger(
    input.interfaceRevision,
    "interfaceRevision",
  );
  const ttlSeconds = positiveSafeInteger(
    input.ttlSeconds ?? INTERFACE_OAUTH_ACCESS_TOKEN_MAX_TTL_SECONDS,
    "ttlSeconds",
  );
  if (ttlSeconds > INTERFACE_OAUTH_ACCESS_TOKEN_MAX_TTL_SECONDS) {
    throw new RangeError(
      `ttlSeconds must be at most ${INTERFACE_OAUTH_ACCESS_TOKEN_MAX_TTL_SECONDS}`,
    );
  }
  const issuedAt = nonNegativeSafeInteger(input.now ?? Date.now(), "now");
  const expiresAt = issuedAt + ttlSeconds * 1_000;
  if (!Number.isSafeInteger(expiresAt)) {
    throw new RangeError("token expiry exceeds the safe integer range");
  }

  const accessToken = generateInterfaceOAuthAccessToken();
  await input.store.saveAccessToken(accessToken, {
    // Interface OAuth tokens are owned by their exact resource URI rather than
    // an interactive OIDC client registration.
    clientId: audience,
    audience,
    scope: permission,
    subject,
    ...(input.takosumiSubject
      ? { takosumiSubject: input.takosumiSubject }
      : {}),
    ...(capsuleId ? { capsuleId } : {}),
    workspaceId,
    role: "interface-runtime",
    interfaceId,
    interfaceBindingId,
    interfaceResolvedRevision,
    expiresAt,
  });

  return {
    accessToken,
    tokenType: "Bearer",
    expiresIn: ttlSeconds,
    expiresAt,
    scope: permission,
  };
}

function generateInterfaceOAuthAccessToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `taksrv_${base64UrlEncodeBytes(bytes)}`;
}

function requiredText(
  value: unknown,
  field: string,
  maxLength: number,
): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${field} is required`);
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new RangeError(`${field} exceeds ${maxLength} characters`);
  }
  return normalized;
}

function optionalText(
  value: unknown,
  field: string,
  maxLength: number,
): string | undefined {
  if (value === undefined) return undefined;
  return requiredText(value, field, maxLength);
}

function requiredResourceUri(value: unknown): string {
  const uri = requiredText(value, "audience", 2_048);
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    throw new TypeError("audience must be an absolute resource URI");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new TypeError(
      "audience must be a canonical credential-free HTTPS resource URI without query or fragment",
    );
  }
  return parsed.href;
}

function requiredPermission(value: unknown): string {
  const permission = requiredText(value, "permission", 256);
  if (!isValidInterfacePermissionToken(permission)) {
    throw new TypeError(
      "permission must be one RFC 6749 Interface scope token",
    );
  }
  return permission;
}

function positiveSafeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${field} must be a positive safe integer`);
  }
  return value;
}

function nonNegativeSafeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${field} must be a non-negative safe integer`);
  }
  return value;
}
