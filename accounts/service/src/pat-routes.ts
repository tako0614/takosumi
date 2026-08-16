import {
  TAKOSUMI_ACCOUNTS_CURRENT_PAT_AUTHORITY_KIND,
  TAKOSUMI_ACCOUNTS_PAT_INVENTORY_KIND,
  TAKOSUMI_ACCOUNTS_PAT_SCOPE_CATALOG_KIND,
  TAKOSUMI_ACCOUNTS_PAT_SCOPES,
  TAKOSUMI_ACCOUNTS_EXTENSION_SELF_SERVICE_PAT_SCOPES,
  TAKOSUMI_ACCOUNTS_SELF_SERVICE_PAT_SCOPES,
  type TakosumiAccountsCurrentPatAuthorityResponse,
  type TakosumiAccountsPatInventoryResponse,
  type TakosumiAccountsPatInventoryToken,
  type TakosumiAccountsPatMetadata,
  type TakosumiAccountsPatScope,
  type TakosumiAccountsPatScopeCatalogEntry,
  type TakosumiAccountsPatScopeCatalogResponse,
  type TakosumiAccountsWorkspaceRole,
  type TakosumiSubject,
} from "@takosjp/takosumi-accounts-contract";
import type {
  AccountsBearerCredentialCandidates,
  AccountsStore,
  PersonalAccessTokenInventoryCursor,
  PersonalAccessTokenRecord,
} from "./store.ts";
import {
  base64UrlEncodeBytes,
  base64UrlEncodeJson,
} from "./encoding.ts";
import {
  bearerChallenge,
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
} from "./pagination.ts";
import type { ControlPlaneOperations } from "./control-operations.ts";

export interface PatWorkspaceMembership {
  readonly workspaceId: string;
  readonly accountId: string;
  readonly roles: readonly string[];
  readonly status: string;
}

/** Exact, read-only membership authority used only by the PAT self view. */
export interface PatWorkspaceMembershipReader {
  getMember(
    workspaceId: string,
    subject: TakosumiSubject,
  ): Promise<PatWorkspaceMembership | undefined>;
}

const PAT_INVENTORY_DEFAULT_LIMIT = 50;
const PAT_INVENTORY_MAX_LIMIT = 100;
const PAT_INVENTORY_CURSOR_KIND =
  "takosumi.account-pat-inventory-cursor@v1" as const;

/**
 * Return the effective account-session-grantable PAT scope set. Core
 * read/write scopes are always present; extension scopes are accepted only
 * after the composition root has validated their explicit metadata.
 */
export function personalAccessTokenSelfServiceScopes(
  extensionScopes: readonly TakosumiAccountsPatScope[] = [],
): readonly TakosumiAccountsPatScope[] {
  assertExtensionSelfServicePatScopes(extensionScopes);
  const requested = new Set<string>([
    ...TAKOSUMI_ACCOUNTS_SELF_SERVICE_PAT_SCOPES,
    ...extensionScopes,
  ]);
  return TAKOSUMI_ACCOUNTS_PAT_SCOPES.filter((scope) => requested.has(scope));
}

function assertExtensionSelfServicePatScopes(
  scopes: readonly TakosumiAccountsPatScope[],
): void {
  const allowed = TAKOSUMI_ACCOUNTS_EXTENSION_SELF_SERVICE_PAT_SCOPES as readonly string[];
  for (const scope of scopes) {
    if (!allowed.includes(scope)) {
      throw new TypeError(
        `unsupported self-service PAT scope ${String(scope)}`,
      );
    }
  }
}

const PERSONAL_ACCESS_TOKEN_SCOPE_CATALOG_METADATA: Readonly<
  Record<
    TakosumiAccountsPatScope,
    Omit<TakosumiAccountsPatScopeCatalogEntry, "scope" | "selfService">
  >
