# Quota Tiers

> このページでわかること: quota tier の定義と各 tier の制限値。

v1 quota tier モデルを定義する。 kernel は operator が Space に attach する
**tier 属性** を公開する。 tier が resolve する dimensional cap は operator
定義で、operator policy の中に完全に住む。 kernel は price book、 free / pro /
enterprise ラダー、 組み込みの商用 semantics を同梱しない。

## Tier model

quota tier は dimension cap の named bundle。 各 Space はちょうど 1 つの
`quotaTierId` を持つ。 kernel が Space の quota dimension を評価するとき、 Space
の tier record を通じて dimension cap を resolve し、
[Quota / Rate Limit](./quota-rate-limit.md) で定義された
fail-closed-for-new-work / fail-open-for-inflight semantics を同様に適用する。

- `quotaTierId` は operator-controlled ID と同じ kebab-case suffix
  文法を持つ文字列 ([Resource IDs](./resource-ids.md) 参照)。 suffix は operator
  が選ぶ (例: `tier:free`、`tier:pro`、`tier:internal`)。 kernel は suffix
  を解釈しない。
- v1 で tier 集合は **flat**: 継承、parent tier、tier composition は無い。 各
  Space は 1 つの tier に resolve する。
- Tier record の永続化先は [Storage Schema](./storage-schema.md) で宣言される
  partition。 kernel restart、journal compaction、restore from backup の across
  で生存する。

kernel は **default tier を同梱しない**。 operator は bootstrap で少なくとも 1
つの tier を登録する。 登録 tier が 0 の installation は boot 時に fail-closed
し、Space provisioning を拒否する。

## Tier dimensions

tier は v1 closed quota set の各 dimension について cap を持つ。

| Dimension                         | Source                                       |
| --------------------------------- | -------------------------------------------- |
| `deployment-count`                | [Quota / Rate Limit](./quota-rate-limit.md). |
| `active-object-count`             | [Quota / Rate Limit](./quota-rate-limit.md). |
| `artifact-storage-bytes`          | [Quota / Rate Limit](./quota-rate-limit.md). |
| `journal-volume-bytes-per-bucket` | [Quota / Rate Limit](./quota-rate-limit.md). |
| `approval-pending-count`          | [Quota / Rate Limit](./quota-rate-limit.md). |
| `cpu-milliseconds`                | Usage projection: `runtime.*_milliseconds`.  |
| `storage-bytes`                   | Usage projection: `resource.storage_bytes`.  |
| `bandwidth-bytes`                 | Usage projection: `runtime.bandwidth_bytes`. |

tier は public / internal route class 単位の per-tier rate-limit
上書きも追加で宣言できる。 上書きは optional。省略時は `TAKOSUMI_RATE_LIMIT_*`
の kernel-wide default が Space に適用される。

embedded / self-hosted deployment が使う `LocalUsageQuotaPolicy` サービスは、
usage が記録される前に上記 3 つの usage dimension を Space ごとに resolve する。
`UsageProjectionService.requireWithinQuota()` は tier cap を超える projected
counter を reject するので、 CPU / storage / bandwidth gate は下流の billing
projection や provider スケジューリングの前に fail-closed できる。

cap 値が literal string `unlimited` のときはその dimension の cap を外す。 cap
`0` は登録時点で reject される。

## Tier registration API

tier 登録は内部 HTTP surface 経由 ([Kernel HTTP API](./kernel-http-api.md)
参照)。

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

その他の endpoint:

- `GET /api/internal/v1/quota-tiers` — 登録済み tier の一覧。
- `GET /api/internal/v1/quota-tiers/:tierId` — 単一 tier。
- `PATCH /api/internal/v1/quota-tiers/:tierId` — dimension cap または rate-limit
  override を更新。`tierId` は immutable。
- `DELETE /api/internal/v1/quota-tiers/:tierId` — tier を削除。 いずれかの Space
  がその tier を参照していると kernel は削除を reject する。 operator は先に全
  referencing Space を別 tier に移行する。

4 つの mutating call はいずれも、 caller の auth context が operator role
でないと fail closed する。

