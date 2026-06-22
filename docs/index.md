# Takosumi

Takosumi は、既存の OpenTofu/Terraform provider と module をそのまま実行する OSS control plane です。
credential/env 自動注入、state 管理、secret 管理、outputs、run 履歴、audit を提供します。

新しい product 方向性の正本は [Takosumi Final Plan](./final-plan.md) です。Core spec / conformance /
Gateway 関連の既存 reference は実装整理のために残っていますが、方針が衝突する場合は Final Plan を優先します。

## 一文での定義

```text
Takosumi OSS:
  既存 Terraform/OpenTofu provider をそのまま実行する control plane。

Takosumi Cloud:
  closed な公式ホスティング版 Takosumi for Operators
  + Cloud 専用の compatibility gateway
  + Cloud 専用の managed resources。
```

最重要境界はこれです。

```text
OSS は既存 provider をそのまま動かす。
Cloud だけが互換 API と managed resource を持つ。
```

## Product Shape

| Product | License / operation | Role |
| --- | --- | --- |
| Takosumi Core | OSS | OpenTofu/Terraform 実行、Provider Connection、Credential Recipe、State、Secret、Run、Audit、Outputs の共通基盤 |
| Takosumi | OSS self-host | 個人・小規模チームが自分の cloud account と manifest を実行する製品 |
| Takosumi for Operators | OSS self-host | 組織・事業者が自分のユーザー向けに Takosumi を運営するための operator edition |
| Takosumi Cloud | Closed official hosting | 私たちが運営する公式 Takosumi for Operators + Cloud 専用 compat / managed resources |

## What Takosumi OSS Does

Takosumi OSS は OpenTofu/Terraform の外側を管理します。

```text
Git repo を clone する
OpenTofu/Terraform を実行する
既存 provider を install する
Provider Connection から credential/env/file を自動注入する
state を保存する
run 履歴を保存する
secret を暗号化保存する
outputs を保存する
plan/apply/destroy を UI/API/CLI で扱う
```

Takosumi OSS が中心にする価値はこれです。

```text
Same manifest, different connection.
```

同じ `.tf` を使い、Provider Binding だけを変えて dev/prod、別 account、別 provider alias に流せます。

## What OSS Does Not Do

Takosumi OSS には以下を入れません。

```text
Cloudflare compatibility API
AWS/GCP compatibility API
S3 gateway
Resource Driver system
Compat Pack system
Managed Edge
Managed Container
Managed Storage
official billing/quota/usage
official cloud backend
```

Cloudflare compatibility gateway や managed resources は Takosumi Cloud 専用です。

## Core Model

Final Plan で固定する public model は以下です。

| Concept | Meaning |
| --- | --- |
| Workspace | user/team の作業空間、state/secret/audit の isolation boundary |
| Project | 1つの service / product / infra group |
| Capsule | 1つの OpenTofu/Terraform module 実行単位 |
| Source | Git URL / ref / commit / path / tarball / upload などの入力 |
| ProviderConnection | provider credential を安全に保存し Run 時だけ env/file として注入する設定 |
| CredentialRecipe | provider を動かすために必要な env/file/pre-run action の定義 |
| ProviderBinding | provider / alias にどの ProviderConnection を注入するかの mapping |
| Run | init / validate / plan / apply / destroy / refresh / output の1回の実行 |
| StateVersion | Capsule state の保存世代 |
| Output | OpenTofu output の保存値。別 Capsule の input に渡せる |
| Runner | checkout / tofu execution / log streaming / state sync / cleanup を行う実行主体 |
| AuditEvent | actor / action / target / result を記録する監査イベント |

既存の Space / Installation / Gateway / provider ownership flags などの語彙は旧設計由来です。今後の実装整理では、必要なものだけ
Final Plan の Workspace / Project / Capsule / ProviderConnection / ProviderBinding / CredentialRecipe に写像し、不要なものは削除します。

## First MVP

最初に完成させる実装単位はこれです。

```text
1. Git URL から repo clone
2. tofu init/plan/apply/destroy を実行
3. Cloudflare API Token Provider Connection を作成
4. CLOUDFLARE_API_TOKEN を Run 時だけ注入
5. 既存 cloudflare/cloudflare provider の manifest を plan/apply
6. run log を保存
7. state を Takosumi に保存
8. outputs を保存
```

最初のデモは「既存 Cloudflare Worker manifest を cloudflare provider のまま実行し、token は `.env` ではなく
Takosumi Connection から注入する」です。Cloudflare compatibility gateway はこの段階では不要です。

## Takosumi Cloud

Takosumi Cloud は closed な公式ホスティング版です。

```text
Takosumi Cloud =
  official hosted Takosumi for Operators
  + Cloudflare Compatibility Gateway
  + Takosumi Managed Edge / Storage / DB / KV / Queue / Container
  + billing / quota / usage / support / abuse controls
```

Cloudflare compatibility は Cloud 専用です。

```text
cloudflare/cloudflare provider
  -> base_url = https://api.takosumi.com/compat/cloudflare/client/v4
  -> Takosumi Cloudflare Compatibility Gateway
  -> Takosumi Managed Edge internal API
```

対応範囲は Workers 系 subset から始めます。

```text
cloudflare_workers_script
cloudflare_workers_route
cloudflare_workers_kv_namespace
cloudflare_r2_bucket
cloudflare_d1_database
worker vars/secrets/bindings
```

## Next Documents

- [Takosumi Final Plan](./final-plan.md)
- [Quickstart](./getting-started/quickstart.md)
- [Core specification](./core-spec.md)
- [Core conformance](./core-conformance.md)
