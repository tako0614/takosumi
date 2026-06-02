# Takosumi v1 {#takosumi-v1}

Takosumi は manifestless な Source install/deploy contract です。public concept は
**Source / Installation / Deployment / PlatformService** の 4 つです。

| Concept | 意味 |
| --- | --- |
| Source | `git` / `prepared` / `local` source input と resolved identity。 |
| Installation | Space に install された source record。current Deployment pointer を持つ。 |
| Deployment | 1 回の apply result。source summary、plan snapshot、binding snapshot、outputs、status を持つ。 |
| PlatformService | operator inventory が提供する service capability。 |

## Takosumi が定義するもの

- Source input kind と source identity guard
- Installation / Deployment lifecycle
- Installer API の 5 endpoint
- dry-run response としての `InstallPlan`
- `planSnapshotDigest` による reviewed source / binding resolution guard
- PlatformService binding snapshot の記録
- rollback の pointer semantics

Takosumi は OpenTofu/Helm/Pulumi、provider credential、account plane、billing、OIDC issuer policy、dashboard、deploy
facade を所有しません。これらは operator distribution の account-facing / operator-facing surface です。

## Source

| Kind | 説明 |
| --- | --- |
| `git` | remote git source。`url` と `ref` を受け取り、apply guard は resolved commit + `planSnapshotDigest`。 |
| `prepared` | build service / CI が作った source archive。`url` と archive payload digest を受け取り、apply guard は source digest + `planSnapshotDigest`。 |
| `local` | dev / operator-local の Takosumi service から見える path。portable byte identity は持たず、guard は `planSnapshotDigest`。 |

Takosumi 専用 source DSL はありません。repo metadata は Git URL、commit、tag、`package.json` などの汎用 metadata から
読みます。operator-owned OpenTofu module は `tofu output -json` で app metadata や inventory material を公開できますが、
Takosumi 自身は HCL parse / plan / apply を行いません。

## InstallPlan

`InstallPlan` は dry-run response の snapshot です。persisted public entity ではありません。

代表 field:

| Field | 説明 |
| --- | --- |
| `source` | resolved Source summary。 |
| `repo` | generic repo metadata。 |
| `requestedBindings` | request / UI / policy から来た binding selection。 |
| `resolvedBindings` | operator PlatformService inventory で解決された service set。 |
| `publications` | Deployment output として公開される予定の non-secret output plan。 |
| `changes` | create / update / delete / noop preview。 |
| `warnings` | operator policy や source metadata の注意。 |

`planSnapshotDigest` は source summary、repo metadata、binding resolution、publication plan、changes を含む reviewed snapshot の
digest です。apply 時に `expected.planSnapshotDigest` を渡すと、dry-run 後に source や binding resolution が変わった場合
409 `failed_precondition` になります。

## Installer API

public Installer API は Installation を中心にした 5 endpoint です。

```text
POST /v1/installations/dry-run
POST /v1/installations
POST /v1/installations/{id}/deployments/dry-run
POST /v1/installations/{id}/deployments
POST /v1/installations/{id}/rollback
```

dashboard、CLI、rollback target selection、support workflow の read / list / history / poll surface は operator-owned read
model です。

## PlatformService Binding

PlatformService inventory は operator distribution が所有します。inventory は OpenTofu output、HCP Stacks publish output、
remote state、static config、cloud API、account-plane dashboard などから作れます。

Takosumi は request の `bindings[]`、operator policy、account-plane selection を受け取り、operator resolver で
PlatformService を解決し、Deployment の `bindingsSnapshot` に保存します。

## Rollback Semantics

`POST /v1/installations/{id}/rollback` は control-plane の pointer 操作です。Installation の
`currentDeploymentId` を保持済みの過去の成功 Deployment に戻します。新しい Deployment は作りません。

rollback が戻すもの:

| 軸 | 値 |
| --- | --- |
| `pointer` | `reverted` |
| `resourceMaterialization` | `not-reapplied` |
| `workloadState` | `not-reverted` |

provider resource や workload data を汎用 rollback する責務は Takosumi にはありません。必要な場合は operator workflow
または app migration / backup restore で扱います。

## Operator Surface

| Surface | Defines |
| --- | --- |
| Takosumi | Source / Installation / Deployment / PlatformService DTO、Installer API、guard、ledger。 |
| Operator distribution | account plane、PlatformService inventory、provider binding、OpenTofu state、dashboard、deploy facade。 |
| operator implementation | operator-adoptable inventory importers、runtime-agent connectors、backend adapters。 |

## 関連ページ

- [仕様境界](./spec-boundaries.md)
- [Installer API](./installer-api.md)
- [プラットフォームサービス](./platform-services.md)
- [Takosumi](./accounts.md)
