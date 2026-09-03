import type {
  PatWorkspaceMembershipReader,
} from "@takosjp/takosumi-accounts-service";
import type { WorkspaceMember } from "takosumi-contract/workspaces";

import { deployControlD1TableNames } from "../../core/adapters/storage/drizzle/schema/logical.ts";
import { workspaceMemberFromRow } from "../../core/domains/deploy-control/store_row_mappers.ts";
import type { FencedControlDatabase } from "./fenced-control-database.ts";

export type {
  FencedControlDatabase,
  ReadOnlyD1Database,
  ReadOnlyD1PreparedStatement,
} from "./fenced-control-database.ts";

interface WorkspaceMemberRow {
  readonly id: unknown;
  readonly workspace_id: unknown;
  readonly account_id: unknown;
  readonly status: unknown;
  readonly record_json: unknown;
  readonly created_at: unknown;
  readonly updated_at: unknown;
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
 *
 * What it must NOT bypass is the operator maintenance fence, which is why the
 * parameter is a {@link FencedControlDatabase} rather than the raw binding: the
 * fence is a property of the binding this reader is handed, so an unfenced
 * composition does not compile.
 */
export function createCloudflareD1PatWorkspaceMembershipReader(
  db: FencedControlDatabase,
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
      if (!row) {
        throw new TypeError("Workspace membership evidence identity is invalid");
      }
      return workspaceMemberFromRow(
        {
          id: row.id,
          workspaceId: row.workspace_id,
          accountId: row.account_id,
          status: row.status,
          recordJson: row.record_json,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        },
        { workspaceId, accountId: subject },
      );
    },
  };
}
