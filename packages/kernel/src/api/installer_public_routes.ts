/**
 * Public installer HTTP surface — 5 endpoints exposing the AppSpec /
 * Installation / Deployment public concept set.
 *
 * Wave 5 implementation: handlers delegate to `InstallerPipeline`. When
 * no pipeline is injected, the routes fall back to 501 not_implemented so
 * upstream tests that don't supply a pipeline still see a stable shape.
 *
 *   POST /v1/installations/dry-run
 *   POST /v1/installations
 *   POST /v1/installations/{id}/deployments/dry-run
 *   POST /v1/installations/{id}/deployments
 *   POST /v1/installations/{id}/rollback
 *
 * Wire shape is the 1:1 mirror of `@takos/takosumi-contract/installer-api`.
 */

import type { Context, Hono } from "hono";
import type {
  DeploymentApplyRequest,
  DeploymentDryRunRequest,
  InstallationApplyRequest,
  InstallationDryRunRequest,
  InstallerErrorCode,
  InstallerErrorEnvelope,
  RollbackRequest,
} from "takosumi-contract/installer-api";
import {
  type InstallerPipeline,
  InstallerPipelineError,
  type InstallerPipelineErrorCode,
} from "../domains/installer/mod.ts";

export const INSTALLER_INSTALLATIONS_PATH = "/v1/installations" as const;
export const INSTALLER_INSTALLATIONS_DRY_RUN_PATH =
  "/v1/installations/dry-run" as const;
export const INSTALLER_INSTALLATION_DEPLOYMENTS_PATH =
  "/v1/installations/:installationId/deployments" as const;
export const INSTALLER_INSTALLATION_DEPLOYMENTS_DRY_RUN_PATH =
  "/v1/installations/:installationId/deployments/dry-run" as const;
export const INSTALLER_INSTALLATION_ROLLBACK_PATH =
  "/v1/installations/:installationId/rollback" as const;

export interface InstallerPublicRouteDependencies {
  /**
   * Installer bearer resolver. When unset or empty, installer routes are
   * disabled and return 404 so public hosts do not leak an unconfigured
   * surface.
   */
  readonly getInstallerToken?: () => string | undefined;
  /**
   * Installer pipeline instance — when unset, every endpoint returns 501
   * not_implemented (Wave 5 default until bootstrap wires one in).
   */
  readonly pipeline?: InstallerPipeline;
}

