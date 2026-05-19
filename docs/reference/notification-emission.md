# Notification Emission

> このページでわかること: kernel が emit する通知イベントの型と配信先。

v1 notification signal surface を定義する: 下流の operator 通知 path
を発火させるべきときに kernel が emit する kernel 側 record、 closed な category
enum、 recipient 解決規則、 pull-only な配信統合モデル、 重複 signal を抑制する
idempotency 規則、 audit primitive。 kernel は signal を emit するだけで、
具体的な email / Slack / SMS / in-app / digest 配信は kernel の外で動作する。

## Notification model

kernel は notification を配信しない。 kernel 側 event が closed な v1 category
のいずれかの条件を満たすたびに、構造化 signal を記録する。 operator が signal
queue を consume し、自前の配信チャネルに fan out する。

このモデルの 2 つの帰結:

- kernel は SMTP / Slack / webhook の credential を保持しない。 配信を operator
  の外側スタックに委ねることは、 provider plugin と同じ credential 境界 (project
  AGENTS.md 参照) と一致する。
- 顧客が見るすべての notification は対応する kernel audit event を持つ。
  operator の外側スタックは、 kernel が先に signal として emit
  していない顧客可視 notification を mint できない。

signal は [Audit Events](./audit-events.md) stream の精選 subset に少数の
derived event を加えたもの (例: `approval-near-expiry` は approval TTL から
derive されたもので、それ自身は raw audit event ではない)。

現行 kernel の SLA breach detection 原始機能は、 notification adapter
が設定されているとき `SlaBreachDetectionService` から `sla-breach-detected`
notification signal を emit する。 配信は引き続き pull-only で operator
が所有する。

## Signal categories

v1 category enum は closed。

```text
approval-pending
approval-near-expiry
revoke-debt-operator-action-required
quota-near-limit
sla-breach-detected
incident-acknowledged
incident-resolved
space-trial-expiring
api-key-expiring
migration-completed
migration-rollback
```

Trigger detail:

| Category                               | Trigger                                                                                                | Default severity |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------ | ---------------- |
| `approval-pending`                     | Approval issued and not yet consumed; emitted at issue and re-emitted at TTL milestones.               | notice           |
| `approval-near-expiry`                 | Approval has consumed 50% and again at 90% of its TTL without being consumed.                          | warning          |
| `revoke-debt-operator-action-required` | RevokeDebt aged into `operator-action-required` (see [RevokeDebt Model](./revoke-debt.md)).            | warning          |
| `quota-near-limit`                     | Quota counter reached 80% and again at 95% of cap (see [Quota and Rate Limit](./quota-rate-limit.md)). | warning          |
| `sla-breach-detected`                  | SLA breach with severity `medium` or higher.                                                           | warning          |
| `incident-acknowledged`                | An incident moved into `acknowledged` (see [Incident Model](./incident-model.md)).                     | notice           |
| `incident-resolved`                    | An incident moved into `resolved`.                                                                     | notice           |
| `space-trial-expiring`                 | Trial Space at 7d, 1d, and 1h before expiry.                                                           | notice           |
| `api-key-expiring`                     | API key TTL approaching at operator-tunable thresholds.                                                | notice           |
| `migration-completed`                  | A kernel migration finished successfully (see [Schema Evolution](./migration-upgrade.md)).             | info             |
| `migration-rollback`                   | A kernel migration rolled back.                                                                        | warning          |

category enum は v1 で closed。 新規 category 追加は `CONVENTIONS.md` §6 RFC
を要する。

## Signal record

```yaml
NotificationSignal:
  id: notification:01HM9N7XK4QY8RT2P5JZF6V3W9
  category: quota-near-limit
  spaceId: space:acme-prod
  organizationId: organization:acme
  severity: warning
  recipientActorIds:
    - actor:alice
    - actor:acme-billing
  payload:
    quotaDimension: deployments-per-hour
    threshold: 0.95
    observed: 0.962
    resetAt: 2026-05-05T08:00:00.000Z
  relatedAuditEventIds:
    - 01HM9N7XK4QY8RT2P5JZF6V3W7
  emittedAt: 2026-05-05T07:43:11.214Z
  acknowledgedAt: null
```

