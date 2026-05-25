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

## 新しい kind を追加する

reusable な kind は stable kind URI と descriptor metadata で意味を公開します。
operator はその URI に implementation binding を別途 attach して runnable
にします。 Takosumi official type catalog の descriptor は JSON-LD
を公開形式として使います。

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
  "publications": {
    "endpoint": {
      "contract": "http-endpoint",
      "material": {
        "url": {
          "source": "provider-result",
          "field": "endpoint"
        }
      }
    }
  },
  "outputs": [
    { "name": "endpoint", "type": "string" }
  ]
}
```

AppSpec 側では operator が解決できる `kind` を使います。

`material` の provider-result field mapping は descriptor documents、generated
helper types、examples、documentation checks が参照する metadata です。runtime
projection は operator-selected implementation binding が行い、結果は
implementation/operator evidence と public Deployment outputs
に分けて記録します。

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

## Reference provider adapter を追加する

Takosumi reference kernel で provider を追加する場合は、descriptor / material
contract を具体 substrate に変換する `KernelPlugin` adapter を用意します。

```ts
import type { KernelPlugin } from "@takos/takosumi-contract/reference/plugin";

export function hetznerCloudWebServiceProvider(
  opts: HetznerCloudWebServiceOptions,
): KernelPlugin {
  return {
    name: "hetzner-cloud-web-service",
    version: "1.0.0",
    provides: ["https://takosumi.com/kinds/v1/web-service"],
    async apply(ctx) {
      const service = await opts.dispatcher.apply({
        provider: "hetzner-cloud-web-service",
        region: opts.region,
        installationId: ctx.installationId,
        componentName: ctx.componentName,
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
      await opts.dispatcher.destroy({
        provider: "hetzner-cloud-web-service",
        resourceHandle: ctx.resourceHandle,
      });
    },
  };
}
```

`opts.dispatcher` は cloud SDK client ではなく、runtime-agent / connector /
operator-owned execution host に operation envelope を渡す operator-side
dispatcher です。side-effecting provider I/O と cloud / OS credential は kernel
process の外に置きます。in-process adapter は validation、planning、envelope
生成、opaque handle の受け渡しに留めます。

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

## Test checklist

- spec validation failure が provider side effect 前に止まる。
- dry-run が changes[] / expected guard を返す。cost estimate は operator
  account-plane response として扱う。
- apply が idempotent に成功する。
- destroy / rollback が対象 resource だけを処理する。
- secret value を log / audit / Deployment record に出さない。

## 関連ページ

- [AppSpec](./reference/app-spec.md)
- [Takosumi Official Type Catalog Specification](./reference/type-catalog.md)
- [Provider Implementations](./reference/providers.md)
- [Operator Bootstrap](./operator/bootstrap.md)
- [Reference Runtime-Agent Execution Surface](./reference/runtime-agent-api.md)