> = {
  read: {
    label: { ja: "読み取り", en: "Read" },
    description: {
      ja: "読み取り専用の既存アカウント API にアクセスします。",
      en: "Read-only access to legacy account APIs.",
    },
    workspaceBinding: "optional",
  },
  write: {
    label: { ja: "書き込み", en: "Write" },
    description: {
      ja: "既存アカウント API の読み取りと書き込みにアクセスします。",
      en: "Read and write access to legacy account APIs.",
    },
    workspaceBinding: "optional",
  },
  admin: {
    label: { ja: "管理者", en: "Administrator" },
    description: {
      ja: "オペレーター発行の管理者権限です。セルフサービスでは付与できません。",
      en: "Operator-issued administrator authority; unavailable to self-service PATs.",
    },
    workspaceBinding: "optional",
  },
  "resources:read": {
    label: { ja: "ホストリソースの読み取り", en: "Hosted resource read" },
    description: {
      ja: "指定した Workspace のホストリソース一覧を読み取ります。",
      en: "Read hosted-resource inventory for one bound Workspace.",
    },
    workspaceBinding: "required",
  },
  "ai.models.read": {
    label: { ja: "AIモデルの読み取り", en: "AI model read" },
    description: {
      ja: "指定した Workspace で利用できる AI モデルを読み取ります。",
      en: "Read AI models available to one bound Workspace.",
    },
    workspaceBinding: "required",
  },
  "ai.chat": {
    label: { ja: "AIチャット", en: "AI chat" },
    description: {
      ja: "指定した Workspace の課金枠で AI チャットを実行します。",
      en: "Run AI chat against the billing authority of one bound Workspace.",
    },
    workspaceBinding: "required",
  },
  "ai.embeddings": {
    label: { ja: "AI埋め込み", en: "AI embeddings" },
    description: {
      ja: "指定した Workspace の課金枠で AI 埋め込みを生成します。",
      en: "Generate AI embeddings against the billing authority of one bound Workspace.",
    },
    workspaceBinding: "required",
  },
};

export function personalAccessTokenScopeCatalog(
  extensionScopes: readonly TakosumiAccountsPatScope[] = [],
): readonly TakosumiAccountsPatScopeCatalogEntry[] {
  const selfService = new Set(
    personalAccessTokenSelfServiceScopes(extensionScopes),
  );
  return TAKOSUMI_ACCOUNTS_PAT_SCOPES.map((scope) => ({
    scope,
    ...PERSONAL_ACCESS_TOKEN_SCOPE_CATALOG_METADATA[scope],
    selfService: selfService.has(scope),
  }));
}

export async function handlePersonalAccessTokenScopeCatalog(input: {
  readonly request: Request;
  readonly store: AccountsStore;
  readonly extensionScopes?: readonly TakosumiAccountsPatScope[];
}): Promise<Response> {
  const session = await requireAccountSession(input);
  if (!session.ok) return session.response;
  const body: TakosumiAccountsPatScopeCatalogResponse = {
    kind: TAKOSUMI_ACCOUNTS_PAT_SCOPE_CATALOG_KIND,
    scopes: personalAccessTokenScopeCatalog(input.extensionScopes),
  };
  return json(body);
}

export async function handlePersonalAccessTokenInventory(input: {
  readonly request: Request;
  readonly url: URL;
  readonly store: AccountsStore;
}): Promise<Response> {
  const session = await requireAccountSession(input);
  if (!session.ok) return session.response;
  if (!personalAccessTokenInventoryQueryIsWellFormed(input.url.searchParams)) {
    return errorJson("invalid_request", "query is malformed", 400);
  }
  const limit = personalAccessTokenInventoryLimit(
    input.url.searchParams.get("limit"),
  );
  const cursor = decodePersonalAccessTokenInventoryCursor(
    input.url.searchParams.get("cursor"),
  );
  if (limit === "invalid" || cursor === "invalid") {
    return errorJson(
      "invalid_request",
      limit === "invalid" ? "limit is invalid" : "cursor is malformed",
      400,
    );
  }

  let page;
  try {
    page = await input.store.listPersonalAccessTokenInventoryPage({
      subject: session.subject,
      limit,
      ...(cursor ? { cursor } : {}),
    });
  } catch {
    return errorJson(
      "inventory_unavailable",
      "Personal access token inventory is unavailable.",
      503,
      input.request,
    );
  }
  if (
    !isPlainObject(page) ||
    typeof page.cursorValid !== "boolean" ||
    !Array.isArray(page.items)
  ) {
    return errorJson(
      "inventory_unavailable",
      "Personal access token inventory is unavailable.",
      503,
      input.request,
    );
  }
  if (!page.cursorValid) {
    if (!cursor) {
      return errorJson(
        "inventory_unavailable",
        "Personal access token inventory is unavailable.",
        503,
        input.request,
      );
    }
    return errorJson("invalid_request", "cursor is stale", 400);
  }
  if (!personalAccessTokenInventoryPageIsWellFormed(page, session.subject, limit, cursor)) {
    return errorJson(
      "inventory_unavailable",
      "Personal access token inventory is unavailable.",
      503,
      input.request,
    );
  }

  const truncated = page.items.length > limit;
  const records = page.items.slice(0, limit);
  const last = records.at(-1);
  const body: TakosumiAccountsPatInventoryResponse = {
    kind: TAKOSUMI_ACCOUNTS_PAT_INVENTORY_KIND,
    tokens: records.map(personalAccessTokenInventoryMetadata),
    total: page.total,
    returned: records.length,
    limit,
    truncated,
    next_cursor:
      truncated && last
        ? encodePersonalAccessTokenInventoryCursor({
            createdAt: last.createdAt,
            tokenId: last.tokenId,
          })
        : null,
  };
  return json(body);
}

