# Resource IDs

Takosumi kernel が API response、audit event、snapshot、journal entry、CLI
output に出す resource ID の grammar です。operator account-plane の actor /
organization / billing ID は account-plane docs で扱います。

## Grammar

```text
<kind>:<unique-suffix>
```

- `kind` は kebab-case ASCII。
- `:` は kind と suffix の delimiter。
- suffix は kind ごとの grammar に従う。
- ID は case-sensitive。
- suffix grammar は kind ごとに閉じる。通常の ULID / kebab-case suffix は
  delimiter-free。content-addressed ID は `sha256:<hex>` のように algorithm
  prefix を含めてよく、`generated` は owner resource ID を prefix として含めて
  よい。

## Kernel-owned ID kind

| Kind                             | Suffix                             | 説明                                              |
| -------------------------------- | ---------------------------------- | ------------------------------------------------- |
| `space`                          | kebab-case                         | operator が指定する Space id。                    |
| `installation`                   | ULID or stable name                | Space 内の Installation。                         |
| `deployment`                     | ULID                               | apply / rollback ごとに kernel が生成。           |
| `journal`                        | ULID                               | WAL entry。                                       |
| `operation`                      | ULID                               | OperationPlan entry。                             |
| `resolution`                     | `sha256:<hex>`                     | ResolutionSnapshot の content address。           |
| `desired`                        | `sha256:<hex>`                     | DesiredSnapshot の content address。              |
| `activation`                     | ULID                               | ActivationSnapshot。                              |
| `object`                         | kebab-case                         | materialized object の logical id。               |
| `link`                           | `<consumer>.<slot>`                | namespace / binding link。                        |
| `generated`                      | `<owner-kind>:<owner-id>/<reason>` | kernel 生成 object。                              |
| `exposure`                       | kebab-case                         | route / ingress exposure。                        |
| `revoke-debt`                    | ULID                               | RevokeDebt entry。                                |
| `approval`                       | ULID                               | approval record。                                 |
| `connector`                      | kebab-case                         | runtime-agent connector id。                      |
| `artifact`                       | `sha256:<hex>`                     | optional operator DataAsset digest。              |
| `policy`                         | `sha256:<hex>`                     | policy bundle digest。                            |
| `group`                          | kebab-case                         | rollout / activation group。                      |
| `operator-implementation-config` | kebab-case or ULID                 | operator implementation / alias config evidence。 |

## Examples

```text
space:acme-prod
installation:01HM9N7XK4QY8RT2P5JZF6V3W9
deployment:01HM9N7XK4QY8RT2P5JZF6V3WA
journal:01HM9N7XK4QY8RT2P5JZF6V3WB
operation:01HM9N7XK4QY8RT2P5JZF6V3WC
resolution:sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08
desired:sha256:b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9
connector:cloudflare-workers
artifact:sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
operator-implementation-config:default
```

## Stability

ID grammar is part of the public wire shape. Changing a kind name, suffix
grammar, or delimiter is a breaking change and requires an RFC.

## 関連ページ

- [Closed Enums](./closed-enums.md)
- [Storage Schema](./storage-schema.md)
- [Digest Computation](./digest-computation.md)
- [Connector Contract](./connector-contract.md)
