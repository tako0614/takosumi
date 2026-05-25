# ダイジェスト計算 {#digest-computation}

Takosumi の public Installer API は、byte stream の digest として次の 2 種類を使います。

| Field                                     | 入力 bytes                            | Surface                         |
| ----------------------------------------- | ------------------------------------- | ------------------------------- |
| `manifestDigest`                          | raw `.takosumi.yml` file bytes        | dry-run / apply / Deployment    |
| `source.digest` / `expected.sourceDigest` | fetched prepared source payload bytes | prepared source dry-run / apply |

git source の identity は resolved commit SHA です。これは source identity であり、Takosumi digest field ではありません。`local` source は portable source byte identity を持たないため、reviewed-source guard は `manifestDigest` だけです。

build graph digest、build cache key、container image digest、operator の Deployment の記録用 digest は、operator または implementation が別 record として扱います。

## 公開 byte digest {#public-byte-digests}

Takosumi v1 の public byte digest は SHA-256 を使います。

```text
digest = "sha256:" + lowercase_hex(SHA-256(input_bytes))
```

ルール:

- hash function は SHA-256。
- string form は `sha256:` + 64 文字の lowercase hex。
- `sha256:` prefix は比較対象の一部。
- validation 後は byte-for-byte の string equality で比較する。比較時に case normalize しない。
- input bytes は対象 file または archive payload の exact bytes。YAML parse result、JSON canonical form、comment removal、key ordering、line-ending normalization は適用しない。

### `manifestDigest` {#manifestdigest}

`manifestDigest` は、resolved source root から選ばれた `.takosumi.yml` bytes の SHA-256 digest です。line ending、comment、whitespace、YAML key order は digest に含まれます。

選ばれた `.takosumi.yml` bytes は YAML parse の前に UTF-8 として decode できる必要があります。invalid UTF-8 は manifest validation の前に拒否します。duplicate YAML mapping key も invalid です。これらの parse rule は `manifestDigest` を変えません。digest は decoded text や parsed YAML ではなく、選ばれた raw bytes から計算します。

`manifestDigest` は dry-run で review した manifest bytes を guard します。 `local` source の source tree 全体を guard するものではありません。

### Prepared source の digest {#sourcedigest}

`source.kind: "prepared"` では、`source.digest` は caller が渡す archive payload bytes の digest です。Installer API は `source.url` を取得し、実際に受け取った bytes の digest を計算し、その値を `source.digest` と比較します。

dry-run と apply response は、同じ resolved prepared source identity の reviewed-source guard として `expected.sourceDigest` を返します。 `expected.sourceDigest` は `source.digest` の代替ではありません。両方がある場合、apply は両方を確認します。

### Expected guard {#expected-guard}

`expected` は apply を dry-run で review した source に固定します。

| Source kind | 必須 expected field              |
| ----------- | -------------------------------- |
| `git`       | `manifestDigest`, `commit`       |
| `prepared`  | `manifestDigest`, `sourceDigest` |
| `local`     | `manifestDigest`                 |

deploy apply では、上の source guard に加えて `expected.currentDeploymentId` を照合します。これは dry-run が review した current Deployment pointer の guard です。

well-shaped guard が resolved source と一致しない場合、apply は 409 `failed_precondition` を返します。source kind に適用できない field を guard が持つ場合、apply は 400 `invalid_argument` を返します。

## Operator の Deployment の記録用 digest {#operator-evidence-digests}

operator profile は、replay、approval、audit、rollout、リソースの作成・更新の recovery のために追加の structured digest を保存できます。名前、canonicalization rule、input field は、その Deployment の記録を定義する operator ledger に属します。public Installer API field ではありません。

## Algorithm migration {#algorithm-migration}

Takosumi v1 の public Installer API は `sha256:` digest だけを使います。将来の spec が別 algorithm を採用する場合、prefix、verifier、docs、tests、public wire validation を同じ compatibility update で変更します。

## 関連ページ {#related-pages}

- [Installer API](./installer-api.md)
- [ビルドサービス境界](./build-spec.md)
