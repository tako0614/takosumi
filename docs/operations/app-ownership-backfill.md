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
`workspaceMutationsFrozen`. Use read-only credentials where available. For every
live Capsule and every account that can manage it under either rule, it compares
three access classes (`view`, `manage`, `owner_only`) between the legacy
Workspace decision and the per-app decision after the backfill. Capsules
without an ownership row are projected with the backfill's own inference
(Workspace owner becomes the owner, active owner/admin members become members),
so it can run before the backfill (including on D1 v75) and again after it.

The JSON report lists `differences` with a `reason`:

- `workspace_reader_not_app_member`: a Workspace `member`/`viewer` could read
  the app; they are not migrated and lose access. Confirm or add them as app
  members before the cutover.
- `workspace_manager_not_app_owner`: a Workspace admin becomes an app member and
  loses owner-only actions (uninstall, transfer, member management).
- `workspace_manager_not_app_member`: a Workspace owner/admin is outside an
  explicit app roster (a new or transferred app) and loses the app.
- `app_role_without_workspace_role`: an app owner/member without Workspace
  membership gains the app (for example after a transfer).

Each difference is a decision by design of TASK-0118; review them, not just the
count. The Phase 0 production inventory (5 Workspaces, 2 owners, 0 non-owner
members) is expected to report `differenceCount: 0`. The report contains
account and Capsule ids; keep it with the private backfill inventory, not in a
public repository or ticket. Bearer restrictions (PAT `appIds`, Workspace-bound
tokens) are identical under both rules and are not part of this comparison;
installed-app OAuth tokens are always the intersection of both rules.

Failure recovery preserves the additive schema and existing storage roots.
Use a reviewed forward repair for incorrect backfill data. Do not drop the new
columns/tables or re-run against an unreviewed target as a rollback.
