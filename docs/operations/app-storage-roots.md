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
| Backup sidecars of a backup labelled with the Capsule | `apps/{cap}/backups/{backup}/…` | `workspaces/{ws of its frozen root}/backups/{backup}/…` (unchanged) | Workspace export: `workspaces/{ws}/backups/…` |
| Source archives of the app's own Source | `apps/{cap}/sources/{src}/snapshots/{snap}/source.tar.zst`, behind `TAKOSUMI_APP_SOURCE_ARCHIVE_ROOTS` | `workspaces/{ws}/sources/…` (unchanged) | Workspace Source: `workspaces/{ws}/sources/…` |
| Resource-subject state | — | — | `workspaces/{ws}/resources/…`; Core allocates none |

- The allocator is `ObjectKeyArtifactReferenceAllocator`
  (`core/adapters/storage/artifact-references.ts`). Core passes the owner
  Capsule and its trusted root (`getCapsuleStorageRoot`) as `owner`. A root
  that is not that Capsule's canonical root is refused, as for state.
- An install reservation syncs its Source before the Capsule exists. That
  Capsule is created with exactly `apps/{reserved id}`, so the first archive
  already goes there.
- An existing Capsule's backup follows the Workspace segment of its frozen root,
  never the live Workspace id. Its Source's archives keep the Source record's
  own Workspace id: a Source has no scopeRef, and no stage before the schema
  contract moves that value.
- `tests/deploy/platform/capsule_scope_ref_golden_test.ts` pins the legacy keys
  as origin/main `e71daf8e6` produced them, through the real callers, for the
  legacy, backfilled and moved-Workspace spellings.
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
only behind `TAKOSUMI_APP_SOURCE_ARCHIVE_ROOTS`:

1. Release a Runner image that contains this change and configure it.
2. Deploy the Worker (default `disabled`: archives keep the Workspace layout;
   backups of a new app already go under `apps/{cap}`, written by the Worker).
3. Set `TAKOSUMI_APP_SOURCE_ARCHIVE_ROOTS=enabled` (platform Worker; the
   Postgres reference server reads the same variable).

Rollback: setting the variable back to `disabled` (or unsetting it) stops new
`apps/` archives; existing ones stay readable and retirable. Returning to a
Worker or Runner image from before this change cannot read an `apps/` archive:
a Plan restoring one fails with `unsafe source archive object key`, and a new
Source sync allocates a Workspace-layout archive again. A backup already
written under `apps/{cap}` stays readable by older code, because backup
references are opaque.

Running any of this against staging or production is a deploy and needs the
user's prior approval.
