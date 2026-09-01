import type { PublicCapsule } from "takosumi-contract/capsules";
import {
  clampPageLimit,
  decodeCursor,
  pageFromProbe,
  pageFromProbeBy,
  type Page,
} from "takosumi-contract/pagination";
import { deployControlPostgresTableNames as names } from "../../adapters/storage/drizzle/schema/logical.ts";
import type { SqlClient, SqlValue } from "../../adapters/storage/sql.ts";
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
import { throwIfAborted } from "./abort.ts";

export class SqlWorkspaceResourcesProjectionReader
  implements WorkspaceResourcesProjectionReader
{
  constructor(private readonly client: SqlClient) {}

  async read(
    input: Parameters<WorkspaceResourcesProjectionReader["read"]>[0],
  ): ReturnType<WorkspaceResourcesProjectionReader["read"]> {
    throwIfAborted(input.signal);
    const resourcesRead = input.resources
      ? this.#readResources(input.space, input.resources)
      : Promise.resolve({ items: [] } as Page<WorkspaceResourceSummary>);
    const workloadsRead = input.workloads
      ? this.#readWorkloads(input.workspaceId, input.workloads)
      : Promise.resolve({ items: [] } as Page<PublicCapsule>);
    const [resources, workloads] = await Promise.all([
      resourcesRead,
      workloadsRead,
    ]);
    throwIfAborted(input.signal);
    return { resources, workloads };
  }

  async #readResources(
    space: string,
    page: NonNullable<
      Parameters<WorkspaceResourcesProjectionReader["read"]>[0]["resources"]
    >,
  ): Promise<Page<WorkspaceResourceSummary>> {
    const cursor = decodeCursor(page.cursor);
    const limit = clampPageLimit(page.limit);
    const parameters: SqlValue[] = cursor
      ? [space, cursor.createdAt, cursor.id, limit + 1]
      : [space, limit + 1];
    const result = await this.client.query<WorkspaceResourceProjectionRow>(
      resourceSql(Boolean(cursor), parameters.length),
      parameters,
    );
    const probed = pageFromProbeBy(result.rows, limit, (row) => ({
      createdAt: row.created_at,
      id: row.id,
    }));
    return {
      items: probed.items.map(projectWorkspaceResourceRow),
      ...(probed.nextCursor ? { nextCursor: probed.nextCursor } : {}),
    };
  }

  async #readWorkloads(
    workspaceId: string,
    page: NonNullable<
      Parameters<WorkspaceResourcesProjectionReader["read"]>[0]["workloads"]
    >,
  ): Promise<Page<PublicCapsule>> {
    const cursor = decodeCursor(page.cursor);
    const limit = clampPageLimit(page.limit);
    const parameters: SqlValue[] = cursor
      ? [workspaceId, cursor.createdAt, cursor.id, limit + 1]
      : [workspaceId, limit + 1];
    const result = await this.client.query<WorkspaceCapsuleProjectionRow>(
      workloadSql(Boolean(cursor), parameters.length),
      parameters,
    );
    return pageFromProbe(
      result.rows.map((row) => projectWorkspaceCapsuleRow(row, workspaceId)),
      limit,
    );
  }
}

function resourceSql(hasCursor: boolean, limitIndex: number): string {
  return `select
    r.id, r.space_id, r.project, r.environment, r.kind, r.name,
    r.managed_by, r.phase, r.observed_generation, r.labels_json, r.created_at,
    l.resource_id as resolution_resource_id,
    l.selected_implementation, l.target, l.locked, l.portability
  from ${names.resourceShapes} r
  left join ${names.resolutionLocks} l on l.resource_id = r.id
  where r.space_id = $1
    ${hasCursor ? "and (r.created_at > $2 or (r.created_at = $2 and r.id > $3))" : ""}
  order by r.created_at asc, r.id asc limit $${limitIndex}`;
}

function workloadSql(hasCursor: boolean, limitIndex: number): string {
  return `select installation_json as record_json from ${names.capsules}
  where space_id = $1 and status <> 'destroyed'
    ${hasCursor ? "and (created_at > $2 or (created_at = $2 and id > $3))" : ""}
  order by created_at asc, id asc limit $${limitIndex}`;
}
