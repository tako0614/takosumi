# Takosumi Kind / Provider / Template Conventions

このドキュメントは `@takos/takosumi` workspace での operator / reference
implementation 向け convention です。**external component kind descriptor
metadata**、**provider implementation binding**、**template** の命名・形状規約を
まとめます。

`Component.kind` は opaque な non-empty string で、kind の意味は operator
distribution が kind URI、descriptor metadata、TypeScript helper、provider
implementation binding、`kindAliases` map で持ち込みます。
`packages/plugins/spec/kinds/` と `packages/plugins/src/kinds/` は Takosumi
official type catalog の descriptor documents と helper を置く場所です。

build / prepare は source snapshot model で扱うのが current convention
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
- **Kind descriptor metadata は operator tooling の入力。** descriptor metadata
  は spec / publications / listens / outputs / aliases を定義し、docs や
  provider package が参照する。Takosumi official type catalog は JSON-LD
  を使う。
- **Implementation binding が runtime 挙動を持つ。** reusable / public kind は
  URI + descriptor metadata + implementation binding で publish する。private な
  operator-local kind は実装設定や docs で同等の contract を持てばよい。
  Takosumi official type catalog で public に共有する場合は JSON-LD として公開
  する。Takosumi reference kernel では binding を `KernelPlugin` で表すが、
  互換実装は別の registry / controller / adapter へ bind してよい。
- **Capability は advisory metadata。** capability の型や意味は kind descriptor
  metadata または owning package が定義する。

Takosumi official type catalog descriptors:

| Kind           | URI                                          | Description                                        |
| -------------- | -------------------------------------------- | -------------------------------------------------- |
| `worker`       | `https://takosumi.com/kinds/v1/worker`       | HTTP worker from source snapshot + spec.entrypoint |
| `web-service`  | `https://takosumi.com/kinds/v1/web-service`  | OCI container HTTP service                         |
| `postgres`     | `https://takosumi.com/kinds/v1/postgres`     | PostgreSQL instance                                |
| `object-store` | `https://takosumi.com/kinds/v1/object-store` | Bucket-style object storage; S3-class API          |
| `gateway`      | `https://takosumi.com/kinds/v1/gateway`      | HTTP listener, routing, host, and TLS policy       |

These descriptor entries are reusable Takosumi vocabulary. Operators explicitly
choose which entries and aliases are visible in a Space, and can publish their
own catalog on another domain. Takosumi Accounts (= takosumi-cloud operator
account plane) publishes OIDC material through the `operator.identity.oidc`
external publication path.

## 2. Naming Conventions

### Boundary / Environment Prefix

- Public contract exports, operator docs, and documented runtime env names use
  `TAKOSUMI_*` as the canonical prefix.
- Internal route constants / env names may also use `TAKOSUMI_*`, but that does
  not make the internal route or helper a public contract. Internal fixtures
  that mention pre-split names such as `TAKOS_PAAS_*` and `TAKOS_RUNTIME_*` must
  be explicitly scoped as non-operator test debt.
- JSR consumers should pin `jsr:@takos/takosumi-contract@^2.6.0` or newer for
  the v1 AppSpec contract, nested Component type, and Installer API wire DTOs.
- Reference provider integration check env names use `TAKOSUMI_PLUGIN_*`.
  `TAKOS_PAAS_PLUGIN_*` is retired from current workflow and secret docs.

### Component Kind ID

- Prefer kebab-case short aliases for examples (`worker`, `postgres`,
  `object-store`, `gateway`).
- Full kind URI is controlled by the publisher. Takosumi official type catalog
  descriptors use `https://takosumi.com/kinds/v1/<name>`; operator-defined kind
  は任意 URI を 選べる。
- Short aliases are operator mappings. They resolve when the operator maps them
  to URI through `kindAliases`.
- Breaking change は新 URI (= v2) を新規発行する。同じ alias に別 semantics を
  黙って被せない。backwards-compatible な capability 追加は同じ URI のままでも
  よい。

### Provider ID

- provider id は scoped stable id を使う (例: `@takos/aws-s3`,
  `@takos/cloudflare-r2`, `@takos/gcp-cloud-run`)。
- **version は `version` フィールド (semver) で管理する**。provider id は stable
  name にする。
- scope の後ろは cloud / runtime を最初の token に置く (例:
  `@takos/aws-fargate`)。

### Capability

