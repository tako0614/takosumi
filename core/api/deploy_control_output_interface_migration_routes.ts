/** Operator-reviewed one-time migration from runtime Output conventions. */

import type {
  ConfirmLegacyOutputInterfaceMigrationInput,
  LegacyOutputInterfaceManualSelection,
  LegacyOutputInterfaceMigrationCandidate,
} from "../domains/interfaces/legacy_output_migration.ts";
import {
  LegacyOutputInterfaceMigrationError,
  RETIRED_RUNTIME_OUTPUT_NAMES,
} from "../domains/interfaces/legacy_output_migration.ts";
import { OpenTofuControllerError } from "../domains/deploy-control/errors.ts";
import { TAKOSUMI_WORKSPACE_OUTPUT_INTERFACE_MIGRATION_ROUTE } from "./deploy_control_route_paths.ts";
import {
  defineRoute,
  type DeployControlEndpoint,
  type DeployControlRouteContext,
  ensureWorkspacePermission,
  nonEmptyString,
  readJsonBody,
  WORKSPACE_ID_PATTERN,
} from "./deploy_control_shared.ts";

const WORKSPACE_ID_PARAM = {
  param: "workspaceId",
  pattern: WORKSPACE_ID_PATTERN,
} as const;

export const DEPLOY_CONTROL_OUTPUT_INTERFACE_MIGRATION_ENDPOINTS: readonly DeployControlEndpoint[] =
  [
    {
      method: "GET",
      path: TAKOSUMI_WORKSPACE_OUTPUT_INTERFACE_MIGRATION_ROUTE,
      summary:
        "Reports exact candidates for migration from retired runtime Output conventions.",
      auth: "deploy-control-token",
      operationId: "reportLegacyOutputInterfaceMigration",
      openapi: {
        pathParams: ["workspaceId"],
        okSchema: "LegacyOutputInterfaceMigrationReportResponse",
      },
      notImplementedMessage: "Output-to-Interface migration is not wired",
    },
    {
      method: "POST",
      path: TAKOSUMI_WORKSPACE_OUTPUT_INTERFACE_MIGRATION_ROUTE,
      summary:
        "Confirms one exact reviewed Output-to-Interface migration candidate.",
      auth: "deploy-control-token",
      operationId: "confirmLegacyOutputInterfaceMigration",
      openapi: {
        pathParams: ["workspaceId"],
        requestSchema: "ConfirmLegacyOutputInterfaceMigrationRequest",
        okSchema: "ConfirmLegacyOutputInterfaceMigrationResponse",
      },
      notImplementedMessage: "Output-to-Interface migration is not wired",
    },
  ];

export function mountDeployControlOutputInterfaceMigrationRoutes(
  ctx: DeployControlRouteContext,
): void {
  const { app, dependencies, deployControlBodyLimit } = ctx;
  const migration = dependencies.legacyOutputInterfaceMigrationService;

  app.get(
    TAKOSUMI_WORKSPACE_OUTPUT_INTERFACE_MIGRATION_ROUTE,
    defineRoute({
      ctx,
      requireService: (deps) =>
        deps.legacyOutputInterfaceMigrationService
          ? undefined
          : "Output-to-Interface migration is not wired",
      param: WORKSPACE_ID_PARAM,
      handler: async ({ c, principal, id: workspaceId }) => {
        ensureWorkspacePermission(principal, workspaceId);
        return c.json(await migration!.report(workspaceId), 200);
      },
    }),
  );

  app.post(
    TAKOSUMI_WORKSPACE_OUTPUT_INTERFACE_MIGRATION_ROUTE,
    deployControlBodyLimit,
    defineRoute({
      ctx,
      requireService: (deps) =>
        deps.legacyOutputInterfaceMigrationService
          ? undefined
          : "Output-to-Interface migration is not wired",
      param: WORKSPACE_ID_PARAM,
      enforceBody: true,
      handler: async ({ c, principal, id: workspaceId }) => {
        ensureWorkspacePermission(principal, workspaceId);
        const parsed = parseConfirmationBody(
          await readJsonBody<Record<string, unknown>>(
            c,
            "outputInterfaceMigrationConfirm",
          ),
        );
        try {
          return c.json(
            await migration!.confirm(
              {
                ...parsed,
                confirmedBy: principal.actor ?? "deploy-control-operator",
              },
              workspaceId,
            ),
            200,
          );
        } catch (error) {
          if (error instanceof LegacyOutputInterfaceMigrationError) {
            throw new OpenTofuControllerError(
              error.code === "candidate_not_found"
                ? "not_found"
                : "failed_precondition",
              error.message,
            );
          }
          throw error;
        }
      },
    }),
  );
}

function parseConfirmationBody(
  body: Record<string, unknown>,
): Omit<ConfirmLegacyOutputInterfaceMigrationInput, "confirmedBy"> {
  const candidate = parseCandidate(body.candidate);
  const selection =
    body.selection === undefined ? undefined : parseSelection(body.selection);
  return { ...candidate, ...(selection ? { selection } : {}) };
}

