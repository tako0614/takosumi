# Digest 計算 {#digest-computation}

> このページでわかること: AppSpec file / structured snapshot / source snapshot /
> operator DataAsset の digest 計算方法。

Takosumi v1 が AppSpec file / snapshot / plan / approval / predicted effect /
source / DataAsset を結びつけるために使う digest 計算の規定です。digest は
**structured JSON digest** と **byte-stream digest** の 2 family に分かれます。

本仕様は normative であり、 本ページと異なる digest を生成する kernel は
仮にレシピが大まかに合っていても非準拠とみなします。 replay / restore /
source・DataAsset verification など instance 間の相互運用は、 digest が byte
単位で一致することに依存します。

## digest の用途 {#digest-usage}

v1 でこの仕様に従う structured JSON digest:

- `desiredSnapshotDigest`: `desired:sha256:...` snapshot の identity。
- `resolutionSnapshotDigest`: `resolution:sha256:...` snapshot の identity。
- `operationPlanDigest`: OperationPlan の identity。 WAL idempotency tuple を
  bind する。
- `effectDetailsDigest`: `actualEffects` / `approvedEffects` view の identity。
- `predictedActualEffectsDigest`: dry-materialization 予測の identity。

v1 でこの仕様に従う byte-stream digest:

- `manifestDigest`: installer が選択した `.takosumi.yml` file bytes の
  identity。
- `source.digest` / `expected.sourceDigest`: prepared source tar payload bytes
  の identity。
- DataAsset digest: optional operator DataAsset extension が保存する blob bytes
  の identity。

[Resource IDs](./resource-ids.md) の content-addressed ID は、structured JSON
record なら JCS digest、raw bytes なら byte-stream digest を使います。各 ID の
入力形状はそれぞれの reference を参照。

## アルゴリズム {#algorithm}

v1 で hash algorithm は固定です。

```text
digest = "sha256:" + lowercase_hex(SHA-256(input_bytes))
```

- hash 関数は FIPS 180-4 の **SHA-256**。 v1 で他の hash は使えない
- digest 出力は常に文字列 `sha256:` プレフィックス + 32 byte hash の小文字 hex。
  `sha256:` プレフィックスは digest の一部で、 byte 単位比較に含まれる
- structured JSON digest の `input_bytes` は次節の canonical encoding で得られる
  byte 列
- byte-stream digest の `input_bytes` は file / tar / blob の raw byte stream
  そのもの。YAML parse result や JSON canonical form へ変換しない

`sha256:` プレフィックスは digest algorithm を explicit にするために存在します。
将来 `CONVENTIONS.md` §6 RFC で別 hash を採用する場合は、 prefix / verifier /
docs / tests を同じ change set で current spec として更新します。

## Canonical encoding {#canonical-encoding}

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

## 各 digest の入力範囲 {#digest-input-scope}

各 digest は厳密な入力に対して計算します。 異なる field を含めたり、 必須 field
を欠いたり、 ネスト配列を並べ替えたりすると別 digest になり、 非準拠になります。

### `manifestDigest` {#manifestdigest}

入力は installer が source root から選択した `.takosumi.yml` の raw UTF-8 file
bytes。line ending、comment、key order も file bytes の一部として digest に参加
します。`manifestDigest` は AppSpec parse 後の normalized object digest ではあり
ません。

### `source.digest` / `expected.sourceDigest` {#sourcedigest}

prepared source の入力は build service が Installer API に渡す tar payload
bytes。 kernel は payload を展開する前に `source.digest` を検証し、dry-run/apply
gate では `expected.sourceDigest` と byte-for-byte で比較します。

### DataAsset digest {#dataasset-digest}

optional DataAsset extension の入力は operator が保存する blob bytes。DataAsset
metadata (`kind`, `contentTypeHint`, retention policy など) は blob digest には
含めず、別 record として audit / retention に参加します。

### `desiredSnapshotDigest` {#desiredsnapshotdigest}

含む:

- `components` — snapshot の closed-shape component list
- `links` — 宣言順の link set
- `exposures` — 宣言順の exposure set
- `dataAssetExtensionRefs` — operator DataAsset extension が有効な場合の ordered
  extension refs
- `desiredGeneration` — 単調増加する generation counter

Identity から外すもの:

- `spaceId` — snapshot は Space 間で identity portable。 Space binding は
  snapshot envelope 側で記録
- `createdAt` — wall-clock timestamp は envelope metadata
- operator 専用 annotation (audit note、 deploy bearer 識別子)

### `operationPlanDigest` {#operationplandigest}

含む:

