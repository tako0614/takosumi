# Control D1 schema predeploy

This runbook is the operator gate for the OSS Takosumi control-ledger D1
adapter. Run it before deploying a platform Worker that requires a newer
control schema. A hosted composition may add tables, but it must predeploy this
OSS-owned subset first and must not rely on request traffic to create or repair
it.

This CLI has two different operating boundaries:

- `plan`, `verify`, and `fence` are valid building blocks for every operator;
- in-place `apply` is only for a new, local, test, or explicitly bounded small
  self-host database whose complete migration batch is proven to fit the
  backend limits.

Migration 44 performs data-preserving canonical table rebuilds in one
transaction. Takosumi Cloud's roughly 726 MB production D1 is not a valid
in-place target: D1 requests/batches have a 30-second limit. The official Cloud
path deploys a schema-independent bridge, permanently fences the legacy DB,
exports it, transforms the full export locally, imports an empty candidate,
and releases only the candidate after cutover proof. It never sends migration
44 to production D1 as one remote batch.

Migration 44 is released history and must not be rewritten. The adopted
Service Form/FormRef separation is a later additive migration with its own new
version; it is never folded into this convergence migration.

The schema plan is derived from the canonical
`ensureD1OpenTofuLedgerSchema` migration chain in a fresh local SQLite
database. The CLI records the complete expected `schema_migrations` ledger and
structural descriptors for every OSS-owned table. `verify` is read-only and
accepts unrelated host-extension tables; it fails on missing or structurally
different OSS tables, migration-ledger drift, and known retired tables.
Descriptors include normalized `sqlite_master.sql`, `PRAGMA table_xinfo`,
explicit and SQLite auto-indexes via `index_xinfo`, foreign keys, and attached
triggers/views. A table with the same columns but a missing `CHECK` or `UNIQUE`
constraint is therefore not ready.

## Ownership and naming

This gate covers only the OSS **control-plane ledger**. Accounts D1 and a
hosting layer's private tables have separate migration owners and separate
evidence.

D1 uses the unprefixed logical table names, including:

```text
resource_shapes
resolution_locks
target_pools
space_policies
resource_identity_fences
```

`resource_identity_fences` is an additive Resource-incarnation fence. Migration
61 creates it empty; live Resource rows adopt fence entries lazily, so the
migration performs no historical backfill.

Names such as `takosumi_target_pools` belong to the Postgres adapter and are
not valid D1 readiness probes. Do not infer D1 readiness from a prefixed table
query.

## Local gate

From an exact, clean OSS Takosumi commit:

```bash
cd takosumi
bun run test:control-d1-schema
bunx tsc --noEmit --pretty false
test -z "$(git status --porcelain)"
export TAKOSUMI_CONTROL_D1_SOURCE_COMMIT="$(git rev-parse HEAD)"

bun run control-d1-schema:plan \
  > "$PRIVATE_EVIDENCE_DIR/control-d1-schema-plan.json"

bun run control-d1-schema:apply -- \
  --environment staging \
  --dry-run \
  > "$PRIVATE_EVIDENCE_DIR/control-d1-schema-dry-run.json"

control_manifest_digest="$(
  jq -er '.manifestDigest | select(test("^sha256:[0-9a-f]{64}$"))' \
    "$PRIVATE_EVIDENCE_DIR/control-d1-schema-plan.json"
)"
```

`plan` and `apply --dry-run` are local-only and make no remote request. The
manifest confirmation binds an apply to the reviewed schema, ledger, and
retired-table set generated from that commit.
Before opening the remote target, a real apply independently verifies that the
current checkout is clean and its actual `HEAD` equals
`TAKOSUMI_CONTROL_D1_SOURCE_COMMIT`; the environment value alone is not trusted.

## Operator configuration

Remote commands read only the selected environment's variables:

