# Reference Backend Packages {#kind-packages}

このページは reference implementation の package boundary だけを説明します。
Takosumi v1 の public contract は Source / Installation / Deployment /
PlatformService / InstallPlan です。

`@takosjp/takosumi-plugins` は operator distribution が選べる backend adapter と
runtime-agent connector の package です。operator はこの package を使っても、
Terraform/OpenTofu、native controller、workflow engine、SaaS adapter、自前
connector を使ってもかまいません。

## Ownership

| Surface                    | Owner                                      |
| -------------------------- | ------------------------------------------ |
| Installer API DTO          | `@takosjp/takosumi`                        |
| reference kernel runtime   | `@takosjp/takosumi`                        |
| backend adapters           | `@takosjp/takosumi-plugins` or operator    |
| runtime-agent connectors   | `@takosjp/takosumi-plugins` or operator    |
| provider state / Terraform | operator distribution / `takos-private/`   |

Backend package exports are implementation choices. They are not required for
compatible Takosumi operators.

## Related

- [Reference Implementation Exports](./reference-plugin-exports.md)
- [Platform Services](./platform-services.md)
- [Extending Takosumi](../extending.md)
