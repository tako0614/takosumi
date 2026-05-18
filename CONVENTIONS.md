# Takosumi Component Kind / Provider / Template Conventions

このドキュメントは `@takos/takosumi` (本リポジトリ) における **component kind
catalog** と **provider plugin**、 **template** の命名・形状規約を定義する RFC
である。 既存の `packages/plugins/src/kinds/`、 `packages/plugins/src/bundled/`、
`packages/plugins/src/templates/` はこの規約に準拠している。

## 1. Component kind catalog principle

- **Takosumi が component kind catalog を所有する。** Component kind (= portable
  component contract) は Takosumi contract / kernel が ownership を持ち、
  `takosumi-contract` の `ComponentKind<TSpec, TOutputs, TCapability>` を満たす
  形で `packages/plugins/src/kinds/` に登録する。
- **第三者は provider を拡張する (kind を増やすのではなく)。** 新しいクラウド /
  ランタイム対応は **既存 kind の provider plugin** を増やすことで行う。 新 kind
  そのものを増やすのは RFC が必要 (§6 参照)。
- **Capability は advisory metadata。** provider plugin は `capabilities`
  フィールドで自分が提供する optional な機能 (versioning / scale-to-zero など)
  を宣言する。 AppSpec が要求する capability を満たせない provider は selection
  から除外される。

現状の curated kind は **5 種で frozen**:

| Kind            | description                                              |
| --------------- | -------------------------------------------------------- |
| `object-store`  | bucket-style object storage; S3-class API portable       |
| `worker`        | serverless HTTP service backed by a JS bundle or image   |
| `postgres`      | managed PostgreSQL instance                              |
| `custom-domain` | DNS + TLS-terminated public domain                       |
| `oidc`          | OIDC consumer mount point (Installation-scoped client)   |

正本 URI は `https://takosumi.com/kinds/v1/<name>` (= JSON-LD で publish)。
AppSpec parser は short name (= `worker`) と full URI (=
`https://operator.example.com/kinds/lambda` 等の operator-defined kind)
の両方を受理する。

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

- kebab-case short name (`object-store`, `worker`, `postgres`, `custom-domain`,
  `oidc`)
- canonical full URI is `https://takosumi.com/kinds/v1/<name>` (JSON-LD)
- breaking change は新 URI (= v2) を新規発行する (= 同じ short name に v2 を被
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

`outputs` (apply の戻り値) は `use:` edge で他 component に注入されるので、
フィールド名と型は kind 全体で揃える。

| Suffix / form        | meaning                                                          |
| -------------------- | ---------------------------------------------------------------- |
| `*Ref` (string)      | secret reference URI; kernel が secret-store adapter で解決する  |
| `connectionString`   | scheme 付き接続文字列 (`postgresql://...`)                       |
| `endpoint`, `url`    | scheme 付き URL (`https://...`, `file://...`)                    |
| `internalHost`       | private DNS name (no scheme)                                     |
| `internalPort`       | numeric port                                                     |
| `bucket`, `database` | non-secret identifier                                            |

### Secret reference syntax

secret 値は raw value ではなく **必ず** reference string で返す:

```text
secret://<provider>/<scope>/<key>
secret://aws/credentials/access-key
secret://gcp/cloud-sql/<instance>/password
```

Reference resolution は kernel 側 secret-store adapter が担当する。 provider
plugin は output schema の `*Ref` フィールドに reference URI を入れる。 AppSpec
側 (= `.takosumi.yml`) に raw secret 値も `${secret-ref:...}` interpolation も
登場しない。

## 4. How to add a new provider for an existing kind

operator-facing entry は **`KernelPlugin` plain array** に統一されている。
provider 追加は次の手順に従う:

1. `packages/plugins/src/bundled/<kind>-<provider>.ts` に `KernelPlugin` を返す
   factory function を書く。 既存ファイル (例 `worker-cloudflare.ts`) を参考に
   すると良い。
2. その kind の `Spec` 型と `Outputs` 型を import し、 `ProviderPlugin` を生成
   する factory を書く。 capability は配列 literal に
   `satisfies readonly XxxCapability[]` を付けて compile-time check する。
3. lifecycle interface (`<Provider>LifecycleClient`) を同じファイルに定義する。
   テスト用の `InMemory<Provider>Lifecycle` クラスを用意し、 real client は
   runtime-agent 経由で inject する。
4. `packages/plugins/src/bundled/mod.ts` に新 provider factory を export として
   追加する。
5. `tests/bundled_<kind>_<provider>_test.ts` を追加する。 最低 3 ケース (apply /
   status / destroy + lifecycle interaction)。
6. cloud 用 production lifecycle が必要なら provider factory の opts 引数で
   runtime-agent / cloud client を渡し、 operator が `createPaaSApp({ plugins:
   [...] })` で plain array に渡す形を保つ。

## 5. How to RFC a new component kind

新 component kind の追加には ecosystem RFC が必要。 以下を 1 つの PR にまとめる:

1. `packages/plugins/src/kinds/<kind>.ts` に Spec / Outputs / Capability 型と
   `validateSpec` / `validateOutputs` を実装する。
2. `packages/plugins/src/kinds/mod.ts` の bundled kind registry に追加する。
3. その kind を実装する provider を **最低 2 つ** 用意する (portability の
   不変式: 1 kind = ≥ 2 providers)。
4. `tests/component_kind_<kind>_test.ts`, `tests/bundled_<kind>_<provider>_test.ts`
   を整備する。
5. `CONVENTIONS.md` (本ドキュメント) の §1 表を更新する。
6. `docs/reference/component-kind-catalog.md` のユーザー向け docs に kind 解説
   ページを追加する。
7. JSON-LD kind catalog (`spec/contexts/kinds/v1/<name>.jsonld`) を publish する
   (= `https://takosumi.com/kinds/v1/<name>` で fetch 可能にする)。

kind 追加は contract 側 (`takosumi-contract`) との coordination が必要な
場合があるため、 PR description に upstream 影響範囲を明記すること。

## 6. RFC process summary

- 新 component kind は **JSON-LD で URI publish + plugin で provider 実装** の
  2 段を踏む。 kind 名前空間は `https://takosumi.com/kinds/v1/<name>` (Takosumi
  curated) と operator-defined URI (= `https://operator.example.com/kinds/...`)
  の 2 種で運用される。
- AppSpec parser は short name (= `worker`) と full URI の両方を受理し、 short
  name は bundled kind に reserve される。
- 既存 kind の breaking change は新 URI を発行する (= v2 として publish)。
  short name に v2 を被せない。
- workflow / cron / hook は kernel-known kind として **追加しない**。 これらは
  upstream automation の責務 (詳細は
  [Workflow Extension Design](./docs/reference/architecture/workflow-extension-design.md))。
