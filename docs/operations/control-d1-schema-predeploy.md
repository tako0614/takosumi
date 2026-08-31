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
transaction. Takosumi hosted service's roughly 726 MB production D1 is not a valid
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

## Official v66 to v67 owner surfaces

The official Takosumi staging and production databases use two schema-only
surfaces. They are deliberately separate from the platform Worker surface:

```text
takosumi-control-d1-schema-staging  staging control D1
takosumi-control-d1-schema          production control D1
```

These surfaces accept only `plan`, `execute`, and `recover`. They do not deploy
a Worker, read a Wrangler config, use Wrangler login/OAuth, or restore D1. The
only provider boundary is the selected environment's explicit Cloudflare
account ID, database ID, and account-scoped API token. The same token reads the
currently serving Worker deployment/version binding through the Cloudflare
REST API and accesses that exact D1 database through the existing D1 REST
transport. A successful REST read proves access to the selected account; no
ambient `CLOUDFLARE_API_TOKEN` fallback is accepted.

This release lane is intentionally exact. It accepts a complete canonical v66
predecessor with no maintenance fence and exactly one pending migration, v67.
Ready state is the canonical v67 closure: 64 immutable migration rows, 38 OSS
tables, and the plan's exact manifest, schema, and ledger digests. A later
migration head or any earlier/extra/mismatched ledger requires a new reviewed
surface change; it is not inferred as another safe migration.

The currently deployed v66-only Worker is **not** a valid serving predecessor
for this mutation. Its `predeployed` verifier requires the ledger length to
equal its own catalog, so it rejects v67. Releasing the migration fence while
that Version serves would create a known outage, and restoring that Version
after v67 would not recover service.

Deploy and read back a zero-downtime bridge before creating either schema
plan. The bridge is built from the exact previously serving source through an
explicitly reviewed ordered compatibility closure; in the bounded
`predeployed-bridge` mode it accepts the exact v66 ledger or the exact candidate
v67 ledger and rejects every other ledger. Normal `predeployed` mode remains
strict to the current v67 catalog and is not the bridge mode.

The same bridge binary has explicit versioned behavior. On exact v66, ordinary
authenticated control-plane reads and writes continue to use the v66 ledger,
but Capsule Interface materialization is disabled before Apply dispatch or
ledger mutation: explicit Interface Plan sidecars and all sealed sidecars are
rejected because the store cannot inspect a sealed payload safely, Interface
intent commit/restore writes fail closed, and the background intent claim/read
path returns no work. Migration v67 creates
`capsule_interface_materialization_intents`; after the code-owned validator
observes exact v67, those gates lift and Interface-bearing commit/read proceeds
normally. Ordinary authenticated Capsule InstallConfig re-adoption remains
available on v66: after a fresh exact-ledger proof, it performs the existing
Capsule CAS without referencing the absent intent table. On v67 the same
operation keeps the Capsule CAS and unresolved-intent retirement in one atomic
batch. This is never an SQL-error fallback. The accepted version comes only
from validation of the physical `schema_migrations` ledger, never from an
environment assertion.

The bridge owner must retain a mode-`0600` private compatibility proof with:

- kind `takosumi.control-d1-serving-compatibility-proof@v3` and status
  `ready`;
- the predecessor platform plan/confirmation and ready-evidence path/digest,
  whose accepted deployed Version must equal the bridge plan's exact
  `predecessorVersionId` and whose validated source commit is therefore the
  exact previously serving source;
- the bridge source commit, absolute platform plan path, platform plan
  confirmation and raw artifact digest, absolute raw platform ready-evidence
  path and digest, independent reviewer, and proof confirmation;
- the predecessor tree and every ordered descendant commit through the bridge,
  with each commit's one exact parent, tree object, changed-path list, and
  SHA-256 of Git's canonical full-index binary patch from that parent, plus an
  aggregate compatibility-closure digest that also binds the reviewer;
