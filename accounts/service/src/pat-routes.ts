import {
  TAKOSUMI_ACCOUNTS_PAT_SCOPES,
  type TakosumiAccountsPatMetadata,
  type TakosumiAccountsPatScope,
} from "@takosjp/takosumi-accounts-contract";
import type { AccountsStore, PersonalAccessTokenRecord } from "./store.ts";
import { base64UrlEncodeBytes } from "./encoding.ts";
import {
  errorJson,
  json,
  readJsonObject,
  stringValue,
} from "./http-helpers.ts";
import { requireAccountSession } from "./account-session.ts";
import {
  decodePageCursor,
  paginateById,
  parsePageLimit,
} from "./installation-routes.ts";

/**
 * List the caller's personal access tokens.
 *
 * Pagination: accepts `?limit` (default 50, max 200) and `?cursor` (opaque
 * base64 cursor produced by the previous response). Cursor format:
 * `base64url(JSON({ lastId }))` where `lastId` is the token's `id`.
 * Responses include `next_cursor` (string or `null`). Sort order follows
 * the underlying store iteration; clients should not rely on a particular
 * order beyond "stable within a page chain".
 */
export async function handleListPersonalAccessTokens(input: {
  request: Request;
  url: URL;
  store: AccountsStore;
}): Promise<Response> {
  const session = await requireAccountSession(input);
  if (!session.ok) return session.response;
  const limit = parsePageLimit(input.url.searchParams.get("limit"));
  if (limit === "invalid") {
    return errorJson(
      "invalid_request",
      "limit must be a positive integer",
      400,
    );
  }
  const afterId = decodePageCursor(input.url.searchParams.get("cursor"));
  if (afterId === "invalid") {
    return errorJson("invalid_request", "cursor is malformed", 400);
  }
  const tokens = await input.store.listPersonalAccessTokensForSubject(
    session.subject,
  );
  const page = paginateById(tokens, {
    getId: (token) => token.tokenId,
    limit,
    afterId,
  });
  return json({
    tokens: page.items.map(personalAccessTokenMetadata),
    next_cursor: page.nextCursor,
  });
}

export async function handleCreatePersonalAccessToken(input: {
  request: Request;
  store: AccountsStore;
}): Promise<Response> {
  const session = await requireAccountSession(input);
  if (!session.ok) return session.response;

  const body = await readJsonObject(input.request);
  if (!body || Array.isArray(body)) {
    return errorJson("invalid_request", "invalid request", 400);
  }
  const name = stringValue(body.name)?.trim();
  const scopes = personalAccessTokenScopesValue(body.scopes);
  const workspaceId = stringValue(body.workspace_id ?? body.workspaceId)?.trim();
  const now = Date.now();
  const expiresAtResult = personalAccessTokenExpiresAtValue(
    body.expires_at ?? body.expiresAt,
    now,
  );
  if (!name || name.length > 80 || !scopes || expiresAtResult === "invalid") {
    return errorJson(
      "invalid_request",
      "name, one or more scopes, and optional future expires_at are required",
      400,
    );
  }
  if (workspaceId) {
    const ownedWorkspaces = await input.store.listWorkspacesForOwner(
      session.subject,
    );
    if (
      !ownedWorkspaces.some((workspace) => workspace.workspaceId === workspaceId)
    ) {
      return errorJson(
        "workspace_not_found",
        "workspace_id must reference a Workspace owned by the token subject",
        404,
      );
    }
  }

  const token = generatePersonalAccessToken();
  const record: PersonalAccessTokenRecord = {
    tokenId: `pat_${crypto.randomUUID().replaceAll("-", "")}`,
    tokenPrefix: personalAccessTokenPrefix(token),
    subject: session.subject,
    name,
    scopes,
    ...(workspaceId ? { workspaceId } : {}),
    createdAt: now,
    expiresAt: expiresAtResult,
  };
  await input.store.savePersonalAccessToken(token, record);
  return json(
    {
      token,
      token_record: personalAccessTokenMetadata(record),
    },
    201,
  );
}

export async function handleRevokePersonalAccessToken(input: {
  tokenId: string;
  request: Request;
  store: AccountsStore;
}): Promise<Response> {
  const session = await requireAccountSession(input);
  if (!session.ok) return session.response;
  const record = await input.store.revokePersonalAccessToken({
    subject: session.subject,
    tokenId: input.tokenId,
    revokedAt: Date.now(),
  });
  if (!record) return errorJson("token_not_found", "token not found", 404);
  return json({ token: personalAccessTokenMetadata(record) });
}

const personalAccessTokenScopes = new Set<string>(TAKOSUMI_ACCOUNTS_PAT_SCOPES);

function personalAccessTokenScopesValue(
  value: unknown,
): readonly TakosumiAccountsPatScope[] | undefined {
  if (!Array.isArray(value) || value.length < 1) return undefined;
  const output: TakosumiAccountsPatScope[] = [];
  const seen = new Set<string>();
  for (const scope of value) {
    if (
      typeof scope !== "string" ||
      !personalAccessTokenScopes.has(scope) ||
      seen.has(scope)
    ) {
      return undefined;
    }
    seen.add(scope);
    output.push(scope as TakosumiAccountsPatScope);
  }
  return output;
}

function personalAccessTokenExpiresAtValue(
  value: unknown,
  now: number,
): number | "invalid" | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") return "invalid";
  const expiresAt = Date.parse(value);
  return Number.isFinite(expiresAt) && expiresAt > now ? expiresAt : "invalid";
}

function generatePersonalAccessToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `takpat_${base64UrlEncodeBytes(bytes)}`;
}

function personalAccessTokenPrefix(token: string): string {
  return token.slice(0, "takpat_".length + 8);
}

export function personalAccessTokenIsActive(
  record: PersonalAccessTokenRecord,
  now: number,
): boolean {
  return (
    record.revokedAt === undefined &&
    (record.expiresAt === undefined || record.expiresAt > now)
  );
}

export function personalAccessTokenIntrospectionBody(
  record: PersonalAccessTokenRecord,
  issuer: string,
): Record<string, unknown> {
  return {
    active: true,
    iss: issuer,
    sub: record.subject,
    client_id: "takosumi-accounts-pat",
    token_type: "Bearer",
    scope: record.scopes.join(" "),
    ...(record.workspaceId
      ? { takosumi: { space_id: record.workspaceId } }
      : {}),
    ...(record.expiresAt === undefined
      ? {}
      : { exp: Math.floor(record.expiresAt / 1000) }),
  };
}

function personalAccessTokenMetadata(
  record: PersonalAccessTokenRecord,
): TakosumiAccountsPatMetadata {
  return {
    id: record.tokenId,
    subject: record.subject,
    name: record.name,
    prefix: record.tokenPrefix,
    scopes: record.scopes,
    ...(record.workspaceId ? { workspace_id: record.workspaceId } : {}),
    created_at: new Date(record.createdAt).toISOString(),
    ...(record.expiresAt === undefined
      ? {}
      : { expires_at: new Date(record.expiresAt).toISOString() }),
    ...(record.revokedAt === undefined
      ? {}
      : { revoked_at: new Date(record.revokedAt).toISOString() }),
    ...(record.lastUsedAt === undefined
      ? {}
      : { last_used_at: new Date(record.lastUsedAt).toISOString() }),
  };
}
