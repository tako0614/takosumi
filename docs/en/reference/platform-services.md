# Platform Services {#platform-services}

A PlatformService is an operator-provided service capability visible to a Space: database, OIDC issuer, object store,
queue, runtime endpoint, MCP server, or similar.

Takosumi core does not own PlatformService inventory. It asks the operator resolver, then records selected services in
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

Operator distributions own inventory. Inventory may be populated from Terraform/OpenTofu output, HCP Stacks publish
output, remote state, static config, cloud APIs, account-plane dashboards, or manual seed data.

Takosumi core reads inventory and records binding snapshots. It does not run Terraform or own state locks.

## Resolution

1. Receive Source and requested bindings.
2. Resolve visible PlatformServices for the target Space.
3. Fail with 409 `failed_precondition` for required unresolved bindings.
4. Fail with 409 for ambiguous single bindings.
5. Record selected services in `InstallPlan.resolvedBindings` and Deployment `bindingsSnapshot`.