- the exact environment, Worker name, `TAKOSUMI_CONTROL_DB` binding, immutable
  serving Version, and target digest;
- `schemaMode: predeployed-bridge`, the code-owned exact v66/v67 catalog digest,
  and ready v66 and v67 entries bound to those exact ledger digests; and
- a cache-free, random-nonce live challenge whose raw canonical response and
  digest bind that same Version, the fixed `TAKOSUMI_CONTROL_DB` binding name,
  every physical v66 D1 ledger row, and the exact dual-ledger allowset.

Only the official read-only bridge-proof surfaces mint that artifact. For
staging:

```bash
bun run deploy -- takosumi-control-d1-bridge-proof-staging create \
  --predecessor-plan \
    "$PRIVATE_SCHEMA_RELEASE_DIR/staging-predecessor-plan.json" \
  --predecessor-confirm sha256:<predecessor-plan-confirmation> \
  --predecessor-evidence \
    "$PRIVATE_SCHEMA_RELEASE_DIR/staging-predecessor-evidence.json" \
  --bridge-plan "$PRIVATE_SCHEMA_RELEASE_DIR/staging-bridge-plan.json" \
  --confirm sha256:<bridge-plan-confirmation> \
  --bridge-evidence \
    "$PRIVATE_SCHEMA_RELEASE_DIR/staging-bridge-release-evidence.json" \
  --confirm-closure sha256:<reviewed-compatibility-closure-digest> \
  --review operator:<same-reviewer-as-bridge-ready-evidence> \
  --proof-out \
    "$PRIVATE_SCHEMA_RELEASE_DIR/staging-bridge-compatibility.json"
```

Use `takosumi-control-d1-bridge-proof` for production. The producer validates
both complete v5 platform plans, both accepted forward checkpoints, and both
full raw ready-evidence artifacts. It requires the predecessor evidence's
deployed Version to be the bridge plan's predecessor Version, requires both
plans to use the same target-mutation authority, and takes both source commits
only from those validated artifacts. For this v66 transition the genuine
previously serving source is
`24ea16d626f540260f496649cbdc5ffd7aa2a1f9`; the descendant
`5ccf82dc33e45d1b80cbbbf8f5636727a17182b0` already catalogs v67 and is not a
valid substitute for predecessor evidence. The validated live Version and
platform artifacts remain authoritative if this operational fact changes.

Git must prove that every commit in `git rev-list --reverse
<predecessor>..<bridge>` is one linear descendant: merge commits, missing,
reordered, or additional commits fail. For each edge the producer records the
exact parent and tree object, derives the changed paths, and hashes a
deterministic `--binary --full-index --no-renames --diff-algorithm=myers
--no-indent-heuristic --unified=3` patch. It then hashes the complete ordered
closure together with the predecessor tree and reviewer. There is deliberately
no fixed path count or allowlist that can hide an intervening product change.
Every Git read uses `git --no-replace-objects`, and the producer fails before
lineage inspection if the checkout contains any `refs/replace` ref or an
`info/grafts` file. Producer and consumer therefore cannot agree on a locally
substituted object graph.

Review the exact closure derived from the two validated artifact commits (do
not derive either commit from the current checkout):

```bash
bun -e '
  import { inspectControlD1BridgeSourceCompatibility as inspect } from
    "./scripts/control-d1-schema-release.ts";
  console.log(JSON.stringify(inspect(process.argv[1], process.argv[2], process.argv[3]), null, 2));
' \
  <predecessor-source-commit> \
  <bridge-source-commit> \
  operator:<same-reviewer-as-bridge-ready-evidence>
```

Review every emitted commit, parent, tree, path, and per-commit patch digest;
then pass the emitted `compatibilityClosureDigest` as `--confirm-closure`. The
producer recomputes the same closure after validating both release chains.
Neither a caller-authored list, a copied aggregate digest, nor a nonce/schema
challenge can substitute for that computation. `--review` must match the
independent reviewer in bridge ready evidence and cannot match any closure
commit author.

