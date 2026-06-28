# Operator

Operator は Takosumi for Operators を自分のユーザー向けに運用する主体です。

Takosumi for Operators は OSS です。Cloudflare Compatibility Gateway、managed edge、
managed storage、official billing、official resource backend は含めません。

## Responsibilities

- control-plane auth / token boundary を設定する
- runner substrate / runner image / resource limits / provider allowlist seed を定義する
- CredentialRecipe seed、provider allowlist、ProviderConnection policy を管理する
- ProviderConnection の sealed backing material / secret delivery を管理する
- state backend と lock backend を管理する
- OpenTofu runner image / local/docker/remote/operator runner pool を管理する
- 必要な場合は release activator materializer を運用し、apply ledger とアプリ公開結果を分けて記録する
- provider credential / control-plane token / state backend credential を user workload に渡さない
- dashboard / API / audit / quota / usage showback を運用する
- tenant isolation、workspace isolation、runner pool isolation、network egress policy の evidence を持つ

## OSS Boundary

Takosumi for Operators が運用するのは既存 OpenTofu/Terraform provider の実行です。

```text
ProviderConnection
  -> CredentialRecipe
  -> temporary env/file injection
  -> OpenTofu/Terraform provider
```

Operator OSS は provider-compatible Gateway endpoint を公開しません。
Workers for Platforms は Takosumi Cloud の tenant/user Worker ingress
boundary であり、OSS Operator の OpenTofu runner execution boundary では
ありません。

## Cloud Boundary

Takosumi Cloud は closed な公式 hosted deployment です。

Cloud だけが以下を持てます。

```text
Cloudflare Compatibility Gateway
Takosumi Managed Edge Worker
Takosumi Object Storage
Takosumi App Database
Takosumi KV / Queue
Takosumi Cloud Container
official billing / quota / usage / support
official resource pools
```

これらの実装・tests・secrets・deployment config は closed Cloud repo に置きます。

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
| Network            | provider allowlist and egress enforcement                                                                                    |
| Tenant isolation   | workspace/team separation and runner isolation                                                                               |
| Audit              | run, secret, state, and admin action evidence                                                                                |

Cloud GA adds managed resource, compatibility gateway, official billing, abuse,
support, usage metering, and deprovision proof requirements.
