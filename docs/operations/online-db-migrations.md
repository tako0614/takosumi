# Operations: Online DB Migrations

> このページでわかること: Takosumi の永続 accounts / control ledger を
> zero-downtime に migration するための expand / backfill / contract 手順、
> rollback 方針、state-transition evidence。D1 と Postgres は同じ論理 model の adapter です。

この runbook は **self-host/operator-owned Takosumi environment** のDB migration
手順と、registered release adapterが満たすべきstate-transition contractを定義します。
対象は platform worker が所有する accounts plane と control-plane ledger
(Workspace / Project / Capsule / Source / GitInstallPlan / GitRevisionPlan / ProviderConnection / CredentialRecipe / ProviderBinding / Secret / Run /
StateVersion / Output / Runner / AuditEvent / Operator settings / RunCost / UsageEvent) です。
既存 ledgers に Space / Installation / StateSnapshot / OutputSnapshot / Deployment などの旧行が残る場合は、Final Plan
model への migration 対象として扱います。host/distribution product の app-local DB migration は各 product docs の領域であり、
この runbook では扱いません。

production surfaceのdeployはこのrepositoryのentrypointを使います。共通ruleは
`takos-control`の`engineering.policy.json`→`deploy`が正本です。

```bash
bun run deploy
```

schema/data/topologyを変更するdeployは`state-change` classであり、
独立review、isolated rehearsal、forward-repair計画を要求します。以下のCLI例は
self-host operatorまたは固定adapterのimplementation building blockであり、公式
Takosumi hosted serviceへのraw migration authorityではありません。

## Scope

| Store                   | Contains                                                                                                                                                                                                                              | Migration owner                                                    |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Accounts ledger         | users, sessions, Workspace membership, and OIDC issuer records                                                                                                                                                                        | Takosumi accounts plane                                            |
| Control-plane ledger    | Workspace, Project, Capsule, Source, GitInstallPlan, GitRevisionPlan, ProviderConnection, CredentialRecipe, ProviderBinding, Secret metadata, Run, StateVersion, Output, Runner, Artifact, RunCost, UsageEvent, Audit, plus legacy rows while migrations are in flight | Takosumi control plane                                             |
| Artifact-store metadata | opaque refs for source archives, artifacts, state, backups                                                                                                                                                                            | owning storage adapter; change only with matching ledger migration |

realized config では accounts と control-plane を別 database / schema にしても
よいですが、正本 model は単一 Takosumi origin が所有する同じ論理 ledger
です。D1 の binding 名や Postgres の schema 名は adapter-private です。

Migration は customer-facing command surface ではありません。operator は
platform worker deploy と同じ change window で migration を扱い、production /
staging の database id や backup id は private run log にだけ記録します。Accounts
owner CLI は raw Wrangler を使わず Cloudflare D1 REST API を呼ぶため、realized config
の明示的な account ID と D1 database UUID を受け取ります。transcript は ID/token/row
を出さず、それらから作った target/config/ledger/schema digest だけを残します。

control-plane D1 の通常リリースでは ad hoc `d1 execute` ではなく
[Control D1 schema predeploy](control-d1-schema-predeploy.md) を使い、current OSS commit
から生成した manifest digest を明示確認して staging → production の順に apply / verify する。
下記の Accounts CLI 例は accounts-plane owner の経路であり、control D1 gate の代替ではない。

### Boot policy

production / staging の process boot は migration を実行しません。Postgres
migration は deploy 前の明示的な `bun run db:migrate` jobだけが適用し、service
boot は `storage_migrations` ledgerをread-onlyで検証します。pending migration、
未知のledger row、checksum drift、database接続失敗、またはproduction-like環境で
database URLが欠けている場合、processはtrafficを受けずに起動失敗します。

Accounts D1 の feature bridge も request-time migration を行いません。bridge は exact
legacy v3 または exact checksummed v4 だけを受理し、`predeployed` では schema/ledger
を read-only 検証して DDL は 0 です。one-time rollout は bridge deploy → bounded
pre-ledger backfill → v4 atomic apply/read-only verify → observation window → separate
exact-v4 tightening の順です。
v4 commit 後は v3-only artifact が rollback cutoff の外になります。