The producer also validates canonical v66/v67 ledger digests and the exact live
immutable Version's D1 and `predeployed-bridge` schema-mode bindings. It
challenges that Version through the public cache-free compatibility endpoint;
the request carries no Cloudflare credential and the response must echo the
fresh nonce, immutable Version, physical v66 ledger and exact code-owned
v66/v67 allowset. It then creates one absent single-link mode-`0600` proof. It
makes no provider or D1 mutation.
A nonce/schema challenge proves only the live Version's current physical ledger
and allowset. It does not prove source compatibility. A hand-authored JSON file,
copied digest, incomplete release evidence, or Version-only assertion is not a
valid producer path.

The schema `plan` stores the proof's absolute path, physical-file digest, and
confirmation, plus the raw platform evidence path.
It also runs both identified platform plans through the complete
`takosumi.platform-worker-release-plan@v5` validator. That validator binds the
exact environment, bridge source commit, confirmation, external checkpoint,
sealed predecessor, target authority path, and authority-directory inode digest
before the schema surface reads the accepted forward checkpoint or derives a
restore lock/retirement marker. It also revalidates the complete raw ready
evidence rather than trusting the proof's copied digest. The consumer also
reruns the same repository-backed ordered-commit closure calculation and
compares every parent/tree/path/patch plus the aggregate digest to the proof,
plan, checkpoint, and receipt bindings. The accepted immutable Version must be
the proof-bound serving
bridge. A proof that names only a
Version, a synthetic object with only `confirmation` and `checkpointPath`, a
plan for another environment/source, or a bridge plan whose forward release is
not accepted is insufficient.
`execute` rereads the same single-link private file and independently requires
the proof-bound immutable Version to remain the only 100-percent serving
Version with the same D1 binding. Both schema `plan` and the locked pre-mutation
check issue their own fresh v66 challenge instead of trusting the proof's stored
response. A missing, edited, generic, v66-only, or
different-Version proof fails before the mutation checkpoint. After exact v67
readback and before accepting the mutation checkpoint, `execute` challenges the
same immutable Version again and requires the physical v67 ledger plus the same
exact dual-ledger allowset. The ready receipt retains both challenge evidence
objects, their response digests, the accepted checkpoint digest, and the durable
maintenance-release receipt digest. Execute and both
v67 recovery branches perform that final check while holding the same
environment/official-Worker target-scoped inter-process lock used by platform
forward and restore. They keep it through schema mutation or fence release,
exact readback, and ready evidence, so a later candidate Worker cannot replace
the bridge mid-transition. The bridge deployment and proof producer are
separately authorized prerequisites; until they exist, this lane intentionally
cannot plan.

The `takosumi.control-d1-schema-mutation-checkpoint@v3` records also bind the
bridge source-compatibility digest. The in-place fence release persists an
opaque `releaseReadinessDigest` computed from that digest, the exact schema-plan
confirmation, and the fsynced pre-apply checkpoint record, which itself retains
the raw predecessor-challenge evidence digest. The accepted checkpoint record
similarly retains the source-compatibility digest and raw candidate-challenge
evidence digest. The `takosumi.control-d1-schema-release-evidence@v3` receipt
retains the predecessor and bridge source commits plus the compatibility-closure
digest.
Production recomputes all bindings from the retained proof, source artifacts,
receipt, and checkpoint and requires the live durable release receipt to match.
An old v67 readback/release receipt therefore cannot be combined with newly
hand-written plan, checkpoint, challenge, source, or receipt JSON.

That target authority lives under
`TAKOSUMI_PLATFORM_MUTATION_AUTHORITY_DIR`, an explicit durable physical
operator-private directory outside all Git worktrees and volatile roots. Both
real platform and schema plan commands inspect the same deterministic target
file read-only before source, provider, or D1 inspection. Plans bind the
directory's device/inode/birth-time/UID/mode identity digest; a same-name
directory replacement fails closed.

