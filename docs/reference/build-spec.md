# BuildSpec (`.takosumi.build.yml`) {#buildspec-takosumi-build-yml}

BuildSpec は source root の optional file です。AppSpec が「何を apply するか」
を書くのに対し、BuildSpec は operator-owned build service に「source をどう
準備するか」を渡します。

build service / CI / operator automation が `.takosumi.yml` と
`.takosumi.build.yml` を読み、必要な command を実行し、最後に **prepared source
snapshot** を Installer API に渡します。kernel は Installer API に渡された
source snapshot と AppSpec を処理します。

## Contract

BuildSpec root は AppSpec と同じ minimal envelope です。

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

| Field        | Required | 説明                                   |
| ------------ | -------- | -------------------------------------- |
| `apiVersion` | yes      | current BuildSpec version。値は `v1`。 |
| `metadata`   | yes      | BuildSpec 自体の id / name。           |
| `components` | yes      | build step / build material の map。   |

BuildSpec component の公開 field は `kind` / `spec` / `publish` / `listen`
です。`kind` の意味と `spec` の中身は build service distribution が決めます。
build service distribution が build kind catalog を持ちます。

`publish` / `listen` は build-only namespace です。AppSpec runtime namespace と
混ざらず、build service は `listen` edge から build DAG を作ります。cycle、
unresolved build output、または build material の型不一致は fail-closed です。
`publish` が表す material は build service owned で、prepared source 内の file /
directory、build-local env、cache key などを含められます。

## Linux Container

`linux-container` は reference build kind の一例です。Linux container image
の中で command を実行します。

| Field        | Required | 説明                                                                 |
| ------------ | -------- | -------------------------------------------------------------------- |
| `image`      | yes      | Linux container image。immutable image reference を推奨。            |
| `command`    | yes      | container 内で実行する command。文字列または argv vector。           |
| `workingDir` | no       | source root 内の作業 directory。                                     |
| `env`        | no       | build service policy が許可した non-secret env。                     |
| `network`    | no       | build service policy が許可した network mode。既定は operator 次第。 |

BuildSpec の output は prepared source tree です。build command は runtime
が読む file を source tree 内に生成し、どの file を runtime が読むかは AppSpec
の kind-specific `spec` に書きます。

`linux-container` の minimum contract は次の通りです。

- build service は source root を container に mount し、`workingDir` があれば
  その directory、なければ source root で `command` を実行する。
- command は runtime が読む file を source tree 内に生成してよい。ただし
  `.takosumi.yml` は build 入力として immutable であり、build 後に内容が変わって
  いた場合は fail-closed。AppSpec を build output に rewrite しない。
- source-root-relative file reference の存在確認は build service distribution、
  selected kind descriptor、または provider implementation convention
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
      compatibilityDate: "2025-01-01"
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
`source.digest`, extracts or forwards the snapshot, parses AppSpec, and passes a
prepared source locator to materializers. A local runtime may receive
`localDirectory`; a remote runtime-agent may receive
`remoteTar { url, digest }`. Build recipes, intermediate outputs, cache
metadata, and provenance remain build-service owned.

## 書く場所

| 内容                               | 書く場所                 |
| ---------------------------------- | ------------------------ |
| runtime intent                     | AppSpec                  |
| build command / build material DAG | BuildSpec                |
| runtime が読む file path           | kind-specific `spec`     |
| workflow / trigger / approval      | operator automation / CI |

## 関連ページ

- [AppSpec](./app-spec.md)
- [Installer API](./installer-api.md)
- [Reference Kind Descriptors](./kind-registry.md)
