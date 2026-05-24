# リファレンス {#reference}

Takosumi reference は、current spec、operator / reference
implementation、内部設計を 分けて読むための索引です。初めて読む場合は
[クイックスタート](../getting-started/quickstart.md) と
[コンセプト](../getting-started/concepts.md) から始めてください。

## Normative contracts

この層が AppSpec author と Installer API client の正本です。

- [AppSpec (`.takosumi.yml`)](./app-spec.md) — source root に置く declarative
  spec。root は `apiVersion` / `metadata` / `components`。
- [Installer API](./installer-api.md) — Installation / Deployment / rollback の
  5 endpoint。
- [Public Spec Source Map](./public-spec-source-map.md) — public surface ごとの
  source of truth と published reference。

## Authoring helpers / examples

この層は public contract を使いやすくするための説明と reference example です。

- [CLI](./cli.md) — Installer API を呼ぶ `takosumi` command surface。
- [Kind Descriptor Examples](./kind-registry.md) — takosumi.com が公開する kind
  descriptor examples。operator が opt-in して使う。

## Source preparation

AppSpec は apply intent を書きます。build や prepare は source を Installer API
に 渡す前の処理です。

- [Build service handoff](./build-spec.md) — build service / CI が prepared
  source snapshot を作るための convention。
- [Digest computation](./digest-computation.md) — AppSpec digest、prepared
  source digest、optional DataAsset digest の計算。

## Operator / reference implementation

この層は Takosumi reference kernel を起動・拡張・運用する人向けです。

- [Environment Variables](./env-vars.md) — kernel / CLI / runtime-agent の env。
- [Provider Implementations](./providers.md) — provider implementation の
  attach、 capability、selection。
- [Provider package examples](./provider-packages.md) — reference provider
  package と capability metadata の例。
- [Reference Plugin Loading](./plugin-loading.md) — reference kernel の
  Vite-like provider attach model。
- [Connector Guide](./connector-contract.md) — runtime-agent connector の
  envelope と accepted DataAsset metadata。
- [Runtime-Agent API](./runtime-agent-api.md) — reference kernel から agent
  に送る lifecycle RPC。
- [Reference Kernel Route Inventory](./kernel-http-api.md) — public installer
  API、internal API、 runtime-agent RPC の境界。

## DataAsset extension

DataAsset は operator が有効化できる optional extension です。AppSpec や
prepared source の代わりではありません。

- [Operator DataAsset Extension](./data-asset-policy.md) — DataAsset access
  policy と lifecycle。
- [DataAsset GC](./artifact-gc.md) — DataAsset retention と activation history。

## Lifecycle / status

- [Lifecycle Protocol](./lifecycle.md)
- [Lifecycle Phases](./lifecycle-phases.md)
- [WAL Stages](./wal-stages.md)
- [GroupHead Rollout](./group-head-rollout.md)
- [Readiness Probes](./readiness-probes.md)
- [Plan Output](./plan-output.md)
- [Status Output](./status-output.md)

## Storage / policy / observability

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

## Security / operation

- [Secret Partitions](./secret-partitions.md)
- [Cross-Process Locks](./cross-process-locks.md)
- [Supply Chain Trust](./supply-chain-trust.md)
- [Bootstrap Protocol](./bootstrap-protocol.md)
- [Backup and Restore](./backup-restore.md)
- [Migration / Upgrade](./migration-upgrade.md)
- [Workers Backend](./workers-backend.md)

## Architecture notes

Architecture notes は内部設計を追うための資料です。current public contract
を読む だけなら必須ではありません。

- [内部設計の概要](./architecture/index.md)
- [Kernel](./architecture/kernel.md)
- [Deploy System](./architecture/deploy-system.md)
- [Runtime Routing](./architecture/runtime-routing.md)
- [Runtime Deployment](./architecture/runtime-deployment-model.md)
- [Kind Resolution Model](./architecture/kind-resolution-model.md)
- [Namespace Export Model](./architecture/namespace-export-model.md)
- [External Descriptor Intake](./architecture/external-descriptor-registry-model.md)
- [Operator Boundaries](./architecture/operator-boundaries.md)

## RFC / design record

RFC は current spec の正本ではなく、設計判断と履歴を追うための記録です。現在の
仕様はこの reference の current public contract を優先してください。

- [RFC 0001 — Kernel kind-agnostic 化](../rfc/0001-kernel-kind-agnostic.md)

## Docs boundary

Takosumi kernel docs は kernel lifecycle と installer contract に集中します。
account、billing、OIDC issuer、customer onboarding、managed offering support
workflow は operator account-plane の資料で扱います。reference implementation の
該当 docs は `takosumi-cloud/` 側にあります。
