# Triggers

> Stability: design draft Audience: operator, integrator, kernel-implementer See
> also: [Closed Enums](/reference/closed-enums),
> [Execute-Step Operation](/reference/execute-step-operation),
> [Audit Events](/reference/audit-events),
> [Workflow Extension Design](/reference/architecture/workflow-extension-design)

Takosumi v1 における **Trigger primitive** の予約済み extension contract です。
Trigger は workflow / job / hook 等の plugin shape を kick するための
kernel-side 機構として設計されていますが、現行 kernel はまだ trigger HTTP routes
/ scheduler / persistent TriggerRegistration store を expose しません。 本 doc
は kind 定義 / HTTP surface / record schema / audit event / boundary の 将来互換
vocabulary を定めます。

## Overview

Trigger は workflow / job / hook 等の plugin shape を起動するための kernel-side
primitive です。kernel は trigger を受けて当該 resource の OperationPlan を
generate し、apply pipeline に流します。

- **3 closed kind**: `manual` / `schedule` / `external-event`
- **git decoupling**: trigger payload は kernel から見て opaque JSON。kernel は
  git push / Slack event / SaaS webhook の syntax を持たず、operator-side が
  external converter で `external-event` 形式に変換して POST する
- **resource-binding**: trigger は単独で意味を持たず、必ず resource (job / hook
  shape の instance) に binding される。発火後の effect は resource の
  OperationPlan として処理される
- **plugin-first 拡張**: 新 trigger kind 追加は `CONVENTIONS.md` §6 RFC を要し、
  trigger semantic の拡張も同様に RFC 経由

## Trigger kind closed v1 enum

```text
manual | schedule | external-event
```

3 値の closed enum。値追加は `CONVENTIONS.md` §6 RFC を必須とする。

### `manual`

Operator / customer-admin が手動で発火する kind。

| Item        | Spec                                        |
| ----------- | ------------------------------------------- |
| HTTP        | `POST /v1/triggers/manual`                  |
| Body        | `{ resourceRef, inputs? }`                  |
| Auth        | actor token + RBAC `workflow-trigger`       |
| Idempotency | `Idempotency-Key` header (24h dedup window) |
| Rate limit  | per-actor (quota tier に従う)               |

`inputs` は opaque JSON で、resource の plugin shape が解釈する。kernel は field
shape を validate しない。`Idempotency-Key` を omit した場合、kernel は 1
request 限りの key を generate するが、retry 保護は得られない (CLI / SDK 側で
key を握ること推奨)。

`resourceRef` は manifest 上で trigger を許可している resource を指す
`object:<shape>/<name>` 形式の reference。RBAC `workflow-trigger` を持たない
actor の request は `permission_denied` で reject される。`resourceRef` が
存在しない / revoke されている場合は `not_found`、resource が `triggers[]` に
`manual` kind を含まない場合は `failed_precondition` を返す。

### `schedule`

kernel-side cron evaluator が発火する kind。

| Item               | Spec                                                                       |
| ------------------ | -------------------------------------------------------------------------- |
| Syntax             | 5-field POSIX cron (`min hour day-of-month month day-of-week`)             |
| Timezone           | UTC fixed (per-trigger TZ は将来 RFC)                                      |
| `@aliases`         | `@hourly` / `@daily` 等は v1 では採用しない (plugin 側で expand 可)        |
| Missed-fire policy | `skip` (default) / `catchup-latest` (per-trigger config)                   |
| 登録               | `POST /api/internal/v1/triggers/schedule` (operator-only)                  |
| Drift 検出         | kernel restart / clock skew で missed-fire を observation event として記録 |

`catchup-latest` は missed window 中の最後の 1 回だけを fire する。複数 missed
fire を全部 catch up する mode は v1 では採用しない (storm 対策)。Drift 検出時の
observation event は `trigger-fired` の payload に
`{ missedFires: <n>, policy: catchup-latest | skip }` を載せて記録する。

`schedule` trigger は `runtime-agent` の clock ではなく kernel-side cron
evaluator が evaluation source となる。kernel が leader 切り替えを行った場合も
`(registrationId, expectedFireAt)` tuple で dedup されるため、二重 fire は
発生しない。

### `external-event`

operator-side webhook receiver が変換した event を受け取る kind。

| Item    | Spec                                                                                              |
| ------- | ------------------------------------------------------------------------------------------------- |
| HTTP    | `POST /v1/triggers/external`                                                                      |
| Body    | `{ resourceRef, eventName, payload }`                                                             |
| Auth    | HMAC-SHA256 signature header `X-Takosumi-Trigger-Signature`                                       |
| Secret  | trigger registration 時に bind、`POST /api/internal/v1/triggers/external` で operator が register |
| Payload | opaque JSON (kernel は意味解釈しない、plugin shape が解釈)                                        |
| Dedup   | `(triggerId, eventName, requestIdempotencyKey)` で 5 分 window 内重複排除                         |
| Tunable | `TAKOSUMI_TRIGGER_DEDUP_WINDOW_SECONDS` (default 300)                                             |

