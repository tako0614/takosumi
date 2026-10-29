# App ownership expansion and backfill

TASK-0118 Phase 3 adds D1 v77 (`d1_app_ownership`) and Postgres v123.
The migrations only add nullable/defaulted columns and two tables. The owner,
slug, environment uniqueness constraint belongs to Phase 9; this tool reports
collisions and never renames apps. The Postgres expansion also adds the physical
nullable `slug` column, which previously existed only in Capsule JSON.

Run the schema owner's normal predeploy procedure separately. This backfill
does not run DDL. D1 v75/v76 continue to use Workspace-derived management access
until the schema and owner rows are available. This is a code change and local
fixture verification; it does not authorize a staging or production operation.

The operator composes a local module exporting `openOwnershipBackfill()`, which
returns `{ control, ownership, workspaceMutationsFrozen?, close? }`. `control` is the target's existing
`OpenTofuControlStore`; `ownership` is `SqlAppOwnershipStore(client, control)` or
`D1AppOwnershipStore(db, control)`. Use read-only credentials for dry-run where
available. The module owns connection setup and private credential loading;
the script never discovers targets or credentials. Do not put credentials in
the module, CLI arguments, report, or URL.

```sh
bun scripts/backfill-app-ownership.ts --adapter=/absolute/operator/ownership-target.ts --dry-run
bun scripts/backfill-app-ownership.ts --adapter=/absolute/operator/ownership-target.ts --apply --plan-digest=sha256:<reviewed-digest> --batch-size=100
```

Dry-run reads all Workspace rows, including archived ones, and all Capsules. It
reports Capsules whose Workspace is missing and usage events whose Capsule is
missing or belongs to another Workspace. These reports are included in the plan
digest. Orphan Capsules are skipped without owner inference, so valid rows can
still progress. Unresolved usage payer records stop apply until repaired and a
new dry-run is reviewed. No payer is guessed for unresolved app usage. The dry-run emits a private
inventory and digest. Owners come from `ownerUserId`. Active owner/admin members
other than the owner become app members; member/viewer, invited and suspended
rows are reported for confirmation and never migrated automatically. Connections
take the Workspace owner, while operator connections retain no personal owner.
Usage tied to a never-transferred Capsule (`ownership_epoch = 0`) takes that
app's owner; only usage without a Capsule falls back to the Workspace owner.
Payer-less usage of a transferred app is never assigned: the current owner is
not its historical payer. Dry-run lists it under `transferredAppUsage`. That
report does not block apply, and re-running the tool leaves the rows
unattributed. Legacy storage roots remain
`workspaces/{workspaceId}/capsules/{capsuleId}`; no R2 object moves. New apps use
`apps/{capsuleId}`. Existing explicit ownership, epochs and app rosters survive.

State, run artifacts and raw outputs for a new app are allocated below its
persisted `apps/{capsuleId}` root. The Runner validates the allocated state
reference before deriving sibling keys, and the stored-service write gate
checks the physical Capsule root in D1. A Capsule without a stored root keeps
its exact Workspace prefix, including on D1 v75/v76. Retained StateVersion
keys remain readable after deletion; this cutover does not copy R2 objects.
Operator recovery adapters must resolve the persisted Capsule root before
staging a new generation-one state.

Account billing bindings reuse the existing `workspaceRef` as `billingRef`.
Multiple incompatible retained bindings for one account are reported and left
for operator resolution. The backfill does not call a billing authority or
change its immutable rows. Billing launch remains stopped under TASK-0109.

Apply requires the operator adapter to set `workspaceMutationsFrozen: true` only
after it has verified the target's live Workspace mutation freeze. A missing or
false value is rejected; dry-run needs no freeze. The adapter must keep that
freeze in force across every batch. There is no CLI switch that substitutes for
this target-specific verification.

Apply re-reads the inventory and requires its digest to match the reviewed
dry-run. Each invocation writes at most 100 rows serially. Re-run dry-run and
review its new digest for the next batch; a completed run has no pending writes.
If a write fails, previously committed rows remain, the tool stops, and a new
dry-run identifies remaining work. Organization Workspace creation and
membership mutations must remain frozen throughout this operation. Keep
app-owner/member writers stopped until backfill completes; the tool is an expand-phase operator operation,
not a concurrent ownership-transfer transaction. Verify each new owner/member,
connection owner and usage payer before authorization switches in Phase 6.

Complete and verify this backfill before enabling or accepting **any ownership
transfer**. Only this migration may infer a missing historical usage payer;
ordinary usage writes preserve an absent payer. After a transfer, the current
owner cannot prove who owed an old unattributed measurement or Plan settlement.
The tool therefore skips every transferred app's payer-less usage, so re-running
it after a transfer cannot turn intentionally unattributed rows into charges.

The freeze permits only canonical, authenticated owner-bound personal Workspace
singleton bootstrap for a fresh account. Organization creation and membership
mutations stay frozen; the bootstrap cannot select an arbitrary owner.

## Phase 6b authorization cutover check

Phase 6b switches app management authorization from Workspace membership to
the app's owner/member role. The code keeps the old Workspace decision for any
Capsule without an ownership row, so a v75/v76 target and Capsules the backfill
has not reached behave exactly as before. Once a Capsule has an ownership row,
only its owner and members can manage it. The rollout gate is "no unexpected
difference between the two rules", checked read-only instead of by sampling
production traffic.

```sh
bun scripts/verify-app-access-cutover.ts --adapter=/absolute/operator/ownership-target.ts
bun scripts/verify-app-access-cutover.ts --adapter=/absolute/operator/ownership-target.ts --fail-on-difference
```