export function mountInstallerPublicRoutes(
  app: Hono,
  dependencies: InstallerPublicRouteDependencies = {},
): void {
  const pipeline = dependencies.pipeline;

  if (!pipeline) {
    app.post(
      INSTALLER_INSTALLATIONS_DRY_RUN_PATH,
      (c) =>
        authorizeInstaller(c, dependencies) ??
          c.json(notImplemented("installer dry-run not yet implemented"), 501),
    );
    app.post(
      INSTALLER_INSTALLATIONS_PATH,
      (c) =>
        authorizeInstaller(c, dependencies) ??
          c.json(notImplemented("installer apply not yet implemented"), 501),
    );
    app.post(
      INSTALLER_INSTALLATION_DEPLOYMENTS_DRY_RUN_PATH,
      (c) =>
        authorizeInstaller(c, dependencies) ??
          c.json(notImplemented("deployment dry-run not yet implemented"), 501),
    );
    app.post(
      INSTALLER_INSTALLATION_DEPLOYMENTS_PATH,
      (c) =>
        authorizeInstaller(c, dependencies) ??
          c.json(notImplemented("deployment apply not yet implemented"), 501),
    );
    app.post(
      INSTALLER_INSTALLATION_ROLLBACK_PATH,
      (c) =>
        authorizeInstaller(c, dependencies) ??
          c.json(notImplemented("rollback not yet implemented"), 501),
    );
    return;
  }

  app.post(INSTALLER_INSTALLATIONS_DRY_RUN_PATH, async (c) => {
    const unauthorized = authorizeInstaller(c, dependencies);
    if (unauthorized) return unauthorized;
    return await runHandler(c, async () => {
      const body = await readJsonBody<InstallationDryRunRequest>(c);
      const response = await pipeline.installationDryRun(body);
      return c.json(response, 200);
    });
  });

  app.post(INSTALLER_INSTALLATIONS_PATH, async (c) => {
    const unauthorized = authorizeInstaller(c, dependencies);
    if (unauthorized) return unauthorized;
    return await runHandler(c, async () => {
      const body = await readJsonBody<InstallationApplyRequest>(c);
      const response = await pipeline.installationApply(body);
      return c.json(response, 201);
    });
  });

  app.post(INSTALLER_INSTALLATION_DEPLOYMENTS_DRY_RUN_PATH, async (c) => {
    const unauthorized = authorizeInstaller(c, dependencies);
    if (unauthorized) return unauthorized;
    return await runHandler(c, async () => {
      const installationId = c.req.param("installationId");
      const body = await readJsonBody<DeploymentDryRunRequest>(c);
      const response = await pipeline.deploymentDryRun(installationId, body);
      return c.json(response, 200);
    });
  });

  app.post(INSTALLER_INSTALLATION_DEPLOYMENTS_PATH, async (c) => {
    const unauthorized = authorizeInstaller(c, dependencies);
    if (unauthorized) return unauthorized;
    return await runHandler(c, async () => {
      const installationId = c.req.param("installationId");
      const body = await readJsonBody<DeploymentApplyRequest>(c);
      const response = await pipeline.deploymentApply(installationId, body);
      return c.json(response, 201);
    });
  });

  app.post(INSTALLER_INSTALLATION_ROLLBACK_PATH, async (c) => {
    const unauthorized = authorizeInstaller(c, dependencies);
    if (unauthorized) return unauthorized;
    return await runHandler(c, async () => {
      const installationId = c.req.param("installationId");
      const body = await readJsonBody<RollbackRequest>(c);
      const response = await pipeline.rollback(installationId, body);
      return c.json(response, 201);
    });
  });
}

function authorizeInstaller(
  c: Context,
  dependencies: InstallerPublicRouteDependencies,
): Response | undefined {
  const token = dependencies.getInstallerToken?.();
  if (!token) {
    return c.json(errorEnvelope("not_found", "installer routes disabled"), 404);
  }
  const header = c.req.header("authorization") ?? "";
  if (header !== `Bearer ${token}`) {
    return c.json(
      errorEnvelope("unauthenticated", "invalid installer bearer"),
      401,
    );
  }
  return undefined;
}

function notImplemented(message: string): InstallerErrorEnvelope {
  return {
    error: {
      code: "not_implemented" satisfies InstallerErrorCode,
      message,
      requestId: crypto.randomUUID(),
    },
  };
}

async function runHandler(
  c: Context,
  fn: () => Promise<Response>,
): Promise<Response> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof InstallerPipelineError) {
      return c.json(
        errorEnvelope(err.code, err.message),
        pipelineHttpStatus(err.code),
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    return c.json(errorEnvelope("internal_error", message), 500);
  }
}

async function readJsonBody<T>(c: Context): Promise<T> {
  try {
    return (await c.req.json()) as T;
  } catch {
    throw new InstallerPipelineError(
      "invalid_argument",
      "request body must be valid JSON",
    );
  }
}

function pipelineHttpStatus(
  code: InstallerPipelineErrorCode,
): 400 | 401 | 403 | 404 | 412 | 429 | 500 | 501 {
  switch (code) {
    case "invalid_argument":
      return 400;
    case "unauthenticated":
      return 401;
    case "permission_denied":
      return 403;
    case "not_found":
      return 404;
    case "failed_precondition":
      return 412;
    case "resource_exhausted":
      return 429;
    case "not_implemented":
      return 501;
    case "internal_error":
      return 500;
  }
}

function errorEnvelope(
  code: InstallerErrorCode,
  message: string,
): InstallerErrorEnvelope {
  return {
    error: {
      code,
      message,
      requestId: crypto.randomUUID(),
    },
  };
}
