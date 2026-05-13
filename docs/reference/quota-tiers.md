# Quota Tiers

> このページでわかること: quota tier の定義と各 tier の制限値。

本リファレンスは v1 quota tier モデルを定義する。kernel は operator が Space に
attach する **tier 属性** を公開する。tier が resolve する dimensional cap は
operator 定義で、operator policy の中に完全に住む。kernel は price book、 free /
pro / enterprise ラダー、組み込みの商用 semantics を同梱しない。

## Tier model

quota tier は dimension cap の named bundle である。各 Space はちょうど 1 つの
`quotaTierId` を持つ。kernel が Space の quota dimension を評価するとき、Space
の tier record を通じて dimension cap を resolve し、
[Quota / Rate Limit](/reference/quota-rate-limit) で定義された fail-closed-for-
new-work / fail-open-for-inflight semantics を同様に適用する。

- `quotaTierId` is a string with the same kebab-case suffix grammar as other
  operator-controlled IDs (see [Resource IDs](/reference/resource-ids)). The
  suffix is operator-chosen, for example `tier:free`, `tier:pro`,
  `tier:internal`. The kernel does not interpret the suffix.
- The tier set is **flat in v1**: there is no inheritance, no parent tier, and
  no tier composition. Each Space resolves to one tier and one tier only.
- Tier records are persisted in the partition declared in
  [Storage Schema](/reference/storage-schema) and survive kernel restart,
  journal compaction, and restore from backup.

kernel は **default tier を同梱しない**。operator は bootstrap で少なくとも 1
つの tier を登録する。登録 tier がゼロの installation は boot 時に fail-closed
して Space provisioning を拒否する。

## Tier dimensions

A tier carries a cap for each dimension in the closed v1 quota set:

| Dimension                         | Source                                             |
| --------------------------------- | -------------------------------------------------- |
| `deployment-count`                | [Quota / Rate Limit](/reference/quota-rate-limit). |
| `active-object-count`             | [Quota / Rate Limit](/reference/quota-rate-limit). |
| `artifact-storage-bytes`          | [Quota / Rate Limit](/reference/quota-rate-limit). |
| `journal-volume-bytes-per-bucket` | [Quota / Rate Limit](/reference/quota-rate-limit). |
| `approval-pending-count`          | [Quota / Rate Limit](/reference/quota-rate-limit). |
| `cpu-milliseconds`                | Usage projection: `runtime.*_milliseconds`.        |
| `storage-bytes`                   | Usage projection: `resource.storage_bytes`.        |
| `bandwidth-bytes`                 | Usage projection: `runtime.bandwidth_bytes`.       |

A tier may additionally declare per-tier rate-limit overrides for the public and
internal route classes. Rate-limit overrides are optional; when omitted, the
Space resolves to the kernel-wide defaults from `TAKOSUMI_RATE_LIMIT_*`.

embedded / self-hosted deployment が使うサービスレベルの `LocalUsageQuotaPolicy`
は、usage が記録される前にこれら 3 つの usage dimension を Space ごとに resolve
する。`UsageProjectionService.requireWithinQuota()` は tier cap を超える
projected counter を reject するので、CPU / storage / bandwidth gate は下流の
billing projection や provider スケジューリングの前に fail-closed できる。

A cap value of the literal string `unlimited` means the tier removes the cap for
that dimension. A cap of `0` is rejected at registration time.

## Tier registration API

tier 登録は内部 HTTP surface 経由で行う
([Kernel HTTP API](/reference/kernel-http-api) 参照)。

`POST /api/internal/v1/quota-tiers`

Request body:

```json
{
  "tierId": "tier:pro",
  "dimensions": {
    "deploymentCount": 100,
    "activeObjectCount": 1000,
    "artifactStorageBytes": 107374182400,
    "journalVolumeBytesPerBucket": 1073741824,
    "approvalPendingCount": 50,
    "spaceExportShareCount": 25
  },
  "rateLimitOverrides": {
    "publicPerSpaceRps": 30,
    "internalPerSpaceRps": 90
  }
}
```

Response:

```json
{ "tierId": "tier:pro", "createdAt": "2026-05-05T00:00:00.000Z" }
```

Other endpoints:

