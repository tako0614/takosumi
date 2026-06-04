# Operations: Disaster Recovery Plan

> このページでわかること: Takos operated environments の disaster recovery
> target、RTO / RPO、multi-region failover 手順、復旧後の検証と復帰条件。

> **Parent workflow**: DR は incident response の一環として起動します。 RTO 内の
> primary region 復旧が不可能、control-plane storage が利用不能 / 破損、または
> provider outage で primary environment が復旧できない場合に発動します。
> activation chain (SEV declaration → war room → DR declaration) は
> [`./incident-response.md`](./incident-response.md) を参照してください。

この DR plan は [Backup and Restore Drills](./backup-restore-drills.md) と
[Incident Response](./incident-response.md) を実行前提にします。 Takosumi kernel
の logical restore protocol は `takosumi/docs/reference/backup-restore.md`
が正本です。

## Targets

| Target          | Value         | Meaning                                                        |
| --------------- | ------------- | -------------------------------------------------------------- |
| RTO             | <= 4 hours    | SEV-1 DR 宣言から customer-facing critical path が復旧するまで |
| RPO             | <= 15 minutes | 復旧先で許容する committed control-plane data loss window      |
| Detection       | <= 5 minutes  | production-wide outage を operator が ack するまで             |
| Customer update | <= 15 minutes | SEV-1 宣言後の初回 customer/status update                      |

RTO / RPO は target です。四半期 DR simulation で実測し、target を満たせない場合
は release promotion blocker として扱います。

## DR Modes

::: warning Terminology 本 runbook で「account」は文脈ごとに以下を区別します:

- **Takosumi Account**: Installable App Model の **identity / billing owner**
  (in-process account plane)
- **Cloud account**: operator-owned Cloudflare account tenancy

DR では両 layer の recovery が必要。Takosumi Account level の data は worker 内
account plane の data store (D1 / Postgres) の DR で、Cloud account level の
resource は Cloudflare DR で restored。 :::

| Mode                  | Use when                                  | Data source                                   | Risk                                             |
| --------------------- | ----------------------------------------- | --------------------------------------------- | ------------------------------------------------ |
| In-region recovery    | isolated service / storage failure        | same-region replica / backup                  | fastest, same-region dependency risk             |
| Cross-region failover | region-wide outage or provider impairment | latest verified cross-region backup / replica | DNS / route propagation and provider parity risk |

default 戦略は active-passive な cross-region recovery です。active-active は、
個別の deploy 構成が明示しない限り本 plan の前提にしません。

## DR Declaration

以下のいずれかに該当する場合は DR を宣言する:

- primary region が利用不能で、30 分以内に recovery path が無い
- control-plane storage が利用不能または破損している
- production 全体の障害に対して安全な in-place rollback が無い
- security incident のため primary environment の隔離が必要
- provider outage で primary region 全体の deploy / auth / git access が不可

DR 宣言には incident commander の承認が必要です。incident commander
不在の場合は、 primary と secondary の on-call が共同で DR を宣言し、理由を
incident channel に 記録できます。

## Pre-flight Checklist

failover 前:

1. production deploy と background mutation job を freeze する。
2. 利用可能な最新 backup / replica の timestamp を確認する。
3. RPO 推定が 15 分以下、または customer impact
   を明示的に受け入れることを確認する。
4. 以下へのアクセスを検証する:
   - recovery account / region
   - encrypted secret partition key
   - DNS / routing 制御
   - image / artifact registry
   - recovery target の observability dashboard
5. owner を任命する:
   - restore owner
   - routing owner
   - verification owner
   - customer communications owner
6. go / no-go の判断を incident timeline に記録する。

## Cross-region Failover Procedure

1. recovery target を準備または選択する。
   - target region の current Cloudflare deploy 構成を使う。
   - restore 進行中に live primary storage を変更しない。
2. control-plane data を restore する。
   - `takosumi/docs/reference/backup-restore.md` に従う。
   - write を有効化する前に audit chain を verify する。
   - secret 値を露出させずに secret partition の availability を確認する。
3. runtime service を reattach する。
   - `takos-app` / `takos-git` / `takos-agent` および Takosumi service set
     を起動する。
   - health endpoint が green であることを確認する。
   - runtime-agent pool が recovery target に enroll することを確認する。
4. customer-facing の critical path を検証する。
   - login / session validation
   - repository read
   - deploy plan resolve
   - 既知の default app route 1 件
   - billing / profile read path
5. routing を shift する。
   - 未対応なら TTL を下げる。
   - customer-facing hostname を recovery target に向ける。
   - 5xx / latency / auth error rate を監視する。
6. monitoring state に入る。
   - 2 つの observation window が green になるまで deploy freeze を維持する。
   - recovered service と既知の residual risk を customer update で通知する。

## Return to Primary

primary に traffic を戻すのは以下が満たされた後だけ:

- root cause が修復または隔離されている
- primary data が recovery target から reconcile されている
- audit chain と deployment record が一貫している
- customer-facing critical path が smoke check を通る
- incident commander が cutback を承認している

cutback は別の change window として扱います。recovery target に write が
入っている場合、primary は recovery target から restore するか、正式に放棄
する必要があります。

## Verification

以下がすべて true になるまで recovery は完了しません:

- HTTP 5xx / latency が SLO 内に戻る
- deploy plan resolve が成功する
- Git read path が成功する
- runtime-agent の heartbeat が healthy
- audit chain が verify される
- backup age / RPO sample が記録される
- customer update が送付される
- follow-up action が起票される

## Simulation Cadence

四半期ごとに、live traffic shift を伴わない production DR simulation
を実施する。 年 2 回以上、incident commander、primary on-call、secondary
on-call、routing owner、storage owner、customer communications owner を含む
tabletop を実施する。

simulation evidence の取り扱いは
[Backup and Restore Drills](./backup-restore-drills.md) と同じ private evidence
ルールに従う。
