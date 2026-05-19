# Incident Model

> このページでわかること: インシデントのモデル定義とステート遷移。

v1 Incident primitive を定義する: service-impacting event の kernel 側 record、
その lifecycle を支配する closed な state machine、 既存の kernel signal から
incident を mint する auto-detection trigger、 operator
と顧客に対する可視性ルール、 すべての state 遷移を記録する audit chain。 kernel
は incident record、state machine、audit primitive を同梱する。
顧客向けステータスページ、incident タイムライン可視化、notification 描画は
kernel の scope 外。

## Incident definition

Incident は次の 2 つの origin 条件のいずれかを満たす、 kernel に記録される
service-impacting event。

- **Auto-detected**: kernel 側 measurable signal から検知。 SLA breach、
  RevokeDebt が `operator-action-required` まで aging、 readiness probe failure
  rate が閾値超過、 持続的な internal-error rate 超過。
- **Operator-declared**: 外側 signal (顧客報告、third-party 依存障害、operator
  側変更失敗) を同じ state machine と audit chain で追跡する必要があるときに内部
  control plane で宣言。

両 origin は同じ record 形を生成し、同じ state machine をたどる。 origin が
record に記録されるので、operator は incident review を検知ソースで slice
できる。

## Incident record

```yaml
Incident:
  id: incident:01HM9N7XK4QY8RT2P5JZF6V3W9
  title: "deployment apply latency p99 above SLO"
  state: detecting # closed enum below
  severity: high # closed enum below
  origin: auto-detected # or operator-declared
  affectedSpaceIds:
    - space:acme-prod
  affectedOrgIds:
    - organization:acme
  kernelGlobal: false
  detectedAt: 2026-05-05T07:43:11.214Z
  acknowledgedAt: null
  mitigatedAt: null
  resolvedAt: null
  rootCause: null
  relatedAuditEventIds:
    - 01HM9N7XK4QY8RT2P5JZF6V3W7
    - 01HM9N7XK4QY8RT2P5JZF6V3W8
```

Field semantics:

| Field                  | Required | Notes                                                                                                                                             |
| ---------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                   | yes      | `incident:<ulid>` form. Kernel-minted at create. Immutable.                                                                                       |
| `title`                | yes      | Operator-editable label. Auto-detected incidents receive a default title derived from the trigger (for example, `sla-breach: apply-latency-p99`). |
| `state`                | yes      | Closed v1 enum (see below).                                                                                                                       |
| `severity`             | yes      | Closed v1 enum (see below). Auto-detected severity is computed from the trigger; operator may raise but not lower without an audit reason.        |
| `origin`               | yes      | Closed enum: `auto-detected`, `operator-declared`. Immutable.                                                                                     |
| `affectedSpaceIds`     | yes      | List of Space ids whose customer-visible behavior is impacted. Empty when `kernelGlobal` is true.                                                 |
| `affectedOrgIds`       | yes      | Derived list of Organizations owning the affected Spaces. Recomputed on Space-set change.                                                         |
| `kernelGlobal`         | yes      | Boolean. `true` when the incident affects kernel-host scope (every Space). `affectedSpaceIds` must be empty in that case.                         |
| `detectedAt`           | yes      | RFC 3339 UTC, millisecond precision. Set at create.                                                                                               |
| `acknowledgedAt`       | no       | Set when `state` first becomes `acknowledged`.                                                                                                    |
| `mitigatedAt`          | no       | Set when `state` first becomes `mitigating`.                                                                                                      |
| `resolvedAt`           | no       | Set when `state` first becomes `resolved`. Required before `postmortem`.                                                                          |
| `rootCause`            | no       | Free-form structured text. Populated only in `postmortem`; required to leave `postmortem` as terminal-published.                                  |
| `relatedAuditEventIds` | yes      | Chain back to the source audit events that triggered detection or that were emitted under this incident. May grow as the incident advances.       |

kernel は作成後に `id`、`origin`、`detectedAt`、`kernelGlobal`
の変更を拒否する。

## State machine

v1 state enum は closed。

```text
detecting | acknowledged | mitigating | monitoring | resolved | postmortem
```

```text
detecting --(operator-ack | auto-ack)--> acknowledged
acknowledged --(operator-action)--> mitigating
mitigating --(operator-action)--> monitoring
monitoring --(operator-action)--> resolved
monitoring --(regression)--> mitigating
resolved --(operator-publishes)--> postmortem
```

State semantics:

- `detecting`: kernel が trigger から incident を mint したが、まだ acknowledge
  されていない。 顧客可視性はこの state では抑制され、record は内部専用。
- `acknowledged`: operator が incident を本物と確認した。 この state
  から後、record は下記 read-only 顧客 query を通じて影響を受けた顧客に見える。
