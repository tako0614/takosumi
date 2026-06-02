# オペレーター {#operator}

operator は Takosumi を起動し、Source をどの PlatformService と runtime
implementation に bind するかを決めます。account、billing、OIDC、approval、
dashboard、OpenTofu state、provider credential は operator
distribution の責務です。

## 前提知識

- Source / Installation / Deployment の lifecycle
- Installer API の dry-run / apply / rollback
- PlatformService inventory と `BindingSelection`
- source handoff (`git` / `prepared` / `local`)
- runtime target、storage、secret store、backup / restore

## 読む順序

1. [コンセプト](../getting-started/concepts.md)
2. [仕様境界](../reference/spec-boundaries.md)
3. [Installer API](../reference/installer-api.md)
4. [プラットフォームサービス](../reference/platform-services.md)
5. [ビルドサービス境界](../reference/build-spec.md)
6. [ビルドサービス例](./build-service-profile.md)
7. [Takosumi 入口](../reference/accounts.md)

## Operator が決めること

| Area                  | Examples                                                                  |
| --------------------- | ------------------------------------------------------------------------- |
| source intake         | git source、prepared artifact、dev / operator-local source                |
| PlatformService       | runtime target、database、object store、queue、OIDC issuer、MCP endpoint |
| binding policy        | default binding、approval、quota、access mode、visibility                 |
| state / secret store  | Postgres、D1、KMS、secret encryption、backup / restore                    |
| infrastructure state  | OpenTofu state、provider credentials、lock                      |
| account surface       | signup、billing、team、dashboard、deploy facade                           |
| runtime execution     | container、worker、VM、local process、runtime-agent handler             |

Takosumi はこの選択を `bindingsSnapshot` と `outputs` として Deployment
record に残します。infrastructure creation と provider state は operator 側に
残します。

## Related

- [Installer API](../reference/installer-api.md)
- [プラットフォームサービス](../reference/platform-services.md)
- [ビルドサービス境界](../reference/build-spec.md)
- [HTTP 公開](../reference/http-exposure.md)
