/** Physical JSON aliases are storage custody details, never public Source contracts. */
export const POSTGRES_FOREIGN_SOURCE_ARCHIVE_REFERENCE_QUERY = `
  select 1 from takosumi_source_snapshots
   where source_id is distinct from $2
     and coalesce(snapshot_json ->> 'archiveRef', snapshot_json ->> 'archiveObjectKey') = $1
  union all
  select 1 from takosumi_runs
   where kind = 'source_sync' and source_id is distinct from $2
     and coalesce(run_json ->> 'archiveRef', run_json ->> 'archiveObjectKey') = $1
  limit 1`;