Field semantics:

| Field                  | Required | Notes                                                                                                                                          |
| ---------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                   | yes      | `notification:<ulid>` form. Deterministic for idempotent triggers (see below). Immutable.                                                      |
| `category`             | yes      | Closed v1 enum.                                                                                                                                |
| `spaceId`              | no       | Owning Space when the signal is Space-scoped. Nullable for kernel-global signals (for example, `migration-completed` covering every Space).    |
| `organizationId`       | no       | Owning Organization when present; derived from `spaceId` or recipient set.                                                                     |
| `severity`             | yes      | Closed enum: `info`, `notice`, `warning`, `error`, `critical`. Matches the audit envelope severity scale.                                      |
| `recipientActorIds`    | yes      | List of Actor ids resolved at emit time. Empty list is rejected; if no recipient resolves, the kernel records a `severity: error` audit event. |
| `payload`              | yes      | Category-specific structured payload, shape-pinned per category. Unknown payload fields are rejected at emit time.                             |
| `relatedAuditEventIds` | yes      | One or more audit events that grounded the signal. Empty list rejected.                                                                        |
| `emittedAt`            | yes      | RFC 3339 UTC, millisecond precision.                                                                                                           |
| `acknowledgedAt`       | no       | Set when the operator's outer stack acknowledges the signal through the API below.                                                             |

## Recipient resolution

