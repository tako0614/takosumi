# Component Kind / Provider の拡張 {#extending}

Takosumi の拡張は 2 種類あります。

| やりたいこと                                            | 追加するもの                     |
| ------------------------------------------------------- | -------------------------------- |
| reference / operator kind を別 cloud / runtime で動かす | implementation binding           |
| 新しい runtime / resource contract を作る               | kind descriptor + implementation |

AppSpec は opaque な component kind string と `spec` を書きます。kind は
operator が opt-in した short alias でも、直接 URI でもよく、operator が kind
URI / descriptor / implementation binding に解決します。Takosumi reference
kernel では `createPaaSApp()` で `KernelPlugin` adapter を attach します。これは
reference implementation の配線方法であり、Takosumi-compatible implementation は
別の仕組みで同じ kind URI を実行しても構いません。

## Reference provider adapter を追加する

Takosumi reference kernel で provider を追加する場合は、reference / operator
kind を具体 substrate に変換する `KernelPlugin` adapter を用意します。

```ts
import type { KernelPlugin } from "@takos/takosumi-contract/plugin";

export function hetznerCloudWebServiceProvider(
  opts: HetznerCloudWebServiceOptions,
): KernelPlugin {
  return {
    name: "hetzner-cloud-web-service",
    version: "1.0.0",
    provides: ["https://takosumi.com/kinds/v1/web-service"],
    async apply(ctx) {
      const service = await opts.client.createService({
        region: opts.region,
        name: `${ctx.installationId}-${ctx.componentName}`,
        spec: ctx.component.spec ?? {},
        bindings: ctx.resolvedBindings,
      });
      return {
        resourceHandle: service.id,
        outputs: {
          id: service.id,
          url: service.url,
        },
      };
    },
    async destroy(ctx) {
      await opts.client.deleteService(ctx.resourceHandle);
    },
  };
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
region / account などの non-secret selector は adapter factory option
に置けます。

## 新しい kind を追加する

新しい kind は URI、descriptor metadata、implementation binding をセットで用意
します。takosumi.com reference catalog で共有する descriptor は JSON-LD
を使います。descriptor は型・入出力 metadata
で、実行方法そのものではありません。

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
      endpoint:
        as: http-endpoint
```

## Test checklist

- spec validation failure が provider side effect 前に止まる。
- dry-run が changes[] / expected digest を返す。cost estimate は operator
  extension として追加できる。
- apply が idempotent に成功する。
- destroy / rollback が対象 resource だけを処理する。
- secret value を log / audit / Deployment record に出さない。

## 関連ページ

- [AppSpec](./reference/app-spec.md)
- [Reference Kind Descriptors](./reference/kind-registry.md)
- [Provider Implementations](./reference/providers.md)
- [Operator Bootstrap](./operator/bootstrap.md)
- [Runtime-Agent API](./reference/runtime-agent-api.md)
