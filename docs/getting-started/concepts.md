# コンセプト — AppSpec から Deployment まで

Takosumi の公開概念は **AppSpec / Installation / Deployment** の 3 つを中心に
考えると読みやすくなります。細かい ledger や provider の実装詳細は、必要に
なってから reference を読む前提です。

## 3 つの公開概念

| 概念         | 意味                                                                             |
| ------------ | -------------------------------------------------------------------------------- |
| AppSpec      | source root の `.takosumi.yml`。アプリが欲しい runtime / resource / 接続を書く。 |
| Installation | Space に入った AppSpec。現在状態、所有、apply 対象になる単位。                   |
| Deployment   | 1 回の apply / rollback の結果。履歴、audit、rollback の根拠になる。             |

Takosumi は AppSpec を読み、Installation を作り、apply ごとに Deployment を記録
します。

## Component と Kind

AppSpec の `components` には runtime や resource の intent を書きます。

```yaml
components:
  api:
    kind: worker
    spec:
      entrypoint: dist/worker.mjs
```

`kind` は component が何であるかを表す opaque string です。`worker`、
`web-service`、`postgres`、`object-store`、`custom-domain` は takosumi.com
reference kind alias の例で、operator が alias map で URI に解決します。 `spec`
の中身は kind ごとの convention です。

## Build service handoff と Prepared Source

AppSpec は apply できる intent を書く file です。source を build する operator
は `.takosumi.build.yml` のような handoff file を build service に読ませ、
prepared source snapshot を作って Installer API に渡せます。

```
.takosumi.build.yml
  -> build service
  -> prepared source tar + sha256
  -> Installer API
```

この分離により、Deployment は content-addressed prepared source と AppSpec を
元に記録されます。runtime が読む file path は各 kind の `spec` に置きます。

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
      - com.example.notes.db

  web:
    kind: worker
    spec:
      entrypoint: dist/worker.mjs
    listen:
      com.example.notes.db:
        as: env
        prefix: DB
```

producer は namespace path に material を publish します。consumer は同じ path
を listen し、env / mount / target などの形で受け取ります。AppSpec には
`${ref:...}` のような文字列 interpolation はありません。

## Kernel、Implementation、Runtime-Agent {#architecture-kernel-runtime-agent}

Takosumi kernel は AppSpec を検証し、Deployment の apply pipeline を進めます。
実際に cloud API や OS を触る処理は materializer / runtime-agent
側に分かれます。

```
AppSpec source or prepared source snapshot
  -> kernel: validate / plan / record Deployment
  -> materializer: kind を具体 runtime/resource に変換
  -> runtime-agent: cloud API / OS executor
```

dev では `takosumi server` が kernel と embedded runtime-agent を同じ process で
起動できます。production では runtime-agent を別 host に分け、cloud credential
を kernel から離せます。

## Operator の責務

operator は provider implementation、credential、runtime-agent 配置、user
account、OIDC issuer、signup UI との接続を決めます。

AppSpec は portable な intent です。同じ AppSpec をどの provider で実行するかは
operator policy と implementation binding / alias config で決まります。Takosumi
reference kernel では implementation binding array を `plugins` option として
起動時に渡します。

## 次に読む

- [AppSpec リファレンス](/reference/app-spec)
- [Build service handoff](/reference/build-spec)
- [Installer API](/reference/installer-api)
- [Provider Implementations](/reference/providers)
- [Operator Bootstrap](/operator/bootstrap)