- `operations` — closed-shape descriptor を持つ ordered operation list
- `approvedEffects` bound — plan が前提とした effect bound
- 各 operation の resolved `connector:<id>`
- 対象 `desired:sha256:...` と `resolution:sha256:...` の ID

Identity から外すもの:

- `idempotencyKey` — `operationPlanDigest` から **derive** される
- `journalCursor` — runtime の WAL 状態
- per-attempt counter (`operationAttempt`)

### `effectDetailsDigest` {#effectdetailsdigest}

input は effect set の closed-enum view。 approval record 上の `approvedEffects`
でも OperationResult 上の `actualEffects` でも同一アルゴリズムを適用します。
effect digest が同形状であることで、 成功 operation の result digest と approval
の effect digest を bound rule ([Provider Implementations](./providers.md))
の下で byte 単位比較できます。

入力は source set の順序を保った closed-shape effect descriptor の列。 canonical
encoder は各 descriptor 内部を JCS 規則で sort しますが、 外側の list を
並べ替えることはしません。

### `predictedActualEffectsDigest` {#predictedactualeffectsdigest}

dry materialization で得られる予測 effect map が入力です
([Provider Implementations](./providers.md))。 形状は `effectDetailsDigest`
と同じ。 digest は OperationPlan に bind され、 `commit` / `post-commit` 時の
`actual-effects-overflow` Risk 評価の参照値に なります。

### `resolutionSnapshotDigest` {#resolutionsnapshotdigest}

含む:

- `operatorImplementationConfigVersion` — operator が起動時に expose した kind
  alias / provider implementation / connector inventory の marker。これは
  ResolutionSnapshot record に保存された opaque string。導出規則は operator
  distribution が所有する
- `providerResolution` — component ごとの resolved kind URI / provider
  implementation / connector binding
- `exportSnapshotIds` — 宣言順の解決済 `export-snapshot:<sha256>` ID
- `importedShares` — 解決依存先の `share:<ulid>` ID と解決済 freshness state
- resolved target — resolver が選んだ component ごとの closed-shape target
  binding

入力の外に置く値:

- `spaceId` — `desiredSnapshotDigest` と同じ identity portability rule
- wall-clock timestamp
- resolver の内部 counter / telemetry

## 衝突の扱い {#collision-handling}

v1 では SHA-256 を衝突なしとして扱います。 kernel は運用上この仮定に依存
します。

- content-addressed ID は digest 一致 = content 一致と仮定
- replay は digest 不一致を必ず content divergence として扱い、 hash 衝突と
  はみなさない

実運用で SHA-256 衝突が発見された場合は、 `CONVENTIONS.md` §6 RFC で別 hash
への移行で対応します。 digest 先頭の `sha256:` プレフィックスはその移行の
余地として設計されています。

## digest 比較 {#digest-comparison}

比較対象によって扱いが異なります。

- **保存済 digest の等価性比較** は byte 単位。 両側はすでに canonical なので、
  比較時に prefix や hex case を正規化しない
- operator implementation config は通常の解決入力であり、reference adapter
  package の取得・検証は operator policy で扱う

kernel は digest を JSON に re-decode して構造比較することはありません。
canonical な byte 列そのものが identity です。

## 再計算ルール {#recalculation-rule}

kernel は digest を初回計算時に persist し、 再計算は元の immutable 入力 record
に対してのみ許可します。

- `desired:sha256:...` / `resolution:sha256:...` / `export-snapshot:sha256:...`
  / `policy:sha256:...` はいずれも immutable record に backed。 record から
  再計算すれば永遠に同じ値が得られる
- `operationPlanDigest` は OperationPlan emit 時に 1 度計算し、 WAL header に
  persist。 replay 時は保存済 record から再計算し、 一致を確認した後で進行
- `effectDetailsDigest` と `predictedActualEffectsDigest` は immutable な plan /
  approval / result record に bind。 再計算は replay と audit verification
  でのみ使う

digest 計算の入力 record は immutable として扱います。実装は persist された
digest を replay / audit verification で使います。

## 関連アーキテクチャ {#related-architecture-notes}

- docs/reference/architecture/snapshot-model.md
- docs/reference/architecture/runtime-deployment-model.md#operation-plan--write-ahead-journal
- docs/reference/architecture/policy-risk-approval-error-model.md
- docs/reference/architecture/namespace-export-model.md#data-asset-model

## 関連ページ

- [Resource IDs](./resource-ids.md)
- [Provider Implementations](./providers.md)
- [WAL Stages](./wal-stages.md)
- [Reference Plugin Loading](./plugin-loading.md)
- [Storage Schema](./storage-schema.md)
