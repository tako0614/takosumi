# Internal execution profiles

> runner profile は **public vocabulary ではありません**。 2026-06-07 改訂の [core-spec](../core-spec.md) で公開語彙は
> Space / Source / Connection / OpenTofu Capsule / Installation / Dependency / Run / RunGroup / Deployment /
> OutputSnapshot / Billing / Activity に
> 閉じています。このページは過去名 `runner profile` の互換 reference であり、現在の概念名は
> Connection / CapabilityBinding / policy layer に従属する **internal execution profile** です。

internal execution profile は OpenTofu 実行境界 (execution boundary) の operator-internal な設定です。substrate、
runner image、resource limit、provider allowlist seed を持ちます。

何を **まだ** 持つか:

- **substrate**: どこで OpenTofu を実行するか (Cloudflare Container 等)。
- **runner image**: container image / queue / Durable Object binding。
- **resource limits**: run time / source archive size / decompressed size / memory。
- **provider allowlist seed**: operator が許可する OpenTofu provider source address の seed (最終的な enforcement は Capsule Gate result と plan JSON に対する policy layer が行う)。

何が **移った** か:

- **credential** は Connection と CapabilityBinding が持ちます。 provider credential は internal execution profile に embedded しません。 mint policy は vault 内で run phase ごとに判定し (source → git credential only、 compatibility/normalize/gate → provider credential なし、 plan/apply/destroy → provider credentials only)、 caller の主張を信用しません。
- **allowlist / action policy** は takosumi-policy layer が持ちます。 Capsule compatibility / provider allowlist / module source policy / data source allowlist / resource type allowlist / action policy / billing mode は Capsule Gate result と plan JSON を評価して全 Run に適用されます。

Cloudflare 上の reference topology では、OpenTofu の `plan/apply` は Cloudflare Container runner が実行します。Workers for Platforms は tenant / user Worker の dispatch runtime としてだけ使い、provider credential を持つ runner とは分けます。

## Shape

これは operator 内部の **resolved execution view** の例です。`stateBackend` は operator-managed state/lock の参照です。
provider credential は Connection / CapabilityBinding / vault policy から run phase ごとに解決され、internal execution profile は
credential value や credential 所有権を持ちません。

```json
{
  "id": "cloudflare-container",
  "name": "Cloudflare Container runner",
  "substrate": "cloudflare-containers",
  "tofuVersion": "1.10.0",
  "stateBackend": {
    "kind": "operator-managed",
    "ref": "state://takosumi/cloudflare",
    "lock": {
      "kind": "native",
      "ref": "lock://takosumi/cloudflare"
    }
  },
  "allowedProviders": ["registry.opentofu.org/cloudflare/cloudflare"],
  "sourcePolicy": {
    "allowLocalSource": false
  },
  "resourceLimits": {
    "maxRunSeconds": 900,
    "maxSourceArchiveBytes": 104857600,
    "maxSourceDecompressedBytes": 1048576000,
    "memoryMb": 1024
  },
  "networkPolicy": {
    "mode": "egress-allowlist",
    "allowedHosts": ["api.cloudflare.com", "registry.opentofu.org"]
  },
  "cloudflareContainer": {
    "image": "registry.example.com/takosumi/opentofu-runner:1.10",
    "queueName": "takosumi-opentofu-runs",
    "durableObjectBinding": "RUNNER"
  },
  "cloudflareWorkersForPlatforms": {
    "dispatchNamespace": "takosumi-tenants",
    "dispatchWorkerBinding": "TAKOSUMI_TENANT_DISPATCH",
    "outboundWorker": {
      "serviceBinding": "TAKOSUMI_OUTBOUND_WORKER",
      "enforceNetworkPolicy": true
    },
    "userWorkerBindings": {
      "mode": "tenant-scoped-only",
      "allowedBindingKinds": [
        "kv_namespace",
        "durable_object_namespace",
        "queue",
        "r2_bucket",
        "d1_database"
      ]
    }
  },
  "secretExposurePolicy": {
    "providerCredentials": "runner-only",
    "tenantWorkerOperatorSecrets": "forbidden",
    "redactLogs": true,
    "blockSensitiveOutputs": true
  }
}
```

## Provider policy

`allowedProviders` は operator がこの execution boundary で許可する provider source address の **allowlist seed** です。
`deniedProviders` は emergency blocklist です。最終的な enforcement は policy layer が Capsule Gate result と plan JSON を評価して全 Run に適用します。

最終的な provider set は Capsule Gate と runner が OpenTofu plan / provider lock から観測した内容で確認します。
runner-observed provider が allowlist 外なら policy は blocked になり、apply Run は作れません。必要な provider credential
を Connection / CapabilityBinding から解決できない Run も provider credential mint 前に blocked です。

## Source policy

`git` と `prepared` source は通常の production source です。`local` source は dev / operator-local execution profile 用であり、operator が `sourcePolicy.allowLocalSource: true` を明示した場合だけ plan Run を作れます。tenant input を扱う profile では local path を許可しません。

prepared source は runner が fetch する archive です。reference runner は `resourceLimits.maxSourceArchiveBytes` で wire size、`resourceLimits.maxSourceDecompressedBytes` で tar header 上の展開後 size を制限し、unsafe path、duplicate normalized path、link、file / directory 以外の tar entry を展開前に拒否します。

