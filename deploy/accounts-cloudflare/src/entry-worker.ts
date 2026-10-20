import { createAuthStagingWorker, type AuthStagingWorker } from "./staging-worker.ts";
import { createAccountsFinancialProofEntrypoint } from "./accounts-financial-proof-entrypoint.ts";
export { AccountsOwnerAdmission } from "./accounts-owner-admission-entrypoint.ts";

const authStagingWorker = createAuthStagingWorker();
// The default export is the provider-facing surface, and workerd dispatches
// RPC to any function on it with the caller's argument first. Expose only the
// HTTP and cron handlers; the in-process financial source resolver stays on
// authStagingWorker and is reached solely through AccountsFinancialProof.
export default Object.freeze({
  fetch: (...args: Parameters<AuthStagingWorker["fetch"]>) => authStagingWorker.fetch(...args),
  scheduled: (...args: Parameters<AuthStagingWorker["scheduled"]>) => authStagingWorker.scheduled(...args),
});
export const AccountsFinancialProof = createAccountsFinancialProofEntrypoint(authStagingWorker);
