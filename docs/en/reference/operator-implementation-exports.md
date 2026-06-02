# Operator Implementation Exports {#operator-implementation-exports}

Operator implementation exports are distribution-local APIs. They are not a
Takosumi npm package and are not the v1 public source contract.

An operator implementation can provide:

- backend adapters
- runtime-agent implementation code
- operator inventory import helpers
- local / cloud provider integration helpers

An operator implementation does not provide:

- a Takosumi-specific source DSL
- an OpenTofu provider replacement
- a Takosumi-owned PlatformService catalog
- a mandatory implementation binding mechanism
- a Takosumi package subpath export

A compatible operator can keep the same Installer API and Deployment record
while materializing PlatformServices through OpenTofu, native
controllers, workflow engines, SaaS adapters, or its own runtime agent.

## Related Pages

- [Extending Takosumi](../extending.md)
- [Platform Services](./platform-services.md)