## Common provider allowlist seeds

Default execution profile は OpenTofu provider source address を allowlist seed します。これは provider adapter registry や
public API ではなく、operator が許可した OpenTofu 実行境界の例です。

`cloudflare-default` は reference Cloudflare topology 用の enabled seed です。AWS / GCP / Azure / Kubernetes / GitHub /
DigitalOcean / Docker は operator が Connection、state backend、network enforcement、live proof を確認してから有効化する
template 例です。template は operator-internal metadata として扱い、CapabilityBinding / policy に解決されるまで
Capsule author や public API consumer には見せません。

| Seed                   | State    | Providers                                                                            | Network policy                                                                       |
| ---------------------- | -------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| `cloudflare-default`   | enabled  | `registry.opentofu.org/cloudflare/cloudflare`                                        | `api.cloudflare.com`                                                                 |
| `aws-default`          | template | `registry.opentofu.org/hashicorp/aws`                                                | `sts.amazonaws.com`、`iam.amazonaws.com`、`route53.amazonaws.com`、`*.amazonaws.com` |
| `gcp-default`          | template | `registry.opentofu.org/hashicorp/google`                                             | `oauth2.googleapis.com`、`cloudresourcemanager.googleapis.com`、`*.googleapis.com`   |
| `azure-default`        | template | `registry.opentofu.org/hashicorp/azurerm`                                            | `login.microsoftonline.com`、`management.azure.com`、`*.azure.com`                   |
| `kubernetes-default`   | template | `registry.opentofu.org/hashicorp/kubernetes`、`registry.opentofu.org/hashicorp/helm` | operator-managed cluster API                                                         |
| `github-default`       | template | `registry.opentofu.org/integrations/github`                                          | `api.github.com`                                                                     |
| `digitalocean-default` | template | `registry.opentofu.org/digitalocean/digitalocean`                                    | `api.digitalocean.com`                                                               |
| `docker-local`         | template | `registry.opentofu.org/kreuzwerker/docker`                                           | local Docker daemon / operator-managed                                               |

`allowedHostPatterns` は provider API の region / service suffix を記録するための internal field です。実際の egress enforcement は runner substrate の責務です。

## State backend

state backend は Takosumi の public output ではありません。Deployment record には state backend reference と lock evidence だけを残します。

state value、credential value、secret output は public ledger に保存しません。

## Cloudflare Containers

Cloudflare Container runner は hosted execution substrate の一つです。Takosumi API process と OpenTofu apply side effect を分けるために使います。

container image、queue、Durable Object binding、work directory は execution profile の `cloudflareContainer` に入ります。実際の secret delivery と provider account は operator environment の責務です。

reference runner は SourceSnapshot を run directory に materialize し、Capsule Normalizer / Gate の結果から generated root と `takosumi.auto.tfvars.json` を作ります。`tofu plan -out <tfplan>` で作った binary plan file の digest を `planDigest` / `planArtifact.digest` として返します。Cloudflare reference execution profile では Durable Object がその `tfplan` を `R2_ARTIFACTS` R2 bucket に昇格し、plan Run には encrypted artifact ref を記録します。apply Run では artifact を R2 から runner に復元し、同じ digest を再計算して一致した場合だけ source materialize / `tofu init` / `tofu apply <tfplan>` に進みます。`terraform.tfstate` は Installation ごとの encrypted StateSnapshot 世代として R2_STATE に復元/保存されます。

## Workers for Platforms

Workers for Platforms は OpenTofu runner ではありません。tenant / user Worker の HTTP ingress と dispatch runtime です。

`cloudflareWorkersForPlatforms` は dispatch namespace、dispatch Worker binding、outbound Worker、user Worker に許可する binding の種類を記録します。operator の provider credential、Deploy Control token、state backend credential は user Worker に binding しません。

outbound Worker は tenant Worker からの外向き通信を operator policy に通すための場所です。`networkPolicy` がある execution boundary では、outbound Worker でも同じ allowlist を enforce する必要があります。

`worker/src/wfp_dispatch_worker.ts` は ingress dispatch の scaffold であり、egress allowlist enforcement を実装しません。`outboundWorker.enforceNetworkPolicy: true` は、operator が dispatch namespace の outbound Worker 設定と allowlist enforcement の live evidence を示したときだけ満たされたものとして扱います。

## Secret exposure policy

`secretExposurePolicy.providerCredentials: "runner-only"` は provider credential を Container runner だけで解決するという宣言です。reference runner は OpenTofu subprocess に host env 全体を渡しません。provider credential は Connection / CapabilityBinding / vault policy と provider-specific env allowlist から明示的に注入された値だけが渡ります。operator-local secret reference は operator secret delivery layer が runner env / mount / short-lived token に解決してから runner を起動します。

`tenantWorkerOperatorSecrets: "forbidden"` は tenant / user Worker に operator secret を渡さないという宣言です。tenant に必要な値は tenant-scoped binding、短命 token、または operator が Connection policy に従って安全に materialize した値だけにします。

`redactLogs` が true の execution boundary では runner diagnostics と failure audit message を保存前に redact します。`blockSensitiveOutputs` が true の execution boundary では `tofu output -json` の sensitive output を OutputSnapshot の `publicOutputs` / `spaceOutputs` に projection しません。
