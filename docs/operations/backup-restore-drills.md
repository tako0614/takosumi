# Operations: Backup and Restore Drills

> このページでわかること: Takosumi operated environments の backup / restore drill
> cadence、月次 staging restore、四半期 production simulation、証跡、失敗時の
> escalation 基準。

Takosumi の production readiness gate はまず **control/state backup** を対象にします。Installation service-data backup は
provider snapshot adapter または Capsule 側の export artifact が実装された Installation だけで有効になる追加 layer です。この
ページは Takosumi operator がその backup / restore をどの頻度で検証し、どの evidence を残すかを定義します。

## Scope

**Backup/Restore layers**:

1. **Control backup** (Takosumi control plane 所有): Space、Source、Connection
   metadata、Provider Catalog、Provider Connection metadata、provider policy、
   CapsuleCompatibilityReport、InstallConfig、Installation provider connections、
   Installation、Dependency、Run、RunGroup、Deployment、StateSnapshot、OutputSnapshot、
   artifacts manifest、billing credit ledger、audit / activity ledger。
2. **Service-data backup** (Installation 所有 / optional): messages、attachments、files、
   posts、profiles など Capsule が provision した service 固有データ。現時点では generic restore は未実装で、対応 provider
   adapter または Capsule-defined export がある Installation だけを対象にする。

control backup は Installation graph と state/output 世代を復元します。
service-data backup は各 Installation の BackupConfig に従い、control restore
後に必要な Installation だけ restore / reattach します。

対象データ:

- Space / Source / Connection metadata / Provider Catalog / Provider Connection metadata /
  provider policy / InstallConfig / Installation provider connections / Installation graph
- Run / RunGroup / Deployment / StateSnapshot / OutputSnapshot / Activity /
  audit ledger
- projected output metadata and state snapshot pointers
- Installation service-data export / provider snapshot / custom command archive

Control backup は metadata、state/artifact manifest、billing ledger
(`BillingAccount` / `SpaceSubscription` / `CreditBalance` / `UsageEvent` /
`CreditReservation`)、audit/activity ledger を対象にします。raw state bytes と raw
outputs は R2_STATE / R2_ARTIFACTS の encrypted object inventory と digest で
復元・照合します。SecretBlob は encrypted envelope と metadata だけを扱い、raw
secret や payment processor credential は repo 外の operator vault に残します。

Takosumi platform worker は users / sessions / billing / OIDC issuer records も
所有します。control backup は payer reference と OIDC discovery/JWKS に必要な
public metadata を保持しますが、raw secret を含めません。

対象外:

- customer export / deletion workflow
- provider-native backup product selection
- commercial SLA credit calculation

Customer-facing export は portability surface であり、operator backup の代替では
ありません。

## Cadence

| Drill                         | Frequency      | Environment                                     | Required evidence                                                                | Owner                              |
| ----------------------------- | -------------- | ----------------------------------------------- | -------------------------------------------------------------------------------- | ---------------------------------- |
| Control ledger restore        | monthly        | staging / isolated control-plane restore target | Space/Installation/Run/Deployment counts, state/output pointer inventory         | Takosumi platform owner            |
| Service-data restore sample   | monthly when enabled | staging                                  | one supported Installation service-data restore transcript, smoke result, RTO / RPO sample | platform on-call owner             |
| Production restore simulation | quarterly      | production shadow / isolated recovery account   | dry-run transcript, latest backup freshness, restore plan review, access check   | platform owner + secondary on-call |
| Backup inventory audit        | monthly        | staging + production                            | backup age, chain head, encryption key availability, retention window            | storage owner                      |
| Emergency restore tabletop    | twice per year | staging or meeting room                         | timeline, decision log, role assignment, runbook gaps                            | incident commander pool            |

月次 staging restore を skip した場合は、次の production release promotion に
platform owner の明示的な承認が必要です。

## Control Backup Restore Minimum

目的: Installation service-data を reattach する前に、Takosumi control ledger を
単独で restore できることを証明する。

手順:

1. 同じ release train の最新 staging control backup を選ぶ。
2. non-production issuer URL / hostname を持つ isolated restore target に restore
   する。
3. 以下を検証する:
   - Space / Source / Connection metadata / Provider Catalog entries /
     Provider Connection metadata and policy / compatibility reports / Installation /
     Installation provider connections / Dependency / SourceSnapshot / DependencySnapshot /
     StateSnapshot / Run / RunGroup / Deployment / OutputSnapshot / Backup /
     UsageEvent の row 数が source
     inventory と一致すること
   - `current_state_generation` と R2 state inventory が一致すること
   - OutputSnapshot projection と raw output artifact manifest が一致すること
   - Provider Catalog resolution、Provider Connection status
     records、Connection status、egress/custom runner policy が復元後も一致すること
   - 既知の staging Space で Installation list / inspect が動くこと
   - billing mode、credit balance、reservation / usage records が live payment
     processor に接触せず load されること
   - Takosumi platform worker の identity / OIDC records を含む restore では、
     復元した issuer から OIDC discovery と JWKS が serve され、必要な public
     client metadata が secret なしで resolve できること
4. RTO/RPO sample と復元 target URL を記録する。
5. evidence を添付したら、isolated restore target を削除する。

この drill が揃って初めて、operator は control/state restore readiness を満たしたとみなします。Service-data restore evidence は、
service-data backup を有効にした supported Installation を public promise に含める前の追加 gate です。

## Monthly Staging Restore

目的: 本番 customer data を使わずに、実 backup から staging 環境を restore
できることを証明する。

手順:

1. 30 分以上経過した最新 staging backup を選ぶ。
2. 以下を記録する:
   - backup id / timestamp
   - source environment
   - schema version
   - audit chain head (hash-chain sink を有効化している場合)
   - encrypted secret partition id
3. isolated restore target を作る。active staging を上書きしてはいけない。
4. control backup manifest と state/artifact inventory に従って logical restore
   を実行する。
5. 以下を検証する:
   - critical record の skip 無しで restore が完了する
   - hash-chain sink を有効化している場合、audit chain が genesis から restored head まで verify される
   - Deployment record を list できる
   - 既知の staging Installation の public route が応答する
   - compatibility / plan を 1 件 resolve できる (apply はしない)
   - runner queue が empty、または意図的に paused であること
6. 実測 RTO と backup age を RPO sample として記録する。
7. evidence を添付したら、isolated restore target を削除する。

合格条件:

- restore が完了
- hash-chain sink を有効化している場合、audit chain が verify される
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

Takosumi operated 環境の evidence は operator の private run log (= repo 外の
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
