import { createAuthStagingWorker } from "./staging-worker.ts";
import { createAccountsFinancialProofEntrypoint } from "./accounts-financial-proof-entrypoint.ts";
export { AccountsOwnerAdmission } from "./accounts-owner-admission-entrypoint.ts";

const authStagingWorker = createAuthStagingWorker();
export default authStagingWorker;
export const AccountsFinancialProof = createAccountsFinancialProofEntrypoint(authStagingWorker);
