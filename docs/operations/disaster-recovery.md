# Operations: Disaster Recovery Plan

> このページでわかること: Takosumi operated environments の disaster recovery
> target、RTO / RPO、recovery-target failover 手順、復旧後の検証と復帰条件。

> **Parent workflow**: DR は incident response の一環として起動します。 RTO 内の
> active environment 復旧が不可能、control-plane storage が利用不能 / 破損、または
> selected provider/adapter outage で active environment が復旧できない場合に発動します。
> activation chain (SEV declaration → war room → DR declaration) は
> [`./incident-response.md`](./incident-response.md) を参照してください。

この DR plan は [Backup and Restore Drills](./backup-restore-drills.md) と
[Incident Response](./incident-response.md) を実行前提にします。DR では
Takosumi control/state backup を先に復元し、provider snapshot adapter または Capsule-defined export がある Capsule
だけ service-data backup をその後に reattach / restore します。generic service-data restore はまだ public promise に含めません。

## Targets

| Target               | Value                         | Meaning                                                   |
| -------------------- | ----------------------------- | --------------------------------------------------------- |
| RTO                  | operator-defined              | DR 宣言から critical path が復旧するまで                  |
| RPO                  | operator-defined              | 復旧先で許容する committed control-plane data loss window |
| Detection/ack target | on-call policy-defined        | environment-wide outage を operator が ack するまで       |
| Affected-user update | communications policy-defined | incident 宣言後の初回 update                              |

RTO / RPO は operator configuration と launch brief が宣言する target です。DR
simulation で実測し、target を満たせない場合
は release promotion blocker として扱います。

## DR Modes

::: warning Terminology

本 runbook で「account」は文脈ごとに以下を区別します:

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
外の operator vault から復旧します。

:::

| Mode                           | Use when                                      | Data source                                | Risk                                                 |
| ------------------------------ | --------------------------------------------- | ------------------------------------------ | ---------------------------------------------------- |
| Same-environment recovery      | isolated service / storage failure            | adapter-selected replica / verified backup | shared failure-domain risk                           |
| Isolated recovery-target shift | environment or provider failure-domain outage | latest verified isolated backup / replica  | routing propagation and selected-adapter parity risk |

recovery topology は operator の deploy adapter と persistence adapter が明示します。
active-passive、cross-region、同一regionのisolated restoreのいずれも選べます。
Core runbook は暗黙の region/provider topology を前提にしません。

## DR Declaration

以下のいずれかに該当する場合は DR を宣言する:

- active environment が利用不能で、宣言済み RTO 内に recovery path が無い
- control-plane storage が利用不能または破損している
- production 全体の障害に対して安全な in-place rollback が無い
- security incident のため active environment の隔離が必要
- selected provider/adapter outage で active environment の deploy / auth / source access が不可

DR 宣言には incident commander の承認が必要です。incident commander
不在の場合は、 primary と secondary の on-call が共同で DR を宣言し、理由を
incident channel に 記録できます。

## Pre-flight Checklist

failover 前:

1. production deploy と background mutation job を freeze する。
2. 利用可能な最新 backup / replica の timestamp を確認する。
3. RPO 推定がそのenvironmentの宣言target内、または user/tenant impact
   を明示的に受け入れることを確認する。
4. 以下へのアクセスを検証する:
   - recovery target / failure domain
   - encrypted secret partition key
   - DNS / routing 制御
   - image / artifact registry
   - recovery target の observability dashboard
5. owner を任命する:
   - restore owner
   - routing owner
   - verification owner
   - affected-user communications owner
6. go / no-go の判断を incident timeline に記録する。

## Recovery-target Failover Procedure

1. recovery target を準備または選択する。
   - operator-selected deploy adapter のreview済みrealized configurationを使う。
   - selected persistence/runner adapters が recovery target で利用可能なことを確認する。
   - restore 進行中に live primary storage を変更しない。
2. control-plane data を restore する。
   - logical control backup manifest、opaque state/artifact ref inventory、selected ledger
     adapter の backup に従う。
   - write を有効化する前に audit chain を verify する。
   - secret 値を露出させずに secret partition の availability を確認する。
3. Capsule service-data を reattach / restore する。
   - critical Workspace の Project / Capsule graph を確認する。
   - 必要な Capsule だけ service-data backup を restore する。
   - generated root / StateVersion / Output の整合性を確認する。
   - CredentialRecipe resolution、ProviderConnection status、
     ProviderBinding status、egress/operator-defined executor policy の整合性を確認する。
4. runtime service を reattach する。
   - platform service composition、queue、Run lease/ownership coordinator、
     selected Runner adapter / runner pool を起動する。
   - health endpoint が green であることを確認する。
   - runner pool が recovery target で plan を受けられることを確認する。
5. user/tenant-facing の critical path を検証する。
   - login / session validation
   - Source git read
   - Capsule compatibility check / plan resolve
   - 既知の Capsule public route または Resolved Interface 1 件
   - Workspace quota/showback read path
6. routing を shift する。
   - selected DNS/routing adapter の承認済み手順を使う。
   - affected-user hostname を recovery target に向ける。
   - 5xx / latency / auth error rate を監視する。
7. monitoring state に入る。
   - 2 つの observation window が green になるまで deploy freeze を維持する。
   - recovered service と既知の residual risk を affected-user update で通知する。

## Return to Primary

primary に traffic を戻すのは以下が満たされた後だけ:

- root cause が修復または隔離されている
- primary data が recovery target から reconcile されている
- audit chain と Run / StateVersion / Output record が一貫している
- user/tenant-facing critical path が smoke check を通る
- incident commander が cutback を承認している

cutback は別の change window として扱います。recovery target に write が
入っている場合、primary は recovery target から restore するか、正式に放棄
する必要があります。

## Verification

以下がすべて true になるまで recovery は完了しません:

- HTTP 5xx / latency が SLO 内に戻る
- Capsule compatibility check / deploy plan resolve が成功する
- Git read path が成功する
- runner queue / selected Runner adapter health が healthy
- audit chain が verify される
- backup age / RPO sample が記録される
- required affected-user update が送付される
- follow-up action が起票される

## Simulation Cadence

operator policy が定める cadence で、live traffic shift を伴わない production DR
simulation と tabletop を実施する。cadence と参加 role は launch brief / on-call
policy に明記し、incident commander、on-call、routing owner、storage owner、
affected-user communications owner の必要範囲を選ぶ。

simulation evidence の取り扱いは
[Backup and Restore Drills](./backup-restore-drills.md) と同じ private evidence
ルールに従う。
