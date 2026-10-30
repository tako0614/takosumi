# App storage roots: storage without Workspace

TASK-0118 Phase 9, stage 9.1-f. A Capsule created after ownership expansion
has the persisted `storage_root` `apps/{capsuleId}`; an existing Capsule keeps
the legacy `workspaces/{ws}/capsules/{cap}` root the ownership backfill froze.
Objects never move and every stored reference stays opaque. This page records
which keys follow the root, how the change is rolled out, and what still reads
the Workspace id. It is a code change with local fixture verification; it does
not authorize a staging or production operation.

## Which keys follow the root

| Object | New app (`apps/{cap}` root) | Existing Capsule (legacy root) | No Capsule |
| --- | --- | --- | --- |
| OpenTofu state, raw output, Restore stage (since 9.0) | `apps/{cap}/environments/…`, `apps/{cap}/runs/…` | under its frozen root | — |
| Backup sidecars of an app-scoped backup (`scope: "capsule"`) | `apps/{cap}/backups/{backup}/…` | `workspaces/{ws of its frozen root}/backups/{backup}/…` | Workspace export, labelled or not: `workspaces/{ws}/backups/…` |
| Source archives of the app's own Source | `apps/{cap}/sources/{src}/snapshots/{snap}/source.tar.zst`, behind `TAKOSUMI_APP_SOURCE_ARCHIVE_ROOTS` | `workspaces/{ws}/sources/…` (unchanged) | Workspace Source: `workspaces/{ws}/sources/…` |
| Resource-subject state | — | — | `workspaces/{ws}/resources/…`; Core allocates none |

- The allocator is `ObjectKeyArtifactReferenceAllocator`
  (`core/adapters/storage/artifact-references.ts`). Core passes the owner
  Capsule and its trusted root (`getCapsuleStorageRoot`) as `owner`. A root
  that is not that Capsule's canonical root is refused, as for state.
- An install reservation syncs its Source before the Capsule exists. That
  Capsule is created with exactly `apps/{reserved id}`, so the first archive
  already goes there.
- Only an app-scoped export belongs to the app. Both app backup routes (the
  public `POST /api/v1/capsules/{id}/backups` and the internal capsule route)
  send `scope: "capsule"`, and the export then carries only that app's
  records: its Capsule, Source and snapshots, InstallConfig, provider bindings
  and the connections they or its Source use, StateVersions and their sealed
  state, Outputs, its own Activity (events that name the app or its Source and
  no other app), security findings, usage events and backups. RunGroups and the
  Workspace record are left out. Before this, the app routes sent no `scope`
  and exported the whole Workspace. A Workspace export labelled with a Capsule
  stays in the Workspace layout.
- Not yet changed, for a future app-level restore: the restore path picks its
  Capsule as `request.capsuleId ?? backup.capsuleId`
  (`core/domains/deploy-control/run-engine/run_engine.ts`). An app-level
  restore must instead be bound to the backup's own `capsuleId` and capsule
  scope, and refuse a Workspace export or another app's backup, so one app's
  restore can never apply another app's state.
- An existing Capsule's app-scoped backup follows the Workspace segment of its
  frozen root, never the live Workspace id. For a Capsule whose Workspace id
  has not moved that is exactly origin/main's key; once the Workspace id moves
  it deliberately differs from main, which keyed new backups by the live
  Workspace id. Its Source's archives keep the Source record's own Workspace
  id: a Source has no scopeRef, and no stage before the schema contract moves
  that value.
- `tests/deploy/platform/capsule_scope_ref_golden_test.ts` pins the legacy keys
  as origin/main `e71daf8e6` produced them, through the real callers, for the
  legacy and backfilled spellings, and the deliberate difference for the
  moved-Workspace spelling.
  `tests/core/adapters/storage/app_storage_roots_parity_test.ts` checks the new
  and the unchanged keys through the memory, Postgres (PGlite) and D1 (SQLite)
  stores.

## Source archive custody

A Source's deletion custody covers exactly `sourceArchiveCustodyPrefixes`:
`apps/{owner}/sources/{src}/snapshots/` for an app-owned Source, then
`workspaces/{ws}/sources/{src}/snapshots/`. The owner always comes from the
persisted Source, never from a request. Retirement walks both prefixes with one
ascending cursor (`apps/` sorts before `workspaces/`), so a page can continue
from one prefix into the next. A live reference from another Source to a key
under either prefix still blocks retirement. The same prefixes are accepted by
the Runner Durable Object (retirement batch and unused-archive cleanup), by the
local runner, by the source ownership migration, which keeps an app-owned
Source's own `apps/` archive canonical, and by the operator release activator.
The custody prefixes and validators accept `apps/` whether or not the flag is
on, so turning it off again never strands an archive.

## Rollout

The Runner image validates the archive key it writes (`runner/lib/policy.ts`),
and an image built before this change refuses `apps/` keys. The platform
deploy may pin an image older than the Worker commit, so Source archives move
only behind `TAKOSUMI_APP_SOURCE_ARCHIVE_ROOTS`, and only once the Runner
confirms it:

- **Automatic precondition.** With the variable `enabled`, the Worker still
  allocates an `apps/` archive only after its configured Runner advertised
  `takosumi.app-source-archive-roots@v1` on `/healthz` (probed through the
  Runner Durable Object's owner-free `GET /runner-capabilities`, which
  dispatches nothing). The probe is bounded at 5 seconds, so a stuck container
  cold start never holds up the install or sync that asked. A confirmation is
  kept for the isolate; a refusal, timeout or unavailable probe keeps the
  Workspace layout and is asked again after 60 seconds. The Postgres reference server probes its Runner the same way. The
  generic `core/index.ts` entry has no Runner to ask and never moves archives.

1. Release a Runner image that contains this change and configure it.
2. Deploy the Worker (default `disabled`: archives keep the Workspace layout;
   app-scoped backups of a new app already go under `apps/{cap}`, written by
   the Worker).
3. Set `TAKOSUMI_APP_SOURCE_ARCHIVE_ROOTS=enabled` through the full platform
   deploy lane (`bun run deploy -- takosumi-platform…`), as a reviewed config
   change of that release. The platform Worker carries the Runner Container:
   never set it with `wrangler versions secret put` or any other out-of-lane
   variable change, which creates a version without the Container binding.
   The Postgres reference server reads the same variable.

Rollback:

- Setting the variable back to `disabled` (or unsetting it), again through the
  deploy lane, stops new `apps/` archives; existing ones stay readable and
  retirable.
- Returning to a Worker or Runner image from before this change cannot read an
  `apps/` archive: a Plan restoring one fails with
  `unsafe source archive object key`, and a new Source sync allocates a
  Workspace-layout archive again.
- **Orphans below this change.** Older code's Source retirement lists only the
  Workspace prefix. A Source retired while the platform runs code below this
  change leaves its `apps/` archives in R2 with no ledger reference; returning
  to this code cannot find them again, because their snapshot and Run rows are
  gone. Before such a rollback, disable the variable and let in-flight
  retirements finish, or plan to remove those objects from the storage
  inventory afterwards.
- A backup already written under `apps/{cap}` stays readable by older code,
  because backup references are opaque.
- An unused `apps/` archive whose Source has since disappeared can no longer be
  proven to be in custody. Its cleanup ends with a warning
  (`SourceSync unused archive cleanup skipped`) instead of failing on every
  redelivery; the object is left for the storage inventory.

Running any of this against staging or production is a deploy and needs the
user's prior approval.
