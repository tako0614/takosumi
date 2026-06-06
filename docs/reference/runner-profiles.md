# Runner profiles

> runner profile は **public vocabulary ではありません**。 2026-06-06 改訂の [core-spec](../core-spec.md) で公開語彙は
> Space / Source / Connection / Installation / Dependency / Run / RunGroup / Deployment / OutputSnapshot / Activity に
> 閉じ、 runner profile は Connection / CapabilityBinding / policy layer に従属する **internal execution profile** に降格しました。

runner profile は OpenTofu 実行境界 (execution boundary) の internal な設定です。 substrate、 runner image、 resource limit、 provider allowlist seed を持ちます。

何を **まだ** 持つか:

- **substrate**: どこで OpenTofu を実行するか (Cloudflare Container 等)。
- **runner image**: container image / queue / Durable Object binding。
- **resource limits**: run time / source archive size / decompressed size / memory。
- **provider allowlist seed**: profile が許可する OpenTofu provider source address の seed (最終的な enforcement は core-spec §25 policy layer が plan JSON に対して行う)。

何が **移った** か:

- **credential** は [Connection](../core-spec.md#8-connection) と [CapabilityBinding](../core-spec.md#9-operator-default-connections) が持ちます。 provider credential は runner profile に embedded しません。 mint policy は vault 内で run phase ごとに判定し (source → git credential only、 build → none、 plan/apply/destroy → provider credentials only)、 caller の主張を信用しません (core-spec §32)。
- **allowlist / action policy** は [takosumi-policy layer](../core-spec.md#25-policy) が持ちます。 provider allowlist (layer 4) / resource type allowlist (layer 5) / action policy (layer 7) は plan JSON を評価して全 Run に適用されます。

Cloudflare 上の reference topology では、OpenTofu の `plan/apply` は Cloudflare Container runner が実行します。Workers for Platforms は tenant / user Worker の dispatch runtime としてだけ使い、provider credential を持つ runner とは分けます。

## Shape

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
  "allowedProviders": [
    "registry.opentofu.org/cloudflare/cloudflare"
  ],
  "credentialRefs": [
    {
      "provider": "registry.opentofu.org/cloudflare/cloudflare",
      "ref": "secret://cloudflare/api-token",
      "required": true
    }
  ],
  "requireCredentialRefs": true,
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
    "allowedHosts": [
      "api.cloudflare.com",
      "registry.opentofu.org"
    ]
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

`allowedProviders` はこの profile が許可する provider source address の **allowlist seed** です。`deniedProviders` は emergency blocklist です。 最終的な enforcement は [core-spec §25 policy layer](../core-spec.md#25-policy) (provider allowlist = layer 4) が plan JSON を評価して全 Run に適用します。

plan Run request の `requiredProviders` は runner 起動前の provider source address 契約です。operator-facing CLI / CI は、review 済み module が使う OpenTofu provider をここに列挙します。profile が `allowedProviders` を持つ場合、空の `requiredProviders` は `tofu init` 前に blocked になります。

最終的な `requiredProviders` は runner が OpenTofu plan / provider lock から観測した provider set で上書きまたは確認されます。runner-observed provider が allowlist 外なら policy は blocked になり、apply Run は作れません。`requireCredentialRefs` が true の場合、required provider に credential reference (Connection 解決済み) がない plan Run も blocked です。

## Source policy

`git` と `prepared` source は通常の production source です。`local` source は dev / operator-local profile 用であり、profile が `sourcePolicy.allowLocalSource: true` を明示した場合だけ plan Run を作れます。tenant input を扱う profile では local path を許可しません。

prepared source は runner が fetch する archive です。reference runner は `resourceLimits.maxSourceArchiveBytes` で wire size、`resourceLimits.maxSourceDecompressedBytes` で tar header 上の展開後 size を制限し、unsafe path、duplicate normalized path、link、file / directory 以外の tar entry を展開前に拒否します。

## Common provider profiles

Default execution profile は OpenTofu provider source address を allowlist seed します。これは provider adapter registry ではなく、operator が許可した OpenTofu 実行境界です。

`cloudflare-default` は reference Cloudflare topology 用の enabled profile です。AWS / GCP / Azure / Kubernetes / GitHub / DigitalOcean / Docker は operator が credential ([Connection](../core-spec.md#8-connection))、state backend、network enforcement、live proof を確認してから有効化する template です。template profile は `labels["takosumi.com/profile-state"] === "template"` として返され、operator が `labels["takosumi.com/profile-enabled"] === "true"` を設定するまで policy で blocked になります。

| Profile | State | Providers | Credential ref | Network policy |
| --- | --- | --- | --- | --- |
| `cloudflare-default` | enabled | `registry.opentofu.org/cloudflare/cloudflare` | `secret://takosumi/cloudflare-default` | `api.cloudflare.com` |
| `aws-default` | template | `registry.opentofu.org/hashicorp/aws` | `secret://takosumi/aws-default` | `sts.amazonaws.com`、`iam.amazonaws.com`、`route53.amazonaws.com`、`*.amazonaws.com` |
| `gcp-default` | template | `registry.opentofu.org/hashicorp/google` | `secret://takosumi/gcp-default` | `oauth2.googleapis.com`、`cloudresourcemanager.googleapis.com`、`*.googleapis.com` |
| `azure-default` | template | `registry.opentofu.org/hashicorp/azurerm` | `secret://takosumi/azure-default` | `login.microsoftonline.com`、`management.azure.com`、`*.azure.com` |
| `kubernetes-default` | template | `registry.opentofu.org/hashicorp/kubernetes`、`registry.opentofu.org/hashicorp/helm` | `secret://takosumi/kubernetes-default` | operator-managed cluster API |
| `github-default` | template | `registry.opentofu.org/integrations/github` | `secret://takosumi/github-default` | `api.github.com` |
| `digitalocean-default` | template | `registry.opentofu.org/digitalocean/digitalocean` | `secret://takosumi/digitalocean-default` | `api.digitalocean.com` |
| `docker-local` | template | `registry.opentofu.org/kreuzwerker/docker` | none by default | local Docker daemon / operator-managed |

`allowedHostPatterns` は provider API の region / service suffix を記録するための field です。実際の egress enforcement は runner substrate の責務です。

## State backend

state backend は Takosumi の public output ではありません。Deployment record には state backend reference と lock evidence だけを残します。

state value、credential value、secret output は public ledger に保存しません。

## Cloudflare Containers

Cloudflare Container runner は hosted execution substrate の一つです。Takosumi API process と OpenTofu apply side effect を分けるために使います。

container image、queue、Durable Object binding、work directory は execution profile の `cloudflareContainer` に入ります。実際の secret delivery と provider account は operator environment の責務です。

reference runner は plan Run の `source` を run directory に materialize し、`variables` を `takosumi.auto.tfvars.json` として module directory に書きます。`tofu plan -out <tfplan>` で作った binary plan file の digest を `planDigest` / `planArtifact.digest` として返します。Cloudflare reference profile では Durable Object がその `tfplan` を `R2_ARTIFACTS` R2 bucket の `opentofu-plan-runs/` prefix に昇格し、plan Run には `object-storage` artifact ref を記録します。apply Run では artifact を R2 から runner に復元し、同じ digest を再計算して一致した場合だけ source materialize / `tofu init` / `tofu apply <tfplan>` に進みます。`terraform.tfstate` は state backend ref の digest を含む `opentofu-state/backends/` prefix の operator-managed R2 sidecar として復元/保存され (core-spec §20 / §26 では Installation ごとの StateSnapshot 世代として管理)、Installation id がまだ無い create apply では source identity key を使います。

## Workers for Platforms

Workers for Platforms は OpenTofu runner ではありません。tenant / user Worker の HTTP ingress と dispatch runtime です。

`cloudflareWorkersForPlatforms` は dispatch namespace、dispatch Worker binding、outbound Worker、user Worker に許可する binding の種類を記録します。operator の provider credential、Deploy Control token、state backend credential は user Worker に binding しません。

outbound Worker は tenant Worker からの外向き通信を operator policy に通すための場所です。`networkPolicy` がある profile では、outbound Worker でも同じ allowlist を enforce する必要があります。

`worker/src/wfp_dispatch_worker.ts` は ingress dispatch の scaffold であり、egress allowlist enforcement を実装しません。`outboundWorker.enforceNetworkPolicy: true` は、operator が dispatch namespace の outbound Worker 設定と allowlist enforcement の live evidence を示したときだけ満たされたものとして扱います。

## Secret exposure policy

`secretExposurePolicy.providerCredentials: "runner-only"` は provider credential を Container runner だけで解決するという宣言です。reference runner は OpenTofu subprocess に host env 全体を渡しません。provider credential は profile の `credentialRefs` (Connection / CapabilityBinding が解決する reference) と provider-specific env allowlist から明示的に注入された値だけが渡ります。`env://VAR_NAME` credential ref は runner host env から `VAR_NAME` を注入する operator-local convention です。`secret://...` ref は operator secret delivery layer が runner env / mount / short-lived token に解決してから runner を起動します。

`tenantWorkerOperatorSecrets: "forbidden"` は tenant / user Worker に operator secret を渡さないという宣言です。tenant に必要な値は tenant-scoped binding、短命 token、または `secret://` reference から operator が安全に materialize した値だけにします。

`redactLogs` が true の profile では runner diagnostics と failure audit message を保存前に redact します。`blockSensitiveOutputs` が true の profile では `tofu output -json` の sensitive output を [OutputSnapshot](../core-spec.md#16-outputsnapshot) の `publicOutputs` / `spaceOutputs` に projection しません (core-spec §32 invariant 11-12)。
