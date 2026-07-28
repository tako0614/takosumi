import {
  TAKOSUMI_ACCOUNTS_ACCOUNT_TOKENS_PATH,
  takosumiAccountsAccountTokenRevokePath,
  type TakosumiAccountsCreatePatRequest,
  type TakosumiAccountsCreatePatResponse,
  type TakosumiAccountsListPatsResponse,
  type TakosumiAccountsPatMetadata,
} from "@takosjp/takosumi-accounts-contract";
import { apiFetch } from "./http.ts";

const TOKEN_PAGE_LIMIT = 200;

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
  input: TakosumiAccountsCreatePatRequest,
): Promise<TakosumiAccountsCreatePatResponse> {
  return await apiFetch<TakosumiAccountsCreatePatResponse>(
    TAKOSUMI_ACCOUNTS_ACCOUNT_TOKENS_PATH,
    { method: "POST", body: input },
  );
}

export async function revokeCloudApiKey(tokenId: string): Promise<void> {
  await apiFetch(takosumiAccountsAccountTokenRevokePath(tokenId), {
    method: "POST",
  });
}
