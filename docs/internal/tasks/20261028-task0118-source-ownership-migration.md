# TASK-0118 Source ownership migration (Phase 2)

This is an operator-invoked, DDL-free migration for Sources created before one
Source belonged to one app. The route is `/internal/platform/source-ownership-migration`
and requires the existing deploy-control operator bearer. Nothing schedules it.
The D1 handler always uses `predeployed` schema mode, including dry-run.

The optional stored-service composition can run the read-only GET dry-run, but
POST apply returns `503 source_archive_custody_unavailable` before any R2 copy
or DB write. Its Runner reads require a matching physical stored-object usage
record, while this migration's raw R2 copier cannot create that record for a
new Source before its DB group commits. Migration in that composition is
deferred until a reviewed custody-aware copier and adoption sequence exist.
The ordinary OSS R2 path uses the copied archive after its size and digest
checks; it does not require a `takosumi-run-id` metadata field on the copy.

## Before an apply

1. Use the current reviewed release, hold the normal control-plane maintenance
   fence, and take a restorable Control DB and R2_SOURCE backup. Record the
   database and bucket identity, schema version, row counts, archive counts,
   backup digest, release commit, and operator identity outside the repo.
2. Run the read-only Phase 0 queries below on the target. The raw Phase 0 SQL
   mentioned by TASK-0118 is operator-local and was not available in this
   worktree; these are equivalent D1 queries against the current schema.
3. Review the dry-run for every Source. `blocked` means a live run, reconcile
   lease, inconsistent provenance, or another unsafe condition. Resolve it and
   repeat the dry-run. Obtain the independent review and the user's separate
   approval before staging or production data mutation.

```sh
TAKOSUMI_DEPLOY_CONTROL_TOKEN=... bun scripts/operator-source-ownership.ts \
  --base-url https://TARGET

TAKOSUMI_DEPLOY_CONTROL_TOKEN=... bun scripts/operator-source-ownership.ts \
  --base-url https://TARGET --source-id src_EXAMPLE
```

The JSON result has `kind`, `preparedAt`, `reportDigest`, and one `results[]`
item per Source. Each item has `inventory` (`action`, owner, live/destroyed app
IDs, split app IDs, snapshot count, archive bytes, foreign archive ref count,
in-flight IDs), `status`, `planDigest`, `copies`, and `bytes`. `planDigest` binds
the complete observed group and prepared mutation, including lanes, all
referenced plans and runs, and archive destinations. No credential or archive
contents are printed. The POST checks the report against the current group;
an intervening change returns `dry_run_changed`.
The reproducible local dry-run fixture is
`/root/dev/tmp/tk0118/phase2-migration-dry-run.json`; it covers exclusive,
live plus destroyed, all destroyed, orphan, shared live, and shared adopted
snapshot cases. It is fixture data, not a target inventory.

After reviewing one Source's dry-run, use that response's exact `preparedAt`
and `reportDigest`:

```sh
TAKOSUMI_DEPLOY_CONTROL_TOKEN=... bun scripts/operator-source-ownership.ts \
  --base-url https://TARGET --source-id src_EXAMPLE --apply \
  --prepared-at 2026-10-28T00:00:00.000Z \
  --report-digest sha256:EXACT_HEX_FROM_THAT_SOURCE_DRY_RUN
```

The mutation is per Source group. It backfills a sole live app as owner,
marks an all-destroyed or orphan Source disabled for the retirement sweeper,
or splits each extra live app into a new Source. For a split it copies the
app's adopted and referenced historical SourceSnapshots and their producer
SourceSync/compatibility-check Runs, repoints that app's Capsule, PlanRuns,
GitInstallPlans, InstallConfig snapshot pins, compatibility reports, and preflight evidence, and records
`source.split` Activity. The retained owner's `defaultRef/defaultPath` is set
from its adopted snapshot. A cloned Source's webhook verifier is disabled
until the operator rotates its secret; the old verifier is never duplicated.
The original compatibility report and producer Run remain as Source history,
with their moved Capsule association cleared after the app-specific clone is
created. Both resulting groups can be inventoried again without treating that
history as a foreign Capsule reference. InstallConfig rows are guarded with
the group and retain their other private fields.
The CLI automatically resumes verified archive copies in bounded POST batches
(at most 16 objects and 64 MiB per request) using a server-signed cursor bound
to the exact dry-run. If the CLI exits during copying, rerun the same reviewed
command from the beginning; existing destination objects are read back and
verified without overwrite. The DB group is committed only on the final batch.

Historical cross-Source archive refs are normalized even for a Source that is
not split. Each immutable archive is copied under its own Source prefix.
The copier checks the original bytes, creates the destination without
overwrite, then reads and hashes the destination. Only after all copies have
passed does the DB commit atomically guard and write the group. A failed copy
touches no DB row; an interrupted DB commit can leave verified extra copies,
which are safe to reuse on retry and should be inventoried for later cleanup.
No source archive is deleted by this tool. The daily retirement sweeper deletes
only after its own guards and custody checks succeed.

## Phase 0 and post-apply verification SQL (Control D1)

Run these read-only queries before and after the migration. Keep raw results
operator-local. `live_apps > 1`, `owner_mismatch`, cross-Source archive refs,
and live-app plan/snapshot mismatches should be zero after all groups are done.
The counts for all-destroyed and orphan Sources may remain until the sweeper
completes retirement.