- lowercase kebab-case (`scale-to-zero`, `presigned-urls`, `read-replicas`)
- colon-scoped prefix を付けない (× `aws:scale-to-zero`)
- reference provider binding は capability 配列 literal に
  `satisfies readonly XxxCapability[]` を付けることで typo を compile-time に
  reject できる。第三者の cloud 拡張は別 union を作って同じ `satisfies` で
  局所的に縛れる。

## 3. Output Schema Convention

reference provider outputs は kind descriptor metadata の `publications`
に登録された material として local publication に投影される。public Deployment
`outputs` は descriptor が定義した JSON material であり、descriptor 外の
provider private field は含めない。フィールド名と型は同じ kind URI の provider
横断で stable にする。

| Suffix / form        | meaning                                                           |
| -------------------- | ----------------------------------------------------------------- |
| `*Ref` (string)      | secret reference URI; kernel が secret-store adapter で解決する   |
| `connectionString`   | passwordless / client-safe DSN。credential は `*SecretRef` で渡す |
| `endpoint`, `url`    | scheme 付き URL (`https://...`, `file://...`)                     |
| `internalHost`       | private DNS name (no scheme)                                      |
| `internalPort`       | numeric port                                                      |
| `bucket`, `database` | non-secret identifier                                             |

### Secret Reference Syntax

reference provider output が secret を返す場合、secret 値は raw value ではなく
**必ず** reference string で返す:

```text
secret://<provider>/<scope>/<key>
secret://aws/credentials/access-key
secret://gcp/cloud-sql/<instance>/password
```

Reference resolution は operator secret-store adapter が担当する。materializer
は output schema の `*Ref` フィールドに reference URI を入れる。AppSpec 側 (=
`.takosumi.yml`) に raw secret 値も、placeholder interpolation も登場しない。

## 4. How To Add A Provider For An Existing Kind

Takosumi reference kernel の operator-facing implementation binding は
**`KernelPlugin` plain array** です。この節は reference provider packages に
contribution する場合の手順です。external / operator-owned provider は任意の
repo、package scope、private distribution、native controller に置けます。
reference provider package に追加する場合は次の形に揃えます:

1. 対象 kind URI を選ぶ。Takosumi official type catalog descriptor なら
   `@takos/takosumi-plugins/kinds` の `TAKOSUMI_REFERENCE_KIND_URIS` を使う。
2. `packages/<cloud>-providers/src/<kind>-<provider>.ts` に `KernelPlugin` を
   返す factory function を書く。既存ファイル (例
   `packages/cloudflare-providers/src/worker-cloudflare.ts`) を参考にする。
3. その kind の `Spec` 型と `Outputs` 型を descriptor owner / owning package
   から import する。private operator-owned kind では provider package と
   descriptor owner を同じ repository に co-locate してよいが、責務名は
   descriptor owner として扱う。
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

External kind は任意 domain の URI で publish できる。Takosumi official type
catalog に取り込む場合だけ project governance / review を通す。

1. URI を決める。operator-owned kind は任意 domain を使う
   (`https://operator.example.com/kinds/lambda` など)。
2. descriptor metadata を用意する。Takosumi official type catalog に追加する場
   合は JSON-LD として `packages/plugins/spec/kinds/v1/<name>.jsonld` に置く。
3. `Spec` / `Outputs` / `Capability` 型と validator を owning package に置く。
   Takosumi official type catalog に追加する場合は `packages/plugins/src/kinds/`
   に置く。
4. implementation binding を用意する。Takosumi reference kernel では
   `KernelPlugin` factory を用意する。
5. Descriptor lint、validator test、implementation lifecycle test、docs
   を追加する。
6. short alias を使わせる場合は operator distribution が `kindAliases` map に
   alias → URI を追加する。

## 6. Process Summary

- 新 component kind は **URI + descriptor metadata + implementation binding** で
  publish する。Takosumi official type catalog は JSON-LD を使う。
- `https://takosumi.com/kinds/v1/*` は Takosumi official type catalog descriptor
  documents。
- AppSpec parser は `kind` を non-empty string として受理する。alias resolution
  と provider selection は operator の implementation binding が担う。Takosumi
  reference kernel では `kindAliases` / implementation binding array (`plugins`
  option) で渡す。
- workflow / cron / hook は upstream automation の責務 (詳細は
  [Workflow Extension Design](./docs/reference/architecture/workflow-extension-design.md))。
