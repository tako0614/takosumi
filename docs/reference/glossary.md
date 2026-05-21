# 用語集 {#glossary}

> このページでわかること: Takosumi の重要用語 (= AppSpec / Installation /
> Deployment / Component / Kind / Materializer / Provider plugin / KernelPlugin
> / Namespace pub/sub / Artifact / Reference operator distribution / Wave J — N
> narrative) の定義 + 関連 reference doc への cross-link。

> **2-layer narrative**: 各用語は **「現状 (Wave L まで)」** (= takosumi kernel
> 0.14 系の actual behavior) と **「Wave N planned」** (= RFC 0001 で確定済
> roadmap) の 2 layer で説明する。 詳細 design は
> [RFC 0001 — kernel kind-agnostic](../rfc/0001-kernel-kind-agnostic.md)
> を参照。

## AppSpec

`.takosumi.yml` の root document。 source root に置く 1 file で install / deploy
/ rollback まで動く Takosumi の **唯一の public manifest 形式**。

- **現状 (Wave L まで)**: root は `{ apiVersion, metadata, components }` の **3
  field**。 `apiVersion` は bare `"v1"` 固定 (Wave L 以降 `takosumi.dev/` 等の
  group prefix は redundant として削除済)。 旧 root `kind: App` field は Wave K
  で物理削除済。
