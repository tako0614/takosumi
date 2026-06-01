# ビルドサービス例 {#operator-build-service-profile}

このページは非規定の operator 設定例です。Takosumi core は build profile を
解釈しません。operator build service は任意の profile を読み、prepared source
payload を作り、Installer API に URL と digest を渡します。

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
      command: bun install --frozen-lockfile && bun run build
      workingDir: .
    dependsOn: []
```

この `kind` は build service 内の語彙です。Takosumi core の public source
contract ではありません。

## Handoff の責務

build service は次を行います。

- source checkout を固定する。
- build node を dependency order で実行する。
- prepared source payload を作る。
- payload digest と optional artifact digest を計算する。
- provenance、cache key、SBOM、signature、approval record を operator record として保存する。
- `source.kind: "prepared"` で Installer API を呼ぶ。

Installer apply は resource side effect 前に payload digest、path safety、size
cap、operator binding selection を検証します。build failure、container image
verification、secret mount、network policy、Terraform/OpenTofu plan は operator
scope です。

## Example Handoff

```json
{
  "source": {
    "kind": "prepared",
    "url": "https://build.example/artifacts/example-notes.tar.gz",
    "digest": "sha256:..."
  },
  "bindings": [
    {
      "name": "runtime",
      "service": "runtime.primary"
    }
  ]
}
```

## Related

- [ビルドサービス境界](../reference/build-spec.md)
- [Installer API](../reference/installer-api.md)
