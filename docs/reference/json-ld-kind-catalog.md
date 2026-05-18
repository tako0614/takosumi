# JSON-LD Kind Catalog

> このページでわかること: `components[*].kind` で参照される **component kind**
> を JSON-LD で公開する正本の仕様。 operator が自前 kind を publish する手順
> もここに記載されます。

Takosumi は 5 種類の built-in component kind (`worker` / `postgres` /
`object-store` / `oidc` / `custom-domain`) を持ちます。 これらの kind は
**JSON-LD 文書として公開** され、 `@id` (= 完全 URI) で一意に識別されます。

operator は自前 domain で同じ shape の `.jsonld` を publish するだけで新 kind
を追加でき、 これが Takosumi が掲げる「ソフトウェアの民主化」 の
土台となります。 (= 第三者は kernel に手を入れずに自分の vocabulary を
立ち上げられる)

## URL convention

```
https://takosumi.com/contexts/v1.jsonld                  ← root vocabulary
https://takosumi.com/contexts/kinds/v1/<name>.jsonld     ← 各 kind 文書
```

operator が自前 kind を立てるときも同じ形を採用してください:

```
https://operator.example.com/contexts/v1.jsonld          ← operator が root を引く場合
https://operator.example.com/kinds/lambda                ← @id (= identifier)
```

operator は Takosumi の root context (`takosumi.com/contexts/v1.jsonld`) を
そのまま `@context` 値として参照しても、 独自 root を publish しても良いです。
kernel は `@context` の意味処理 (= semantic expand) を行わず、 **URI を
identifier として** だけ扱います。

## 文書 shape

各 kind 文書は次のフィールドを含みます。

| フィールド     | 必須 | 意味                                                                 |
| -------------- | ---- | -------------------------------------------------------------------- |
| `@context`     | yes  | root vocabulary URL (= `https://takosumi.com/contexts/v1.jsonld` 等) |
| `@id`          | yes  | この kind の canonical URI (= `https://.../kinds/v1/<name>`)         |
| `@type`        | yes  | 固定 `"ComponentKind"`                                               |
| `name`         | yes  | short name (= AppSpec の `kind` 短縮形に対応; 例 `worker`)           |
| `version`      | yes  | `v1` / `v2` 等の kind version                                        |
| `description`  | yes  | 1 文の説明                                                           |
| `spec`         | yes  | 入力 schema の field list (= `[{ name, type, required, meaning }]`)  |
| `outputs`      | yes  | 出力 field list                                                      |
| `capabilities` | yes  | provider が claim できる capability の固定集合                       |

`spec` / `outputs` の各 entry は次のキーを持ちます:

- `name` : field 名
- `type` : type hint (= `string` / `boolean` / `string[]` / `object` / `enum`
  等)
- `required` : 必須かどうか
- `meaning` : human-readable 意味付け
- `enum` : enum 型の場合の許容値リスト (optional)

ここに書かれた shape は **正本** であり、 `packages/contract/src/app-spec.ts` の
`COMPONENT_KINDS` 配列および `packages/plugins/src/kinds/*.ts` の TS schema
はこの正本に追従します。

## operator-defined kind の publish 手順

1. **`.jsonld` を立てる** — 自分の domain で
   `https://operator.example.com/kinds/lambda` 等の URL から JSON-LD 文書を返す
   HTTPS endpoint を publish します。 shape は 上記の通り (例として
   [`spec/contexts/kinds/v1/worker.jsonld`](https://github.com/takos/takosumi/blob/main/spec/contexts/kinds/v1/worker.jsonld)
   を参考に)。
2. **plugin で attach** — `packages/plugins/src/kinds/<your-kind>.ts` 相当の
   実装を持つ Deno module を JSR (または npm) に publish し、 operator の
   `factories.ts` から登録します (= 既存 plugin host の機構)。
3. **AppSpec で参照** — App author は `.takosumi.yml` で
   `kind: https://operator.example.com/kinds/lambda` のように full URI を直接
   書けば、 kernel は parser 段階で「URI 形式の kind 名」を accept します。

## kernel が context を resolve する方針

- **起動時 cache のみ** — kernel は built-in kind の `.jsonld` を embed して
  起動時に load します。 operator-defined kind は plugin 登録時に local cache
  に格納されます。
- **fetch のみ** — `@context` URL を opportunistically fetch
  することはありません。 semantic expand / RDF reasoning は行わず、 URI を
  identifier として完全一致 比較で扱います。
- **`@context` は文字列 hint** — JSON-LD parser として動作するわけではないため、
  kind 文書を fetch して読み解く必要は無く、 plugin が提供する TS schema が
  実行時 validate の正本となります。

## Cross-references

- [AppSpec](./app-spec.md) — `.takosumi.yml` の `kind` field が short name と
  full URI の両方を受理する仕様
- [Component Kind Catalog](./component-kind-catalog.md) — 5 built-in kind の
  詳細 schema
- [Plugins extending](../extending.md) — 新 kind / provider 登録の手順
