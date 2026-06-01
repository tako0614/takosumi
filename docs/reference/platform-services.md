# プラットフォームサービス {#platform-services}

PlatformService は operator distribution が Space に提供する service capability です。DB、OIDC issuer、object store、queue、
runtime endpoint、MCP server などを表せます。

Takosumi core は PlatformService inventory を所有しません。operator resolver に問い合わせ、選択結果を Deployment の
`bindingsSnapshot` に記録します。

## BindingSelection

install / deploy request、account-plane UI、operator policy は `bindings[]` を渡せます。

```json
{
  "bindings": [
    {
      "name": "db",
      "serviceKind": "postgres",
      "labels": { "tier": "primary" },
      "required": true,
      "inject": { "mode": "secret-env", "prefix": "DB" }
    },
    {
      "name": "identity",
      "servicePath": "identity.primary.oidc",
      "required": true
    }
  ]
}
```

| Field | 説明 |
| --- | --- |
| `name` | workload-local binding name。 |
| `servicePath` | operator inventory 内の exact service path。 |
| `serviceKind` | service kind selector。 |
| `labels` | selector を絞る labels。 |
| `many` | true の場合、一致する service を collection として扱う。 |
| `required` | 解決できない場合に apply を失敗させる。 |
| `inject` | operator/runtime adapter 向けの injection hint。 |

`servicePath` は exact match、`serviceKind` + `labels` は discovery です。両方を指定した場合、path で見つけた service が kind /
labels と互換であることを operator resolver が確認します。

## PlatformService

operator resolver は `PlatformService` を返します。

```json
{
  "path": "identity.primary.oidc",
  "kind": "identity.oidc",
  "name": "Primary OIDC issuer",
  "labels": { "owner": "takosumi" },
  "material": {
    "issuer": "https://accounts.example.com",
    "clientIdRef": "secret:oidc-client-id"
  }
}
```

raw credential は Deployment の public output に出しません。secret value は operator secret delivery に残し、Deployment には
secret reference や non-secret material だけを記録します。

## Inventory ownership

PlatformService inventory の owner は operator distribution です。inventory source は自由です。

- Terraform/OpenTofu output
- HCP Stacks publish output
- remote state
- static config
- cloud provider API
- account-plane dashboard
- manually seeded service registry

Takosumi core は inventory を read して binding snapshot を記録するだけです。Terraform apply や state lock は実行しません。

## Resolution rules

1. Source と requested bindings を受け取る。
2. operator resolver が target Space に visible な PlatformService を選ぶ。
3. `required: true` で未解決なら 409 `failed_precondition`。
4. `many` が false / omitted で複数一致なら 409 `failed_precondition`。
5. 選択結果を `InstallPlan.resolvedBindings` と Deployment `bindingsSnapshot` に記録する。

## 関連ページ

- [Takosumi core 仕様](./core-spec.md)
- [Installer API](./installer-api.md)
- [仕様境界](./spec-boundaries.md)
