# Takosumi {#takosumi-distribution}

Takosumi は Takosumi core を使う reference operator distribution です。
Cloud は account、billing、OIDC、dashboard、approval、deploy facade、
PlatformService inventory、Terraform/OpenTofu state を持ちます。

## Ownership

| Surface                                      | Owner                                    |
| -------------------------------------------- | ---------------------------------------- |
| Source / Installation / Deployment           | [Takosumi core](./core-spec.md)          |
| Installer API                                | [Installer API](./installer-api.md)      |
| PlatformService inventory / binding policy   | Takosumi distribution              |
| Accounts / OIDC / billing / dashboard        | Takosumi distribution              |
| Terraform/OpenTofu state / provider evidence | Takosumi distribution / operator   |

Takosumi core は Cloud の inventory を通じて PlatformService を resolve し、
Deployment に binding snapshot と outputs を記録します。Cloud 固有の service
path、account-facing projection、approval record、launch token、billing behavior、
dashboard API は Cloud docs が正本です。

## Cloud docs

- [Takosumi docs](https://accounts.takosumi.com/docs/)
- [日本語: Takosumi Distribution Contract v1](https://accounts.takosumi.com/docs/ja/spec)
- [English: Takosumi Distribution Contract v1](https://accounts.takosumi.com/docs/en/spec)

この checkout の maintainer path は `takosumi/docs/ja/spec.md` と
`takosumi/docs/en/spec.md` です。

## Related

- [仕様境界](./spec-boundaries.md)
- [プラットフォームサービス](./platform-services.md)
- [Installer API](./installer-api.md)
