/** Operator-only immutable Form Package installation and retained-byte proof. */

import {
  isInstalledFormReference,
  isSha256Digest,
  type FormPackage,
  type InstalledFormReference,
} from "takosumi-contract";
import { FormRegistryError } from "../domains/service-forms/mod.ts";
import { OpenTofuControllerError } from "../domains/deploy-control/errors.ts";
import {
  TAKOSUMI_FORM_PACKAGE_INSTALL_ROUTE,
  TAKOSUMI_FORM_PACKAGE_REVERIFY_ROUTE,
} from "./deploy_control_route_paths.ts";
import {
  defineRoute,
  ensureOperatorPermission,
  type DeployControlEndpoint,
  type DeployControlRouteContext,
  readJsonBody,
} from "./deploy_control_shared.ts";

export const DEPLOY_CONTROL_FORM_PACKAGE_ENDPOINTS: readonly DeployControlEndpoint[] =
  [
    {
      method: "POST",
      path: TAKOSUMI_FORM_PACKAGE_INSTALL_ROUTE,
      summary: "Installs one immutable verifier-approved Form Package.",
      auth: "deploy-control-token",
      operationId: "installFormPackage",
      openapi: {
        requestSchema: "InstallFormPackageRequest",
        okSchema: "FormPackageVerificationResponse",
      },
      notImplementedMessage: "Form Package registry is not wired",
    },
    {
      method: "POST",
      path: TAKOSUMI_FORM_PACKAGE_REVERIFY_ROUTE,
      summary: "Re-verifies retained bytes for one exact FormRef/package pair.",
      auth: "deploy-control-token",
      operationId: "reverifyFormPackage",
      openapi: {
        requestSchema: "InstalledFormReference",
        okSchema: "FormPackageVerificationResponse",
      },
      notImplementedMessage: "Form Package registry is not wired",
    },
  ];

export function mountDeployControlFormPackageRoutes(
  ctx: DeployControlRouteContext,
): void {
  const { app, deployControlBodyLimit } = ctx;

  app.post(
    TAKOSUMI_FORM_PACKAGE_INSTALL_ROUTE,
    deployControlBodyLimit,
    defineRoute({
      ctx,
      requireService: requireFormRegistry,
      enforceBody: true,
      handler: async ({ c, principal }) => {
        ensureOperatorPermission(principal, "manage host Form Packages");
        const body = parseInstallBody(
          await readJsonBody<Record<string, unknown>>(c, "formPackageInstall"),
        );
        const installed = await callRegistry(() =>
          ctx.dependencies.formRegistryService!.installPackage({
            ...body,
            actorId: principal.actor,
          }),
        );
        return c.json(redactedVerification(installed), 200);
      },
    }),
  );

  app.post(
    TAKOSUMI_FORM_PACKAGE_REVERIFY_ROUTE,
    deployControlBodyLimit,
    defineRoute({
      ctx,
      requireService: requireFormRegistry,
      enforceBody: true,
      handler: async ({ c, principal }) => {
        ensureOperatorPermission(principal, "manage host Form Packages");
        const identity = parseIdentity(
          await readJsonBody<Record<string, unknown>>(c, "formPackageReverify"),
        );
        const retained = await callRegistry(() =>
          ctx.dependencies.formRegistryService!.verifyRetainedIdentity(
            identity,
          ),
        );
        return c.json(
          {
            ...redactedVerification(retained.package),
            identity,
          },
          200,
        );
      },
    }),
  );
}

function requireFormRegistry(
  dependencies: DeployControlRouteContext["dependencies"],
): string | undefined {
  return dependencies.formRegistryService
    ? undefined
    : "Form Package registry is not wired";
}

function parseInstallBody(body: Record<string, unknown>): {
  readonly artifactRef: string;
  readonly expectedPackageDigest: string;
} {
  if (
    typeof body.artifactRef !== "string" ||
    body.artifactRef.trim() === "" ||
    body.artifactRef.length > 2048 ||
    /[\u0000-\u001f\u007f]/u.test(body.artifactRef)
  ) {
    throw invalid(
      "artifactRef must be a non-empty control-free string of at most 2048 characters",
    );
  }
  if (!isSha256Digest(body.expectedPackageDigest)) {
    throw invalid("expectedPackageDigest must be an exact sha256 digest");
  }
  return {
    artifactRef: body.artifactRef,
    expectedPackageDigest: body.expectedPackageDigest,
  };
}

function parseIdentity(body: Record<string, unknown>): InstalledFormReference {
  if (!isInstalledFormReference(body)) {
    throw invalid(
      "request must contain only an exact formRef and packageDigest",
    );
  }
  return body;
}

function redactedVerification(packageRecord: FormPackage) {
  return {
    verified: true as const,
    packageDigest: packageRecord.packageDigest,
    verifierId: packageRecord.verifierId,
    status: packageRecord.status,
    definitionRefs: packageRecord.definitionRefs,
    installedAt: packageRecord.installedAt,
    updatedAt: packageRecord.updatedAt,
  };
}

async function callRegistry<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof FormRegistryError) {
      throw registryError(error);
    }
    // Reader/verifier implementations may throw arbitrary errors. Do not pass
    // them to the shared logger or response because messages can contain an
    // artifact location, trust configuration, or package-derived content.
    throw new OpenTofuControllerError(
      "internal_error",
      "Form Package operation failed",
      { reason: "form_package_internal_error" },
    );
  }
}

function registryError(error: FormRegistryError): OpenTofuControllerError {
  switch (error.code) {
    case "invalid_request":
      return invalid("invalid Form Package request");
    case "verification_failed":
      return new OpenTofuControllerError(
        "failed_precondition",
        "Form Package verification failed",
        { reason: "form_package_verification_failed" },
      );
    case "verification_unavailable":
      return new OpenTofuControllerError(
        "failed_precondition",
        "trusted Form Package verification is unavailable",
        { reason: "form_package_verification_unavailable" },
      );
    case "package_conflict":
      return new OpenTofuControllerError(
        "failed_precondition",
        "Form Package conflicts with retained registry evidence",
        { reason: "form_package_conflict" },
      );
    case "definition_not_installed":
      return new OpenTofuControllerError(
        "not_found",
        "exact retained FormRef/package pair was not found",
        { reason: "form_package_identity_not_found" },
      );
    case "package_unavailable":
    case "package_retained":
    case "activation_conflict":
    case "activation_not_found":
      return new OpenTofuControllerError(
        "failed_precondition",
        "Form Package operation is not permitted by retained registry state",
        { reason: "form_package_state_conflict" },
      );
  }
}

function invalid(message: string): OpenTofuControllerError {
  return new OpenTofuControllerError("invalid_argument", message);
}
