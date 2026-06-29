# Operator

Operator は Takosumi for Operator を自分のユーザー向けに運用する主体です。

Takosumi OSS は Git-based OpenTofu control plane、Resource Shape API、Compatibility API framework、Adapter system を持ちます。
Takosumi for Operator は、その上に customer management、billing / metering / quota、operator console、managed target
catalog、commercial operation を足して運用します。Takosumi Cloud は私たちが運用する公式 hosted operation です。

## Responsibilities

- control-plane auth / token boundary を設定する
- runner substrate / runner image / resource limits / provider allowlist seed を定義する
- CredentialRecipe seed、provider allowlist、ProviderConnection policy を管理する
- ProviderConnection の sealed backing material / secret delivery を管理する
- Resource Shape / TargetPool / Adapter / compatibility profile の availability を管理する
- state backend と lock backend を管理する
- OpenTofu runner image / local/docker/remote/operator runner pool を管理する
- customer / billing / metering / quota / support operation を運用する
- 必要な場合は release activator materializer を運用し、apply ledger とアプリ公開結果を分けて記録する
- provider credential / control-plane token / state backend credential を user workload に渡さない
- dashboard / API / audit / quota / usage showback を運用する
- tenant isolation、workspace isolation、runner pool isolation、network egress policy の evidence を持つ

## OSS Boundary

Takosumi OSS の portable boundary は 2 つです。

```text
Git / OpenTofu stack:
ProviderConnection
  -> CredentialRecipe
  -> temporary env/file injection
  -> OpenTofu/Terraform provider

Resource Shape:
Resource
  -> TargetPool / Policy / Credential
  -> Adapter capability
  -> ResolutionLock
  -> NativeResource
```

Operator は scoped / versioned compatibility profile を有効にできます。例: `compat.s3.v1`、`compat.oci.v1`、
`compat.cloudevents.v1`。公開範囲は `/v1/capabilities` で示し、full AWS compatibility や full Cloudflare compatibility は
名乗りません。

## Operator / Cloud Boundary

Operator / Cloud が持つのは商用運用と managed capacity です。

```text
customer management
billing / metering / quota / plan
operator console
managed target catalog
support / abuse operation
commercial audit
operator-owned target pools
```

Takosumi Cloud は公式 hosted deployment であり、以下を公式 managed service として運用します。

```text
official resource pools
Takosumi Native Runtime
Takosumi Native Object Store
Takosumi Native Queue
Takosumi Native DB
Takosumi Edge Gateway
Takosumi AI Gateway
official billing / quota / usage / support / SLA
```

公式 managed capacity の実装・tests・secrets・deployment config は closed Cloud repo に置きます。

## Production Readiness

OSS Operator GA の readiness は以下です。

| Area               | Required evidence                                                                                                            |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| Website/docs       | docs build, custom domain/TLS if hosted publicly                                                                             |
| Runner             | non-production OpenTofu plan/apply/destroy proof                                                                             |
| Release activation | webhook/materializer proof, activation failure surfacing, rollback-independent ledger evidence if app publication is enabled |
| Accounts/auth      | dashboard, session/OIDC as configured, audit trail                                                                           |
| State              | state backend, lock evidence, backup/restore drill                                                                           |
| Secrets            | encrypted storage, rotation process, redaction proof                                                                         |
| Provider recipes   | CredentialRecipe seed, provider allowlist, ProviderConnection policy, and helper coverage                                    |
| Resource shapes    | TargetPool policy, adapter capability evidence, ResolutionLock behavior                                                      |
| Compatibility      | scoped/versioned capability list and negative proof for unsupported full-provider APIs                                       |
| Network            | provider allowlist and egress enforcement                                                                                    |
| Tenant isolation   | workspace/team separation and runner isolation                                                                               |
| Audit              | run, secret, state, and admin action evidence                                                                                |

Cloud GA adds official managed targets, hosted compatibility profiles, official
billing, abuse, support, usage metering, and deprovision proof requirements.