- `GET /api/internal/v1/quota-tiers` lists every registered tier.
- `GET /api/internal/v1/quota-tiers/:tierId` returns one tier.
- `PATCH /api/internal/v1/quota-tiers/:tierId` updates the dimension caps or the
  rate-limit overrides. The `tierId` field is immutable.
- `DELETE /api/internal/v1/quota-tiers/:tierId` removes a tier. The kernel
  rejects deletion when any Space still references the tier; operators migrate
  every referencing Space to another tier first.

All four mutating calls fail closed when the caller's auth context is not in the
operator role.

## Tier assignment to Space

A Space carries a `quotaTierId` field. The field is required at Space
provisioning: a Space cannot exist without a resolved tier.

- Initial assignment happens at Space creation; the request must reference an
  already-registered `tierId`.
- Reassignment uses
  `PATCH /api/internal/v1/spaces/:id { "quotaTierId": "tier:..." }`.
- The kernel applies the new tier on the next quota evaluation; it does not
  retroactively rewrite past audit counters or past ActivationSnapshots.
- Reassignment that lowers a cap below the Space's current usage does not roll
  back inflight work. New work that would push the Space past the new cap fails
  closed under the standard quota path.

## Bootstrap requirement

bootstrap protocol ([Bootstrap Protocol](/reference/bootstrap-protocol) 参照)
は、 kernel が Space provisioning を受け付ける前に operator が少なくとも 1 つの
tier を登録することを要求する。慣習として `tier:default` を登録し、operator が
追加 tier を導入するまですべての Space をこれに bind する。suffix は強制
されず、operator は任意の kebab-case 名を選べる。

`TAKOSUMI_QUOTA_TIER_BOOTSTRAP_REQUIRED` (default `true`) controls the boot-time
check. Disabling it is permitted for local-mode operator testing only and is
rejected at boot in `production`.

## Audit events

Tier lifecycle emits the following audit events (see
[Audit Events](/reference/audit-events)):

- `quota-tier-registered` — payload carries `tierId` and the full dimension and
  rate-limit cap snapshot.
- `quota-tier-updated` — payload carries `tierId`, the previous cap snapshot,
  and the new cap snapshot.
- `quota-tier-removed` — payload carries `tierId` and the cap snapshot at
  removal time.
- `space-tier-changed` — payload carries `spaceId`, `previousTierId`,
  `nextTierId`, and the actor that performed the change.

Tier-level events carry a null `spaceId`; `space-tier-changed` carries the
affected Space.

## Storage

Tier records persist as a dedicated record class consistent with
[Storage Schema](/reference/storage-schema):

| Field                | Type      | Required | Notes                                         |
| -------------------- | --------- | -------- | --------------------------------------------- |
| `tierId`             | string    | yes      | Operator-controlled kebab-case ID. Immutable. |
| `dimensions`         | object    | yes      | Map of dimension name to cap.                 |
| `rateLimitOverrides` | object    | no       | Optional rate-limit override map.             |
| `createdAt`          | timestamp | yes      | Set on registration.                          |
| `updatedAt`          | timestamp | yes      | Updated on every `PATCH`.                     |

Space record は `quotaTierId` を外部参照として持つ。quota counter 自体は Space
record に残る。tier は counter と比較される cap を供給するだけである。

## Operator boundary

本リファレンスは kernel 側 primitive を定義する: tier モデル、登録 API、
割り当て surface、audit 形。tier を顧客プランに結びつける **商用 semantics** —
任意通貨での価格設定、契約条項、督促 policy、free-to-paid アップグレードフロー、
tier 比較のダッシュボード描画、tier 認識の billing export — は `takos-private/`
のような operator distribution と kernel audit log を consume するサードパー
ティ billing システムに住む。kernel はこれらの概念を一切エンコードしない。

## Related architecture notes

- `docs/reference/architecture/operator-boundaries.md` — operator policy layer
  that consumes tier-resolved quota signals.
- `docs/reference/architecture/space-model.md` — Space identity that scopes tier
  assignment.
- `docs/reference/architecture/operation-plan-write-ahead-journal-model.md` —
  quota evaluation point against tier-resolved caps.

## 関連ページ

- [Quota / Rate Limit](/reference/quota-rate-limit)
- [Storage Schema](/reference/storage-schema)
- [Audit Events](/reference/audit-events)
- [Kernel HTTP API](/reference/kernel-http-api)
- [Environment Variables](/reference/env-vars)
- [Resource IDs](/reference/resource-ids)