- `mitigating`: operator が remediation を適用中。 顧客可視性は維持される。
- `monitoring`: remediation 適用済み。 operator は resolved 宣言前に regression
  を観測中。
- `resolved`: operator が impact 終了を宣言。`resolvedAt` set。 顧客可視性は
  "resolved" framing に shift。
- `postmortem`: operator が構造化 root-cause record を publish した (`rootCause`
  populated)。 v1 で terminal。

Transition rules:

- `detecting` は、trigger family の auto-acknowledge policy に operator が opt
  in している場合 `acknowledged` に auto-ack できる。それ以外は operator 起動。
- `monitoring` は `resolved` 到達前に `mitigating` へ無制限回数 regress できる。
  各 regression は audit event。
- `postmortem` は terminal。 publish 済み root cause の編集には、
  以前を参照する新 incident が必要。

Severity enum (closed v1):

```text
low | medium | high | critical
```

- `low`: 内部 metric の劣化、顧客可視 impact なし。
- `medium`: scoped 顧客 impact (単一 Space、部分 surface)。
- `high`: 単一 Organization 内の複数 Space に渡る、 または kernel-global
  readiness probe に渡る幅広い顧客 impact。
- `critical`: kernel-global outage または compliance 関連 data path failure。

severity は detection 時に trigger family から計算され、operator が調整できる。
severity の引き上げは理由付きの audit event を記録する。 severity の引き下げも
audit event を記録し、state 遷移と同じ承認スコープを要求する。

## Auto-detection triggers

kernel は次の family から incident を mint する。 各 family は default severity
と auto-acknowledge default にマップされ、operator は Space 単位で上書きできる。

| Trigger family                         | Source signal                                                         | Default severity | Default auto-ack |
| -------------------------------------- | --------------------------------------------------------------------- | ---------------- | ---------------- |
| `sla-breach`                           | SLA breach detected on a published SLO                                | derived          | no               |
| `revoke-debt-operator-action-required` | RevokeDebt aged into `operator-action-required` count above threshold | medium           | no               |
| `readiness-probe-failure-rate`         | `/readyz` failing above the operator-tunable threshold for the window | high             | yes              |
| `error-rate-sustained`                 | DomainErrorCode `internal_error` rate sustained above threshold       | medium           | no               |

Trigger detail:

- **SLA breach**: severity は breached SLO が宣言する customer-impact tier
  から導出される。 kernel は breach signal id を `relatedAuditEventIds` に
  attach する。
- **RevokeDebt aging**: 閾値は Space ごとに policy pack で設定される。 default
  は medium severity で `>= 1` aged debt。operator が上下に tune。 同じ open
  incident に新たな aged debt が入ると、 新 incident を mint せず
  `relatedAuditEventIds` を伸ばす。
- **Readiness probe failure rate**: 構造上 kernel-global。 `kernelGlobal: true`
  を set し、`affectedSpaceIds` をクリア。
- **Sustained error rate**: error stream が Space scope を運べば per-Space、
  そうでなければ kernel-global。

kernel は `(trigger family, scope)` tuple ごとの sliding window 内で auto
検知された incident を重複排除する。 window 内で 2 度目の一致 trigger は open
incident に追記。 window 外では新規 incident を mint。

## Operator actions

operator は HMAC で gate された内部 control plane を通じて操作する
([Kernel HTTP API](./kernel-http-api.md) 参照)。

- `POST /api/internal/v1/incidents` — operator-declared incident を宣言。 Body:
  `title`、`severity`、`affectedSpaceIds` または `kernelGlobal`、 optional
  `relatedAuditEventIds`。
- `PATCH /api/internal/v1/incidents/:id` — state 遷移、title 編集、severity
  調整、 `affectedSpaceIds` または `relatedAuditEventIds` への追加。 state
  machine 違反は kernel が reject。
- `POST /api/internal/v1/incidents/:id/postmortem` — root-cause record を
  publish。 `state = resolved` 必須。 `state = postmortem` を set し record を
  freeze。
- `GET /api/internal/v1/incidents` — cursor pagination 付きの list。
  `state`、`severity`、`origin`、time window、`spaceId` で filter。

## Customer-affecting query

read-only な顧客 query は、 `state` が `acknowledged` 以降で、
`affectedSpaceIds` に caller が読める Space を含む incident を公開する。

- `GET /api/internal/v1/spaces/:id/incidents` — Space scope の incident list。
  返す field:
  `id`、`title`、`state`、`severity`、`detectedAt`、`acknowledgedAt`、`mitigatedAt`、`resolvedAt`、`rootCause`
  (`state = postmortem` のときのみ)。