function personalAccessTokenInventoryQueryIsWellFormed(
  searchParams: URLSearchParams,
): boolean {
  const allowed = new Set(["limit", "cursor"]);
  for (const key of searchParams.keys()) {
    if (!allowed.has(key) || searchParams.getAll(key).length !== 1) return false;
  }
  return true;
}

function personalAccessTokenInventoryLimit(
  value: string | null,
): number | "invalid" {
  if (value === null) return PAT_INVENTORY_DEFAULT_LIMIT;
  if (!/^[1-9][0-9]*$/u.test(value)) return "invalid";
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed <= PAT_INVENTORY_MAX_LIMIT
    ? parsed
    : "invalid";
}

function encodePersonalAccessTokenInventoryCursor(
  cursor: PersonalAccessTokenInventoryCursor,
): string {
  return base64UrlEncodeJson({
    kind: PAT_INVENTORY_CURSOR_KIND,
    createdAt: cursor.createdAt,
    tokenId: cursor.tokenId,
  });
}

function decodePersonalAccessTokenInventoryCursor(
  value: string | null,
): PersonalAccessTokenInventoryCursor | "invalid" | undefined {
  if (value === null) return undefined;
  if (
    value.length === 0 ||
    value.length > 512 ||
    !/^[A-Za-z0-9_-]+$/u.test(value)
  ) {
    return "invalid";
  }
  let normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  while (normalized.length % 4 !== 0) normalized += "=";
  try {
    const binary = atob(normalized);
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(
      Uint8Array.from(binary, (character) => character.charCodeAt(0)),
    );
    const parsed: unknown = JSON.parse(decoded);
    if (
      !isPlainObject(parsed) ||
      Object.keys(parsed).length !== 3 ||
      parsed.kind !== PAT_INVENTORY_CURSOR_KIND ||
      !Number.isSafeInteger(parsed.createdAt) ||
      (parsed.createdAt as number) < 0 ||
      typeof parsed.tokenId !== "string" ||
      parsed.tokenId.length === 0 ||
      parsed.tokenId.length > 256
    ) {
      return "invalid";
    }
    const cursor = {
      createdAt: parsed.createdAt as number,
      tokenId: parsed.tokenId,
    };
    return encodePersonalAccessTokenInventoryCursor(cursor) === value
      ? cursor
      : "invalid";
  } catch {
    return "invalid";
  }
}

function personalAccessTokenInventoryPageIsWellFormed(
  page: Record<string, unknown> & {
    readonly items: readonly unknown[];
    readonly cursorValid: boolean;
  },
  subject: TakosumiSubject,
  limit: number,
  cursor: PersonalAccessTokenInventoryCursor | undefined,
): page is Record<string, unknown> & {
  readonly items: readonly PersonalAccessTokenRecord[];
  readonly total: number;
  readonly cursorValid: true;
} {
  if (
    !Number.isSafeInteger(page.total) ||
    (page.total as number) < 0 ||
    page.items.length > limit + 1 ||
    page.items.length > (page.total as number)
  ) {
    return false;
  }
  let previous = cursor;
  for (const record of page.items) {
    if (
      !personalAccessTokenInventoryRecordIsWellFormed(record, subject) ||
      (previous &&
        (record.createdAt < previous.createdAt ||
          (record.createdAt === previous.createdAt &&
            record.tokenId <= previous.tokenId)))
    ) {
      return false;
    }
    previous = { createdAt: record.createdAt, tokenId: record.tokenId };
  }
  return true;
}

