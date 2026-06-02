# Operator Implementation Exports {#operator-implementation-exports}

Operator implementation exports are distribution-local APIs. They are not a
Takosumi npm package and are not the v1 public source contract.

Operator implementation が提供しうるもの:

- backend adapters
- runtime-agent connectors
- operator inventory import helpers
- local / cloud provider integration helpers

Operator implementation が提供しないもの:

- Takosumi-specific source authoring DSL
- OpenTofu provider replacement
- Takosumi-owned PlatformService catalog
- mandatory implementation binding mechanism

compatible operator は同じ Installer API と Deployment record を保ちながら、
OpenTofu、native controller、workflow engine、SaaS adapter、自前 runtime
agent のいずれでも PlatformService を materialize できます。

## Related

- [Takosumi を拡張する](../extending.md)
- [プラットフォームサービス](./platform-services.md)
