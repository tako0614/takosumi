# Resource IDs

Takosumi installer public wire と reference kernel evidence で使う resource ID
の grammar です。public installer wire と reference-internal /
operator-extension wire は stability scope が違います。operator account-plane の
actor / organization / billing ID は account-plane docs で扱います。

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

## Public Installer Wire ID Kinds

| Kind           | Suffix              | 説明                                                                 |
| -------------- | ------------------- | -------------------------------------------------------------------- |
| `space`        | kebab-case          | operator が指定する Space id。                                       |
| `installation` | ULID or stable name | Space 内の Installation。                                            |
| `deployment`   | ULID                | apply ごとに kernel が生成。rollback は retained Deployment を参照。 |

## Reference-Internal And Operator-Extension ID Kinds

以下は reference kernel evidence、operator tooling、または optional extension の
ID です。AppSpec shape と Installer API request / response shape が全
implementation に要求する portable public spec であり、下表の ID
はその外側です。

| Kind                             | Suffix                             | 説明                                                                      |
| -------------------------------- | ---------------------------------- | ------------------------------------------------------------------------- |
| `journal`                        | ULID                               | WAL entry。                                                               |
| `operation`                      | ULID                               | OperationPlan entry。                                                     |
| `resolution`                     | `sha256:<hex>`                     | ResolutionSnapshot の content address。                                   |
| `desired`                        | `sha256:<hex>`                     | DesiredSnapshot の content address。                                      |
| `activation`                     | ULID                               | ActivationSnapshot。                                                      |
| `object`                         | kebab-case                         | materialized object の logical id。                                       |
| `link`                           | `<consumer>.<slot>`                | publication / binding link。                                              |
| `generated`                      | `<owner-kind>:<owner-id>/<reason>` | kernel 生成 object。                                                      |
| `exposure`                       | kebab-case                         | route / ingress exposure。                                                |
| `revoke-debt`                    | ULID                               | RevokeDebt entry。                                                        |
| `approval`                       | ULID                               | approval record。                                                         |
| `connector`                      | kebab-case                         | runtime-agent connector id。                                              |
| `artifact`                       | `sha256:<hex>`                     | compatibility wire prefix for optional operator DataAsset record digest。 |
| `policy`                         | `sha256:<hex>`                     | policy bundle digest。                                                    |
| `group`                          | kebab-case                         | rollout / activation group。                                              |
| `operator-implementation-config` | kebab-case or ULID                 | operator implementation / alias config evidence。                         |

## Examples

```text
space_acme_prod
inst_01HM9N7XK4QY8RT2P5JZF6V3W9
dep_01HM9N7XK4QY8RT2P5JZF6V3WA
```

Reference-internal / extension examples:

```text
journal:01HM9N7XK4QY8RT2P5JZF6V3WB
operation:01HM9N7XK4QY8RT2P5JZF6V3WC
res_sha256_...
desired:sha256:b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9
conn_cloudflare_workers
artifact:sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
operator_implementation_config_default
```

## Stability

Public installer wire ID grammar is part of the public wire shape. Changing
`space` / `installation` / `deployment` kind names, suffix grammar, or delimiter
is a breaking change and requires an RFC. Reference-internal and
operator-extension IDs may evolve with the owning implementation or extension,
but readers of reference kernel evidence must follow the grammar documented
here.

## 関連ページ

- [Enum and Value Index](./closed-enums.md)
- [Storage Schema](./storage-schema.md)
- [Digest Computation](./digest-computation.md)
- [Connector Guide](./connector-contract.md)
