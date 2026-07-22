/** Operator-only exact FormRef backfill and retained backup replay routes. */

import {
  defineRoute,
  type DeployControlEndpoint,
  type DeployControlRouteContext,
  ensureOperatorPermission,
  ensureWorkspacePermission,
  readJsonBody,
} from "./deploy_control_shared.ts";
import {
  TAKOSUMI_RESOURCE_FORM_PIN_INVENTORY_ROUTE,
  TAKOSUMI_WORKSPACE_RESOURCE_FORM_PIN_BACKFILL_ROUTE,
  TAKOSUMI_WORKSPACE_RESOURCE_FORM_PIN_RESTORE_ROUTE,
} from "./deploy_control_route_paths.ts";
import { OpenTofuControllerError } from "../domains/deploy-control/errors.ts";
import {
  isInstalledFormReference,
  isResourceShapeKind,
  type ResourceShapeKind,
} from "takosumi-contract";
import type { ResourceFormPinBackupEntry } from "takosumi-contract/backups";
import { decodeCursor, MAX_PAGE_LIMIT } from "takosumi-contract/pagination";
import type { SpaceId } from "../shared/ids.ts";

// Migration-local compatibility only. Historical production ledgers can carry
// durable Workspace owner ids with the retired `space_` prefix. Normal
// Workspace APIs remain ws_-only; these exact backfill/restore routes must be
// able to repair either persisted form without broadening product identity.
const RESOURCE_FORM_PIN_MIGRATION_WORKSPACE_ID_PATTERN =
  /^(?:ws_[0-9a-zA-Z]{3,64}|space_[0-9a-zA-Z]{1,64})$/u;

const WORKSPACE_ID_PARAM = {
  param: "workspaceId",
  pattern: RESOURCE_FORM_PIN_MIGRATION_WORKSPACE_ID_PATTERN,
} as const;

export const DEPLOY_CONTROL_RESOURCE_FORM_PIN_ENDPOINTS: readonly DeployControlEndpoint[] =
  [
    {
      method: "GET",
      path: TAKOSUMI_RESOURCE_FORM_PIN_INVENTORY_ROUTE,
      summary:
        "Captures a complete, authoritative all-Workspace exact FormRef pin inventory.",
      auth: "deploy-control-token",
      operationId: "captureResourceFormPinInventory",
      openapi: { okSchema: "ResourceFormPinInventoryReceipt" },
      notImplementedMessage: "exact FormRef pin inventory is not wired",
    },
    {
      method: "POST",
      path: TAKOSUMI_WORKSPACE_RESOURCE_FORM_PIN_BACKFILL_ROUTE,
      summary:
        "Backfills exact FormRef pins from one explicitly selected durable activation.",
      auth: "deploy-control-token",
      operationId: "backfillResourceFormPins",
      openapi: {
        pathParams: ["workspaceId"],
        requestSchema: "BackfillResourceFormPinsRequest",
        okSchema: "ResourceFormPinOperationReport",
      },
      notImplementedMessage: "exact FormRef pin operations are not wired",
    },
    {
      method: "POST",
      path: TAKOSUMI_WORKSPACE_RESOURCE_FORM_PIN_RESTORE_ROUTE,
      summary:
        "Replays exact FormRef pins from a redacted retained backup sidecar.",
      auth: "deploy-control-token",
      operationId: "restoreResourceFormPins",
      openapi: {
        pathParams: ["workspaceId"],
        requestSchema: "RestoreResourceFormPinsRequest",
        okSchema: "ResourceFormPinOperationReport",
      },
      notImplementedMessage: "exact FormRef pin operations are not wired",
    },
  ];

export function mountDeployControlResourceFormPinRoutes(
  ctx: DeployControlRouteContext,
): void {
  const { app, dependencies, deployControlBodyLimit } = ctx;
  const operations = dependencies.resourceFormPinOperations;

  app.get(
    TAKOSUMI_RESOURCE_FORM_PIN_INVENTORY_ROUTE,
    defineRoute({
      ctx,
      requireService: requiredInventoryDependency,
      handler: async ({ c, principal }) => {
        ensureOperatorPermission(
          principal,
          "capture the instance-wide Resource Form pin inventory",
        );
        return c.json(
          await dependencies.resourceFormPinInventory!.capture(),
          200,
        );
      },
    }),
  );

  app.post(
    TAKOSUMI_WORKSPACE_RESOURCE_FORM_PIN_BACKFILL_ROUTE,
    deployControlBodyLimit,
    defineRoute({
      ctx,
      requireService: requiredDependencies,
      param: WORKSPACE_ID_PARAM,
      enforceBody: true,
      handler: async ({ c, principal, id: workspaceId }) => {
        ensureWorkspacePermission(principal, workspaceId);
        const spaceId = await resolveAuthorizedSpace(ctx, workspaceId);
        const body = parseBackfillBody(
          await readJsonBody<Record<string, unknown>>(
            c,
            "resourceFormPinBackfill",
          ),
        );
        return c.json(
          await operations!.backfill({
            workspaceId,
            spaceId,
            actorId: principal.actor,
            ...body,
          }),
          200,
        );
      },
    }),
  );

  app.post(
    TAKOSUMI_WORKSPACE_RESOURCE_FORM_PIN_RESTORE_ROUTE,
    deployControlBodyLimit,
    defineRoute({
      ctx,
      requireService: requiredDependencies,
      param: WORKSPACE_ID_PARAM,
      enforceBody: true,
      handler: async ({ c, principal, id: workspaceId }) => {
        ensureWorkspacePermission(principal, workspaceId);
        const spaceId = await resolveAuthorizedSpace(ctx, workspaceId);
        const body = parseRestoreBody(
          await readJsonBody<Record<string, unknown>>(
            c,
            "resourceFormPinRestore",
          ),
        );
        return c.json(
          await operations!.restore({
            workspaceId,
            spaceId,
            actorId: principal.actor,
            ...body,
          }),
          200,
        );
      },
    }),
  );
}

