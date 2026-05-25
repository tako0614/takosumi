# コンセプト — AppSpec から Deployment まで {#concepts}

Takosumi は、source root の `.takosumi.yml` を Space に install し、apply
の結果を Deployment として記録します。最初は AppSpec / Installation / Deployment
の 3 つだけを押さえると全体像を追えます。

AppSpec は source に入る宣言ファイルです。Installer API は AppSpec source を
operator-supplied `spaceId` の文脈で評価し、Installation / Deployment record を
残します。operator は Space、account、policy、billing、domain ownership、
provider credential と account-facing projection を扱います。

## 3 つの公開概念

| 概念         | 意味                                                                             | 詳細                                                                              |
| ------------ | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| AppSpec      | source root の `.takosumi.yml`。アプリが欲しい runtime / resource / 接続を書く。 | component の `kind` / `spec` / `publish` / `listen` で intent を宣言する。        |
| Installation | operator-supplied `spaceId` に scoped された AppSpec の core record。            | 作成は Installer API の `POST /v1/installations`。                                |
| Deployment   | 1 回の apply 結果。履歴、audit、rollback の根拠になる。                          | 成功・失敗を問わず全 apply が記録される。rollback は retained Deployment へ戻す。 |

```text
source root + AppSpec
  -> install
  -> Installation
  -> apply / deploy update
  -> Deployment history
  -> rollback to retained Deployment
```

kernel Installer API は source と AppSpec を評価して Installation / Deployment
record を残します。operator account plane は account / Space membership と
account-facing ownership projection を持ちます。rollback は retained Deployment
への current pointer move です。

Space は operator account plane が提供する install scope です。Installer API は
`spaceId` を context として扱い、AppSpec source を Deployment record にします。

## 仕様の分かれ方

Takosumi core、Takosumi official type catalog、operator distribution は別の
仕様面です。Takosumi 本体仕様と公式型仕様はこの docs site に置き、Cloud など
operator 固有の account-plane 仕様はその operator docs に置きます。

| 仕様面                         | 何を決めるか                                                                      |
| ------------------------------ | --------------------------------------------------------------------------------- |
| Takosumi core                  | AppSpec / Installation / Deployment、Installer API、publish/listen grammar。      |
| Takosumi official type catalog | kind descriptor、material contract、projection family、JSON-LD catalog metadata。 |
| Operator distribution          | account-plane、dashboard、billing、identity、deploy/admin facade。                |

境界を先に確認したい場合は
[Specification Boundaries](../reference/spec-boundaries.md) を読んでください。

## Component と Kind

以下の例は operator profile が `worker` alias を kind URI に map している前提
です。別 operator では異なる alias または URI を使えます。

```yaml
components:
  api:
    kind: worker
    spec:
      entrypoint: src/worker.ts
```

`kind` は opaque string。short alias は operator が URI に解決する。 `spec` は
kind ごとの入力。worker なら `entrypoint`、web-service なら `image`、`port`、
`scale`。

Kind 周辺の語は次の順で読むと迷いません。

1. AppSpec author は `kind` string を書く。
2. operator は short alias または URI を kind URI に解決する。
3. descriptor はその kind の input schema、publication、output を説明する。
4. material contract は `publish.<name>.as` が offer する bindable output の型。
5. implementation binding は descriptor / material contract を provider runtime
   や resource に変換する operator 側の実装。

## publish / listen

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
      entrypoint: src/worker.ts
    listen:
      db:
        from: db.connection
        as: secret-env
        prefix: DB
```

producer は `publish` で local publication を定義。consumer は
`listen.<binding>.from` で参照し、`as` で注入形式（secret-env / env /
config-mount / upstream）を指定する。

operator が提供する
[external publication](../reference/external-publications.md) は external
publication path で listen する。path は operator distribution spec が決め、
material contract は type catalog が決める。

## Source

Installer API は source を `git`、dev/operator-local の `local` path、または
build service / CI が作った `prepared` archive として受け取ります。AppSpec は
runtime/install intent だけを書き、build command や container build recipe は
build service / CI の責務に置く。runtime が読む file path や provider が使う
image reference は kind-specific `spec` に残します。

build handoff の詳細は [Build service handoff](../reference/build-spec.md)。

## 実行先は operator が選ぶ

```text
AppSpec source
  -> kernel: validate / plan / record Deployment
  -> operator-selected provider/runtime: kind を具体 runtime/resource に変換
```

公開概念は AppSpec / Installation / Deployment です。public Installer API は
dry-run / install / deploy dry-run / deploy / rollback の 5 endpoint です。
component の `kind` をどの runtime / resource に割り当てるかは、 operator が
catalog と policy で決めます。

runtime HTTP exposure を出す場合も同じ AppSpec model を使います。workload が
`http-endpoint` material を `publish` し、`gateway` のような ingress component
が `listen` して provider-native ingress を作ります。runtime request は kernel
Installer API を経由しません。詳細は
[HTTP Exposure](../reference/http-exposure.md)。

## 次に読む

- [クイックスタート](./quickstart.md)
- [AppSpec リファレンス](../reference/app-spec.md)
- [読む順序](./reading-paths.md)
