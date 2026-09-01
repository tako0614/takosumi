# Schema と version の対応表

Takosumi に単一の「schema version」はありません。API、永続化 migration、
repository manifest、実行時 ABI は別々の authority と互換性規則を持ちます。
この表の高い migration 番号は append-only ledger の位置であり、Takosumi の
product version や破壊的変更の回数ではありません。

このページは current source と同じ変更で更新します。
`tests/scripts/schema_matrix_documentation_test.ts` は、source catalog の最新値、
日本語/英語ページ、公開済み JSON Schema の範囲がずれた場合に失敗します。

## 現行 matrix

| Lane | 現行 identity | Authority / source | Writer と reader | 互換性と変更方法 |
| --- | --- | --- | --- | --- |
| OSS package | `@takosjp/takosumi` `1.0.0`; `@takosjp/takosumi-contract` `2.0.0` | `package.json`; `contract/package.json` | package publisher / package consumer | software SemVer。API、DB、個別 envelope の version を暗黙に変更しない |
| public capability API | `takosumi.dev/v1alpha1` | `contract/capabilities.ts` | Takosumi discovery / dashboard、CLI、client | 現行 discovery lane はこれだけ。新 lane は source、OpenAPI、route inventory、JP/EN docs を同時更新する |
| OpenAPI document | dialect `3.1.0`; `info.version` `1.0.0` | `core/api/openapi.ts` | API server / generated・manual client | `info.version` は package releaseとlockstep。path上のAPI identityやDB migration番号ではない |
| control storage (PostgreSQL-compatible) | latest migration `110` | `core/adapters/storage/migrations.ts`; `core/adapters/storage/migration-runner/mod.ts` | owning predeploy runner / control plane | `storage_migrations` のappend-only ledger。productionはforward-only。operator手順は非公開runbook `docs/operations/online-db-migrations.md` が所有する |
| platform control D1 | manifest `2`; latest migration `66`; catalog entries `63` | `worker/src/d1_opentofu_store.ts`; `deploy/platform/control_d1_schema.ts` | owning deploy preflight / platform Worker | hosted環境はfirst requestで変更せず、plan/apply/verifyを先に実行。operator手順は非公開runbook `docs/operations/control-d1-schema-predeploy.md` が所有する。manifest/schema/ledger digestはcommitごとのevidenceでありversion laneではない |
| Accounts PostgreSQL | latest migration `037` | `accounts/service/migrations/*.sql`; `accounts/service/migrations/README.md` | Accounts migration command / Accounts service | filenameとledger checksumをappend-onlyで保持。破壊的変更はexpand/backfill/contractとforward repairを記録する |
| Accounts D1 | latest migration `4` | `cli/src/cli-accounts-db.ts`; `deploy/accounts-cloudflare/src/handler.ts` | `accounts migrate-d1` / Accounts Worker | version `0` bootstrap + forward migrations。Workerは期待versionとledgerをfail-closedで確認する |
| repository manifest | parser: `takosumi.com/v1`, `takosumi.com/v2`, `takosumi.com/v2.1`, `takosumi.com/v2.2`, `takosumi.com/v2.3`; checked-in schemas: `v2.1`–`v2.3` | `contract/repository-manifest.ts`; `docs/public/schemas/repository-manifest-v2.*.schema.json` | repository / same-commit manifest compiler | 各laneはclosed object。`v1`/`v2`はparser compatibilityのみ。`v2.2`はInterface consume、`v2.3`はcredential-free `sourceBuild`を追加 |
| Capsule source options | `install.takosumi.com/v1alpha1` | `contract/capsules.ts` | repository/install source / Accounts・dashboard | closed envelope。互換でないfield/meaningは新identityとmigration noteを必要とする |
| optional Form host boundary | `forms.takoform.com/v1alpha1`; `takoform.host-api@v1alpha1`; install envelope `takosumi.takoform-install-envelope-set@v3` | `contract/form-host-interoperability.ts`; `contract/service-forms.ts` | external Form/package flow / optional host adapter | portable Takoform authorityではない。Formの`definitionVersion`とTakosumi software versionを同期させない |
| legacy Generic Offering surface | current `/v1/offering-*` routes and Offering store | `core/domains/offerings/`; route inventory | operator-only compatibility / migration-delete owner | Takosumi Core の supported authority ではない。新しい integration では使わず、managed Offering は Takoserver が所有する |
| background/runtime ABI | background authority/result `v2`; host runtime materialization `v1`; managed runtime/relational batch `v1` | `contract/background-events.ts`; `contract/host-runtime-materialization.ts`; `contract/managed-runtime-connections.ts`; `contract/managed-relational-runtime.ts` | host/runner / exact ABI consumer | producerと全consumerが同時に読めるwindowを用意する。同一tokenの意味変更には旧reader regressionと互換性noteが必要 |
| readiness/config evidence | platform readiness `v2`; platform hardening `v1`; provider configurations `@v1` | `contract/platform-readiness.ts`; `contract/platform-hardening.ts`; `contract/provider-configurations.ts` | operator tooling / validator | evidence formatのversion。service APIやDB schemaのversionではない |
| runner durable receipts | mutation dispatch/semantics `v2`; credential authority `v1`; run owner `v1` | `worker/src/durable/OpenTofuRunnerObject.ts`; `worker/src/durable/OpenTofuRunOwnerObject.ts` | Durable Object / recovery・audit reader | acknowledgement-loss後のrecovery identity。旧receiptを上書きせず、新readerまたは明示migrationを追加する |
| SourceSnapshot / StateVersion / Run | 独立したwire schema versionなし | `contract/sources.ts`; `contract/state-versions.ts`; `contract/runs.ts`; owning DB migrations | Takosumi control plane / dashboard、runner | TS shapeと永続化migrationがauthority。便宜的なglobal schema versionを追加しない |

Takosumi Cloud は退役した historical identity で、current availability/pricing/SLA/support
authority ではありません。Takosumi Hosted が retail/commerce/client composition を
所有する場合も、managed supply、capacity、provider credential、Offering は Takoserver が
所有します。各外部 product は利用する OSS commit と schema evidence を exact pin し、
自分の private matrix/history で管理します。

## Versionを変えるとき

1. 変更対象のauthorityを一つ決めます。package、API、DB catalog、envelopeを一緒に
   version upしません。
2. additiveかbreakingか、writer/reader window、既存データ、forward repairを記録します。
3. DB変更は新しいmigration entryを追加し、適用済みentryの意味や名前を再利用しません。
4. `@vN`/`apiVersion`を維持する場合は、旧readerが新しい値を受け取っても同じ意味で
   処理できるtestを追加します。証明できなければ新しいidentityにします。
5. このmatrix、日本語/英語の利用者向け文書、生成schema/OpenAPI、consumer testを
   同じchangeで更新します。

## Release と recovery

- production/stagingのDB変更はowning deploy/predeploy入口だけから行います。
- migration番号だけでbreakingnessを判断しません。各entryのdescription、SQL、
  compatibility window、backup/restore evidenceを確認します。
- rollback用の逆SQLをproduction authorityにしません。互換な直前artifact、restore、
  または新しいforward-repair migrationを使います。
- backup/restore evidenceには対象lane、latest applied migration、catalog/manifest digest、
  application commitを記録します。
