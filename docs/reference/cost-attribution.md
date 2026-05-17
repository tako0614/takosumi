# Cost Attribution

> このページでわかること: リソースコストの帰属先ルール。

v1 cost-attribution メタデータ surface を定義する。 kernel は各 Space
に自由形式の **operator 管理メタデータマップ** を公開し、その map を audit event
と telemetry label を通じて伝播する。 これにより外部 billing パイプラインが
kernel の usage signal を operator 定義の会計軸 (cost center、project
code、customer segment、ad-hoc label) に join できる。 kernel は billing
engine、invoice surface、price book、attribution key
の意味についての意見を同梱しない。

::: info Current HTTP status cost attribution field は model / service contract
field。 現行 kernel HTTP router は `PATCH /api/internal/v1/spaces/:id` や
`GET /api/internal/v1/spaces?costCenter=...` 等の filter を mount していない。
[Kernel HTTP API — Internal control plane routes](/reference/kernel-http-api#internal-control-plane-routes)
参照。 :::

## Attribution metadata model

各 Space は optional な `attribution` map を持つ。

| Field             | Type                | Required | Notes                                                                               |
| ----------------- | ------------------- | -------- | ----------------------------------------------------------------------------------- |
| `costCenter`      | string              | no       | Operator-defined cost center identifier.                                            |
| `projectCode`     | string              | no       | Operator-defined project or workstream code.                                        |
| `customerSegment` | string              | no       | Operator-defined segment label (for example `enterprise`, `internal`, `community`). |
| `customLabels`    | map<string, string> | no       | Free-form labels keyed by operator-controlled name.                                 |

4 field はいずれも optional。 kernel
は値を導出せず、値を要求せず、語彙を強制しない。 kernel から見ると、どの値も
opaque な文字列。

operator distribution が kernel 上に Organization を公開するとき、
同じモデルが組織スコープにも適用される: Organization record は同じ `attribution`
形を持ち、 組織内の Space は何も自動継承しない。 組織レベル attribution を
provisioning 時に Space record にミラーするかは operator distribution が決める。

## Storage

attribution メタデータは [Storage Schema](/reference/storage-schema) に整合し、
Space record 上に map field として永続化される。 `customLabels` の key は
verbatim に保存される。 kernel は lower-case 化も正規化もしない。 安定した label
namespace が欲しい operator は prefix convention (例:
`cc:engineering`、`segment:enterprise`) を採用し、 operator policy
層で適用する。

Per-key value caps:

- `costCenter`, `projectCode`, `customerSegment`: 128 characters.
- `customLabels` keys: 64 characters each, kebab-case ASCII or the reserved
  colon prefix shape `<namespace>:<value>`.
- `customLabels` values: 256 characters each.
- The whole map: 32 entries and 8 KiB serialised.

上限を超えた値は HTTP `400 Bad Request` で write 時に reject される。 kernel
は黙って切り詰めない。

## Update API

attribution は次の PATCH で更新する。

```text
PATCH /api/internal/v1/spaces/:id
{
  "attribution": {
    "costCenter": "cc:platform",
    "projectCode": "proj:payments-2026",
    "customerSegment": "enterprise",
    "customLabels": {
      "owner": "team-a",
      "billing-contact": "ar+platform@example.invalid"
    }
  }
}
```

更新 semantics:

- `PATCH` は `attribution` map 全体を置き換える。 partial mutation
  はサポートされない。 client は意図する map 全体を再送する。 これは kernel
  の明示的で replay-safe な state 遷移を好む姿勢に合致する。
- field を `null` にセットするとそのフィールドが削除される。 `attribution`
  自体を `null` にセットすると map 全体がクリアされる。
- kernel は **遡及意図を拒否する**: `PATCH` は patch commit timestamp 以降に
  emit されたすべての audit event と telemetry サンプルに適用される。 過去の
  audit row と telemetry サンプルは、emit 時点で現在だった attribution
  を保持する。 書き換え path は無い。

## Audit propagation

envelope が `spaceId` を持つすべての audit event
([Audit Events](/reference/audit-events) 参照) は、 Space の現在の `attribution`
snapshot を固定 key `attribution` 下で event payload に追加で持つ。 snapshot は
event 書込み時に取られ、 audit hash chain に流れる canonical bytes
の一部となる。

attribution の変更自体は次の event で追跡される。

- `space-attribution-changed` — payload に `spaceId`、以前の map、次の
  map、actor を運ぶ。

attribution は Space の compliance regime
([Compliance Retention](/reference/compliance-retention) 参照) が宣言する完全な
retention window の間、audit log に残る。 retention が audit row を drop
するとき attribution も一緒に drop される。 kernel は out-of-band な attribution
アーカイブを保持しない。

## Telemetry labels

[Telemetry / Metrics](/reference/telemetry-metrics) が定義する OTLP と
Prometheus exporter は、 attribution を Space scope のすべての metric / span に
resource 属性 / label として attach する。

```text
takosumi_space_id          required
takosumi_quota_tier_id     required
takosumi_cost_center       optional
takosumi_project_code      optional
takosumi_customer_segment  optional
```

`customLabels` map はデフォルトでは label として **emit されない**。 custom
label を export したい operator は `TAKOSUMI_TELEMETRY_ATTRIBUTION_PROMOTE`
環境変数で promote する。 この変数は metric label に promote する `customLabels`
key のカンマ区切りリストを取る。 kernel での観測 cardinality が operator が tune
できる `TAKOSUMI_TELEMETRY_ATTRIBUTION_MAX_CARDINALITY` (default `200`) を超える
key の promotion は reject される。

promote 済み key が閾値を超えたとき、 kernel は `severity: warning` の audit
event `telemetry-cardinality-warning` を emit し、 operator が閾値を上げるか key
を promote list から外すまでその key の promotion を停止する。

## Reporting query

- `GET /api/internal/v1/spaces?costCenter=cc:platform`
- `GET /api/internal/v1/spaces?customerSegment=enterprise`
- `GET /api/internal/v1/spaces?customLabel=owner:team-a`

kernel は一致する Space record を返す。
**集約、グルーピング、合計、チャート描画は scope 外**: operator
は下流パイプラインで audit log を query した Space 集合と join する。

## Privacy

attribution メタデータは各 surface の retention window 中、 audit log と
telemetry export に残る。 operator は個人識別情報を attribution
に入れない責任を負う。 kernel は PII classifier を実行せず、読み取り時に
attribution 値を redact しない。

規制 regime が適用される場合
([Compliance Retention](/reference/compliance-retention) 参照)、 operator policy
層は ingest 時に email / 電話番号 / その他 PII に見える値を持つ attribution
書込みを reject すべき。 kernel は policy がそこで動けるよう raw write path
を公開する。

## Operator boundary

本リファレンスは kernel 側 primitive を定義する: メタデータ field、update
API、audit 伝播、telemetry promotion contract。 **end-to-end な cost workflow**
— audit log を billing system に取り込み、 attribution を顧客 record に join
し、 price book 計算を実行し、 invoice を生成し、 cost-center
単位ダッシュボードを surface し、 外部会計システムと reconcile する — は
`takos-private/` のような operator distribution と operator が組む billing
パイプラインに住む。 kernel はメタデータ surface を同梱してそこで止まる。

## Related architecture notes

- `docs/reference/architecture/operator-boundaries.md` — attribution-tagged
  signal を consume する operator policy 層。
- `docs/reference/architecture/space-model.md` — attribution を所有する Space
  identity。
- `docs/reference/architecture/operation-plan-write-ahead-journal-model.md` —
  attribution snapshot を捕捉する audit emission point。

## 関連ページ

- [Storage Schema](/reference/storage-schema)
- [Audit Events](/reference/audit-events)
- [Telemetry / Metrics](/reference/telemetry-metrics)
- [Compliance Retention](/reference/compliance-retention)
- [Quota / Rate Limit](/reference/quota-rate-limit)
- [Quota Tiers](/reference/quota-tiers)
- [Kernel HTTP API](/reference/kernel-http-api)
- [Closed Enums](/reference/closed-enums)
