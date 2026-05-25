# Reference Adapter Loading (`plugins` option) {#plugin-loading}

AppSpec の `kind` は operator が URI に解決し、その kind の `spec` と
publish/listen contract に合う implementation binding を選びます。JSON-LD
descriptor は、Takosumi official type catalog がその型・意味・入出力を表すため
に使う semantic metadata です。provider implementation は、その contract を具体
runtime / resource に変換する operator-owned 実装です。Takosumi reference kernel
では、この実装を `KernelPlugin` として attach します。

同じ descriptor を扱う別の Takosumi-compatible implementation は、native
controller、static registry、SaaS adapter、workflow engine などで implementation
binding を持てます。plugin loading は reference kernel の実装手段です。

## 基本モデル {#model}

An operator using the reference kernel imports provider packages as ordinary
TypeScript modules and passes them to `createPaaSApp()` as the reference adapter
array (`plugins` option).

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

package の取得方法、lockfile、HTTPS、private registry、vendoring は operator
distribution の policy です。

## 起動時検査 {#boot-validation}

reference kernel が見るのは、起動時に渡された `kindAliases` と reference adapter
array (`plugins` option) です。

- short alias は operator-provided `kindAliases` にあるものだけ解決される
- reference implementation adapter は `provides[]` で kind URI を宣言する
- 同じ kind URI を複数 adapter が提供し、operator profile / Space policy でも
  一意に選べない bootstrap は fail-closed
- apply / dry-run が必要とする kind URI を Space-visible implementation binding
  が 1 つも提供しない場合は provider side effect 前に fail-closed。bootstrap
  validation は、operator が宣言した reference adapter inventory の重複・不正・
  operator profile が必須として宣言した binding の欠落を検査する。

## DataAsset extension との関係 {#dataasset-extension}

`/v1/artifacts` は operator が mount できる optional DataAsset extension です。
DataAsset routes は Installer API の 5 endpoint と別の credential / route
surface を使います。plugin loading は reference adapter array の話であり、
DataAsset の route、credential、metadata kind、GC policy は
[Operator DataAsset Extension](./data-asset-policy.md) と
[Connector Guide](./connector-contract.md) が定義します。

## 失敗時の UX {#failure-ux}

| Failure                                | Behavior                                           |
| -------------------------------------- | -------------------------------------------------- |
| unresolved kind alias                  | dry-run / apply reject before provider side effect |
| no adapter provides a kind URI         | dry-run / apply reject before provider side effect |
| ambiguous adapter set for one kind URI | boot reject                                        |
| connector not visible                  | apply reject before runtime-agent dispatch         |

## 関連ページ {#related-pages}

- [Supply Chain Trust](./supply-chain-trust.md)
- [Provider Implementations](./providers.md)
- [Connector Guide](./connector-contract.md)
- [DataAsset Policy](./data-asset-policy.md)
- [Storage Schema](./storage-schema.md)
