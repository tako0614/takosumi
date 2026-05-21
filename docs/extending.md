# Component Kind / Materializer の拡張 {#extending}

Takosumi の拡張は 2 種類あります。

| やりたいこと | 追加するもの |
| --- | --- |
| 既存 kind を別 cloud / runtime で動かす | provider plugin |
| 新しい runtime / resource contract を作る | kind descriptor + materializer |

AppSpec に `plugin:` field はありません。operator が `createPaaSApp()` で plugin
や inline materializer を attach します。

## Provider plugin を追加する

provider plugin は既存 kind を具体 substrate に materialize する実装です。

```ts
import { kernelPluginFromProviderPlugin } from "@takos/takosumi-contract/kernel-plugin-adapter";

export function hetznerCloudWorkerProvider(opts: HetznerCloudWorkerOptions) {
  const provider = createHetznerCloudWorkerProvider({ token: opts.token });

  return kernelPluginFromProviderPlugin({
    provider,
    provides: ["https://takosumi.com/kinds/v1/worker"],
  });
}
```

命名は次の形に揃えます。

| 対象 | ルール |
| --- | --- |
| Factory name | camelCase、`<provider><Kind>Provider` |
| Provider id | kebab-case、cloud / runtime を先頭に置く |
| Package | cloud / runtime owner を持つ provider package |
| Credential | factory option または runtime-agent host env で注入 |

provider は credential を AppSpec から読みません。credential と region / account
などの operator 設定は plugin factory option または runtime-agent 側の config で
渡します。

## Inline materializer を追加する

小さい operator-local recipe は inline materializer で十分です。

```ts
import { createPaaSApp } from "@takos/takosumi-kernel";

const { app } = await createPaaSApp({
  materializers: [
    {
      kindUri: "https://operator.example.com/kinds/cache",
      apply: async (spec, ctx) => {
        return {
          handle: `cache:${ctx.componentName}`,
          outputs: {
            endpoint: "redis://cache.internal:6379",
          },
        };
      },
      destroy: async () => {},
    },
  ],
});
```

inline materializer も provider plugin と同じく、outputs を返し、lifecycle
boundary を守る必要があります。

## 新しい kind を追加する

新しい kind は JSON-LD descriptor と materializer をセットで用意します。

```json
{
  "@context": "https://takosumi.com/contexts/kinds/v1",
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
- [Kind Catalog](./reference/kind-catalog.md)
- [Provider Plugins](./reference/providers.md)
- [Operator Bootstrap](./operator/bootstrap.md)
- [Runtime-Agent API](./reference/runtime-agent-api.md)
