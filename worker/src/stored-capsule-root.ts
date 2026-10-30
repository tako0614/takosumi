import { capsuleArtifactRoot } from "../../core/adapters/storage/artifact-references.ts";
import type { D1Database } from "./bindings.ts";
import { StoredServiceUsageError } from "./stored-service-usage.ts";

type Row = Record<string, unknown>;
async function rows(db: D1Database, sql: string, params: readonly unknown[]): Promise<readonly Row[]> {
  const result = await db.prepare(sql).bind(...params).all<Row>();
  if (result.success === false || !Array.isArray(result.results) || result.results.length > 8 ||
    (result.meta?.rows_read !== undefined && result.meta.rows_read > 4096)) throw new StoredServiceUsageError();
  return result.results;
}

/** Read the physical root from the primary D1 schema, including v75/v76 fallback. */
export async function storedCapsuleArtifactRoot(
  database: D1Database,
  workspaceId: string,
  capsuleId: string,
  environment?: string,
): Promise<string> {
  const db = "withSession" in database && typeof database.withSession === "function"
    ? database.withSession("first-primary") : database;
  const column = await rows(db,
    "select name from pragma_table_info('capsules') where name = 'storage_root'",
    []);
  if (column.length > 1) throw new StoredServiceUsageError();
  const hasRoot = column.length === 1;
  const capsuleRows = await rows(db,
    `select id, space_id, environment, record_json${hasRoot ? ", storage_root" : ""} from capsules where id = ? limit 2`,
    [capsuleId]);
  if (capsuleRows.length !== 1) throw new StoredServiceUsageError();
  const row = capsuleRows[0]!;
  if (typeof row.record_json !== "string" || row.record_json.length > 1024 * 1024) throw new StoredServiceUsageError();
  let capsule: Row;
  try {
    const parsed: unknown = JSON.parse(row.record_json);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    capsule = parsed as Row;
  } catch { throw new StoredServiceUsageError(); }
  if (row.id !== capsuleId || row.space_id !== workspaceId || capsule.id !== capsuleId ||
    capsule.workspaceId !== workspaceId || row.environment !== capsule.environment ||
    (environment !== undefined && row.environment !== environment)) throw new StoredServiceUsageError();
  const physical = hasRoot ? row.storage_root : undefined;
  if (physical !== null && physical !== undefined && typeof physical !== "string") throw new StoredServiceUsageError();
  // On v75/v76 there is no physical root authority. Old code could already
  // serialize an apps root into JSON, so keep the exact legacy allocation.
  // A nullable v77 row also retains its legacy root until backfill assigns one.
  // The physical column is the authority after expansion; legacy JSON may
  // still contain a root written before the schema bridge was corrected.
  // Without a physical root the legacy root was written under the Capsule's
  // frozen scope (`capsuleScopeRef`): its stored scopeRef, else its Workspace.
  const scopeRef = capsule.scopeRef === undefined ? workspaceId : capsule.scopeRef;
  if (typeof scopeRef !== "string" || scopeRef.length === 0) throw new StoredServiceUsageError();
  try {
    return capsuleArtifactRoot(scopeRef, capsuleId, physical ?? undefined);
  } catch {
    throw new StoredServiceUsageError();
  }
}
