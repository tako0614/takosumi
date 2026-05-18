# Extending Component Kinds and Providers

> このページでわかること: 新しい component kind / provider plugin
> を追加する手順。

命名規則と最小コミットメントの詳細は
[`takosumi/CONVENTIONS.md`](https://github.com/takos-jp/takosumi/blob/main/CONVENTIONS.md)
(canonical) 参照。

## 拡張の選び方

| 目的                                                               | やること                                                           | RFC 必要 |
| ------------------------------------------------------------------ | ------------------------------------------------------------------ | -------- |
| 既存 component kind を別 cloud / runtime で動かしたい              | [§ provider を追加する](#新-provider-の追加)                       | 不要     |
| 既存 component kind では足りない portable resource type を作りたい | [§ component kind を RFC する](#新しい-component-kind-を-rfc-する) | 必要     |

Component kind catalog は Takosumi が curate する (kernel が known kind
として扱える contract を維持するため)。 第三者の public extension surface は
provider。component kind を増やす場合は ecosystem RFC が必要。

## 新 provider の追加

新しいクラウド / ランタイムで既存 component kind を動かす場合のフロー
(`CONVENTIONS.md` §4 と同期)。

### 1. ファイルを作る

```
packages/plugins/src/shape-providers/<kind-id>/<provider-id>.ts
```

例: `worker` の Hetzner Cloud 実装なら
`packages/plugins/src/shape-providers/worker/hetzner-cloud.ts`。ディレクトリ名に
`shape-providers` が残っているのは package の実装名であり、public concept は
component kind です。

### 2. ProviderPlugin factory を export する

既存の
[`object-store/aws-s3.ts`](https://github.com/takos-jp/takosumi/blob/main/packages/plugins/src/shape-providers/object-store/aws-s3.ts)
や
[`worker/cloudflare-workers.ts`](https://github.com/takos-jp/takosumi/blob/main/packages/plugins/src/shape-providers/worker/cloudflare-workers.ts)
をテンプレに `ProviderPlugin<TSpec, TOutputs>` を返す factory を書く。

```ts
import type { ProviderPlugin } from "takosumi-contract";
import type {
  WorkerCapability,
  WorkerOutputs,
  WorkerSpec,
} from "../../kinds/worker.ts";

const SUPPORTED_CAPABILITIES: readonly WorkerCapability[] = [
  "always-on",
  "long-request",
];

export interface HetznerCloudWorkerProviderOptions {
  readonly lifecycle: HetznerCloudLifecycleClient;
}

export function createHetznerCloudWorkerProvider(
  options: HetznerCloudWorkerProviderOptions,
): ProviderPlugin<WorkerSpec, WorkerOutputs> {
  // ...
}
```

### 3. Lifecycle client interface を同居させる

provider は credential を直接持たない。 同じファイル内で
`<Provider>LifecycleClient` interface を declare し、
`InMemory<Provider>Lifecycle` クラスをテスト用に export する。 production の
lifecycle 配線は [§ factories.ts](#factories-ts-に-production-配線を追加)
で行う。

### 4. Naming convention

| 対象             | rule                                                         |
| ---------------- | ------------------------------------------------------------ |
| Provider id      | kebab-case、cloud / runtime を最初の token (`hetzner-cloud`) |
| Provider version | semver (`1.0.0`)。id にバージョンを含めない                  |
| Capability       | lowercase kebab-case、namespace prefix なし                  |
| Output field     | component kind の `outputFields` と完全一致                  |

### 5. mod.ts と deno.json を更新

```ts
// packages/plugins/src/shape-providers/mod.ts
export {
  createHetznerCloudWorkerProvider,
  type HetznerCloudWorkerProviderOptions,
} from "./worker/hetzner-cloud.ts";
```

```jsonc
// deno.json
{
  "exports": {
    "./shape-providers/worker/hetzner-cloud": "./packages/plugins/src/shape-providers/worker/hetzner-cloud.ts"
  }
}
```

### 6. テスト

`tests/shape_provider_hetzner_cloud_test.ts` に最低 3 ケース:

1. `apply` が outputs を返し、 `outputFields` を満たすこと。
2. `status` が apply 直後に `kind: "ready"` を返すこと。
3. `destroy` 後の `status` が `kind: "deleted"` を返すこと。

`InMemory<Provider>Lifecycle` を inject して動かす。

### 7. `factories.ts` に production 配線を追加 {#factories-ts-に-production-配線を追加}

```ts
// packages/plugins/src/shape-providers/factories.ts
if (opts.hetzner) {
  out.push(
    asPlugin<HetznerCloudWebServiceProviderOptions>(
      createHetznerCloudWebServiceProvider({
        lifecycle: new GatewayHetznerCloudLifecycle(opts.hetzner),
      }),
    ),
  );
}
```

`GatewayHetznerCloudLifecycle` は `JsonGateway` を使う thin HTTP adapter で、
operator gateway 経由で Hetzner Cloud API を呼ぶ。

cf.
[Operator Bootstrap § Gateway URL pattern](/operator/bootstrap#gateway-url-pattern)

## 新しい component kind を RFC する

新しい portable resource type を追加する場合は **ecosystem RFC** が必要
(`CONVENTIONS.md` §6)。

### Process

1. **Issue を立てる** — github issue で motivating use case と既存 Shape
   では足りない理由を提示。
2. **Spec / Outputs / Capability 型を書く** — contract package の component kind
   catalog に schema と output 型を追加する。
3. **Bundled kind registry に追加** — component kind catalog / plugin registry
   に登録。
4. **≥ 2 provider を実装** — portability 不変式: 1 kind = 最低 2 provider。 1
   つの cloud に縛られた kind は portable とは呼ばないため reject される。
5. **テスト** — `tests/component_kind_<kind-id>_test.ts` (schema の境界ケース)
   と `tests/shape_provider_<provider>_test.ts` を整備。
6. **CONVENTIONS.md §1 表を更新**。
7. **docs を更新** — [Component Kind Catalog](/reference/component-kind-catalog)
   に解説 section を追加し、 [Provider Plugins](/reference/providers) に 2
   つ以上の provider を追記。
8. **upstream contract 影響範囲を PR description に記載** — `takosumi-contract`
   側 API 変更が必要な場合は coordination を明示。

### Naming convention

| 対象            | rule                                             |
| --------------- | ------------------------------------------------ |
| Kind id         | kebab-case (`object-store`)                      |
| breaking change | 整数 increment (`@v2`)                           |
| capability 追加 | 同じ `@vN` のまま (capability list は open enum) |

### Output schema convention

複数 provider が同じ output shape を返すために、 field 名と型は component kind
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
が解決する。

## Workflow / cron / hook が必要な場合

GitHub Actions に相当する workflow / cron / lifecycle hook 機能は current kernel
extension path に存在しない。 kernel は trigger / execute-step / declarable-hook
等の workflow primitive を一切ホストしない。

current v1 では、 `cron-job` / `workflow-job` / `pre-apply-hook` /
`post-activate-hook` のような component kind を AppSpec として publish
することも current extension recipe ではない。 これらは将来 RFC 用の reserved
vocabulary。

必要な場合の current placement:

| concern                        | current owner                                    |
| ------------------------------ | ------------------------------------------------ |
| git push / webhook / build     | external CI or operator product                  |
| scheduled invocation           | app / operator product using substrate scheduler |
| deployment pre/post automation | upstream workflow before installer deploy call   |
| multi-step pipeline            | upstream workflow that submits AppSpec source    |

kernel 側で追加できるのは desired-state component kind と provider plugin まで。
source preparation、 workflow runner、 scheduler は above-kernel product
の責務。 詳細は
[Workflow Extension Design](/reference/architecture/workflow-extension-design)
参照。

## 関連ページ

- [Reference Index](/reference/) — 全 v1 仕様の索引
- [Component Kind Catalog](/reference/component-kind-catalog)
- [Provider Plugins](/reference/providers)
- [Workflow Placement Rationale](/reference/architecture/workflow-extension-design)
- [Catalog Release Trust](/reference/catalog-release-trust) — publisher key /
  signature chain
- [Connector Contract](/reference/connector-contract) — connector identity /
  acceptedKinds
- [Manifest](/manifest)
- [Operator Bootstrap](/operator/bootstrap)
- [`CONVENTIONS.md`](https://github.com/takos-jp/takosumi/blob/main/CONVENTIONS.md)
  (canonical)
