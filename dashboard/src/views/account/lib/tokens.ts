import {
  TAKOSUMI_ACCOUNTS_ACCOUNT_TOKENS_PATH,
  TAKOSUMI_ACCOUNTS_SELF_SERVICE_PAT_SCOPES,
  takosumiAccountsAccountTokenRevokePath,
  type TakosumiAccountsCreatePatRequest,
  type TakosumiAccountsCreatePatResponse,
  type TakosumiAccountsListPatsResponse,
  type TakosumiAccountsPatMetadata,
  type TakosumiAccountsPatScope,
} from "@takosjp/takosumi-accounts-contract";
import { apiFetch } from "./http.ts";

const TOKEN_PAGE_LIMIT = 200;

type SelfServicePatScope =
  (typeof TAKOSUMI_ACCOUNTS_SELF_SERVICE_PAT_SCOPES)[number];

export type CreateCloudApiKeyInput = Omit<
  TakosumiAccountsCreatePatRequest,
  "scopes"
> & {
  readonly scopes: readonly SelfServicePatScope[];
};

export function buildSelfServiceCloudApiKeyRequest(
  input: TakosumiAccountsCreatePatRequest,
): CreateCloudApiKeyInput {
  return {
    ...input,
    scopes: input.scopes.filter(isSelfServicePatScope),
  };
}

function isSelfServicePatScope(
  scope: TakosumiAccountsPatScope,
): scope is SelfServicePatScope {
  return (
    TAKOSUMI_ACCOUNTS_SELF_SERVICE_PAT_SCOPES as readonly TakosumiAccountsPatScope[]
  ).includes(scope);
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
): Promise<TakosumiAccountsCreatePatResponse> {
  return await apiFetch<TakosumiAccountsCreatePatResponse>(
    TAKOSUMI_ACCOUNTS_ACCOUNT_TOKENS_PATH,
    { method: "POST", body: buildSelfServiceCloudApiKeyRequest(input) },
  );
}

export async function revokeCloudApiKey(tokenId: string): Promise<void> {
  await apiFetch(takosumiAccountsAccountTokenRevokePath(tokenId), {
    method: "POST",
  });
}
