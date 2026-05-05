# Extending the Shape Model

このページは provider plugin / Shape / Template を **追加・拡張** する RFC-style
ガイドです。canonical な命名規則と最小コミットメントは
[`takosumi/CONVENTIONS.md`](https://github.com/takos-jp/takosumi/blob/main/CONVENTIONS.md)
を正本とし、本ページは docs site での日本語サマリです。

## 拡張の選び方

| 目的                                                      | やること                                         | RFC 必要 |
| --------------------------------------------------------- | ------------------------------------------------ | -------- |
| 既存 Shape を別 cloud / runtime で動かしたい              | [§ provider を追加する](#新-provider-の追加)     | 不要     |
| 既存 Shape の組み合わせで定型構成を作りたい               | [§ template を追加する](#新-template-の追加)     | 不要     |
| 既存 Shape では足りない new portable resource type を作る | [§ Shape を RFC する](#新しい-shape-を-rfc-する) | 必要     |

> **大原則**: Takos は Shape catalog を curate する。第三者は **provider** か
> **template** を増やす。Shape を増やす場合は ecosystem RFC が必要。

## 新 provider の追加

新しいクラウド / ランタイムで既存 Shape を動かす場合のフロー (`CONVENTIONS.md`
§4 と同期)。

### 1. ファイルを作る

```
packages/plugins/src/shape-providers/<shape-id>/<provider-id>.ts
```

例: `web-service@v1` の Hetzner Cloud 実装なら
`packages/plugins/src/shape-providers/web-service/hetzner-cloud.ts`。

### 2. ProviderPlugin factory を export する

既存の
[`object-store/aws-s3.ts`](https://github.com/takos-jp/takosumi/blob/main/packages/plugins/src/shape-providers/object-store/aws-s3.ts)
や
[`web-service/gcp-cloud-run.ts`](https://github.com/takos-jp/takosumi/blob/main/packages/plugins/src/shape-providers/web-service/gcp-cloud-run.ts)
をテンプレに `ProviderPlugin<TSpec, TOutputs>` を返す factory を書きます。

```ts
import type { ProviderPlugin } from "takosumi-contract";
import type {
  WebServiceCapability,
  WebServiceOutputs,
  WebServiceSpec,
} from "../../shapes/web-service.ts";

const SUPPORTED_CAPABILITIES: readonly WebServiceCapability[] = [
  "always-on",
  "long-request",
];

export interface HetznerCloudWebServiceProviderOptions {
  readonly lifecycle: HetznerCloudLifecycleClient;
}

export function createHetznerCloudWebServiceProvider(
  options: HetznerCloudWebServiceProviderOptions,
): ProviderPlugin<WebServiceSpec, WebServiceOutputs> {
  // ...
}
```

### 3. Lifecycle client interface を同居させる

provider は **credential を直接持ちません**。同じファイル内で
`<Provider>LifecycleClient` interface を declare
し、`InMemory<Provider>Lifecycle` クラスをテスト用に export します。production
の lifecycle 配線は [§ factories.ts](#factories-ts-に-production-配線を追加)
で行います。

### 4. Naming convention

| 対象             | rule                                                         |
| ---------------- | ------------------------------------------------------------ |
| Provider id      | kebab-case、cloud / runtime を最初の token (`hetzner-cloud`) |
| Provider version | semver (`1.0.0`)。id にバージョンを含めない                  |
| Capability       | lowercase kebab-case、namespace prefix なし                  |
| Output field     | shape の `outputFields` と完全一致                           |

### 5. mod.ts と deno.json を更新

```ts
// packages/plugins/src/shape-providers/mod.ts
export {
  createHetznerCloudWebServiceProvider,
  type HetznerCloudWebServiceProviderOptions,
} from "./web-service/hetzner-cloud.ts";
```

```jsonc
// deno.json
{
  "exports": {
    "./shape-providers/web-service/hetzner-cloud": "./packages/plugins/src/shape-providers/web-service/hetzner-cloud.ts"
  }
}
```

### 6. テスト

`tests/shape_provider_hetzner_cloud_test.ts` に最低 3 ケース:

1. `apply` が outputs を返し、`outputFields` を満たすこと。
2. `status` が apply 直後に `kind: "ready"` を返すこと。
3. `destroy` 後の `status` が `kind: "deleted"` を返すこと。

`InMemory<Provider>Lifecycle` を inject して動かします。

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
operator gateway 経由で Hetzner Cloud API を呼びます。

cf.
[Operator Bootstrap § Gateway URL pattern](/operator/bootstrap#gateway-url-pattern)

## 新 template の追加

template は **既存 Shape / Provider の合成** だけで作れます。新 Shape を
増やしません。

### 1. ファイルを作る

```
src/templates/<template-id>.ts
```

例: `selfhosted-k3s-cluster.ts`。

### 2. `Template<Inputs>` を export

```ts
import type { ManifestResource, Template } from "takosumi-contract";

export interface SelfhostedK3sClusterInputs {
  readonly serviceName: string;
  readonly image: string;
  readonly port: number;
  readonly namespace?: string;
}

export const SelfhostedK3sClusterTemplate: Template<SelfhostedK3sClusterInputs> = {
  id: "selfhosted-k3s-cluster",
  version: "v1",
  validateInputs(value, issues) { /* ... */ },
  expand(inputs) {
    return [
      { shape: "database-postgres@v1", name: "db",  provider: "@takos/selfhost-postgres", spec: { ... } },
      { shape: "web-service@v1",       name: inputs.serviceName, provider: "@takos/kubernetes-deployment",
        spec: { /* ${ref:db.connectionString} bindings */ } },
    ];
  },
};
```

### 3. Naming convention

- id: kebab-case、`<deployment-style>-<environment>` 形式が推奨
  (`selfhosted-single-vm`, `web-app-on-cloudflare`)。
- version: `vN`。breaking change で increment。

### 4. mod.ts に export

```ts
// src/templates/mod.ts
export { SelfhostedK3sClusterTemplate } from "./selfhosted-k3s-cluster.ts";
```

### 5. registry へ register

operator side で `registerTemplate(SelfhostedK3sClusterTemplate)` を呼ぶか、
bundled template として `mod.ts` 一括 register に追加します。

### 6. 既存 docs を更新

[Templates](/reference/templates) ページの bundled list に新 template を
追記してください。

## 新しい Shape を RFC する

新しい portable resource type を追加する場合は **ecosystem RFC** が必要です
(`CONVENTIONS.md` §6)。

### Process

1. **Issue を立てる** — github issue で motivating use case と既存 Shape では
   足りない理由を提示。
2. **Spec / Outputs / Capability 型を書く** — `src/shapes/<shape-id>.ts` に
   `Shape<Spec, Outputs, Capability>` 実装 (`validateSpec` / `validateOutputs`
   含む)。
3. **TAKOSUMI_BUNDLED_SHAPES に追加** — `src/shapes/mod.ts` に登録。
4. **≥ 2 provider を実装** — portability 不変式: 1 shape = 最低 2 provider。 1
   つの cloud に縛られた Shape は portable とは呼ばないため reject されます。
5. **テスト** — `tests/shape_<shape-id>_test.ts` (validateSpec の境界ケース) と
   `tests/shape_provider_<provider>_test.ts` を整備。
6. **CONVENTIONS.md §1 表を更新**。
7. **docs を更新** — [Shape Catalog](/reference/shapes) に解説 section
   を追加し、 [Provider Plugins](/reference/providers) に 2 つ以上の provider
   を追記。
8. **upstream contract 影響範囲を PR description に記載** — `takosumi-contract`
   側 API 変更が必要な場合は coordination を明示。

### Naming convention

| 対象            | rule                                             |
| --------------- | ------------------------------------------------ |
| Shape id        | kebab-case + `@vN` (`object-store@v1`)           |
| breaking change | 整数 increment (`@v2`)                           |
| capability 追加 | 同じ `@vN` のまま (capability list は open enum) |

### Output schema convention

複数 provider が同じ output shape を返すために、field 名と型は shape 全体で
揃えます (`CONVENTIONS.md` §3 表):

| Suffix / form        | 用途                                       |
| -------------------- | ------------------------------------------ |
| `*Ref` (string)      | secret reference URI (`secret://...`)      |
| `connectionString`   | scheme 付き接続文字列 (`postgresql://...`) |
| `endpoint`, `url`    | scheme 付き URL                            |
| `internalHost`       | private DNS name (no scheme)               |
| `internalPort`       | numeric port                               |
| `bucket`, `database` | non-secret identifier                      |

secret の raw value は **絶対に返しません**。`*Ref` field に
`secret://<provider>/<scope>/<key>` を入れ、kernel 側 secret-store adapter が
解決します。

## Workflow / cron / hook を提供したい場合

GitHub Actions に相当する workflow / cron / lifecycle hook 機能は kernel curated
catalog に含めず、provider plugin が独自 shape として提供します。v1 の予約済み
kernel-side primitive ([Triggers](/reference/triggers),
[Execute-Step Operation](/reference/execute-step-operation),
[Declarable Hooks](/reference/declarable-hooks)) は future route / store 実装の
vocabulary を固定するもので、現行 kernel では active route として expose
されません。現時点では plugin shape を通常の `resources[]` として deploy し、
必要な実行や webhook receiver は provider plugin / operator-side で実装して
ください。multi-step DAG が必要な場合は **template** に複数 single-step shape を
expand させる設計を推奨します — 既存の template mechanism をそのまま再利用
できます。

### Case 1: `cron-job@v1` shape

Schedule trigger と single-step bundle を 1 つの resource として束ねる shape。
spec は `{ cron, missedFirePolicy, bundle, inputs }` 程度で済みます。 provider
plugin / operator-side scheduler が bundle 実行を駆動し、将来の Trigger registry
実装が入ったら同じ vocabulary に移行できます。 例: 夜間 backup runner、 定期
metrics rotate、 TTL 付き artifact GC。 shape spec は CONVENTIONS §6 RFC
として上げ、provider plugin と一緒に出版します。

### Case 2: `workflow-job@v1` shape (single step build / test / migrate)

Manual fire か external-event を受けて 1 ステップだけ走らせる shape。 spec は
`{ triggers, bundle, inputs, retry }`。 typical な使い方は GitHub PR の test
runner 相当で、現時点では webhook receiver は operator-side に置きます。将来の
[Triggers § external-event](/reference/triggers) route が実装されたら同じ
resource vocabulary を kernel trigger に接続できます。 build / test / migrate
のように DAG が要らないケースを最小コストで provide できる shape として位置付け
ます。 multi-step pipeline が必要なら template が複数 `workflow-job@v1` resource
を expand する形で表現します。

### Case 3: `pre-apply-hook@v1` / `post-activate-hook@v1` shape

[Declarable Hooks](/reference/declarable-hooks) を任意の deployment に declare
可能にする shape。 spec は
`{ bindToDeployment, bundle, inputs, hookOrder, failurePolicy, timeout }`。 例:
db migration runner (pre-apply)、smoke test runner / notification poster
(post-activate)。現時点では provider plugin / operator-side が hook dispatch を
担います。将来の Declarable Hooks route / store が実装されたら、同じ
`failurePolicy` vocabulary を kernel dispatch に移行できます。

各 case とも、shape spec / provider plugin 実装 / template による pipeline 化 の
3 レイヤを揃えれば curated 5 shape を変更せずに workflow surface を拡張
できます。 詳細は
[Workflow Extension Design](/reference/architecture/workflow-extension-design)
を参照。

## 関連ページ

- [Reference Index](/reference/) — 全 v1 仕様の索引
- [Shape Catalog](/reference/shapes)
- [Provider Plugins](/reference/providers)
- [Templates](/reference/templates)
- [Triggers](/reference/triggers) — schedule / external-event / manual fire の
  予約済み registry vocabulary
- [Execute-Step Operation](/reference/execute-step-operation) — single-step
  bundle 実行の予約済み primitive
- [Declarable Hooks](/reference/declarable-hooks) — lifecycle hook を declare
  可能にする予約済み bus
- [Workflow Extension Design](/reference/architecture/workflow-extension-design)
  — plugin-first workflow extension の設計 rationale
- [External Participants](/reference/external-participants) — 3rd-party export /
  ExternalImplementation の登録
- [Catalog Release Trust](/reference/catalog-release-trust) — publisher key /
  signature chain
- [Connector Contract](/reference/connector-contract) — connector identity /
  acceptedKinds
- [Manifest](/manifest)
- [Operator Bootstrap](/operator/bootstrap)
- [`CONVENTIONS.md`](https://github.com/takos-jp/takosumi/blob/main/CONVENTIONS.md)
  (canonical)
