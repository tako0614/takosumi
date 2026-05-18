# AppSpec Dependency Semantics

> このページでわかること: current AppSpec の component dependency / binding
> semantics。 component 間の接続は **`publish` / `listen` edge のみ**
> で表現する。 旧 `use:` edge / `${ref:...}` placeholder 文法は current public
> AppSpec には存在しない。

## Source form

AppSpec は `.takosumi.yml` の `components` map だけを public dependency source
として扱う。 component 間の依存は **`publish` (= 自分が出す material) と
`listen` (= 他 component の material を受け取る)** の 2 つの edge で明示する。

```yaml
components:
  db:
    kind: postgres
    spec:
      version: "16"
      size: small
    publish:
      - com.example.notes.db

  assets:
    kind: object-store
    spec:
      name: notes-assets
    publish:
      - com.example.notes.assets

  web:
    kind: worker
    build:
      command: npm ci && npm run build
      output: dist/worker.mjs
    listen:
      com.example.notes.db:
        as: env
        prefix: DATABASE_
      com.example.notes.assets:
        as: env
        prefix: ASSETS_
```

### `publish`

`publish` value は namespace registry に登録する path の **配列** で、 component
が apply 後に返す `outputs` (= kind JSON-LD の `publishes[]` で宣言された
material) がその path に publish される。 同 AppSpec 内の他 component から
listen することも、 cross-installation で operator account plane (= Takosumi
Accounts) から listen することも、 同じ path 表現で扱える。

### `listen`

`listen` の key は publish 側の namespace path。 value は consumer 側の binding
rule で、 current v1 は次を持つ:

| Field    | Meaning                                                               |
| -------- | --------------------------------------------------------------------- |
| `as`     | `env` / `mount` / `target` のいずれか (= projection 形式)             |
| `prefix` | `as: env` のとき、 env 名を `${PREFIX}<FIELD>` に変換する文字列       |
| `mount`  | reserved mount point identifier (= kind 側で reserve した short name) |

`as: env` は producer の outputs map を `${PREFIX}<FIELD>` env vars として
注入する。 `as: target` は upstream worker の URL を custom-domain の target
として使う形 (= ingress projection)。

## Validation

installer / kernel は AppSpec parse 時に publish / listen graph を作る。

- `listen` の path は **同じ AppSpec の `publish` にあるか、 operator plane の
  reserved path** に一致しなければならない。
- self-reference (= 同 component の publish path を listen) は禁止。
- cycle は禁止 (= component を node、 publish → listen を edge とする DAG)。
- `listen.<path>.mount` は kind の reserved mount short name にのみ使える。
- 旧 `use:` edge / `${ref:...}` / `${secret-ref:...}` / `${bindings.*}` /
  `${secrets.*}` / `${installation.*}` / `${artifacts.*}` / `${params.*}` は
  current AppSpec では invalid syntax (= parser が reject)。

validation error は apply 前に surface し、 resource は materialize されない。

## Apply order

apply pipeline は publish / listen graph から topological order を決める。 独立
component は並行実行できるが、 listen 側 component は publish 側 outputs が
確定した後に materialize される。

provider output は raw string interpolation ではなく、 listen binding rule に
従って runtime desired state に注入される。 secret raw value は AppSpec に
戻さない。 provider が secret を出す場合は secret-store boundary を通した
reference (= `secret://...`) として扱い、 worker runtime 側で adapter が
解決する。

## Cross-space / operator plane

current AppSpec の listen path は同 AppSpec の publish path に閉じる必要はなく、
**operator account plane が publish する reserved path** (=
`operator.identity.
oidc` 等) も listen できる。 例えば Takosumi Accounts
(takosumi-cloud) が `operator.identity.oidc` namespace path に OIDC client
material を publish し、 worker は `listen.operator.identity.oidc` で
`OIDC_ISSUER_URL` / `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` /
`OIDC_REDIRECT_URIS` を受け取る。

Space 間共有は AppSpec placeholder ではなく、 Namespace Export / Binding
contract の責務。

## Related architecture notes

- [Manifest Validation](/reference/manifest-validation)
- [AppSpec](/reference/app-spec)
- [Namespace Exports](/reference/namespace-exports)
- [OperationPlan / WAL](/reference/architecture/operation-plan-write-ahead-journal-model)
- [Closed Enums](/reference/closed-enums)
