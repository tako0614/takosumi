# Extending Takosumi {#extending}

Takosumi v1 extension is operator integration. It is not source-repository DSL expansion.

| Goal | Owner |
| --- | --- |
| Expose DB/OIDC/bucket/queue as services | Operator PlatformService inventory |
| Import OpenTofu output | Operator distribution importer |
| Deliver credentials/endpoints to runtime | Runtime-agent connector / backend adapter |
| Provide account/billing/dashboard/deploy facade | Operator distribution |

OpenTofu providers should not be reimplemented as Takosumi-specific adapters. Infrastructure that belongs in OpenTofu stays in
the operator layer; Takosumi consumes the resulting PlatformService inventory.

## Related

- [Specification Boundaries](./reference/spec-boundaries.md)
- [Platform Services](./reference/platform-services.md)
- [Installer API](./reference/installer-api.md)
