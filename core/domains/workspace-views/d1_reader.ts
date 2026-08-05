import {
  clampPageLimit,
  decodeCursor,
  pageFromProbe,
  pageFromProbeBy,
  type Page,
} from "takosumi-contract/pagination";
import { deployControlD1TableNames as names } from "../../adapters/storage/drizzle/schema/logical.ts";
import type { D1Like } from "../resource-shape/d1_stores.ts";
import {
  projectWorkspaceCapsuleRow,
  projectWorkspaceResourceRow,
  type WorkspaceCapsuleProjectionRow,
  type WorkspaceResourceProjectionRow,
} from "./projection.ts";
import type {
  WorkspaceResourcesProjectionReader,
  WorkspaceResourceSummary,
} from "./service.ts";
import type { PublicCapsule } from "takosumi-contract/capsules";

export class D1WorkspaceResourcesProjectionReader
  implements WorkspaceResourcesProjectionReader
{
  constructor(private readonly db: D1Like) {}

  async read(
    input: Parameters<WorkspaceResourcesProjectionReader["read"]>[0],
  ): ReturnType<WorkspaceResourcesProjectionReader["read"]> {
    throwIfAborted(input.signal);
    if (!this.db.batch) {
      throw new Error("D1 workspace projection requires batch support");
    }
    const queries: {
      readonly kind: "resources" | "workloads";
      readonly statement: ReturnType<D1Like["prepare"]>;
    }[] = [];
    if (input.resources) {
      const cursor = decodeCursor(input.resources.cursor);
      const limit = clampPageLimit(input.resources.limit);
      queries.push({
        kind: "resources",
        statement: this.db
          .prepare(resourceSql(Boolean(cursor)))
          .bind(
            input.space,
            ...(cursor
              ? [
                  cursor.createdAt,
                  cursor.createdAt,
                  cursor.id,
                  limit + 1,
                ]
              : [limit + 1]),
          ),
      });
    }
    if (input.workloads) {
      const cursor = decodeCursor(input.workloads.cursor);
      const limit = clampPageLimit(input.workloads.limit);
      queries.push({
        kind: "workloads",
        statement: this.db
          .prepare(workloadSql(Boolean(cursor)))
          .bind(
            input.workspaceId,
            ...(cursor
              ? [
                  cursor.createdAt,
                  cursor.createdAt,
                  cursor.id,
                  limit + 1,
                ]
              : [limit + 1]),
          ),
      });
    }
    if (queries.length === 0) {
      return { resources: { items: [] }, workloads: { items: [] } };
    }
    const results = await this.db.batch(
      queries.map((query) => query.statement),
    );
    throwIfAborted(input.signal);
    if (
      results.length !== queries.length ||
      results.some((result) => !Array.isArray(result.results))
    ) {
      throw new Error("D1 workspace projection returned incomplete batch evidence");
    }
    let resources: Page<WorkspaceResourceSummary> = { items: [] };
    let workloads: Page<PublicCapsule> = { items: [] };
    queries.forEach((query, index) => {
      const rows = results[index]!.results!;
      if (query.kind === "resources") {
        const limit = clampPageLimit(input.resources!.limit);
        const page = pageFromProbeBy(
          rows as readonly WorkspaceResourceProjectionRow[],
          limit,
          (row) => ({ createdAt: row.created_at, id: row.id }),
        );
        resources = {
          items: page.items.map(projectWorkspaceResourceRow),
          ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
        };
      } else {
        const limit = clampPageLimit(input.workloads!.limit);
        const projected = (
          rows as readonly WorkspaceCapsuleProjectionRow[]
        ).map((row) => projectWorkspaceCapsuleRow(row, input.workspaceId));
        workloads = pageFromProbe(projected, limit);
      }
    });
    return { resources, workloads };
  }
}

function resourceSql(hasCursor: boolean): string {
  return `select
    r.id, r.space_id, r.project, r.environment, r.kind, r.name,
    r.managed_by, r.phase, r.observed_generation, r.labels_json, r.created_at,
    l.resource_id as resolution_resource_id,
    l.selected_implementation, l.target, l.locked, l.portability
  from ${names.resourceShapes} r
  left join ${names.resolutionLocks} l on l.resource_id = r.id
  where r.space_id = ?
    ${hasCursor ? "and (r.created_at > ? or (r.created_at = ? and r.id > ?))" : ""}
  order by r.created_at asc, r.id asc limit ?`;
}

function workloadSql(hasCursor: boolean): string {
  return `select record_json from ${names.capsules}
  where space_id = ? and status <> 'destroyed'
    ${hasCursor ? "and (created_at > ? or (created_at = ? and id > ?))" : ""}
  order by created_at asc, id asc limit ?`;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
}