The target owner durably binds `control-d1-schema`, this plan's exact
confirmation, and its canonical mutation-checkpoint path. A process death or a
post-checkpoint failure leaves an `active` or `unresolved` owner; neither may be
reclaimed by a new execute, another schema plan, or a platform operation. A
surviving same-machine record after reboot remains discoverable and unresolved;
foreign-machine or malformed/torn records fail closed. Only
this exact plan's `recover` may acquire it, and any recovery failure keeps it
unresolved. Do not delete or edit the lock or checkpoint to make another plan
runnable.

Create an owner-private directory outside every Git worktree. The directory
must be owned by the caller and mode `0700`; plans, checkpoints, receipts, and
evidence are created once as mode `0600` files. Plans contain the exact account
and database IDs and the raw Time Travel bookmark. Public stdout contains only
non-secret digests and migration counts. The API token is never written to a
plan, checkpoint, receipt, evidence, diagnostic, or stdout.

Artifact names are authority boundaries, not interchangeable scratch paths.
Before writing any schema plan, checkpoint, receipt, or evidence, the owner
validates one cross-surface graph of canonical future paths and existing
device/inode identities. It includes the schema plan, evidence, mutation
checkpoint, serving proof, raw platform ready evidence, and staging receipt;
the bridge platform plan,
realized config, forward checkpoint, `.restore` checkpoint, retirement marker,
target mutation lock, restore lock and both pending namespaces; and both sealed
closure roots, configs, and upload entrypoints. Existing hard-link/symlink
aliases, ancestor overlap, and still-absent future-name aliases are rejected.
In particular, selecting a future `.restore`, retirement, lock, or closure path
as `--plan-out` cannot poison later recovery state.

```bash
umask 077
PRIVATE_SCHEMA_RELEASE_DIR=/absolute/operator-private/control-d1-v67
mkdir -m 0700 "$PRIVATE_SCHEMA_RELEASE_DIR"
export TAKOSUMI_PLATFORM_MUTATION_AUTHORITY_DIR=\
/absolute/durable/operator-private/takosumi-target-authority
mkdir -m 0700 "$TAKOSUMI_PLATFORM_MUTATION_AUTHORITY_DIR"

export TAKOSUMI_CONTROL_D1_STAGING_CLOUDFLARE_ACCOUNT_ID=...
export TAKOSUMI_CONTROL_D1_STAGING_DATABASE_ID=...
export TAKOSUMI_CONTROL_D1_STAGING_CLOUDFLARE_API_TOKEN=...

bun run deploy -- takosumi-control-d1-schema-staging plan \
  --plan-out "$PRIVATE_SCHEMA_RELEASE_DIR/staging-plan.json" \
  --serving-compatibility-proof \
    "$PRIVATE_SCHEMA_RELEASE_DIR/staging-bridge-compatibility.json"

staging_confirmation="$(
  jq -er '.confirmation | select(test("^sha256:[0-9a-f]{64}$"))' \
    "$PRIVATE_SCHEMA_RELEASE_DIR/staging-plan.json"
)"

bun run deploy -- takosumi-control-d1-schema-staging execute \
  --plan "$PRIVATE_SCHEMA_RELEASE_DIR/staging-plan.json" \
  --confirm "$staging_confirmation" \
  --review operator:reviewer@example.com \
  --evidence "$PRIVATE_SCHEMA_RELEASE_DIR/staging-receipt.json"
```

`plan` is remote-read-only. It requires one clean pushed source commit and
seals its author, exact environment/account/database, current 100-percent
serving bridge Version and `TAKOSUMI_CONTROL_DB` D1 binding, the retained
v66/v67 compatibility proof, credential digest, canonical/current/pending
ledgers, schema digests, absent fence, and current Time Travel bookmark.
`execute` requires the exact confirmation and a reviewer different from the
source author, then re-reads every one of those boundaries. Bookmark or bridge
proof/Version drift blocks execution; write a new plan to a new absent path
instead of editing or reusing the old plan.

