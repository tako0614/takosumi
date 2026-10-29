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
returns `{ control, ownership, close? }`. `control` is the target's existing
`OpenTofuControlStore`; `ownership` is `SqlAppOwnershipStore(client, control)` or
`D1AppOwnershipStore(db, control)`. Use read-only credentials for dry-run where
available. The module owns connection setup and private credential loading;
the script never discovers targets or credentials. Do not put credentials in
the module, CLI arguments, report, or URL.

```sh
bun scripts/backfill-app-ownership.ts --adapter=/absolute/operator/ownership-target.ts --dry-run
bun scripts/backfill-app-ownership.ts --adapter=/absolute/operator/ownership-target.ts --apply --plan-digest=sha256:<reviewed-digest> --batch-size=100
```

Dry-run reads all Workspace rows, including archived ones, and emits a private
inventory and digest. Owners come from `ownerUserId`. Active owner/admin members
other than the owner become app members; member/viewer, invited and suspended
rows are reported for confirmation and never migrated automatically. Connections
and existing usage take the Workspace owner, while operator connections retain
no personal owner. Legacy storage roots remain
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

Apply re-reads the inventory and requires its digest to match the reviewed
dry-run. Each invocation writes at most 100 rows serially. Re-run dry-run and
review its new digest for the next batch; a completed run has no pending writes.
If a write fails, previously committed rows remain, the tool stops, and a new
dry-run identifies remaining work. Workspace creation and membership mutations
must remain frozen throughout this operation. Keep app-owner/member writers
stopped until backfill completes; the tool is an expand-phase operator operation,
not a concurrent ownership-transfer transaction. Verify each new owner/member,
connection owner and usage payer before authorization switches in Phase 6.

Failure recovery preserves the additive schema and existing storage roots.
Use a reviewed forward repair for incorrect backfill data. Do not drop the new
columns/tables or re-run against an unreviewed target as a rollback.
