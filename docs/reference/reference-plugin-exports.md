# Reference Implementation Exports {#reference-plugin-exports}

`@takosjp/takosumi-plugins` は operator distribution が選べる reference
implementation package です。v1 public source contract ではありません。

この package が提供するもの:

- backend adapters
- runtime-agent connectors
- operator inventory import helpers
- local / cloud provider integration helpers

この package が提供しないもの:

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
