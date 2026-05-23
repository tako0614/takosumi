# Takosumi Kind / Provider / Template Conventions

このドキュメントは `@takos/takosumi` workspace での **external component kind
descriptor**、**provider implementation adapter**、**template** の命名・形状規約
をまとめる reference convention です。

`Component.kind` は opaque な non-empty string で、kind の意味は operator
distribution が JSON-LD descriptor、TypeScript helper、provider implementation
binding、`kindAliases` map で持ち込みます。`packages/plugins/spec/kinds/` と
`packages/plugins/src/kinds/` は takosumi.com reference descriptor examples
です。

`Component.build` は削除済みで、source snapshot model が current convention
です。詳細 design は
[`docs/rfc/0001-kernel-kind-agnostic.md`](docs/rfc/0001-kernel-kind-agnostic.md)。

## 1. Kind Definition Principle

- **Kind は operator が解決する。** AppSpec parser は `worker` のような short
  alias と `https://operator.example.com/kinds/lambda` のような full URI を
  どちらも文字列として受理する。runtime 意味は operator の implementation
  binding が与える。
- **Alias resolution は operator-owned。** `worker` などの short alias は
  reference kernel では `createPaaSApp({ kindAliases, plugins })` に渡された map
  で URI に解決される。未解決 alias は provider operation の前に fail-closed
  する。
- **Kind descriptor は operator tooling の入力。** JSON-LD descriptor は spec /
  publishes / listens / outputs / aliases を説明し、docs や provider package
  が参照する。
- **Materializer 実装が runtime 意味を持つ。** 新 kind は任意 domain の URI +
  optional descriptor + implementation binding で成立する。Takosumi reference
  kernel では binding を `KernelPlugin` adapter で表す。
- **Capability は advisory metadata。** capability の型や意味は kind descriptor
  または owning package が定義する。

takosumi.com reference descriptors:

| Kind            | URI                                           | Description                                       |
| --------------- | --------------------------------------------- | ------------------------------------------------- |
| `worker`        | `https://takosumi.com/kinds/v1/worker`        | HTTP worker from preparedSource + spec.entrypoint |
| `web-service`   | `https://takosumi.com/kinds/v1/web-service`   | OCI container HTTP service                        |
| `postgres`      | `https://takosumi.com/kinds/v1/postgres`      | PostgreSQL instance                               |
| `object-store`  | `https://takosumi.com/kinds/v1/object-store`  | Bucket-style object storage; S3-class API         |
| `custom-domain` | `https://takosumi.com/kinds/v1/custom-domain` | DNS + TLS-terminated public domain                |

These descriptors are reference examples for operator distributions. Takosumi
Accounts (= takosumi-cloud operator account plane) publishes OIDC material
through its namespace publisher.

## 2. Naming Conventions

### Boundary / Environment Prefix

- New public contract exports, internal route constants, docs, and runtime env
  names use `TAKOSUMI_*` as the canonical prefix.
- Current public contract exports, operator docs, and runtime env names use
  `TAKOSUMI_*`. Internal fixtures that mention pre-split names such as
  `TAKOS_PAAS_*` and `TAKOS_RUNTIME_*` must be explicitly scoped as non-operator
  test debt.
- JSR consumers should pin `jsr:@takos/takosumi-contract@^3.0.0` or newer for
  the v1 AppSpec / Component / Installer API contract.
- Provider proof and live smoke env names use `TAKOSUMI_PLUGIN_*`.
  `TAKOS_PAAS_PLUGIN_*` is retired from current workflow and secret docs.

### Component Kind ID

- Prefer kebab-case short aliases for examples (`worker`, `postgres`,
  `object-store`, `custom-domain`).
- Full kind URI is controlled by the publisher. takosumi.com reference
  descriptors use `https://takosumi.com/kinds/v1/<name>`; operator-defined kind
  は任意 URI を 選べる。
- Short aliases are operator mappings. They resolve when the operator maps them
  to URI through `kindAliases`.
- Breaking change は新 URI (= v2) を新規発行する。同じ alias に別 semantics を
  黙って被せない。backwards-compatible な capability 追加は同じ URI のままでも
  よい。

### Provider ID

- kebab-case (`aws-s3`, `cloudflare-r2`, `cloud-run`, `k3s-deployment`,
  `coredns-local`)
- **version は `version` フィールド (semver) で管理する**。provider id は stable
  name にする。
- provider id は cloud / runtime を必ず最初の token に置く (例: `aws-fargate`
  not `fargate-aws`)。

### Capability

- lowercase kebab-case (`scale-to-zero`, `presigned-urls`, `read-replicas`)
- namespace prefix を付けない (× `aws:scale-to-zero`)
- reference provider adapter は capability 配列 literal に
  `satisfies readonly XxxCapability[]` を付けることで typo を compile-time に
  reject できる。第三者の cloud 拡張は別 union を作って同じ `satisfies` で
  局所的に縛れる。

