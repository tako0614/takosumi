# Reference Adapter Loading (`plugins` option) {#plugin-loading}

::: info
これは reference kernel の実装ドキュメントです。Takosumi-compatible implementation は、この plugin mechanism を使わずに kind URI を実装へ bind できます。
:::

Reference kernel は `createPaaSApp({ kindAliases, plugins })` で `KernelPlugin` の plain array を受け取ります。各 adapter は実体化できる kind URI を `provides[]` で宣言します。

Backend-specific reference adapter は別 repository の `takosumi-plugins` に置きます。Takosumi core repository は plugin interface と portable descriptor を持ちますが、concrete cloud / host binding は umbrella package に同梱しません。

`component.spec` は descriptor-owned author input です。Reference pipeline は `apply()` の前に `connect` output ref と `listen.path` / `listen.kind` selector を `ctx.resolvedBindings` へ解決します。adapter は env、mount、upstream runtime input が必要なときにその context を読みます。Native package は dependency-derived value を受け取るために hidden `spec` mutation へ依存しません。

```ts
import { createPaaSApp } from "@takosjp/takosumi/kernel";
import {
  cloudflareWorkerPlugin,
  KIND_URI as WORKER_KIND,
} from "@takosjp/takosumi-plugins/kind/cloudflare-worker";

const lifecycle = createCloudflareWorkersLifecycleClient({ accountId });

const { app } = await createPaaSApp({
  kindAliases: { "cloudflare-worker": WORKER_KIND },
  plugins: [cloudflareWorkerPlugin({ accountId, lifecycle })],
});
```

`lifecycle` は operator distribution が用意する backend lifecycle client です。package-local in-memory lifecycle は offline test 用の opt-in であり、operator bootstrap の暗黙 fallback ではありません。

`kindAliases` は operator policy です。short alias は portable kind URI または native kind URI を指せます。解決後の kind URI が `spec` schema、output slot、connection compatibility を所有します。Portable manifest には portable URI と、その URI を提供する binding を使います。Backend-specific field を使う manifest には native URI または native alias を使います。

## Boot validation

- 未解決 alias は apply 前に失敗する。
- `provides[]` が空の adapter は bootstrap で失敗する。
- 同じ kind URI を複数 adapter が提供すると bootstrap で失敗する。
- kind URI を提供する adapter がなければ、apply は side effect の前に失敗する。

Package acquisition、lockfile、vendoring、private registry、supply-chain policy は operator distribution の責務です。

## JSON-LD との関係

JSON-LD descriptor file は kind vocabulary と metadata を公開します。Reference adapter array は JSON-LD を executable code として load しません。互換 implementation は descriptor metadata を compile、mirror、vendor しながら、別の implementation binding mechanism を使えます。

## 関連ページ

- [Kind Packages](./kind-packages.md)
- [Kind Binding 実装](./kind-bindings.md)
- [Takosumi 公式カタログ仕様](./catalog.md)
