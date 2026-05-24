# コンセプト — AppSpec から Deployment まで {#concepts}

Takosumi は **AppSpec / Installation / Deployment** の 3 つを中心に読むと分かり
やすくなります。provider、runtime-agent、plugin などの実装語彙は、運用や拡張が
必要になってから読めば十分です。

## 3 つの公開概念

| 概念         | 意味                                                                              |
| ------------ | --------------------------------------------------------------------------------- |
| AppSpec      | source root の `.takosumi.yml`。アプリが欲しい runtime / resource / 接続を書く。  |
| Installation | Space に入った AppSpec。Space は operator/account-plane が所有する install 境界。 |
| Deployment   | 1 回の apply / rollback の結果。履歴、audit、rollback の根拠になる。              |

流れは単純です。

```text
source root + AppSpec
  -> install
  -> Installation
  -> apply / rollback
  -> Deployment history
```

## Component と Kind

AppSpec の `components` には runtime や resource の intent を書きます。

```yaml
components:
  api:
    kind: worker
    spec:
      entrypoint: dist/worker.mjs
```

`kind` は component が何であるかを表す string です。`worker`、`web-service`、
`postgres`、`object-store`、`gateway` は takosumi.com が公開する reference kind
descriptor example の short alias です。operator は alias または URI
を解決し、対応する実行先を選びます。

`spec` の中身は kind ごとの入力です。たとえば worker は source snapshot 内の
`entrypoint` path を読み、web-service は container image や port を読む、という
形になります。

## publish / listen

component 間接続は `publish` と `listen` で表します。

```yaml
components:
  db:
    kind: postgres
    spec:
      version: "16"
      size: small
    publish:
      connection:
        as: service-binding

  web:
    kind: worker
    spec:
      entrypoint: dist/worker.mjs
    listen:
      db:
        from: db.connection
        as: env
        prefix: DB
```

producer は local publication を publish します。consumer は
`listen.<name>.from` で `component.publication` を参照し、env / mount / upstream
などの形で受け取ります。AppSpec には `${ref:...}` のような文字列 interpolation
はありません。

operator が Space に公開する外部 material は `namespace:<path>` で参照します。
たとえば OIDC issuer は `namespace:operator.identity.oidc` のように listen
できます。

## Source と prepared source

Takosumi は source root から AppSpec を読みます。Installer API に渡す source は
次の形です。

| Source     | 使いどころ                                                        |
| ---------- | ----------------------------------------------------------------- |
| `git`      | remote operator が git repository を fetch する。                 |
| `prepared` | build service / CI が source tree を tar + sha256 で固定する。    |
| `local`    | dev / operator-local。kernel process から同じ path が見える場合。 |

AppSpec は apply したい intent を書く file です。source を build する場合、build
service / CI / operator automation が先に command を実行し、runtime が読む file
も入れた prepared source snapshot を作ります。

```text
.takosumi.yml
  + optional .takosumi.build.yml
  -> build service / CI
  -> prepared source tar + sha256
  -> Installer API
```

runtime が読む file path は AppSpec の kind-specific `spec` に置きます。build
command や cache、provenance は build service 側の record です。

## Operator implementation は別レイヤ

Takosumi kernel は AppSpec を検証し、Deployment の apply pipeline を進めます。
実際に cloud API や OS を触る処理は operator が用意した implementation に分かれ
ます。

```text
AppSpec source or resolved source snapshot
  -> kernel: validate / plan / record Deployment
  -> operator implementation: kind を具体 runtime/resource に変換
```

Kinds are supplied by the operator. AppSpec author は `kind` / `spec` /
`publish` / `listen` を書き、kind-specific な validation と runtime behavior は
operator が選ぶ descriptor metadata と implementation binding 側で扱います。
JSON-LD descriptor や plugin 配線は、provider / extension を作る段階で読めば十分
です。

## 次に読む

- [読む順序](./reading-paths.md)
- [AppSpec リファレンス](../reference/app-spec.md)
- [Build service handoff](../reference/build-spec.md)
- [Installer API](../reference/installer-api.md)
- [Provider Implementations](../reference/providers.md)