## 3. Output Schema Convention

`outputs` (apply の戻り値) は kind descriptor の `publishes[]` に登録された
material として namespace registry に publish される。フィールド名と型は同じ
kind URI の provider 横断で stable にする。

| Suffix / form        | meaning                                                         |
| -------------------- | --------------------------------------------------------------- |
| `*Ref` (string)      | secret reference URI; kernel が secret-store adapter で解決する |
| `connectionString`   | scheme 付き接続文字列 (`postgresql://...`)                      |
| `endpoint`, `url`    | scheme 付き URL (`https://...`, `file://...`)                   |
| `internalHost`       | private DNS name (no scheme)                                    |
| `internalPort`       | numeric port                                                    |
| `bucket`, `database` | non-secret identifier                                           |

### Secret Reference Syntax

secret 値は raw value ではなく **必ず** reference string で返す:

```text
secret://<provider>/<scope>/<key>
secret://aws/credentials/access-key
secret://gcp/cloud-sql/<instance>/password
```

Reference resolution は kernel 側 secret-store adapter が担当する。materializer
は output schema の `*Ref` フィールドに reference URI を入れる。AppSpec 側 (=
`.takosumi.yml`) に raw secret 値も、placeholder interpolation も登場しない。

## 4. How To Add A Provider For An Existing Kind

Takosumi reference kernel の operator-facing entry は **`KernelPlugin` plain
array** です。cloud provider は独立 package として ship されるため、新規 cloud /
runtime 対応は対応する provider package の中に factory を追加する形になる:

1. 対象 kind URI を選ぶ。takosumi.com reference descriptor なら
   `@takos/takosumi-plugins/kinds` の `TAKOSUMI_REFERENCE_KIND_URIS` を使う。
2. `packages/<cloud>-providers/src/<kind>-<provider>.ts` に `KernelPlugin` を
   返す factory function を書く。既存ファイル (例
   `packages/cloudflare-providers/src/worker-cloudflare.ts`) を参考にする。
3. その kind の `Spec` 型と `Outputs` 型を owning package から import する。
   operator-defined kind なら provider package 内で型と validator を持ってよい。
4. lifecycle interface (`<Provider>LifecycleClient`) を同じファイルに定義する。
   テスト用の `InMemory<Provider>Lifecycle` クラスを用意し、real client は
   runtime-agent 経由で inject する。
5. `packages/<cloud>-providers/mod.ts` に新 provider factory を export として
   追加する。
6. `packages/<cloud>-providers/tests/<kind>_<provider>_test.ts` を追加する。
   最低 3 ケース (apply / status / destroy + lifecycle interaction)。
7. operator docs では reference kernel の
   `createPaaSApp({ kindAliases, plugins: [...] })` に attach する例を示す。

新規 cloud ごと package を起こす場合 (例: 新 PaaS) は
`packages/<cloud>-providers/` を workspace member として deno.json に追加し、
`@takos/takosumi-<cloud>-providers` で JSR publish する。

## 5. How To Publish A New Component Kind

External kind は任意 domain の URI で publish できる。takosumi.com reference
descriptors に取り込む場合だけ project governance / review を通す。

1. URI を決める。operator-owned kind は任意 domain を使う
   (`https://operator.example.com/kinds/lambda` など)。
2. JSON-LD descriptor を publish する。takosumi.com reference descriptors
   に追加する場合は `packages/plugins/spec/kinds/v1/<name>.jsonld` に置く。
3. `Spec` / `Outputs` / `Capability` 型と validator を owning package に置く。
   takosumi.com reference descriptors に追加する場合は
   `packages/plugins/src/kinds/` に置く。
4. implementation binding を用意する。Takosumi reference kernel では
   `KernelPlugin` factory を用意する。
5. Descriptor lint、validator test、provider lifecycle test、docs を追加する。
6. short alias を使わせる場合は operator distribution が `kindAliases` map に
   alias → URI を追加する。

## 6. Process Summary

- 新 component kind は **URI + optional JSON-LD descriptor + implementation
  binding** で成立する。
- `https://takosumi.com/kinds/v1/*` は takosumi.com reference descriptors。
- AppSpec parser は `kind` を non-empty string として受理する。alias resolution
  と provider selection は operator の implementation binding が担う。Takosumi
  reference kernel では `kindAliases` / `plugins` で渡す。
- workflow / cron / hook は kernel-known kind として **追加しない**。これらは
  upstream automation の責務 (詳細は
  [Workflow Extension Design](./docs/reference/architecture/workflow-extension-design.md))。