```text
TAKOSUMI_CONTROL_D1_STAGING_CLOUDFLARE_ACCOUNT_ID
TAKOSUMI_CONTROL_D1_STAGING_DATABASE_ID
TAKOSUMI_CONTROL_D1_STAGING_CLOUDFLARE_API_TOKEN
TAKOSUMI_CONTROL_D1_PRODUCTION_CLOUDFLARE_ACCOUNT_ID
TAKOSUMI_CONTROL_D1_PRODUCTION_DATABASE_ID
TAKOSUMI_CONTROL_D1_PRODUCTION_CLOUDFLARE_API_TOKEN
```

Keep them in operator-private process state. `verify` requires D1 Read;
`apply` requires D1 Write. Tokens, account IDs, database IDs, SQL parameters,
and Cloudflare response bodies are omitted from transcripts. A one-way
configuration digest still binds apply and verify evidence to the selected
remote database.

The REST adapter has a fixed `https://api.cloudflare.com` origin. Do not add an
operator-configurable API origin or pass a token on the command line.

After this gate is part of the host's mandatory promotion sequence, set the
platform composition's `TAKOSUMI_CONTROL_D1_SCHEMA_MODE` to `predeployed`.
That mode performs one strict read-only check of the complete migration ledger
per store instance and never executes schema DDL from a request. Every store
operation additionally checks the durable maintenance fence, so a warmed
isolate also fails closed while predeploy is active. It fails closed if a
version, name, or checksum is missing or different. The OSS default remains
`bootstrap` so a self-hosted reference composition can initialize a new
database; hosted operators must opt into `predeployed` only together with this
gate.

Deploy the fence-aware Worker version before entering the contract-migration
window. The apply command atomically acquires a deterministic maintenance
fence and installs write-block triggers on existing user tables, waits five
seconds for request reads to drain, and then runs each migration. Versions 24
through 47 submit the complete migration statements and their
`schema_migrations` insert as one atomic statement group. Ordinary groups use
the D1 `/query` endpoint. If a group contains compound `CREATE TRIGGER` DDL,
the operator REST adapter renders the whole group as one SQL file and uses the
official D1 Import API (`init` / presigned upload / `ingest` / `poll`) because
the `/query` parser does not accept that DDL reliably. The adapter validates the
uploaded file ETag, never sends the Cloudflare bearer token to the presigned
upload origin, and reports success only after import completion. The Import API
blocks database access while it applies the file atomically; this is only a
transport change and does not weaken or replace the canonical trigger fence.
Inside the transaction only, an uncommitted bypass permits the migration
writes; requests always see the blocking state. Rebuilt tables receive their
trigger again before commit.

`fence` installs the same durable maintenance record and write-block triggers
without running a migration or releasing the fence:

```bash
bun run control-d1-schema:fence -- \
  --environment production \
  --confirm-manifest "$control_manifest_digest" \
  > "$PRIVATE_EVIDENCE_DIR/control-d1-legacy-fence.json"
```

Its application schema and migration ledger remain unchanged. Hosted
blue/green cutovers treat that fence as permanent; there is intentionally no
legacy release command.

## Backup before apply

D1 production storage has always-on Time Travel. Record its current bookmark
before each staging or production apply. Also export the database when the
release requires an offline or longer-retention copy. Wrangler accepts a D1
database **name or binding**, not its UUID, in these commands.

```bash
umask 077
mkdir -p "$PRIVATE_EVIDENCE_DIR/backups"

bun run wrangler -- d1 time-travel info \
  "$TAKOSUMI_CONTROL_D1_DATABASE" \
  --config "$TAKOSUMI_WRANGLER_CONFIG" \
  --json \
  > "$PRIVATE_EVIDENCE_DIR/control-d1-bookmark-before.json"

bun run wrangler -- d1 export \
  "$TAKOSUMI_CONTROL_D1_DATABASE" \
  --remote \
  --config "$TAKOSUMI_WRANGLER_CONFIG" \
  --output "$PRIVATE_EVIDENCE_DIR/backups/control-d1-before.sql"
```

An export blocks other database requests while it runs, so perform it inside
the reviewed change window. Never commit the bookmark, SQL export, realized
Wrangler config, or database identifiers. Restoring a Time Travel bookmark
overwrites the database in place and requires the separate incident/rollback
approval in the backup and rollback runbooks.

