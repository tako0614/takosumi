# Quickstart — first install まで

このページでは、CLI を入れて `.takosumi.yml` を作り、最初の Installation を作る
ところまで進めます。Takosumi の概念を先に読みたい場合は
[コンセプト](./concepts.md) を参照してください。

## 1. CLI を入れる

```bash
deno install -gA -n takosumi jsr:@takos/takosumi-cli
takosumi version
```

## 2. AppSpec を置く

source root に `.takosumi.yml` を作ります。AppSpec root は
`apiVersion`、`metadata`、`components` の 3 field だけです。

```yaml
apiVersion: v1
metadata:
  id: com.example.hello
  name: hello
components:
  web:
    kind: worker
    spec:
      artifact:
        kind: js-bundle
        hash: sha256:...
      compatibilityDate: "2025-01-01"
```

`kind: worker` は Takos reference registry の alias 例です。Takosumi spec
自体は公式 component kind を定義せず、operator が alias map で URI に解決した
場合だけ意味を持ちます。AppSpec contract 自体が持つ component field は
`kind`、`spec`、 `publish`、`listen` です。source から artifact
を作る場合は、AppSpec ではなく [BuildSpec](/reference/build-spec) と build
service に置きます。

上の `sha256:...` は build service / CI が artifact upload 後に resolved bundle
へ記録する digest です。

## 3. local install を試す

まず dry-run で AppSpec と source を検証します。

```bash
takosumi install dry-run --space space_personal --source .
```

問題がなければ Installation を作ります。

```bash
takosumi install --space space_personal --source .
```

local mode では CLI が in-process kernel を使います。remote kernel に投げる場合
は URL と token を明示します。

```bash
export TAKOSUMI_REMOTE_URL=http://localhost:8788
export TAKOSUMI_INSTALLER_TOKEN=$(openssl rand -hex 32)

TAKOSUMI_DEV_MODE=1 takosumi server --port 8788 &
takosumi install --space space_personal --source .
```

`TAKOSUMI_DEV_MODE=1` は dev 専用です。plaintext secret storage や unsafe
default を許可するため、production / staging では使いません。

## 4. component を接続する

component 間の依存は `publish` と `listen` で書きます。文字列 interpolation や
旧 `use:` edge は使いません。

```yaml
apiVersion: v1
metadata:
  id: com.example.notes
  name: notes
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
    listen:
      com.example.notes.db:
        as: env
        prefix: DB
    spec:
      artifact:
        kind: js-bundle
        hash: sha256:...
      compatibilityDate: "2025-01-01"
```

`db` が namespace path に material を publish し、`web` が同じ path を listen
します。material を env / mount / target のどれで注入するかは `listen` 側で
明示します。

## 次に読む

- [コンセプト](./concepts.md)
- [AppSpec リファレンス](/reference/app-spec)
- [BuildSpec リファレンス](/reference/build-spec)
- [Provider plugin](/reference/providers)
- [Operator Bootstrap](/operator/bootstrap)
