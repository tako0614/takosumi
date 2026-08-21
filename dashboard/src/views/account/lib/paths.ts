/**
 * API paths for the account-plane RPC client (sign-in and session).
 *
 * The account API is mounted at the same-origin `/api/v1/*` prefix. The
 * canonical path constants live in the accounts contract
 * (`@takosjp/takosumi-accounts-contract`); this module just re-exports them
 * under the local names the view code uses, so there is no parallel path table
 * to keep in sync.
 */
import {
  TAKOSUMI_ACCOUNTS_AUTH_PROVIDERS_PATH,
  TAKOSUMI_ACCOUNTS_UPSTREAM_AUTHORIZE_PATH,
  TAKOSUMI_ACCOUNTS_UPSTREAM_CALLBACK_PATH,
} from "@takosjp/takosumi-accounts-contract";

export const SESSION_ME = "/api/v1/account/session/me";

export const UPSTREAM_AUTHORIZE = TAKOSUMI_ACCOUNTS_UPSTREAM_AUTHORIZE_PATH;
export const UPSTREAM_CALLBACK = TAKOSUMI_ACCOUNTS_UPSTREAM_CALLBACK_PATH;
export const AUTH_PROVIDERS = TAKOSUMI_ACCOUNTS_AUTH_PROVIDERS_PATH;
