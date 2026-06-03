# Model

Takosumi v1 の model は OpenTofu module repo と run ledger だけです。

```text
OpenTofu module repo
  -> PlanRun
  -> ApplyRun
  -> Deployment
  -> DeploymentOutput
```

## Installation

Installation は Space 内の installed module record です。保持する情報は source、runner profile、status、current deployment pointer です。

source は `git`、`prepared`、`local` のいずれかです。production operator は通常 `git` または `prepared` を使い、`local` は dev / operator-local profile 用です。`local` source は RunnerProfile が `sourcePolicy.allowLocalSource: true` を明示した場合だけ受け付けます。

## PlanRun

PlanRun は review 可能な plan attempt です。Takosumi は次を記録します。

- source digest
- variables digest
- required providers
- policy decision と policy decision digest
- plan digest
- immutable plan artifact reference と digest
- provider lock digest
- update / destroy の場合は plan 時点の Installation current Deployment pointer
- audit events

PlanRun が成功しても infrastructure は変わりません。
PlanRun が返す `planArtifact.digest` は `planDigest` と一致します。reference runner ではこれは binary `tfplan` file の digest です。Cloudflare reference profile は reviewed `tfplan` を `TAKOS_ARTIFACTS` R2 bucket の `opentofu-plan-runs/` prefix に保存し、PlanRun には `kind: "object-storage"` の artifact ref を残します。ApplyRun はこの immutable artifact を runner に復元して `tofu apply <reviewed-plan>` を実行するため、review していない source / variables / provider lock から再 plan した内容を apply しません。

## ApplyRun

ApplyRun は PlanRun から作ります。request の `expected` guard は PlanRun の digest と一致する必要があります。

guard が一致しない場合、Takosumi は apply を拒否します。これは「review した plan artifact」と「実際に apply する artifact」がずれる事故を防ぐためです。update / destroy では Installation の current Deployment pointer が PlanRun 作成時から変わっていても拒否します。Accounts / dashboard facade も PlanRun から missing guard field を補完せず、PlanRun response または facade のreview responseの expected guard 全体を apply request に持ち越します。

ApplyRun は state backend、state lock evidence、runner profile、diagnostics、audit events を記録します。

## Deployment

Deployment は成功した ApplyRun の結果です。current Deployment pointer は Installation に保存されます。失敗した ApplyRun は Deployment になりません。

## DeploymentOutput

DeploymentOutput は `tofu output -json` から作ります。secret output は公開 ledger value にしません。public URL、health URL、docs URL など、operator policy が公開可能と判断した output だけを残します。

## RunnerProfile

RunnerProfile は execution boundary です。Takosumi の source repo では provider credential value を持ちません。credential reference、provider allowlist、state backend、resource limit、network policy、Cloudflare Container execution、Cloudflare Workers for Platforms dispatch runtime、secret exposure policy などは RunnerProfile に入ります。

Cloudflare topology では、OpenTofu runner は Container、tenant / user Worker の ingress は Workers for Platforms です。provider credential、Deploy Control token、state backend credential は tenant / user Worker に渡しません。

詳しくは [Runner profiles](./runner-profiles.md)。
