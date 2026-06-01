# Operator Catalog {#catalog}

Takosumi v1 does not expose core-owned backend vocabulary as a public source
contract. Catalogs are operator-owned PlatformService and binding inventories.

An operator catalog decides:

- PlatformServices visible in a Space
- runtime targets, databases, object storage, queues, OIDC issuers, and other
  service capabilities
- aliases, labels, service paths, and visibility
- implementations backed by Terraform/OpenTofu or cloud provider state
- access modes, approval, quota, and billing subject

Takosumi core receives:

- `PlatformService`
- `ResolvedBinding`
- Deployment `bindingsSnapshot`
- Deployment `outputs`

Backend-specific adapters, runtime-agent connectors, Terraform modules, and
provider controllers are operator implementation. Takosumi core public v1 stays
limited to Source, Installation, Deployment, PlatformService, and InstallPlan.

## Related Pages

- [Platform Services](./platform-services.md)
- [Specification Boundaries](./spec-boundaries.md)
- [Extending Takosumi](../extending.md)
