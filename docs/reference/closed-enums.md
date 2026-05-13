# Closed Enums

> このページでわかること: kernel が使う closed enum の一覧と拡張ルール。

本ページは Takosumi v1 が定める閉じた enum / state machine の一覧です。 各項目
に値、 1 行のセマンティクス、 詳細リファレンスへのリンクを示します。 すべて
**閉じた** enum であり、 拡張には `CONVENTIONS.md` §6 の RFC が必須です。
provider / template / 第三者パッケージが単独で拡張することはできません。

## v1 wire shape の対象

reference doc が freeze する v1 wire shape の対象:

- closed enum 値 (本 doc に列挙されたすべての enum)
- state machine の状態名と遷移
- record schema の field 名と型
- HTTP endpoint path と request / response の field 名
  ([Kernel HTTP API](/reference/kernel-http-api))
- CLI subcommand 名と flag 名 ([CLI](/reference/cli))
- audit event 名と payload field 名 ([Audit Events](/reference/audit-events))
- environment variable 名 ([Environment Variables](/reference/env-vars))
- resource ID prefix と format ([Resource IDs](/reference/resource-ids))

breaking 変更には `CONVENTIONS.md` §6 RFC が必須。

operator-tunable な default 値 (TTL / grace / threshold / quota cap 等) は wire
shape ではないため、 stability とは独立。 default 値変更は CHANGELOG
への記載のみで足りる ([Stability](/reference/#stability) 参照)。

## Access modes

```text
read | read-write | admin | invoke-only | observe-only
```

link consumer が export の resource とどう関わるかを規定する 5 値の語彙。
`read-write` と `admin` は `safeDefaultAccess` の default にはなりません。
詳細セマンティクス、 `safeDefaultAccess` の contract、 承認無効化との関係は
[Access Modes](/reference/access-modes) を参照。

## Lifecycle phases

```text
apply | activate | destroy | rollback | recovery | observe
```

OperationPlan 単位で適用される 6 phase enum。

- `apply`: `OperationPlan` と `ResolutionSnapshot` を生成
- `activate`: traffic を切り替える
- `destroy`: managed / generated object を削除
- `rollback`: 直前の `ResolutionSnapshot` を再適用
- `recovery`: kernel restart や lock loss の後、 WAL から再開
- `observe`: runtime-agent describe に対して長時間動作する

phase ごとの入出力、 WAL stage、 失敗時の挙動、 定常状態の遷移図は
[Lifecycle Phases](/reference/lifecycle-phases) を参照。

## LifecycleStatus

```text
running | stopped | missing | error | unknown
```

runtime-agent が managed object ごとに報告する 5 値 state。 backing connector
上の観測 state であり、 control-plane phase ではありません。 `apply` /
`describe` / `destroy` / `verify` ごとの遷移は
[Lifecycle Phases — LifecycleStatus enum](/reference/lifecycle-phases#lifecyclestatus-enum)
を参照。

## operationKind

```text
apply-object | delete-object | verify-object
materialize-link | rematerialize-link | revoke-link
prepare-exposure | activate-exposure
transform-data-asset | observe | compensate
```

内部 `OperationRecord.operationKind` 用の 11 値予約 enum。 公開 apply code は
operation kind を文字列で持ち、 `takosumi plan` では
`planned[].op = "create" | "update" | "delete"` のみを露出します。

| 値                     | 意味                                                                                         |
| ---------------------- | -------------------------------------------------------------------------------------------- |
| `apply-object`         | connector 上で managed object を作成または更新する。                                         |
| `delete-object`        | `destroy` / `rollback` の中で managed object を削除する。                                    |
| `verify-object`        | 解決済み spec と一致するか再読込で確認。 mutation は emit しない。                           |
| `materialize-link`     | link source から generated object を初回 render する。                                       |
| `rematerialize-link`   | source export digest 変更後に generated object を再 render する。                            |
| `revoke-link`          | link 削除に伴って generated object を tear down する。 `RevokeDebt` を emit することがある。 |
| `prepare-exposure`     | traffic flip 前に新規 Exposure (routing surface) を stage する。                             |
| `activate-exposure`    | `activate` phase で準備済み Exposure に traffic を切り替える。                               |
| `transform-data-asset` | DataAsset transformer を走らせて derived artifact を作る。                                   |
| `observe`              | `observe` phase で動作する長時間動作の runtime-agent describe。                              |
| `compensate`           | `rollback` / `recovery` で部分 commit された effect を取り消す recovery operation。          |

kind ごとの入出力 / WAL stage の対応は内部 OperationPlan architecture に記述。
公開 plan shape は [Plan Output Schema](/reference/plan-output)、 provider
dispatch contract は
[Provider Implementation Contract](/reference/provider-implementation-contract)
を参照。

## WAL stages

```text
prepare | pre-commit | commit | post-commit | observe | finalize
        | abort | skip                                  (terminal)
```

write-ahead operation journal 用の 8 値 enum。 `prepare` / `pre-commit` /
`commit` / `post-commit` / `observe` / `finalize` が forward stage、 `abort` /
`skip` が terminal stage。 idempotency tuple は
`(spaceId, operationPlanDigest, journalEntryId)` で、 forward stage のどこから
replay しても同じ結果になります。 stage セマンティクスと replay rule は
[WAL Stages](/reference/wal-stages) を参照。

## Approval lifecycle states

```text
pending | approved | denied | expired | invalidated | consumed
```

approval record の server-side state machine 6 値。

- `pending`: 発行時の初期状態
- `approved`: 発行後で唯一の非 terminal 状態。 apply pipeline が消費すると
  `consumed`、 後述 6 trigger のいずれかが発火すると `invalidated` に遷移
- `denied` / `expired` / `invalidated` / `consumed`: terminal

`consumed` record は audit のため保持されますが再利用不可で、 これを提示すると
`failed_precondition` になります。 client UX hint の `reviewing` は server-side
state ではなく persist されません。 遷移 contract と binding field は
[Approval Invalidation Triggers](/reference/approval-invalidation#approver-ux-states)
を参照。

## Approval invalidation triggers

```text
1. digest change
2. effect-detail change
3. implementation change
4. external freshness change
5. catalog release change
6. Space-context change
```

6 種の独立した trigger があり、 いずれか 1 つが発火すると approval は無効化さ
れます。 `digest change` と `effect-detail change` は他 binding を再評価せず短
絡無効化します (digest 変更は完全 re-resolve を強制するため)。 trigger contract
と伝搬規則は [Approval Invalidation Triggers](/reference/approval-invalidation)
を参照。

## Risk taxonomy

```text
collision-detected | transform-unapproved | stale-export
revoke-debt-created | secret-projection | grant-escalation
network-egress-expansion | cross-space-import (reserved)
external-implementation | catalog-release-bump
policy-pack-bump | space-context-change
artifact-policy-override | post-commit-failed
recovery-compensate-required | drift-detected
data-asset-kind-mismatch | approval-binding-stale
implementation-change
```

stable ID を持つ 19 値の closed Risk enum。 kernel は `OperationPlan` 1 件あた
り 1 approval を発行し、 発火した Risk を `riskItemIds[]` で列挙します。 Risk
個別のセマンティクスと operator の対処フローは
[Risk Taxonomy](/reference/risk-taxonomy) を参照。

## RevokeDebt reason

```text
external-revoke | link-revoke | activation-rollback
approval-invalidated | cross-space-share-expired (reserved)
```

`RevokeDebt` の closed reason enum (5 値)。 `external-revoke` は managed
`destroy` を伴わず connector が object 消失を報告したときに emit され、
`link-revoke` は明示的な projection 削除を、 `activation-rollback` は
`compensate` recovery を表します。 詳細は
[RevokeDebt Model](/reference/revoke-debt) を参照。

## RevokeDebt status

```text
open | operator-action-required | cleared
```

`RevokeDebt` entry の lifecycle status (3 値)。

- `open`: emission 時の default
- `operator-action-required`: 自動 clear に失敗し、 aging window が operator
  threshold を超えたときに設定される
- `cleared`: terminal

aging window と clear 条件は [RevokeDebt Model](/reference/revoke-debt) を参
照。

## Object lifecycle classes

```text
managed | generated | external | operator | imported
```

kernel が管理する object の closed 分類 5 値。

| Class       | 意味                                                                                                |
| ----------- | --------------------------------------------------------------------------------------------------- |
| `managed`   | 現在 Space の apply pipeline が作成・所有し、 `destroy` phase で削除される。                        |
| `generated` | managed object を projection / link rendering して materialize したもの。 source が消えれば消える。 |
| `external`  | connector 上で既に存在するもの。 kernel は読み取り / grant 発行はするが削除はしない。               |
| `operator`  | operator が install (例: `connector:<id>`)。 tenant Space lifecycle の対象外。                      |

`destroy` で削除されるのは `managed` と `generated` のみ。

## Mutation constraints

```text
immutable | replace-only | in-place | append-only
ordered-replace | reroute-only
```

`outputField` が宣言する、 apply 間で provider が field をどう mutation できる
かを定める 6 値の closed enum。

| Constraint        | 許可される apply 動作                                                |
| ----------------- | -------------------------------------------------------------------- |
| `immutable`       | 初回 apply で値が固定。 以後の変更は planning で失敗する。           |
| `replace-only`    | 値を変えるには provider が resource を drop & 再作成する必要がある。 |
| `in-place`        | 再作成せずに live resource 上で field を mutation してよい。         |
| `append-only`     | 既存 entry を増やせるが、 削除や順序変更はできない。                 |
| `ordered-replace` | entry の置換は可。 ただし宣言順序を保たなければならない。            |
| `reroute-only`    | resource 自体には触れず、 前段の routing surface のみを変更できる。  |

## Link mutations

```text
rematerialize | reproject | regrant | rewire | revoke
retain-generated | no-op | repair
```

apply pipeline が OperationPlan に出す per-link diff の 8 値 closed enum。

| Mutation           | 発火条件                                                                                         |
| ------------------ | ------------------------------------------------------------------------------------------------ |
| `rematerialize`    | source export digest が変更。 新 export から generated object を再導出。                         |
| `reproject`        | source は不変だが projection rule が変更。 generated identity のみ再 render。                    |
| `regrant`          | grant detail (例: access mode) が変更。 backing object は維持。                                  |
| `rewire`           | routing target が変更。 managed object は維持し、 exposure を rebuild。                          |
| `revoke`           | link 削除。 generated object を tear down。 `link-revoke` の `RevokeDebt` を emit する場合あり。 |
| `retain-generated` | link 削除だが operator policy で generated object を保持 (例: audit のため)。                    |
| `no-op`            | 両 snapshot で link が存在し materialization も一致。                                            |
| `repair`           | drift 検出。 generated state を resolved link に合わせる。                                       |

## Link materialization states

```text
pending | materializing | materialized | stale | rematerializing
revoking | revoked | failed | debt
```

`ResolutionSnapshot` 内の各 link projection に付く 9 値 closed state。
`materialized` が定常成功、 `stale` は export freshness の問題があるが
再実行未着手、 `debt` は link に紐付く `RevokeDebt` が open であることを表す。

## Bundled DataAsset kinds

```text
oci-image | js-bundle | lambda-zip | static-bundle | wasm
```

`Artifact.kind` の初期登録語彙。 protocol field は operator install の connector
に対して開かれていますが、 bundle される kernel は discovery のため この 5
種を登録します。 kind ごとの必須 metadata、 サイズ上限、 connector 側
enforcement は [Artifact Kinds](/reference/artifact-kinds) を参照。

## Health states

```text
unknown | observing | healthy | degraded | unhealthy
```

observe loop が報告する Exposure health enum (5 値)。 activate 直後の Exposure
は `unknown` から始まり、 `observing` を経て `healthy` / `degraded` /
`unhealthy` に落ち着きます。 遷移詳細は
[Lifecycle Phases — `observe`](/reference/lifecycle-phases#observe) を参照。

## DomainErrorCode

```text
invalid_argument | permission_denied | not_found
failed_precondition | resource_exhausted | not_implemented
unauthenticated | readiness_probe_failed | internal_error
```

kernel の domain error response が返す 9 値 closed code enum。

| Code                     | 意味                                                                     |
| ------------------------ | ------------------------------------------------------------------------ |
| `invalid_argument`       | manifest schema、 form input、 digest 不一致など。                       |
| `permission_denied`      | space 越境、 entitlement 拒否、 policy gate 拒否。                       |
| `not_found`              | endpoint 無効化 (token 未設定) や deployment / artifact / Space の不在。 |
| `failed_precondition`    | record なしの destroy、 collision 検出、 approval invalidated など。     |
| `resource_exhausted`     | quota 超過、 `TAKOSUMI_ARTIFACT_MAX_BYTES` を超える artifact upload。    |
| `not_implemented`        | issuer 未配線、 operator gate 機能が未有効。                             |
| `unauthenticated`        | bearer 欠落、 内部 HMAC 検証失敗。                                       |
| `readiness_probe_failed` | `/livez` / `/readyz` または依存 port が ready でない。                   |
| `internal_error`         | kernel 内部の未処理例外。                                                |

transport mapping (HTTP status、 gRPC code) は code 毎に固定で
[Kernel HTTP API](/reference/kernel-http-api) に定義。 `invalid_argument` を
発生させる manifest-time validation は
[Manifest Validation](/reference/manifest-validation) を参照。

## LifecycleErrorBody codes

```text
unauthorized | bad_request | connector_not_found
artifact_kind_mismatch | connector_failed
```

runtime-agent の `/v1/lifecycle/*` response が返す 5 値 closed code enum。
`connector-extended:*` prefix は connector 拡張用に予約されており、
runtime-agent はその値をそのまま転送します。 詳細は
[Runtime-Agent API — Error model](/reference/runtime-agent-api#error-model)
を参照。

## Actor types

```text
human | service-account | runtime-agent | support-staff
```

Actor record の closed enum (4 値)。

- `human`: operator が onboard した user
- `service-account`: API key に bind された non-interactive caller
- `runtime-agent`: enroll 済み runtime-agent プロセス
- `support-staff`: impersonation grant の対象となる operator 側 support
  principal

type ごとの binding field と認証 contract は
[Actor / Organization Model](/reference/actor-organization-model) を参照。

## Roles

```text
org-owner | org-admin | org-billing | space-admin
space-deployer | space-viewer | support-staff
```

この role matrix は kernel が persist / enforce しません (Takosumi Accounts
側で扱う)。

## API key types

```text
deploy-token | read-token | admin-token | support-token
```

operator が設定する deploy / artifact credential。 account API key は Takosumi
Accounts の所有。

## Auth provider types

```text
bearer-token | oidc | mtls | runtime-agent-enrollment
```

user 認証の brokering は Takosumi Accounts 側で扱う。 runtime-agent enrollment
は kernel / operator の trust 関心事で、 user auth provider ではない。

## Trial Space lifecycle

```text
active-trial | expiring-soon | frozen | cleaned-up | converted
```

Trial Space record の lifecycle closed enum (5 値)。

- `active-trial`: 発行後の定常状態
- `expiring-soon`: auto-expire 前の window を示す
- `frozen`: データを保持したまま apply / activate を停止
- `cleaned-up`: hard delete 後の terminal
- `converted`: 通常 Space への upgrade 後の terminal

遷移 contract と quota envelope は [Trial Spaces](/reference/trial-spaces) を
参照。

## Incident state

```text
detecting | acknowledged | mitigating | monitoring | resolved | postmortem
```

Incident の closed state machine (6 値)。

- `detecting`: emit 時の初期状態
- `acknowledged`: operator が認知したことを記録
- `mitigating`: 対処実施中
- `monitoring`: 復旧後の経過観察
- `resolved`: 運用上の terminal
- `postmortem`: 記録上の terminal

状態遷移詳細は [Incident Model](/reference/incident-model) を参照。

## Incident severity

```text
low | medium | high | critical
```

Incident の severity (4 値)。 notification emission や SLA-breach の連動を制御
します。 severity ごとの policy は [Incident Model](/reference/incident-model)
を参照。

## Support impersonation grant lifecycle

```text
requested | approved | rejected | revoked | expired
```

grant lifecycle の closed enum (5 値)。 `requested` が発行時の初期状態。
`support-token` が使えるのは `approved` のときのみで、 `rejected` / `revoked` /
`expired` は terminal。 state ごとの binding と audit contract は
[Support Impersonation](/reference/support-impersonation) を参照。

## SLA state

```text
ok | warning | breached | recovering | ok-recovered
```

SLA 評価の closed state (5 値)。

- `ok`: 定常状態
- `warning`: threshold 接近
- `breached`: SLO threshold 超過時に記録
- `recovering`: 閾値以下に戻ったが cooldown window 内
- `ok-recovered`: cooldown 成功後の terminal

検出と cooldown rule は [SLA Breach Detection](/reference/sla-breach-detection)
を参照。

## Connector identity

connector identity は closed prefix `connector:<id>` を用います。 すべての
connector は operator install で、 上述 object lifecycle class の `operator`
に該当します。 identity scheme は closed で、 v1 で connector を表す prefix
は他にありません。

## Workflow Primitive Enums

kernel は trigger / declarable-hook / `execute-step` の enum 群を持ちません。
workflow / cron / hook の実行は kernel の外 (例: `takosumi-git`) で扱います。
詳細は
[Workflow Placement Rationale](/reference/architecture/workflow-extension-design)
を参照。

## 関連 architecture notes

- `docs/reference/architecture/target-model.md` — access mode / mutation
  constraint / object lifecycle class の closed-enum architecture
- `docs/reference/architecture/execution-lifecycle.md` — phase enum の choice
  space と observe / recovery を別 phase に切り出した理由
- `docs/reference/architecture/operation-plan-write-ahead-journal-model.md` —
  WAL stage と idempotency tuple の rationale
- `docs/reference/architecture/policy-risk-approval-error-model.md` — Risk 19
  entries / approval invalidation triggers / DomainErrorCode の closure 理由
- `docs/reference/architecture/link-projection-model.md` — link mutation / link
  materialization state の生成 algorithm
- `docs/reference/architecture/data-asset-model.md` — DataAsset kind 5 値と
  connector identity scheme
- `docs/reference/architecture/namespace-export-model.md` — share lifecycle 5 値

## 関連ページ

- [Access Modes](/reference/access-modes)
- [Lifecycle Phases](/reference/lifecycle-phases)
- [Shape Catalog](/reference/shapes)
- [Provider Plugins](/reference/providers)
- [Auth Providers](/reference/auth-providers)
- [RBAC Policy](/reference/rbac-policy)
- [API Key Management](/reference/api-key-management)
- [Tenant Provisioning](/reference/tenant-provisioning)
- [Tenant Export & Deletion](/reference/tenant-export-deletion)
- [Trial Spaces](/reference/trial-spaces)
- [Quota Tiers](/reference/quota-tiers)
- [Incident Model](/reference/incident-model)
- [Notification Emission](/reference/notification-emission)
- [SLA Breach Detection](/reference/sla-breach-detection)
- [Support Impersonation](/reference/support-impersonation)
- [Cost Attribution](/reference/cost-attribution)
- [Backup / Restore](/reference/backup-restore)
- [Schema Evolution](/reference/migration-upgrade)
- [Catalog Release Trust](/reference/catalog-release-trust)
- [Kernel HTTP API](/reference/kernel-http-api)
- [Audit Events](/reference/audit-events)
- [Environment Variables](/reference/env-vars)
- [Resource IDs](/reference/resource-ids)
