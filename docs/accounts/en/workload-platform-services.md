# Workload Platform Services {#workload-platform-services}

Takosumi publishes Space-visible PlatformService entries that installed
apps can consume through Cloud-managed binding selection. Source repositories do
not declare these services in a Takosumi-specific metadata file.

The path is managed by Cloud. Output materialization is Cloud distribution
state, not a Takosumi core authoring vocabulary.

| Service path | Capability | Cloud behavior |
| --- | --- | --- |
| `identity.primary.oidc` | OIDC workload identity | OIDC issuer, per-Installation client, redirect origin policy, client secret ref. |
| `billing.primary.default` | Billing usage port | Billing owner, portal, usage endpoint, metering credential ref. |

Reference deployments resolve these paths through the operator-private
`POST /internal/workload-platform-services/resolve` route. The Takosumi core
Installer API receives the selected binding snapshot and records it on
Deployment.

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

The concrete request shape belongs to the Takosumi Accounts deploy facade or account-plane
UI. Takosumi core only records the resolved binding snapshot.

## OIDC Materialization

| Output data | Delivery |
| --- | --- |
| issuer URL / discovery URL | non-secret config |
| client id | non-secret config |
| redirect/callback origin | derived from activated endpoint/domain projection |
| token endpoint auth method | non-secret config |
| `clientSecretRef` | secretRef-mediated runtime data for confidential clients only |

Caller-supplied redirect URLs are compatibility input. Redirect authority comes
from Cloud's activated HTTP domain projection or operator domain policy. The
default is a public client (`tokenEndpointAuthMethod: none`). Workloads that
need confidential client auth explicitly request `tokenEndpointAuthMethod`.

## Billing Materialization

| Output data | Delivery |
| --- | --- |
| portal URL | non-secret config |
| usage report endpoint | non-secret config |
| billing owner ref | non-secret account management ref |
| `meteringCredentialRef` | secretRef-mediated runtime data |

Workloads report usage through the BillingPort endpoint. They do not receive
payment-provider credentials.

## Failure Behavior

Required service checks run before Cloud calls the core Installer API apply
path. Missing, invisible, or unauthorized required services fail with
`409 failed_precondition`. No workload lifecycle attempt starts.

Late materialization failure keeps launch traffic disabled and keeps the Cloud
projection out of `ready`. On update, the previous current Deployment remains
the launch target.

Raw secrets are never copied into public Deployment outputs, dashboard JSON,
export bundles, or workload-visible non-secret config.
