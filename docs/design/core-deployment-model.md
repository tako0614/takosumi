# Core Deployment Model

Core Deployment Model は、authoring manifest から compile された後に kernel が
保持する正本 state model である。manifest syntax ではなく、
`Deployment`、`ProviderObservation`、`GroupHead` が deploy core の canonical
records になる。

## Canonical Records

| Record                | Role                                                                                         |
| --------------------- | -------------------------------------------------------------------------------------------- |
| `Deployment`          | 入力 manifest snapshot、descriptor closure、resolved graph、desired state、status を持つ正本 |
| `ProviderObservation` | provider / runtime 側から見た observed state。canonical desired state ではない               |
| `GroupHead`           | `space_id + group_id` ごとの current deployment pointer                                      |

`Deployment` は以下を保持する。

- `input`: `manifest_snapshot`, `source_kind`, `source_ref`, `env`, `group`
- `resolution`: `descriptor_closure`, `resolved_graph`
- `desired`: `routes`, `bindings`, `resources`, `runtime_network_policy`,
  `activation_envelope`
- `status`: `preview`, `resolved`, `applying`, `applied`, `failed`,
  `rolled-back`
- `conditions`, `policy_decisions`, `approval`, `rollback_target`

`ProviderObservation` は `present` / `missing` / `drifted` / `unknown` を表す。
drift status は `provider-object-missing`、`config-drift`、`status-drift`、
`security-drift`、`ownership-drift`、`cache-drift` などを持てる。

`GroupHead` は strongly consistent な group pointer である。rollback は過去の
Deployment を新しい head として進める。multi-generation rollback 用の
`group_head_history` も実装済みである。

source:

- `packages/contract/src/core-v1.ts`
- `packages/kernel/src/domains/deploy/deployment_service.ts`
- `packages/kernel/src/domains/deploy/group_head_history.ts`

## ObjectAddress

Core v1 は object を単なる string name ではなく `ObjectAddress` で扱う。

```text
component:api
resource:db
output:public-url
provider-output:aws-rds-endpoint
```

`ObjectAddress` は `namespace:encoded-name` segment を `/` で連結した stable
address である。component / resource / output / provider-output / group などを
同じ address system で扱える。

この抽象により、manifest 上の論理名、provider output、deployment route、 binding
source、policy subject は同じ addressable object として扱える。

source:

- `packages/contract/src/core-v1.ts`

## Descriptor Closure

contract / runtime / resource / interface / output / provider / composite は
JSON-LD descriptor として表現される。resolution 時には descriptor と依存 context
を closure にして digest pin する。

official descriptor set には以下の family がある。

- authoring descriptors
- composites
- artifacts
- interfaces
- outputs
- resources
- runtimes
- providers

次期 `contract` / `provider` / `bundle` plugin model は、この descriptor closure
と digest pinning を resolution layer の正本として使う。plugin が新しい世界を
増やしても、kernel は closure digest によって「何を信じて plan したか」を保持
できる。

source:

- `packages/kernel/src/domains/deploy/core_plan.ts`
- `packages/kernel/src/domains/deploy/descriptor_closure.ts`
- `packages/kernel/src/domains/deploy/descriptors/`

## Authoring Surfaces

Core contract には既に `App`、`Environment`、`Policy` の authoring shape が
ある。

```ts
interface CoreAppSpec {
  apiVersion: "takosumi.com/v1";
  kind: "App";
  name: string;
  components: Record<string, CoreComponentSpec>;
  exposures?: Record<string, CoreExposureSpec>;
  outputs?: Record<string, CoreOutputSpec>;
  requirements?: JsonObject;
}

interface CoreEnvSpec {
  apiVersion: "takosumi.com/v1";
  kind: "Environment";
  providerTargets?: Record<string, CoreProviderTargetSpec>;
  router?: JsonObject;
  runtimeNetworkPolicy?: JsonObject;
  accessPathPreferences?: JsonObject;
}

interface CorePolicySpec {
  apiVersion: "takosumi.com/v1";
  kind: "Policy";
  descriptorPolicy?: JsonObject;
  bindingPolicy?: JsonObject;
  routerPolicy?: JsonObject;
  resourcePolicy?: JsonObject;
  approvals?: JsonObject;
}
```

deploy domain には `.takos/app.yml` 相当の `PublicDeployManifest` → `AppSpec`
compiler もある。次期 manifest は、この compiler path を置き換えるか 前段に
vNext normalizer を追加する形で統合する。

source:

- `packages/contract/src/core-v1.ts`
- `packages/kernel/src/domains/deploy/types.ts`
- `packages/kernel/src/domains/deploy/compiler.ts`

## Binding And Output

`Output` は producer が publish する typed value であり、consumer へ自動で渡る
値ではない。consumer へ渡すには explicit binding が必要である。

binding source は次の 4 種類。

| Source            | Meaning                                          |
| ----------------- | ------------------------------------------------ |
| `resource`        | resource claim から access mode を通じて注入する |
| `output`          | explicit output declaration から値を受け取る     |
| `secret`          | secret store から secret reference を注入する    |
| `provider-output` | provider が返した typed output を受け取る        |

binding には `injection`、`sensitivity`、`enforcement`、`resolutionPolicy`、
`accessPath` が付与される。external boundary を越える binding は runtime network
policy の egress allow rule や policy decision を通る。

source:

- `packages/contract/src/core-v1.ts`
- `packages/kernel/src/domains/deploy/binding_resolver.ts`
- `packages/kernel/src/domains/deploy/resolved_graph.ts`

## Policy Decision

Core v1 には policy decision と condition reason catalog が実装済みである。

policy decision outcome:

- `allow`
- `deny`
- `require-approval`

policy gate:

- `descriptor-resolution`
- `authoring-expansion`
- `graph-projection`
- `provider-selection`
- `binding-resolution`
- `access-path-selection`
- `operation-planning`
- `activation-preview`
- `apply-phase-revalidation`
- `repair-planning`
- `rollback-planning`

次期 manifest model は、plan warning を free text として流すだけではなく、
`DeploymentPolicyDecision` / `DeploymentCondition` に落とし込める形にする。

source:

- `packages/contract/src/core-v1.ts`
- `packages/kernel/src/api/condition_reasons.ts`
