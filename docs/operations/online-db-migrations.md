# Operations: Online DB Migrations

> このページでわかること: Takos app DB の zero-downtime migration framework、
> expand / backfill / contract 手順、rollback procedure、release gate。

Takos app-local profile / chat / memory / product API metadata は `takos/app`
が所有します。Takosumi Accounts が account / auth / billing / OIDC issuer /
Installation ledger を所有し、Takos app は OIDC consumer としてそれらを consume
します。DB migration は customer-facing command surface ではありません。Operator
が Takos app migration を実行する場合も、正本は `takos/app` の migration gate
とこの runbook です。

## Gate

実行:

```bash
cd takos
bun run validate:migration-safety
```

これは内部的に以下に委譲します:

```bash
cd takos/app
bun run validate:migration-safety
```

app 側 validator は `0001` から `0062` までの migration を baseline として扱い
ます。`0063` 以降の新規 migration には safety class marker を必ず含めます:

```sql
-- takos-migration-safety: expand
```

Allowed classes:

| Class       | Use                                               | Production rule                     |
| ----------- | ------------------------------------------------- | ----------------------------------- |
| `expand`    | additive schema change                            | deploy before code reads/writes it  |
| `backfill`  | idempotent data copy / repair                     | chunked, observable, resumable      |
| `contract`  | remove old schema after traffic no longer uses it | explicit approval and rollback note |
| `emergency` | incident-only repair                              | incident commander approval         |

## Zero-downtime Pattern

expand / migrate / contract の順で進めます:

1. Expand: nullable / default 付き column、additive table、additive index
   を追加する。
2. dual-write、または旧 schema と新 schema の両方を read できる code を deploy
   する。
3. backfill は bounded chunk で行う。冪等で resumable であること。
4. backfill evidence が green になってから read を新 schema に切り替える。
5. dual-write を 1 observation window 維持する。
6. Contract: rollback で旧 schema が不要になってから削除する。

expand と contract を 1 つの migration に混ぜないこと。

## Dangerous DDL

app validator が marker 無しの migration に対して block する DDL:

- `DROP TABLE`
- `DROP COLUMN`
- `ALTER TABLE ... RENAME TO`
- `ALTER TABLE ... RENAME COLUMN`
- `ALTER TABLE ... ALTER COLUMN ... SET NOT NULL`
- `CREATE UNIQUE INDEX` without `IF NOT EXISTS`

dangerous DDL は `contract` または `emergency` に加えて以下の両方が必要:

```sql
-- takos-migration-approval: <issue-or-runbook-link>
-- takos-migration-rollback: <forward-repair-or-restore-plan>
```

## Rollback Procedure

`expand` および `backfill` の場合:

1. rollout を停止し、expanded schema は維持する。
2. application code を、両方の shape に互換な直前 version まで戻す。
3. 次の patch window までは additive column / table を残す。
4. backfill が不正データを生んだ場合は forward repair migration を実行するか、
   影響行を backup から復元する。

`contract` の場合:

1. 旧 code path がどこにも deploy されていないことを確認する。
2. backup と restore drill evidence の存在を確認する。
3. まず staging で contract migration を実行する。
4. contract 後に rollback が必要な場合は backup から復元するか、文書化された
   forward repair を実行する。場当たり的な逆 SQL に依存しないこと。

`emergency` の場合:

1. incident commander が migration を承認する。
2. 変更前の evidence を保全する。
3. incident 緩和に必要な最小限の repair のみ実行する。
4. emergency fix を通常の expand / backfill / contract 状態に変換するための
   follow-up task を起票する。

## Production Checklist

production 前:

- `bun run validate:migration-safety` が green
- migration に正しい safety class marker が付いている
- backfill が bounded batch size と冪等性を持つ
- code が current production schema と後方互換
- staging で同じ migration を実行済み
- backup restore path が判明している
- rollback image / commit が判明している

production 後:

- app / API の health、OIDC consumer session smoke、app-local profile / API
  smoke を検証する。billing / account ledger smoke は Takosumi Accounts の
  migration / restore runbook の領域。
- migration ledger に該当 row が存在することを検証する。
- runtime、row 数、skip した重複 DDL を記録する。
- observation window が終わるまで expanded schema を維持する。

## Evidence

public evidence:

- `validate:migration-safety` の出力
- pull request リンク
- release gate summary

private evidence:

- production migration の run log
- backup snapshot id
- restore drill のリンク
- provider account / D1 database id
