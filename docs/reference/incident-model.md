# Incident Model

> このページでわかること: インシデントのモデル定義とステート遷移。

本リファレンスは v1 Incident primitive を定義する: service-impacting event の
kernel 側 record、その lifecycle を支配する closed な state machine、既存の
kernel signal から incident を mint する auto-detection trigger、operator と
顧客に対する可視性ルール、すべての state 遷移を記録する audit chain。kernel は
incident record、state machine、audit primitive を同梱する。顧客向けステータス
ページ、incident タイムライン可視化、notification 描画は kernel の scope 外
である。

## Incident definition

Incident は次の 2 つの origin 条件のいずれかを満たす、kernel に記録される
service-impacting event である。

- **Auto-detected** from a kernel-side measurable signal: an SLA breach,
  RevokeDebt aging into `operator-action-required`, a readiness probe failure
  rate above threshold, or a sustained internal-error rate above threshold.
- **Operator-declared** through the internal control plane when an outer-layer
  signal (customer report, third-party dependency outage, operator-side change
  failure) needs to be tracked through the same state machine and audit chain.

両 origin は同じ record 形を生成し、同じ state machine をたどる。Origin が
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

v1 state enum は closed である。

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

- `detecting`: kernel has minted the incident from a trigger but no operator has
  yet acknowledged it. Customer-visibility is suppressed in this state; the
  record is internal-only.
- `acknowledged`: operator has confirmed the incident is real. From this state
  forward, the record is visible to affected customers through the read-only
  customer query (below).
- `mitigating`: operator is applying remediation. Customer visibility remains.
- `monitoring`: remediation has been applied; operator is observing for
  regression before declaring resolved.
- `resolved`: operator has declared the impact ended. `resolvedAt` is set.
  Customer visibility shifts to "resolved" framing.
- `postmortem`: operator has published a structured root-cause record
  (`rootCause` populated). Terminal in v1.

Transition rules:

- `detecting` may auto-ack to `acknowledged` if the operator opts in via the
  auto-acknowledge policy on the trigger family. Otherwise acknowledgement is
  operator-initiated.
- `monitoring` may regress to `mitigating` an unbounded number of times before
  reaching `resolved`. Each regression is an audit event.
- `postmortem` is terminal. Editing the published root cause requires a new
  incident referencing the previous one.

Severity enum (closed v1):

```text
low | medium | high | critical
```

- `low`: degraded internal metric, no customer-visible impact.
- `medium`: scoped customer impact (single Space, partial surface).
- `high`: broad customer impact across multiple Spaces in one Organization or
  across the kernel-global readiness probe.
- `critical`: kernel-global outage or compliance-relevant data path failure.

severity は detection 時に trigger family から計算され、operator が調整できる。
severity の引き上げは理由付きの audit event を記録する。severity の引き下げも
audit event を記録し、state 遷移と同じ承認スコープを要求する。

## Auto-detection triggers

kernel は次の family から incident を mint する。各 family は default severity
と auto-acknowledge default にマップされ、operator は Space 単位で上書きできる。

| Trigger family                         | Source signal                                                         | Default severity | Default auto-ack |
| -------------------------------------- | --------------------------------------------------------------------- | ---------------- | ---------------- |
| `sla-breach`                           | SLA breach detected on a published SLO                                | derived          | no               |
| `revoke-debt-operator-action-required` | RevokeDebt aged into `operator-action-required` count above threshold | medium           | no               |
| `readiness-probe-failure-rate`         | `/readyz` failing above the operator-tunable threshold for the window | high             | yes              |
| `error-rate-sustained`                 | DomainErrorCode `internal_error` rate sustained above threshold       | medium           | no               |

Trigger detail:

- **SLA breach**: severity is derived from the breached SLO's declared
  customer-impact tier. The kernel attaches the breach signal id to
  `relatedAuditEventIds`.
- **RevokeDebt aging**: thresholds are configured per Space in the policy pack.
  The default is `>= 1` aged debt for medium severity; operators tune up or
  down. A new aged debt entering the same open incident extends
  `relatedAuditEventIds` rather than minting a new incident.
- **Readiness probe failure rate**: kernel-global by construction. Sets
  `kernelGlobal: true` and clears `affectedSpaceIds`.
- **Sustained error rate**: per-Space when the error stream carries a Space
  scope; kernel-global otherwise.

