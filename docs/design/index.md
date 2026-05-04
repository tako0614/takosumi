# Takosumi Design Notes

Takosumi の設計 doc は、巨大な 1 本の設計書ではなく、中核抽象ごとに分離して
読む。manifest は入り口だが、Takosumi の本体は manifest syntax ではない。
Takosumi の本体は、宣言を deployment graph と lifecycle operation へ変換する
PaaS kernel である。

## Reading Order

| Doc                                                              | Core question                                    |
| ---------------------------------------------------------------- | ------------------------------------------------ |
| [Manifest Model](/design/manifest-model)                         | ユーザーが何を宣言するか                         |
| [Core Deployment Model](/design/core-deployment-model)           | kernel が何を正本 record として保持するか        |
| [Execution Lifecycle](/design/execution-lifecycle)               | plan / apply / destroy / rollback をどう進めるか |
| [Routing Model](/design/routing-model)                           | route をどの層で扱い、何を canonical にするか    |
| [Artifacts and Supply Chain](/design/artifacts-and-supply-chain) | artifact / plugin / trust をどこで切るか         |
| [Operator Boundaries](/design/operator-boundaries)               | self-host 運用でどこを閉じ、どこを公開するか     |

## Conceptual Layers

Takosumi の抽象は次の層に分ける。

| Layer             | Canonical abstraction                                     | Owned by                          |
| ----------------- | --------------------------------------------------------- | --------------------------------- |
| Authoring         | `Manifest`, `Component`, `Contract`, `Provider`, `Bundle` | manifest compiler / plugins       |
| Resolution        | descriptor closure, resolved graph, policy decisions      | kernel deploy core                |
| Deployment state  | `Deployment`, `ProviderObservation`, `GroupHead`          | `takosumi-contract` / state store |
| Execution         | plan, apply, destroy, status, rollback                    | kernel orchestrator               |
| Data plane        | runtime-agent, connector, provider handle                 | runtime-agent / provider plugin   |
| Routing           | app route, deployment route, route assignment, endpoint   | deploy core / routing domain      |
| Supply chain      | artifact, plugin manifest, lock, trust policy             | artifact store / plugin loader    |
| Operator boundary | auth, secret store, adapter wiring, observability         | self-host operator                |

## Design North Star

Takosumi は plugin で拡張できる OSS / self-hostable PaaS kernel である。Docker、
VM、Kubernetes、systemd、Cloudflare、AWS、GCP、Azure、VPS、自宅サーバー、
managed database、object storage、queue、DNS、domain、edge runtime、
runtime-agent などを、同じ宣言モデルから plan / deploy / manage できるように
する。

ただし core は cloud catalog ではない。core は parse、validation、plugin
resolution、bundle expansion、DAG construction、provider compatibility check、
plan generation、apply / destroy / status orchestration、state persistence、
reference resolution、runtime-agent boundary を担当する。何を作るか、どこで
どう作るか、どの bundle を展開するかは plugin が定義する。

## Stable Design Decisions

- すべての deploy 対象は `component` として扱う。
- compute resource も storage / database / domain / queue と同じ component
  family に入れる。
- manifest は宣言的に書く。
- manifest authoring は `resources` / `templates` に分けず、`components[]` に
  統一する方向を canonical とする。
- core-owned catalog は最小化し、contract / provider / bundle / connector の
  定義は plugin へ寄せる。
- provider はできるだけ具体にする。
- deploy-anywhere 的なまとまりは `bundle` で表す。
- bundle は lifecycle resource ではなく、plan 時に concrete components へ展開
  される authoring abstraction とする。
- plugin dependency は manifest に書けるが、apply は lock 済み plugin だけを
  対象にする。
- `Output` は publish された typed value であり、consumer へ渡すには explicit
  binding が必要。
- route は複数層に分かれる。HTTP API route、manifest route、Deployment route、
  routing projection、service endpoint を混同しない。
- kernel adapter plugin と manifest dependency plugin は別物として扱う。

## Source Anchors

- `packages/contract/src/core-v1.ts`
- `packages/contract/src/plugin.ts`
- `packages/contract/src/runtime-agent-lifecycle.ts`
- `packages/kernel/src/domains/deploy/`
- `packages/kernel/src/domains/routing/`
- `packages/kernel/src/domains/service-endpoints/`
- `packages/kernel/src/plugins/`
- `docs/reference/kernel-http-api.md`
- `docs/reference/lifecycle.md`
- `docs/reference/runtime-agent-api.md`
- `docs/operator/self-host.md`