function personalAccessTokenInventoryRecordIsWellFormed(
  record: unknown,
  subject: TakosumiSubject,
): record is PersonalAccessTokenRecord {
  return (
    isPlainObject(record) &&
    record.subject === subject &&
    typeof record.tokenId === "string" &&
    record.tokenId.length > 0 &&
    record.tokenId.length <= 256 &&
    typeof record.tokenPrefix === "string" &&
    record.tokenPrefix.length > 0 &&
    typeof record.name === "string" &&
    record.name.length > 0 &&
    Array.isArray(record.scopes) &&
    canonicalPersonalAccessTokenScopes(record.scopes).length > 0 &&
    (record.workspaceId === undefined ||
      (typeof record.workspaceId === "string" &&
        record.workspaceId.length > 0 &&
        record.workspaceId.length <= 256)) &&
    timestampIsValid(record.createdAt) &&
    optionalTimestampIsValid(record.expiresAt) &&
    optionalTimestampIsValid(record.revokedAt) &&
    optionalTimestampIsValid(record.lastUsedAt)
  );
}

function timestampIsValid(value: unknown): value is number {
  return (
    Number.isSafeInteger(value) &&
    (value as number) >= 0 &&
    Number.isFinite(new Date(value as number).getTime())
  );
}

function optionalTimestampIsValid(value: unknown): boolean {
  return value === undefined || timestampIsValid(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function personalAccessTokenInventoryMetadata(
  record: PersonalAccessTokenRecord,
): TakosumiAccountsPatInventoryToken {
  return {
    token_id: record.tokenId,
    subject: record.subject,
    name: record.name,
    prefix: record.tokenPrefix,
    scopes: canonicalPersonalAccessTokenScopes(record.scopes),
    workspace_id: record.workspaceId ?? null,
    created_at: new Date(record.createdAt).toISOString(),
    expires_at:
      record.expiresAt === undefined
        ? null
        : new Date(record.expiresAt).toISOString(),
    revoked_at:
      record.revokedAt === undefined
        ? null
        : new Date(record.revokedAt).toISOString(),
    last_used_at:
      record.lastUsedAt === undefined
        ? null
        : new Date(record.lastUsedAt).toISOString(),
  };
}

export async function handleCurrentPersonalAccessTokenAuthority(input: {
  readonly request: Request;
  readonly store: AccountsStore;
  readonly membershipReader?: PatWorkspaceMembershipReader;
}): Promise<Response> {
  const token = currentPatBearerToken(
    input.request.headers.get("authorization"),
  );
  if (!token) return bearerChallenge("invalid_token");

  let candidates: AccountsBearerCredentialCandidates;
  try {
    candidates = await resolvePatAuthorityCandidates(input.store, token);
  } catch {
    return bearerChallenge("invalid_token");
  }
  if (
    candidates === null ||
    typeof candidates !== "object" ||
    Array.isArray(candidates)
  ) {
    return bearerChallenge("invalid_token");
  }
  const candidateCount =
    Number(candidates.session !== undefined) +
    Number(candidates.accessToken !== undefined) +
    Number(candidates.personalAccessToken !== undefined);
  const record = candidates.personalAccessToken;
  const now = Date.now();
  const scopes =
    record && personalAccessTokenAuthorityRecordIsWellFormed(record)
      ? canonicalPersonalAccessTokenScopes(record.scopes)
      : [];
  if (
    candidateCount !== 1 ||
    !record ||
    !personalAccessTokenIsStrictlyActive(record, now) ||
    scopes.length === 0
  ) {
    return bearerChallenge("invalid_token");
  }

  if (record.workspaceId === undefined) {
    return json(currentPersonalAccessTokenAuthorityBody(record, scopes, null));
  }
  if (!record.workspaceId) return bearerChallenge("invalid_token");
  if (!input.membershipReader) {
    return errorJson(
      "verification_unavailable",
      "Workspace membership verification is unavailable.",
      503,
      input.request,
    );
  }

  let member: PatWorkspaceMembership | undefined;
  try {
    member = await input.membershipReader.getMember(
      record.workspaceId,
      record.subject,
    );
  } catch {
    return errorJson(
      "verification_unavailable",
      "Workspace membership verification is unavailable.",
      503,
      input.request,
    );
  }
  if (member !== undefined && !patWorkspaceMembershipIsWellFormed(member)) {
    return errorJson(
      "verification_unavailable",
      "Workspace membership verification is unavailable.",
      503,
      input.request,
    );
  }
  const role = currentPatWorkspaceRole(
    member,
    record.workspaceId,
    record.subject,
  );
  if (!role) {
    return errorJson(
      "workspace_membership_inactive",
      "The personal access token no longer has an active Workspace membership.",
      403,
      input.request,
    );
  }
  return json(currentPersonalAccessTokenAuthorityBody(record, scopes, role));
}

function personalAccessTokenAuthorityRecordIsWellFormed(
  record: PersonalAccessTokenRecord,
): boolean {
  return (
    typeof record.tokenId === "string" &&
    record.tokenId.length > 0 &&
    record.tokenId.length <= 256 &&
    isTakosumiSubject(record.subject) &&
    Array.isArray(record.scopes) &&
    record.scopes.length > 0 &&
    timestampIsValid(record.createdAt) &&
    optionalTimestampIsValid(record.expiresAt) &&
    optionalTimestampIsValid(record.revokedAt) &&
    (record.workspaceId === undefined ||
      (typeof record.workspaceId === "string" &&
        record.workspaceId.length > 0 &&
        record.workspaceId.length <= 256))
  );
}

function isTakosumiSubject(value: unknown): value is TakosumiSubject {
  return (
    typeof value === "string" &&
    /^tsub_[^\s]+$/u.test(value) &&
    value.length <= 256
  );
}

function patWorkspaceMembershipIsWellFormed(
  value: PatWorkspaceMembership,
): boolean {
  const roles = Array.isArray(value.roles) ? value.roles : [];
  return (
    typeof value.workspaceId === "string" &&
    value.workspaceId.length > 0 &&
    typeof value.accountId === "string" &&
    value.accountId.length > 0 &&
    (value.status === "active" ||
      value.status === "invited" ||
      value.status === "suspended") &&
    Array.isArray(value.roles) &&
    new Set(roles).size === roles.length &&
    roles.every(
      (role) =>
        role === "owner" ||
        role === "admin" ||
        role === "member" ||
        role === "viewer",
    )
  );
}

async function resolvePatAuthorityCandidates(
  store: AccountsStore,
  token: string,
): Promise<AccountsBearerCredentialCandidates> {
  if (store.resolveAccountsBearerCandidates) {
    return await store.resolveAccountsBearerCandidates(token);
  }
  const [session, accessToken, personalAccessToken] = await Promise.all([
    store.findAccountSession(token),
    store.findAccessToken(token),
    store.findPersonalAccessToken(token),
  ]);
  return {
    ...(session ? { session } : {}),
    ...(accessToken ? { accessToken } : {}),
    ...(personalAccessToken ? { personalAccessToken } : {}),
  };
}

function currentPatBearerToken(authorization: string | null): string | null {
  const match = authorization?.match(/^Bearer ([^\s]+)$/iu);
  return match?.[1] ?? null;
}

function personalAccessTokenIsStrictlyActive(
  record: PersonalAccessTokenRecord,
  now: number,
): boolean {
  return (
    record.revokedAt === undefined &&
    (record.expiresAt === undefined ||
      (Number.isFinite(record.expiresAt) && record.expiresAt > now))
  );
}

function canonicalPersonalAccessTokenScopes(
  scopes: readonly unknown[],
): readonly TakosumiAccountsPatScope[] {
  if (!scopes.every((scope): scope is string => typeof scope === "string")) {
    return [];
  }
  const unique = new Set<string>(scopes);
  if (
    unique.size !== scopes.length ||
    [...unique].some(
      (scope) =>
        !(TAKOSUMI_ACCOUNTS_PAT_SCOPES as readonly string[]).includes(scope),
    )
  ) {
    return [];
  }
  return TAKOSUMI_ACCOUNTS_PAT_SCOPES.filter((scope) => unique.has(scope));
}

function currentPatWorkspaceRole(
  member: PatWorkspaceMembership | undefined,
  workspaceId: string,
  subject: TakosumiSubject,
): TakosumiAccountsWorkspaceRole | undefined {
  if (
    !member ||
    member.workspaceId !== workspaceId ||
    member.accountId !== subject ||
    member.status !== "active"
  ) {
    return undefined;
  }
  for (const role of ["owner", "admin", "member", "viewer"] as const) {
    if (member.roles.includes(role)) return role;
  }
  return undefined;
}

function currentPersonalAccessTokenAuthorityBody(
  record: PersonalAccessTokenRecord,
  scopes: readonly TakosumiAccountsPatScope[],
  workspaceRole: TakosumiAccountsWorkspaceRole | null,
): TakosumiAccountsCurrentPatAuthorityResponse {
  return {
    kind: TAKOSUMI_ACCOUNTS_CURRENT_PAT_AUTHORITY_KIND,
    token_id: record.tokenId,
    subject: record.subject,
    scopes,
    workspace_id: record.workspaceId ?? null,
    expires_at:
      record.expiresAt === undefined
        ? null
        : new Date(record.expiresAt).toISOString(),
    workspace_role: workspaceRole,
  };
}

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
  operations?: ControlPlaneOperations;
  resolveOperations?: () => Promise<ControlPlaneOperations | undefined>;
  extensionScopes?: readonly TakosumiAccountsPatScope[];
}): Promise<Response> {
  const session = await requireAccountSession(input);
  if (!session.ok) return session.response;

  const body = await readJsonObject(input.request);
  if (!body || Array.isArray(body)) {
    return errorJson("invalid_request", "invalid request", 400);
  }
  const name = stringValue(body.name)?.trim();
  const scopes = personalAccessTokenScopesValue(body.scopes);
  const workspaceId = stringValue(body.workspace_id)?.trim();
  const now = Date.now();
  const expiresAtResult = personalAccessTokenExpiresAtValue(
    body.expires_at,
    now,
  );
  if (!name || name.length > 80 || !scopes || expiresAtResult === "invalid") {
    return errorJson(
      "invalid_request",
      "name, one or more scopes, and optional future expires_at are required",
      400,
    );
  }
  if (
    scopes.some(
      (scope) =>
        !personalAccessTokenSelfServiceScopes(input.extensionScopes).includes(
          scope,
        ),
    )
  ) {
    return errorJson(
      "insufficient_scope",
      "admin scope cannot be granted by the self-service token endpoint",
      403,
    );
  }
  if (
    scopes.some(
      (scope) =>
        PERSONAL_ACCESS_TOKEN_SCOPE_CATALOG_METADATA[scope]
          .workspaceBinding === "required",
    ) &&
    !workspaceId
  ) {
    return errorJson(
      "invalid_request",
      "the selected personal access token scopes require workspace_id",
      400,
    );
  }
  if (workspaceId) {
    const operations =
      input.operations ?? (await input.resolveOperations?.());
    const ownsWorkspace = await subjectOwnsWorkspace({
      operations,
      subject: session.subject,
      workspaceId,
    });
    if (!ownsWorkspace) {
      return errorJson("workspace_not_found", "workspace not found", 404);
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

async function subjectOwnsWorkspace(input: {
  readonly operations?: ControlPlaneOperations;
  readonly subject: TakosumiSubject;
  readonly workspaceId: string;
}): Promise<boolean> {
  const operations = input.operations;
  if (!operations) return false;
  try {
    return Boolean(
      await operations.workspaces.getWorkspaceForAccount(
        input.subject,
        input.workspaceId,
      ),
    );
  } catch {
    return false;
  }
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
  workspaceRole?: string,
): Record<string, unknown> {
  return {
    active: true,
    token_use: "personal_access",
    iss: issuer,
    sub: record.subject,
    client_id: "takosumi-accounts-pat",
    token_type: "Bearer",
    scope: record.scopes.join(" "),
    ...(record.workspaceId
      ? {
          takosumi: {
            workspace_id: record.workspaceId,
            ...(workspaceRole ? { role: workspaceRole } : {}),
          },
        }
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
