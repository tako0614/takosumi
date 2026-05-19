# Zone Selection

> このページでわかること: deploy 先 zone の選択ロジック。

v1 zone 属性を定義する。 kernel は zone を **operator 定義の文字列**
として扱い、 Space / Object / DataAsset / Connector scope
のメタデータとして付加し、 manifest 展開、drift detection、audit log
を通じて伝播する。 kernel は topology graph、latency テーブル、zone pricing
モデルを所有しない。

## Single-region invariant

Takosumi v1 installation のすべての zone は **1 region** に住む。 kernel はこの
invariant を強制する: region 間 link は v1 の scope 外。 複数 region
にまたがりたい operator distribution は将来の multi-region account-plane /
operator RFC として扱う必要がある。 region ごとに 1 つの Takosumi installation
を動かしてもプラットフォーム federation は作られず、 それら installation
は独立したままである。

region 間 semantics の追加 (multi-region 書込み、region failover、geo-routing)
は `CONVENTIONS.md` §6 RFC を要する。

## Zone model

zone は operator 管理 ID と同じ suffix 文法を持つ kebab-case ASCII 文字列
([Resource IDs](/reference/resource-ids) 参照)。 例:
`az-1a`、`az-1b`、`rack-c`。 kernel は値を解釈しない: 似た名前の 2 つの zone
は無関係で、 kernel は文字列形から隣接性や距離を推論しない。

operator は環境変数で、認識する zone 集合を publish する。

```text
TAKOSUMI_ZONES_AVAILABLE   comma-separated list, e.g. "az-1a,az-1b,az-1c"
TAKOSUMI_ZONE_DEFAULT      one of TAKOSUMI_ZONES_AVAILABLE; required when
                           TAKOSUMI_ZONES_AVAILABLE is set
```

`TAKOSUMI_ZONES_AVAILABLE` を空でない list に設定すると zone
チェックが有効化される。 未設定なら kernel は zone-agnostic のままで、 その mode
では下記の zone field は評価時に黙って無視される。

zone チェックが有効なとき、 Space / Object / DataAsset / Connector scope
のすべての zone 値は `TAKOSUMI_ZONES_AVAILABLE` のメンバーでなければならない。
未知 zone は書込み時に HTTP `400 Bad Request` で reject される。

## Zone attribute

zone は 4 つの scope に付加される。

| Scope     | Field            | Notes                                                         |
| --------- | ---------------- | ------------------------------------------------------------- |
| Space     | `defaultZone`    | Default zone for objects in the Space.                        |
| Object    | `zone`           | Object-level override. Falls back to the Space `defaultZone`. |
| DataAsset | `zonePreference` | Soft preference for asset placement.                          |
| Connector | `zonePreference` | Soft preference for connector binding.                        |

`zone` は拘束的: connector は binding context で resolved zone を受け取り、
それに応じて resource を配置しなければならない。 `zonePreference` は助言的:
connector は基底 provider が zone hint をサポートする場合に値を参照し、 provider
が preference を尊重できないときには audit signal を発行する。

Space record は `defaultZone` を永続化する。 Object / DataAsset / Connector
record はそれぞれの zone field を [Storage Schema](/reference/storage-schema)
に従って永続化する。

## AppSpec boundary

current AppSpec は zone placeholder や cross-Space zone reference を持たない。
zone は Space default、operator policy、provider binding context
から解決される。

component kind spec で `zoneAware: true` を宣言する target descriptor は、
binding context で resolved zone 文字列を受け取る。 zone awareness を宣言しない
descriptor はこの field を無視する。 kernel は強制も drop もしない。

## Cross-zone link policy

同じ Space 内の 2 つの object の resolved zone が異なる link は **cross-zone
link**。 default policy は `allow-with-warning`。

- kernel は `severity: notice` の `cross-zone-link-warning` audit event を emit
  し、 link ID、consumer zone、producer zone、Space ID を運ぶ。
- link 自体は生成され、deployment は進む。

policy は `TAKOSUMI_CROSS_ZONE_LINK_POLICY` で operator が tune できる。

| Value                | Effect                                                     |
| -------------------- | ---------------------------------------------------------- |
| `allow`              | Permit cross-zone links silently; no audit event.          |
| `allow-with-warning` | Default. Permit and emit `notice`.                         |
| `deny`               | Reject the deployment with `errorCode: cross_zone_denied`. |

