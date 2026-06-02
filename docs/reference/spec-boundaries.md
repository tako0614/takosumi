# 仕様境界 {#spec-boundaries}

Takosumi ecosystem の仕様面は owner と compatibility promise が異なります。

| Surface | 答える問い |
| --- | --- |
| Takosumi | Source を install / deploy / rollback / record できるか。 |
| Operator distribution | account plane、PlatformService inventory、backend behavior、OpenTofu state をどう提供するか。 |
| Operator implementation | runtime-agent connector、inventory importer、backend adapter をどう提供するか。 |

## Takosumi {#takosumi}

Takosumi の範囲:

- `Source` / `Installation` / `Deployment` / `PlatformService` DTO
- Installer API 5 endpoint
- `InstallPlan` dry-run snapshot
- source pin、prepared digest、current pointer、`planSnapshotDigest` guard
- Deployment record の `planSnapshot` / `bindingsSnapshot` / outputs
- rollback pointer semantics

Takosumi compatibility は Installer API behavior、source guard、Deployment record、closed error envelope に基づきます。

Takosumi の範囲外:

- OpenTofu/Helm/Pulumi execution
- provider credential and state lock
- account / billing / OIDC / dashboard
- cloud-specific resource graph
- source repo 内の Takosumi 専用 DSL

## Operator distribution {#operator-distribution}

Operator distribution は Takosumi の周辺で account-facing behavior と backend operation を定義します。

範囲:

- account と Space ownership record
- installer token issuance と auth policy
- PlatformService inventory
- OpenTofu/Helm/Pulumi state where used
- OIDC / billing / dashboard / deploy facade
- account-plane read model と audit projection
- runtime / gateway / provider binding choice

Takosumi は reference operator distribution の 1 つです。normative docs は `takosumi/docs/` に置きます。

## Operator implementation {#integration-packages}

Operator implementation は operator distribution が所有する backend wiring です。

範囲:

- PlatformService inventory importer
- runtime-agent connector
- backend adapter
- reference distribution の便利な wiring

OpenTofu provider の代替ではありません。OpenTofu で作るべき infra は operator side で作り、その output を
PlatformService inventory に渡します。

## 置き場所の目安

| 文書が触れるもの | normative definition の置き場所 |
| --- | --- |
| Source / Installation / Deployment / PlatformService DTO | Takosumi |
| Installer API 5 endpoint | Takosumi |
| `InstallPlan` / `planSnapshotDigest` | Takosumi |
| PlatformService concrete path / labels / lifecycle | operator distribution |
| OpenTofu state / provider credentials | operator distribution or `takos-private/` |
| account API / billing / OIDC / dashboard route | operator distribution |
| runtime-agent connector implementation | operator distribution |

## 読む順序

1. [Takosumi v1](./takosumi-v1.md)
2. [Installer API](./installer-api.md)
3. [プラットフォームサービス](./platform-services.md)
4. operator behavior が必要なときは operator distribution docs。Takosumi は [Takosumi](./accounts.md) から読む。
