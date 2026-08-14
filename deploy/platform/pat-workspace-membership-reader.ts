import type {
  PatWorkspaceMembershipReader,
} from "@takosjp/takosumi-accounts-service";
import type {
  WorkspaceMember,
  WorkspaceMemberStatus,
  WorkspaceRole,
} from "takosumi-contract/workspaces";

import { deployControlD1TableNames } from "../../core/adapters/storage/drizzle/schema/logical.ts";

interface WorkspaceMemberRow {
  readonly id: unknown;
  readonly workspace_id: unknown;
  readonly account_id: unknown;
  readonly status: unknown;
  readonly record_json: unknown;
  readonly created_at: unknown;
  readonly updated_at: unknown;
}

export interface ReadOnlyD1Database {
  prepare(query: string): ReadOnlyD1PreparedStatement;
}

interface ReadOnlyD1PreparedStatement {
  bind(...values: readonly unknown[]): ReadOnlyD1PreparedStatement;
  all<T = unknown>(): Promise<{
    readonly success?: boolean;
    readonly results?: readonly T[];
  }>;
}

export interface CloudflareD1PatWorkspaceMembershipReader
  extends PatWorkspaceMembershipReader {
  getMember(
    workspaceId: string,
    subject: Parameters<PatWorkspaceMembershipReader["getMember"]>[1],
  ): Promise<WorkspaceMember | undefined>;
}

/**
 * Read the one canonical Workspace membership required by the PAT self view.
 *
 * This intentionally bypasses the full deploy-control store: the latter owns
 * lazy schema/bootstrap work, while this authority check must remain one
 * bounded SELECT with no initialization or mutation path.
 */
export function createCloudflareD1PatWorkspaceMembershipReader(
  db: ReadOnlyD1Database,
): CloudflareD1PatWorkspaceMembershipReader {
  return {
    async getMember(workspaceId, subject) {
      const result = await db
        .prepare(
          `select id, workspace_id, account_id, status, record_json,
                  created_at, updated_at
             from ${deployControlD1TableNames.workspaceMembers}
            where workspace_id = ? and account_id = ?
            limit 2`,
        )
        .bind(workspaceId, subject)
        .all<WorkspaceMemberRow>();
      if (result.success !== true || !Array.isArray(result.results)) {
        throw new TypeError("Workspace membership evidence read failed");
      }
      if (result.results.length === 0) return undefined;
      if (result.results.length !== 1) {
        throw new TypeError(
          "Workspace membership evidence must contain exactly one row",
        );
      }

      const row = result.results[0];
      if (
        !row ||
        typeof row.id !== "string" ||
        row.workspace_id !== workspaceId ||
        row.account_id !== subject ||
        !isWorkspaceMemberStatus(row.status) ||
        !isCanonicalTimestamp(row.created_at) ||
        !isCanonicalTimestamp(row.updated_at)
      ) {
        throw new TypeError("Workspace membership evidence identity is invalid");
      }
      const record = parseWorkspaceMemberRecord(row.record_json);
      if (
        record.workspaceId !== workspaceId ||
        record.accountId !== subject ||
        record.id !== row.id ||
        record.status !== row.status ||
        record.createdAt !== row.created_at ||
        record.updatedAt !== row.updated_at
      ) {
        throw new TypeError("Workspace membership evidence identity is invalid");
      }
      return {
        id: record.id,
        workspaceId,
        accountId: subject,
        status: record.status,
        roles: record.roles,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      };
    },
  };
}

function parseWorkspaceMemberRecord(value: unknown): WorkspaceMember {
  let parsed: unknown;
  try {
    parsed = typeof value === "string" ? JSON.parse(value) : undefined;
  } catch {
    throw new TypeError("Workspace membership evidence is malformed");
  }
  if (
    !isRecord(parsed) ||
    typeof parsed.id !== "string" ||
    parsed.id.length === 0 ||
    typeof parsed.workspaceId !== "string" ||
    typeof parsed.accountId !== "string" ||
    !isWorkspaceMemberStatus(parsed.status) ||
    !Array.isArray(parsed.roles) ||
    !parsed.roles.every(isWorkspaceRole) ||
    new Set(parsed.roles).size !== parsed.roles.length ||
    !isCanonicalTimestamp(parsed.createdAt) ||
    !isCanonicalTimestamp(parsed.updatedAt)
  ) {
    throw new TypeError("Workspace membership evidence is malformed");
  }
  return {
    id: parsed.id,
    workspaceId: parsed.workspaceId,
    accountId: parsed.accountId,
    status: parsed.status,
    roles: parsed.roles as WorkspaceRole[],
    createdAt: parsed.createdAt,
    updatedAt: parsed.updatedAt,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isWorkspaceRole(value: unknown): value is WorkspaceRole {
  return (
    value === "owner" ||
    value === "admin" ||
    value === "member" ||
    value === "viewer"
  );
}

function isWorkspaceMemberStatus(
  value: unknown,
): value is WorkspaceMemberStatus {
  return value === "active" || value === "invited" || value === "suspended";
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}
