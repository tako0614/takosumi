# Operations: Backup and Restore Drills

> このページでわかること: Takosumi operated environments の backup / restore drill
> cadence、isolated restore、production simulation、証跡、失敗時の
> escalation 基準。

Takosumi の production readiness gate はまず **control/state backup** を対象にします。Capsule service-data backup は
provider snapshot adapter または Capsule 側の export artifact が実装された Capsule だけで有効になる追加 layer です。この
ページは Takosumi operator がその backup / restore をどの頻度で検証し、どの evidence を残すかを定義します。
physical database、object store、key layout、region topology は selected persistence
adapter が所有し、Core の backup contract には入りません。

## Scope

**Backup/Restore layers**:

1. **Control backup** (Takosumi control plane 所有): Workspace、Project、Capsule、Source、
   ProviderConnection metadata、CredentialRecipe selection、ProviderBinding、Secret metadata、
   provider policy、compatibility report、Run、StateVersion、Output、artifacts manifest、
   operator quota/showback ledger、AuditEvent ledger。
2. **Service-data backup** (Capsule 所有 / optional): messages、attachments、files、
   posts、profiles など Capsule が provision した service 固有データ。現時点では generic restore は未実装で、対応 provider
   adapter または Capsule-defined export がある Capsule だけを対象にする。

control backup は Project / Capsule graph と StateVersion / Output 世代を復元します。
service-data backup は各 Capsule の backup/export 設定に従い、control restore
後に必要な Capsule だけ restore / reattach します。

対象データ:

- Workspace / Project / Capsule / Source metadata / ProviderConnection metadata /
  CredentialRecipe / ProviderBinding / provider policy / Capsule graph
- Run / StateVersion / Output / AuditEvent ledger
- captured Output metadata and current StateVersion ids
- Capsule service-data export / provider snapshot / custom command archive

Control backup は metadata、state/artifact manifest、operator quota/showback ledger、
AuditEvent ledger を対象にします。Takosumi Cloud official billing / payment processor records are
Cloud-private commercial records and are not part of the OSS control backup contract. Raw state bytes と raw
outputs は host artifact store の opaque ref inventory と digest で復元・照合
します。filesystem、S3-compatible storage、R2などのphysical placementは
adapter-specificであり、logical restoreはobject keyを再構築しません。
Secret は encrypted envelope と metadata だけを扱い、raw
secret や payment processor credential は repo 外の operator vault に残します。

Takosumi platform worker は users / sessions / quota/showback / OIDC issuer records も
所有します。control backup は OIDC discovery/JWKS に必要な public metadata を保持しますが、
raw secret を含めません。

対象外:

- user/tenant export / deletion workflow
- provider-native backup product selection
- commercial SLA credit calculation

User-facing export は portability surface であり、operator backup の代替では
ありません。

## Cadence

cadence は operator policy が明示します。OSS baseline は月次・四半期などの固定頻度や
特定 provider の retention window を組み込みません。各行は configured schedule で
current evidence を更新し、missed-run threshold も同じ policy に記録します。

| Drill                         | Frequency               | Environment                                     | Required evidence                                                                        | Owner                              |
| ----------------------------- | ----------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------- |
| Control ledger restore        | operator-configured     | staging / isolated control-plane restore target | Workspace/Project/Capsule/Run/StateVersion/Output counts, state/output pointer inventory | Takosumi platform owner            |
| Service-data restore sample   | configured when enabled | staging / isolated target                       | one supported Capsule service-data restore transcript, smoke result, RTO / RPO sample    | platform on-call owner             |
| Production restore simulation | operator-configured     | production shadow / isolated recovery target    | dry-run transcript, latest backup freshness, restore plan review, access check           | platform owner + secondary on-call |
| Backup inventory audit        | operator-configured     | configured operated environments                | backup age, chain head, encryption key availability, retention window                    | storage owner                      |
| Emergency restore tabletop    | operator-configured     | non-live target or tabletop                     | timeline, decision log, role assignment, runbook gaps                                    | incident commander pool            |

configured restore drill を missed-run threshold まで skip した場合は、次の production
release promotion に platform owner の明示的な承認が必要です。

## Control Backup Restore Minimum

目的: Capsule service-data を reattach する前に、Takosumi control ledger を
単独で restore できることを証明する。

手順:

1. 同じ release train の最新 staging control backup を選ぶ。
2. non-production issuer URL / hostname を持つ isolated restore target に restore
   する。
3. 以下を検証する:
   - Workspace / Project / Capsule / Source metadata /
     ProviderConnection metadata and policy / CredentialRecipe / ProviderBinding /
     compatibility reports / Run / StateVersion / Output / Backup metadata /
     quota/showback record の row 数が source
     inventory と一致すること
   - Capsuleのcurrent StateVersion id、そのStateVersionのopaque state ref/digest、
     selected artifact-store inventory が一致すること
   - captured Output ledger と raw output artifact manifest が一致すること
   - CredentialRecipe resolution、ProviderConnection status、
     ProviderBinding status、egress/operator-defined executor policy が復元後も一致すること
   - 既知の staging Workspace で Capsule list / inspect が動くこと
   - quota/showback records が外部commercial extension callbackなしでloadされること
   - Takosumi platform worker の identity / OIDC records を含む restore では、
     復元した issuer から OIDC discovery と JWKS が serve され、必要な public
     client metadata が secret なしで resolve できること
4. RTO/RPO sample と復元 target URL を記録する。
5. evidence を添付したら、isolated restore target を削除する。

この drill が揃って初めて、operator は control/state restore readiness を満たしたとみなします。Service-data restore evidence は、
service-data backup を有効にした supported Capsule を public promise に含める前の追加 gate です。

## Scheduled Isolated Restore

目的: 本番 user/tenant data を不用意に複製せず、実 backup から isolated 環境を restore
できることを証明する。

手順:

1. write 中でないことを selected adapter が証明できる最新の staging backup を選ぶ。
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
   - Run / StateVersion / Output record を list できる
   - 既知の staging Capsule の public route または Resolved Interface が応答する
   - compatibility / plan を 1 件 resolve できる (apply はしない)
   - runner queue が empty、または意図的に paused であること
6. 実測 RTO と backup age を RPO sample として記録する。
7. evidence を添付したら、isolated restore target を削除する。

合格条件:

- restore が完了
- hash-chain sink を有効化している場合、audit chain が verify される
- smoke check が pass する
- RTO sample が現行 DR target を下回る、または action item が起票される

## Production Restore Simulation

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
- user/tenant data を public docs / ticket / screenshot で露出させる
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
operator vault)、 または承認済みの incident / compliance system に保管します。user/tenant
identifier、 provider account id、raw backup object name、secret partition
material を public docs にコミットしてはいけません。

## Failure Handling

以下の場合は SEV-2 incident を開く:

- 利用可能な最新 backup が宣言 RPO target を超えている
- audit chain verification 前に restore が失敗
- 必要な restore key が利用できない
- 環境全体の backup inventory が欠落している
- configured drill の missed-run threshold を超えた

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

失敗が再発する場合は、user/tenant impact が無くても
[Incident Response](./incident-response.md) に従って postmortem を作成します。
