# DataAsset Policy

> Stability: stable
> Audience: operator, kernel-implementer
> See also: [DataAsset Kinds](/reference/artifact-kinds),
> [Connector Contract](/reference/connector-contract),
> [Risk Taxonomy](/reference/risk-taxonomy),
> [Approval Invalidation Triggers](/reference/approval-invalidation),
> [WAL Stages](/reference/wal-stages),
> [Audit Events](/reference/audit-events)

Takosumi v1 で kernel が DataAsset の取り扱いを制御する operator policy
の正本仕様。`artifactPolicy.perKey` schema、kind ごとの override 規則、
cache policy、transform approval gate、transform への secret handling を
closed semantics で定義する。Connector の `acceptedKinds` と重ね合わせて
resolution / plan / pre-commit を決定する point になる。

## artifactPolicy schema

operator config に置く `artifactPolicy` の v1 schema:

```yaml
artifactPolicy:
  perKey:
    <kind>:
      sizeCapBytes: <int>
      signatureRequired: <bool>
      cachePolicy: <enum: no-cache | cache-once | cache-always>
      transformAllowed: <bool>
  default:
    sizeCapBytes: <int>
    signatureRequired: <bool>
    cachePolicy: <enum>
    transformAllowed: <bool>
```

field 規則:

| field             | 型     | 必須 | 意味                                                            |
| ----------------- | ------ | ---- | --------------------------------------------------------------- |
| `sizeCapBytes`    | int    | yes  | 当該 kind の DataAsset に許容される最大バイト数                 |
| `signatureRequired` | bool | yes  | plan が署名済 artifact を要求するか                             |
| `cachePolicy`     | enum   | yes  | connector cache の運用方針 (後述)                               |
| `transformAllowed`| bool   | no   | 当該 kind を transform input として許容するか (default: false)  |

`perKey.<kind>` の `<kind>` は DataAsset kind の closed enum 5 値
(`oci-image` / `js-module` / `wasm-module` / `static-archive` /
`source-archive`) のいずれか。Connector が `acceptedKinds` で declare して
いない kind についても artifactPolicy には書ける (将来導入の Connector
向け pre-policy として)。

## Override priority

resolution は以下の順で policy を解決する:

1. `artifactPolicy.perKey.<kind>` に当該 kind が存在すればそれを使う。
2. なければ `artifactPolicy.default` を使う。
3. `default` も未定義なら kernel built-in default
   ([DataAsset Kinds](/reference/artifact-kinds) 参照) を使う。

`perKey` で部分指定した field のみが override される (per-field override
ではなく per-record override である点に注意)。`perKey.<kind>` を書いたら
当該 kind の全 field を埋める。

## Cache policy enum

`cachePolicy` は connector が DataAsset を取り扱う際の保管方針。

| 値              | 意味                                                                  |
| --------------- | --------------------------------------------------------------------- |
| `no-cache`      | connector は materialize 後に直ちに破棄。次回 apply で再取得          |
| `cache-once`    | connector は first apply で取得し、digest 一致を確認した上で再利用    |
| `cache-always`  | connector が manifest digest 単位で永続 cache を持つ                  |

cache の存在自体は connector 実装が担う。kernel は policy 値を connector
に渡し、observed cache state を ObservationSet に reflect する。

## Per-kind 既定値

Connector の `acceptedKinds` に `<kind>` が含まれている前提で、
`artifactPolicy` を一切書かない場合の kernel built-in 既定:

| kind             | sizeCapBytes | signatureRequired      | cachePolicy   | transformAllowed |
| ---------------- | ------------ | ---------------------- | ------------- | ---------------- |
| `oci-image`      | n/a (pointer)| operator policy 次第   | `cache-once`  | false            |
| `js-module`      | 50 MiB       | regulated profile 必須 | `cache-once`  | true (output)    |
| `wasm-module`    | 50 MiB       | reserved Space で必須  | `cache-once`  | false            |
| `static-archive` | 50 MiB       | operator policy 次第   | `cache-always`| true (output)    |
| `source-archive` | 50 MiB       | transform commit で必須| `cache-once`  | true (input)     |

`oci-image` は pointer kind なので `sizeCapBytes` が意味を持たない。
operator が値を書いても無視される。

## Transform approval gates

DataAsset transform は `source-archive` を入力に取り、`js-module` または
`static-archive` を出力する pipeline で、operator-installed Transform が
実行する。kernel は transform を **default で禁止** し、approval flow を
通った宣言のみ通す。

### Approval 必須範囲

以下のすべてが approval 対象:

- `source-archive → js-module` 変換
- `source-archive → static-archive` 変換
- `source-archive → source-archive` 変換 (canonicalization 等)

approval は通常の Approval flow 経由で得る
([Approval Invalidation Triggers](/reference/approval-invalidation))。
approval record は (input source-archive digest, transform identity,
output kind) の triple に bind される。

### Risk

