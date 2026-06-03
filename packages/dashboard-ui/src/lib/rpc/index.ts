/**
 * Typed RPC client for the Takosumi dashboard SPA.
 *
 * A thin, fully-typed wrapper over the accounts/service REST API. It does NOT
 * introduce any server runtime, SolidStart server functions, or SSR — the SPA
 * stays `ssr: false` / `preset: "static"` and talks to the same-origin API
 * (served by the Worker's Static Assets split, or the node serve) using the
 * HttpOnly `takosumi_session` cookie. Every method goes through {@link apiFetch}
 * (transport in ./http) and uses contract-mirrored paths (./paths).
 *
 * Usage: `import { rpc, ApiError } from "~/lib/rpc";` then e.g.
 * `await rpc.installations.get(id)`.
 */
import { clearSession, refreshSession } from "../session";
import * as installations from "./installations";
import * as tokens from "./tokens";
import * as billing from "./billing";
import * as auth from "./auth";

export const rpc = {
  session: {
    /** Refresh + return the current session (null when unauthenticated). */
    me: refreshSession,
    /** Clear the local cache and ask the server to revoke the cookie. */
    signOut: clearSession,
  },
  installations: {
    list: installations.listInstallationsForSpace,
    get: installations.getInstallation,
    plan: installations.planInstallation,
    create: installations.createInstallation,
    uninstall: installations.uninstallInstallation,
    services: installations.listInstallationServices,
    serviceCatalog: installations.listWorkloadServices,
    rotateServiceToken: installations.rotateInstallationServiceToken,
    materialize: installations.materializeInstallation,
    requestExport: installations.requestInstallationExport,
    getExportOperation: installations.getInstallationExportOperation,
    exportDownloadUrl: installations.installationExportDownloadUrl,
    events: installations.listInstallationEvents,
  },
  tokens: {
    list: tokens.listTokens,
    create: tokens.createToken,
    revoke: tokens.revokeToken,
  },
  billing: {
    checkout: billing.startStripeCheckout,
  },
  auth: {
    startUpstreamOAuth: auth.startUpstreamOAuth,
    completeUpstreamOAuth: auth.completeUpstreamOAuth,
    recallOAuthProvider: auth.recallOAuthProvider,
    requestPasskeyRegisterOptions: auth.requestPasskeyRegisterOptions,
    completePasskeyRegistration: auth.completePasskeyRegistration,
  },
} as const;

export { ApiError } from "./http";

export type {
  CreateInstallationInput,
  DeploymentOutput,
  ExportInput,
  ExportOperation,
  Installation,
  InstallationPlanRunInput,
  InstallationPlanRunResponse,
  InstallationEvent,
  InstallationEventsResult,
  MaterializeInput,
  OidcClientConfig,
  RotateWorkloadServiceTokenResult,
  WorkloadService,
  WorkloadServiceDescriptor,
  WorkloadServiceStatus,
} from "./installations";
export type {
  CreateTokenInput,
  CreateTokenResult,
  PersonalAccessToken,
} from "./tokens";
export type { StripeCheckoutResult } from "./billing";
export type { CallbackResult, PasskeyRegisterOptions } from "./auth";
