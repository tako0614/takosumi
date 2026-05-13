# Tenant Provisioning

> このページでわかること: テナントのプロビジョニングフロー。

Takosumi v1 における tenant onboarding の kernel-side primitive。 本 reference
は **Space** を tenant unit とし、Space を新規に立ち上げる ための internal
API、provisioning の closed v1 段階、idempotency と rollback、初期
state、organization membership との分離、rate limit、audit event を固定する。本
reference が定めるのは kernel surface のみで、顧客 向け signup UI / payment 確認
/ TOS 同意 flow は扱わない。

::: info Current HTTP status This reference describes the full tenant
provisioning spec surface. The current kernel HTTP router mounts
`GET /api/internal/v1/spaces` and `POST /api/internal/v1/spaces`, but the
current `POST` body is the lightweight Space-create shape documented in
[Kernel HTTP API — Internal control plane routes](/reference/kernel-http-api#internal-control-plane-routes),
not the full provisioning request below. `GET /api/internal/v1/spaces/:id` and

## Tenant の単位

tenant 単位は **Space** で、Space は単一の **Organization** に所属する。

- `space:<id>` は kernel 内で resource ID として使われる識別子で、形式は
  [Resource IDs](/reference/resource-ids) に従う。
- 1 つの Organization は複数の Space を保有できるが、Space は同時に 複数の
  Organization に属さない。
- Space は quota / audit chain / secret partition / observation set の 独立 unit
  RFC vocabulary。

owner Organization は provisioning 時に確定する。Org membership 自体の 編集は別
internal API で扱い、本 reference の範囲外。

## Provisioning API (target contract)

operator-only の internal control plane。caller は
[Kernel HTTP API](/reference/kernel-http-api) の internal HMAC credential を
保持する。

### `POST /api/internal/v1/spaces`

Request body:

```ts
interface SpaceProvisionRequest {
  readonly spaceId: string; // "space:<id>" 形式 (operator が allocate)
  readonly organizationId: string; // 所属 Org の resource ID
  readonly profile: SpaceProfile; // displayName / locale / timezone 等の Space metadata
  readonly initialCatalogReleaseId: string; // adopt する CatalogRelease
  readonly quotaTierId: string; // 適用する quota tier
  readonly metadata?: Record<string, string>;
  readonly mode?: "sync" | "async"; // default: "async"
}
```

Response:

```ts
interface SpaceProvisionResponse {
  readonly spaceId: string;
  readonly status: "provisioned" | "in-progress" | "operator-action-required";
  readonly createdAt: string; // RFC 3339 UTC
  readonly defaultActor: {
    readonly actorId: string;
    readonly tokenId: string;
    readonly bootstrapToken: string; // single-use, short TTL
  };
  readonly progress?: {
    readonly stage: ProvisioningStage;
    readonly message?: string;
  };
}
```

`mode: "sync"` は小規模 Space 向けで、API 呼び出しの間に全段階を完走する。
`mode: "async"` は大規模 Space (大量の CatalogRelease object adopt 等) を
想定し、`status: "in-progress"` を返したうえで `GET /api/internal/v1/spaces/:id`
で polling する。

`Idempotency-Key` header は **必須**。同じ key の再送は同じ response を
返す。新しい key で同じ `spaceId` を二重 provisioning すると、kernel は 既存
Space と一致するなら同じ response を返し、不一致なら HTTP `409
Conflict` で
reject する。

### `GET /api/internal/v1/spaces/:id`

provisioning status / current quota tier / current CatalogRelease / observation
set summary を返す。`mode: "async"` の polling 用 endpoint。

## Provisioning 段階 (closed v1)

provisioning は以下の段階を **この順序** で実行する。新段階の追加は
`CONVENTIONS.md` §6 RFC を要する。

| # | Stage                          | Effect                                                    |
| - | ------------------------------ | --------------------------------------------------------- |
| 1 | `namespace-partition-allocate` | storage-schema 上の Space partition を allocate。         |
| 2 | `secret-partition-init`        | secret partition を初期化、master key を derive。         |
| 3 | `quota-tier-apply`             | quotaTierId の caps を Space に attach。                  |
| 4 | `catalog-release-adopt`        | initialCatalogReleaseId を Space に adopt。               |
| 5 | `default-operator-account`     | default operator account を生成、bootstrap token を発行。 |
| 6 | `audit-chain-genesis`          | per-Space audit chain の genesis event を書く。           |
| 7 | `observation-set-init`         | observation 集計 store の Space スコープを初期化。        |

各段階は **idempotent** に再試行できる。kernel は段階単位の completion record
を保持し、再試行は未完了段階から再開する。段階 1 と 2 は
[Storage Schema](/reference/storage-schema) と
[Secret Partitions](/reference/secret-partitions) に従う。段階 3 は
[Quota and Rate Limit](/reference/quota-rate-limit) の closed dimension に caps
を attach する。段階 4 は
[Catalog Release Trust](/reference/catalog-release-trust) の adopt semantics
に従う。

## Provisioning 失敗時の rollback

任意段階で恒久的失敗が確定したら、kernel は完了済み段階を **逆順** で rollback
する。

- rollback も idempotent で、失敗中に再呼び出されても安全に進む。
- すべての段階を rollback できた場合、Space は kernel state に残らない。
- rollback の途中で更なる失敗が起きた場合、Space は
  `status: operator-action-required` で hold され、provisioning audit event
  に部分失敗の段階が記録される。operator の手動介入で前進または完全 rollback
  を選ぶ。

partial-failure の Space は read-only で、新規 deployment / activation / share
issuance はすべて denied。

## Initial state

provisioning 完走直後の Space は以下の state を持つ。

- GroupHead は `idle`。manifest が apply されるまで動く workload はない。
- quota usage は全 dimension で 0。
- audit chain は genesis event のみで、`prevHash` は zero hash。
- approval queue / RevokeDebt queue は空。cross-Space share state は reserved /
- observation set は initialized だが metric は未到着。
- default operator account は権限を持つ唯一の actor。bootstrap token は
  single-use で、初回 sign-in 後は通常 token に置き換わる。
- Catalog adopt 段階で取り込まれた release manifest が adoption record
  として残る。adopted release の version は audit event の payload で
  確認できる。

initial state は以後の `desired-recorded` / `resolution-recorded` event の
baseline になる。最初の deployment が apply されるまで、Space に対する
read-mostly な status query は すべて空集合を返す。

## Organization membership 連動

Space provisioning は owner Organization 確定までを担当する。

- owner Org は `organizationId` で固定し、後から変更しない (transfer は 別
  API)。
- Org member の Space への role 付与は別 internal API で行い、provisioning API
  は default operator account 1 件しか作らない。
- Org が存在しない / aware ではない `organizationId` は HTTP `409 Conflict` で
  reject される。

## Provisioning rate limit

provisioning は新 Space を生む high-impact 操作なので、独立した rate limit
を持つ。詳細は [Quota and Rate Limit](/reference/quota-rate-limit) の internal
route カテゴリに従い、本 endpoint には以下の追加 cap が当たる。

- **per-Org**: 同一 Org 内での provisioning 件数 / 時間。
- **per-actor**: 呼び出し HMAC actor あたりの件数 / 時間。
- **global**: kernel 全体での provisioning 件数 / 時間。

cap を超えた呼び出しは HTTP `429 Too Many Requests` で reject される。
provisioning rate limit は読み取り系と独立で、`GET /api/internal/v1/spaces/:id`
は別 bucket。

それぞれの cap は以下の env で operator が設定する。unset は cap 無し。

| Variable                                        | Notes                        |
| ----------------------------------------------- | ---------------------------- |
| `TAKOSUMI_PROVISIONING_RATE_PER_ORG_PER_HOUR`   | per-Org 1 時間あたり件数。   |
| `TAKOSUMI_PROVISIONING_RATE_PER_ACTOR_PER_HOUR` | per-actor 1 時間あたり件数。 |
| `TAKOSUMI_PROVISIONING_RATE_GLOBAL_PER_MINUTE`  | kernel 全体 1 分あたり件数。 |

short window (per-minute) と long window (per-hour) を組合せ、burst と sustained
の両方を guard する設計。short window 単独で reject された 場合の `Retry-After`
は短く、long window で reject された場合は長くなる。

## Audit events

provisioning lifecycle の audit event は [Audit Events](/reference/audit-events)
の closed enum に追加する。

- `space-provisioned` — provisioning が `status: provisioned` で完走。
- `space-provisioning-failed` — rollback 完走後、または
  `operator-action-required` 状態に固定したとき。
- `catalog-release-adopted` — 段階 4 で CatalogRelease が adopt された
  瞬間。Space が独立の adopt 操作を行ったときも同じ event を共有する。

各 event payload は `spaceId` / `organizationId` / `quotaTierId` /
`initialCatalogReleaseId` / 失敗時は `failedStage` を保持する。

provisioning 中の段階単位の中間 event は v1 では emit しない。これは
provisioning が高頻度操作ではなく、段階別の状況は status endpoint の polling
で十分観測できるため。段階 fail-and-retry の trace を operator が
必要とした場合は、kernel の structured log
([Logging Conventions](/reference/logging-conventions)) を参照する。

## Status query

`GET /api/internal/v1/spaces/:id` は以下の field を返す。

| Field              | Notes                                                |
| ------------------ | ---------------------------------------------------- |
| `spaceId`          | resource ID。                                        |
| `organizationId`   | owner Org の resource ID。                           |
| `provisioning`     | `status` / `currentStage` / `failedStage` (該当時)。 |
| `quotaTierId`      | 現在適用中の quota tier。                            |
| `catalogReleaseId` | 現在 adopt 中の CatalogRelease。                     |
| `audit`            | `chainHead` / `genesisAt`。                          |
| `metadata`         | provisioning 時に渡された metadata。                 |

provisioning が `in-progress` の Space は `audit.chainHead` が genesis event
に固定される。`provisioned` 確定後に initial state 内で発火した event があれば
head は前進する。

## Invariants

- tenant unit は Space で、Space は単一 Org に所属する。
- provisioning は closed 7 段階を順序実行し、各段階は idempotent。
- 失敗時は逆順 rollback、部分失敗は `operator-action-required` で hold。
- `Idempotency-Key` header は必須で、同 key の再送は同 response を返す。
- provisioning rate limit は per-Org / per-actor / global の 3 scope。

## kernel 範囲と外側の境界

本 reference は Space onboarding に必要な kernel-side primitive のみを
定義する。顧客向け signup form、payment 確認、TOS 同意 UI、organization
billing、support escalation、welcome email 等の顧客 onboarding flow は takosumi
の範囲外で、operator が `takos-private/` 等の外側で実装する。 takosumi kernel は
idempotent な internal API、closed provisioning 段階、 audit primitive
を提供することに専念する。

## Related architecture notes

- `docs/reference/architecture/space-model.md` — Space を tenant boundary
  として固定する rationale と Org membership の分離議論
- `docs/reference/architecture/operator-boundaries.md` — kernel が公開する
  provisioning primitive と operator policy 層の責務分担
- `docs/reference/architecture/catalog-release-descriptor-model.md` —
  initialCatalogReleaseId adopt 段階の semantics と再試行設計

## 関連ページ

- [Storage Schema](/reference/storage-schema)
- [Audit Events](/reference/audit-events)
- [Quota and Rate Limit](/reference/quota-rate-limit)
- [Secret Partitions](/reference/secret-partitions)
- [Resource IDs](/reference/resource-ids)
- [Kernel HTTP API](/reference/kernel-http-api)
- [Catalog Release Trust](/reference/catalog-release-trust)
