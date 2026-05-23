# Reference Plugin Loading モデル {#plugin-loading}

> このページでわかること: Takosumi reference kernel が provider implementation
> を Vite 風に attach する方法。

JSON-LD kind descriptor は kind の型・意味・入出力を表す semantic contract
です。 provider implementation はその descriptor を具体 runtime / resource
に変換する operator-owned 実装です。Takosumi reference kernel では、この実装を
`KernelPlugin` として attach します。

同じ descriptor を扱う別の Takosumi-compatible implementation は、native
controller、static registry、SaaS adapter、workflow engine など別の仕組みで
implementation binding を持てます。takosumi.com reference implementation では
その組み込み方を plugin API として提供します。

## 基本モデル {#model}

Takosumi reference operator distribution は普通の TypeScript module として
provider package を import し、`createPaaSApp()` に plain array で渡します。

```ts
import { createPaaSApp } from "@takos/takosumi-kernel/bootstrap";
import { TAKOSUMI_REFERENCE_KIND_ALIASES } from "@takos/takosumi-plugins/kinds";
import { cloudflareWorkerProvider } from "@takos/takosumi-cloudflare-providers";

const { app } = await createPaaSApp({
  kindAliases: TAKOSUMI_REFERENCE_KIND_ALIASES,
  plugins: [
    cloudflareWorkerProvider({ accountId }),
  ],
});
```

package の取得方法、lockfile、HTTPS、private registry、vendoring は reference
operator distribution の policy です。

## 起動時検査 {#boot-validation}

reference kernel が見るのは、起動時に渡された `kindAliases` と `plugins`
だけです。

- short alias は operator-provided `kindAliases` にあるものだけ解決される
- reference implementation adapter は `provides[]` で kind URI を宣言する
- 同じ kind URI を複数 adapter が提供する bootstrap は fail-closed
- adapter が 0 件、または必要 kind を提供する adapter が 0 件なら provider side
  effect 前に fail-closed

## DataAsset extension との関係 {#dataasset-extension}

`/v1/artifacts` は operator が mount できる DataAsset extension です。
source-backed connector は prepared source を読み、DataAsset-backed connector は
operator extension の content-addressed bytes を consume します。

## 失敗時の UX {#failure-ux}

| Failure                       | Behavior                                           |
| ----------------------------- | -------------------------------------------------- |
| unresolved kind alias         | dry-run / apply reject before provider side effect |
| no plugin provides a kind URI | dry-run / apply reject before provider side effect |
| duplicate plugin provider     | boot reject                                        |
| connector not visible         | apply reject before runtime-agent dispatch         |

## 関連ページ {#related-pages}

- [Supply Chain Trust](./supply-chain-trust.md)
- [Provider Implementations](./providers.md)
- [Connector Contract](./connector-contract.md)
- [DataAsset Policy](./data-asset-policy.md)
- [Storage Schema](./storage-schema.md)
