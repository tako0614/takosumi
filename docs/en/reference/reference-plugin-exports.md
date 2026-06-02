# Reference Implementation Exports {#reference-plugin-exports}

`@takosjp/takosumi-plugins` is a reference implementation package an operator
distribution may choose. It is not the v1 public source contract.

The package provides:

- backend adapters
- runtime-agent connectors
- operator inventory import helpers
- local / cloud provider integration helpers

The package does not provide:

- a Takosumi-specific source DSL
- an OpenTofu provider replacement
- a Takosumi-owned PlatformService catalog
- a mandatory implementation binding mechanism

A compatible operator can keep the same Installer API and Deployment record
while materializing PlatformServices through OpenTofu, native
controllers, workflow engines, SaaS adapters, or its own runtime agent.

## Related Pages

- [Extending Takosumi](../extending.md)
- [Platform Services](./platform-services.md)