## Bounded self-host staging, then production

This in-place sequence is not the Takosumi Cloud procedure. Use it only after
the self-host operator has proved that the complete dataset and every migration
batch fit its backend limits. Large or uncertain databases use the host's
fenced export/candidate procedure instead.

Apply exactly the locally reviewed manifest and immediately run the read-only
verification:

```bash
bun run control-d1-schema:apply -- \
  --environment staging \
  --confirm-manifest "$control_manifest_digest" \
  > "$PRIVATE_EVIDENCE_DIR/control-d1-schema-apply-staging.json"

bun run control-d1-schema:verify -- \
  --environment staging \
  > "$PRIVATE_EVIDENCE_DIR/control-d1-schema-verify-staging.json"
```

The apply transcript is ready only when its top-level `status` and nested
`verification.status` are both `ready`. It also records the non-secret drain
duration. The fence is released only after the complete structural and ledger
verification passes. A failed apply deliberately leaves it active; ordinary
requests and standalone verification remain fail-closed. Retry only the same
clean source commit and exact manifest digest, which deterministically resumes
the same fence. Changing or forcibly clearing a failed fence requires the
incident/restore procedure, not ad hoc SQL. Run staging functional checks
before repeating backup, apply, and verify with `--environment production` and
the same manifest digest.

### Sealed in-place release recovery

Use this path only for a reviewed in-place fence whose OSS schema work already
completed and whose release requires an explicit recovery authorization. It
does not apply migrations, upgrade the maintenance table, repair guards, or
reuse a hosted/candidate release controller.

First select one exact release timestamp and run the read-only status command:

```bash
export TAKOSUMI_CONTROL_D1_SOURCE_COMMIT="$(git rev-parse HEAD)"
release_timestamp="2026-08-05T12:00:05.000Z"

bun run control-d1-schema:release-status -- \
  --environment staging \
  --confirm-manifest "$control_manifest_digest" \
  --released-at "$release_timestamp" \
  > "$PRIVATE_EVIDENCE_DIR/control-d1-release-status.json"
```

A releasable transcript has top-level `status: "ready"` and
`maintenanceStatus: "active"`. It proves the stored and recomputed fence ID,
original fence source, current clean tool source, manifest, environment,
role/policy, source-export state, predecessor lineage, maintenance flags and
timestamps, selected-target digest, current maintenance-table shape, stable
`schema_version`, exact OSS schema and migration ledger, integrity/FK checks,
canonical guard count/digests, and exact generated release-plan budgets/digest.
The maintenance proof includes a sanitized exact DDL digest and required-CHECK
result; it never emits the DDL itself. All three reserved recovery relations
must be absent.
It emits no native account/database ID, provider token, or raw SQL.

Copy every confirmation from that same ready transcript. Do not recompute or
substitute a value:

```bash
release_status="$PRIVATE_EVIDENCE_DIR/control-d1-release-status.json"

bun scripts/control-d1-schema.ts release \
  --environment staging \
  --confirm-manifest "$control_manifest_digest" \
  --released-at "$release_timestamp" \
  --confirm-release-status-digest "$(jq -er .statusDigest "$release_status")" \
  --confirm-release-readiness-digest "$(jq -er .releaseReadinessDigest "$release_status")" \
  --confirm-fence-id "$(jq -er .fence.fenceId "$release_status")" \
  --confirm-fence-source-commit "$(jq -er .fence.originalSourceCommit "$release_status")" \
  --confirm-tool-source-commit "$(jq -er .fence.currentToolSourceCommit "$release_status")" \
  --confirm-target-digest "$(jq -er .fence.targetDigest "$release_status")" \
  > "$PRIVATE_EVIDENCE_DIR/control-d1-forward-repair-release.json"
```

