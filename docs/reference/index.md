# リファレンス {#reference}

Takosumi docs の reference は、kernel と installer contract を調べるための索引
です。初めて読む場合は [クイックスタート](/getting-started/quickstart) と
[コンセプト](/getting-started/concepts) から始めてください。

## まず見る contract

- [AppSpec (`.takosumi.yml`)](./app-spec.md) — ユーザーが source root に置く
  declarative spec。
- [BuildSpec (`.takosumi.build.yml`)](./build-spec.md) — source build と
  prepared source snapshot を作るための build service input。
- [Installer API](./installer-api.md) — Installation / Deployment / rollback の
  5 endpoint。
- [Kernel HTTP API](./kernel-http-api.md) — public installer API、internal API、
  runtime-agent RPC の境界。
- [Runtime-Agent API](./runtime-agent-api.md) — kernel から agent に送る
  lifecycle RPC。
- [Public Spec Source Map](./public-spec-source-map.md) — public surface ごとの
  source of truth と published reference の対応表。
- [CLI](./cli.md) — `takosumi` command surface。
- [Environment Variables](./env-vars.md) — kernel / CLI / runtime-agent の env。
- [Glossary](./glossary.md) — docs 全体で使う短い用語定義。

## Component と provider

- [Reference Kind Descriptors](./kind-registry.md) — takosumi.com reference
  component kind、spec、outputs、JSON-LD descriptor。
- [Provider Implementations](./providers.md) — provider implementation の
  attach、 capability、selection。
- [Provider package examples](./provider-packages.md) — reference provider
  package と capability metadata の例。
- [Connector Contract](./connector-contract.md) — runtime-agent connector の
  envelope と accepted kind。
- [DataAsset Policy](./data-asset-policy.md) — optional DataAsset extension
  の扱い。
- [DataAsset GC](./artifact-gc.md) — DataAsset retention と activation history。

## Lifecycle と実行

- [Lifecycle Protocol](./lifecycle.md)
- [Lifecycle Phases](./lifecycle-phases.md)
- [WAL Stages](./wal-stages.md)
- [GroupHead Rollout](./group-head-rollout.md)
- [Readiness Probes](./readiness-probes.md)
- [Plan Output](./plan-output.md)
- [Status Output](./status-output.md)

## Storage、policy、observability

- [Storage Schema](./storage-schema.md)
- [Audit Events](./audit-events.md)
- [Closed Enums](./closed-enums.md)
- [Risk Taxonomy](./risk-taxonomy.md)
- [Approval Invalidation](./approval-invalidation.md)
- [Access Modes](./access-modes.md)
- [RevokeDebt Model](./revoke-debt.md)
- [Observation Retention](./observation-retention.md)
- [Drift Detection](./drift-detection.md)
- [Telemetry / Metrics](./telemetry-metrics.md)
- [Logging Conventions](./logging-conventions.md)
- [Observability Stack](./observability-stack.md)

## Security と operation

- [Secret Partitions](./secret-partitions.md)
- [Cross-Process Locks](./cross-process-locks.md)
- [Plugin Loading](./plugin-loading.md)
- [Supply Chain Trust](./supply-chain-trust.md)
- [Backup and Restore](./backup-restore.md)
- [Migration / Upgrade](./migration-upgrade.md)
- [Bootstrap Protocol](./bootstrap-protocol.md)
- [Workers Backend](./workers-backend.md)

## Architecture notes

Architecture notes は内部設計を追うための資料です。

- [内部設計の概要](./architecture/index.md)
- [Kernel](./architecture/kernel.md)
- [Deploy System](./architecture/deploy-system.md)
- [Runtime Routing](./architecture/runtime-routing.md)
- [Runtime Deployment](./architecture/runtime-deployment-model.md)
- [Kind Resolution Model](./architecture/kind-resolution-model.md)
- [Namespace Export Model](./architecture/namespace-export-model.md)
- [External Descriptor Intake](./architecture/external-descriptor-registry-model.md)
- [Operator Boundaries](./architecture/operator-boundaries.md)

## Docs boundary

Takosumi kernel docs は kernel lifecycle と installer contract に集中します。
account、billing、OIDC issuer、customer onboarding、managed offering support
workflow は operator account-plane の資料で扱います。reference implementation の
該当 docs は `takosumi-cloud/` 側にあります。