The currently serving staging database is already exact v67/64 and therefore
cannot honestly mint the required `appliedMigrationVersions: [67]` rehearsal
receipt: observing ready v67 does not prove the reviewed v66-to-v67 execution,
bookmark, credential-custody, and bridge-proof chain. Do not fabricate or
adopt an `observed-ready` receipt; production rejects every kind other than the
real schema execution evidence. Production planning remains blocked until a
separate isolated fresh v66 staging-rehearsal target is exposed through this
same plan/execute/recover state machine and performs the actual transition.
Provisioning that additional Worker/D1 topology is a separate owner surface
and is not performed by this release command.

`execute` first acquires the target-scoped inter-process lock shared by every
official forward/restore/schema mutation for that environment and Worker. It
then acquires the identified bridge platform plan's restore lock. Lock order is
always target first and plan restore second. It derives the latter only from
the fully validated plan authority, then validates the same authority again
after acquisition. It rereads the proof, live Version/binding, exact v66
prestate, bookmark, and the platform restore checkpoint while holding both
authorities. The acceptable states are no restore checkpoint, or an exact fully
accepted checkpoint after the official restore has reconciled both stages and
its sealed predecessor Version and the compatible bridge is again the
proof-bound live Version. Any malformed, partial, or `unknown`
Container/Worker stage blocks retirement and schema apply.
Run the platform surface's reviewed `restore` recovery to reconcile that
checkpoint; never delete or edit it and never let schema reclaim a stale lock
as proof that an in-flight provider mutation did not settle. Before the sole
schema apply, execute fsyncs a permanent schema-retirement marker beside the
bridge plan's checkpoint. The bridge plan's official restore checks that same
marker under the same lock before its first Container or Worker mutation, so
its v66-only predecessor can no longer be routed after the schema transition
begins. If retirement succeeds but a later schema check or apply fails, the
marker remains: do not delete it or reuse that stale restore plan.

Immediately before the sole call to the existing fenced schema apply,
`execute` also fsyncs a mutation checkpoint derived from the schema plan path.
Once that checkpoint exists, no evidence-path change can invoke apply again.
Success requires `appliedMigrationVersions: [67]`, an inactive/released fence,
and a second read-only exact v67 verification while both target and bridge
restore authorities remain held. A timeout or lost acknowledgement goes to
`recover`; never rerun `execute`.

Production planning consumes only the exact ready execution receipt from that
fresh isolated staging rehearsal, same source, and canonical schema. It rereads
the complete confirmed staging plan, its validated bridge plan/proof/raw
platform evidence, the two-record mutation checkpoint ending in accepted
`[67]`, the exact live v67 D1 schema, the durable released-fence identity, and a
fresh candidate challenge against the same Version. The production plan seals
the staging plan, checkpoint and receipt paths/digests/confirmation, and
production `execute` independently repeats that authority check. A JSON object
that merely self-reports the expected fields or digests is not a receipt. The
durable released-fence receipt must also carry the release-readiness digest
bound to that checkpoint's original pre-apply record:

```bash
export TAKOSUMI_CONTROL_D1_PRODUCTION_CLOUDFLARE_ACCOUNT_ID=...
export TAKOSUMI_CONTROL_D1_PRODUCTION_DATABASE_ID=...
export TAKOSUMI_CONTROL_D1_PRODUCTION_CLOUDFLARE_API_TOKEN=...

bun run deploy -- takosumi-control-d1-schema plan \
  --plan-out "$PRIVATE_SCHEMA_RELEASE_DIR/production-plan.json" \
  --serving-compatibility-proof \
    "$PRIVATE_SCHEMA_RELEASE_DIR/production-bridge-compatibility.json" \
  --staging-plan "$PRIVATE_SCHEMA_RELEASE_DIR/staging-plan.json" \
  --staging-receipt "$PRIVATE_SCHEMA_RELEASE_DIR/staging-receipt.json"

production_confirmation="$(
  jq -er '.confirmation | select(test("^sha256:[0-9a-f]{64}$"))' \
    "$PRIVATE_SCHEMA_RELEASE_DIR/production-plan.json"
)"

bun run deploy -- takosumi-control-d1-schema execute \
  --plan "$PRIVATE_SCHEMA_RELEASE_DIR/production-plan.json" \
  --confirm "$production_confirmation" \
  --review operator:reviewer@example.com \
  --evidence "$PRIVATE_SCHEMA_RELEASE_DIR/production-evidence.json"
```

