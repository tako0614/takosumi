# Takosumi Shape / Provider / Template Conventions

このドキュメントは `@takos/takosumi` (本リポジトリ) における **shape catalog**
と **provider plugin**、 **template** の命名・形状規約を定義する RFC である。
既存の `src/shapes/`、`src/shape-providers/`、`src/templates/` および
`src/shape-providers/factories.ts` はこの規約に準拠している。

## 1. Shape catalog principle

- **Takos curates the shape catalog.** Shape (= portable resource shape) は
  Takos ecosystem が ownership を持ち、`takosumi-contract` の
  `Shape<TSpec, TOutputs,
  TCapability>` を満たす形で `src/shapes/`
  に登録する。
- **Third parties extend providers, not shapes.**
  新しいクラウド/ランタイム対応は 既存 shape の `ProviderPlugin` 実装(=
  shape-provider)を増やすことで行う。 shape そのものを増やすのは RFC が必要 (§6
  参照)。
- **Capabilities are advisory metadata.** shape-provider は `capabilities`
  フィールドで自分が提供する optional な機能(versioning / scale-to-zero
  など)を宣言する。 manifest が要求する capability を満たせない provider は
  selection から除外される。

現状の curated shape は 4 つ:

| Shape id            | version | description                                        |
| ------------------- | ------- | -------------------------------------------------- |
| `object-store`      | `v1`    | bucket-style object storage; S3-class API portable |
| `web-service`       | `v1`    | long-running HTTP service backed by an OCI image   |
| `database-postgres` | `v1`    | managed PostgreSQL instance                        |
| `custom-domain`     | `v1`    | DNS + TLS-terminated public domain                 |

## 2. Naming conventions

### Shape id

- kebab-case 名 + `@vN` バージョンサフィックス
- `object-store@v1`, `web-service@v1`, `database-postgres@v1`,
  `custom-domain@v1`
- バージョンは breaking change のたびに整数 increment (`@v2`, `@v3` ...)
- backwards-compatible な capability 追加は同じ `@vN` のまま。capability list が
  open enum であることを利用する。

### Provider id

- kebab-case (`aws-s3`, `cloudflare-r2`, `cloud-run`, `k3s-deployment`,
  `coredns-local`)
- **id にバージョンは含めない**。バージョンは `version` フィールド (semver) で
  管理する。
- provider id は cloud / runtime を必ず最初の token に置く (例: `aws-fargate`
  not `fargate-aws`)。

### Capability

- lowercase kebab-case (`scale-to-zero`, `presigned-urls`, `read-replicas`)
- namespace prefix を付けない (× `aws:scale-to-zero` ✕)。capability semantics は
  shape 側で portable に定義済み。

## 3. Output schema convention

`outputs` (apply の戻り値) は他 resource から `${ref:<resource-name>.<field>}`
で参照されるので、フィールド名と型は shape 全体で揃える。

| Suffix / form        | meaning                                                 |
| -------------------- | ------------------------------------------------------- |
| `*Ref` (string)      | secret reference; `${secret-ref:...}` syntax で resolve |
| `connectionString`   | scheme 付き接続文字列 (`postgresql://...`)              |
| `endpoint`, `url`    | scheme 付き URL (`https://...`, `file://...`)           |
| `internalHost`       | private DNS name (no scheme)                            |
| `internalPort`       | numeric port                                            |
| `bucket`, `database` | non-secret identifier                                   |

### Secret reference syntax

secret 値は raw value ではなく **必ず** reference string で返す:

```text
secret://<provider>/<scope>/<key>
secret://aws/credentials/access-key
secret://gcp/cloud-sql/<instance>/password
```

Reference resolution は kernel 側 secret-store adapter が担当する。
shape-provider は `${secret-ref:...}` syntax を直接生成するのではなく、 output
schema の `*Ref` フィールドに reference URI を入れる。

## 4. How to add a new provider for an existing shape

1. `src/shape-providers/<shape-id>/<provider-id>.ts` に新ファイルを作る。
   既存ファイル (例 `aws-s3.ts`) を参考にすると良い。
2. その shape の `Spec` 型と `Outputs` 型を import
   し、`ProviderPlugin<TSpec,
   TOutputs>` を返す factory 関数を export
   する。capability は `SUPPORTED_CAPABILITIES` 定数で宣言する。
3. lifecycle interface (`<Provider>LifecycleClient`) を同じファイルに定義する。
   テスト用の `InMemory<Provider>Lifecycle` クラスを用意し、real client は
   `factories.ts` 側で wire する。
4. `src/shape-providers/mod.ts` に新 provider を export として追加する。
5. `deno.json` の `exports` に `./shape-providers/<shape>/<provider>`
   エントリを追加する。
6. `tests/shape_provider_<provider>_test.ts` を追加する。最低 3 ケース (apply /
   status / destroy + lifecycle interaction)。
7. cloud 用 production lifecycle が必要なら `src/shape-providers/factories.ts`
   に thin gateway adapter または Deno API adapter を追加する。

## 5. How to RFC a new shape

shape を新設するには ecosystem RFC が必要。以下を 1 つの PR にまとめる:

1. `src/shapes/<shape-id>.ts` に Spec / Outputs / Capability 型と `validateSpec`
   / `validateOutputs` を実装する。
2. `src/shapes/mod.ts` の `TAKOSUMI_BUNDLED_SHAPES` に追加する。
3. その shape を実装する provider を **最低 2 つ** 用意する (portability の
   不変式: 1 shape = ≥ 2 providers)。
4. `tests/shape_<shape-id>_test.ts`, `tests/shape_provider_<provider>_test.ts`
   を整備する。
5. `CONVENTIONS.md` (本ドキュメント) の §1 表を更新する。
6. `takos/docs/` のユーザー向け docs に shape 解説ページを追加する。

shape 追加は contract 側 (`takosumi-contract`) との coordination が必要な
場合があるため、PR description に upstream 影響範囲を明記すること。
