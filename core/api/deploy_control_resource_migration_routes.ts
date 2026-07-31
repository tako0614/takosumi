/**
 * Operator execution of one Plan-pinned Capsule `resource_migration`.
 *
 * The declaration in the Capsule's InstallConfig pins a bundle digest; the
 * bundle's manifest pins each entry's bytes. The operator supplies both, and
 * this route re-derives every digest before anything reaches a database — so
 * the SQL that runs is exactly the SQL the install was reviewed with, and a
 * compromised or mistaken operator process cannot substitute its own.
 *
 * Which Resource a declaration names is answered from server-side records, not
 * from the request: the address's Resource type selects a Shape, and the
 * Capsule must own exactly one Resource of it. An ambiguous address fails
 * closed rather than picking one.
 */

import type { CapsulesService } from "../domains/capsules/mod.ts";
import type {
  InstallConfigResourceMigrationAction,
  InstallConfigLifecycleAction,
} from "takosumi-contract/install-configs";
import type { AdapterMigrationEntry } from "../domains/resource-shape/adapter.ts";
import { OpenTofuControllerError } from "../domains/deploy-control/errors.ts";
import { TAKOSUMI_CAPSULE_RESOURCE_MIGRATION_ROUTE } from "./deploy_control_route_paths.ts";
import {
  defineRoute,
  type DeployControlEndpoint,
  type DeployControlRouteContext,
  ensureWorkspacePermission,
  readJsonBody,
} from "./deploy_control_shared.ts";

const CAPSULE_ID_PARAM = {
  param: "capsuleId",
  pattern: /^cap_[a-z0-9]{1,64}$/u,
} as const;

/** `takoform_relational_database.database` -> the Shape it can only mean. */
const RESOURCE_TYPE_SHAPES: Readonly<Record<string, string>> = {
  takoform_relational_database: "RelationalDatabase",
};

const MAX_ENTRIES = 500;
const MAX_ENTRY_BYTES = 2 * 1024 * 1024;

export const DEPLOY_CONTROL_RESOURCE_MIGRATION_ENDPOINTS: readonly DeployControlEndpoint[] =
  [
    {
      method: "POST",
      path: TAKOSUMI_CAPSULE_RESOURCE_MIGRATION_ROUTE,
      summary:
        "Applies one Plan-pinned resource_migration declared by a Capsule's InstallConfig.",
      auth: "deploy-control-token",
      operationId: "applyCapsuleResourceMigration",
      openapi: {
        pathParams: ["capsuleId"],
        requestSchema: "ApplyCapsuleResourceMigrationRequest",
        okSchema: "ApplyCapsuleResourceMigrationResponse",
      },
      notImplementedMessage: "Capsule resource migration is not wired",
    },
  ];

export function mountDeployControlResourceMigrationRoutes(
  ctx: DeployControlRouteContext,
): void {
  const { app, dependencies, deployControlBodyLimit } = ctx;

  app.post(
    TAKOSUMI_CAPSULE_RESOURCE_MIGRATION_ROUTE,
    deployControlBodyLimit,
    defineRoute({
      ctx,
      requireService: (deps) =>
        deps.capsulesService && deps.resourceShapeService
          ? undefined
          : "Capsule resource migration is not wired",
      param: CAPSULE_ID_PARAM,
      enforceBody: true,
      handler: async ({ c, principal, id: capsuleId }) => {
        const capsules = dependencies.capsulesService as CapsulesService;
        const resources = dependencies.resourceShapeService!;
        const capsule = await capsules.getCapsule(capsuleId);
        ensureWorkspacePermission(principal, capsule.workspaceId);

        const body = await readJsonBody<Record<string, unknown>>(
          c,
          "capsuleResourceMigration",
        );
        const actionId = requiredString(body.actionId, "actionId");
        const manifestText = requiredString(body.manifest, "manifest");
        const declaration = await migrationDeclaration(
          capsules,
          capsule.installConfigId,
          actionId,
        );

        await assertPinnedManifest(manifestText, declaration.bundle.digest);
        const entries = await verifiedEntries(manifestText, body.entries);

        const shape = shapeForAddress(declaration.target.resourceAddress);
        const name = await soleOwnedResourceName(
          resources,
          capsule.workspaceId,
          capsuleId,
          shape,
        );

        const result = await resources.migrate(
          capsule.workspaceId,
          shape as Parameters<typeof resources.migrate>[1],
          name,
          {
            actorAccountId: principal.actor ?? "deploy-control-operator",
            workspaceId: capsule.workspaceId,
            roles: ["operator"],
            requestId: c.get("requestId") ?? "",
          },
          entries,
        );
        if (!result.ok) {
          throw new OpenTofuControllerError(
            result.error.code === "not_found"
              ? "not_found"
              : "failed_precondition",
            result.error.message,
          );
        }
        return c.json(
          {
            capsuleId,
            actionId,
            resourceAddress: declaration.target.resourceAddress,
            resourceName: name,
            applied: result.value.applied,
            skipped: result.value.skipped,
            summary: result.value.summary,
          },
          200,
        );
      },
    }),
  );
}

