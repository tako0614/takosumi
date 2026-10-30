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

## Owner attribution and usage

An object under an app's `apps/{cap}` root is attributed to that Capsule;
every other object keeps the Workspace it has always been attributed to.
Nothing under `apps/` is looked up back to a Workspace.

- Retained-artifact facts (`TAKOSUMI_ARTIFACT_STORAGE_USAGE`,
  `worker/src/artifact-storage-usage.ts`) carry `{ capsuleId }` for an `apps/`
  state key, read from the key Core allocated from the persisted root, and
  `{ workspaceId }` for a legacy key, as before. The Runner no longer resolves
  an `apps/` key's Workspace from `capsules.space_id`.
- The complete stored-service profile (`StoredObjectOwner` in
  `worker/src/stored-service-usage.ts`) has the same two shapes. The owner
  resolver (`worker/src/stored-object-owner-resolver.ts`) takes an `apps/`
  object's Capsule from its ledger record: the StateVersion's Capsule, the Run's
  Capsule, the persisted Source's owner (a Source archive), or the backup's
  Capsule. The key alone is never proof, and an `apps/` Source archive whose
  Source row is gone is unresolvable rather than attributed to a Workspace.
  Every write path (`worker/src/stored-service-owner-context.ts`) pins the same
  owner, and a Source sync may write an `apps/` archive only under its Source's
  own owner prefix.
- A legacy object's context keeps exactly the shape and key order it had, so
  operation digests of intents already pending are unchanged. Private Run
  files stay Workspace-scoped until stage 9.5/9.6.
- A current pointer is matched against the root of the latest retained
  StateVersion's own key, not a root rebuilt from its Workspace column.

There is no production binding for either profile.

## Object metadata and Restore

- The Runner Durable Object reads a Capsule's state root back from the stateRef
  Core allocated from the persisted root, checked to be that Capsule's
  canonical root, and no longer rebuilds a legacy root from the dispatch's
  Workspace id. A legacy Capsule whose Workspace id moved keeps writing under
  its frozen root.
- Every new Capsule state object, Restore stage and staged recovery artifact
  carries `takosumi-capsule-id` and `takosumi-storage-root`. It still carries
  `takosumi-workspace-id`, so a rolled-back Worker can restore it, but that is
  no longer an owner proof.
- Restore, its acknowledgement, the Restore-origin source check and the Restore
  stage collector bind an object that names its root on that root alone. An
  object written before stage 9.1-f has no root and is bound by its
  `takosumi-workspace-id` as before: the key's Workspace segment or the source
  StateVersion's Workspace. An old `apps/` object has no Workspace in its key,
  so its Capsule id binds it; the Restore acknowledgement no longer reads the
  Run's Workspace for it.

## Storage-root check

`scripts/check-capsule-storage-roots.ts` is read-only. It lists every Capsule
row, destroyed ones included, and resolves its root exactly as the stores do:

- `apps` / `legacy`: a persisted canonical root;
- `derived`: no persisted root, resolved from the frozen scopeRef (else the
  Workspace id) by the fallback stage 9.5 removes. These rows must be 0 before
  the 9.5 bridge (backfill them with the ownership backfill);
- `unresolvable`: an invalid record, a root that is not the Capsule's own, or no
  usable scope. The tool exits 1 when any exist.

```ts
// /absolute/operator/storage-root-check.ts
import { CloudflareD1RestTransport } from "<repo>/deploy/cloudflare/d1-rest-transport.ts";
import { d1CapsuleStorageRootCheckTarget } from "<repo>/core/domains/capsules/storage_root_check.ts";

export async function openCapsuleStorageRootCheck() {
  const db = new CloudflareD1RestTransport({ accountId, databaseId, apiToken });
  return { target: d1CapsuleStorageRootCheckTarget(db) };
}
```

```bash
bun --no-env-file scripts/check-capsule-storage-roots.ts --adapter="$ADAPTER"
# review: total, byStatus, byRoot, derived, unresolvable, ok
```

Postgres uses `sqlCapsuleStorageRootCheckTarget(client)`. For a rehearsal,
point the D1 target at a local SQLite copy of an export. The test
`tests/core/domains/capsules/storage_root_check_test.ts` checks it against the
memory, Postgres and D1 stores' own `getCapsuleStorageRoot`. Running it
against staging or production reads that database and still needs the user's
prior approval. At planning time (2026-10-30) production had 58 Capsule rows
and staging 103, none with a null `storage_root`.

## What still reads the Workspace id

| Value | Owner stage |
| --- | --- |
| An existing Capsule's Source archive layout (the Source record's own Workspace id) | 9.5/9.6 |
| Stored-service profile only: the Restore acknowledgement of an `apps/` root reads the Run's Workspace to fill the runner scope, which `assertRunnerAllocation` compares with the Run; and the Capsule-row consistency checks in `storedCapsuleArtifactRoot` | 9.5 |
| Restore fence Durable Object name (`restoreRunnerObjectName`) | 9.1-f/9.5 (the serialized restore job carries no scope yet) |
| Staged state-recovery handle and custody digest | 9.5 |
| Private Run file scope, keys and AAD | 9.5/9.6 |

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
