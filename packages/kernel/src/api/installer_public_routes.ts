/**
 * Public installer HTTP surface — 5 endpoints exposing the AppSpec /
 * Installation / Deployment public concept set.
 *
 * Wave 5 stub: route mounts return `not_implemented` until the kernel
 * installer pipeline (parse → resolve use edges → run component.build
 * → call provider plugins → persist Deployment) is wired in. The shape
 * matches `@takos/takosumi-contract/installer-api` 1:1.
 *
 *   POST /v1/installations/dry-run
 *   POST /v1/installations
 *   POST /v1/installations/{id}/deployments/dry-run
 *   POST /v1/installations/{id}/deployments
 *   POST /v1/installations/{id}/rollback
 *
 * Mounted in a follow-up commit alongside removal of the legacy
 * `deploy_public_routes.ts` `POST /v1/deployments` surface.
 */

import type { Hono } from "hono";
import type {
  InstallerErrorCode,
  InstallerErrorEnvelope,
} from "takosumi-contract/installer-api";

export const INSTALLER_INSTALLATIONS_PATH = "/v1/installations" as const;
export const INSTALLER_INSTALLATIONS_DRY_RUN_PATH =
  "/v1/installations/dry-run" as const;
export const INSTALLER_INSTALLATION_DEPLOYMENTS_PATH =
  "/v1/installations/:installationId/deployments" as const;
export const INSTALLER_INSTALLATION_DEPLOYMENTS_DRY_RUN_PATH =
  "/v1/installations/:installationId/deployments/dry-run" as const;
export const INSTALLER_INSTALLATION_ROLLBACK_PATH =
  "/v1/installations/:installationId/rollback" as const;

function notImplemented(message: string): InstallerErrorEnvelope {
  return {
    error: {
      code: "not_implemented" satisfies InstallerErrorCode,
      message,
      requestId: crypto.randomUUID(),
    },
  };
}

export interface InstallerPublicRouteDependencies {
  // Wave 5 follow-up will populate these (token resolver, source fetcher,
  // installer pipeline, persistence stores, observability sinks, etc.).
  readonly _placeholder?: never;
}

export function mountInstallerPublicRoutes(
  app: Hono,
  _dependencies: InstallerPublicRouteDependencies = {},
): void {
  app.post(INSTALLER_INSTALLATIONS_DRY_RUN_PATH, (c) =>
    c.json(notImplemented("installer dry-run not yet implemented"), 501));

  app.post(INSTALLER_INSTALLATIONS_PATH, (c) =>
    c.json(notImplemented("installer apply not yet implemented"), 501));

  app.post(INSTALLER_INSTALLATION_DEPLOYMENTS_DRY_RUN_PATH, (c) =>
    c.json(notImplemented("deployment dry-run not yet implemented"), 501));

  app.post(INSTALLER_INSTALLATION_DEPLOYMENTS_PATH, (c) =>
    c.json(notImplemented("deployment apply not yet implemented"), 501));

  app.post(INSTALLER_INSTALLATION_ROLLBACK_PATH, (c) =>
    c.json(notImplemented("rollback not yet implemented"), 501));
}