approval なしで transform を含む plan を発火すると `transform-unapproved`
Risk が `pre-commit` で raise される
([Risk Taxonomy](/reference/risk-taxonomy) §19)。severity は `error` の
ため、approval grant が無い限り plan は `deny` で停止する。

### Enforcement point

transform の有効性は WAL `pre-commit` stage で検証する
([WAL Stages](/reference/wal-stages))。

- `prepare`: transform 計画を resolution に展開し、plan に Risk を立てる。
- `pre-commit`: kernel が approval binding を再 verify し、transform を
  invoke する。binding が崩れていれば `transform-unapproved` で reject。
- `commit`: 出力 DataAsset を artifact partition に書き込む。

approval invalidation triggers の **digest change** (trigger 1) /
**effect-detail change** (trigger 2) で transform approval は崩れる。
特に source-archive digest が変わった場合、approval は短絡 invalidate
される。

### transformAllowed flag

`artifactPolicy.perKey.<kind>.transformAllowed` は当該 kind を transform
の **input または output** に取れるかを指定する。`false` の kind を
transform pipeline で使おうとした plan は approval 対象にすらならず、
`transform-unapproved` Risk が `error` severity で発火する。

## Transform secret handling

transform は通常 untrusted code path とみなす。runtime secret の漏洩を
防ぐため、kernel は secret の transform 入力への流入を default で遮断する。

### Default rule

- runtime secret (Space partition の `${secret:...}` reference) は
  transform 入力に **渡らない**。
- secret reference 自体も transform 入力 manifest からは strip される。
  raw value も reference 値も transform プロセスに到達しない。
- transform は source-archive と (operator が明示 inject した) public
  parameter のみを受け取る。

### Exception (policy-explicit)

transform への secret 持ち込みが業務上必要なケースは、operator policy
で **明示承認** した場合に限り許容する。

- policy で `transform.secretPassthrough` を明示 enable する。
- 当該 secret を `transform-input` として approve する。secret-projection
  Risk と同じ flow に乗り、approval record に raw bind される。
- approval は input source-archive digest にも bind されるので、source
  digest を変えると即時 invalidate される。

承認なく secret を transform に持ち込もうとした plan は
`secret-projection` + `transform-unapproved` の双方を raise し、
`error` severity で `deny` する。

## Connector との関係

`artifactPolicy` は Connector の `acceptedKinds` の **上に重ねる** 制限で
ある ([Connector Contract](/reference/connector-contract))。

- Connector が `acceptedKinds` で declare していない kind は、policy で
  許容しても resolution が fail する (`connector-not-accepting-kind`)。
- Connector が accept する kind を policy が `transformAllowed: false` に
  していると、当該 kind を transform に通す plan が reject される。
- `signatureRequired: true` の policy は Connector の signing capability
  と整合する必要がある。Connector が署名検証 capability を持たない場合、
  当該 Connector binding は plan で reject される。

resolution が Connector + policy の両方を満たす binding を選ぶ責任を
持つ。両方を満たす binding が無ければ plan は失敗する。

## Operator surface

### Config 配置

`artifactPolicy` は operator config (kernel host) に置く。runtime-agent
host や CLI host には push しない。kernel が起動時に load し、変更は
kernel restart または `operator reload` で反映する。

### Audit events

policy 関連の操作は audit log に記録される
([Audit Events](/reference/audit-events)):

- `artifact-policy-changed` — policy update / reload
- `transform-approved` — transform approval grant
- `transform-rejected` — transform approval rejection / invalidation
- `transform-secret-passthrough-enabled` / `...-disabled` — secret 例外
  の toggle

すべて actor identity と policy diff (redacted) を payload に持つ。

### CLI

operator は以下で policy を扱う:

- `takosumi policy artifact list` — 現行 policy を表示
- `takosumi policy artifact reload` — config を再読込
- `takosumi approval list --kind transform` — pending transform approval

## Failure modes

| 状況                                            | error code / Risk             | 復旧                              |
| ----------------------------------------------- | ----------------------------- | --------------------------------- |
| `sizeCapBytes` 超過                             | `artifact-size-cap-exceeded`  | policy 引き上げ または artifact 圧縮 |
| signatureRequired but unsigned                  | `artifact-signature-missing`  | 署名 artifact を再 upload         |
| Connector が kind を accept しない              | `connector-not-accepting-kind`| Connector を変更 / 追加           |
| transform 未承認                                | `transform-unapproved` Risk   | approval flow を通す              |
| secret passthrough 未承認 with secret in input  | `secret-projection` Risk      | policy enable + approval          |

## Related design notes

本文を読むのに design/ への参照は不要だが、設計の rationale は以下に残る:

- `docs/design/data-asset-model.md` — DataAsset kind enum と transform
  pipeline の rationale
- `docs/design/policy-risk-approval-error-model.md` — transform approval
  の Risk taxonomy 上の位置付け
- `docs/design/operator-boundaries.md` — transform への secret 流入を
  default で遮断する trust 境界
