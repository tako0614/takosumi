# Reference

> このページでわかること: Takosumi v1 リファレンスドキュメントの目次。

## API surfaces

クライアントとサーバーの間で交わされる surface。

- [AppSpec (`.takosumi.yml`)](./app-spec.md) — source root に置く 1 ファイル
- [Kind Catalog](./kind-catalog.md) — curated 4 種 component kind +
  operator-defined kind schema + JSON-LD source-of-truth + artifact kind
  registry
- [Installer API](./installer-api.md) — 5 endpoint の wire spec (dry-run / apply
  / rollback)
- [Kernel HTTP API](./kernel-http-api.md) — public installer + internal control
  plane + runtime-agent RPC の overview
- [Runtime-Agent API](./runtime-agent-api.md) — kernel ↔ runtime-agent の
  lifecycle RPC
- [CLI](./cli.md) — `takosumi` command surface
- [Lifecycle Protocol](./lifecycle.md) — phase 連携と cross-process lock
- [Provider Plugins — Implementation Contract](./providers.md#implementation-contract)
  — runtime-agent 側 Implementation の wire-level contract
- [Public Spec Source Map](./public-spec-source-map.md) — public surface ごとの
  source of truth / publish URL / drift check

## Lifecycle & execution

phase 進行と実行モデル。

- [Lifecycle Phases](./lifecycle-phases.md) — apply / activate / destroy /
  rollback / recovery / observe + `LifecycleStatus`
- [WAL Stages](./wal-stages.md) — write-ahead journal stage / idempotency /
  replay
- [GroupHead and Rollout](./group-head-rollout.md) — canary / shadow / rollout
  state machine
- [Readiness Probes](./readiness-probes.md) — readiness DAG and dependency
  propagation

## Policy / Risk / Approval

allow / deny / approval を扱う closed vocabulary。

- [Closed Enums](./closed-enums.md) — 全 closed enum と state machine の hub
- [Access Modes](./access-modes.md) — `read` / `read-write` / `admin` /
  `invoke-only` / `observe-only`
- [Approval Invalidation Triggers](./approval-invalidation.md) — 6 trigger と
  propagation
- [Risk Taxonomy](./risk-taxonomy.md) — closed risk enum と stable id
- [RevokeDebt Model](./revoke-debt.md) — reason / status / aging window

## Storage & observability

永続化レイヤと観測レイヤ。

- [Storage Schema](./storage-schema.md) — Snapshot / Journal / RevokeDebt /
  Approval の論理 wire schema
- [Journal Compaction](./journal-compaction.md) — compaction policy / retention
- [Audit Events](./audit-events.md) — event taxonomy / hash chain
- [Observation Retention](./observation-retention.md) — ObservationSet retention
  / ObservationHistory opt-in / freshness propagation
- [Drift Detection](./drift-detection.md) — DriftIndex compute / annotation /
  RevokeDebt linkage

## Identity & Access

account-plane identity / billing / RBAC は Takosumi Accounts が所有する。 kernel
側から見たときの境界を次のページで説明する。

- [Actor / Organization Model](./architecture/identity-and-access-architecture.md#actor--organization-model)
  — actor / organization の責務境界
- [RBAC Policy](./rbac-policy.md) — RBAC を所有する layer の整理
- [API Key Management](./api-key-management.md) — installer / artifact
  credentials
- [Auth Providers](./auth-providers.md) — auth provider の責務境界

## Security & trust

operator が production 運用するための trust 境界。

- [Secret Partitions](./secret-partitions.md) — AES-GCM partition / HKDF salt /
  multi-cloud override
- [Cross-Process Locks](./cross-process-locks.md) — heartbeat / TTL / recovery
- [Catalog Release Trust](./catalog-release-trust.md) — signature / publisher
  key enrollment

## Tenant lifecycle

Space provisioning / trial / export / deletion の手順。

- [Tenant Provisioning](./tenant-provisioning.md) — Space onboarding / initial
  CatalogRelease binding
- [Trial Spaces](./trial-spaces.md) — trial lifecycle 5-state / auto-expire /
  conversion
- [Tenant Export and Deletion](./tenant-export-deletion.md) — data export /
  Space deletion / hard-delete window

## Operations

運用タスクと制限。

- [Schema Evolution](./migration-upgrade.md) — rolling upgrade / rollback /
  kernel ↔ runtime-agent skew
- [Quota / Rate Limit](./quota-rate-limit.md) — per-tenant metering / rate limit
  policy
- [Compliance Retention](./compliance-retention.md) — PCI-DSS / HIPAA / SOX
  retention map
- [Bootstrap Protocol](./bootstrap-protocol.md) — kernel 初回起動 / default
  Space / initial CatalogRelease
- [Backup and Restore](./backup-restore.md) — backup / restore protocol と境界
- [Telemetry and Metrics](./telemetry-metrics.md) — OpenTelemetry / Prometheus
  export 規約
- [Logging Conventions](./logging-conventions.md) — structured log / level / PII
  redaction
- [Observability Stack](./observability-stack.md) — managed vs self-hosted
  ownership and SLI / SLO targets

## PaaS operations

multi-tenant PaaS provider 固有の運用 surface。

- [Quota Tiers](./quota-tiers.md) — tier catalog / quota envelope / tier
  transition
- [Cost Attribution](./cost-attribution.md) — usage event / per-Space
  attribution / billing export
- [SLA Breach Detection](./sla-breach-detection.md) — SLA 5-state / breach
  detection / recovery
- [Zone Selection](./zone-selection.md) — zone catalog / placement policy /
  failover
- [Incident Model](./incident-model.md) — incident state 6-value / severity
  4-value / postmortem
- [Support Impersonation](./support-impersonation.md) — grant lifecycle /
  approval / scope and audit
- [Notification Emission](./notification-emission.md) — channel / delivery /
  dedup / retention

## Catalog & extension

Component kind catalog / provider / artifact 拡張面。

- [Kind Catalog](./kind-catalog.md) — curated 4 built-in component kind +
  operator-defined kind の spec / outputs / publish / listen 仕様 +
  `https://takosumi.com/kinds/v1/*` の JSON-LD 形式と operator-defined kind の
  publish 手順 + DataAsset kind registry / registerArtifactKind
- [Provider Plugins](./providers.md) — v1 provider matrix / KernelPlugin attach
- [Connector Contract](./connector-contract.md) — `connector:<id>` /
  acceptedKinds / envelope versioning
- [DataAsset Policy](./data-asset-policy.md) — upload cap / accepted-kind
  enforcement / artifact auth boundaries
- [Artifact GC](./artifact-gc.md) — artifact GC / ActivationSnapshot history
  export

## Manifest & wire formats

- [Manifest](./manifest.md) — spec / validation rules / expand semantics / data
  model (= `.takosumi.yml` 正本)
- [Plan Output Schema](./plan-output.md) — `takosumi plan` / `mode: "plan"` 出力
- [Status Output Schema](./status-output.md) — internal Installation /
  Deployment ledger read boundary
- [Resource IDs](./resource-ids.md) — kind grammar / suffix format / 安定性
- [Digest Computation](./digest-computation.md) — JCS canonicalization / sha256
  / 各 digest の input scope
- [Time and Clock Model](./time-clock-model.md) — wall / monotonic / Lamport /
  clock skew

## Configuration

- [Environment Variables](./env-vars.md) — kernel / CLI / runtime-agent の v1
  env catalog

## Stability

reference doc が freeze する v1 wire shape の対象:

- closed enum 値 / state machine の状態名と遷移
- record schema の field 名と型
- HTTP endpoint path と request / response の field 名
- CLI subcommand 名と flag 名
- audit event 名と payload field 名
- environment variable 名
- resource ID prefix と format

これらの breaking 変更には `CONVENTIONS.md` §6 RFC が必須。

operator-tunable な default 値 (TTL / grace window / threshold / batch size /
quota tier cap / polling interval 等) は wire shape ではないため、 stability
とは独立。 default 値変更は CHANGELOG への記載のみで足りる。

doc 内で "operator-tunable" / "operator-decided" / "policy-controlled"
と書かれた値は operator policy で tuning できる対象であり、 wire shape の
stability とは独立に評価する。
