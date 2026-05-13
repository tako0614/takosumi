# Zone Selection

> このページでわかること: deploy 先 zone の選択ロジック。

本リファレンスは v1 zone 属性を定義する。kernel は zone を **operator
定義の文字列** として扱い、Space / Object / DataAsset / Connector scope
のメタデータとして付加し、manifest 展開、drift detection、audit log を
通じて伝播する。kernel は topology graph、latency テーブル、zone pricing
モデルを所有しない。

## Single-region invariant

Takosumi v1 installation のすべての zone は **1 region** に住む。kernel は この
invariant を強制する: region 間 link は v1 の scope 外である。複数 region
にまたがりたい operator distribution は将来の multi-region account-plane /
operator RFC として扱う必要がある。region ごとに 1 つの Takosumi installation を
動かしてもプラットフォーム federation は作られず、それら installation は独立
したままである。

region 間 semantics の追加 (multi-region 書込み、region failover、geo-routing)
は `CONVENTIONS.md` §6 RFC を要する。

## Zone model

zone は operator 管理 ID と同じ suffix 文法を持つ kebab-case ASCII 文字列で ある
([Resource IDs](/reference/resource-ids) 参照)。例: `az-1a`、`az-1b`、
`rack-c`。kernel は値を解釈しない: 似た名前の 2 つの zone は無関係で、kernel
は文字列形から隣接性や距離を推論しない。

operator は環境変数を通じて、認識する zone 集合を publish する。

```text
TAKOSUMI_ZONES_AVAILABLE   comma-separated list, e.g. "az-1a,az-1b,az-1c"
TAKOSUMI_ZONE_DEFAULT      one of TAKOSUMI_ZONES_AVAILABLE; required when
                           TAKOSUMI_ZONES_AVAILABLE is set
```

`TAKOSUMI_ZONES_AVAILABLE` を空でない list に設定すると zone チェックが
有効化される。未設定なら kernel は zone-agnostic のままで、その mode では下記の
zone field は評価時に黙って無視される。

zone チェックが有効なとき、Space / Object / DataAsset / Connector scope の
すべての zone 値は `TAKOSUMI_ZONES_AVAILABLE` のメンバーでなければならない。
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
それに応じて resource を配置しなければならない。`zonePreference` は助言的:
connector は基底 provider が zone hint をサポートする場合に値を参照し、 provider
が preference を尊重できないときには audit signal を発行する。

Space record は `defaultZone` を永続化する。Object / DataAsset / Connector
record はそれぞれの zone field を [Storage Schema](/reference/storage-schema)
に従って永続化する。

## Manifest reference

manifest は [Manifest Expand Semantics](/reference/manifest-expand-semantics)
で定義された標準 `${ref:...}` 展開を通じて zone を参照する。

```yaml
objects:
  - id: object:web
    zone: ${ref:space.defaultZone}
  - id: object:cache
    zone: az-1b
```

shape spec で `zoneAware: true` を宣言する target descriptor は、binding context
で resolved zone 文字列を受け取る。zone awareness を宣言しない descriptor はこの
field を無視する。kernel は強制も drop もしない。

## Cross-zone link policy

同じ Space 内の 2 つの object の resolved zone が異なる link は **cross-zone
link** である。default policy は `allow-with-warning`。

- The kernel emits a `cross-zone-link-warning` audit event with
  `severity: notice` carrying the link ID, the consumer zone, the producer zone,
  and the Space ID.
- The link itself is created and the deployment proceeds.

policy は `TAKOSUMI_CROSS_ZONE_LINK_POLICY` で operator が tune できる。

| Value                | Effect                                                     |
| -------------------- | ---------------------------------------------------------- |
| `allow`              | Permit cross-zone links silently; no audit event.          |
| `allow-with-warning` | Default. Permit and emit `notice`.                         |
| `deny`               | Reject the deployment with `errorCode: cross_zone_denied`. |

policy は kernel-global に適用される。Space 単位の policy 上書きは
`CONVENTIONS.md` §6 RFC を要する。

## Failover signal

zone failure は **signal surface** であり、kernel 駆動の failover 機構ではない。
kernel は autonomous に object を zone 間で移動しない。

- Connectors that detect a zone-down condition (provider API returning
  zone-specific failure, probe consistently failing inside one zone) emit
  `zone-failure-observed` to drift detection (see
  [Drift Detection](/reference/drift-detection)). The drift event carries the
  zone string and the affected object IDs.
- The next ActivationSnapshot built after a zone-failure observation carries an
  annotation `zoneFailure: { zone: "...", observedAt: ... }` on every affected
  object. The annotation is informational; the snapshot is still produced.
- Recovery is symmetrical: connectors emit `zone-recovery-observed` and the next
  ActivationSnapshot drops the annotation.

operator distribution が signal をどう扱うか (外部ロードバランサーの failover、
顧客トラフィックのリダイレクト、desired manifest の再形成、ステータスページ
への投稿) は kernel の外に住む。kernel の仕事は signal を observable で durable
にすることである。

## Audit events

zone 関連の audit event ([Audit Events](/reference/audit-events) 参照):

- `cross-zone-link-warning` — emitted on cross-zone link creation under
  `allow-with-warning`. Severity `notice`.
- `zone-failure-observed` — emitted on connector-reported zone failure. Severity
  `warning`.
- `zone-recovery-observed` — emitted on connector-reported zone recovery.
  Severity `notice`.
- `space-default-zone-changed` — emitted when a Space's `defaultZone` is
  updated. Severity `info`. Payload carries previous and next zone, and the
  actor.

`zone-failure-observed` と `zone-recovery-observed` は Space ID と zone 文字列の
両方を運ぶ。kernel-global zone failure (すべての Space に影響) は `spaceId` を
順次各 Space に設定して event を発行する。kernel はこれらを単一 event に
まとめないので、下流 consumer が正しく attribute できる。

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
zone 製品** — 顧客ダッシュボードでの zone セレクタ、latency
テーブルと推奨コピー、災害復旧プレイブック、zone outage を説明する公開ステー
タス copy、zone availability を商用コミットメントに結びつける契約文言 — は
`takos-private/` のような operator distribution に住む。kernel は属性と audit
signal を同梱してそこで止まる。

## Related architecture notes

- `docs/reference/architecture/operator-boundaries.md` — operator policy layer
  that acts on zone signals.
- `docs/reference/architecture/exposure-activation-model.md` —
  ActivationSnapshot shape that carries zone annotations.
- `docs/reference/architecture/space-model.md` — Space identity that owns
  `defaultZone`.

## 関連ページ

- [Storage Schema](/reference/storage-schema)
- [Audit Events](/reference/audit-events)
- [Connector Contract](/reference/connector-contract)
- [Manifest Expand Semantics](/reference/manifest-expand-semantics)
- [Drift Detection](/reference/drift-detection)
- [Environment Variables](/reference/env-vars)
- [Resource IDs](/reference/resource-ids)