kernel は `(trigger family, scope)` tuple 単位の sliding window 内で auto
検知された incident を重複排除する。window 内で 2 度目の一致 trigger が来た
場合は open な incident に追記する。window 外では新規 incident を mint する。

## Operator actions

operator は HMAC で gate された内部 control plane を通じて操作する
([Kernel HTTP API](/reference/kernel-http-api) 参照)。

- `POST /api/internal/v1/incidents` — declare an operator-declared incident.
  Body fields: `title`, `severity`, `affectedSpaceIds` or `kernelGlobal`,
  optional `relatedAuditEventIds`.
- `PATCH /api/internal/v1/incidents/:id` — advance state, edit title, adjust
  severity, add to `affectedSpaceIds` or `relatedAuditEventIds`. The kernel
  rejects transitions that violate the state machine.
- `POST /api/internal/v1/incidents/:id/postmortem` — publish the root-cause
  record. Requires `state = resolved`. Sets `state =
  postmortem` and freezes
  the record.
- `GET /api/internal/v1/incidents` — list with cursor pagination and filters on
  `state`, `severity`, `origin`, time window, `spaceId`.

## Customer-affecting query

読み取り専用の顧客クエリは、`state` が `acknowledged` 以降で、`affectedSpaceIds`
に caller が読める Space を含む incident を公開する。

- `GET /api/internal/v1/spaces/:id/incidents` — list incidents scoped to the
  Space. Returns `id`, `title`, `state`, `severity`, `detectedAt`,
  `acknowledgedAt`, `mitigatedAt`, `resolvedAt`, `rootCause` (only when
  `state = postmortem`).

クエリはアクセス権にかかわらず `detecting` 状態の incident を抑制する: 後で
false positive と判定された auto-detected incident が顧客に見えることはない。

`kernelGlobal` incident は、caller が kernel 内のいずれかの Space に対する
権限を持つあらゆる Space クエリで返される。

## Audit events

すべての state 遷移は audit event を発行する。v1 incident audit event 分類は
closed で、[Audit Events](/reference/audit-events) の closed enum に加わる。

- `incident-detected`
- `incident-acknowledged`
- `incident-state-changed`
- `incident-severity-changed`
- `incident-resolved`
- `incident-postmortem-published`

各 event は標準 envelope に
`{incidentId, fromState, toState, fromSeverity, toSeverity,
relatedAuditEventIds}`
を記録した incident payload を持つ (該当箇所のみ)。 kernel は state pair
が有効な遷移でない audit write を reject する。

## Storage schema

Incident は [Storage Schema](/reference/storage-schema) を 1 つの record class
で拡張する。

| Record     | Indexed by                                                          | Persistence                                                        |
| ---------- | ------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `Incident` | `(id)`, `(state)`, `(detectedAt)`, `(spaceId via affectedSpaceIds)` | Kept indefinitely under audit retention; `postmortem` is terminal. |

実装は incident store を audit store と同居させてよいが、上記の indexed カラム
は保持しなければならない。

## Scope boundary

spec surface は incident record、state machine、auto-detection trigger、上記の
operator / 顧客読取りエンドポイント、audit chain を含む。現行 kernel リポジ
トリはそれら HTTP route をマウントしていない。公開ステータスページ UI、顧客
notification テンプレート描画、incident タイムライン可視化、third-party paging
integration、on-call rotation、チケットトラッカー連携は **Takosumi の scope 外**
であり、operator の外側スタック (例: `takos-private/` や別の PaaS provider front
end) が実装する。kernel はそれら外側 surface が組み立てに使う storage / audit
primitive を公開する。

## Related architecture notes

- `docs/reference/architecture/operator-boundaries.md` — operator vs. customer
  visibility rules referenced by the customer-affecting query.
- `docs/reference/architecture/policy-risk-approval-error-model.md` — severity
  derivation and trigger family mapping.
- `docs/reference/architecture/observation-drift-revokedebt-model.md` —
  RevokeDebt aging trigger source.

## 関連ページ

- [Audit Events](/reference/audit-events)
- [Storage Schema](/reference/storage-schema)
- [RevokeDebt Model](/reference/revoke-debt)
- [Quota and Rate Limit](/reference/quota-rate-limit)
- [Readiness Probes](/reference/readiness-probes)
- [Kernel HTTP API](/reference/kernel-http-api)
- [Resource IDs](/reference/resource-ids)