function requiredInventoryDependency(
  dependencies: DeployControlRouteContext["dependencies"],
): string | undefined {
  return dependencies.resourceFormPinInventory
    ? undefined
    : "exact FormRef pin inventory is not wired";
}

function requiredDependencies(
  dependencies: DeployControlRouteContext["dependencies"],
): string | undefined {
  return dependencies.resourceFormPinOperations &&
    dependencies.resolveResourceFormPinScope
    ? undefined
    : "exact FormRef pin operations are not wired";
}

async function resolveAuthorizedSpace(
  ctx: DeployControlRouteContext,
  workspaceId: string,
): Promise<SpaceId> {
  const resolved =
    await ctx.dependencies.resolveResourceFormPinScope!(workspaceId);
  if (!resolved || resolved.trim() === "") {
    throw new OpenTofuControllerError(
      "failed_precondition",
      "Workspace has no authorized Resource Space mapping",
    );
  }
  return resolved as SpaceId;
}

function parseBackfillBody(body: Record<string, unknown>): {
  readonly kind: ResourceShapeKind;
  readonly activationIds: readonly string[];
  readonly cursor?: string;
  readonly limit?: number;
  readonly dryRun?: boolean;
} {
  if (!isResourceShapeKind(body.kind)) {
    throw invalid("kind must be an installed Resource kind");
  }
  if (
    !Array.isArray(body.activationIds) ||
    body.activationIds.length < 1 ||
    body.activationIds.length > 32 ||
    body.activationIds.some(
      (value) =>
        typeof value !== "string" || value.trim() === "" || value.length > 256,
    )
  ) {
    throw invalid(
      "activationIds must contain 1..32 non-empty strings of at most 256 characters",
    );
  }
  const page = parsePage(body);
  if (body.dryRun !== undefined && typeof body.dryRun !== "boolean") {
    throw invalid("dryRun must be a boolean");
  }
  return {
    kind: body.kind,
    activationIds: body.activationIds,
    ...page,
    ...(body.dryRun !== undefined ? { dryRun: body.dryRun } : {}),
  };
}

function parseRestoreBody(body: Record<string, unknown>): {
  readonly entries: readonly ResourceFormPinBackupEntry[];
  readonly cursor?: string;
  readonly limit?: number;
} {
  if (!Array.isArray(body.entries) || !body.entries.every(isBackupEntry)) {
    throw invalid(
      "entries must contain valid redacted exact FormRef backup entries",
    );
  }
  return { entries: body.entries, ...parsePage(body) };
}

function isBackupEntry(value: unknown): value is ResourceFormPinBackupEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  const keys = Object.keys(entry).sort();
  return (
    keys.length === 4 &&
    keys[0] === "identity" &&
    keys[1] === "kind" &&
    keys[2] === "resourceId" &&
    keys[3] === "resourceScopeId" &&
    typeof entry.resourceId === "string" &&
    entry.resourceId.trim() !== "" &&
    typeof entry.resourceScopeId === "string" &&
    entry.resourceScopeId.trim() !== "" &&
    typeof entry.kind === "string" &&
    entry.kind.trim() !== "" &&
    isInstalledFormReference(entry.identity) &&
    entry.identity.formRef.kind === entry.kind
  );
}

function parsePage(body: Record<string, unknown>): {
  readonly cursor?: string;
  readonly limit?: number;
} {
  if (
    body.cursor !== undefined &&
    (typeof body.cursor !== "string" ||
      body.cursor.trim() === "" ||
      decodeCursor(body.cursor) === undefined)
  ) {
    throw invalid("cursor must be a non-empty string");
  }
  if (
    body.limit !== undefined &&
    (!Number.isSafeInteger(body.limit) ||
      Number(body.limit) < 1 ||
      Number(body.limit) > MAX_PAGE_LIMIT)
  ) {
    throw invalid("limit must be a positive safe integer");
  }
  return {
    ...(body.cursor !== undefined ? { cursor: body.cursor as string } : {}),
    ...(body.limit !== undefined ? { limit: body.limit as number } : {}),
  };
}

function invalid(message: string): OpenTofuControllerError {
  return new OpenTofuControllerError("invalid_argument", message);
}
