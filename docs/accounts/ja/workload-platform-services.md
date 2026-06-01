# Workload Platform Services {#workload-platform-services}

Takosumi は installed app が consume できる Space-visible な
PlatformService entry を公開します。source repository は Takosumi 専用 manifest
でこれらの service を宣言しません。Takosumi Accounts deploy facade / account-plane UI /
operator policy が binding selection を決めます。

path は Cloud が管理します。出力データの materialization は Cloud distribution
state であり、Takosumi core の source authoring vocabulary ではありません。

| Platform service path | Capability | Cloud behavior |
| --- | --- | --- |
| `identity.primary.oidc` | OIDC workload identity | OIDC issuer、per-Installation client、redirect origin policy、client secret ref |
| `billing.primary.default` | Billing usage port | Billing owner、portal、usage endpoint、metering credential ref |

reference deployment は operator-private な
`POST /internal/workload-platform-services/resolve` route でこれらの path を解決します。Takosumi core Installer API は選ばれた binding snapshot を受け取り、Deployment に記録します。

## Binding Example

```json
{
  "bindings": [
    {
      "name": "oidc",
      "platformServicePath": "identity.primary.oidc",
      "required": true
    }
  ]
}
```

concrete request shape は Takosumi Accounts deploy facade または account-plane UI の surface
です。Takosumi core は resolved binding snapshot だけを記録します。

## OIDC Materialization

| Material | Delivery |
| --- | --- |
| issuer URL / discovery URL | non-secret config |
| client id | non-secret config |
| redirect/callback origin | activated endpoint / domain projection から導出 |
| token endpoint auth method | non-secret config |
| `clientSecretRef` | confidential client のときだけ出す secretRef-mediated runtime material |

caller-supplied redirect URL は compatibility input です。redirect authority は
Cloud の activated HTTP domain projection または operator domain policy から決めます。default は public client (`tokenEndpointAuthMethod: none`) です。confidential client が必要な workload は `tokenEndpointAuthMethod` を明示します。

## Billing Materialization

| Material | Delivery |
| --- | --- |
| portal URL | non-secret config |
| usage report endpoint | non-secret config |
| billing owner ref | non-secret account-plane ref |
| `meteringCredentialRef` | secretRef-mediated runtime material |

workload は BillingPort endpoint を通じて usage を report します。workload は
payment-provider credential を受け取りません。

## Failure Behavior

required service checks は Cloud が Takosumi Installer API apply path を呼ぶ前に実行します。required な workload platform service が missing / invisible / unauthorized の場合、Cloud は `409 failed_precondition` を返し、workload lifecycle を開始しません。

late materialization failure は launch traffic を止め、Cloud 投影を `ready` にしません。update の場合は previous current Deployment を launch target として維持します。

raw secret は public Deployment output、dashboard JSON、export bundle、workload-visible non-secret config へコピーしません。
