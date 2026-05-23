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

- [Reference Kind Registry](./kind-catalog.md) — Takos reference component
  kind、spec、outputs、JSON-LD descriptor。
- [Provider plugin](./providers.md) — provider plugin の attach、capability、
  selection。
- [Provider Catalog](./provider-catalog.md) — 同梱 provider id と capability の
  一覧。
- [Connector Contract](./connector-contract.md) — runtime-agent connector の
  envelope と accepted kind。
- [DataAsset Policy](./data-asset-policy.md) — artifact / data asset の扱い。
- [Artifact GC](./artifact-gc.md) — artifact retention と activation history。

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
- [Catalog Release Trust](./catalog-release-trust.md)
- [Supply Chain Trust](./supply-chain-trust.md)
- [Backup and Restore](./backup-restore.md)
- [Migration / Upgrade](./migration-upgrade.md)
- [Bootstrap Protocol](./bootstrap-protocol.md)
- [Workers Backend](./workers-backend.md)

## Architecture notes

Architecture notes は内部設計を追うための奥の資料です。通常の authoring には
不要です。

- [内部設計の概要](./architecture/index.md)
- [Kernel](./architecture/kernel.md)
- [Deploy System](./architecture/deploy-system.md)
- [Runtime Routing](./architecture/runtime-routing.md)
- [Runtime Deployment](./architecture/runtime-deployment-model.md)
- [Namespace Export Model](./architecture/namespace-export-model.md)
- [Operator Boundaries](./architecture/operator-boundaries.md)

## Docs boundary

Takosumi kernel docs は account、billing、OIDC issuer、customer onboarding、
managed offering support workflow を説明しません。それらは operator
account-plane の責務であり、reference implementation は `takosumi-cloud/` 側の
docs で扱います。
