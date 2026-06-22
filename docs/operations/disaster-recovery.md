# Operations: Disaster Recovery Plan

> このページでわかること: Takosumi operated environments の disaster recovery
> target、RTO / RPO、multi-region failover 手順、復旧後の検証と復帰条件。

> **Parent workflow**: DR は incident response の一環として起動します。 RTO 内の
> primary region 復旧が不可能、control-plane storage が利用不能 / 破損、または
> provider outage で primary environment が復旧できない場合に発動します。
> activation chain (SEV declaration → war room → DR declaration) は
> [`./incident-response.md`](./incident-response.md) を参照してください。

この DR plan は [Backup and Restore Drills](./backup-restore-drills.md) と
[Incident Response](./incident-response.md) を実行前提にします。DR では
Takosumi control/state backup を先に復元し、provider snapshot adapter または Capsule-defined export がある Capsule
だけ service-data backup をその後に reattach / restore します。generic service-data restore はまだ public promise に含めません。

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

- **Workspace**: Takosumi の user/team boundary。Project / Capsule graph、ProviderConnection、Secret、
  StateVersion、Output、AuditEvent の isolation scope。
- **Quota/showback ledger**: Takosumi platform worker が持つ operator-selected disabled/showback records。
  official billing / payment processor records are Takosumi Cloud-only commercial records.
- **Cloud account**: provider account used by a Workspace-owned ProviderConnection.
  AWS/GitHub/Kubernetes/custom provider access is restored through
  ProviderConnections / Secret / provider policy state, not by taking over a
  provider account as hidden operator-owned infrastructure.

DR では Takosumi platform worker の identity / quota/showback / OIDC records、Workspace
直下の Project / Capsule graph、StateVersion / Output、operator infrastructure
の recovery を分けて扱います。raw secret と payment processor credential は repo
外の operator vault から復旧します。 :::

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
  - provider outage で primary region 全体の deploy / auth / source access が不可

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
   - control backup manifest、state/artifact inventory、hosted D1 control-ledger backup に従う。
   - write を有効化する前に audit chain を verify する。
   - secret 値を露出させずに secret partition の availability を確認する。
3. Capsule service-data を reattach / restore する。
   - critical Workspace の Project / Capsule graph を確認する。
   - 必要な Capsule だけ service-data backup を restore する。
   - generated root / StateVersion / Output の整合性を確認する。
   - CredentialRecipe resolution、ProviderConnection status、
     ProviderBinding status、egress/custom runner policy の整合性を確認する。
4. runtime service を reattach する。
   - Takosumi platform worker、queue、CoordinationObject、
     OpenTofuRunOwnerObject、OpenTofuRunnerObject、runner container を起動する。
   - health endpoint が green であることを確認する。
   - runner pool が recovery target で plan を受けられることを確認する。
5. customer-facing の critical path を検証する。
   - login / session validation
   - Source git read
   - Capsule compatibility check / plan resolve
   - 既知の Capsule public route または Output projection 1 件
   - Workspace quota/showback read path
6. routing を shift する。
   - 未対応なら TTL を下げる。
   - customer-facing hostname を recovery target に向ける。
   - 5xx / latency / auth error rate を監視する。
7. monitoring state に入る。
   - 2 つの observation window が green になるまで deploy freeze を維持する。
   - recovered service と既知の residual risk を customer update で通知する。

## Return to Primary

primary に traffic を戻すのは以下が満たされた後だけ:

- root cause が修復または隔離されている
- primary data が recovery target から reconcile されている
- audit chain と Run / StateVersion / Output record が一貫している
- customer-facing critical path が smoke check を通る
- incident commander が cutback を承認している

cutback は別の change window として扱います。recovery target に write が
入っている場合、primary は recovery target から restore するか、正式に放棄
する必要があります。

## Verification

以下がすべて true になるまで recovery は完了しません:

- HTTP 5xx / latency が SLO 内に戻る
- Capsule compatibility check / deploy plan resolve が成功する
- Git read path が成功する
- runner queue / container health が healthy
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
