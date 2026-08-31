# Schema and version matrix

Takosumi has no single global "schema version". APIs, durable migrations,
repository manifests, and runtime ABIs have separate authorities and
compatibility rules. A high migration number is a position in an append-only
ledger, not the product version or a count of breaking changes.

This page changes with the current source. The regression test at
`tests/scripts/schema_matrix_documentation_test.ts` fails when the source
catalog, the Japanese and English matrices, or the published JSON Schema set
drift apart.

## Current matrix

| Lane | Current identity | Authority / source | Writer and reader | Compatibility and change rule |
| --- | --- | --- | --- | --- |
| OSS package | `@takosjp/takosumi` `1.0.0`; `@takosjp/takosumi-contract` `2.1.0` | `package.json`; `contract/package.json` | package publisher / package consumer | Software SemVer. It does not implicitly change an API, database, or envelope version |
| public capability API | `takosumi.dev/v1alpha1` | `contract/capabilities.ts` | Takosumi discovery / dashboard, CLI, client | This is the only current discovery lane. A new lane updates source, OpenAPI, route inventory, and both language docs together |
| OpenAPI document | dialect `3.1.0`; `info.version` `1.0.0` | `core/api/openapi.ts` | API server / generated or manual client | `info.version` follows the package release. It is not the API path identity or a database migration number |
| control storage (PostgreSQL-compatible) | latest migration `111` | `core/adapters/storage/migrations.ts`; `core/adapters/storage/migration-runner/mod.ts` | owning predeploy runner / control plane | Append-only `storage_migrations` ledger; production is forward-only. The private operator runbook `docs/operations/online-db-migrations.md` owns the procedure. Empty-state retirement of the embedded Form Host is v110 |
| platform control D1 | manifest `2`; latest migration `67`; catalog entries `64` | `worker/src/d1_opentofu_store.ts`; `deploy/platform/control_d1_schema.ts` | owning deploy preflight / platform Worker | Hosted environments run plan/apply/verify before traffic, not mutation on first request. The private operator runbook `docs/operations/control-d1-schema-predeploy.md` owns the procedure. Empty-state retirement of the embedded Form Host is v66. Manifest/schema/ledger digests are per-commit evidence, not version lanes |
| Accounts PostgreSQL | latest migration `044` | `accounts/service/migrations/*.sql`; `accounts/service/migrations/README.md` | Accounts migration command / Accounts service | Preserve filename and checksum ledger append-only; record expand/backfill/contract and forward repair for destructive transitions |
| Accounts D1 | latest migration `4`; catalog entries `5` (including bootstrap `0`) | `accounts/service/src/d1-migrations.ts`; `cli/src/cli-accounts-d1.ts`; `deploy/accounts-cloudflare/src/handler.ts` | Accounts D1 migration command / Accounts Worker | Version `0` bootstrap plus forward migrations; the Worker fails closed on expected-version or ledger drift |
| repository manifest | parser: `takosumi.com/v1`, `takosumi.com/v2`, `takosumi.com/v2.1`, `takosumi.com/v2.2`, `takosumi.com/v2.3`, `takosumi.com/v2.4`; checked-in schemas: `v2.1`–`v2.4` | `contract/repository-manifest.ts`; `docs/public/schemas/repository-manifest-v2.*.schema.json` | repository / same-commit manifest compiler | Every lane is a closed object. `v1`/`v2` are parser-compatibility lanes only; `v2.2` adds Interface consumption, `v2.3` adds credential-free `sourceBuild`, and `v2.4` adds binding-delivered OIDC `ownerSubject` |
| retired embedded Form host | no current OSS schema; `forms.takoform.com/v1alpha1` is retained FormRef/migration data only | `docs/internal/core-spec.md`; `contract/platform-extension-routes.ts` | external Form Host / Takosumi migration custody | Takosumi does not mount `/apis/forms.takoform.com/...`; those paths remain unconditional `404`. The portable Form protocol and backend authority belong to an external Host |
| background/runtime ABI | background authority/result `v2`; managed runtime connection `v1`; managed relational batch `v1` | `contract/background-events.ts`; `contract/managed-runtime-connections.ts`; `contract/managed-relational-runtime.ts` | host/runner / exact ABI consumer | Provide a window in which every producer and consumer can read the shape. Same-token semantic changes require old-reader regression evidence and a compatibility note |
| readiness/config evidence | platform readiness `v2`; platform hardening `v1`; provider configurations `@v1` | `contract/platform-readiness.ts`; `contract/platform-hardening.ts`; `contract/provider-configurations.ts` | operator tooling / validator | Evidence-format versions, not service API or database versions |
| runner durable receipts | mutation dispatch/semantics `v2`; credential authority `v1`; run owner `v1` | `worker/src/durable/OpenTofuRunnerObject.ts`; `worker/src/durable/OpenTofuRunOwnerObject.ts` | Durable Object / recovery and audit reader | Recovery identities after acknowledgement loss; never overwrite an old receipt, add a reader or an explicit migration |
| SourceSnapshot / StateVersion / Run | no independent wire-schema version | `contract/sources.ts`; `contract/state-versions.ts`; `contract/runs.ts`; owning database migrations | Takosumi control plane / dashboard and runner | TypeScript shape and durable migrations are authoritative. Do not add a convenience global schema version |

Takosumi Cloud is a separate closed delta with its own D1 component manifest.
Private component numbers are not copied into the OSS public contract. Cloud
must exact-pin the OSS commit and schema evidence it consumes and maintain its
own matrix and history.

## Changing a version

1. Select one owning authority. Do not bump package, API, database catalog, and
   envelope versions as a unit.
2. Record whether the change is additive or breaking, its writer/reader window,
   existing-data behavior, and forward repair.
3. Add a new database migration entry; never reuse the name or meaning of an
   applied entry.
4. When retaining an `@vN` or `apiVersion`, add evidence that an old reader
   receives the new value with unchanged meaning. Otherwise mint a new identity.
5. Update this matrix, both language docs, generated schema/OpenAPI, and
   consumer tests in the same change.

## Release and recovery

- Mutate staging or production databases only through the owning deploy or
  predeploy entrypoint.
- Do not infer breakingness from a migration number. Read the entry description,
  SQL, compatibility window, and backup/restore evidence.
- Reverse SQL is not production rollback authority. Use a compatible previous
  artifact, restore, or a new forward-repair migration.
- Backup/restore evidence records the lane, latest applied migration,
  catalog/manifest digest, and application commit.