Use case: operator-side が git push / Slack / SaaS event を受け、内部で kernel
向けに変換して `/v1/triggers/external` に POST する。kernel はこの converter
の実装を持たない。

## Trigger ↔ resource binding

resource (job / hook shape の instance 等) は manifest 上で `triggers[]` field
を持ち、kernel は trigger 発火時に当該 resource を re-apply (新 OperationPlan
generate) する。

```yaml
- shape: cron-job@v1
  name: nightly-backup
  provider: "@some-org/cron-runner"
  spec:
    triggers:
      - kind: schedule
        cron: "0 3 * * *"
        missedFirePolicy: skip
    bundle:
      kind: oci-image
      uri: ghcr.io/example/backup@sha256:...
```

resource manifest の `triggers[]` entry は 1 trigger registration record
を生成し、 manifest revision が変わると registration も diff の対象になる (古い
registration は revoke、新しい registration は issue)。

## TriggerRegistration record schema

manifest に書かれた trigger 1 entry は以下の record として永続化される。

```yaml
TriggerRegistration:
  id: trigger-registration:<ulid>
  spaceId: space:<ulid>
  resourceRef: object:cron-job/nightly-backup
  kind: manual | schedule | external-event
  spec: <kind-specific> # cron / eventName / signature subject 等
  secretHash: optional # external-event のみ、HMAC secret の sha256
  createdAt: <rfc3339>
  revokedAt: optional # revoke 後は新 fire を受けない
```

## Trigger record schema (per-fire instance)

発火 1 回ごとに以下の record が永続化される。

```yaml
Trigger:
  id: trigger:<ulid>
  registrationId: trigger-registration:<ulid>
  spaceId: space:<ulid>
  kind: manual | schedule | external-event
  firedAt: <rfc3339>
  payload: opaque JSON # external-event のみ、redaction policy は audit と同じ
  causedOperationId: operation:<ulid> # 結果として generate された OperationPlan
  status: fired | rejected | deduplicated
```

`status` は `fired` (正常) / `rejected` (auth / signature 失敗) / `deduplicated`
(dedup window 内重複) の 3 値 closed enum。

## Audit events

Trigger は以下の audit event を emit する。詳細 envelope は
[Audit Events](/reference/audit-events) を参照。

| Event                  | 発火条件                                       |
| ---------------------- | ---------------------------------------------- |
| `trigger-fired`        | 正常 fire (status = `fired`)                   |
| `trigger-rejected`     | actor token / HMAC signature 検証失敗          |
| `trigger-deduplicated` | dedup window 内で同一 idempotency key を再受信 |

## HTTP endpoints

| Path                                      | Auth                        | Scope                           |
| ----------------------------------------- | --------------------------- | ------------------------------- |
| `POST /v1/triggers/manual`                | actor token                 | RBAC `workflow-trigger`         |
| `POST /v1/triggers/external`              | HMAC sig (per-registration) | per-registration secret         |
| `POST /api/internal/v1/triggers/schedule` | internal HMAC               | operator-only register          |
| `POST /api/internal/v1/triggers/external` | internal HMAC               | operator register (secret bind) |
| `DELETE /api/internal/v1/triggers/:id`    | internal HMAC               | operator-only revoke            |

## Cancellation

- 発火後の OperationPlan は `POST /api/internal/v1/operations/:id/cancel` で
  cancel する。詳細は
  [Execute-Step Operation](/reference/execute-step-operation) を参照
- `schedule` trigger の registration を発火停止するには
  `DELETE /api/internal/v1/triggers/:id` で revoke する
- `external-event` registration の secret rotation は revoke + 新規 register の
  2 段階で行う (in-place rotation は v1 で採用しない)

## Boundary

kernel が ownership を持つのは以下:

- trigger 発火 (manual HTTP / cron evaluator / external-event HTTP)
- dedup window 管理
- HMAC signature verify / actor token verify
- `trigger-fired` / `trigger-rejected` / `trigger-deduplicated` audit emit
- TriggerRegistration / Trigger record の永続化

kernel が ownership を**持たない**もの (outside takosumi, operator-side):

- 顧客向け trigger UI / dashboard
- webhook converter (git push → external-event 変換 / Slack → external-event
  変換)
- payload schema validation (plugin shape の責務)
- per-trigger TZ / cron `@aliases` / 複数 catchup mode 等の semantic 拡張

各 trigger kind の semantic 拡張 (新 trigger kind 追加 / `schedule` の TZ field
追加 / dedup tuple の変更 等) は `CONVENTIONS.md` §6 RFC を要する。

## Related design notes

- `docs/reference/architecture/workflow-extension-design.md` — Plugin-first
  rationale