```sql
WITH source_apps AS (
  SELECT s.id, s.status,
         COALESCE(json_extract(s.record_json, '$.autoSync'), 0) AS auto_sync,
         COUNT(c.id) AS app_refs,
         COALESCE(SUM(CASE WHEN c.status <> 'destroyed' THEN 1 ELSE 0 END), 0) AS live_apps
  FROM sources s LEFT JOIN capsules c ON c.source_id = s.id
  GROUP BY s.id
)
SELECT COUNT(*) AS sources,
       SUM(status = 'active') AS active_sources,
       SUM(auto_sync = 1) AS auto_sync_sources,
       SUM(status = 'active' AND auto_sync = 1) AS active_polling_sources,
       SUM(live_apps > 1) AS shared_live_sources,
       SUM(live_apps > 0 AND app_refs > live_apps) AS shared_live_destroyed_sources,
       SUM(app_refs > 0 AND live_apps = 0) AS all_destroyed_sources,
       SUM(app_refs = 0) AS orphan_sources,
       SUM(app_refs = 0 AND status = 'active' AND auto_sync = 1) AS polling_orphans,
       SUM(app_refs > 0 AND live_apps = 0 AND status = 'active' AND auto_sync = 1)
         AS polling_all_destroyed
FROM source_apps;

SELECT COUNT(*) AS snapshot_rows, COUNT(DISTINCT source_id) AS snapshot_sources
FROM source_snapshots;

SELECT COUNT(*) AS snapshots_used_by_multiple_apps FROM (
  SELECT json_extract(run_json, '$.sourceSnapshotId') AS snapshot_id
  FROM runs WHERE type IN ('plan', 'destroy_plan', 'drift_check')
    AND json_extract(run_json, '$.sourceSnapshotId') IS NOT NULL
  GROUP BY snapshot_id HAVING COUNT(DISTINCT installation_id) > 1
);

SELECT s.id AS source_id,
       COUNT(c.id) AS app_refs,
       COALESCE(SUM(CASE WHEN c.status <> 'destroyed' THEN 1 ELSE 0 END), 0) AS live_apps,
       json_extract(s.record_json, '$.ownerCapsuleId') AS owner_capsule_id,
       s.status, json_extract(s.record_json, '$.autoSync') AS auto_sync,
       json_extract(s.record_json, '$.retiringAt') AS retiring_at
FROM sources s LEFT JOIN capsules c ON c.source_id = s.id
GROUP BY s.id ORDER BY s.id;

SELECT COUNT(*) AS live_shared_sources FROM (
  SELECT s.id FROM sources s JOIN capsules c ON c.source_id = s.id
  WHERE c.status <> 'destroyed' GROUP BY s.id HAVING COUNT(*) > 1
);

SELECT source_id, COUNT(*) AS snapshot_rows,
       COALESCE(SUM(CAST(json_extract(record_json, '$.archiveSizeBytes') AS INTEGER)), 0)
         AS archive_bytes
FROM source_snapshots WHERE source_id IS NOT NULL
GROUP BY source_id ORDER BY snapshot_rows DESC, source_id LIMIT 20;

SELECT COUNT(*) AS owner_mismatch
FROM capsules c JOIN sources s ON s.id = c.source_id
WHERE c.status <> 'destroyed'
  AND COALESCE(json_extract(s.record_json, '$.ownerCapsuleId'), '') <> c.id;

SELECT COUNT(*) AS foreign_snapshot_archives FROM source_snapshots ss
JOIN sources s ON s.id = ss.source_id
WHERE substr(COALESCE(json_extract(ss.record_json, '$.archiveRef'),
                      json_extract(ss.record_json, '$.archiveObjectKey'), ''),
             1, length('workspaces/' || s.space_id || '/sources/' || s.id || '/snapshots/'))
  <> 'workspaces/' || s.space_id || '/sources/' || s.id || '/snapshots/';

SELECT COUNT(*) AS foreign_sync_run_archives FROM runs r
JOIN sources s ON s.id = r.source_id
WHERE r.type = 'source_sync'
  AND substr(COALESCE(json_extract(r.run_json, '$.archiveRef'), ''),
             1, length('workspaces/' || s.space_id || '/sources/' || s.id || '/snapshots/'))
  <> 'workspaces/' || s.space_id || '/sources/' || s.id || '/snapshots/';

SELECT COUNT(*) AS live_plan_snapshot_mismatch FROM runs r
JOIN capsules c ON c.id = r.installation_id AND c.status <> 'destroyed'
LEFT JOIN source_snapshots ss
  ON ss.id = json_extract(r.run_json, '$.sourceSnapshotId')
WHERE json_extract(r.run_json, '$.sourceSnapshotId') IS NOT NULL
  AND r.type IN ('plan', 'destroy_plan')
  AND (ss.id IS NULL OR ss.source_id <> c.source_id);

SELECT COUNT(*) AS live_git_plan_source_mismatch FROM git_install_plans p
JOIN capsules c ON c.id = json_extract(p.record_json, '$.capsuleId')
WHERE c.status <> 'destroyed' AND
  (COALESCE(json_extract(p.record_json, '$.sourceId'), '') <> c.source_id OR
   (json_extract(p.record_json, '$.preflight.sourceId') IS NOT NULL AND
    json_extract(p.record_json, '$.preflight.sourceId') <> c.source_id));
```

## Failure and recovery

`blocked` and `dry_run_changed` make no DB change. A copy error leaves no DB
change and the Worker log carries raw diagnostics; HTTP returns a stable error
without secret values. A DB conflict rolls the group back. Repeat a dry-run
and apply only after reviewing the new report. If a copy succeeded before a
DB conflict, its create-only digest check makes retry safe. If the target was
committed and later found incorrect, stop further groups, preserve evidence,
restore the reviewed DB/R2 backup under the normal maintenance fence, or make
an independently reviewed forward repair. Do not manually overwrite immutable
SourceSnapshot IDs or archive objects.
