# Build Service Handoff (`.takosumi.build.yml`) {#buildspec-takosumi-build-yml}

このページは、operator build service が prepared source snapshot を作るための
handoff convention です。Takosumi の public lifecycle は AppSpec / Installation
/ Deployment と Installer API で進み、`.takosumi.build.yml` の parser / runner
は operator distribution が持ちます。

build service / CI / operator automation が `.takosumi.yml` と
`.takosumi.build.yml` を読み、必要な command を実行し、最後に **prepared source
snapshot** を Installer API に渡します。kernel は Installer API に渡された
source snapshot と AppSpec を処理します。

## Example input shape

この convention の build service input は AppSpec と似た minimal envelope を
使います。

```yaml
apiVersion: v1
metadata:
  id: com.example.notes.build
  name: Example Notes build
components:
  web:
    kind: linux-container
    spec:
      image: ghcr.io/example/build-node@sha256:...
      command: npm ci && npm run build
```

| Field        | Required | 説明                                                  |
| ------------ | -------- | ----------------------------------------------------- |
| `apiVersion` | yes      | build service input convention version。値は `v1`。   |
| `metadata`   | yes      | build input 自体の id / name。                        |
| `components` | yes      | build service が実行または解決する component の map。 |

この convention で build service が読む component field は `kind` / `spec` /
`publish` / `listen` です。`kind` の意味と `spec` の中身は build service
distribution が決めます。build service distribution が operator-defined build
kind descriptor set / convention を持ちます。

`publish` / `listen` は build-only namespace です。AppSpec runtime namespace と
混ざらず、build service は `listen` edge から build DAG を作ります。cycle、
unresolved build output、または build material の型不一致は fail-closed です。
`publish` が表す material は build service owned で、prepared source 内の file /
directory、build-local env、cache key などを含められます。

## Linux Container Example

`linux-container` は reference build kind の一例です。Linux container image
の中で command を実行します。

| Field        | Required | 説明                                                                 |
| ------------ | -------- | -------------------------------------------------------------------- |
| `image`      | yes      | Linux container image。immutable image reference を推奨。            |
| `command`    | yes      | container 内で実行する command。文字列または argv vector。           |
| `workingDir` | no       | source root 内の作業 directory。                                     |
| `env`        | no       | build service policy が許可した non-secret env。                     |
| `network`    | no       | build service policy が許可した network mode。既定は operator 次第。 |

build service の output は prepared source tree です。build command は runtime
が読む file を source tree 内に生成し、どの file を runtime が読むかは AppSpec
の kind-specific `spec` に書きます。

`linux-container` example の behavior は次の通りです。

- build service は source root を container に mount し、`workingDir` があれば
  その directory、なければ source root で `command` を実行する。
- command は runtime が読む file を source tree 内に生成してよい。ただし
  `.takosumi.yml` は build 入力として immutable であり、build 後に内容が変わって
  いた場合は fail-closed。AppSpec を build output に rewrite しない。
- source-root-relative path の存在確認は build service distribution、selected
  kind convention、または provider implementation convention
  が必要に応じて行う。
- build service は container image digest、network policy、cache、secret mount、
  provenance の扱いを operator policy として定義する。

```yaml
# .takosumi.yml
components:
  web:
    kind: worker
    spec:
      entrypoint: dist/worker.mjs
```

```yaml
# .takosumi.build.yml
components:
  web:
    kind: linux-container
    spec:
      image: ghcr.io/example/build-node@sha256:...
      command: npm ci && npm run build
```

## Handoff

build service は build 後の source tree を tar snapshot として固定し、sha256 を
計算して Installer API に渡します。

```text
source root
  -> read .takosumi.yml
  -> read .takosumi.build.yml
  -> run build components
  -> create prepared source tar
  -> POST /v1/installations/* with source.kind=prepared
```

```json
{
  "spaceId": "space:personal",
  "source": {
    "kind": "prepared",
    "url": "https://build.example.com/snapshots/app-123.tar",
    "digest": "sha256:..."
  }
}
```

The prepared snapshot must contain `.takosumi.yml`. The kernel verifies
`source.digest`, parses AppSpec, records the Deployment, and passes a prepared
source locator to the selected implementation. Build recipes, intermediate
outputs, cache metadata, and provenance remain build-service owned.

## 書く場所

| 内容                               | 書く場所                         |
| ---------------------------------- | -------------------------------- |
| runtime intent                     | AppSpec                          |
| build command / build material DAG | `.takosumi.build.yml` convention |
| runtime が読む file path           | kind-specific `spec`             |
| workflow / trigger / approval      | operator automation / CI         |

## 関連ページ

- [AppSpec](./app-spec.md)
- [Installer API](./installer-api.md)
- [Reference Kind Examples](./kind-registry.md)