query はアクセス権にかかわらず `detecting` 状態の incident を抑制する: 後で
false positive と判定された auto-detected incident が顧客に見えることはない。

`kernelGlobal` incident は、 caller が kernel 内のいずれかの Space
に対する権限を持つあらゆる Space query で返される。

## Audit events

すべての state 遷移は audit event を発行する。 v1 incident audit event 分類は
closed で、 [Audit Events](./audit-events.md) の closed enum に加わる。

- `incident-detected`
- `incident-acknowledged`
- `incident-state-changed`
- `incident-severity-changed`
- `incident-resolved`
- `incident-postmortem-published`

各 event は標準 envelope に
`{incidentId, fromState, toState, fromSeverity, toSeverity, relatedAuditEventIds}`
を記録した incident payload を持つ (該当箇所のみ)。 kernel は state pair
が有効な遷移でない audit write を reject する。

## Storage schema

Incident は [Storage Schema](./storage-schema.md) を 1 つの record class
で拡張する。

| Record     | Indexed by                                                          | Persistence                                                        |
| ---------- | ------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `Incident` | `(id)`, `(state)`, `(detectedAt)`, `(spaceId via affectedSpaceIds)` | Kept indefinitely under audit retention; `postmortem` is terminal. |

実装は incident store を audit store と同居させてよいが、 上記の indexed
カラムは保持しなければならない。

## Scope boundary

spec surface は incident record、state machine、auto-detection trigger、上記の
operator / 顧客読取り endpoint、audit chain を含む。 現行 kernel
リポジトリはそれら HTTP route を mount していない。 公開ステータスページ UI、
顧客 notification テンプレート描画、 incident タイムライン可視化、 third-party
paging integration、 on-call rotation、 チケットトラッカー連携は **Takosumi の
scope 外** であり、 operator の外側スタック (例: `takos-private/` や別の PaaS
provider front end) が実装する。 kernel はそれら外側 surface が組み立てに使う
storage / audit primitive を公開する。

## Related architecture notes

- `docs/reference/architecture/operator-boundaries.md` — 顧客 query が参照する
  operator vs 顧客の可視性ルール。
- `docs/reference/architecture/policy-risk-approval-error-model.md` — severity
  導出と trigger family mapping。
