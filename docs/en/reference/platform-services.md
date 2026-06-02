# Platform Services {#platform-services}

A PlatformService is an operator-provided service capability visible to a Space: database, OIDC issuer, object store,
queue, runtime endpoint, MCP server, or similar.

Takosumi does not own PlatformService inventory. It asks the operator resolver, then records selected services in
Deployment `bindingsSnapshot`.

## BindingSelection

Install/deploy requests, account-plane UI, or operator policy may pass `bindings[]`.

```json
{
  "bindings": [
    {
      "name": "db",
      "serviceKind": "postgres",
      "labels": { "tier": "primary" },
      "required": true,
      "inject": { "mode": "secret-env", "prefix": "DB" }
    }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `name` | Workload-local binding name. |
| `servicePath` | Exact operator inventory path. |
| `serviceKind` | Service selector. |
| `labels` | Selector labels. |
| `many` | Treat matches as a collection. |
| `required` | Fail apply when unresolved. |
| `inject` | Operator/runtime adapter hint. |

## Inventory Ownership

Operator distributions own inventory. GA treats OpenTofu output as the native
inventory source. Operators may also import HCP Stacks publish output, remote
state, static config, cloud APIs, account-plane dashboards, or manual seed data.

Takosumi reads inventory and records binding snapshots. It does not run
`tofu apply` or own state locks.

### OpenTofu Output Import Example

An operator distribution can read `tofu output -json` and map selected outputs
into PlatformService definitions visible to a Space. Space scope is an
operator-inventory visibility rule; Deployments only store the selected service
snapshot.

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

The default importer does not expose sensitive outputs in `material`. Operators
include sensitive outputs only when they explicitly enable `includeSensitiveOutputs`
inside a secret-delivery boundary.

## Resolution

1. Receive Source and requested bindings.
2. Resolve visible PlatformServices for the target Space.
3. Fail with 409 `failed_precondition` for required unresolved bindings.
4. Fail with 409 for ambiguous single bindings.
5. Record selected services in `InstallPlan.resolvedBindings` and Deployment `bindingsSnapshot`.