async function migrationDeclaration(
  capsules: CapsulesService,
  installConfigId: string,
  actionId: string,
): Promise<InstallConfigResourceMigrationAction> {
  const config = await capsules.getInstallConfig(installConfigId);
  const actions: readonly InstallConfigLifecycleAction[] =
    config.lifecycleActions ?? [];
  const declaration = actions.find(
    (action) => action.kind === "resource_migration" && action.id === actionId,
  );
  if (!declaration) {
    throw new OpenTofuControllerError(
      "not_found",
      `InstallConfig ${installConfigId} declares no resource_migration ${actionId}`,
    );
  }
  return declaration as InstallConfigResourceMigrationAction;
}

/**
 * The declaration commits to the manifest's exact bytes. Re-deriving the digest
 * here is what makes every per-entry digest below trustworthy: without it the
 * operator could present a manifest listing whatever SQL it liked.
 */
async function assertPinnedManifest(
  manifestText: string,
  pinned: string,
): Promise<void> {
  const digest = await sha256Hex(manifestText);
  if (`sha256:${digest}` !== pinned) {
    throw new OpenTofuControllerError(
      "failed_precondition",
      "resource migration bundle manifest does not match the Plan-pinned digest",
    );
  }
}

async function verifiedEntries(
  manifestText: string,
  raw: unknown,
): Promise<readonly AdapterMigrationEntry[]> {
  const manifest = parseManifest(manifestText);
  const supplied = new Map<string, string>();
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new OpenTofuControllerError(
      "invalid_argument",
      "resource migration entries must be a non-empty array",
    );
  }
  if (raw.length > MAX_ENTRIES) {
    throw new OpenTofuControllerError(
      "invalid_argument",
      `resource migration entry limit is ${MAX_ENTRIES}`,
    );
  }
  for (const value of raw) {
    const entry = value as { name?: unknown; sql?: unknown };
    const name = requiredString(entry.name, "entries[].name");
    const sql = requiredString(entry.sql, "entries[].sql");
    if (sql.length > MAX_ENTRY_BYTES) {
      throw new OpenTofuControllerError(
        "invalid_argument",
        `resource migration entry ${name} exceeds the size limit`,
      );
    }
    supplied.set(name, sql);
  }

  // Manifest order is the migration order; the request's order is ignored so a
  // reordered payload cannot change what a pinned bundle means.
  const verified: AdapterMigrationEntry[] = [];
  for (const entry of manifest.entries) {
    const sql = supplied.get(entry.name);
    if (sql === undefined) {
      throw new OpenTofuControllerError(
        "invalid_argument",
        `resource migration bundle is missing entry ${entry.name}`,
      );
    }
    const digest = `sha256:${await sha256Hex(sql)}`;
    if (digest !== entry.sha256) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `resource migration entry ${entry.name} does not match its pinned digest`,
      );
    }
    verified.push({ name: entry.name, sha256: entry.sha256, sql });
  }
  return verified;
}

interface ParsedManifest {
  readonly entries: readonly { readonly name: string; readonly sha256: string }[];
}

function parseManifest(manifestText: string): ParsedManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestText);
  } catch {
    throw new OpenTofuControllerError(
      "invalid_argument",
      "resource migration bundle manifest is not valid JSON",
    );
  }
  const record = parsed as {
    apiVersion?: unknown;
    entries?: unknown;
  };
  if (record?.apiVersion !== "takosumi.resource-migrations/v1") {
    throw new OpenTofuControllerError(
      "invalid_argument",
      "resource migration bundle manifest apiVersion is unsupported",
    );
  }
  if (!Array.isArray(record.entries) || record.entries.length === 0) {
    throw new OpenTofuControllerError(
      "invalid_argument",
      "resource migration bundle manifest declares no entries",
    );
  }
  return {
    entries: record.entries.map((value, index) => {
      const entry = value as { name?: unknown; sha256?: unknown };
      return {
        name: requiredString(entry.name, `manifest.entries[${index}].name`),
        sha256: requiredString(
          entry.sha256,
          `manifest.entries[${index}].sha256`,
        ),
      };
    }),
  };
}

function shapeForAddress(resourceAddress: string): string {
  const type = resourceAddress.split(".").at(-2) ?? "";
  const shape = RESOURCE_TYPE_SHAPES[type];
  if (!shape) {
    throw new OpenTofuControllerError(
      "failed_precondition",
      `resource migration target ${resourceAddress} names no migratable Resource type`,
    );
  }
  return shape;
}

async function soleOwnedResourceName(
  resources: NonNullable<
    DeployControlRouteContext["dependencies"]["resourceShapeService"]
  >,
  workspaceId: string,
  capsuleId: string,
  shape: string,
): Promise<string> {
  const listed = await resources.list(workspaceId);
  const owned = listed.filter((resource) => {
    const owner = resource.metadata.owner;
    return (
      resource.kind === shape &&
      typeof owner === "object" &&
      owner.kind === "Capsule" &&
      owner.id === capsuleId
    );
  });
  if (owned.length !== 1) {
    throw new OpenTofuControllerError(
      "failed_precondition",
      `Capsule ${capsuleId} owns ${owned.length} ${shape} Resources; a migration target must be unambiguous`,
    );
  }
  return owned[0]!.metadata.name;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new OpenTofuControllerError(
      "invalid_argument",
      `${field} must be a non-empty string`,
    );
  }
  return value;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
