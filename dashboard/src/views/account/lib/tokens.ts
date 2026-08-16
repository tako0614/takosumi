import {
  TAKOSUMI_ACCOUNTS_ACCOUNT_TOKENS_PATH,
  TAKOSUMI_ACCOUNTS_PAT_SCOPE_CATALOG_KIND,
  TAKOSUMI_ACCOUNTS_PAT_SCOPE_CATALOG_PATH,
  TAKOSUMI_ACCOUNTS_PAT_SCOPES,
  takosumiAccountsAccountTokenRevokePath,
  type TakosumiAccountsCreatePatRequest,
  type TakosumiAccountsCreatePatResponse,
  type TakosumiAccountsListPatsResponse,
  type TakosumiAccountsPatMetadata,
  type TakosumiAccountsPatScope,
  type TakosumiAccountsPatScopeCatalogEntry,
  type TakosumiAccountsPatScopeCatalogResponse,
} from "@takosjp/takosumi-accounts-contract";
import { apiFetch } from "./http.ts";

const TOKEN_PAGE_LIMIT = 200;

export type CreateCloudApiKeyInput = Omit<
  TakosumiAccountsCreatePatRequest,
  "scopes"
> & {
  readonly scopes: readonly TakosumiAccountsPatScope[];
};

export function buildSelfServiceCloudApiKeyRequest(
  input: TakosumiAccountsCreatePatRequest,
  catalog: readonly TakosumiAccountsPatScopeCatalogEntry[],
): CreateCloudApiKeyInput {
  if (input.scopes.length === 0) {
    throw new TypeError("Self-service PAT creation requires at least one scope");
  }
  if (new Set(input.scopes).size !== input.scopes.length) {
    throw new TypeError("Self-service PAT creation contains a duplicate scope");
  }
  const catalogByScope = new Map(catalog.map((entry) => [entry.scope, entry]));
  for (const scope of input.scopes) {
    const entry = catalogByScope.get(scope);
    if (!entry?.selfService) {
      throw new TypeError(
        `PAT scope ${scope} is not available for self-service`,
      );
    }
    if (
      entry.workspaceBinding === "required" &&
      !input.workspace_id?.trim()
    ) {
      throw new TypeError(`PAT scope ${scope} requires a workspace binding`);
    }
  }
  return {
    ...input,
    scopes: input.scopes,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function isLocalizedText(value: unknown): value is Readonly<{
  ja: string;
  en: string;
}> {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["ja", "en"]) &&
    typeof value.ja === "string" &&
    value.ja.trim().length > 0 &&
    typeof value.en === "string" &&
    value.en.trim().length > 0
  );
}

function isPatScope(value: unknown): value is TakosumiAccountsPatScope {
  return (
    typeof value === "string" &&
    (TAKOSUMI_ACCOUNTS_PAT_SCOPES as readonly string[]).includes(value)
  );
}

function isScopeCatalogEntry(
  value: unknown,
): value is TakosumiAccountsPatScopeCatalogEntry {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "scope",
      "label",
      "description",
      "selfService",
      "workspaceBinding",
    ]) ||
    !isPatScope(value.scope) ||
    !isLocalizedText(value.label) ||
    !isLocalizedText(value.description) ||
    typeof value.selfService !== "boolean" ||
    (value.workspaceBinding !== "optional" &&
      value.workspaceBinding !== "required")
  ) {
    return false;
  }
  switch (value.scope) {
    case "read":
    case "write":
      return value.selfService && value.workspaceBinding === "optional";
    case "admin":
      return !value.selfService && value.workspaceBinding === "optional";
    case "resources:read":
    case "ai.models.read":
    case "ai.chat":
    case "ai.embeddings":
      return value.workspaceBinding === "required";
  }
}

/** Fail closed when a successful response does not match the versioned catalog. */
export function normalizeCloudApiKeyScopeCatalog(
  value: unknown,
): TakosumiAccountsPatScopeCatalogResponse {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["kind", "scopes"]) ||
    value.kind !== TAKOSUMI_ACCOUNTS_PAT_SCOPE_CATALOG_KIND ||
    !Array.isArray(value.scopes) ||
    !value.scopes.every(isScopeCatalogEntry)
  ) {
    throw new TypeError("Invalid Accounts PAT scope catalog");
  }
  const scopes = value.scopes as readonly TakosumiAccountsPatScopeCatalogEntry[];
  if (new Set(scopes.map((entry) => entry.scope)).size !== scopes.length) {
    throw new TypeError("Invalid Accounts PAT scope catalog: duplicate scope");
  }
  return {
    kind: TAKOSUMI_ACCOUNTS_PAT_SCOPE_CATALOG_KIND,
    scopes,
  };
}

export async function listCloudApiKeyScopeCatalog(): Promise<
  TakosumiAccountsPatScopeCatalogResponse
> {
  const response = await apiFetch<unknown>(
    TAKOSUMI_ACCOUNTS_PAT_SCOPE_CATALOG_PATH,
  );
  return normalizeCloudApiKeyScopeCatalog(response);
}

/** Takosumi Cloud API keys are Accounts personal access tokens. */
export async function listCloudApiKeys(): Promise<
  readonly TakosumiAccountsPatMetadata[]
> {
  const response = await apiFetch<TakosumiAccountsListPatsResponse>(
    `${TAKOSUMI_ACCOUNTS_ACCOUNT_TOKENS_PATH}?limit=${TOKEN_PAGE_LIMIT}`,
  );
  return response.tokens;
}

export async function createCloudApiKey(
  input: CreateCloudApiKeyInput,
  catalog: readonly TakosumiAccountsPatScopeCatalogEntry[],
): Promise<TakosumiAccountsCreatePatResponse> {
  return await apiFetch<TakosumiAccountsCreatePatResponse>(
    TAKOSUMI_ACCOUNTS_ACCOUNT_TOKENS_PATH,
    {
      method: "POST",
      body: buildSelfServiceCloudApiKeyRequest(input, catalog),
    },
  );
}

export async function revokeCloudApiKey(tokenId: string): Promise<void> {
  await apiFetch(takosumiAccountsAccountTokenRevokePath(tokenId), {
    method: "POST",
  });
}