- [Observation Drift & RevokeDebt Model](#observation-drift--revokedebt-model) —
  RevokeDebt aging trigger source。

## 関連ページ

- [Audit Events](./audit-events.md)
- [Storage Schema](./storage-schema.md)
- [RevokeDebt Model](./revoke-debt.md)
- [Quota and Rate Limit](./quota-rate-limit.md)
- [Readiness Probes](./readiness-probes.md)
- [Kernel HTTP API](./kernel-http-api.md)
- [Resource IDs](./resource-ids.md)

## Observation Drift & RevokeDebt Model

Observation は Space 内の reality を記録する。Drift は計算される。Debt は失敗
した cleanup を記録する。

### ObservationSet

```yaml
ObservationSet:
  spaceId: space:acme-prod
  desiredSnapshotId: desired:...
  observedAt: ...
  observations:
    object:api:
      state: present | missing | degraded | unknown
    link:api.DATABASE_URL:
      state: materialized | stale | failed
    export:takos.database.primary:
      freshness: fresh | stale | revoked | unknown
```

ObservationSet は DesiredSnapshot を変更しない。

### Space rule

ObservationSet、DriftIndex、RevokeDebt は Space scope である。ある Space の
observation は別 Space の DesiredSnapshot を変更したり validate したりしては
ならない。current v1 は Space を跨ぐ share debt を作らない。将来の RFC で
provider Space を有効化する場合も、記録された share 経由でのみアクセスする。

### DriftIndex

DriftIndex は DesiredSnapshot と ObservationSet を比較する。

```yaml
Drift:
  address: link:api.DATABASE_URL
  kind: stale-secret-projection
  severity: warning | error
  detectedAt: ...
```

### RevokeDebt

RevokeDebt は revoke または削除すべきだが cleanup できなかった生成 material を
記録する。

#### RevokeDebt record schema

```yaml
RevokeDebt:
  id: revoke-debt:...
  generatedObjectId: generated:link:api.DATABASE_URL/grant
  sourceExportSnapshotId: export-snapshot:...
  externalParticipantId: db-platform
  reason: external-revoke
  status: open
  ownerSpaceId: space:acme-prod
  originatingSpaceId: space:acme-prod
  retryPolicy: {}
  createdAt: ...
```

closed な v1 enum:

```text
reason:
  external-revoke         external system rejected or could not acknowledge
  link-revoke             link revoke could not complete cleanly
  activation-rollback     activation rolled back but cleanup is pending
  approval-invalidated    a previously approved retain became invalid
  cross-space-share-expired

status:
  open                    debt is queued and will be retried
  operator-action-required
                          retry is exhausted or blocked; operator must act
  cleared                 debt is satisfied; entry is preserved for audit
```

#### Ownership fields

RevokeDebt は cleanup / retry を実行する Space が所有する。current v1 は
次の語彙を使う。

- `ownerSpaceId` drives retry, status transitions, cleanup, and worker context.
- `originatingSpaceId` records where the debt originated; omitted values default
  to `ownerSpaceId`.
- status mutation is scoped to `ownerSpaceId`.

#### ActivationSnapshot propagation

`status: operator-action-required` は ActivationSnapshot state に伝播するが、
fail-safe-not-fail-closed である。

- 関連する debt が `operator-action-required` の間、新規 traffic shift
  (GroupHead を進める activation) は block される。
- 既存の GroupHead pointer と TrafficAssignment は自動的に rollback
  **されない**。 runtime は以前の assignment を提供し続ける。
- observation で `unhealthy` 注記と debt がどう相互作用するかは
  [Exposure Activation Model — Post-activate health state](./architecture/namespace-export-model.md#post-activate-health-state)
  を参照。

RevokeDebt は警告ではない。operational debt であり、status、plan、audit、
production readiness check で可視でなければならない。

### Observation retention

ObservationSet は最新の reality を保存する。ObservationHistory は optional で
policy 管理。OperationJournal と RevokeDebt は recovery クリティカルな履歴を
持つ。

### Observability architecture

この節は observation / drift / debt が operator から見える signal になるまでを
規律するアーキテクチャ層の規則を記録する。wire shape は reference 文書にある。

#### Audit retention policy

retention は階層的である。各層は別個の目的と TTL 境界を持つ。

```text
ObservationSet         latest reality only; superseded by next observation
ObservationHistory     optional; opt-in retention of past ObservationSet entries
OperationJournal       recovery-critical; retained until journal compaction allows it
AuditLog               compliance-driven; retained per operator policy
```

アーキテクチャ規則:

- TTL は kernel が固定しない。各層は operator 管理の retention policy を持つ。
- 後続の ObservationSet が存在する限り ObservationSet は自由に破棄できる。
- 依存する RevokeDebt が非終了状態にある間、または WAL replay の正しさが依存
  している間は、OperationJournal entry を破棄してはならない。
- AuditLog retention は他 3 つから独立している。compliance window が
  OperationJournal retention を短くすることはない。

#### Drift propagation

drift entry はまず `DriftIndex` に surface する。そこから固定 path に沿って
伝播する。

```text
DriftIndex
  -> ActivationSnapshot annotation     drift annotates the relevant activation entry
  -> status surface                    operator status / plan / preview reflects the drift
  -> approval invalidation             see Approval invalidation triggers in policy-risk-approval-error-model
```

DriftIndex は DesiredSnapshot を変更しない。drift による activation rollback は
RevokeDebt と activation lifecycle が仲介し、DesiredSnapshot を直接編集する
ことはない。

#### RevokeDebt aging

`status: open` のまま aging window を過ぎた RevokeDebt は、自動的に
`operator-action-required` に遷移する。

```text
open --(aging window elapsed without retry success)--> operator-action-required
```

Aging のアーキテクチャ規則:

- aging window は policy 管理であり、kernel 定数ではない。アーキテクチャは
  そのような window が存在し、遷移が自動・idempotent・journal 済みであること
  だけを要求する。
- 手動 operator action は window によらず `open` から `operator-action-required`
  に直接遷移できる。
- `cleared` は終端である。aged debt が clear されたときは aging 遷移と clearance
  event の両方を記録する。

#### ObservationHistory policy

ObservationHistory は optional で Space scope である。

```text
opt-in    operator enables retention; ObservationSet entries are appended to history
opt-out   default; only the latest ObservationSet is kept
```

アーキテクチャ規則:

- ObservationHistory は resolution や planning の authority にはならない。query
  surface に過ぎない。
- ObservationHistory を有効化しても DriftIndex の semantics は変わらない。drift
  は current ObservationSet と DesiredSnapshot を比較して計算される。
- ObservationHistory を無効化しても OperationJournal や RevokeDebt record を
  削除してはならない。

### Cross-references

- [Space Model](./architecture/space-model.md)
- [Operator Boundaries](./architecture/operator-boundaries.md)
- [Policy, Risk, Approval, and Error Model](./architecture/policy-risk-approval-error-model.md)
- [Exposure Activation Model](./architecture/namespace-export-model.md#exposure-activation-model)
- [PaaS Provider Architecture](./architecture/paas-provider-architecture.md)
