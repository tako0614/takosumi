# Exact FormRef migration and replay

This runbook covers the operator-only migration from pre-FormRef Resource rows
to one exact installed `FormRef` + `packageDigest` pair. It does not change the
Resource id, import id, native object, or lifecycle authority.

## Preconditions

- the reviewed control schema is applied (D1 v46 or Postgres v94 or later);
- the exact signed package and definition are retained in the Form Registry;
- exactly one reviewed active `FormActivation` is selected for the target kind
  and scope;
- the host has an explicit Workspace-to-Resource-Space authorization mapping;
- a complete authoritative inventory receipt has been captured and reviewed;
- an immutable control backup was captured before the first non-dry-run page.

Never derive a FormRef from `latest`, kind alone, or a caller-selected Space.
The internal route derives the Space from the host mapping and the actor from
the deploy-control bearer.

## Authoritative inventory and receipt binding

Do not derive coverage from the backfill manifest: that cannot detect an
omitted Workspace or Resource. Before generating any per-Workspace backfill
requests, use an unrestricted deploy-control bearer to capture the independent
durable-ledger inventory:

```http
GET /internal/v1/migrations/resource-form-pins/inventory
Authorization: Bearer <instance-wide operator token>
```

The route keyset-pages **all durable Workspaces**, resolves every Workspace to
one explicit authorized Resource Space, and scans all Resources in the ten
bundled Service Form-compatible kinds. It performs the semantic scan twice and
returns no receipt if the two digests differ. A missing/duplicate Space mapping,
cursor cycle, empty non-terminal page, duplicate id, or hard-bound overflow also
fails closed; there is no partial-success response.

Require `complete = true`. The canonical `matrix` has exactly one entry for
every Workspace x bundled-kind scope, including zero-Resource scopes. `rows`
contains exact `workspaceId`, `space`, `resourceId`, `name`, `kind`, and the
current installed Form identity or `null`. It contains no Resource spec,
Output, NativeResource, target, or credential value. `matrixDigest` covers the
canonical matrix and rows but not `capturedAt`, so production-equivalent replica
and production receipts can be compared without pretending their timestamps are
identical.

Generate the backfill set from this receipt and require an exact set/count
comparison before the first write: every non-null row is already pinned and
every null row is either represented by exactly one reviewed backfill candidate
or blocks the cutover. Preserve zero-count matrix scopes. Bind the raw receipt
and `matrixDigest` to the immutable pre-write backup id/digest, its redacted
`resourceFormPins` sidecar digest, source commit, package/activation evidence,
and the cutover manifest. A manifest-provided count or digest is not a substitute
for this receipt.

## Bounded dry run

Use the operator deploy-control URL and keep the bearer outside repository
files and shell history. The body contains no credentials or Resource values.

```http
POST /internal/v1/workspaces/{workspaceId}/migrations/resource-form-pins/backfill
Authorization: Bearer <operator token>
Content-Type: application/json

{
  "kind": "ObjectBucket",
  "activationIds": ["activation_exact_object_bucket"],
  "dryRun": true,
  "limit": 100
}
```

Require `refused = 0` and review every `would_pin` row. The response contains
only Resource id, kind, outcome/reason, activation id, and the exact installed
identity key. It contains no spec, Output, target, NativeResource value, or
credential. If `nextCursor` is present, echo it in the next request and keep
the same reviewed activation set.

## Apply

Repeat the same bounded request with `dryRun` omitted or `false`. Stop on the
first refused row or unexpected count. Every successful row atomically pins
both Resource and ResolutionLock and emits an idempotent redacted activity
event. Retry is safe: a backfill scan omits rows that are already pinned, while
an exact backup replay reports `already_pinned`. A substituted identity or
concurrent Resource/lock change fails closed.

After the last page:

1. read the Resource and ResolutionLock and compare their exact identity;
2. run observe/refresh without backend recreation;
3. verify the canonical direct-operation Run/result and NativeResource
   evidence carry the same pair;
4. retain the package and definition even if the activation is later disabled
   or the package is deprecated/revoked.

## Isolated backup replay drill

