# ビルドサービス例 {#operator-build-service-profile}

このページは非規定の operator 設定例です。 [ビルドサービス境界](../reference/build-spec.md) で説明したビルド済みアーカイブの受け渡しを、operator build service がどのように作れるかを示します。

operator は、Takosumi Manifest と近い書き味の source-level build service を持ちたい場合にこの設定例を採用できます。Takosumi が受け取るのは、build service が作ったビルド済みアーカイブの URL と digest だけです。

## 入力形の例

```yaml
apiVersion: v1
metadata:
  id: com.example.notes.build
  name: Example Notes build
nodes:
  web:
    kind: linux-container
    spec:
      image: ghcr.io/example/build-node@sha256:...
      command: npm ci && npm run build
      workingDir: .
    dependsOn: []
```

| Field        | Required | 意味                                     |
| ------------ | -------- | ---------------------------------------- |
| `apiVersion` | yes      | build-service profile version。          |
| `metadata`   | yes      | build-service input の metadata。        |
| `nodes`      | yes      | profile が解釈する build graph の node。 |

build node field は `kind`、`spec`、`dependsOn` です。この `kind` は build service 内の語彙であり、Manifest の component kind でも公式型カタログの定義でもありません。

## Linux container node の例

`linux-container` は build node kind の例です。Linux container image の中で command を実行します。

| Field        | Required | 意味                                                       |
| ------------ | -------- | ---------------------------------------------------------- |
| `image`      | yes      | Linux container image。immutable reference を推奨。        |
| `command`    | yes      | container 内で実行する command string または argv vector。 |
| `workingDir` | no       | source-root-relative working directory。                   |
| `env`        | no       | build-service policy が許可する non-secret env。           |
| `network`    | no       | build-service policy が許可する network mode。             |

`workingDir` は build-service path grammar を使います。Manifest の source-file-reference grammar ではありません。省略するか `.` にすると source root で実行します。それ以外は source root 配下の POSIX relative directory path です。`/` で始まらず、NUL、空 segment、`.`、`..` を含まず、resolved realpath が source root 内に残る必要があります。

profile は、command string を shell command として扱うか argv vector として扱うか、許可する environment variable、network の有無、cache mount、保持する provenance を定義できます。

## Handoff の責務

この profile を使う build service は次を行います。

- source-root の `.takosumi.yml` を immutable input として読む。
- build node を dependency order で実行する。
- ビルド済みアーカイブの root に同じ `.takosumi.yml` bytes が残るようにする。
- Manifest の kind 固有 `spec` field が参照する runtime file を含める。
- ビルド済みアーカイブの payload digest を計算する。
- `source.kind: "prepared"` で Installer API を呼ぶ。

build failure、cache invalidation、container image verification、secret mount、 network policy、provenance record は build service の責務です。Installer apply はリソースの作成・更新前に Manifest、kind の定義が指定する source file path、ビルド済みアーカイブの安全性、`source.digest` を検証します。

## 例

```yaml
# .takosumi.yml
apiVersion: v1
metadata:
  id: com.example.notes
  name: Example Notes
components:
  web:
    kind: worker
    spec:
      entrypoint: src/worker.ts
```

```yaml
# .takosumi.build.yml
apiVersion: v1
metadata:
  id: com.example.notes.build
  name: Example Notes build
nodes:
  web:
    kind: linux-container
    spec:
      image: ghcr.io/example/build-node@sha256:...
      command: npm ci && npm run build
    dependsOn: []
```

build service は結果の source tree をビルド済みアーカイブにし、 [ビルドサービス境界](../reference/build-spec.md) の通り Installer API に渡します。