protected production schema は forward-only です。確認句やoverride flagを付けた
down-migration runnerも公開せず、失敗後は互換な直前artifact、forward repair、
またはmigrationとは別authorityのrecovery手順を選びます。migration catalogの
reverse SQLはchecksum互換性と明示的なlocal / development / test fixture reset
だけに残し、fixture reset moduleはdatabase URLやproduction credentialを解決しません。

`TAKOSUMI_DB_AUTO_MIGRATE=true` はlocal / development専用の明示的な利便機能です。
production / stagingでの指定は拒否されます。未指定または`false`は「検証を省略」
ではなく「schemaを書き換えず、predeploy済みであることだけを検証」を意味します。

## Gate

実行:

```bash
cd takosumi
bun run check
bun test tests/core/adapters/storage/migration-runner/mod_test.ts tests/core/adapters/storage/migration-runner/fixture_reset_test.ts
bun test tests/core/adapters/storage/drizzle/schema/schema_mirror_test.ts
```

`bun run check` is required here because it includes the root typecheck and
supported distribution builds that raw `tsc --noEmit` does not cover.

変更が API contract / dashboard に影響する場合は追加で:

```bash
cd takosumi
bun test core/api/route_inventory_test.ts
bun run check:dashboard
```

## Safety Classes

新規 migration は次のいずれかに分類します。

| Class       | Use                                            | Production rule                           |
| ----------- | ---------------------------------------------- | ----------------------------------------- |
| `expand`    | additive table / column / index                | deploy before code requires the new shape |
| `backfill`  | idempotent data copy / repair                  | chunked, observable, resumable            |
| `contract`  | remove old shape after all code stops using it | explicit approval and restore plan        |
| `emergency` | incident-only repair                           | incident commander approval               |

expand と contract を同じ release に混ぜないこと。Run / StateVersion /
Output / audit ledger は replay ではなく正本 record です。旧 StateSnapshot /
OutputSnapshot rows が残る環境でも、destructive
DDL は原則 `contract` window まで延期します。

## Zero-downtime Pattern

1. Expand: nullable / default 付き column、additive table、additive index を追加する。
2. service code を旧 shape / 新 shape の両方に互換にする。
3. backfill は bounded chunk で実行し、idempotency key または cursor を持たせる。
4. dashboard / API / queue consumer が新旧両方を読める observation window を置く。
5. read path を新 shape に切り替える。
6. Contract: backup / restore drill evidence と rollback note が揃ってから旧 shape を削除する。

## Dangerous DDL

以下は marker なしで実行してはいけません。

- `DROP TABLE`
- `DROP COLUMN`
- `ALTER TABLE ... RENAME TO`
- `ALTER TABLE ... RENAME COLUMN`
- `ALTER TABLE ... ALTER COLUMN ... SET NOT NULL`
- unique constraint / index の追加

dangerous DDL は migration comment、issue / incident link、forward repair か
restore plan を必ず持たせます。場当たり的な逆 SQL を rollback plan として
扱わないこと。

control D1 の contract migration は、predeploy CLI が取得する durable
maintenance fence の外では実行しません。v24 以降の destructive rebuild は
copy / drop / rename / index 再作成と migration-ledger insert を同じ D1 batch
transaction に含めます。失敗時は全体 rollback し、fence は active のまま残す
ため、request write と部分 schema が混在する状態を許しません。

## Failure and reversal procedure

`expand` / `backfill`:

1. rollout を停止し、expanded schema は維持する。
2. code を新旧両 shape に互換な直前 version へ戻す。
3. backfill が誤データを作った場合は forward repair を実行する。
4. cleanup は次の patch window まで延期する。

`contract`:

1. 旧 code path がどこにも deploy されていないことを確認する。
2. backup と restore drill evidence の存在を確認する。
3. staging で同じ contract migration を実行済みであることを確認する。
4. contract 後の rollback は restore か forward repair に限定する。

`emergency`:

1. incident commander が migration を承認する。
2. 変更前の evidence を保全する。
3. incident 緩和に必要な最小限だけ実行する。
4. 通常 migration に畳み込む follow-up を起票する。

## Self-host/operator execution checklist

production 前:

- targeted tests と typecheck が green
- migration が safety class を持つ
- staging で同じ migration を実行済み
- backup restore path が判明している
- platform worker rollback version / commit が判明している
- queue consumer / scheduled handler を freeze する必要があるか判断済み