Staging and production must be physically isolated. The staging receipt
records its private `(accountId, databaseId)` tuple, and the production plan
rejects an exact tuple match even though the environment-qualified target
digests differ. The receipt and plan also record a domain-separated SHA-256
credential-custody digest derived from the API token. This permits equality
checking without serializing or printing the token; production rejects reuse
of the same token custody even when the physical databases differ. Use both a
different Cloudflare account/database target and a different credential for
production. These IDs and digests remain in mode-`0600` private artifacts and
never enter public stdout.

Create the candidate `takosumi-platform` plan only after the production bridge
is serving. That makes the bridge its sealed predecessor and restore target.
After schema evidence is ready, execute and read back that already reviewed
candidate plan. Retain the bridge as the rollback floor through candidate
readback; the former v66-only Version is permanently invalid as a code-rollback
target once v67 has committed.

Recovery always reads the authoritative D1 ledger and maintenance state before
deciding. Exact v66/absent recovery then acquires the exact schema target lock,
rereads ledger and maintenance state under it, and only then may reconcile a
crash-before-apply owner as `untouched`. Before exact v67/inactive can emit
ready it requires the retained pre-apply checkpoint and matching durable
release-readiness digest. Before an exact active
fence can be released, recovery acquires the same target lock and then the
bridge plan's restore lock, rereads the retained proof and exact live Worker
Version/D1 binding, and requires the official platform restore checkpoint to
be absent or exactly reconciled before it idempotently verifies the stale
v66-only restore remains retired. The target lock remains held through exact
schema/fence readback and ready evidence. An unresolved checkpoint is not
cleared by stale-lock reclamation and cannot produce v67 ready evidence. Proof,
Version, binding, bridge-plan, lock, restore-checkpoint, or retirement drift
fails closed without ready evidence:

- exact v66 with no fence is reported `untouched` and is not mutated;
- exact v67 with an inactive fence is verified and reported `ready`;
- exact v67 with the plan's active in-place fence first reports a separate
  `releaseConfirmation` without writing evidence or mutating D1;
- every other state fails closed and names D1 Time Travel restore as a
  separate incident authority.

For the exact active-fence case only, repeat recovery with that state-derived
confirmation and an independent reviewer. This calls the existing atomic fence
release once and verifies the full inactive v67 closure; it never runs apply:

```bash
bun run deploy -- takosumi-control-d1-schema recover \
  --plan "$PRIVATE_SCHEMA_RELEASE_DIR/production-plan.json" \
  --confirm "$production_confirmation" \
  --evidence "$PRIVATE_SCHEMA_RELEASE_DIR/recovery-evidence.json"

# Only when the first command reports release-confirmation-required:
read -r -p "Reviewed releaseConfirmation: " reported_release_confirmation
bun run deploy -- takosumi-control-d1-schema recover \
  --plan "$PRIVATE_SCHEMA_RELEASE_DIR/production-plan.json" \
  --confirm "$production_confirmation" \
  --evidence "$PRIVATE_SCHEMA_RELEASE_DIR/recovery-evidence.json" \
  --confirm-release "$reported_release_confirmation" \
  --review operator:reviewer@example.com
```

The production API token needs Workers Scripts Read and D1 Read for planning,
plus D1 Write for execute or a confirmed active-fence release. Keep distinct
staging and production tokens under separate operator credential custody; the
raw token is never persisted by the surface.

## Local and self-host gate

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

