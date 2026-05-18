# Takosumi Component Kind / Provider / Template Conventions

このドキュメントは `@takos/takosumi` (本リポジトリ) における **component kind
catalog** と **provider plugin**、 **template** の命名・形状規約を定義する RFC
である。 既存の `packages/plugins/src/kinds/`、
`packages/plugins/src/bundled/`、 `packages/plugins/src/templates/`
はこの規約に準拠している。

## 1. Component kind catalog principle

- **Component kind catalog は extensible である。** Component kind (= portable
  component contract) は **JSON-LD document** で publish され、 AppSpec parser
  は short alias (= `worker`) と full URI (=
  `https://operator.example.com/kinds/
  lambda`) の両方を受理する。 Takosumi
  curated 4 kind の正本 URI は `https://takosumi.com/kinds/v1/<name>`。 各
  .jsonld は **spec / publishes / listens / outputs を 1 document
  で一体宣言する**。
- **Takosumi が curate するのは 4 kind だけ。** `worker` / `postgres` /
  `object-store` / `custom-domain` の 4 種は本 repo の
  `spec/contexts/kinds/v1/
  *.jsonld` に curated として ship される。 旧 `oidc`
  kind は takosumi-cloud (operator account plane) に移動し、 本 repo には
  JSON-LD も materializer も 持たない。
- **第三者は kind / provider のどちらでも拡張できる。** 新 cloud / runtime 対応
  だけで済む場合は **既存 kind の provider package** を増やす方が軽い。 portable
  resource type そのものが新規の場合は **新 kind を JSON-LD で publish + 任意の
  materializer 形態で実装**する (§6 参照)。
- **Capability は advisory metadata。** materializer は `capabilities`
  フィールド で自分が提供する optional な機能 (versioning / scale-to-zero など)
  を宣言する。 AppSpec が要求する capability を満たせない materializer は
  selection から 除外される。

Takosumi curated kind:

| Kind            | description                                                         |
| --------------- | ------------------------------------------------------------------- |
| `worker`        | serverless HTTP service backed by a JS bundle artifact or image URI |
| `postgres`      | managed PostgreSQL instance                                         |
| `object-store`  | bucket-style object storage; S3-class API portable                  |
| `custom-domain` | DNS + TLS-terminated public domain                                  |

正本 URI は `https://takosumi.com/kinds/v1/<name>` (= JSON-LD で publish)。
operator-defined kind は任意 domain で URI を発行できる (=
`https://operator.
example.com/kinds/lambda` 等)。

## 2. Naming conventions

### Boundary / environment prefix

- New public contract exports, internal route constants, docs, and runtime env
  names use `TAKOSUMI_*` as the canonical prefix.
- Pre-split names such as `TAKOS_PAAS_*` and `TAKOS_RUNTIME_*` are retired from
  the current public contract. New code and new operator docs must not introduce
  them; any internal fixture that mentions them must be explicitly scoped as
  non-operator test debt.
- JSR consumers should pin `jsr:@takos/takosumi-contract@^3.0.0` or newer for
  the v1 AppSpec / Component / Installer API contract.
- Provider proof and live smoke env names use `TAKOSUMI_PLUGIN_*`.
  `TAKOS_PAAS_PLUGIN_*` is retired from current workflow and secret docs.

### Component kind id

- kebab-case short alias (`worker`, `postgres`, `object-store`, `custom-domain`)
- canonical full URI is `https://takosumi.com/kinds/v1/<name>` (JSON-LD) for
  Takosumi curated kinds; operator-defined kind は任意 URI を選べる
- breaking change は新 URI (= v2) を新規発行する (= 同じ short alias に v2 を被
  せない)。 backwards-compatible な capability 追加は同じ URI のまま (capability
  list が open enum であることを利用する)

### Provider id

- kebab-case (`aws-s3`, `cloudflare-r2`, `cloud-run`, `k3s-deployment`,
  `coredns-local`)
- **id にバージョンを含めない**。バージョンは `version` フィールド (semver) で
  管理する。
- provider id は cloud / runtime を必ず最初の token に置く (例: `aws-fargate`
  not `fargate-aws`)。

### Capability

- lowercase kebab-case (`scale-to-zero`, `presigned-urls`, `read-replicas`)
- namespace prefix を付けない (× `aws:scale-to-zero`)
- capability semantics は **kind 側で型定義され、 contract がその source of
  truth**。 各 kind ファイル (`packages/plugins/src/kinds/<kind>.ts`) が
  `WorkerCapability` / `ObjectStoreCapability` 等の string union 型を export
  する。 新 capability の追加はその union への追加 (内部) または kind RFC
  (外部からの提案) を要する。
- provider plugin は `ProviderPlugin<Spec, Outputs, Capability>` の Capability
  generic に kind の union を渡すか、 array literal 末尾に
  `satisfies readonly XxxCapability[]` を付けることで **typo を compile-time に
  reject** できる。 第三者の cloud 拡張 (実験的 capability) は別 union を
  作って同じ `satisfies` で局所的に縛れる。

## 3. Output schema convention

`outputs` (apply の戻り値) は kind の JSON-LD `publishes[]` に登録された
material として namespace registry に publish される。 フィールド名と型は kind
全体で揃える (= 同 kind 内の provider 横断で stable)。

