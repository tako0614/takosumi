# Incident Model

> このページでわかること: インシデントのモデル定義とステート遷移。

v1 Incident primitive を定義する: service-impacting event の kernel 側 record、 その lifecycle を支配する closed な state machine、 既存の kernel signal から incident を mint する auto-detection trigger、 operator と顧客に対する可視性ルール、 すべての state 遷移を記録する audit chain。 kernel は incident record、state machine、audit primitive を同梱する。 顧客向けステータスページ、incident タイムライン可視化、notification 描画は kernel の scope 外。

## Incident definition

Incident は次の 2 つの origin 条件のいずれかを満たす、 kernel に記録される service-impacting event。

- **Auto-detected**: kernel 側 measurable signal から検知。 SLA breach、 RevokeDebt が `operator-action-required` まで aging、 readiness probe failure rate が閾値超過、 持続的な internal-error rate 超過。
- **Operator-declared**: 外側 signal (顧客報告、third-party 依存障害、operator 側変更失敗) を同じ state machine と audit chain で追跡する必要があるときに内部 control plane で宣言。

両 origin は同じ record 形を生成し、同じ state machine をたどる。 origin が record に記録されるので、operator は incident review を検知ソースで slice できる。

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

kernel は作成後に `id`、`origin`、`detectedAt`、`kernelGlobal` の変更を拒否する。

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

- `detecting`: kernel が trigger から incident を mint したが、まだ acknowledge されていない。 顧客可視性はこの state では抑制され、record は内部専用。
- `acknowledged`: operator が incident を本物と確認した。 この state から後、record は下記 read-only 顧客 query を通じて影響を受けた顧客に見える。
- `mitigating`: operator が remediation を適用中。 顧客可視性は維持される。
- `monitoring`: remediation 適用済み。 operator は resolved 宣言前に regression を観測中。
- `resolved`: operator が impact 終了を宣言。`resolvedAt` set。 顧客可視性は "resolved" framing に shift。
- `postmortem`: operator が構造化 root-cause record を publish した (`rootCause` populated)。 v1 で terminal。

Transition rules:

- `detecting` は、trigger family の auto-acknowledge policy に operator が opt in している場合 `acknowledged` に auto-ack できる。それ以外は operator 起動。
- `monitoring` は `resolved` 到達前に `mitigating` へ無制限回数 regress できる。 各 regression は audit event。
- `postmortem` は terminal。 publish 済み root cause の編集には、 以前を参照する新 incident が必要。

Severity enum (closed v1):

```text
low | medium | high | critical
```

- `low`: 内部 metric の劣化、顧客可視 impact なし。
- `medium`: scoped 顧客 impact (単一 Space、部分 surface)。
- `high`: 単一 Organization 内の複数 Space に渡る、 または kernel-global readiness probe に渡る幅広い顧客 impact。
- `critical`: kernel-global outage または compliance 関連 data path failure。

severity は detection 時に trigger family から計算され、operator が調整できる。 severity の引き上げは理由付きの audit event を記録する。 severity の引き下げも audit event を記録し、state 遷移と同じ承認スコープを要求する。

## Auto-detection triggers

kernel は次の family から incident を mint する。 各 family は default severity と auto-acknowledge default にマップされ、operator は Space 単位で上書きできる。

| Trigger family                         | Source signal                                                         | Default severity | Default auto-ack |
| -------------------------------------- | --------------------------------------------------------------------- | ---------------- | ---------------- |
| `sla-breach`                           | SLA breach detected on a published SLO                                | derived          | no               |
| `revoke-debt-operator-action-required` | RevokeDebt aged into `operator-action-required` count above threshold | medium           | no               |
| `readiness-probe-failure-rate`         | `/readyz` failing above the operator-tunable threshold for the window | high             | yes              |
| `error-rate-sustained`                 | DomainErrorCode `internal_error` rate sustained above threshold       | medium           | no               |

Trigger detail:

- **SLA breach**: severity は breached SLO が宣言する customer-impact tier から導出される。 kernel は breach signal id を `relatedAuditEventIds` に attach する。
- **RevokeDebt aging**: 閾値は Space ごとに policy pack で設定される。 default は medium severity で `>= 1` aged debt。operator が上下に tune。 同じ open incident に新たな aged debt が入ると、 新 incident を mint せず `relatedAuditEventIds` を伸ばす。
- **Readiness probe failure rate**: 構造上 kernel-global。 `kernelGlobal: true` を set し、`affectedSpaceIds` をクリア。
- **Sustained error rate**: error stream が Space scope を運べば per-Space、 そうでなければ kernel-global。

