# Operations: Online DB Migrations

> このページでわかること: Takosumi platform worker の hosted D1 control
> ledger を zero-downtime に migration するための expand / backfill /
> contract 手順、rollback 方針、release gate。

この runbook は **Takosumi operated environment** の DB migration 正本です。
対象は platform worker が所有する accounts plane と control-plane ledger
(Workspace / Project / Capsule / Source / ProviderConnection / CredentialRecipe / ProviderBinding / Secret / Run /
StateVersion / Output / Runner / AuditEvent / Operator settings / UsageEvent / CreditReservation / Billing) です。
既存 ledgers に Space / Installation / StateSnapshot / OutputSnapshot / Deployment などの旧行が残る場合は、Final Plan
model への migration 対象として扱います。host/distribution product の app-local DB migration は各 product docs の領域であり、
この runbook では扱いません。

## Scope

| Store               | Contains                                                                                                                                                                                                                                                                                | Migration owner                                   |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Accounts D1         | users, sessions, account / billing / OIDC issuer records                                                                                                                                                                                                                                | Takosumi accounts plane                           |
| Control-plane D1    | Workspace, Project, Capsule, Source, ProviderConnection, CredentialRecipe, ProviderBinding, Secret metadata, Run, StateVersion, Output, Runner, Artifact, UsageEvent, CreditReservation, Billing, Audit, plus legacy rows while migrations are in flight | Takosumi control plane                            |
| R2 object manifests | source archives, artifacts, state snapshots, backups                                                                                                                                                                                                                                    | schema change only when D1 metadata shape changes |

realized config では accounts と control-plane を別 D1 binding にしてもよいが、
正本 model は single Takosumi platform worker が所有する ledger です。

Migration は customer-facing command surface ではありません。operator は
platform worker deploy と同じ change window で migration を扱い、production /
staging の database id や backup id は private run log にだけ記録します。
Wrangler 4.x の `d1 execute` は positional に D1 database name / binding を受け取るため、
runbook の `--database-id` には UUID ではなく realized config の database name または binding
名を渡す。UUID は private evidence として記録してもよいが、CLI 実行引数の正本にしない。

## Gate

実行:

```bash
cd takosumi
bun run check
bun test core/adapters/storage/migrations_test.ts
bun test core/adapters/storage/drizzle/schema/schema_mirror_test.ts
```

`bun run check` is required here because it includes the root typecheck, worker
typecheck, and Cloudflare worker build checks that raw `tsc --noEmit` does not
cover.

変更が API contract / dashboard に影響する場合は追加で:

```bash
cd takosumi
bun test core/api/route_inventory_test.ts
cd dashboard && bun run build
```

## Safety Classes

新規 migration は次のいずれかに分類します。

| Class       | Use                                            | Production rule                           |
| ----------- | ---------------------------------------------- | ----------------------------------------- |
| `expand`    | additive table / column / index                | deploy before code requires the new shape |
| `backfill`  | idempotent data copy / repair                  | chunked, observable, resumable            |
| `contract`  | remove old shape after all code stops using it | explicit approval and restore plan        |
| `emergency` | incident-only repair                           | incident commander approval               |

expand と contract を同じ release に混ぜないこと。Run / StateSnapshot /
OutputSnapshot / audit ledger は replay ではなく正本 record なので、destructive
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

## Rollback Procedure

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

## Production Checklist

production 前:

- targeted tests と typecheck が green
- migration が safety class を持つ
- staging で同じ migration を実行済み
- backup restore path が判明している
- platform worker rollback version / commit が判明している
- queue consumer / scheduled handler を freeze する必要があるか判断済み

実行例:

```bash
cd takosumi
bun run cli -- accounts migrate-d1 --database-id takosumi-accounts-staging --remote
bun run cli -- accounts migrate-d1 --database-id takosumi-accounts --remote
```

production 後:

- `https://app.takosumi.com/healthz` が green
- OIDC discovery / JWKS が serve される
- `GET /api/v1/spaces` が認証なしで 401 を返す
- known staging / production Space の Installation list が読める
- compatibility check / plan read path が smoke できる
- migration runtime、row 数、skip した duplicate DDL を private evidence に記録する

## Evidence

public evidence:

- test / typecheck summary
- pull request link
- release gate summary

private evidence:

- production migration run log
- backup snapshot id
- database id / account id
- restore drill link
