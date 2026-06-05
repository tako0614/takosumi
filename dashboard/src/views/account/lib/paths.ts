/**
 * API paths for the account-plane RPC client.
 *
 * The account plane is mounted in-process at the worker origin root, so every
 * path is a same-origin `/v1/*` URL. The canonical path constants and builders
 * live in the accounts contract (`@takosjp/takosumi-accounts-contract`); this
 * module just re-exports them under the local names the account-plane view code
 * uses, so there is no parallel `/v1/*` table to keep in sync.
 */
import {
  TAKOSUMI_ACCOUNTS_ACCOUNT_TOKENS_PATH,
  TAKOSUMI_ACCOUNTS_CONNECTIONS_PATH,
  TAKOSUMI_ACCOUNTS_INSTALLATION_PLAN_RUNS_PATH,
  TAKOSUMI_ACCOUNTS_INSTALLATIONS_PATH,
  TAKOSUMI_ACCOUNTS_PASSKEY_REGISTER_COMPLETE_PATH,
  TAKOSUMI_ACCOUNTS_PASSKEY_REGISTER_OPTIONS_PATH,
  TAKOSUMI_ACCOUNTS_STRIPE_CHECKOUT_PATH,
  TAKOSUMI_ACCOUNTS_UPSTREAM_AUTHORIZE_PATH,
  TAKOSUMI_ACCOUNTS_UPSTREAM_CALLBACK_PATH,
  TAKOSUMI_ACCOUNTS_WORKLOAD_SERVICES_PATH,
  takosumiAccountsAccountTokenRevokePath,
  takosumiAccountsConnectionPath,
  takosumiAccountsConnectionTestPath,
  takosumiAccountsInstallationEventsPath,
  takosumiAccountsInstallationExportDownloadPath,
  takosumiAccountsInstallationExportOperationPath,
  takosumiAccountsInstallationExportPath,
  takosumiAccountsInstallationMaterializePath,
  takosumiAccountsInstallationPath,
  takosumiAccountsInstallationServiceRotateTokenPath,
  takosumiAccountsInstallationServicesPath,
} from "@takosjp/takosumi-accounts-contract";

export const SESSION_ME = "/v1/account/session/me";

export const ACCOUNT_TOKENS = TAKOSUMI_ACCOUNTS_ACCOUNT_TOKENS_PATH;
export const accountTokenRevoke = takosumiAccountsAccountTokenRevokePath;

export const STRIPE_CHECKOUT = TAKOSUMI_ACCOUNTS_STRIPE_CHECKOUT_PATH;

export const UPSTREAM_AUTHORIZE = TAKOSUMI_ACCOUNTS_UPSTREAM_AUTHORIZE_PATH;
export const UPSTREAM_CALLBACK = TAKOSUMI_ACCOUNTS_UPSTREAM_CALLBACK_PATH;
export const PASSKEY_REGISTER_OPTIONS =
  TAKOSUMI_ACCOUNTS_PASSKEY_REGISTER_OPTIONS_PATH;
export const PASSKEY_REGISTER_COMPLETE =
  TAKOSUMI_ACCOUNTS_PASSKEY_REGISTER_COMPLETE_PATH;

export const INSTALLATIONS = TAKOSUMI_ACCOUNTS_INSTALLATIONS_PATH;
export const INSTALLATION_PLAN_RUNS =
  TAKOSUMI_ACCOUNTS_INSTALLATION_PLAN_RUNS_PATH;
export const WORKLOAD_SERVICES = TAKOSUMI_ACCOUNTS_WORKLOAD_SERVICES_PATH;

export const CONNECTIONS = TAKOSUMI_ACCOUNTS_CONNECTIONS_PATH;
export const connection = takosumiAccountsConnectionPath;
export const connectionTest = takosumiAccountsConnectionTestPath;
export const installation = takosumiAccountsInstallationPath;
export const installationMaterialize =
  takosumiAccountsInstallationMaterializePath;
export const installationExport = takosumiAccountsInstallationExportPath;
export const installationExportOperation =
  takosumiAccountsInstallationExportOperationPath;
export const installationExportDownload =
  takosumiAccountsInstallationExportDownloadPath;
export const installationEvents = takosumiAccountsInstallationEventsPath;
export const installationServices = takosumiAccountsInstallationServicesPath;
export const installationServiceRotateToken =
  takosumiAccountsInstallationServiceRotateTokenPath;
