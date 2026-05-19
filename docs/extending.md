# Component Kind / Materializer の拡張 {#extending-component-kinds-and-materializers}

> このページでわかること: 新しい component kind / materializer を追加する手順。

命名規則と最小コミットメントの詳細は
[`takosumi/CONVENTIONS.md`](https://github.com/tako0614/takosumi/blob/main/CONVENTIONS.md)
(canonical) 参照。

## 拡張の選び方

| 目的                                                     | やること                                                                                      | RFC 必要                           |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------- |
| 既存 component kind を別 cloud / runtime で動かしたい    | [§ provider を追加する](#新-provider-の追加)                                                  | 不要                               |
| 既存 kind では足りない portable resource type を作りたい | [§ 新 component kind を JSON-LD + materializer で追加する](#新しい-component-kind-を追加する) | curated catalog に取り込む場合のみ |

Component kind catalog は **extensible** です。 Takosumi curated は 4 kind
(`worker` / `postgres` / `object-store` / `custom-domain`) ですが、 operator は
任意 domain に JSON-LD で新 kind を publish し、 materializer を attach
することで完全に独自の kind を追加できます。

## 新 provider の追加

新しいクラウド / ランタイムで既存 component kind を動かす場合のフロー
(`CONVENTIONS.md` §4 と同期)。 cloud provider は独立 package として ship されて
いるため、 該当 cloud の provider package に factory を追加します。

```text
packages/<cloud>-providers/src/<kind>-<provider>.ts
```

例: `worker` の Hetzner Cloud 実装なら新規 `packages/hetzner-cloud-providers/`
package を起こすか、 既存の cloud-neutral package に置きます。

### 1. KernelPlugin factory を export する

既存の
[`packages/cloudflare-providers/src/worker-cloudflare.ts`](https://github.com/tako0614/takosumi/blob/main/packages/cloudflare-providers/src/worker-cloudflare.ts)
や
[`packages/aws-providers/src/object-store-aws-s3.ts`](https://github.com/tako0614/takosumi/blob/main/packages/aws-providers/src/object-store-aws-s3.ts)
をテンプレに `KernelPlugin` を返す factory を書きます。

```ts
import type { KernelPlugin } from "@takos/takosumi-contract/plugin";
import { kernelPluginFromProviderPlugin } from "@takos/takosumi-contract/kernel-plugin-adapter";
import { KIND_URI_BY_NAME } from "@takos/takosumi-contract/app-spec";

export interface HetznerCloudWorkerProviderOptions {
  readonly token?: string;
  readonly lifecycle?: HetznerCloudLifecycleClient;
}

export function hetznerCloudWorkerProvider(
  opts: HetznerCloudWorkerProviderOptions = {},
): KernelPlugin {
  const lifecycle = opts.lifecycle ?? new InMemoryHetznerCloudLifecycle();
  const provider = createHetznerCloudWorkerProvider({ lifecycle });
  return kernelPluginFromProviderPlugin({
    provider,
    kindUri: KIND_URI_BY_NAME.worker,
    capabilities: ["always-on", "long-request"],
  });
}
```

### 2. Lifecycle client interface を同居させる

provider は credential を直接持ちません。 同じファイル内で
`<Provider>LifecycleClient` interface を declare し、
`InMemory<Provider>Lifecycle` クラスをテスト用に export します。 production
lifecycle (runtime-agent 経由) は別途 inject します。

### 3. 命名規則 {#naming-convention}

| 対象             | rule                                                                |
| ---------------- | ------------------------------------------------------------------- |
| Factory name     | camelCase、 `<provider><Kind>Provider` (`cloudflareWorkerProvider`) |
| Provider id      | kebab-case、cloud / runtime を最初の token (`hetzner-cloud`)        |
| Provider version | semver (`1.0.0`)。 id にバージョンを含めない                        |
| Capability       | lowercase kebab-case、 namespace prefix なし                        |
| Output field     | component kind の JSON-LD `outputs` と完全一致                      |

### 4. package `mod.ts` に re-export を追加

```ts
// packages/<cloud>-providers/mod.ts
export {
  hetznerCloudWorkerProvider,
  type HetznerCloudWorkerProviderOptions,
} from "./src/worker-hetzner-cloud.ts";
```

### 5. テスト

`packages/<cloud>-providers/tests/<kind>_<provider>_test.ts` に最低 3 ケース:

1. `apply` が outputs を返し、 kind JSON-LD の `outputs[]` field set
   を満たすこと。
2. KernelPlugin が宣言する `kindUri` が canonical kind URI と一致すること。
3. `destroy` が呼べること。

### 6. operator 配線

operator は `createPaaSApp({ plugins })` の plain array に渡すだけ:

```ts
import { hetznerCloudWorkerProvider } from "@takos/takosumi-hetzner-cloud-providers";
import { createPaaSApp } from "@takos/takosumi-kernel";

const { app } = await createPaaSApp({
  plugins: [
    hetznerCloudWorkerProvider({ token: process.env.HETZNER_TOKEN }),
  ],
});
```

## 新しい component kind を追加する

新しい portable resource type は **JSON-LD で publish + materializer 実装** の 2
段で成立します。 catalog は frozen ではなく、 operator は任意 domain で新 kind
を発行できます (`CONVENTIONS.md` §6)。

### 任意 domain で新 kind を発行する場合 (operator-owned)

```yaml
# .takosumi.yml
components:
  cache:
    kind: https://example.com/kinds/cache@v1
    spec:
      sizeGiB: 1
    publish:
      - com.example.notes.cache
```

operator は (1) `https://example.com/kinds/cache@v1` で JSON-LD document を
serve し、 (2) materializer を `createPaaSApp({ materializers: [...] })` または
`KernelPlugin` factory として attach します。

### Takosumi curated catalog に取り込みたい場合

Takosumi curated (= `https://takosumi.com/kinds/v1/<name>`) に取り込みたい場合は
ecosystem RFC が必要です:

1. **Issue を立てる** — github issue で motivating use case と既存 kind では
   足りない理由を提示。
2. **JSON-LD document を書く** — `spec/contexts/kinds/v1/<name>.jsonld` に
   **spec (JSON Schema 2020-12) / publishes / listens / outputs** を 1 document
   で一体宣言する。
3. **Spec / Outputs / Capability 型を書く** —
   `packages/plugins/src/kinds/<kind>.ts` に TS 等価を実装する。
4. **curated kind registry に追加** — `packages/plugins/src/kinds/mod.ts`
   に登録。
5. **≥ 2 materializer を実装** — portability 不変式: 1 kind = 最低 2
   materializer。 cloud provider package の KernelPlugin factory + inline recipe
   どちらでも可。
6. **テスト** — `tests/component_kind_<kind-id>_test.ts` (JSON-LD spec 境界
   ケース) と各 materializer の test を整備。
7. **CONVENTIONS.md §1 表を更新**。
8. **docs を更新** — [Kind Catalog](./reference/kind-catalog.md#component-kinds)
   に解説 section を追加。

### Materializer = KernelPlugin | InlineMaterializer {#materializer--kernelplugin--inlinematerializer}

materializer は 2 形態を受理します。 cloud provider package は `KernelPlugin`
factory を export しますが、 operator が **inline 関数** で書くこともできます:

```ts
import { createPaaSApp } from "@takos/takosumi-kernel";

const { app } = await createPaaSApp({
  materializers: [
    {
      kindUri: "https://example.com/kinds/cache@v1",
      apply: async (spec, ctx) => {
        // operator-owned 任意 JS。 outputs を返し、 publishes[] に登録される。
        return { outputs: { endpoint: "redis://...", port: 6379 } };
      },
      destroy: async (handle, ctx) => {/* ... */},
    },
  ],
});
```

plugin convention は実装の 1 形態に過ぎず、 contract (= input spec validate /
output 返却 / publishes register) を満たせば形は任意です。

### 命名規則 {#naming-convention-1}

| 対象               | rule                                                                            |
| ------------------ | ------------------------------------------------------------------------------- |
| Kind id            | kebab-case (`object-store`)、 curated は `https://takosumi.com/kinds/v1/<name>` |
| Operator-owned URI | 任意 domain (`https://operator.example.com/kinds/<name>`)                       |
| breaking change    | 新 URI を発行 (`@v2`)、 short alias に v2 を被せない                            |
| capability 追加    | 同じ URI のまま (capability list は open enum)                                  |

### 出力スキーマ規則 {#output-schema-convention}

複数 materializer が同じ output shape を返すために、 field 名と型は kind
全体で揃える (`CONVENTIONS.md` §3 表):

| Suffix / form        | 用途                                       |
| -------------------- | ------------------------------------------ |
| `*Ref` (string)      | secret reference URI (`secret://...`)      |
| `connectionString`   | scheme 付き接続文字列 (`postgresql://...`) |
| `endpoint`, `url`    | scheme 付き URL                            |
| `internalHost`       | private DNS name (no scheme)               |
| `internalPort`       | numeric port                               |
| `bucket`, `database` | non-secret identifier                      |

secret の raw value は絶対に返さない。 `*Ref` field に
`secret://<provider>/<scope>/<key>` を入れ、 kernel 側 secret-store adapter
が解決します。

## Workflow / cron / hook が必要な場合

GitHub Actions に相当する workflow / cron / lifecycle hook 機能は current kernel
extension path に存在しません。 kernel は trigger / execute-step /
declarable-hook 等の workflow primitive を一切ホストしません。

current v1 では、 `cron-job` / `workflow-job` / `pre-apply-hook` /
`post-activate-hook` のような component kind を AppSpec として publish
することも current extension recipe ではありません。 これらは将来 RFC 用の
reserved vocabulary です。

必要な場合の current placement:

| concern                        | current owner                                    |
| ------------------------------ | ------------------------------------------------ |
| git push / webhook / build     | external CI or operator product                  |
| scheduled invocation           | app / operator product using substrate scheduler |
| deployment pre/post automation | upstream workflow before installer deploy call   |
| multi-step pipeline            | upstream workflow that submits AppSpec source    |

kernel 側で追加できるのは desired-state component kind と materializer まで。
source preparation、 workflow runner、 scheduler は above-kernel product の
責務です。 詳細は
[Workflow Extension Design](./reference/architecture/workflow-extension-design.md)
参照。

## 次に読む

- [Kind Catalog](./reference/kind-catalog.md#component-kinds) — curated 4 kind
  の spec / publishes / listens / outputs を読み、 自前 kind との差分を決める
- [Provider Plugins](./reference/providers.md) — 既存 provider の `KernelPlugin`
  実装例 (factory が返す lifecycle envelope の形)
- [Operator Bootstrap](/operator/bootstrap) — 追加した factory を
  `createPaaSApp({ plugins: [...] })` に attach する手順
- [AppSpec](./reference/app-spec.md) — 新 kind を AppSpec で declare するための
  envelope 仕様
- [Workflow Extension Design](./reference/architecture/workflow-extension-design.md)
  — kernel scope 外 (workflow / cron / hook) の境界判断
- [Manifest](/manifest) — operator が apply する manifest の syntax
- [Reference Index](./reference/index.md) — 全 v1 仕様の索引
- [`CONVENTIONS.md`](https://github.com/tako0614/takosumi/blob/main/CONVENTIONS.md)
  (canonical) — 命名規則と最小コミットメント詳細