## Tier assignment to Space

Space は `quotaTierId` field を持つ。 Space provisioning 時点で必須: tier が
resolve しない Space は存在できない。

- 初回割り当ては Space 生成時。 request は登録済みの `tierId` を参照する。
- 再割り当ては
  `PATCH /api/internal/v1/spaces/:id { "quotaTierId": "tier:..." }`。
- kernel は次回の quota 評価から新 tier を適用する。 過去の audit counter や
  ActivationSnapshot は retroactive に書き換えない。
- cap を Space の現在使用量より下げる再割り当てでも inflight work は rollback
  されない。 新 cap を越える new work は標準の quota path で fail close する。

## Bootstrap requirement

bootstrap protocol ([Bootstrap Protocol](./bootstrap-protocol.md) 参照) は、
kernel が Space provisioning を受け付ける前に operator が少なくとも 1 つの tier
を登録することを要求する。 慣習として `tier:default` を登録し、 operator が追加
tier を導入するまですべての Space をこれに bind する。 suffix
は強制されず、operator は任意の kebab-case 名を選べる。

`TAKOSUMI_QUOTA_TIER_BOOTSTRAP_REQUIRED` (default `true`) が boot-time check
を制御する。 無効化は local-mode operator testing 限定で許容され、`production`
では boot で reject される。

## Audit events

Tier lifecycle が発行する audit event ([Audit Events](./audit-events.md) 参照):

- `quota-tier-registered` — `tierId` と全 dimension / rate-limit cap snapshot を
  payload に持つ。
- `quota-tier-updated` — `tierId`、変更前 cap snapshot、変更後 cap snapshot
  を運ぶ。
- `quota-tier-removed` — `tierId` と削除時点の cap snapshot を運ぶ。
- `space-tier-changed` — `spaceId`、`previousTierId`、`nextTierId`、変更を行った
  actor を運ぶ。

tier-level event は `spaceId` を null で運ぶ。`space-tier-changed`
は影響を受けた Space を運ぶ。

## Storage

Tier record は [Storage Schema](./storage-schema.md) と整合する専用 record class
として永続化される。

| Field                | Type      | Required | Notes                                         |
| -------------------- | --------- | -------- | --------------------------------------------- |
| `tierId`             | string    | yes      | Operator-controlled kebab-case ID. Immutable. |
| `dimensions`         | object    | yes      | Map of dimension name to cap.                 |
| `rateLimitOverrides` | object    | no       | Optional rate-limit override map.             |
| `createdAt`          | timestamp | yes      | Set on registration.                          |
| `updatedAt`          | timestamp | yes      | Updated on every `PATCH`.                     |

Space record は `quotaTierId` を外部参照として持つ。 quota counter 自体は Space
record に残る。 tier は counter と比較される cap を供給するだけ。

## Operator boundary

本リファレンスは kernel 側 primitive を定義する: tier モデル、登録 API、
割り当て surface、audit 形。 tier を顧客プランに結びつける **商用 semantics** —
任意通貨での価格設定、契約条項、督促 policy、free-to-paid アップグレードフロー、
tier 比較ダッシュボード描画、tier 認識の billing export — は `takos-private/`
のような operator distribution と kernel audit log を consume するサードパーティ
billing システムに住む。 kernel はこれらの概念を一切エンコードしない。

## Related architecture notes

- `docs/reference/architecture/operator-boundaries.md` — tier-resolved quota
  signal を consume する operator policy 層。
- `docs/reference/architecture/space-model.md` — tier assignment を scope する
  Space identity。
- `docs/reference/architecture/runtime-deployment-model.md#operation-plan--write-ahead-journal`
  — tier-resolved cap に対する quota evaluation point。

## 関連ページ

- [Quota / Rate Limit](./quota-rate-limit.md)
- [Storage Schema](./storage-schema.md)
- [Audit Events](./audit-events.md)
- [Kernel HTTP API](./kernel-http-api.md)
- [Environment Variables](./env-vars.md)
- [Resource IDs](./resource-ids.md)
