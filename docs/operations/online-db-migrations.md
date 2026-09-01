# Operations: Online DB Migrations

> このページでわかること: Takosumi の永続 accounts / control ledger を
> zero-downtime に migration するための expand / backfill / contract 手順、
> rollback 方針、state-transition evidence。D1 と Postgres は同じ論理 model の adapter です。

この runbook は **self-host/operator-owned Takosumi environment** のDB migration
手順と、registered release adapterが満たすべきstate-transition contractを定義します。
対象は platform worker が所有する accounts plane と control-plane ledger
(Workspace / Project / Capsule / Source / ProviderConnection / CredentialRecipe / ProviderBinding / Secret / Run /
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
Takosumi Cloudへのraw migration authorityではありません。

## Scope

| Store                   | Contains                                                                                                                                                                                                                              | Migration owner                                                    |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Accounts ledger         | users, sessions, Workspace membership, and OIDC issuer records                                                                                                                                                                        | Takosumi accounts plane                                            |
| Control-plane ledger    | Workspace, Project, Capsule, Source, ProviderConnection, CredentialRecipe, ProviderBinding, Secret metadata, Run, StateVersion, Output, Runner, Artifact, RunCost, UsageEvent, Audit, plus legacy rows while migrations are in flight | Takosumi control plane                                             |
| Artifact-store metadata | opaque refs for source archives, artifacts, state, backups                                                                                                                                                                            | owning storage adapter; change only with matching ledger migration |

realized config では accounts と control-plane を別 database / schema にしても
よいですが、正本 model は単一 Takosumi origin が所有する同じ論理 ledger
です。D1 の binding 名や Postgres の schema 名は adapter-private です。

Migration は customer-facing command surface ではありません。operator は
platform worker deploy と同じ change window で migration を扱い、production /
staging の database id や backup id は private run log にだけ記録します。
Wrangler 4.x の `d1 execute` は positional に D1 database name / binding を受け取るため、
runbook の `--database-id` には UUID ではなく realized config の database name または binding
名を渡します。UUID は private evidence として記録してもよいが、CLI 実行引数の正本にしません。

control-plane D1 の通常リリースでは ad hoc `d1 execute` ではなく
[Control D1 schema predeploy](control-d1-schema-predeploy.md) を使い、current OSS commit
から生成した manifest digest を明示確認して staging → production の順に apply / verify します。
下記の Accounts CLI 例は accounts-plane owner の経路であり、control D1 gate の代替ではありません。

### Boot policy

production / staging の process boot は migration を実行しません。Postgres
migration は deploy 前の明示的な `bun run db:migrate` jobだけが適用し、service
boot は `storage_migrations` ledgerをread-onlyで検証します。pending migration、
未知のledger row、checksum drift、database接続失敗、またはproduction-like環境で
database URLが欠けている場合、processはtrafficを受けずに起動失敗します。

protected production schema は forward-only です。確認句やoverride flagを付けた
down-migration runnerも公開せず、失敗後は互換な直前artifact、forward repair、
またはmigrationとは別authorityのrecovery手順を選びます。migration catalogの
reverse SQLは明示的なlocal / development / test fixture reset
だけに残し、fixture reset moduleはdatabase URLやproduction credentialを解決しません。

`TAKOSUMI_DB_AUTO_MIGRATE=true` はlocal / development専用の明示的な利便機能です。
production / stagingでの指定は拒否されます。未指定または`false`は「検証を省略」
ではなく「schemaを書き換えず、predeploy済みであることだけを検証」を意味します。

### Checksum policy

`storage_migrations` に記録する checksum は **id・version・実行される SQL** だけ
から作ります。SQL は行頭の `--` comment、行末の空白、空行を落としてから hash する
ので、comment の加筆や整形は適用済み ledger を壊しません。`description` と fixture
reset用の `down` SQL は checksum に含めません。どちらも protected database には
到達しないため、released entry の文言修正が本番の boot を落とす理由にはなりません。

古い runner が書いた ledger は旧 digest のままでも verify を通ります。
`bun run db:migrate` が非 dry-run で走ると、その行を canonical digest へ
書き換え、件数を `reconciled N pre-canonical checksum row(s)` として出力します。
`plan` は未変換の行数を先に報告します。**editorial な変更（description・`down`・
comment）を含む release の前に、対象環境で一度 `bun run db:migrate` を通して
reconcile を終わらせてください。** 全環境の `legacyChecksumIds` が 0 になったら、
runner の旧 digest 受理経路は削除できます。

新 runner を deploy するだけなら順序の制約はありません。旧 digest はそのまま
verify を通るので、`db:migrate` 前に service が起動しても失敗しません。ただし
**reconcile 済みの database に対して旧 runner の artifact へ戻すと、旧 runner は
canonical digest を知らないため checksum mismatch で起動しません。** reconcile を
含む release の reversal は「直前 artifact へ戻す」ではなく forward repair
（新 runner を含む artifact を再度出す）です。

### Retiring a released migration

catalog から released migration を消すときは、`retiredStorageMigrations` に
`{ id, version, reason }` を宣言します。宣言があれば、その migration を適用済みの
database は ledger 行を保持したまま起動できます。宣言がないまま消すと
`StorageMigrationCatalogError` で永久に起動不能になります。retire した id と
version は二度と再利用できません（runner が catalog 構築時に拒否します）。

retire してよいのは、**新規 database がその migration を必要としない**とき、つまり
後続 migration がその形に依存していないときだけです。

### Disposable fixture reset

local / development / test の使い捨て database だけは巻き戻せます。

```bash
cd takosumi
TAKOSUMI_FIXTURE_DATABASE_URL=postgres://takos@127.0.0.1:5432/takosumi_dev \
  bun run db:fixture-reset -- --scope=local --steps=1 --dry-run
```

この CLI は fail-closed です。`--scope` は local / development / test のみ、接続先は
`--url` か `TAKOSUMI_FIXTURE_DATABASE_URL` だけから解決し（`DATABASE_URL` や
`TAKOSUMI_PRODUCTION_DATABASE_URL` は読みません）、host は loopback か unix socket
に限り、`TAKOSUMI_ENVIRONMENT` が production / staging なら拒否します。`down` を
持たない migration に当たるとそこで停止します。protected production schema に
対応する経路はありません。

## Gate

実行:

```bash
cd takosumi
bun run check
bun test tests/core/adapters/storage/migration-runner/mod_test.ts tests/core/adapters/storage/migration-runner/fixture_reset_test.ts
bun test tests/core/adapters/storage/drizzle/schema/schema_mirror_test.ts
bun test tests/core/scripts/db_fixture_reset_test.ts
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

1. Expand: nullable / default 付き column、additive table、additive index を追加します。
2. service code を旧 shape / 新 shape の両方に互換にします。
3. backfill は bounded chunk で実行し、idempotency key または cursor を持たせます。
4. dashboard / API / queue consumer が新旧両方を読める observation window を置きます。
5. read path を新 shape に切り替えます。
6. Contract: backup / restore drill evidence と rollback note が揃ってから旧 shape を削除します。

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

control D1 の contract migration は、predeploy CLI が取得する永続
maintenance fence の外では実行しません。v24 以降の destructive rebuild は
copy / drop / rename / index 再作成と migration-ledger insert を同じ D1 batch
transaction に含めます。失敗時は全体 rollback し、fence は active のまま残す
ため、request write と部分 schema が混在する状態を許しません。

## Failure and reversal procedure

`expand` / `backfill`:

1. rollout を停止し、expanded schema は維持します。
2. code を新旧両 shape に互換な直前 version へ戻します。
3. backfill が誤データを作った場合は forward repair を実行します。
4. cleanup は次の patch window まで延期します。

`contract`:

1. 旧 code path がどこにも deploy されていないことを確認します。
2. backup と restore drill evidence の存在を確認します。
3. staging で同じ contract migration を実行済みであることを確認します。
4. contract 後の rollback は restore か forward repair に限定します。

`emergency`:

1. incident commander が migration を承認します。
2. 変更前の evidence を保全します。
3. incident 緩和に必要な最小限だけ実行します。
4. 通常 migration に畳み込む follow-up を起票します。

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
bun run cli -- accounts migrate-d1 --database-id takosumi-accounts-staging --remote
bun run cli -- accounts migrate-d1 --database-id takosumi-accounts --remote
```

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
- backup snapshot id
- database id / account id
- restore drill link
