# BuildSpec (`.takosumi.build.yml`) {#buildspec-takosumi-build-yml}

BuildSpec は source root の optional file です。AppSpec が「何を apply するか」
を書くのに対し、BuildSpec は operator-owned build service に「source をどう
準備するか」を渡します。

Takosumi kernel は BuildSpec を読みません。Installation / Deployment に並ぶ
public entity でもありません。build service / CI / operator automation が
`.takosumi.yml` と `.takosumi.build.yml` を読み、必要な command を実行し、
最後に **prepared source snapshot** を Installer API に渡します。

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
Takosumi spec は build kind catalog を持ちません。

## Linux Container

`linux-container` は reference build kind の一例です。Linux container image
の中で command を実行します。

| Field        | Required | 説明                                                                 |
| ------------ | -------- | -------------------------------------------------------------------- |
| `image`      | yes      | Linux container image。digest pin を推奨。                           |
| `command`    | yes      | container 内で実行する command。文字列または argv vector。           |
| `workingDir` | no       | source root 内の作業 directory。                                     |
| `env`        | no       | build service policy が許可した non-secret env。                     |
| `network`    | no       | build service policy が許可した network mode。既定は operator 次第。 |

BuildSpec は artifact output DSL を持ちません。build command は source tree を
準備するだけです。どの file を runtime が読むかは AppSpec の kind-specific
`spec` に書きます。

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
  "spaceId": "space_personal",
  "source": {
    "kind": "prepared",
    "url": "https://build.example.com/snapshots/app-123.tar",
    "digest": "sha256:..."
  }
}
```

The prepared snapshot must contain `.takosumi.yml`. The kernel verifies
`source.digest`, extracts the snapshot, parses AppSpec, and passes the prepared
source locator / local source directory to materializers. Build recipes,
intermediate outputs, cache metadata, and provenance remain build-service owned.

## Non Goals

BuildSpec does not define:

| 書かないもの                         | 理由                                                           |
| ------------------------------------ | -------------------------------------------------------------- |
| AppSpec `component.build`            | AppSpec は runtime intent だけを持つ。                         |
| `outputs.artifact` / artifact kind   | file path は kind-specific `spec` に置く。                     |
| `spec.artifact` injection            | build service は AppSpec を artifact descriptor に書換えない。 |
| workflow / trigger / approval policy | operator automation / CI の責務。                              |

## 関連ページ

- [AppSpec](./app-spec.md)
- [Installer API](./installer-api.md)
- [Reference Kind Registry](./kind-catalog.md)
