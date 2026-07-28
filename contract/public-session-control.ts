/**
 * Runtime contract for the public, bearer-authenticated `/api/v1` projections
 * consumed outside the Takosumi dashboard.
 *
 * The decoder values live with the producing domain contract so clients do not
 * re-declare enums or silently trust generic JSON type arguments.
 */

import type { PublicCapsule } from "./capsules.ts";
import type { PublicRun, RunChangeSummary, RunStatus, RunType } from "./runs.ts";
import type { Workspace } from "./workspaces.ts";

export interface PublicSessionWireDecoder<T> {
  readonly document: string;
  readonly decode: (value: unknown) => T;
}

export type PublicSessionWorkspace = Pick<
  Workspace,
  | "id"
  | "handle"
  | "displayName"
  | "type"
  | "ownerUserId"
  | "createdAt"
  | "updatedAt"
>;

export type PublicSessionCapsule = Pick<
  PublicCapsule,
  | "id"
  | "workspaceId"
  | "projectId"
  | "name"
  | "slug"
  | "sourceId"
  | "installConfigId"
  | "environment"
  | "currentStateGeneration"
  | "status"
  | "createdAt"
  | "updatedAt"
>;

export type PublicSessionRun = Pick<
  PublicRun,
  | "id"
  | "workspaceId"
  | "capsuleId"
  | "type"
  | "status"
  | "requiresApproval"
  | "backupId"
  | "restoreStateGeneration"
  | "summary"
  | "errorCode"
  | "createdBy"
  | "createdAt"
  | "finishedAt"
>;

export interface PublicSessionWorkspacesResponse {
  readonly workspaces: readonly PublicSessionWorkspace[];
  readonly nextCursor?: string;
}

export interface PublicSessionCapsulesResponse {
  readonly capsules: readonly PublicSessionCapsule[];
  readonly nextCursor?: string;
}

export interface PublicSessionRunsResponse {
  readonly runs: readonly PublicSessionRun[];
  readonly nextCursor?: string;
}

export interface PublicSessionRunResponse {
  readonly run: PublicSessionRun;
}

export const PUBLIC_SESSION_WORKSPACES_RESPONSE_DECODER: PublicSessionWireDecoder<
  PublicSessionWorkspacesResponse
> = {
  document: "Takosumi public Workspace list",
  decode(value) {
    const body = requireRecord(value, "document");
    const nextCursor = optionalString(body.nextCursor, "nextCursor");
    return {
      workspaces: requireArray(body.workspaces, "workspaces").map(
        decodeWorkspace,
      ),
      ...(nextCursor === undefined ? {} : { nextCursor }),
    };
  },
};

export const PUBLIC_SESSION_CAPSULES_RESPONSE_DECODER: PublicSessionWireDecoder<
  PublicSessionCapsulesResponse
> = {
  document: "Takosumi public Capsule list",
  decode(value) {
    const body = requireRecord(value, "document");
    const nextCursor = optionalString(body.nextCursor, "nextCursor");
    return {
      capsules: requireArray(body.capsules, "capsules").map(decodeCapsule),
      ...(nextCursor === undefined ? {} : { nextCursor }),
    };
  },
};

export const PUBLIC_SESSION_RUNS_RESPONSE_DECODER: PublicSessionWireDecoder<
  PublicSessionRunsResponse
> = {
  document: "Takosumi public Run list",
  decode(value) {
    const body = requireRecord(value, "document");
    const nextCursor = optionalString(body.nextCursor, "nextCursor");
    return {
      runs: requireArray(body.runs, "runs").map(decodeRun),
      ...(nextCursor === undefined ? {} : { nextCursor }),
    };
  },
};

export const PUBLIC_SESSION_RUN_RESPONSE_DECODER: PublicSessionWireDecoder<
  PublicSessionRunResponse
> = {
  document: "Takosumi public Run response",
  decode(value) {
    const body = requireRecord(value, "document");
    return { run: decodeRun(body.run) };
  },
};

function decodeWorkspace(value: unknown): PublicSessionWorkspace {
  const workspace = requireRecord(value, "workspace");
  const type = workspace.type;
  if (type !== "personal" && type !== "organization") {
    throw new Error("workspace.type must be personal or organization");
  }
  return {
    id: requireString(workspace.id, "workspace.id"),
    handle: requireString(workspace.handle, "workspace.handle"),
    displayName: requireString(
      workspace.displayName,
      "workspace.displayName",
    ),
    type,
    ownerUserId: requireString(workspace.ownerUserId, "workspace.ownerUserId"),
    createdAt: requireString(workspace.createdAt, "workspace.createdAt"),
    updatedAt: requireString(workspace.updatedAt, "workspace.updatedAt"),
  };
}

