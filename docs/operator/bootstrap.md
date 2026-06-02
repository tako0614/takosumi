# Reference Bootstrap {#operator-bootstrap}

::: info
Public contract は [Installer API](../reference/installer-api.md) です。このページは
Takosumi service の起動時 wiring だけを扱います。
:::

Reference Takosumi は `createTakosumiService()` に operator-selected binding
implementation を渡して起動できます。Source payload は provider を選びません。
install / deploy request、operator policy、account-plane UI が PlatformService
binding selection を決め、operator distribution が OpenTofu / Helm / native
controller wiring と inventory importer を所有します。

## Local Example

```ts
import { createTakosumiService } from "@takosjp/takosumi";
import { createSqlPlatformServiceResolver } from "./operator-inventory";

const { app } = await createTakosumiService({
  platformServiceResolver: createSqlPlatformServiceResolver({
    inventoryTable: "platform_services",
  }),
});

Bun.serve({ port: 8788, fetch: app.fetch });
```

この bootstrap は local operator distribution が Takosumi service に inventory resolver を渡す例です。backend resource は OpenTofu / Helm / native controller で operator side に作り、その output を PlatformService inventory として登録します。

## Runtime-Agent

Credential や cloud SDK のアクセスは runtime-agent または operator host に留めます。
adapter はテスト用の in-memory lifecycle と本番配線用の lifecycle-client option
を公開できます。どの connector credential を配置するかは operator distribution
が決定します。

## 関連ページ

- [Operator backend implementations](../reference/kind-packages.md)
- [Operator binding implementations](../reference/kind-bindings.md)
- [Runtime-Agent API](../reference/runtime-agent-api.md)
