# Support Impersonation

> このページでわかること: サポート用 impersonation の仕組みと制約。

operator の support 機能を代行して顧客 Space に読み書きする support-staff Actor
の v1 認証モデルを定義する。 support-staff actor 型、 impersonation grant と
session record、 顧客 admin が grant を承認するための承認フロー、 read-only /
read-write スコープ規則、 session TTL 上限、 audit primitive、 operator 専用 API
surface を固定する。 具体的なサポートダッシュボード、 チケット連携、
画面共有ツール、 顧客向け承認 UI は kernel の scope 外。

## Support-staff actor

`support-staff` actor 型は closed な v1 actor 型 enum の一部
([Actor / Organization Model](/reference/actor-organization-model#actor-types)
参照)。 identity 形式:

```text
actor:support-staff/<id>
```

Properties:

- auth source は operator の support tenant に対する OIDC、 または
  support-tenant subject に bind された operator 発行 bearer token。
- support-staff Actor は直接 Space membership を持たない。 Membership record
  に現れず、support-staff Actor への RBAC role assignment は reject される。
- Space の read / write 認可は、下記 impersonation grant と session record
  だけが mediate する。
- support-staff Actor の lifecycle は operator-controlled: 作成 / 一時停止 /
  削除は operator 側に住む。

kernel は support-staff Actor を mint しようとする installer bearer や
runtime-agent enrollment を reject する。 発行 path は operator 内部 control
plane のみ。

## Impersonation grant

impersonation grant は、 support-staff Actor が Space に対して session を open
できるようにする認可 artifact。

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

- `requested`: operator が support-staff Actor を代行して生成した
  grant。まだ使えない。
- `approved`: 顧客 admin (target Space の Organization 上で `space-admin` role
  を持つ member) が grant を受諾。 `expiresAt` まで session を open できる。
- `rejected`: 顧客 admin が否認、または operator が approval 前にキャンセル。
- `revoked`: 顧客 admin または operator が TTL 前に approved grant を終了。
- `expired`: kernel が `expiresAt` で auto-terminate。

Terminal states: `rejected`, `revoked`, `expired`. kernel は terminal grant を
active state に戻す mutation を reject する。新規 grant を mint する必要がある。

### Approval flow

1. operator が `POST /api/internal/v1/support/impersonations` を
   `supportActorId`、`spaceId`、`scope`、`reason`、optional `ticketRef` で
   issue。grant は `requested` に。
2. 顧客 admin は customer-self-service plane (UI ではなく kernel 側 query) で
   pending grant を見て、accept または reject する。
3. Acceptance は grant を `approved` に進め、`approvedByActorId` と `approvedAt`
   を記録する。 kernel は approve 時点で acting Actor が target Space の
   Organization 上で `space-admin` を持つことを live RBAC view で検証し、 stale
   assignment を reject する。
4. Rejection は grant を `rejected` に進め、`rejectedByActorId` と `rejectedAt`
   を記録する。

`read-write` grant の承認は顧客 admin の明示同意を要求する: 承認 payload
は明示的な `acceptScope: "read-write"` field を運ぶ。 承認 payload が
`read-only` しか運ばない場合、kernel は `read-write` grant を reject する。

## Impersonation session

session は承認された grant の下で発行される runtime token。

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

- default scope は `read-only`。 `read-only` session は live RBAC view
  が認可した任意の Space-read endpoint を invoke できる。 write surface は
  session token を reject する。
- `read-write` session は parent grant が `read-write` であることを要求する。 各
  write action は自身の audit event に加えて
  `support-impersonation-write-action-recorded` audit event を emit する。
- session token は他 Space の scope に交換できない。 grant が mid-session
  で終了すると、それが所有する全 session が終了する。

## Rate limit and active-session caps

kernel は過度に広い impersonation を防ぐため、上限を強制する。

- Space ごとの同時 `approved` grant の最大数 (operator-tunable, default
  3)。超過した grant request は reject。
- Space ごとの同時 active session の最大数 (operator-tunable, default
  2)。超過した session open は reject。
- support-staff Actor ごとの全 Space 横断の同時 active session の最大数
  (operator-tunable, default 5)。

上限到達は `severity: warning` の audit signal を emit する。 operator が tune
できる window 内での上限到達の繰り返しは
[Incident Model](/reference/incident-model) auto 検知 path の trigger family
となる: 拒否された grant request や session open のバーストが持続すると、
`support-impersonation-burst` family の下で incident が auto mint される。

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
`{grantId, sessionId, supportActorId, spaceId, scope, reason, endReason}`
を記録した payload を持つ (該当箇所のみ)。 audit chain は永続的: 終端の grant と
session は Space の compliance regime ([Audit Events](/reference/audit-events)
参照) のもと audit store に残る。 顧客 admin はこれらの event を、kernel が
Space scope の任意の event 向けに公開する同じ audit query で読み取る。

## Operator-only endpoints

operator は HMAC で gate された内部 control plane を通じて操作する
([Kernel HTTP API](/reference/kernel-http-api) 参照)。

- `POST /api/internal/v1/support/impersonations` — operator が grant を生成。
  Body: `supportActorId`、`spaceId`、`scope`、`reason`、optional `ticketRef`、
  operator max 内で bound された optional `expiresAt` override。
- `DELETE /api/internal/v1/support/impersonations/:id` — operator
  がキャンセルまたは revoke。 `requested` なら `rejected`、`approved` なら
  `revoked` に set。
- `GET /api/internal/v1/support/impersonations` —
  `state`、`spaceId`、`supportActorId`、time window で filter した list。

customer self-service plane は、顧客 admin 向けの approval / revoke endpoint
を公開する。

- `POST /v1/impersonations/:id/accept` — 顧客 admin が承認。 body は要求 scope
  の確認 `acceptScope` を運ぶ。
- `POST /v1/impersonations/:id/reject` — 顧客 admin が rejection。
- `DELETE /v1/impersonations/:id` — 顧客 admin が approved grant を revoke
  (所有する全 session を終了)。

customer self-service plane は他の Space admin 操作と同じ RBAC 強制を使う。
呼び出し時点で target Organization に対して `space-admin` を保持していない Actor
からの上記すべてを kernel は reject する。

## Storage schema

support impersonation は [Storage Schema](/reference/storage-schema) を 2 つの
record class で拡張する。

| Record                        | Indexed by                                                                 | Persistence                              |
| ----------------------------- | -------------------------------------------------------------------------- | ---------------------------------------- |
| `SupportImpersonationGrant`   | `(id)`, `(spaceId, state)`, `(supportActorId, state)`, `(expiresAt)`       | Kept indefinitely under audit retention. |
| `SupportImpersonationSession` | `(id)`, `(grantId)`, `(spaceId, startedAt)`, `(supportActorId, startedAt)` | Kept indefinitely under audit retention. |

## Scope boundary

Takosumi kernel は support-staff actor 型、grant と session record、approval
フロー、scope / TTL 強制、rate limit、audit chain、上記の operator /
self-service endpoint を同梱する。 顧客 admin 通知 UI、 support-staff
ダッシュボード、 チケットトラッカー連携、 画面共有 / リモート制御ツール、
support tenant の identity provisioning、 read-only redacted view の描画は
**Takosumi の scope 外** であり、 operator の外側スタック (例: `takos-private/`
や別の PaaS provider front end) が実装する。 kernel はそれら外側 surface
が組み立てに使う auth モデルと audit primitive を公開する。

## Related architecture notes

- `docs/reference/architecture/operator-boundaries.md` — human / service-account
  Actor とは別 trust 境界としての support-staff actor。
- `docs/reference/architecture/policy-risk-approval-error-model.md` — read-write
  consent rule が参照する approval semantics。
- `docs/reference/architecture/space-model.md` — customer-self-service approval
  flow が参照する Space-admin role binding。

## 関連ページ

- [Actor / Organization Model](/reference/actor-organization-model)
- [Audit Events](/reference/audit-events)
- [Kernel HTTP API](/reference/kernel-http-api)
- [Storage Schema](/reference/storage-schema)
- [Incident Model](/reference/incident-model)
- [Resource IDs](/reference/resource-ids)