- **Wave N planned**: root contract に変更なし (= AppSpec envelope は Wave N の
  scope 外)。 ただし内部 Component の `kind:` field は今後 operator-injected
  alias map で resolve される (= 後述 [Kind](#kind))。

詳細: [AppSpec (`.takosumi.yml`)](./app-spec.md) /
[Manifest](./manifest.md#data-model)

## Installation

Space に入った AppSpec 1 つ (= 所有 / 課金 / 現在状態を 持つ entity)。 同じ
AppSpec を 異なる Space に install すれば、 異なる Installation が それぞれ
作られる。 1 Installation は 0 以上の Deployment 履歴を持つ。

- 作成: `POST /v1/installations` (= 5 endpoint の中核)
- 削除: `DELETE` は持たない (= operator account-plane の責務)
- public API surface は 5 endpoint だけ (`POST /v1/installations/dry-run` /
  `POST /v1/installations` / `POST /v1/installations/{id}/deployments/dry-run` /
  `POST /v1/installations/{id}/deployments` /
  `POST /v1/installations/{id}/rollback`)

詳細: [Installer API](./installer-api.md)

## Deployment

1 回の apply 結果 (= 履歴 / audit / rollback の単位)。 Installation の current
state は 「最後に successful だった Deployment」 で 決まる。

- 失敗した Deployment も record される (= audit のため)
- rollback は specific Deployment を指して reapply する形 (=
  `POST /v1/installations/{id}/rollback`)
- evidence (= provider decision / outputs / kind URI / digest 等) は Deployment
  に persist される

詳細: [Manifest § Data model](./manifest.md#data-model) /
[Lifecycle Phases](./lifecycle-phases.md)

## Component

AppSpec の `components` map の child entry。 1 component = 1 portable resource
declaration。

- **現状 (Wave L まで)**: `{ kind, spec, publish, listen, build }` の **5
  field**。 `name` は map key として表現 (= field ではない)。
- **Wave N planned**: `build` field 物理削除予定 →
  `{ kind, spec, publish, listen }` の **4 field** に。 build は別 `kind: build`
  component に移管予定 (= RFC 0001 §5)。

詳細: [AppSpec § `components`](./app-spec.md#components)

## Kind

Component の type discriminator (= 「contract」 を URI で識別する文字列)。
materializer 解決の key になる。

- **現状 (Wave L まで)**: 短い alias (= `worker` / `postgres` / `object-store` /
  `custom-domain`) または完全な JSON-LD URI (= 例
  `https://takosumi.com/kinds/v1/worker`) が書ける。 alias は takosumi kernel
  core が hardcoded で認識する 4 種。
- **Wave N planned**: alias の hardcoded 認識を物理削除。 全 alias は
  **operator-injected alias map** (= `createPaaSApp({ aliases })`、 RFC 0001
  §4.4) 経由で resolve される。 takosumi-cloud reference distribution は
  `https://cloud.takosumi.com/kinds/v1/<name>` で 6 kind を publish 予定 (=
  worker / postgres / object-store / custom-domain / build / oidc)。

詳細: [Kind Catalog](./kind-catalog.md#component-kinds)

## Materializer

Kind を 実体化する code (= 「desired state spec を 実 cloud resource に 変換する
apply 関数 + lifecycle hook」)。 contract 上 **`KernelPlugin` または
`InlineMaterializer` の union 形態** を 取る:

- **`KernelPlugin`** — `provides[]` で kind URI を declare する factory function
  (= cloud provider package が 提供する形式、 Vite plugin pattern)。
- **`InlineMaterializer`** — `createPaaSApp({ materializers: [...] })` に 渡せる
  inline 関数 (= operator が小さい recipe を 直接書きたいとき用)。

両形態は contract (= input spec validate + apply 関数 + outputs 返却 + publishes
register) を満たせば 同等に valid。

詳細: [Extending Takosumi](../extending.md) / [Provider Plugins](./providers.md)

## Provider plugin

KernelPlugin の cloud-specific 実装 (= 例 `awsS3ObjectStoreProvider()` /
`cloudflareWorkerProvider()`)。 別 package
`@takos/takosumi-{aws,gcp,cloudflare,kubernetes,deno-deploy,selfhost}-providers`
として 公開され、 operator は必要な cloud だけ import する。

- takosumi core (= kernel / plugins / cli) は cloud SDK に依存しない (= core
  neutrality)
- credential は operator が opts として inject する (= kernel は credential を
  見ない)
- 21 bundled provider plugin (= 20 default + 1 opt-in)

詳細: [Provider Plugins](./providers.md)

## KernelPlugin

plugin contract の interface 名 (= `packages/contract/src/plugin.ts`)。 factory
function が return する shape:

- `name` (例 `"@takos/cloudflare-workers"`)
- `version` (= semver string)
- `provides[]` — 実装する kind URI(s) の array
- `capabilities[]` — 宣言 capability (= open string、 reserved prefix は
  `takos.*` / `system.*` / `operator.*`)
- `apply(spec, ctx)` / `destroy(handle, ctx)` — provider lifecycle
- `onInstallStart` / `onInstallComplete` / `onDeploymentStart` /
  `onDeploymentComplete` — optional lifecycle hook

詳細: [Provider Plugins § Public API surface](./providers.md#public-api-surface)

## Namespace pub/sub

Component 間の接続を表現する **唯一の model** (= 旧 `use:` edge / `${ref:...}`
placeholder syntax は廃止)。 各 component は 2 つの edge を 持つ:

- **`publish: [<namespacePath>]`** — 自分の outputs を namespace registry に
  登録する
- **`listen: { <namespacePath>: { as, prefix?, mount? } }`** — 他 component の
  publish material を 受け取り、 env / mount / target の形で 注入する

cross-Installation 共有 (= 例 Takosumi Accounts の `operator.identity.oidc`
namespace pub) も 同じ shape で 扱える。

詳細: [Manifest § Expand Semantics](./manifest.md#expand-semantics)

## Artifact

`build` component の output (= digest-pinned URL + sha256)。 worker kind は
`spec.artifact` で artifact reference を取り、 materializer が cloud (= Workers
script / Lambda zip 等) に 投入する。

- **現状 (Wave L まで)**: `Component.build` field (= `{ command, output }` の
  最小 recipe) で AppSpec 内に build step を書ける。 jobs / steps / matrix /
  triggers / pipeline は持たない (= CI workflow ではない)。
- **Wave N planned**: `Component.build` field 物理削除、 別 `kind: build`
  component に移管。 別 build component の outputs を `worker` 等が `listen`
  edge 経由で受け取る model に進化 (= RFC 0001 §5)。

詳細: [AppSpec](./app-spec.md) /
[RFC 0001 §5](../rfc/0001-kernel-kind-agnostic.md#5-build-kind-details-第-3-軸-detail)

## Reference operator distribution

Takosumi ecosystem 上で **1 つの実装例** として ship される operator
distribution。 「公式 / blessed」 ではなく **alternative も 同 contract で
同列**:

- **`takosumi-cloud/`** — identity / billing / OIDC issuer / Installation ledger
  / dashboard を package する operator account-plane の reference distribution
  (= 2 reference deploy artifact: `deploy/cloudflare/` (Workers + D1 + R2) と
  `deploy/node-postgres/` (Deno + Postgres + Caddy))
- alternative distribution は spec 上 完全に置き換え可能 (= contract-compatible
  であれば architectural privilege なし)

詳細: [Architecture Overview](./architecture/index.md) /
[Provider Plugins](./providers.md)

## Wave J / K / L / M / N narrative

Takosumi minimization sequence (= 段階的 contract surface 削減 / 構造変更):

- **Wave J** (= 2026-05-19 完遂) — Component contract minimization。 旧
  `Component.routes` / `AppSpec.interfaces` / `AppSpec.permissions` 削除。
  [ecosystem ROADMAP](https://github.com/tako0614/takos/blob/master/ROADMAP.md)
- **Wave K** (= 2026-05-20 完遂) — AppSpec root envelope minimization。 root
  `kind: App` field 物理削除。
  [ecosystem ROADMAP](https://github.com/tako0614/takos/blob/master/ROADMAP.md)
- **Wave L** (= 2026-05-20 完遂) — AppSpec `apiVersion` group prefix removal。
  `takosumi.dev/v1` → bare `"v1"` 化。
  [ecosystem ROADMAP](https://github.com/tako0614/takos/blob/master/ROADMAP.md)
- **Wave M** (= 2026-05-20 完遂) — website landing IA + docs restructure (=
  `takosumi.com/docs/` 統合 + `/contexts/` overlay)。
  [ecosystem ROADMAP](https://github.com/tako0614/takos/blob/master/ROADMAP.md)
- **Wave N** (= 2026-05-21 RFC stage) — kernel kind-agnostic 化 +
  `Component.build` 削除 + curated catalog 完全廃止 + 全 kind を operator
  distribution が JSON-LD + plugin で 持ち込む model に進化予定。
  [RFC 0001](../rfc/0001-kernel-kind-agnostic.md)

## 関連 doc

- [AppSpec (`.takosumi.yml`)](./app-spec.md) — envelope / components / publish /
  listen / build recipe の全 field 仕様
- [Manifest](./manifest.md) — validation rules / expand semantics / data model
- [Kind Catalog](./kind-catalog.md) — curated 4 kind の spec / outputs / publish
  / listen
- [Provider Plugins](./providers.md) — 21 bundled provider / KernelPlugin attach
- [Extending Takosumi](../extending.md) — 新 kind / provider の追加手順
- [RFC 0001](../rfc/0001-kernel-kind-agnostic.md) — Wave N design (kernel
  kind-agnostic 化)
