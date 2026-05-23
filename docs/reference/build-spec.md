# BuildSpec (`.takosumi.build.yml`) {#buildspec-takosumi-build-yml}

BuildSpec は source root の optional file です。AppSpec が「何を apply するか」
を書くのに対し、BuildSpec は build service / operator automation に source build
の方針を渡します。

Takosumi kernel は BuildSpec を public entity として扱いません。

Installation / Deployment に並ぶ entity ではありません。

build service または CI は `.takosumi.yml` と `.takosumi.build.yml` を読みます。

current transitional design では、build service が artifact を `/v1/artifacts`
に upload し、reference が解決済みの AppSpec bundle を Installer API
に渡します。 follow-up wave では public artifact concept を縮小し、plugin が
build 後の source snapshot / git state を読む model に寄せます。

## Root shape

BuildSpec root は AppSpec と同じ 3 field です。

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
| `metadata`   | yes      | BuildSpec 自体の id / name / labels。  |
| `components` | yes      | build step / build material の map。   |

unknown root field は reject されます。

## `components`

BuildSpec component は名前付き map entry です。公開 field は AppSpec component
と同じ 4 つです。

| Field     | Required | 説明                                                                 |
| --------- | -------- | -------------------------------------------------------------------- |
| `kind`    | yes      | build kind。short alias または build service が解決できる kind URI。 |
| `spec`    | no       | build kind ごとの open object。                                      |
| `publish` | no       | build-only namespace path に output material を登録する。            |
| `listen`  | no       | build-only namespace path から input material を受け取る。           |

BuildSpec の `publish` / `listen` は build graph のための namespace です。
AppSpec の runtime namespace とは混ぜません。

BuildSpec は fixed step catalog ではありません。AppSpec component と同じく、
`kind` が contract を選び、`spec` の中身はその build kind / build service
distribution が決めます。

## Build kind

Build kind は operator / build service distribution が解決します。short alias は
自由に使えますが、canonical URI を使うこともできます。

```yaml
components:
  web:
    kind: https://takosumi.com/build-kinds/v1/linux-container
```

Takos が公開する reference build kind URI は
`https://takosumi.com/build-kinds/v1/linux-container` です。short alias
`linux-container` は build service distribution がこの URI へ解決できます。

## `linux-container`

`linux-container` は Linux container image の中で command を実行する reference
build kind です。current transitional design では named output を artifact
として 取り出します。

| Field        | Required | 説明                                                                  |
| ------------ | -------- | --------------------------------------------------------------------- |
| `image`      | yes      | Linux container image。digest pin を推奨。                            |
| `command`    | yes      | container 内で実行する command。文字列または argv vector。            |
| `outputs`    | no       | artifact output map。`artifact` は同名 AppSpec component へ注入する。 |
| `workingDir` | no       | source root 内の作業 directory。                                      |
| `env`        | no       | build service policy が許可した non-secret env。                      |
| `network`    | no       | build service policy が許可した network mode。既定は operator 次第。  |

BuildSpec の `outputs.artifact` は予約名です。同名 AppSpec component
がある場合、 build service はこの output を provider input の `spec.artifact`
descriptor に 変換して resolved AppSpec bundle に注入します。

追加 output descriptor は次の shape です。

| Field      | Required | 説明                                                |
| ---------- | -------- | --------------------------------------------------- |
| `path`     | yes      | container 実行後に取り出す path。source root 基準。 |
| `kind`     | yes      | upload する artifact kind。例: `js-bundle`。        |
| `metadata` | no       | artifact に添える JSON object。                     |

default artifact の artifact kind は component kind descriptor から推論します。
`worker` は `js-bundle` です。推論不能または複数候補の場合、build service は
fail-closed にします。

## Batch execution

build service は BuildSpec component graph を topological order で解決し、1 回の
build batch として実行します。

```text
source root
  -> read .takosumi.yml
  -> read .takosumi.build.yml
  -> resolve BuildSpec publish/listen graph
  -> run build components in batch
  -> POST /v1/artifacts for default artifact and additional outputs
  -> create resolved AppSpec bundle
  -> POST /v1/installations/* with source.kind=bundle
```

1 つでも build component が失敗した場合、build service は Installer API に apply
を投げません。部分的に作られた artifact の retention / GC は operator policy に
従います。

## AppSpec への注入

BuildSpec component name が AppSpec component name と一致し、`outputs.artifact`
がある場合、build service はその file を `/v1/artifacts` に upload し、resolved
bundle 内で同名 AppSpec component の `spec.artifact` に descriptor
を注入します。

```yaml
# .takosumi.yml
components:
  web:
    kind: worker
    spec:
      compatibilityDate: "2025-01-01"
```

```yaml
# .takosumi.build.yml
components:
  web:
    kind: linux-container
    spec:
      image: ghcr.io/example/build-node@sha256:...
      command: npm run build
      outputs:
        artifact:
          path: dist/worker.mjs
          kind: js-bundle
```

```yaml
# resolved .takosumi.yml inside the bundle
components:
  web:
    kind: worker
    spec:
      artifact:
        kind: js-bundle
        hash: sha256:...
        metadata: {}
      compatibilityDate: "2025-01-01"
```

同じ AppSpec component がすでに `spec.artifact.hash` または `spec.artifact.uri`
を持ち、同名 BuildSpec component も存在する場合は ambiguous として fail-closed
にします。

複数 output は許可されます。`outputs.artifact` 以外の output は BuildSpec の
`publish` / `listen` で次の build component に渡すか、bundle metadata として
扱うために使います。

## Installer API への handoff

build service は overlay field や build recipe を Installer API に渡しません。
handoff は解決済み AppSpec bundle です。

```json
{
  "spaceId": "space_personal",
  "source": {
    "kind": "bundle",
    "uri": "artifact:sha256:...",
    "digest": "sha256:..."
  }
}
```

bundle 内の AppSpec は `.takosumi.yml` と同じ AppSpec contract に従います。
component `build` field は含めません。

## Follow-up: source snapshot model

artifact / build の最終形は [RFC 0001](../rfc/0001-kernel-kind-agnostic.md) の
follow-up として source snapshot model に寄せます。

- build service は build 後 source tree / git state を digest-pinned snapshot と
  して固定する。
- provider plugin は lifecycle apply 時に snapshot locator を受け取り、自分の
  kind contract に従って必要な file / path / metadata を読む。
- `spec` 内の parameter は Takosumi が意味解釈しない plugin-owned variables と
  して扱う。
- `js-bundle` などの artifact kind は Takosumi public spec から外す候補にする。

## 関連ページ

- [AppSpec](./app-spec.md)
- [Installer API](./installer-api.md)
- [DataAsset Policy](./data-asset-policy.md)
- [Reference Kind Registry](./kind-catalog.md#artifact-kinds)