| Suffix / form        | meaning                                                         |
| -------------------- | --------------------------------------------------------------- |
| `*Ref` (string)      | secret reference URI; kernel が secret-store adapter で解決する |
| `connectionString`   | scheme 付き接続文字列 (`postgresql://...`)                      |
| `endpoint`, `url`    | scheme 付き URL (`https://...`, `file://...`)                   |
| `internalHost`       | private DNS name (no scheme)                                    |
| `internalPort`       | numeric port                                                    |
| `bucket`, `database` | non-secret identifier                                           |

### Secret reference syntax

secret 値は raw value ではなく **必ず** reference string で返す:

```text
secret://<provider>/<scope>/<key>
secret://aws/credentials/access-key
secret://gcp/cloud-sql/<instance>/password
```

Reference resolution は kernel 側 secret-store adapter が担当する。 materializer
は output schema の `*Ref` フィールドに reference URI を入れる。 AppSpec 側 (=
`.takosumi.yml`) に raw secret 値も、 placeholder interpolation も登場しない。

## 4. How to add a new provider for an existing kind

operator-facing entry は **`KernelPlugin` plain array** に統一されている。 cloud
provider は独立 package として ship されるため、 新規 cloud / runtime 対応は
対応する provider package の中に factory を追加する形になる:

1. `packages/<cloud>-providers/src/<kind>-<provider>.ts` に `KernelPlugin` を
   返す factory function を書く。 既存ファイル (例
   `packages/cloudflare-
   providers/src/worker-cloudflare.ts`)
   を参考にすると良い。
2. その kind の `Spec` 型と `Outputs` 型を import し、 `ProviderPlugin` を生成
   する factory を書く。 capability は配列 literal に
   `satisfies readonly XxxCapability[]` を付けて compile-time check する。
3. lifecycle interface (`<Provider>LifecycleClient`) を同じファイルに定義する。
   テスト用の `InMemory<Provider>Lifecycle` クラスを用意し、 real client は
   runtime-agent 経由で inject する。
4. `packages/<cloud>-providers/mod.ts` に新 provider factory を export として
   追加する。
5. `packages/<cloud>-providers/tests/<kind>_<provider>_test.ts` を追加する。
   最低 3 ケース (apply / status / destroy + lifecycle interaction)。
6. cloud 用 production lifecycle が必要なら provider factory の opts 引数で
   runtime-agent / cloud client を渡し、 operator が
   `createPaaSApp({ plugins:
   [...] })` で plain array に渡す形を保つ。

新規 cloud ごと package を起こす場合 (例: 新 PaaS) は
`packages/<cloud>-
providers/` を workspace member として deno.json に追加し、
`@takos/takosumi-
<cloud>-providers` で JSR publish する。

## 5. How to RFC a new component kind

新 component kind の追加には ecosystem RFC が必要。 catalog は extensible で、
任意 domain に publish できるが、 **Takosumi curated catalog** (=
`https://takosumi.com/kinds/v1/<name>`) に取り込みたい場合は次の手順:

1. `spec/contexts/kinds/v1/<name>.jsonld` に JSON-LD document を書き、 **spec
   (JSON Schema 2020-12) / publishes / listens / outputs** を一体宣言する。
2. `packages/plugins/src/kinds/<kind>.ts` に Spec / Outputs / Capability 型と
   `validateSpec` / `validateOutputs` を実装する (= JSON-LD spec の TS 等価)。
3. `packages/plugins/src/kinds/mod.ts` の curated kind registry に追加する。
4. その kind を実装する materializer を **最低 2 つ** 用意する (portability の
   不変式: 1 kind = ≥ 2 materializer)。 KernelPlugin factory として該当 cloud
   provider package に追加するか、 operator が inline materializer で書ける
   recipe を提示する。
5. `tests/component_kind_<kind>_test.ts` (spec validate の境界ケース) + 各
   materializer の test を整備する。
6. `CONVENTIONS.md` (本ドキュメント) の §1 表を更新する。
7. `docs/reference/component-kind-catalog.md` のユーザー向け docs に kind 解説
   ページを追加する。

operator-defined kind (= `https://operator.example.com/kinds/<name>`) は
Takosumi curated catalog に取り込まずに任意 domain で publish できる。 この 場合
JSON-LD document を operator が serve し、 materializer を operator 自身が
attach すれば成立する。

## 6. RFC process summary

- **新 component kind の追加は 2 段で成立する**: (1) JSON-LD document を任意
  domain で publish (= kind URI を発行) + (2) **materializer 実装** を operator
  が attach する。 materializer は `KernelPlugin` factory (= cloud provider
  package が export する形) または `createPaaSApp({ materializers: [...] })`
  に渡す **inline 関数** のどちらでも良い。 plugin convention は実装の 1 形態
  に過ぎず、 contract (= input spec validate / output 返却 / publishes register)
  を満たせば形は任意。
- kind 名前空間は `https://takosumi.com/kinds/v1/<name>` (Takosumi curated) と
  operator-defined URI (= `https://operator.example.com/kinds/...`) の 2 種で
  運用される。
- AppSpec parser は short alias (= `worker`) と full URI の両方を受理し、 short
  alias は curated kind に reserve される。
- 既存 kind の breaking change は新 URI を発行する (= v2 として publish)。 short
  alias に v2 を被せない。 capability list は open enum なので追加は
  backwards-compatible。
- workflow / cron / hook は kernel-known kind として **追加しない**。 これらは
  upstream automation の責務 (詳細は
  [Workflow Extension Design](./docs/reference/architecture/workflow-extension-design.md))。
