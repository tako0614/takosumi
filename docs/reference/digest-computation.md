# Digest Computation

> このページでわかること: manifest / artifact の digest 計算方法。

Takosumi v1 が snapshot / plan / approval / predicted effect を結びつけるため
に使う digest 計算の規定です。 digest が persist される箇所、 および suffix が
content-addressed な resource ID すべてで同一アルゴリズムを用います。

本仕様は normative であり、 本ページと異なる digest を生成する kernel は
仮にレシピが大まかに合っていても非準拠とみなします。 replay / restore / catalog
adoption など instance 間の相互運用は、 digest が byte 単位で一致す
ることに依存します。

## digest の用途

v1 でこの仕様に従う digest:

| Digest                         | 用途                                                             |
| ------------------------------ | ---------------------------------------------------------------- |
| `desiredSnapshotDigest`        | `desired:sha256:...` snapshot の identity。                      |
| `resolutionSnapshotDigest`     | `resolution:sha256:...` snapshot の identity。                   |
| `operationPlanDigest`          | OperationPlan の identity。 WAL idempotency tuple を bind する。 |
| `effectDetailsDigest`          | `actualEffects` / `approvedEffects` view の identity。           |
| `predictedActualEffectsDigest` | dry-materialization 予測の identity。                            |

[Resource IDs](/reference/resource-ids) の他の content-addressed ID
(`export-snapshot:` / `catalog-release:` / `policy:`) も同アルゴリズム。 各 ID
の入力形状はそれぞれの reference を参照。

## アルゴリズム

v1 で digest アルゴリズムは固定です。

```text
digest = "sha256:" + lowercase_hex(SHA-256(canonical_encoding(input)))
```

- hash 関数は FIPS 180-4 の **SHA-256**。 v1 で他の hash は使えない
- digest 出力は常に文字列 `sha256:` プレフィックス + 32 byte hash の小文字 hex。
  `sha256:` プレフィックスは digest の一部で、 byte 単位比較に含まれる
- hash への入力は次節の canonical encoding で得られる byte 列

`sha256:` プレフィックスは、 将来 `CONVENTIONS.md` §6 RFC で別 hash に
移行する際にも wire shape を壊さないために存在します。 移行期間中は別
プレフィックスの digest と `sha256:` digest が共存できます。

## Canonical encoding