It uses the same operator adapter module as the backfill
(`openOwnershipBackfill()`), never writes, needs no mutation freeze and ignores
`workspaceMutationsFrozen`. Use read-only credentials where available. It
compares three access classes (`view`, `manage`, `owner_only`) between the
legacy Workspace decision and what the deployed per-app code decides:

- For a Capsule that already has an ownership row, exactly that row's owner
  and its active `capsule_members` (what the live resolver reads).
- For a Capsule without a row, the backfill's projection (Workspace owner
  becomes the owner, active owner/admin members become members). It can
  therefore run before the backfill (including on D1 v75), during it and after
  it, and shows what the cutover code will decide once every app has its row.
  Until the backfill writes an app's row, the live code still uses the
  Workspace decision for that app, so run the check after the backfill (step 4
  below) for the result the cutover will actually enforce.
- Every Source used by live apps: its `ownerCapsuleId`, or every live Capsule
  built from an ownerless Source. Every one of those apps must allow, each
  under its own rule (an app with a row by its roster, an app without a row by
  the projection); a Source of apps with and without rows is reported with
  `ownershipSource: "mixed"`.
- The legacy read rule lets every active Workspace member read, including
  members with no or unknown roles.

The JSON report lists `differences` (`capsuleId` or `sourceId`) with a `reason`:

- `workspace_reader_not_app_member`: an active Workspace member/viewer (or
  role-less member) could read the app; they are not migrated and lose access.
  Confirm or add them as app members before the cutover.
- `workspace_manager_not_app_owner`: a Workspace owner/admin who is an app
  member loses owner-only actions (uninstall, transfer, member management).
- `workspace_manager_not_app_member`: a Workspace owner/admin is outside the
  app's roster (a new or transferred app, or an owner row written before its
  member rows) and loses the app.
- `app_role_beyond_workspace_role`: a Workspace member/viewer who is an app
  owner/member gains management.
- `app_role_without_workspace_role`: an app owner/member without Workspace
  membership gains the app (for example after a transfer).

`affectsBothRequiredCredentials: true` marks differences that also apply to
installed-app OAuth tokens and `requireCurrentMembership` compositions, which
need both decisions; they never gain access.

### Order and preconditions

1. Complete the Source ownership migration
   ([source-ownership-migration.md](./source-ownership-migration.md)) where
   possible. Ownerless Sources keep working (they belong to every live app
   built from them), but a Source shared by several apps then needs every one
   of those apps to allow each action.
2. Apply the D1 v77/v78 (Postgres v123) schema.
3. Run the backfill to completion (every batch, until a dry-run reports no
   pending writes) with Workspace mutations frozen. Backfill writes a Capsule's
   owner row and its member rows as separate writes, possibly in different
   batches. If the cutover code is already deployed, an owner/admin who will be
   migrated as an app member is locked out of that app between the owner write
   and the member write. Run the backfill in the maintenance window **before**
   deploying the cutover release, or accept that window.
4. Run this tool (expect `differenceCount: 0` for the Phase 0 inventory) and
   review every difference.
5. Deploy the cutover release.

Each difference is a decision by design of TASK-0118; review them, not just the
count. The Phase 0 production inventory (5 Workspaces, 2 owners, 0 non-owner
members) is expected to report `differenceCount: 0`. The report contains
account and Capsule ids; keep it with the private backfill inventory, not in a
public repository or ticket. Bearer restrictions (PAT `appIds`, Workspace-bound
tokens) are identical under both rules and are not part of this comparison.

An installed app's own OAuth token reaches only its own app (and there needs
both its app role and the Workspace decision). Only apps built from a
repository listed in `TAKOSUMI_ACCOUNTS_DELEGATED_APP_SOURCES` keep Workspace
delegation. On a target where Takos installs apps for its users, set that
variable to the Takos repository coordinate, for example
`[{"url":"https://github.com/<owner>/takos","path":".","refs":["refs/heads/main","refs/tags/v*"]}]`
with the exact URL the Takos Capsule was installed from and the refs it is
deployed from, before deploying this release; otherwise Takos's delegated
install, approve and apply requests return 403. Delegation follows the applied
revision: the full ref name the runner recorded on its snapshot (`resolvedRef`)
must be an allowed `refs/heads/…` or `refs/tags/…` name. A Takos Capsule
redeployed from a pull-request ref or a raw commit is not a delegate, and only
its owner can change its ref or path or roll it back.

Snapshots fetched before this release have no `resolvedRef`, so after deploying
the Takos Capsule is **not** a delegate until its applied snapshot records one:

1. Deploy the runner from this release together with the control plane (the
   runner reports `resolvedRef`; an older runner leaves every snapshot without
   it and no app delegates).
2. As the Takos app's owner, trigger a sync of its Source
   (`POST /api/v1/sources/{sourceId}/sync`).
3. If the Source's ref still resolves to the applied commit and the applied
   snapshot is the newest snapshot of that Source, ref and path, the sync
   reuses that snapshot and writes `resolvedRef` into it in place: delegation
   works at once, no apply needed. If the ref has moved on (or a newer snapshot
   of the same lane exists), the sync creates a new snapshot and the applied one
   stays without `resolvedRef`: update the Takos app (plan and apply) to the new
   snapshot to restore delegation.
4. Confirm by calling a Workspace route with the Takos app's token (for example
   its install flow) or by reading the applied snapshot
   (`GET /api/v1/sources/{sourceId}/snapshots`, field `resolvedRef`).

Failure recovery preserves the additive schema and existing storage roots.
Use a reviewed forward repair for incorrect backfill data. Do not drop the new
columns/tables or re-run against an unreviewed target as a rollback.