Staging commands read the staging variables. Production plan/execute also read
the staging variables because they independently revalidate the sealed
rehearsal authority before production mutation:

```text
TAKOSUMI_CONTROL_D1_STAGING_CLOUDFLARE_ACCOUNT_ID
TAKOSUMI_CONTROL_D1_STAGING_DATABASE_ID
TAKOSUMI_CONTROL_D1_STAGING_CLOUDFLARE_API_TOKEN
TAKOSUMI_CONTROL_D1_PRODUCTION_CLOUDFLARE_ACCOUNT_ID
TAKOSUMI_CONTROL_D1_PRODUCTION_DATABASE_ID
TAKOSUMI_CONTROL_D1_PRODUCTION_CLOUDFLARE_API_TOKEN
TAKOSUMI_PLATFORM_MUTATION_AUTHORITY_DIR
```

Keep them in operator-private process state. `verify` requires D1 Read;
`apply` requires D1 Write. Tokens, account IDs, database IDs, SQL parameters,
and Cloudflare response bodies are omitted from transcripts. A one-way
configuration digest still binds apply and verify evidence to the selected
remote database.

The REST adapter has a fixed `https://api.cloudflare.com` origin. Do not add an
operator-configurable API origin or pass a token on the command line.

Use `predeployed-bridge` only for the reviewed v66-to-v67 bridge window. Its
allowset is code-owned and exactly two entries long; no environment value or
challenge response can widen it. After v67 is accepted and the candidate Worker
has been read back, set the ordinary platform composition's
`TAKOSUMI_CONTROL_D1_SCHEMA_MODE` to `predeployed`. That mode performs one strict
read-only check of the complete current v67 migration ledger
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

D1 production storage has always-on Time Travel. The official owner surface's
read-only plan records the bookmark through the canonical REST boundary and
execute requires it not to drift. Do not replace that proof with the following
Wrangler commands. They remain self-host/operator-owned helpers for a separate
manual deployment, where Wrangler accepts a D1 database **name or binding**,
not its UUID. Also export the database when that separate release requires an
offline or longer-retention copy.

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

This in-place sequence is not the Takosumi hosted service procedure. Use it only after
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

### Forward-repair release for an older fence source

If an active or inactive in-place fence was created by an older clean OSS
commit, a reviewed repair may release that exact fence from a newer clean
checkout without rerunning schema work:

```bash
export TAKOSUMI_CONTROL_D1_SOURCE_COMMIT="$(git rev-parse HEAD)"

bun scripts/control-d1-schema.ts release \
  --environment staging \
  --confirm-manifest "$control_manifest_digest" \
  --confirm-fence-source-commit <older-40-hex-commit> \
  > "$PRIVATE_EVIDENCE_DIR/control-d1-forward-repair-release.json"
```

The repair checkout must be clean and its actual `HEAD` must equal
`TAKOSUMI_CONTROL_D1_SOURCE_COMMIT`; the confirmation does not override that
source check. The current checkout builds the exact current manifest, while
`--confirm-fence-source-commit` identifies the older fence source only. The
release command matches the active fence or durable inactive receipt against
that source, the current manifest, selected environment, and selected
database, then uses the existing atomic guard predicate and release readback.
It is accepted only by `release`, never applies a schema or migration, and
fails closed on any source, manifest, environment, database, or fence mismatch.
The transcript's `sourceCommit` is the current repair checkout and
`confirmedFenceSourceCommit` is the separately confirmed older fence source;
no provider credentials or raw provider response is emitted.

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

Takosumi hosted service implements that ownership ordering during an offline candidate
transform, not by invoking this CLI's remote `apply` against production. Its
private manifest does not replace this OSS gate, and this OSS CLI does not know
about Cloud tables, billing, Cloud capacity, or closed runtime internals.

See Cloudflare's official documentation for
[D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/),
[D1 export](https://developers.cloudflare.com/d1/best-practices/import-export-data/),
and the
[D1 query API](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/query/).
