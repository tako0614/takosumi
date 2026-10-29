# App ownership expansion and backfill

TASK-0118 Phase 3 adds D1 v77 (`d1_app_ownership`) and Postgres v123.
The migrations only add nullable/defaulted columns and two tables. The owner,
slug, environment uniqueness constraint belongs to Phase 9; this tool reports
collisions and never renames apps. The Postgres expansion also adds the physical
nullable `slug` column, which previously existed only in Capsule JSON.

Run the schema owner's normal predeploy procedure separately. This backfill
does not run DDL. D1 v75/v76 continue to use Workspace-derived management access
until the schema and owner rows are available. The same rollout window also
applies D1 v78 (transfer ledger, credential mint leases) and D1 v79 / Postgres
v124-v125 (nonunique indexes for per-app Workspace list visibility, owner
Connection lists and the transfer-ledger payer walk). The full order is in
[Rollout order](#rollout-order). This is a code change and local fixture
verification; it does not authorize a staging or production operation.

The tool reads a module exporting `openOwnershipBackfill()`, which
returns `{ control, ownership, workspaceMutationsFrozen?, close? }`. `control` is the target's existing
`OpenTofuControlStore`; `ownership` is `SqlAppOwnershipStore(client, control)` or
`D1AppOwnershipStore(db, control)`. Use read-only credentials for dry-run where
available. The module owns connection setup and private credential loading;
the script never discovers targets or credentials. Do not put credentials in
the module, CLI arguments, report, or URL.

### Cloudflare D1 adapter

For a Cloudflare D1 Control database, use the supported adapter
`scripts/app-ownership-target-cloudflare-d1.ts` instead of writing one. It
talks to the Cloudflare REST API (`/query`, `/raw` and the Workers deployment
and Version reads) and takes its configuration only from the environment. Each
value may be set directly or as an absolute `_FILE` path, never both; the token
is never printed, logged, put in a URL or echoed in an error:

| Variable | Meaning |
| --- | --- |
| `TAKOSUMI_OWNERSHIP_TARGET_MODE` | `read-only` (default) or `apply` |
| `TAKOSUMI_OWNERSHIP_D1_ACCOUNT_ID[_FILE]` | Cloudflare account |
| `TAKOSUMI_OWNERSHIP_D1_DATABASE_ID[_FILE]` | the Control D1 database |
| `TAKOSUMI_OWNERSHIP_D1_API_TOKEN[_FILE]` | API token (prefer the file) |
| `TAKOSUMI_OWNERSHIP_D1_DATABASE_NAME` | optional; refuses any other database |
| `TAKOSUMI_OWNERSHIP_FREEZE_WORKERS[_FILE]` | apply only: `[{"script":"<Worker>","versionId":"<serving Version>"}]` |

- `read-only` sends only `SELECT`/`WITH` reads and read-only schema `PRAGMA`s;
  any other statement is refused before it is sent. Reads retry on 429/5xx.
  It never sets `workspaceMutationsFrozen`, so `--apply` is refused. Use it for
  every dry-run and for the cutover verification below.
- `apply` proves the Workspace mutation freeze from Cloudflare before it
  returns `workspaceMutationsFrozen: true`, and again before a write once the
  proof is older than 30 seconds: every listed Worker serves exactly its listed
  Version at 100 percent, binds this database, and resolves
  `TAKOSUMI_ACCOUNTS_WORKSPACE_MUTATIONS_FROZEN` to frozen (absent counts as
  the frozen default; `false`/`off`/`0`, an unparsable value or a secret
  binding refuses); no unlisted Worker in the account may serve a Version bound
  to this database. List every Worker that runs the Accounts handler on this
  Control D1 (for example the platform Worker and a separate auth Worker) with
  the Version ids from their release evidence. The Control store stays on the
  read-only client; only the ownership store writes, and only the backfill's
  column-scoped updates and inserts on `capsules`, `capsule_members`,
  `connections`, `usage_events` and `account_billing_bindings`. Writes are
  never retried; an unacknowledged write is reconciled by the next dry-run.
- `close()` prints one JSON line to stderr with statement, write, refusal and
  freeze-check counts, without ids or credentials.

The Control store checks the schema maintenance fence on every operation, so
the adapter works only after the schema fence is released.

```sh
export TAKOSUMI_OWNERSHIP_D1_ACCOUNT_ID_FILE=/operator/private/account-id
export TAKOSUMI_OWNERSHIP_D1_DATABASE_ID_FILE=/operator/private/control-database-id
export TAKOSUMI_OWNERSHIP_D1_API_TOKEN_FILE=/operator/private/cloudflare-api-token
ADAPTER="$PWD/scripts/app-ownership-target-cloudflare-d1.ts"
bun --no-env-file scripts/backfill-app-ownership.ts --adapter="$ADAPTER" --dry-run
TAKOSUMI_OWNERSHIP_TARGET_MODE=apply \
TAKOSUMI_OWNERSHIP_FREEZE_WORKERS_FILE=/operator/private/freeze-workers.json \
  bun --no-env-file scripts/backfill-app-ownership.ts --adapter="$ADAPTER" \
  --apply --plan-digest=sha256:<reviewed-digest> --batch-size=100
```

A Postgres target composes its own module with `SqlAppOwnershipStore`:

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
  Workspace decision for that app, so run the check after the backfill (step 5
  of the [rollout order](#rollout-order)) for the result the per-app code will
  actually enforce.
- Every Source with an owner app or used by live apps: its `ownerCapsuleId` (an uninstalled owner
  app by its retained ownership row and roster, which the live decision still
  reads), or every live Capsule built from an ownerless Source. Every one of
  those apps must allow, each
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

### Rollout order

The release must be serving **before** the schema changes. A Worker verifies
only the predeployed Control schema heads it knows: one built before the
TASK-0118 schema changes (such as the Worker serving staging and production
before this rollout) accepts heads 71 through 75 only, so it fails every
request closed once v76 or later is applied. This release accepts complete
heads 71 through 79 and, on v75, keeps the Workspace
decision (no ownership rows exist yet; the members and ownership-transfers API
answer `503 feature_unavailable`, Interface link writes `failed_precondition`).
Backfilling first and deploying afterwards is therefore impossible on a target
that still serves an older Worker.

1. **Deploy the release while Control D1 is still at v75.** On Cloudflare this
   is the full platform lane (Worker, runner image and variables together), plus
   every other Worker that serves the same Control D1 (for example a separate
   auth Worker): all of them must accept v76-v79 before step 2. Put these
   variables into the same release:
   - `TAKOSUMI_SOURCE_RETIREMENT_SWEEP_ENABLED = "0"` until step 3 and its
     inventory review are done.
   - `TAKOSUMI_ACCOUNTS_WORKSPACE_MUTATIONS_FROZEN = "true"`. Unset is also
     frozen, but the explicit value lets the adapter prove it; an invalid value
     fails every Accounts request.
   - `TAKOSUMI_ACCOUNTS_DELEGATED_APP_SOURCES` where Takos installs apps (see
     below). It must be present from this release on: installed-app tokens are
     confined to their own app as soon as this code serves. A malformed value
     also fails every Accounts request, so parse it before planning.

   Until step 2 the predecessor Worker remains a valid restore target; after
   step 2 only forward repair is valid.
2. **Apply the Control schema v75 -> v79** in one fenced window (production:
   `takosumi-control-d1-schema-production-v75-v79`; staging: the generic
   `takosumi-control-d1-schema-staging` surface; Postgres hosts: v122-v125 with
   the normal migration runner). Read back the v79-compatible runtime of every
   Worker on that database, then `release` the fence and `verify`. See
   [Control D1 schema predeploy](./control-d1-schema-predeploy.md#fixed-production-v75-to-v79-transition).
3. **Migrate Source ownership**
   ([source-ownership-migration.md](./source-ownership-migration.md)) with the
   schema fence released; the route refuses while it is active. Ownerless
   Sources keep working (they belong to every live app built from them), but a
   Source shared by several apps then needs every one of those apps to allow
   each action.
4. **Run the backfill to completion** with the Workspace mutation freeze in
   force (every batch, until a dry-run reports no pending writes). Keep the
   members and ownership-transfers API unused for the whole window; the freeze
   does not stop them. The backfill writes a Capsule's owner row and its member
   rows as separate writes, possibly in different batches. Because the per-app
   code is already serving, a Workspace owner/admin who will be migrated as an
   app member cannot manage that app between those two writes: run the batches
   back to back. A target with no non-owner Workspace managers (the Phase 0
   production inventory has none) is unaffected.
5. **Run this tool with `--fail-on-difference`** (expect `differenceCount: 0`
   for the Phase 0 inventory) and review every difference before declaring the
   rollout complete.
6. **Confirm delegation and re-sync Takos.** Read back
   `TAKOSUMI_ACCOUNTS_DELEGATED_APP_SOURCES` on the serving Version and follow
   the `resolvedRef` steps below for the Takos Source.

The freeze stays in force after the backfill; `"false"` is only the rollback
switch for the Workspace-membership surface.

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
deployed from, in the release itself (step 1 above); otherwise Takos's delegated
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
