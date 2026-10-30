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

- `read-only` sends only single `SELECT`/`WITH` reads and read-only schema
  `PRAGMA`s, classified by a SQLite-aware tokenizer (comments, string
  literals and `"…"`, `` `…` `` and `[…]` identifiers; only `?` parameters;
  more than one statement, an unterminated quote or comment, or any character
  SQLite could read differently is refused). Any other statement is refused
  before it is sent. Reads retry on 429/5xx. It never sets
  `workspaceMutationsFrozen`, so `--apply` is refused. Use it for every
  dry-run and for the cutover verification below.
- `apply` proves the freeze from Cloudflare before it returns
  `workspaceMutationsFrozen: true`, and again before a write once the proof is
  older than 30 seconds: every listed Worker serves exactly its listed Version
  at 100 percent, binds this database, resolves
  `TAKOSUMI_ACCOUNTS_WORKSPACE_MUTATIONS_FROZEN` to frozen (absent counts as
  the frozen default; `false`/`off`/`0`, an unparsable value or a secret
  binding refuses) and sets `TAKOSUMI_APP_OWNERSHIP_MUTATIONS` to `frozen`
  (absent means the `enabled` default and refuses, as do `enabled`, any other
  value, a duplicate or a secret binding; see
  [App ownership kill switch](#app-ownership-kill-switch)); no unlisted Worker
  in the account may serve a Version bound to this database. List every
  Worker bound to this Control D1 (the platform Worker and any separate auth
  Worker, such as `takosumi-auth-staging` on staging) with the Version ids
  from their release evidence; each must have been released with the switch
  frozen in [rollout step 1](#rollout-order). The Control store stays on the
  read-only client; only the ownership store writes, and only the six exact
  statements the backfill issues (Capsule owner initialization and its paired
  owner-member cleanup, which must follow it in the same batch; the
  `capsule_members` and
  `account_billing_bindings` upserts with their exact columns and conflict
  updates; the Connection owner and usage payer updates). Any other table,
  column, conflict update or predicate is refused. Writes are never retried;
  an unacknowledged write is reconciled by the next dry-run.
- Limits of the proof: it checks only Workers the Cloudflare API lists for
  this account. Direct D1 clients (another API token, `wrangler d1 execute`,
  a Worker in another account) are outside it, so stop them for the window.
  Freeze-proof and read requests retry 429/5xx three times; a persistent 429
  then refuses the proof or the read, and the backfill stops before writing.
  A write that fails (including 429) is not retried; the tool stops, and the
  next dry-run shows the remaining work.
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
app-owner/member writers stopped until the backfill is verified with
`TAKOSUMI_APP_OWNERSHIP_MUTATIONS=frozen`
([App ownership kill switch](#app-ownership-kill-switch)); the tool is an
expand-phase operator operation, not a concurrent ownership-transfer
transaction. Verify each new owner/member,
connection owner and usage payer before authorization switches in Phase 6.

Complete and verify this backfill before enabling or accepting **any ownership
transfer**; the kill switch below enforces this. Only this migration may infer
a missing historical usage payer;
ordinary usage writes preserve an absent payer. After a transfer, the current
owner cannot prove who owed an old unattributed measurement or Plan settlement.
The tool therefore skips every transferred app's payer-less usage, so re-running
it after a transfer cannot turn intentionally unattributed rows into charges.

The freeze permits only canonical, authenticated owner-bound personal Workspace
singleton bootstrap for a fresh account. Organization creation and membership
mutations stay frozen; the bootstrap cannot select an arbitrary owner.

### App ownership kill switch

The Workspace freeze does not stop per-app writers. They are live as soon as
the v75 -> v79 schema window releases its fence: an ownership transfer accepted before the backfill has
written payers leaves that app's payer-less usage permanently unattributed
(the backfill skips transferred apps), and member writes race the backfill's
own member rows. `TAKOSUMI_APP_OWNERSHIP_MUTATIONS` stops them:

| Value | Effect |
| --- | --- |
| `enabled` (default; also unset or empty) | Normal behavior. Self-hosted deployments need no change. |
| `frozen` | `POST /api/v1/capsules/{capsuleId}/members` (add), `DELETE /api/v1/capsules/{capsuleId}/members/{accountId}` (remove, and leave by a member), `POST /api/v1/capsules/{capsuleId}/ownership-transfers` (offer), `POST /api/v1/ownership-transfers/{transferId}/accept` and `DELETE /api/v1/ownership-transfers/{transferId}` (cancel) return HTTP 409 with `code: "failed_precondition"` and `details.reason: "app_ownership_mutations_frozen"`, before any app is read. Member and transfer reads keep working. |

Any other value fails every Accounts request, so parse it before planning.
Credential checks (app-bound OAuth grants, Workspace-scoped bearers) still
answer first. Set it on every Worker bound to the Control D1 (the platform
Worker, including its shared-auth and operator-control routes, and a separate
auth Worker such as `takosumi-auth-staging`); Node/PostgreSQL hosts read the
same variable. The Cloudflare adapter's apply proof requires `frozen` on every
Worker that serves a Version bound to the Control D1, listed or not. The
dashboard shows a "paused for maintenance" message for this reason.

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
  Workspace decision for that app, so run the check after the backfill (step 6
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

1. **Deploy the release while Control D1 is still at v75.** Release **every
   Worker bound to the Control D1** from this main, each with
   `TAKOSUMI_APP_OWNERSHIP_MUTATIONS = "frozen"`, not only the platform Worker:
   - the platform Worker, through the full platform lane (Worker, runner image
     and variables together);
   - every separate auth (issuer) Worker that binds the same Control D1. On
     staging this is `takosumi-auth-staging`, released through
     `takosumi-auth-staging-authority`: its target admits
     `TAKOSUMI_APP_OWNERSHIP_MUTATIONS` only as `frozen` or `enabled`, and any
     variable change moves its authority digest, so
     `takosumi-auth-staging-code` refuses it with
     `auth_staging_code_authority_drift`.

   An auth Worker cannot be left on its old release. It verifies the
   predeployed Control schema on every sign-in, issuer, `/readyz` and
   scheduled request, so an auth Worker still running pre-v76 code (built
   before the TASK-0118 schema changes) stops working, failing those requests
   closed, as soon as step 3 moves the schema past v75. Releasing it later than
   step 1 also leaves step 5 blocked: the adapter's apply proof refuses while
   any Worker that serves a Version bound to the Control D1 lacks the frozen
   switch (`ownership_app_mutations_not_frozen` for a listed Worker,
   `ownership_freeze_unlisted_worker` for one left out of
   `TAKOSUMI_OWNERSHIP_FREEZE_WORKERS`). All of them must accept v76-v79 before
   step 3. Put these variables into the same release of each Worker (the auth
   Worker does not run the Source retirement sweep, so the first one applies to
   the platform Worker only):
   - `TAKOSUMI_SOURCE_RETIREMENT_SWEEP_ENABLED = "0"` until step 4 and its
     inventory review are done.
   - `TAKOSUMI_ACCOUNTS_WORKSPACE_MUTATIONS_FROZEN = "true"`. Unset is also
     frozen, but the explicit value lets the adapter prove it; an invalid value
     fails every Accounts request.
   - `TAKOSUMI_APP_OWNERSHIP_MUTATIONS = "frozen"` until step 7
     ([App ownership kill switch](#app-ownership-kill-switch)). On v75 these
     writes cannot succeed anyway; from the end of step 3 they would otherwise
     be live while the backfill runs. The adapter's apply proof refuses
     without it.
   - `TAKOSUMI_ACCOUNTS_DELEGATED_APP_SOURCES` where Takos installs apps (see
     [Takos delegation](#takos-delegation)). It must be present from this
     release on: installed-app tokens are confined to their own app as soon as
     this code serves. A malformed value also fails every Accounts request, so
     parse it before planning.

   Until step 3 the predecessor Worker remains a valid restore target; after
   step 3 only forward repair is valid.
2. **Re-sync the Takos app's Source right after step 1 reads back** (only where
   Takos installs apps): as the Takos app's owner, sync its Source and, if the
   ref has moved, plan and apply the Takos app to the new snapshot (details in
   [Takos delegation](#takos-delegation)). Wait until those Runs finish: the
   schema lane in step 3 refuses queued or running Runs.

   **Remaining 403 window:** from the moment step 1's code serves until this
   step records `resolvedRef` on the Takos app's applied snapshot, Takos's
   delegated install, approve and apply requests return 403, because the
   Takos app's own token is already confined to its own app. Users acting with
   their own sessions are unaffected. The window is as short as the time
   between step 1's readback and the sync (or, if the ref moved, until the
   Takos app's apply finishes); it cannot be closed earlier, because only the
   runner and control plane of this release record `resolvedRef`.

   The recorded `resolvedRef` survives the later steps (verified in code): it
   is a field of the snapshot record (`source_snapshots.record_json`), which
   v76-v79 do not touch; the Source ownership migration in step 4 rewrites
   snapshots only as whole records (archive canonicalization and split copies
   keep every field and remap the adopted revision to the copied snapshot);
   the backfill writes only ownership, member, Connection owner, usage payer
   and billing binding columns.
3. **Apply the Control schema v75 -> v79** in one fenced window (production:
   `takosumi-control-d1-schema-production-v75-v79`; staging: the generic
   `takosumi-control-d1-schema-staging` surface; Postgres hosts: v122-v125 with
   the normal migration runner). Read back the v79-compatible runtime of every
   Worker on that database, then `release` the fence and `verify`. See
   [Control D1 schema predeploy](./control-d1-schema-predeploy.md#fixed-production-v75-to-v79-transition).
   On Postgres, the v124 and v125 indexes are built with plain
   `CREATE INDEX` (not `CONCURRENTLY`, which cannot run inside the migration
   transaction): each build blocks writes (reads continue) on `usage_events`,
   `backups`, `capsules`, `connections` and `capsule_ownership_transfers` for
   its duration. On a large self-hosted database, measure the build time on a
   copy and schedule the migration in a write-quiet window.
4. **Migrate Source ownership**
   ([source-ownership-migration.md](./source-ownership-migration.md)) with the
   schema fence released; the route refuses while it is active. Ownerless
   Sources keep working (they belong to every live app built from them), but a
   Source shared by several apps then needs every one of those apps to allow
   each action.
5. **Run the backfill to completion** with the Workspace mutation freeze and
   the app ownership kill switch in force (every batch, until a dry-run
   reports no pending writes). The kill switch keeps member and transfer
   writes out of the window, so no transfer can make an app's payer-less usage
   permanently unattributed and no member write races the backfill's member
   rows. The backfill writes a Capsule's owner row and its member rows as
   separate writes, possibly in different batches. Because the per-app code is
   already serving, a Workspace owner/admin who will be migrated as an app
   member cannot manage that app between those two writes: run the batches
   back to back. A target with no non-owner Workspace managers (the Phase 0
   production inventory has none) is unaffected.
6. **Run this tool with `--fail-on-difference`** (expect `differenceCount: 0`
   for the Phase 0 inventory) and review every difference before declaring the
   rollout complete.
7. **Re-enable app ownership writes and confirm delegation.** After step 6
   passes and its differences are reviewed, set
   `TAKOSUMI_APP_OWNERSHIP_MUTATIONS = "enabled"` (or remove it) on every
   Worker bound to that Control D1 through its normal release path (for
   `takosumi-auth-staging`, `takosumi-auth-staging-authority` again). From
   then on every never-transferred app's usage already has its payer. Read back
   `TAKOSUMI_ACCOUNTS_DELEGATED_APP_SOURCES` on the serving Version and
   confirm the Takos app's applied snapshot still records `resolvedRef`.

The Workspace freeze stays in force after the backfill; `"false"` is only the
rollback switch for the Workspace-membership surface.

Each difference is a decision by design of TASK-0118; review them, not just the
count. The Phase 0 production inventory (5 Workspaces, 2 owners, 0 non-owner
members) is expected to report `differenceCount: 0`. The report contains
account and Capsule ids; keep it with the private backfill inventory, not in a
public repository or ticket. Bearer restrictions (PAT `appIds`, Workspace-bound
tokens) are identical under both rules and are not part of this comparison.

### Takos delegation

An installed app's own OAuth token reaches only its own app (and there needs
both its app role and the Workspace decision). Only apps built from a
repository listed in `TAKOSUMI_ACCOUNTS_DELEGATED_APP_SOURCES` delegate for
their user. Once the Takos Capsule has an ownership row, only tokens of users
who are its owner or a member delegate (checked live), and on another app the
user's own role there decides; the token's Workspace binding is not consulted
for that (TASK-0118 P9.1-b). Without an ownership row the token must still be
bound to the Takos Capsule's Workspace. On a target where Takos installs apps for its users, set that
variable to the Takos repository coordinate, for example
`[{"url":"https://github.com/<owner>/takos","path":".","refs":["refs/heads/main","refs/tags/v*"]}]`
with the exact URL the Takos Capsule was installed from and the refs it is
deployed from, in the release itself (step 1 of the
[rollout order](#rollout-order)); otherwise Takos's delegated install, approve
and apply requests return 403. Delegation follows the applied
revision: the full ref name the runner recorded on its snapshot (`resolvedRef`)
must be an allowed `refs/heads/…` or `refs/tags/…` name. A Takos Capsule
redeployed from a pull-request ref or a raw commit is not a delegate, and only
its owner can change its ref or path or roll it back.

Snapshots fetched before this release have no `resolvedRef`, so after deploying
the Takos Capsule is **not** a delegate until its applied snapshot records one.
Do this as step 2 of the [rollout order](#rollout-order), still on v75 and
before the schema window; delegation reads only the Capsule, its adopted
revision, its Source and that snapshot, which v75 already has:

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
