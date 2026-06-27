/**
 * API paths for the account-plane RPC client (sign-in / session / Stripe
 * billing — the only account-plane endpoints the dashboard still calls).
 *
 * The account plane is mounted in-process at the worker origin root, so every
 * path is a same-origin `/v1/*` URL. The canonical path constants live in the
 * accounts contract (`@takosjp/takosumi-accounts-contract`); this module just
 * re-exports them under the local names the view code uses, so there is no
 * parallel `/v1/*` table to keep in sync.
 */
import {
  TAKOSUMI_ACCOUNTS_AUTH_PROVIDERS_PATH,
  TAKOSUMI_ACCOUNTS_UPSTREAM_AUTHORIZE_PATH,
  TAKOSUMI_ACCOUNTS_UPSTREAM_CALLBACK_PATH,
} from "@takosjp/takosumi-accounts-contract";

export const SESSION_ME = "/v1/account/session/me";

// Stripe checkout / customer portal are Takosumi Cloud-only endpoints. The OSS
// account plane no longer serves them (they 404 on an OSS-only deployment;
// Takosumi Cloud serves them). The dashboard keeps the client paths as plain
// literals so the same SPA can talk to a Cloud-backed origin without a separate
// build.
export const STRIPE_CHECKOUT = "/v1/billing/stripe/checkout";
export const STRIPE_PORTAL = "/v1/billing/stripe/portal";

export const UPSTREAM_AUTHORIZE = TAKOSUMI_ACCOUNTS_UPSTREAM_AUTHORIZE_PATH;
export const UPSTREAM_CALLBACK = TAKOSUMI_ACCOUNTS_UPSTREAM_CALLBACK_PATH;
export const AUTH_PROVIDERS = TAKOSUMI_ACCOUNTS_AUTH_PROVIDERS_PATH;
