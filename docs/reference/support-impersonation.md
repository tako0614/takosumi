# Support Impersonation

> このページでわかること: サポート用 impersonation の仕組みと制約。

本リファレンスは、operator の support 機能を代行して顧客 Space に読み書きする
support-staff Actor の v1 認証モデルを定義する。support-staff actor 型、
impersonation grant と session record、顧客 admin が grant を承認するための
承認フロー、read-only / read-write スコープ規則、session TTL 上限、audit
primitive、operator 専用 API surface を固定する。具体的なサポートダッシュ
ボード、チケット連携、画面共有ツール、顧客向け承認 UI は kernel の scope 外
である。

## Support-staff actor

`support-staff` actor 型は closed な v1 actor 型 enum の一部である
([Actor / Organization Model](/reference/actor-organization-model#actor-types)
参照)。identity 形式は次の通り。

```text
actor:support-staff/<id>
```

Properties:

- Auth source is OIDC against the operator's support tenant or an
  operator-issued bearer token bound to a support-tenant subject.
- A support-staff Actor never holds direct Space membership. It does not appear
  in any Membership record. RBAC role assignment is rejected for support-staff
  Actors.
- Authorization to read or write a Space is mediated entirely through the
  impersonation grant and session records below.
- A support-staff Actor lifecycle is operator-controlled: creating, suspending,
  and deleting them lives on the operator side.

kernel は support-staff Actor を mint しようとする public deploy bearer や
runtime-agent enrollment を reject する。発行 path は operator の内部 control
plane のみである。

## Impersonation grant

impersonation grant は、support-staff Actor が Space に対して session を open
できるようにする認可 artifact である。

```yaml
SupportImpersonationGrant:
  id: support-grant:01HM9N7XK4QY8RT2P5JZF6V3W9
  supportActorId: actor:support-staff/jane
  spaceId: space:acme-prod
  scope: read-only # or read-write
  reason: "ticket ACME-1234: deploy stuck in failed-apply"
  ticketRef: "acme-tickets#1234" # operator-supplied opaque reference, optional
  state: requested # closed enum below
  requestedAt: 2026-05-05T07:43:11.214Z
  approvedAt: null
  rejectedAt: null
  expiresAt: 2026-05-06T07:43:11.214Z
  approvedByActorId: null
  rejectedByActorId: null
```

Field semantics:

| Field               | Required | Notes                                                                                                               |
| ------------------- | -------- | ------------------------------------------------------------------------------------------------------------------- |
| `id`                | yes      | `support-grant:<ulid>` form. Kernel-minted at create. Immutable.                                                    |
| `supportActorId`    | yes      | Must reference an Actor whose type is `support-staff`. Immutable.                                                   |
| `spaceId`           | yes      | Single Space scope. v1 grants are not multi-Space; cross-Space support work creates one grant per Space. Immutable. |
| `scope`             | yes      | Closed enum: `read-only`, `read-write`. Default at create is `read-only`. Immutable for the grant.                  |
| `reason`            | yes      | Mandatory free-form rationale recorded into the audit chain. Minimum length enforced by kernel.                     |
| `ticketRef`         | no       | Operator-supplied opaque reference for cross-system correlation.                                                    |
| `state`             | yes      | Closed enum (see lifecycle).                                                                                        |
| `requestedAt`       | yes      | RFC 3339 UTC, millisecond precision.                                                                                |
| `approvedAt`        | no       | Set when `state` becomes `approved`.                                                                                |
| `rejectedAt`        | no       | Set when `state` becomes `rejected`.                                                                                |
| `expiresAt`         | yes      | TTL ceiling for the grant. Bounded by operator-tunable max (default 1h, 24h max).                                   |
| `approvedByActorId` | no       | Customer admin Actor that approved. Required at approve time.                                                       |
| `rejectedByActorId` | no       | Customer admin Actor or operator that rejected.                                                                     |

### Grant lifecycle

```text
requested --(customer-admin-approves)--> approved --(expires | revoked)--> terminated
   |                                          |
   |                                          `--(customer-admin-revokes)--> revoked
   `--(customer-admin-rejects | operator-cancels)--> rejected
```

Closed `state` enum: `requested`, `approved`, `rejected`, `revoked`, `expired`.

- `requested`: grant created by the operator on behalf of a support-staff Actor.
  The grant is not yet usable.
- `approved`: a customer admin (member with `space-admin` role on the target
  Space's Organization) accepted the grant. Sessions can be opened up to
  `expiresAt`.
- `rejected`: customer admin denied or the operator cancelled before approval.
- `revoked`: customer admin or operator terminated an approved grant before TTL.
- `expired`: kernel auto-terminated at `expiresAt`.

Terminal states: `rejected`, `revoked`, `expired`. The kernel rejects mutating a
terminal grant back to an active state. A new grant must be minted.

### Approval flow

1. Operator issues `POST /api/internal/v1/support/impersonations` with
   `supportActorId`, `spaceId`, `scope`, `reason`, and optional `ticketRef`.
   Grant enters `requested`.
2. Customer admin sees the pending grant on the customer-self-service plane (a
   kernel-side query, not a UI) and either accepts or rejects.
3. Acceptance moves the grant to `approved` and records `approvedByActorId` and
   `approvedAt`. The kernel verifies the acting Actor holds `space-admin` on the
   target Space's Organization at approve time; the check uses the live RBAC
   view and rejects stale assignments.
4. Rejection moves the grant to `rejected` with `rejectedByActorId` and
   `rejectedAt`.

`read-write` grant は承認時に顧客 admin の明示同意を要求する: 承認 payload は
明示的な `acceptScope: "read-write"` field を運ぶ。承認 payload が `read-only`
しか運ばない場合、kernel は `read-write` grant を reject する。

## Impersonation session

session は承認された grant の下で発行される runtime token である。

```yaml
SupportImpersonationSession:
  id: support-session:01HM9N7XK4QY8RT2P5JZF6V3WA
  grantId: support-grant:01HM9N7XK4QY8RT2P5JZF6V3W9
  supportActorId: actor:support-staff/jane
  spaceId: space:acme-prod
  scope: read-only
  startedAt: 2026-05-05T07:50:00.000Z
  endedAt: null
  expiresAt: 2026-05-05T08:50:00.000Z
  endReason: null
```

Field semantics:

| Field            | Required | Notes                                                                                                  |
| ---------------- | -------- | ------------------------------------------------------------------------------------------------------ |
| `id`             | yes      | `support-session:<ulid>` form. Kernel-minted. Immutable.                                               |
| `grantId`        | yes      | Owning grant. Immutable.                                                                               |
| `supportActorId` | yes      | Inherited from the grant. Immutable.                                                                   |
| `spaceId`        | yes      | Inherited from the grant. Immutable.                                                                   |
| `scope`          | yes      | Inherited from the grant; cannot be widened mid-session.                                               |
| `startedAt`      | yes      | RFC 3339 UTC, millisecond precision.                                                                   |
| `endedAt`        | no       | Set on session end.                                                                                    |
| `expiresAt`      | yes      | Session TTL. Default 1h, operator-tunable, 24h max. Cannot exceed the grant's `expiresAt`.             |
| `endReason`      | no       | Closed enum: `expired`, `support-ended`, `customer-revoked`, `operator-cancelled`, `grant-terminated`. |

Session rules:

- Default scope is `read-only`. A `read-only` session may invoke any Space-read
  endpoint authorized by the live RBAC view; write surfaces reject the session
  token.
- A `read-write` session requires the parent grant to be `read-write`. Every
  write action emits a `support-impersonation-write-action-recorded` audit event
  in addition to the action's own audit event.
- Session token is not exchangeable for any other Space's scope; a grant ending
  mid-session ends every session it owns.

## Rate limit and active-session caps

kernel は過度に広い impersonation を防ぐため、上限を強制する。

- Per Space, a maximum number of concurrently `approved` grants
  (operator-tunable, default 3). Excess grant requests are rejected.
- Per Space, a maximum number of concurrently active sessions (operator-tunable,
  default 2). Excess session opens are rejected.
- Per support-staff Actor, a maximum number of concurrent active sessions across
  all Spaces (operator-tunable, default 5).

上限到達は `severity: warning` の audit signal を発行する。operator が tune
できる window 内での上限到達の繰り返しは
[Incident Model](/reference/incident-model) 自動検知 path の trigger family と
なる: 拒否された grant 要求や session open のバーストが持続すると、
`support-impersonation-burst` family の下で incident が自動 mint される。

## Audit events

v1 support-impersonation の audit event 分類は closed で、
[Audit Events](/reference/audit-events) の closed enum に加わる。

- `support-impersonation-requested`
- `support-impersonation-approved`
- `support-impersonation-rejected`
- `support-impersonation-revoked`
- `support-impersonation-expired`
- `support-impersonation-session-started`
- `support-impersonation-session-ended`
- `support-impersonation-write-action-recorded`

各 event は標準 envelope に
`{grantId, sessionId, supportActorId, spaceId, scope, reason, endReason}` を
記録した payload を持つ (該当箇所のみ)。audit chain は永続的: 終端の grant と
session は Space の compliance regime ([Audit Events](/reference/audit-events)
参照) のもと audit store に残る。 顧客 admin はこれらの event を、kernel が
Space scope の任意の event 向けに 公開する同じ audit クエリで読み取る。

## Operator-only endpoints

operator は HMAC で gate された内部 control plane を通じて操作する
([Kernel HTTP API](/reference/kernel-http-api) 参照)。

- `POST /api/internal/v1/support/impersonations` — operator creates a grant.
  Body: `supportActorId`, `spaceId`, `scope`, `reason`, optional `ticketRef`,
  optional `expiresAt` override bounded by the operator max.
- `DELETE /api/internal/v1/support/impersonations/:id` — operator cancels or
  revokes. Sets `state` to `rejected` (if `requested`) or `revoked` (if
  `approved`).
- `GET /api/internal/v1/support/impersonations` — list with filters on `state`,
  `spaceId`, `supportActorId`, time window.

customer self-service plane は、顧客 admin 向けの approval / revoke エンド
ポイントを公開する。

- `POST /v1/impersonations/:id/accept` — customer admin approves. Body carries
  `acceptScope` to confirm the requested scope.
- `POST /v1/impersonations/:id/reject` — customer admin rejects.
- `DELETE /v1/impersonations/:id` — customer admin revokes an approved grant
  (terminates every session it owns).

customer self-service plane は他の Space admin 操作と同じ RBAC 強制を使う。
kernel は呼び出し時点で target Organization に対して `space-admin` を保持して
いない Actor からの上記すべてを reject する。

## Storage schema

support impersonation は [Storage Schema](/reference/storage-schema) を 2 つの
record class で拡張する。

| Record                        | Indexed by                                                                 | Persistence                              |
| ----------------------------- | -------------------------------------------------------------------------- | ---------------------------------------- |
| `SupportImpersonationGrant`   | `(id)`, `(spaceId, state)`, `(supportActorId, state)`, `(expiresAt)`       | Kept indefinitely under audit retention. |
| `SupportImpersonationSession` | `(id)`, `(grantId)`, `(spaceId, startedAt)`, `(supportActorId, startedAt)` | Kept indefinitely under audit retention. |

## Scope boundary

Takosumi kernel は support-staff actor 型、grant と session の record、approval
フロー、scope / TTL 強制、rate limit、audit chain、上記の operator /
self-service エンドポイントを同梱する。顧客 admin 通知 UI、support-staff
ダッシュボード、 チケットトラッカー連携、画面共有 / リモート制御ツール、support
tenant の identity provisioning、読取専用 redacted view の描画は **Takosumi の
scope 外** であり、operator の外側スタック (例: `takos-private/` や別の PaaS
provider front end) が実装する。kernel はそれら外側 surface が組み立てに使う
auth モデルと audit primitive を公開する。

## Related architecture notes

- `docs/reference/architecture/operator-boundaries.md` — support-staff actor as
  a separate trust boundary from human and service-account Actors.
- `docs/reference/architecture/policy-risk-approval-error-model.md` — approval
  semantics referenced by the read-write consent rule.
- `docs/reference/architecture/space-model.md` — Space-admin role binding
  referenced by the customer-self-service approval flow.

## 関連ページ

- [Actor / Organization Model](/reference/actor-organization-model)
- [Audit Events](/reference/audit-events)
- [Kernel HTTP API](/reference/kernel-http-api)
- [Storage Schema](/reference/storage-schema)
- [Incident Model](/reference/incident-model)
- [Resource IDs](/reference/resource-ids)