Do not down-migrate or clear exact pins. Restore the control backup into an
isolated target, then obtain the redacted `resourceFormPins` sidecar from the
operator backup tooling. Replay one bounded page:

```http
POST /internal/v1/workspaces/{workspaceId}/migrations/resource-form-pins/restore
Authorization: Bearer <operator token>
Content-Type: application/json

{
  "entries": [
    {
      "resourceId": "tkrn:...",
      "resourceScopeId": "...",
      "kind": "ObjectBucket",
      "identity": {
        "formRef": {
          "apiVersion": "forms.takoform.com/v1alpha1",
          "kind": "ObjectBucket",
          "definitionVersion": "...",
          "schemaDigest": "sha256:..."
        },
        "packageDigest": "sha256:..."
      }
    }
  ],
  "limit": 100
}
```

Replay verifies retained package/definition bytes and atomically writes only
the exact pair onto an existing coherent Resource/ResolutionLock. It never
invokes resolution or a backend adapter. A scope mismatch, missing lock,
unverifiable retained package, or concurrent change is refused.

Record source commit, schema manifest digest, backup id/time, activation id,
authoritative inventory receipt/digest, sidecar digest, page cursors/counts,
response digests, post-replay read/observe result, and the isolated-target
teardown in operator-private evidence. Live staging replay is not a substitute
for the isolated production-equivalent release gate; repository tests alone are
not live rollback evidence.

## Production-equivalent pre-FormRef replica drill

Before the first production migration, prove the full forward-and-restore path
on two newly created, purpose-named scratch databases. Never point these
commands at production or the shared staging database. Evidence belongs in an
operator-owned directory outside every repository, with directory mode `0700`
and file mode `0600`.

Generate the legacy fixture from the reviewed implementation immediately
before FormRef persistence, rather than maintaining handwritten legacy SQL:

```bash
bun run service-form:formref-replica-fixture -- \
  --predecessor-checkout /absolute/path/to/clean/reviewed-v44-checkout \
  --sqlite-output /absolute/private/evidence/pre-formref-v44.sqlite \
  --sql-output /absolute/private/evidence/pre-formref-v44.sql \
  --evidence-output /absolute/private/evidence/pre-formref-v44.json
```

The generator pins the reviewed predecessor commit, requires a clean checkout,
materializes schema v44 through that checkout's migration code, writes the
legacy Resource/ResolutionLock pair through that checkout's stores, and proves
that neither table has exact Form identity columns. SQLite `.dump` transaction
wrappers are not valid D1 import statements; remove only `BEGIN TRANSACTION`
and `COMMIT` in a separately digested D1-import copy.

After importing that fixture into distinct primary and restore scratch D1
databases, run the live harness with an OAuth/API token supplied only through
`CLOUDFLARE_API_TOKEN`:

```bash
bun run service-form:formref-replica-drill -- \
  --source-commit <clean-exact-head> \
  --account-id <scratch-account-id> \
  --primary-database-id <scratch-primary-id> \
  --primary-database-name takosumi-formref-primary-YYYYMMDD-<nonce> \
  --restore-database-id <scratch-restore-id> \
  --restore-database-name takosumi-formref-restore-YYYYMMDD-<nonce> \
  --takoform-root /absolute/path/to/clean/reviewed-takoform-checkout \
  --evidence-directory /absolute/private/evidence
```

The harness requires the supplied source commit to equal the clean checkout
HEAD and refuses database names outside the two scratch prefixes. Before any
schema write it reads back schema v44, exact row counts, the synthetic fixture
id/spec/output/lock markers, and the absence of FormRef columns from both
targets. It then applies the canonical current D1 migration to both databases;
verifies the reviewed
signed ObjectBucket package and exact activation; exports pre-write backups;
proves missing-activation refusal, dry-run immutability, atomic backfill,
idempotent retry, and partial-pair trigger refusal; then replays the redacted
sidecar into the separate restore database and proves wrong-scope,
unverifiable-package, and missing-lock refusals plus idempotent restore. It
writes no account/database id to the final report, only SHA-256 fingerprints.

Delete both scratch databases by their exact names after preserving the final
exports and transcripts. Record deletion success in the private evidence set;
do not use wildcard cleanup.
