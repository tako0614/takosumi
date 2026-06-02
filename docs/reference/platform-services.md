# プラットフォームサービス {#platform-services}

PlatformService は operator distribution が Space に提供する service capability です。DB、OIDC issuer、object store、queue、
runtime endpoint、MCP server などを表せます。

Takosumi は PlatformService inventory を所有しません。operator resolver に問い合わせ、選択結果を Deployment の
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

PlatformService inventory の owner は operator distribution です。GA では
OpenTofu output を native source とし、必要に応じて他の operator-owned source
を import できます。

- OpenTofu output
- HCP Stacks publish output
- remote state
- static config
- cloud provider API
- account-plane dashboard
- manually seeded service registry

Takosumi は inventory を read して binding snapshot を記録するだけです。`tofu apply` や state lock は実行しません。

### OpenTofu output import example

operator distribution は `tofu output -json` の結果を読み、Space に見せる PlatformService 定義へ変換できます。
Space scope は operator inventory 側の visibility rule であり、Deployment に保存されるのは選択済み service の snapshot だけです。

```json
{
  "outputs": {
    "oidc_issuer_url": {
      "sensitive": false,
      "value": "https://accounts.example.com"
    },
    "oidc_client_id": {
      "sensitive": false,
      "value": "app_client"
    },
    "oidc_client_secret": {
      "sensitive": true,
      "value": "redacted-at-import"
    }
  },
  "services": [
    {
      "spaceId": "space_123",
      "path": "identity.primary.oidc",
      "kind": "identity.oidc@v1",
      "material": {
        "issuerUrl": "oidc_issuer_url",
        "clientId": "oidc_client_id",
        "clientSecret": "oidc_client_secret"
      }
    }
  ]
}
```

default importer は sensitive output を `material` へ出しません。operator が secret delivery boundary の内側で
明示的に `includeSensitiveOutputs` を有効化した場合だけ sensitive output を含めます。

## Resolution rules

1. Source と requested bindings を受け取る。
2. operator resolver が target Space に visible な PlatformService を選ぶ。
3. `required: true` で未解決なら 409 `failed_precondition`。
4. `many` が false / omitted で複数一致なら 409 `failed_precondition`。
5. 選択結果を `InstallPlan.resolvedBindings` と Deployment `bindingsSnapshot` に記録する。

## 関連ページ

- [Takosumi v1](./takosumi-v1.md)
- [Installer API](./installer-api.md)
- [仕様境界](./spec-boundaries.md)
