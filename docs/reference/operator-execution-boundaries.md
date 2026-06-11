# Operator execution boundaries

> operator execution boundary は operator-internal な実行境界設定であり、**public vocabulary ではありません**。
> 2026-06-08 改訂の [core-spec](../core-spec.md) で公開語彙は
> Space / Source / Connection / Provider Template / Provider Env Set / OpenTofu Capsule /
> Installation / InstallConfig / DeploymentProfile / ProviderBinding / Dependency / SourceSnapshot / DependencySnapshot / StateSnapshot / Run / RunGroup / Deployment / OutputSnapshot /
> Backup / Billing / Activity に閉じています。

operator execution boundary は OpenTofu 実行境界の operator-internal な設定です。substrate、runner image、
resource limit、provider allowlist seed を持ちます。

何を **まだ** 持つか:

- **substrate**: どこで OpenTofu を実行するか (Cloudflare Container 等)。
- **runner image**: container image / queue / Durable Object binding。
- **resource limits**: run time / source archive size / decompressed size / memory。
- **provider allowlist seed**: operator が許可する OpenTofu provider source address の seed (最終的な enforcement は Capsule Gate result と plan JSON に対する policy layer が行う)。

何が **移った** か:

- **credential** は Connection / vault が保持し、ProviderBinding は provider ごとの
  `default` / `connection` / `manual` / `disabled` 解決だけを持ちます。provider credential は
  operator-internal resolved execution view に embedded しません。 mint policy は vault 内で run phase ごとに判定し
  (source → git credential only、 compatibility/normalize/gate → provider credential なし、 plan/apply/destroy → provider credentials only)、 caller の主張を信用しません。
- **allowlist / action policy** は takosumi-policy layer が持ちます。 Capsule compatibility / provider allowlist / module source policy / data source allowlist / resource type allowlist / action policy / billing mode は Capsule Gate result と plan JSON を評価して全 Run に適用されます。

Cloudflare 上の reference topology では、OpenTofu の `plan/apply` は Cloudflare Container runner が実行します。Workers for Platforms は tenant / user Worker の dispatch runtime としてだけ使い、provider credential を持つ runner とは分けます。

## Shape

