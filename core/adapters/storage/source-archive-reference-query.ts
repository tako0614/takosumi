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

/** Physical legacy archive aliases stay in the storage adapter. */
export const POSTGRES_SOURCE_RETIREMENT_ARCHIVE_BLOCKER_QUERY = `
  with refs as (
    select source_id, coalesce(snapshot_json ->> 'archiveRef', snapshot_json ->> 'archiveObjectKey') as ref
      from takosumi_source_snapshots
    union all
    select source_id, coalesce(run_json ->> 'archiveRef', run_json ->> 'archiveObjectKey') as ref
      from takosumi_runs where kind = 'source_sync'
  )
  select blocker from (
    select 'outside_scope' as blocker, 0 as priority from refs
      where source_id = $1 and (ref is null or left(ref, length($2)) <> $2)
    union all
    select 'foreign_reference' as blocker, 1 as priority from refs
      where source_id is distinct from $1 and left(ref, length($2)) = $2
  ) blockers order by priority limit 1`;

export const POSTGRES_SOURCE_RETIREMENT_ARCHIVE_REFS_PAGE_QUERY = `
  select distinct ref from (
    select coalesce(snapshot_json ->> 'archiveRef', snapshot_json ->> 'archiveObjectKey') as ref
      from takosumi_source_snapshots where source_id = $1
    union all
    select coalesce(run_json ->> 'archiveRef', run_json ->> 'archiveObjectKey') as ref
      from takosumi_runs where kind = 'source_sync' and source_id = $1
  ) archive_refs where ref is not null and ($2::text is null or ref > $2)
  order by ref limit $3`;