function decodeCapsule(value: unknown): PublicSessionCapsule {
  const capsule = requireRecord(value, "capsule");
  const status = capsule.status;
  if (!isCapsuleStatus(status)) {
    throw new Error("capsule.status is unsupported");
  }
  return {
    id: requireString(capsule.id, "capsule.id"),
    workspaceId: requireString(capsule.workspaceId, "capsule.workspaceId"),
    projectId: requireString(capsule.projectId, "capsule.projectId"),
    name: requireString(capsule.name, "capsule.name"),
    slug: requireString(capsule.slug, "capsule.slug"),
    sourceId: requireString(capsule.sourceId, "capsule.sourceId"),
    installConfigId: requireString(
      capsule.installConfigId,
      "capsule.installConfigId",
    ),
    environment: requireString(capsule.environment, "capsule.environment"),
    currentStateGeneration: requireCount(
      capsule.currentStateGeneration,
      "capsule.currentStateGeneration",
    ),
    status,
    createdAt: requireString(capsule.createdAt, "capsule.createdAt"),
    updatedAt: requireString(capsule.updatedAt, "capsule.updatedAt"),
  };
}

function decodeRun(value: unknown): PublicSessionRun {
  const run = requireRecord(value, "run");
  const type = run.type;
  if (!isRunType(type)) throw new Error("run.type is unsupported");
  const status = run.status;
  if (!isRunStatus(status)) throw new Error("run.status is unsupported");
  const capsuleId = optionalString(run.capsuleId, "run.capsuleId");
  const requiresApproval = optionalBoolean(
    run.requiresApproval,
    "run.requiresApproval",
  );
  const summary =
    run.summary === undefined ? undefined : decodeRunSummary(run.summary);
  const backupId = optionalString(run.backupId, "run.backupId");
  const restoreStateGeneration = optionalCount(
    run.restoreStateGeneration,
    "run.restoreStateGeneration",
  );
  const errorCode = optionalString(run.errorCode, "run.errorCode");
  const finishedAt = optionalString(run.finishedAt, "run.finishedAt");
  return {
    id: requireString(run.id, "run.id"),
    workspaceId: requireString(run.workspaceId, "run.workspaceId"),
    ...(capsuleId === undefined ? {} : { capsuleId }),
    type,
    status,
    ...(requiresApproval === undefined ? {} : { requiresApproval }),
    ...(backupId === undefined ? {} : { backupId }),
    ...(restoreStateGeneration === undefined
      ? {}
      : { restoreStateGeneration }),
    ...(summary === undefined ? {} : { summary }),
    ...(errorCode === undefined ? {} : { errorCode }),
    createdBy: requireString(run.createdBy, "run.createdBy"),
    createdAt: requireString(run.createdAt, "run.createdAt"),
    ...(finishedAt === undefined ? {} : { finishedAt }),
  };
}

function decodeRunSummary(value: unknown): RunChangeSummary {
  const summary = requireRecord(value, "run.summary");
  const add = optionalCount(summary.add, "run.summary.add");
  const change = optionalCount(summary.change, "run.summary.change");
  const destroy = optionalCount(summary.destroy, "run.summary.destroy");
  return {
    ...(add === undefined ? {} : { add }),
    ...(change === undefined ? {} : { change }),
    ...(destroy === undefined ? {} : { destroy }),
  };
}

function isCapsuleStatus(
  value: unknown,
): value is PublicSessionCapsule["status"] {
  return (
    value === "pending" ||
    value === "active" ||
    value === "stale" ||
    value === "error" ||
    value === "disabled" ||
    value === "destroyed"
  );
}

function isRunStatus(value: unknown): value is RunStatus {
  return (
    value === "queued" ||
    value === "running" ||
    value === "waiting_approval" ||
    value === "succeeded" ||
    value === "failed" ||
    value === "cancelled" ||
    value === "expired"
  );
}

function isRunType(value: unknown): value is RunType {
  return (
    value === "source_sync" ||
    value === "compatibility_check" ||
    value === "plan" ||
    value === "apply" ||
    value === "destroy_plan" ||
    value === "destroy_apply" ||
    value === "drift_check" ||
    value === "backup" ||
    value === "restore"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(
  value: unknown,
  field: string,
): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${field} must be an object`);
  return value;
}

function requireArray(value: unknown, field: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  return value;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  return requireString(value, field);
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`${field} must be a boolean`);
  return value;
}

function requireCount(value: unknown, field: string): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw new Error(`${field} must be a non-negative integer`);
  }
  return value;
}

function optionalCount(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  return requireCount(value, field);
}