policy は kernel-global に適用される。 Space 単位の policy 上書きは
`CONVENTIONS.md` §6 RFC を要する。

## Failover signal

zone failure は **signal surface** であり、kernel 駆動の failover 機構ではない。
kernel は autonomous に object を zone 間で移動しない。

- zone-down 状態を検知した connector (provider API が zone
  固有失敗を返す、または probe が 1 zone 内で連続失敗する) は
  `zone-failure-observed` を drift detection に emit する
  ([Drift Detection](/reference/drift-detection) 参照)。 drift event は zone
  文字列と影響を受けた object ID を運ぶ。
- zone-failure 観測後に build される次の ActivationSnapshot は、 影響を受けた各
  object に `zoneFailure: { zone: "...", observedAt: ... }` annotation を持つ。
  annotation は informational で、snapshot は引き続き生成される。
- 復旧は対称: connector は `zone-recovery-observed` を emit し、次の
  ActivationSnapshot は annotation を drop する。

operator distribution が signal をどう扱うか (外部 LB の failover、
顧客トラフィックのリダイレクト、 desired manifest の再形成、
ステータスページへの投稿) は kernel の外に住む。 kernel の仕事は signal を
observable で durable にすること。

## Audit events

zone 関連の audit event ([Audit Events](/reference/audit-events) 参照):

- `cross-zone-link-warning` — `allow-with-warning` 下の cross-zone link 生成で
  emit。severity `notice`。
- `zone-failure-observed` — connector 報告の zone failure で emit。severity
  `warning`。
- `zone-recovery-observed` — connector 報告の zone recovery で emit。severity
  `notice`。
- `space-default-zone-changed` — Space `defaultZone` の更新で emit。severity
  `info`。payload に変更前後の zone と actor。

`zone-failure-observed` と `zone-recovery-observed` は Space ID と zone
文字列の両方を運ぶ。 kernel-global zone failure (すべての Space に影響) は
`spaceId` を順次各 Space に設定して event を発行する。 kernel はこれらを単一
event にまとめないので、下流 consumer が正しく attribute できる。

## Storage

zone field は [Storage Schema](/reference/storage-schema) に整合する既存 record
class 上に永続化される。

| Record             | Field             | Required | Notes                                            |
| ------------------ | ----------------- | -------- | ------------------------------------------------ |
| Space              | `defaultZone`     | no       | Required when `TAKOSUMI_ZONES_AVAILABLE` is set. |
| Object             | `zone`            | no       | Falls back to Space `defaultZone`.               |
| DataAsset          | `zonePreference`  | no       | Soft preference.                                 |
| Connector          | `zonePreference`  | no       | Soft preference.                                 |
| ActivationSnapshot | `zoneAnnotations` | no       | Map of object ID to `{ zone, zoneFailure? }`.    |

zone 値は ActivationSnapshot の中で immutable — snapshot は activation 時に zone
を凍結し、履歴分析の canonical record となる。

## Operator boundary

本リファレンスは kernel 側 primitive を定義する: zone 属性、manifest と snapshot
を通じた伝播、cross-zone link policy、failure / recovery signal。 **顧客可視の
zone 製品** — 顧客ダッシュボードでの zone セレクタ、 latency
テーブルと推奨コピー、 災害復旧プレイブック、 zone outage
を説明する公開ステータス copy、 zone availability
を商用コミットメントに結びつける契約文言 — は `takos-private/` のような operator
distribution に住む。 kernel は属性と audit signal を同梱してそこで止まる。

## Related architecture notes

- `docs/reference/architecture/operator-boundaries.md` — zone signal で動く
  operator policy 層。
- `docs/reference/architecture/exposure-activation-model.md` — zone annotation
  を持つ ActivationSnapshot shape。
- `docs/reference/architecture/space-model.md` — `defaultZone` を所有する Space
  identity。

## 関連ページ

- [Storage Schema](/reference/storage-schema)
- [Audit Events](/reference/audit-events)
- [Connector Contract](/reference/connector-contract)
- [Manifest — Expand Semantics](/reference/manifest#expand-semantics)
- [Drift Detection](/reference/drift-detection)
- [Environment Variables](/reference/env-vars)
- [Resource IDs](/reference/resource-ids)
