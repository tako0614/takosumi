# Reference Backend Packages {#kind-packages}

This page describes only the reference implementation package boundary.
Takosumi v1 public contract is Source, Installation, Deployment,
PlatformService, and InstallPlan.

`@takosjp/takosumi-plugins` is a package of backend adapters and runtime-agent
connectors an operator distribution may choose. Operators may also use
OpenTofu, native controllers, workflow engines, SaaS adapters, or
their own connectors.

## Ownership

| Surface                    | Owner                                    |
| -------------------------- | ---------------------------------------- |
| Installer API DTO          | `@takosjp/takosumi`                      |
| Takosumi service runtime   | `@takosjp/takosumi`                      |
| backend adapters           | `@takosjp/takosumi-plugins` or operator  |
| runtime-agent connectors   | `@takosjp/takosumi-plugins` or operator  |
| provider state / OpenTofu  | operator distribution / `takos-private/` |

Backend package exports are implementation choices. They are not required for
compatible Takosumi operators.

## Related Pages

- [Reference Implementation Exports](./reference-plugin-exports.md)
- [Platform Services](./platform-services.md)
- [Extending Takosumi](../extending.md)