kernel は `(trigger family, scope)` tuple ごとの sliding window 内で auto 検知された incident を重複排除する。 window 内で 2 度目の一致 trigger は open incident に追記。 window 外では新規 incident を mint。

## Operator actions

operator は HMAC で gate された内部 control plane を通じて操作する ([Kernel HTTP API](/reference/kernel-http-api) 参照)。

- `POST /api/internal/v1/incidents` — operator-declared incident を宣言。 Body: `title`、`severity`、`affectedSpaceIds` または `kernelGlobal`、 optional `relatedAuditEventIds`。
- `PATCH /api/internal/v1/incidents/:id` — state 遷移、title 編集、severity 調整、 `affectedSpaceIds` または `relatedAuditEventIds` への追加。 state machine 違反は kernel が reject。
- `POST /api/internal/v1/incidents/:id/postmortem` — root-cause record を publish。 `state = resolved` 必須。 `state = postmortem` を set し record を freeze。
- `GET /api/internal/v1/incidents` — cursor pagination 付きの list。 `state`、`severity`、`origin`、time window、`spaceId` で filter。

## Customer-affecting query

read-only な顧客 query は、 `state` が `acknowledged` 以降で、 `affectedSpaceIds` に caller が読める Space を含む incident を公開する。

- `GET /api/internal/v1/spaces/:id/incidents` — Space scope の incident list。 返す field: `id`、`title`、`state`、`severity`、`detectedAt`、`acknowledgedAt`、`mitigatedAt`、`resolvedAt`、`rootCause` (`state = postmortem` のときのみ)。

query はアクセス権にかかわらず `detecting` 状態の incident を抑制する: 後で false positive と判定された auto-detected incident が顧客に見えることはない。

`kernelGlobal` incident は、 caller が kernel 内のいずれかの Space に対する権限を持つあらゆる Space query で返される。

## Audit events

すべての state 遷移は audit event を発行する。 v1 incident audit event 分類は closed で、 [Audit Events](/reference/audit-events) の closed enum に加わる。

- `incident-detected`
- `incident-acknowledged`
- `incident-state-changed`
- `incident-severity-changed`
- `incident-resolved`
- `incident-postmortem-published`

各 event は標準 envelope に `{incidentId, fromState, toState, fromSeverity, toSeverity, relatedAuditEventIds}` を記録した incident payload を持つ (該当箇所のみ)。 kernel は state pair が有効な遷移でない audit write を reject する。

## Storage schema

Incident は [Storage Schema](/reference/storage-schema) を 1 つの record class で拡張する。

| Record     | Indexed by                                                          | Persistence                                                        |
| ---------- | ------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `Incident` | `(id)`, `(state)`, `(detectedAt)`, `(spaceId via affectedSpaceIds)` | Kept indefinitely under audit retention; `postmortem` is terminal. |

実装は incident store を audit store と同居させてよいが、 上記の indexed カラムは保持しなければならない。

## Scope boundary

spec surface は incident record、state machine、auto-detection trigger、上記の operator / 顧客読取り endpoint、audit chain を含む。 現行 kernel リポジトリはそれら HTTP route を mount していない。 公開ステータスページ UI、 顧客 notification テンプレート描画、 incident タイムライン可視化、 third-party paging integration、 on-call rotation、 チケットトラッカー連携は **Takosumi の scope 外** であり、 operator の外側スタック (例: `takos-private/` や別の PaaS provider front end) が実装する。 kernel はそれら外側 surface が組み立てに使う storage / audit primitive を公開する。

## Related architecture notes

- `docs/reference/architecture/operator-boundaries.md` — 顧客 query が参照する operator vs 顧客の可視性ルール。
- `docs/reference/architecture/policy-risk-approval-error-model.md` — severity 導出と trigger family mapping。
- `docs/reference/architecture/observation-drift-revokedebt-model.md` — RevokeDebt aging trigger source。

## 関連ページ

- [Audit Events](/reference/audit-events)
- [Storage Schema](/reference/storage-schema)
- [RevokeDebt Model](/reference/revoke-debt)
- [Quota and Rate Limit](/reference/quota-rate-limit)
- [Readiness Probes](/reference/readiness-probes)
- [Kernel HTTP API](/reference/kernel-http-api)
- [Resource IDs](/reference/resource-ids)