Self-host/operator-owned Postgres compositionの実行例:

```bash
cd takosumi
bun run cli -- accounts migrate --database-url "$TAKOSUMI_ACCOUNTS_DATABASE_URL"
```

Self-host/operator-owned Cloudflare D1 reference compositionの実行例:

```bash
cd takosumi
bun run cli -- accounts migrate-d1 plan \
  --environment staging \
  --account-id "$CLOUDFLARE_ACCOUNT_ID" \
  --database-id "$CLOUDFLARE_DATABASE_ID" \
  --source-commit "$SOURCE_COMMIT" \
  --backup-evidence-digest "$BACKUP_EVIDENCE_DIGEST"
# plan の source/catalog/target/configuration digest と private backup evidence を確認
bun run cli -- accounts migrate-d1 apply ... \
  --confirm-source-digest "$SOURCE_DIGEST" \
  --confirm-catalog-digest "$CATALOG_DIGEST" \
  --confirm-target-digest "$TARGET_DIGEST" \
  --confirm-configuration-digest "$CONFIGURATION_DIGEST"
bun run cli -- accounts migrate-d1 verify ...
```

同じ手順を staging 完了後に production の explicit ID で繰り返します。`plan` は remote
call 0、`status` / `verify` は read-only です。apply は pending migration ごとに plain
receipt INSERT を含む D1 atomic batch を 1 回だけ送り、同一 catalog の racing winner
だけ exact receipt で reconcile します。exact pre-state のままなら新しい operator
invocation での retry を要求し、partial/mismatch/read failure は indeterminate です。
raw bookmark は source checkout 外の owner UID 0700 directory / atomic no-replace
0600 regular file の owner-private custody に置き、apply にはその opaque digest だけを
渡します。configuration digest はこの backup evidence と versioned backfill/schema
policy（`key` cursor / 100-row chunk を含む）を同時に束縛します。restore は別の
incident authority です。

全 mode は plan 構築より前に owning Takosumi checkout を hardened Git で観測します。
`rev-parse --show-toplevel` の realpath、HEAD、tracked/untracked を含む porcelain status
が exact import-relative root / `--source-commit` / clean state と一致しない限り、token、
transport、bookmark、evidence file には触れません。ambient `GIT_DIR` / `GIT_WORK_TREE`、
global/system config、external fsmonitor は authority になりません。

bridge Worker が exact v3 を serve している間に、owner CLI は
`bucket='oidc_clients' AND key > cursor` を `ORDER BY key LIMIT 100` で読みます。
各 row が `key == clientId`、non-empty `capsuleId`、valid non-null
`activationDigest` を満たす Capsule-bound document であることを確認し、
chunk ごとに exact-v3 ledger/schema guard と bucket/key/missing 条件付き UPDATE を
同じ D1 atomic batch で一度だけ行います。cursor は memory only、UPDATE は restart-safe
で、lost acknowledgement は選択済み key と exact state の read-only reconciliation
だけを行います。fence loss では exact clean v4 だけを採用し、v4+missing や drift へ
post-cutoff repair write をしません。key/document は public evidence に出しません。全体の
zero-missing を確認した後、v4 batch の第1 statement が exact v3 ledger、canonical
`sqlite_master` schema closure、zero-missing を同一 transaction 内で再 fence し、続いて ALTER、v0-v3 checksum
backfill、v4 receipt を commit します。順序は bridge deploy → bounded backfill →
atomic v4 → exact-v4-only Worker であり、v4 後に bridge より古い Worker へ rollback
しません。

production 後（`$TAKOSUMI_ORIGIN` は operator が公開した origin）:

- `$TAKOSUMI_ORIGIN/healthz` が green
- OIDC discovery / JWKS が serve される
- `GET /api/v1/workspaces` が認証なしで 401 を返す
- known staging / production Workspace の Capsule list が読める
- compatibility check / plan read path が smoke できる
- migration runtime、row 数、skip した duplicate DDL を private evidence に記録する

## Evidence

public evidence:

- test / typecheck summary
- pull request link
- shipped commit, artifact digest, and readback result

private evidence:

- production migration run log
- backup snapshot/bookmark id とその opaque evidence digest
- database id / account id
- restore drill link
