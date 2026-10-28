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
    select source_id, snapshot_json ->> 'sourceId' as json_source_id,
      coalesce(snapshot_json ->> 'archiveRef', snapshot_json ->> 'archiveObjectKey') as ref
      from takosumi_source_snapshots
    union all
    select source_id, run_json ->> 'sourceId' as json_source_id,
      coalesce(run_json ->> 'archiveRef', run_json ->> 'archiveObjectKey') as ref
      from takosumi_runs where kind = 'source_sync'
  )
  select 'foreign_reference' as blocker from refs
   where (refs.source_id is distinct from $1 or refs.json_source_id is distinct from $1)
     and left(refs.ref, length($2)) = $2
     and not coalesce((
       refs.source_id is not null and refs.source_id = refs.json_source_id
       and (
         exists (select 1 from takosumi_sources s where s.id = refs.source_id
           and s.status = 'disabled' and s.source_json ->> 'status' = 'disabled'
           and s.source_json ->> 'id' = s.id
           and s.source_json ->> 'workspaceId' = s.space_id
           and s.source_json ->> 'autoSync' = 'false'
           and nullif(s.source_json ->> 'retiringAt', '') is not null
           and (nullif(s.source_json ->> 'ownerCapsuleId', '') is null
             or exists (select 1 from takosumi_capsules owner
               where owner.id = s.source_json ->> 'ownerCapsuleId'
                 and owner.space_id = s.space_id and owner.source_id = s.id
                 and owner.status = 'destroyed'
                 and owner.installation_json ->> 'id' = owner.id
                 and owner.installation_json ->> 'workspaceId' = owner.space_id
                 and owner.installation_json ->> 'sourceId' = owner.source_id
                 and owner.installation_json ->> 'status' = 'destroyed')))
         or (not exists (select 1 from takosumi_sources s where s.id = refs.source_id)
           and exists (select 1 from takosumi_audit_events a
             where a.action = 'source.retired' and a.target_type = 'source'
               and a.target_id = refs.source_id))
       )
       and not exists (select 1 from takosumi_capsules c
         where (c.source_id = refs.source_id
           or c.installation_json ->> 'sourceId' = refs.source_id
           or c.id = (select s.source_json ->> 'ownerCapsuleId'
             from takosumi_sources s where s.id = refs.source_id))
           and not coalesce((c.status = 'destroyed' and c.installation_json ->> 'status' = 'destroyed'
             and c.installation_json ->> 'id' = c.id
             and c.installation_json ->> 'workspaceId' = c.space_id
             and c.installation_json ->> 'sourceId' = refs.source_id
             and c.source_id = refs.source_id), false))
       and not exists (select 1 from takosumi_runs r
         where (r.status in ('queued', 'running')
           or r.run_json ->> 'status' in ('queued', 'running'))
           and (r.source_id = refs.source_id or r.run_json ->> 'sourceId' = refs.source_id
             or r.installation_id in (select c.id from takosumi_capsules c
               where c.source_id = refs.source_id
                 or c.installation_json ->> 'sourceId' = refs.source_id)
             or r.run_json ->> 'capsuleId' in (select c.id from takosumi_capsules c
               where c.source_id = refs.source_id
                 or c.installation_json ->> 'sourceId' = refs.source_id)))
     ), false)
   limit 1`;

export const POSTGRES_SOURCE_RETIREMENT_ARCHIVE_REFS_PAGE_QUERY = `
  select distinct ref from (
    select coalesce(snapshot_json ->> 'archiveRef', snapshot_json ->> 'archiveObjectKey') as ref
      from takosumi_source_snapshots where source_id = $1
    union all
    select coalesce(run_json ->> 'archiveRef', run_json ->> 'archiveObjectKey') as ref
      from takosumi_runs where kind = 'source_sync' and source_id = $1
  ) archive_refs where ref is not null and left(ref, length($4)) = $4
    and ($2::text is null or ref > $2)
  order by ref limit $3`;
