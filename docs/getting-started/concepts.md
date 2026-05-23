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
      artifact:
        kind: js-bundle
        hash: sha256:...
      compatibilityDate: "2025-01-01"
```

`kind` は component が何であるかを表す opaque string です。Takosumi spec は公式
component kind
を定義しません。`worker`、`web-service`、`postgres`、`object-store`、
`custom-domain` は Takos reference registry の alias で、operator が alias map
で URI に解決した場合だけ意味を持ちます。`spec` の中身は kind ごとの convention
で、AppSpec root の公開 field ではありません。

## BuildSpec と artifact

AppSpec は apply できる intent を書く file で、source を container 内で build
する手順は持ちません。build が必要な source は optional `.takosumi.build.yml`
を置きます。build service は全 build component を batch 実行します。

```
.takosumi.build.yml
  -> build service
  -> current: /v1/artifacts upload
  -> resolved AppSpec bundle
  -> Installer API
```

この分離により、kernel は shell / container 実行を持たず、Deployment では bundle
の AppSpec から digest-pinned build result を参照します。follow-up wave では
plugin が build 後 source snapshot / git state を読む model に寄せます。

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
      artifact:
        kind: js-bundle
        hash: sha256:...
      compatibilityDate: "2025-01-01"
    listen:
      com.example.notes.db:
        as: env
        prefix: DB
```

producer は namespace path に material を publish します。consumer は同じ path
を listen し、env / mount / target などの形で受け取ります。AppSpec には
`${ref:...}` のような文字列 interpolation はありません。

## Kernel、Materializer、Runtime-Agent

Takosumi kernel は AppSpec を検証し、Deployment の apply pipeline を進めます。
実際に cloud API や OS を触る処理は materializer / runtime-agent
側に分かれます。

```
AppSpec source or resolved bundle
  -> kernel: validate / plan / record Deployment
  -> materializer: kind を具体 runtime/resource に変換
  -> runtime-agent: cloud API / OS executor
```

dev では `takosumi server` が kernel と embedded runtime-agent を同じ process で
起動できます。production では runtime-agent を別 host に分け、cloud credential
を kernel から離せます。

## Operator の責務

operator は provider plugin、credential、runtime-agent 配置、外部 identity
surface との接続を決めます。Takosumi kernel 自身は user account、OIDC issuer、
signup UI を所有しません。

AppSpec は portable な intent です。同じ AppSpec をどの provider で実行するかは
operator policy と plugin registry で決まります。

## 次に読む

- [AppSpec リファレンス](/reference/app-spec)
- [BuildSpec リファレンス](/reference/build-spec)
- [Installer API](/reference/installer-api)
- [Provider plugin](/reference/providers)
- [Operator Bootstrap](/operator/bootstrap)