これは operator 内部の **resolved execution view** の例です。`stateBackend` は operator-managed state/lock の参照です。
provider credential は Connection / vault policy と ProviderBinding の provider 解決から run phase ごとに解決され、operator-internal resolved execution view は
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
    },
    "apiProxy": {
      "origin": "https://app.takosumi.com",
      "route": "/internal/cf-proxy"
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
runner-observed provider が allowlist 外なら policy は blocked になり、apply Run は作れません。runner は provider lockfile
digest を返し、provider を使う Installation-context plan は lockfile digest を default-on で要求します。mirror-required
policy の Run では strict `TF_CLI_CONFIG_FILE` を生成し、filesystem mirror include / direct exclude と installed provider
path / digest の attestation を plan evidence として返します。必要な provider credential を Connection / ProviderBinding から
解決できない Run も provider credential mint 前に blocked です。

## Source policy

`git` と `prepared` source は通常の production source です。`local` source は dev / operator-local boundary 用であり、operator が `sourcePolicy.allowLocalSource: true` を明示した場合だけ plan Run を作れます。tenant input を扱う boundary では local path を許可しません。

prepared source は runner が fetch する archive です。reference runner は `resourceLimits.maxSourceArchiveBytes` で wire size、`resourceLimits.maxSourceDecompressedBytes` で tar header 上の展開後 size を制限し、unsafe path、duplicate normalized path、link、file / directory 以外の tar entry を展開前に拒否します。

## Common provider allowlist seeds

Default operator boundary は OpenTofu provider source address を allowlist seed します。これは Provider Template ではなく、
operator が許可した OpenTofu 実行境界の internal seed です。

`cloudflare-default` は reference Cloudflare topology 用の enabled seed です。AWS / GCP / GitHub / Kubernetes は
user env set provider template として、operator が Connection、state backend、network enforcement、live proof を確認してから
有効化します。Azure / DigitalOcean / Docker などは initial template ではなく、provider env set と explicit policy evidence で
追加する provider の例です。

| Seed                           | State    | Providers                                                                            | Network policy                                                                       |
| ------------------------------ | -------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| `cloudflare-default`           | enabled  | `registry.opentofu.org/cloudflare/cloudflare`                                        | `api.cloudflare.com`                                                                 |
| `aws-verified-template`        | template | `registry.opentofu.org/hashicorp/aws`                                                | `sts.amazonaws.com`、`iam.amazonaws.com`、`route53.amazonaws.com`、`*.amazonaws.com` |
| `gcp-verified-template`        | template | `registry.opentofu.org/hashicorp/google`                                             | `oauth2.googleapis.com`、`cloudresourcemanager.googleapis.com`、`*.googleapis.com`   |
| `kubernetes-verified-template` | template | `registry.opentofu.org/hashicorp/kubernetes`、`registry.opentofu.org/hashicorp/helm` | operator-managed cluster API                                                         |
| `github-verified-template`     | template | `registry.opentofu.org/integrations/github`                                          | `api.github.com`                                                                     |

Future/custom examples such as Azure / DigitalOcean / Docker must enter through provider env set plus explicit policy
evidence, or through a later Takosumi-provided managed promotion.

`allowedHostPatterns` は provider API の region / service suffix を記録するための internal field です。実際の egress enforcement は runner substrate の責務です。

## State backend

state backend は Takosumi の public output ではありません。Deployment record には state backend reference と lock evidence だけを残します。

state value、credential value、secret output は public ledger に保存しません。

## Cloudflare Containers

Cloudflare Container runner は hosted execution substrate の一つです。Takosumi API process と OpenTofu apply side effect を分けるために使います。

container image、queue、Durable Object binding、work directory は operator boundary の `cloudflareContainer` に入ります。実際の secret delivery と provider account は operator environment の責務です。

reference runner の `compatibility_check` action は SourceSnapshot を run directory に materialize し、credential-free `tofu init`
と Capsule Normalizer / Gate 用の source file collection を行います。plan/apply action は固定済み SourceSnapshot または
normalized artifact と generated root を materialize し、dependency/input values だけを `takosumi.auto.tfvars.json` に書きます。
provider credentials は `.auto.tfvars.json` に入れず、generated-root provider configuration へ approved root-only channel で渡します。`tofu plan -out <tfplan>` で
作った binary plan file の digest を `planDigest` / `planArtifact.digest` として返します。Cloudflare reference execution
profile では Durable Object がその `tfplan` を `R2_ARTIFACTS` R2 bucket に昇格し、plan Run には encrypted artifact ref を
記録します。apply Run では artifact を R2 から runner に復元し、同じ digest を再計算して一致した場合だけ source
materialize / `tofu init` / `tofu apply <tfplan>` に進みます。`terraform.tfstate` は Installation ごとの encrypted
StateSnapshot 世代として R2_STATE に復元/保存されます。

## Workers for Platforms

Workers for Platforms は OpenTofu runner ではありません。tenant / user Worker の HTTP ingress と dispatch runtime です。

`cloudflareWorkersForPlatforms` は dispatch namespace、dispatch Worker binding、outbound Worker、user Worker に許可する binding の種類を記録します。operator の provider credential、Deploy Control token、state backend credential は user Worker に binding しません。

outbound Worker は tenant Worker からの外向き通信を operator policy に通すための場所です。`networkPolicy` がある execution boundary では、outbound Worker でも同じ allowlist を enforce する必要があります。

`providers/cloudflare/hosting/wfp_dispatch_worker.ts` は ingress dispatch の scaffold であり、egress allowlist enforcement を実装しません。`outboundWorker.enforceNetworkPolicy: true` は、operator が dispatch namespace の outbound Worker 設定と allowlist enforcement の live evidence を示したときだけ満たされたものとして扱います。

### Managed Worker hosting via the cf-proxy (transparent, plain capsule)

managed (takosumi-hosted) な Cloudflare Worker capsule は **plain OpenTofu のまま** です。capsule は普通の `cloudflare_workers_script` (+ 普通の KV / D1 / R2 + 普通の `bindings` block) を書くだけで、WfP 固有の HCL を一切持ちません。pin している cloudflare provider (v5) は script を dispatch namespace に置けないため、control plane が managed run (= 必須 provider が operator-default credential に fall-through した run、§7.1) でのみ cloudflare provider の `base_url` を **cf-proxy** に向けます:

```
<apiProxy.origin><apiProxy.route>/<dispatchNamespace>/<installSlug>/client/v4
```

cf-proxy (`providers/cloudflare/hosting/cf_proxy_worker.ts`、platform worker の `/internal/cf-proxy/*` route) は worker-script の API path を namespace 版に書き換え、それ以外 (KV / D1 / R2 等) は素通しします:

```
/client/v4/accounts/{id}/workers/scripts/{name}[/sub]
  -> /client/v4/accounts/{id}/workers/dispatch/namespaces/{ns}/scripts/{installSlug}-{name}[/sub]
```

`{installSlug}` prefix で namespace 内の script 名が install 間で一意になります。`/subdomain` sub-resource は namespace script に存在しないため no-op success にします (ingress は dispatcher)。script の binding map は素通しで作られた実 KV / D1 / R2 resource を参照するので、bindings に特別扱いは要りません。

**redirect の integrity**: namespace / slug は base_url の **path** から来ます。base_url は control plane が設定し、capsule は上書きできません (generated root が `providers = {}` を child に渡すため、capsule が provider block を持つと tofu plan が落ちる、fail-closed)。self-host (= 自分の Connection) と非 cloudflare / 非 Worker capsule は `base_url` を受け取らず、generated root は byte-identical のままです。

**operator credential / v1 posture**: provider API token は `TF_VAR_cloudflare<_alias>_api_token` として runner に届き、cf-proxy は request の `Authorization` をそのまま `api.cloudflare.com` へ forward します (= 既存と同じ posture)。token-vending Connection の `policies` には **Workers Scripts: Edit** (dispatch namespace を含む) が必要です。**gated hardening** (本 mechanism の手前で managed を開放するまでに満たすもの): cf-proxy 自身が operator token を保持し runner には scoped capability だけを渡す / managed run の egress を cf-proxy のみに絞る (outbound Worker enforcement)。`apiProxy` が無い profile では managed hosting は無効です。

## Secret exposure policy

`secretExposurePolicy.providerCredentials: "runner-only"` は provider credential を Container runner だけで解決するという宣言です。reference runner は OpenTofu subprocess に host env 全体を渡しません。provider credential は Connection / ProviderBinding / vault policy と provider-specific env allowlist から明示的に注入された値だけが渡ります。operator-local secret reference は operator secret delivery layer が runner env / mount / short-lived token に解決してから runner を起動します。

`tenantWorkerOperatorSecrets: "forbidden"` は tenant / user Worker に operator secret を渡さないという宣言です。tenant に必要な値は tenant-scoped binding、短命 token、または operator が Connection policy に従って安全に materialize した値だけにします。

`redactLogs` が true の execution boundary では runner diagnostics と failure audit message を保存前に redact します。`blockSensitiveOutputs` が true の execution boundary では `tofu output -json` の sensitive output を OutputSnapshot の `publicOutputs` / `spaceOutputs` に projection しません。