kernel は emit 時に identity model
([Actor / Organization Model](./architecture/identity-and-access-architecture.md#actor--organization-model)
参照) と category 固有の recipient 規則から `recipientActorIds` を計算する。
規則は v1 で closed。

| Category                               | Recipient rule                                                                                                     |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `approval-pending`                     | Actors holding the approval-authority role on the Space's Organization.                                            |
| `approval-near-expiry`                 | Same as `approval-pending`.                                                                                        |
| `revoke-debt-operator-action-required` | Actors holding `space-admin` on the Space's Organization plus the Organization's `billingContactActorId`.          |
| `quota-near-limit`                     | Actors holding `space-admin` on the Space's Organization plus `billingContactActorId`.                             |
| `sla-breach-detected`                  | Actors holding `space-admin` on every affected Organization.                                                       |
| `incident-acknowledged`                | Actors holding any membership state `active` on the affected Organizations, plus `billingContactActorId`.          |
| `incident-resolved`                    | Same recipient set as the `incident-acknowledged` signal that grounded the same incident.                          |
| `space-trial-expiring`                 | `billingContactActorId` plus `org-owner` Actors of the Space's Organization.                                       |
| `api-key-expiring`                     | The Actor that owns the API key. If the owner is `service-account`, the Organization's `org-owner` Actors instead. |
| `migration-completed`                  | `org-owner` Actors of every Organization with at least one active Space.                                           |
| `migration-rollback`                   | Same recipient set as `migration-completed` for the same migration id.                                             |

解決は emit 時の live identity view を使う。 Membership が `removed`
に遷移する直前に emit された signal は以前の `recipientActorIds` を運ぶ。 kernel
は emit 後に再解決しない。

## Pull-only delivery integration

push surface ではなく、operator は signal queue を pull する。

- `GET /api/internal/v1/notifications` — cursor pagination 付きで signal list。
  filter は `category`、`spaceId`、`organizationId`、`severity`、time window。
  cursor は opaque で acknowledgement 横断で安定。
- `GET /api/internal/v1/notifications?since=<cursor>` — 最後に見た cursor から
  pull を再開。
- `POST /api/internal/v1/notifications/:id/ack` — operator が delivery 試行後に
  signal を ack。`acknowledgedAt` set。 ack は delivery 結果から独立し、kernel
  は結果によらず signal を記録する。

pull-only モデル:

- kernel から push credential を取り除く。
- operator は region ごとに 1 つの delivery worker を deploy し、at-least-once
  な consumer semantics で水平スケールできる。
- operator が tune できる retention window が閉じるまで signal は durable。 ack
  済み signal より未 ack signal の方が長く保持され、audit retention
  で上限が決まる。

webhook 風の push モードは **v1 では scope 外**。 kernel は notification
配信のための outbound HTTP 呼び出しを開始しない。

## Idempotency

signal `id` は `(category, scope, trigger fingerprint)` tuple ごとに決定的。
trigger fingerprint は category 固有。

- `approval-pending`, `approval-near-expiry`: `approvalId` + TTL milestone
  (`issue`、`50pct`、`90pct`)。
- `revoke-debt-operator-action-required`: `revokeDebtId` + transition
  timestamp。
- `quota-near-limit`: `(quotaDimension, threshold, window-start)`。
- `sla-breach-detected`: breach signal id。
- `incident-acknowledged`, `incident-resolved`: `(incidentId, toState)`。
- `space-trial-expiring`: `(spaceId, milestone)`、milestone は `7d` / `1d` /
  `1h`。
- `api-key-expiring`: `(apiKeyId, milestone)`。
- `migration-completed`, `migration-rollback`: `(migrationId, outcome)`。

同じ trigger を再評価すると同じ `id` が生成される。 kernel は write
時に重複排除する: 既存 `id` での 2 度目の emit は no-op として記録され、 同じ
record 上の `notification-emit-suppressed-duplicate` envelope として audit に
surface する。

## Audit events

v1 notification audit event 分類は closed で、 [Audit Events](./audit-events.md)
の closed enum に加わる。

- `notification-emitted`
- `notification-acknowledged`

各 event は標準 envelope に
`{notificationId, category, recipientActorIds, relatedAuditEventIds}` を記録した
payload を持つ。 audit chain は notification record を `relatedAuditEventIds` の
source event にリンクし、 任意の signal を根拠付けた chain を operator が replay
できる。

## Storage schema

NotificationSignal は [Storage Schema](./storage-schema.md) を 1 つの record
class で拡張する。

| Record               | Indexed by                                                                                                 | Persistence                                                                        |
| -------------------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `NotificationSignal` | `(id)`, `(category, emittedAt)`, `(spaceId, emittedAt)`, `(organizationId, emittedAt)`, `(acknowledgedAt)` | Kept under audit retention; acknowledged signals trim earlier than unacknowledged. |

実装は signal store を audit store と同居させてよいが、 上記 indexed
カラムは保持しなければならない。

## Scope boundary

Takosumi kernel は signal record、closed category enum、recipient 解決規則、
pull-only operator endpoint、idempotency 規則、audit chain を同梱する。 具体的な
email テンプレート、Slack bot 配線、in-app push チャネル、 SMS / 音声 gateway、
digest スケジューリング、 locale 対応レンダリング、 unsubscribe / 設定 UI、
per-recipient 配信 throttling は **Takosumi の scope 外** であり、 operator
の外側スタック (`takos-private/` や別の PaaS provider front end など)
が実装する。 kernel はそれら外側 surface が組み立てに使う signal / audit
primitive を公開する。

## Related architecture notes

- `docs/reference/architecture/operator-boundaries.md` — pull-only delivery を
  motivate する credential 境界。
- `docs/reference/architecture/policy-risk-approval-error-model.md` — approval
  関連 category を根拠付ける approval / risk event。
- `docs/reference/incident-model.md#observation-drift--revokedebt-model` —
  `revoke-debt-operator-action-required` category を根拠付ける RevokeDebt
  trigger。

## 関連ページ

- [Audit Events](./audit-events.md)
- [Actor / Organization Model](./architecture/identity-and-access-architecture.md#actor--organization-model)
- [Approval Invalidation Triggers](./approval-invalidation.md)
- [RevokeDebt Model](./revoke-debt.md)
- [Quota and Rate Limit](./quota-rate-limit.md)
- [Incident Model](./incident-model.md)
- [Schema Evolution](./migration-upgrade.md)
- [Kernel HTTP API](./kernel-http-api.md)
- [Storage Schema](./storage-schema.md)
- [Resource IDs](./resource-ids.md)