function parseCandidate(
  value: unknown,
): LegacyOutputInterfaceMigrationCandidate {
  const raw = record(value, "candidate");
  assertOnlyKeys(
    raw,
    [
      "capsuleId",
      "capsuleUpdatedAt",
      "installConfigId",
      "installConfigUpdatedAt",
      "outputId",
      "outputDigest",
      "outputNamesDigest",
      "legacyConventionNames",
      "availableOutputNames",
      "mode",
      "interfaceBlueprintsDigest",
    ],
    "candidate",
  );
  const stringFields = [
    "capsuleId",
    "capsuleUpdatedAt",
    "installConfigId",
    "installConfigUpdatedAt",
    "outputId",
    "outputDigest",
    "outputNamesDigest",
  ] as const;
  for (const field of stringFields)
    requireString(raw[field], `candidate.${field}`);
  if (
    raw.mode !== "service_blueprints" &&
    raw.mode !== "owner_selection_required"
  ) {
    invalid(
      "candidate.mode must be service_blueprints or owner_selection_required",
    );
  }
  const legacyConventionNames = stringArray(
    raw.legacyConventionNames,
    "candidate.legacyConventionNames",
  );
  if (
    legacyConventionNames.some(
      (name) =>
        !RETIRED_RUNTIME_OUTPUT_NAMES.includes(
          name as (typeof RETIRED_RUNTIME_OUTPUT_NAMES)[number],
        ),
    )
  ) {
    invalid("candidate.legacyConventionNames contains an unknown convention");
  }
  const availableOutputNames = stringArray(
    raw.availableOutputNames,
    "candidate.availableOutputNames",
  );
  const interfaceBlueprintsDigest =
    raw.interfaceBlueprintsDigest === undefined
      ? undefined
      : requireString(
          raw.interfaceBlueprintsDigest,
          "candidate.interfaceBlueprintsDigest",
        );
  if (
    (raw.mode === "service_blueprints") !==
    (interfaceBlueprintsDigest !== undefined)
  ) {
    invalid(
      "candidate.interfaceBlueprintsDigest must be present only for service_blueprints",
    );
  }
  return {
    capsuleId: raw.capsuleId as string,
    capsuleUpdatedAt: raw.capsuleUpdatedAt as string,
    installConfigId: raw.installConfigId as string,
    installConfigUpdatedAt: raw.installConfigUpdatedAt as string,
    outputId: raw.outputId as string,
    outputDigest: raw.outputDigest as string,
    outputNamesDigest: raw.outputNamesDigest as string,
    legacyConventionNames:
      legacyConventionNames as LegacyOutputInterfaceMigrationCandidate["legacyConventionNames"],
    availableOutputNames,
    mode: raw.mode,
    ...(interfaceBlueprintsDigest ? { interfaceBlueprintsDigest } : {}),
  };
}

function parseSelection(value: unknown): LegacyOutputInterfaceManualSelection {
  const raw = record(value, "selection");
  assertOnlyKeys(
    raw,
    [
      "name",
      "type",
      "version",
      "document",
      "inputName",
      "outputName",
      "pointer",
      "access",
    ],
    "selection",
  );
  const access = record(raw.access, "selection.access");
  assertOnlyKeys(
    access,
    ["visibility", "policyRef", "resourceUriInput"],
    "selection.access",
  );
  if (!["private", "workspace", "public"].includes(String(access.visibility))) {
    invalid(
      "selection.access.visibility must be private, workspace, or public",
    );
  }
  const pointer =
    raw.pointer === undefined
      ? undefined
      : requireString(raw.pointer, "selection.pointer", true);
  const policyRef = optionalString(
    access.policyRef,
    "selection.access.policyRef",
  );
  const resourceUriInput = optionalString(
    access.resourceUriInput,
    "selection.access.resourceUriInput",
  );
  if (raw.document === undefined) invalid("selection.document is required");
  return {
    name: requireString(raw.name, "selection.name"),
    type: requireString(raw.type, "selection.type"),
    version: requireString(raw.version, "selection.version"),
    document: raw.document as LegacyOutputInterfaceManualSelection["document"],
    inputName: requireString(raw.inputName, "selection.inputName"),
    outputName: requireString(raw.outputName, "selection.outputName"),
    ...(pointer === undefined ? {} : { pointer }),
    access: {
      visibility:
        access.visibility as LegacyOutputInterfaceManualSelection["access"]["visibility"],
      ...(policyRef ? { policyRef } : {}),
      ...(resourceUriInput ? { resourceUriInput } : {}),
    },
  };
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalid(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.every(nonEmptyString)) {
    invalid(`${field} must be an array of non-empty strings`);
  }
  const strings = value as string[];
  if (new Set(strings).size !== strings.length) {
    invalid(`${field} must not contain duplicates`);
  }
  return [...strings];
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  field: string,
): void {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) {
    invalid(`${field} contains unsupported field ${unexpected.sort()[0]}`);
  }
}

function requireString(
  value: unknown,
  field: string,
  allowEmpty = false,
): string {
  if (typeof value !== "string" || (!allowEmpty && value.trim() === "")) {
    invalid(
      `${field} must be ${allowEmpty ? "a string" : "a non-empty string"}`,
    );
  }
  return allowEmpty ? (value as string) : (value as string).trim();
}

function optionalString(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : requireString(value, field);
}

function invalid(message: string): never {
  throw new OpenTofuControllerError("invalid_argument", message);
}