Immediately before dispatch, `release` recomputes the complete semantic status
and compares every confirmation. Its only mutation is one atomic D1 Import:
it creates guard-inventory, migration-ledger, and self-checking assertion
relations without `IF NOT EXISTS`, populates the expected inventories in
measured chunks, atomically checks the exact maintenance DDL, schema version,
migration ledger, table/guard identity, integrity and foreign keys, then
inserts the compact result into the assertion relation. Only that successful
self-contained assertion is followed by the unconditional inactive update,
preselected timestamp/authorization receipt, exact guard drops, and removal of
all three relations. Every rendered statement is strictly below
100,000 UTF-8 bytes and uses zero bindings (below the 100-binding contract);
the complete rendered Import is measured separately. Any false predicate or
mid-Import error rolls back the release and keeps the fence and guards active.
A pre-existing reserved relation is a status failure and is never auto-dropped.

The mutating command dispatches at most once. If its acknowledgement is lost,
do **not** rerun `release`. Use only the read-only status command with every
sealed value from the original active transcript and the identical timestamp:

```bash
bun run control-d1-schema:release-status -- \
  --environment staging \
  --confirm-manifest "$control_manifest_digest" \
  --released-at "$release_timestamp" \
  --confirm-release-status-digest "$(jq -er .statusDigest "$release_status")" \
  --confirm-release-authorization-digest "$(jq -er .releaseAuthorizationDigest "$release_status")" \
  --confirm-release-readiness-digest "$(jq -er .releaseReadinessDigest "$release_status")" \
  --confirm-fence-id "$(jq -er .fence.fenceId "$release_status")" \
  --confirm-fence-source-commit "$(jq -er .fence.originalSourceCommit "$release_status")" \
  --confirm-tool-source-commit "$(jq -er .fence.currentToolSourceCommit "$release_status")" \
  --confirm-target-digest "$(jq -er .fence.targetDigest "$release_status")" \
  > "$PRIVATE_EVIDENCE_DIR/control-d1-release-receipt-status.json"
```

An exact committed receipt reports `status: "released"`,
`maintenanceStatus: "inactive"`, `receiptMatchesAuthorization: true`,
`receiptMatchesReleaseReadiness: true`, and
`receiptConfirmationsExact: true`. A reconciliation invocation that still
finds an active fence reports a non-ready ambiguous-receipt issue and cannot be
reused as a fresh release preflight. Any active or mismatched result is
investigation evidence, never permission for an automatic second release.

The separate provider-free capability command exercises a 221-user-table,
657-guard **worst-case regression fixture**. Those numbers are not a claim
about any hosted production database:

```bash
bun run control-d1-schema:release-recovery-capability \
  > "$PRIVATE_EVIDENCE_DIR/control-d1-release-recovery-capability.json"
```

Its `@v2` transcript proves the bounded plan, exact local REST/Import success,
and injected mid-Import rollback. It explicitly reports
`targetAuthorization.status: "not_authorized"`: local SQLite evidence cannot
authorize a target. Disposable live D1 exact-shape success and injected
rollback evidence remain a separate operator-owned requirement. The existing
`release-capability` `@v1` command and its hosted consumer are unchanged.

The repair checkout must be clean and its actual `HEAD` must equal
`TAKOSUMI_CONTROL_D1_SOURCE_COMMIT`; confirming an older fence source never
overrides that check.

Schema migration is forward-only. A Worker rollback must remain compatible
with the migrated schema; use a reviewed forward repair or an approved D1
restore rather than ad hoc down-migration SQL.

No flag, confirmation phrase, or operator CLI grants protected production
down-migration authority. Disposable local/development/test fixture reset is a
separate injected-client test utility and cannot resolve this runbook's D1
target or credentials.

## Hosted compositions

A host that keeps private schema in the same D1 database must preserve two
independent authorities:

1. apply and verify this OSS control manifest;
2. only after it succeeds, apply and verify the host-owned manifest.

Takosumi Cloud implements that ownership ordering during an offline candidate
transform, not by invoking this CLI's remote `apply` against production. Its
private manifest does not replace this OSS gate, and this OSS CLI does not know
about Cloud tables, billing, Cloud capacity, or closed runtime internals.

See Cloudflare's official documentation for
[D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/),
[D1 export](https://developers.cloudflare.com/d1/best-practices/import-export-data/),
and the
[D1 query API](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/query/).
