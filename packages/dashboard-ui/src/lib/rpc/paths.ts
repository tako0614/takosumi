/**
 * API paths for the RPC client.
 *
 * These mirror the canonical path builders in
 * `@takosjp/takosumi-accounts-contract` (e.g.
 * `takosumiAccountsInstallationMaterializePath`). The SPA build is kept
 * self-contained (vinxi/vite does not resolve the repo's tsconfig path
 * aliases), so the paths are duplicated here rather than imported. The
 * API-vs-SPA split e2e + the contract are the drift guards; keep this in sync
 * with the contract if the public paths change.
 */

const enc = encodeURIComponent;

export const SESSION_ME = "/v1/account/session/me";

export const ACCOUNT_TOKENS = "/v1/account/tokens";
export const accountTokenRevoke = (tokenId: string): string =>
  `${ACCOUNT_TOKENS}/${enc(tokenId)}/revoke`;

export const STRIPE_CHECKOUT = "/v1/billing/stripe/checkout";

export const UPSTREAM_AUTHORIZE = "/v1/auth/upstream/authorize";
export const UPSTREAM_CALLBACK = "/v1/auth/upstream/callback";
export const PASSKEY_REGISTER_OPTIONS = "/v1/auth/passkeys/register/options";
export const PASSKEY_REGISTER_COMPLETE = "/v1/auth/passkeys/register/complete";

export const INSTALLATIONS = "/v1/installations";
export const INSTALLATION_PLAN_RUNS = "/v1/installations/plan-runs";
export const installation = (id: string): string => `${INSTALLATIONS}/${enc(id)}`;
export const installationMaterialize = (id: string): string =>
  `${installation(id)}/materialize`;
export const installationExport = (id: string): string =>
  `${installation(id)}/export`;
export const installationExportOperation = (
  id: string,
  operationId: string,
): string => `${installation(id)}/exports/${enc(operationId)}`;
export const installationExportDownload = (
  id: string,
  operationId: string,
): string => `${installationExportOperation(id, operationId)}/download`;
export const installationEvents = (id: string): string =>
  `${installation(id)}/events`;
