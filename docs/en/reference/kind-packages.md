# Operator Backend Implementations {#kind-packages}

This page describes the operator backend implementation boundary.
Takosumi v1 public contract is Source, Installation, Deployment,
PlatformService, and InstallPlan.

Takosumi does not publish a backend adapter or runtime handler package. Operators use
OpenTofu, Helm, native controllers, workflow engines, SaaS adapters, or their
own runtime-agent implementation, then connect the output to PlatformService
inventory and Deployment evidence.

## Ownership

| Surface                    | Owner                                    |
| -------------------------- | ---------------------------------------- |
| Installer API DTO          | `@takosjp/takosumi`                      |
| Takosumi service runtime   | `@takosjp/takosumi`                      |
| backend / runtime implementation | operator distribution            |
| provider state / OpenTofu  | operator distribution / `takos-private/` |

Backend / runtime implementation exports are operator choices. They are not
required for compatible Takosumi operators and are not part of the public source
contract.

## Related Pages

- [Operator Implementation Exports](./operator-implementation-exports.md)
- [Platform Services](./platform-services.md)
- [Extending Takosumi](../extending.md)
