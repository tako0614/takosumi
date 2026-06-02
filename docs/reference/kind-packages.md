# Operator Backend Implementations {#kind-packages}

このページは operator backend implementation の境界を説明します。
Takosumi v1 の public contract は Source / Installation / Deployment /
PlatformService / InstallPlan です。

Takosumi は backend adapter / runtime handler package を publish しません。operator は
OpenTofu、Helm、native controller、workflow engine、SaaS adapter、または自前の
runtime-agent 実装を使い、その output を PlatformService inventory と Deployment
evidence に接続します。

## Ownership

| Surface                    | Owner                                      |
| -------------------------- | ------------------------------------------ |
| Installer API DTO          | `@takosjp/takosumi`                        |
| Takosumi service runtime   | `@takosjp/takosumi`                        |
| backend / runtime implementation | operator distribution                |
| provider state / OpenTofu  | operator distribution / `takos-private/`   |

Backend / runtime implementation exports are operator choices. They are not
required for compatible Takosumi operators and are not part of the public source
contract.

## Related

- [Operator Implementation Exports](./operator-implementation-exports.md)
- [Platform Services](./platform-services.md)
- [Extending Takosumi](../extending.md)