canonical encoding は
[RFC 8785 (JSON Canonicalization Scheme, JCS)](https://www.rfc-editor.org/rfc/rfc8785)
に従い、 v1 固有の補足を加えます。

- **object key** は UTF-16 code unit 列で辞書式 sort (JCS の規則)。 実装間で
  byte-stable に sort される
- **数値** は JCS §3.2.2.3 の IEEE 754 double 表現で出力。 safe integer 範囲
  の整数は小数点 / 指数なし、 小数は最短表現。 kernel は ingest 時に non-finite
  (`NaN` / `+Infinity` / `-Infinity`) を拒否するため digest 計算へは到達しない
- **文字列** は encoding 前に Unicode Normalization Form C (NFC) で正規化。
  encoding は UTF-8 で、 JCS の escape rule (`\"`、 `\\`、 `\/` は非 escape、
  制御文字は `\u00xx`)
- **配列** は宣言順を保つ。 canonical encoding は要素を並べ替えない
- **空白** は出力しない。 byte 列に余白は含まれない
- **文字集合** は UTF-8 固定。 SHA-256 への入力は canonical JSON の UTF-8 表現

実装は自前の canonicalizer を作らず、 検証済み JCS library に NFC 前処理を
かければ十分です。

## 各 digest の入力範囲

各 digest は厳密な入力に対して計算します。 異なる field を含めたり、 必須 field
を欠いたり、 ネスト配列を並べ替えたりすると別 digest になり、 非準拠
になります。

### `desiredSnapshotDigest`

含む:

- `components` — snapshot の closed-shape component list
- `links` — 宣言順の link set
- `exposures` — 宣言順の exposure set
- `dataAssets` — 宣言順の DataAsset binding
- `desiredGeneration` — 単調増加する generation counter

含まない:

- `spaceId` — snapshot は Space 間で identity portable。 Space binding は
  snapshot envelope 側で記録
- `createdAt` — wall-clock timestamp は identity に含めない
- operator 専用 annotation (audit note、 deploy bearer 識別子)

### `operationPlanDigest`

含む:

- `operations` — closed-shape descriptor を持つ ordered operation list
- `approvedEffects` bound — plan が前提とした effect bound
- 各 operation の resolved `connector:<id>`
- 対象 `desired:sha256:...` と `resolution:sha256:...` の ID

含まない:

- `idempotencyKey` — `operationPlanDigest` から **derive** される。 入力では
  ない
- `journalCursor` — runtime の WAL 状態は plan identity に含めない
- per-attempt counter (`operationAttempt`)

### `effectDetailsDigest`

input は effect set の closed-enum view。 approval record 上の `approvedEffects`
でも OperationResult 上の `actualEffects` でも同一アルゴ リズムを適用します。
effect digest が同形状であることで、 成功 operation の result digest と approval
の effect digest を bound rule
([Provider Implementation Contract — Effect bound rule](/reference/provider-implementation-contract#effect-bound-rule))
の下で byte 単位比較できます。

入力は source set の順序を保った closed-shape effect descriptor の列。 canonical
encoder は各 descriptor 内部を JCS 規則で sort しますが、 外側の list
を並べ替えることはしません。

### `predictedActualEffectsDigest`

dry materialization で得られる予測 effect map が入力です
([Provider Implementation Contract — Dry materialization phase](/reference/provider-implementation-contract#dry-materialization-phase))。
形状は `effectDetailsDigest` と同じ。 digest は OperationPlan に bind され、
`commit` / `post-commit` 時の `actual-effects-overflow` Risk 評価の参照値に
なります。

### `resolutionSnapshotDigest`

含む:

- `catalogReleaseId` — 解決時に active な closed `catalog-release:<...>` ID
- `exportSnapshotIds` — 宣言順の解決済 `export-snapshot:<sha256>` ID
- `importedShares` — 解決依存先の `share:<ulid>` ID と解決済 freshness state
- resolved target — resolver が選んだ component ごとの closed-shape target
  binding

含まない:

- `spaceId` — `desiredSnapshotDigest` と同じ identity portability rule
- wall-clock timestamp
- resolver の内部 counter / telemetry

## 衝突の扱い

v1 では SHA-256 を衝突なしとして扱います。 kernel は運用上この仮定に依存
します。

- content-addressed ID は digest 一致 = content 一致と仮定
- replay は digest 不一致を必ず content divergence として扱い、 hash 衝突と
  はみなさない

実運用で SHA-256 衝突が発見された場合は、 `CONVENTIONS.md` §6 RFC で別 hash
への移行で対応します。 digest 先頭の `sha256:` プレフィックスはその移行の
余地として設計されています。

## digest 比較

比較対象によって扱いが異なります。

- **保存済 digest の等価性比較** は byte 単位。 両側はすでに canonical なの で、
  比較時に prefix や hex case を正規化しない
- **catalog release の署名検証** は
  [Catalog Release Trust](/reference/catalog-release-trust) の署名 backend
  を介した constant-time byte 比較。 timing-safe 比較が必要な のはここだけで、
  通常の apply pipeline チェックでは不要

kernel は digest を JSON に re-decode して構造比較することはありません。
canonical な byte 列そのものが identity です。

## 再計算ルール

kernel は digest を初回計算時に persist し、 再計算は元の immutable 入力 record
に対してのみ許可します。

- `desired:sha256:...` / `resolution:sha256:...` / `export-snapshot:sha256:...`
  / `catalog-release:sha256:...` / `policy:sha256:...` はいずれも immutable
  record に backed。 record から再計算すれば永遠に同じ値が得られる
- `operationPlanDigest` は OperationPlan emit 時に 1 度計算し、 WAL header に
  persist。 replay 時は保存済 record から再計算し、 一致を確認した後で進行
- `effectDetailsDigest` と `predictedActualEffectsDigest` は immutable な plan /
  approval / result record に bind。 再計算は replay と audit verification
  でのみ使う

入力 record が mutable な場合 (v1 では digest 計算の入力は mutable では
ないが)、 再計算は無効で、 実装は persist された digest を使います。

## Related architecture notes

- docs/reference/architecture/snapshot-model.md
- docs/reference/architecture/operation-plan-write-ahead-journal-model.md
- docs/reference/architecture/policy-risk-approval-error-model.md
- docs/reference/architecture/catalog-release-descriptor-model.md
- docs/reference/architecture/data-asset-model.md

## 関連ページ

- [Resource IDs](/reference/resource-ids)
- [Provider Implementation Contract](/reference/provider-implementation-contract)
- [WAL Stages](/reference/wal-stages)
- [Catalog Release Trust](/reference/catalog-release-trust)
- [Storage Schema](/reference/storage-schema)
