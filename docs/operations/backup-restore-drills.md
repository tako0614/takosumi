# Operations: Backup and Restore Drills

> このページでわかること: Takos operated environments の backup / restore drill
> cadence、月次 staging restore、四半期 production simulation、証跡、失敗時の
> escalation 基準。

Takosumi kernel の logical backup / restore protocol は
`takosumi/docs/reference/backup-restore.md` が正本です。このページは Takos
operator がその protocol をどの頻度で検証し、どの evidence を残すかを定義
します。

## Scope

**Backup/Restore 3 layer**:

1. **Takosumi Account level** (Takosumi Accounts 所有): identity, billing,
   Installation ledger
2. **Takos product level** (Takos 所有): app-local profile, chat / memory /
   files
3. **Runtime / kernel level** (takosumi 所有): deployment records, compiled
   manifests, runtime-agent work queue

各 layer は **独立した backup runbook** を持ち、整合性 restore は cross-layer の
sequencing で行います (account level → product level → kernel level の順)。

対象データ:

- Takosumi Accounts identity / billing / Installation ledger / OIDC client
  registry (Takosumi Account level)
- Takos app-local profile / chat / memory / files (Takos product level)
- Takos Git repositories / refs / object metadata (Takos product level)
- Takosumi deployment records / WAL / audit chain / provider operation state
  (runtime / kernel level)
- runtime-agent work queue and terminal projections (runtime / kernel level)
- default app metadata required to reattach customer routes
- secret metadata and encrypted envelopes

Takosumi Account level の physical backup procedure は worker 内 account plane
(Takosumi) の data store (D1 / Postgres) backup runbook が正本です。本 runbook は
Takos product level と runtime / kernel level の drill cadence に加えて、Accounts
restore evidence の最小項目を固定します。

対象外:

- customer export / deletion workflow
- provider-native backup product selection
- commercial SLA credit calculation

Customer-facing export は portability surface であり、operator backup の代替では
ありません。

## Cadence

| Drill                         | Frequency      | Environment                                   | Required evidence                                                              | Owner                              |
| ----------------------------- | -------------- | --------------------------------------------- | ------------------------------------------------------------------------------ | ---------------------------------- |
| Accounts ledger restore       | monthly        | staging / isolated Accounts restore target    | account/space/install ledger counts, OIDC client restore, billing ledger smoke | Takosumi Accounts owner            |
| Staging logical restore       | monthly        | staging                                       | restore transcript, audit chain verification, smoke result, RTO / RPO sample   | platform on-call owner             |
| Production restore simulation | quarterly      | production shadow / isolated recovery account | dry-run transcript, latest backup freshness, restore plan review, access check | platform owner + secondary on-call |
| Backup inventory audit        | monthly        | staging + production                          | backup age, chain head, encryption key availability, retention window          | storage owner                      |
| Emergency restore tabletop    | twice per year | staging or meeting room                       | timeline, decision log, role assignment, runbook gaps                          | incident commander pool            |

月次 staging restore を skip した場合は、次の production release promotion に
platform owner の明示的な承認が必要です。

## Takosumi Accounts Restore Minimum

目的: Takos product data や kernel runtime data を reattach する前に、account
plane を単独で restore できることを証明する。

手順:

1. 同じ release train の最新 staging Takosumi Accounts backup を選ぶ。
2. non-production issuer URL を持つ isolated Accounts target に restore する。
3. 以下を検証する:
   - account / space / Installation / BindingMaterialRecord / permission scope /
     Installation runtime mode / InstallationEvent の row 数が source inventory
     と 一致すること
   - 復元した issuer から OIDC discovery と JWKS が serve されること
   - 復元した OIDC client が staging auth-code smoke、または deterministic な
     token-validation fixture を通せること
   - 既知の staging Space で Installation list / inspect が動くこと
   - billing account record と entitlement projection が live Stripe に接触せず
     load されること (drill が Stripe sandbox を明示的に使う場合を除く)
   - launch-token の issue / consume を、復元した staging Takos API endpoint
     に対して実行できる、または意図的に skip した旨を記録できること
4. RTO/RPO sample と復元した issuer URL を記録する。
5. evidence を添付したら、isolated restore target を削除する。

この drill と Takos product restore および runtime restore evidence が揃って
初めて、operator は production restore readiness を満たしたとみなします。

## Monthly Staging Restore

目的: 本番 customer data を使わずに、実 backup から staging 環境を restore
できることを証明する。

手順:

1. 30 分以上経過した最新 staging backup を選ぶ。
2. 以下を記録する:
   - backup id / timestamp
   - source environment
   - schema version
   - audit chain head
   - encrypted secret partition id
3. isolated restore target を作る。active staging を上書きしてはいけない。
4. `takosumi/docs/reference/backup-restore.md` に従って logical restore
   を実行する。
5. 以下を検証する:
   - critical record の skip 無しで restore が完了する
   - audit chain が genesis から restored head まで verify される
   - deployment record を list できる
   - 既知の staging app route が応答する
   - deploy plan を 1 件 resolve できる (apply はしない)
   - runtime-agent queue が empty、または意図的に paused であること
6. 実測 RTO と backup age を RPO sample として記録する。
7. evidence を添付したら、isolated restore target を削除する。

合格条件:

- restore が完了
- audit chain が verify される
- smoke check が pass する
- RTO sample が現行 DR target を下回る、または action item が起票される

## Quarterly Production Simulation

目的: live production を上書きせずに、production backup / access / key / restore
手順を検証する。

許可される操作:

- 最新 backup の metadata を読む
- backup object の存在 / retention を確認する
- 承認された break-glass path で key access を確認する
- restore tool を dry-run / validate-only モードで走らせる
- 承認があれば、isolated recovery account にサニタイズ済み sample を restore
  する

禁止操作:

- live production storage の上書き
- production write を staging へ replay する
- customer data を public docs / ticket / screenshot で露出させる
- break-glass credential access で incident commander 承認を bypass する

production simulation には primary / secondary on-call の両方が参加します。
break-glass access を実行した場合は audit event とフォローアップ review item を
作成します。

## Evidence Record

各 drill は private な evidence record を生成します。public docs では drill が
実施された事実のみ要約できます。

必須項目:

```text
date:
drill type:
environment:
operator:
backup id:
backup timestamp:
schema version:
audit chain head:
restore target:
RTO sample:
RPO sample:
smoke checks:
result: pass | fail
follow-up actions:
```

Takos-operated 環境の evidence は operator の private run log (= repo 外の
operator vault)、 または承認済みの incident / compliance system に保管します。customer
identifier、 provider account id、raw backup object name、secret partition
material を public docs にコミットしてはいけません。

## Failure Handling

以下の場合は SEV-2 incident を開く:

- 利用可能な最新 backup が宣言 RPO target を超えている
- audit chain verification 前に restore が失敗
- 必要な restore key が利用できない
- 環境全体の backup inventory が欠落している
- 月次 staging drill を 2 回連続で skip した

以下の場合は SEV-1 にエスカレートする:

- production data loss が疑われる
- 使える production backup が存在しない
- restore tooling が recovery target を破壊した
- secret partition を承認済み key で読めない

## Follow-up Rules

失敗した drill は必ず owner と due date 付きの action item
を生成します。critical backup / key availability の問題は、 platform owner と
incident commander pool が close または明示的に waive するまで production
release promotion を block します。

失敗が再発する場合は、customer impact が無くても
[Incident Response](./incident-response.md) に従って postmortem を作成します。
