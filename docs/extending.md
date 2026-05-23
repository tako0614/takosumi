# Component Kind / Materializer の拡張 {#extending}

Takosumi の拡張は 2 種類あります。

| やりたいこと                                            | 追加するもの                   |
| ------------------------------------------------------- | ------------------------------ |
| reference / operator kind を別 cloud / runtime で動かす | implementation binding         |
| 新しい runtime / resource contract を作る               | kind descriptor + materializer |

AppSpec は `kind` URI と `spec` を書きます。JSON-LD descriptor が kind
の型・意味 を表し、operator がその kind URI に implementation binding
を用意します。Takosumi reference kernel では `createPaaSApp()` で `KernelPlugin`
を attach します。

## Reference provider adapter を追加する

Takosumi reference kernel で provider を追加する場合は、reference / operator
kind を具体 substrate に materialize する `KernelPlugin` adapter を用意します。

```ts
import { kernelPluginFromProviderPlugin } from "@takos/takosumi-contract/kernel-plugin-adapter";

export function hetznerCloudWebServiceProvider(
  opts: HetznerCloudWebServiceOptions,
) {
  const provider = createHetznerCloudWebServiceProvider({
    region: opts.region,
    lifecycleClient: opts.lifecycleClient,
  });

  return kernelPluginFromProviderPlugin({
    provider,
    kindUri: "https://takosumi.com/kinds/v1/web-service",
  });
}
```

命名は次の形に揃えます。

| 対象         | ルール                                             |
| ------------ | -------------------------------------------------- |
| Factory name | camelCase、`<provider><Kind>Provider`              |
| Provider id  | kebab-case、cloud / runtime を先頭に置く           |
| Package      | cloud / runtime owner を持つ provider package      |
| Credential   | runtime-agent host env または operator host で注入 |

provider credential は runtime-agent host または operator host 側に置きます。
region / account などの non-secret selector は plugin factory option
に置けます。

## 新しい kind を追加する

新しい kind は JSON-LD descriptor と implementation binding
をセットで用意します。

```json
{
  "@context": "https://takosumi.com/contexts/v1.jsonld",
  "@id": "https://operator.example.com/kinds/cache",
  "name": "cache",
  "spec": {
    "type": "object",
    "properties": {
      "engine": { "enum": ["redis", "valkey"] },
      "size": { "type": "string" }
    },
    "required": ["engine"]
  },
  "outputs": [
    { "name": "endpoint", "type": "string" }
  ]
}
```

AppSpec 側では operator が解決できる `kind` を使います。

```yaml
components:
  cache:
    kind: https://operator.example.com/kinds/cache
    spec:
      engine: valkey
      size: small
    publish:
      - com.example.app.cache
```

## Test checklist

- spec validation failure が provider side effect 前に止まる。
- dry-run が outputs / risk / plan を返す。
- apply が idempotent に成功する。
- destroy / rollback が handle を使って対象 resource だけを処理する。
- secret value を log / audit / Deployment record に出さない。

## 関連ページ

- [AppSpec](./reference/app-spec.md)
- [Reference Kind Descriptors](./reference/kind-registry.md)
- [Provider Implementations](./reference/providers.md)
- [Operator Bootstrap](./operator/bootstrap.md)
- [Runtime-Agent API](./reference/runtime-agent-api.md)
