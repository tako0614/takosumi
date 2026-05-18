# Reference

> このページでわかること: Takosumi v1 リファレンスドキュメントの目次。

## API surfaces

クライアントとサーバーの間で交わされる surface。

- [AppSpec (`.takosumi.yml`)](./app-spec) — source root に置く 1 ファイル
- [Component Kind Catalog](./component-kind-catalog) — curated 4 種 +
  operator-defined kind schema
- [Installer API](./installer-api) — 5 endpoint の wire spec (dry-run / apply /
  rollback)
- [Kernel HTTP API](./kernel-http-api) — public installer + internal control
  plane + runtime-agent RPC の overview
- [Runtime-Agent API](./runtime-agent-api) — kernel ↔ runtime-agent の lifecycle
  RPC
- [CLI](./cli) — `takosumi` command surface
- [Lifecycle Protocol](./lifecycle) — phase 連携と cross-process lock
- [Provider / Implementation Contract](./provider-implementation-contract) —
  runtime-agent 側 Implementation の wire-level contract
- [Public Spec Source Map](./public-spec-source-map) — public surface ごとの
  source of truth / publish URL / drift check

## Lifecycle & execution

phase 進行と実行モデル。

- [Lifecycle Phases](./lifecycle-phases) — apply / activate / destroy / rollback
  / recovery / observe + `LifecycleStatus`
- [WAL Stages](./wal-stages) — write-ahead journal stage / idempotency / replay
- [GroupHead and Rollout](./group-head-rollout) — canary / shadow / rollout
  state machine
- [Readiness Probes](./readiness-probes) — readiness DAG and dependency
  propagation

## Policy / Risk / Approval

allow / deny / approval を扱う closed vocabulary。

- [Closed Enums](./closed-enums) — 全 closed enum と state machine の hub
- [Access Modes](./access-modes) — `read` / `read-write` / `admin` /
  `invoke-only` / `observe-only`
- [Approval Invalidation Triggers](./approval-invalidation) — 6 trigger と
  propagation
- [Risk Taxonomy](./risk-taxonomy) — closed risk enum と stable id
- [RevokeDebt Model](./revoke-debt) — reason / status / aging window

## Storage & observability

永続化レイヤと観測レイヤ。

- [Storage Schema](./storage-schema) — Snapshot / Journal / RevokeDebt /
  Approval の論理 wire schema
- [Journal Compaction](./journal-compaction) — compaction policy / retention
- [Audit Events](./audit-events) — event taxonomy / hash chain
- [Observation Retention](./observation-retention) — ObservationSet retention /
  ObservationHistory opt-in / freshness propagation
- [Drift Detection](./drift-detection) — DriftIndex compute / annotation /
  RevokeDebt linkage

## Identity & Access

account-plane identity / billing / RBAC は Takosumi Accounts が所有する。 kernel
側から見たときの境界を次のページで説明する。

- [Actor / Organization Model](./actor-organization-model) — actor /
  organization の責務境界
- [RBAC Policy](./rbac-policy) — RBAC を所有する layer の整理
- [API Key Management](./api-key-management) — installer / artifact credentials
- [Auth Providers](./auth-providers) — auth provider の責務境界

## Security & trust

operator が production 運用するための trust 境界。

- [Secret Partitions](./secret-partitions) — AES-GCM partition / HKDF salt /
  multi-cloud override
- [Cross-Process Locks](./cross-process-locks) — heartbeat / TTL / recovery
- [Catalog Release Trust](./catalog-release-trust) — signature / publisher key
  enrollment

## Tenant lifecycle

Space provisioning / trial / export / deletion の手順。

- [Tenant Provisioning](./tenant-provisioning) — Space onboarding / initial
  CatalogRelease binding
- [Trial Spaces](./trial-spaces) — trial lifecycle 5-state / auto-expire /
  conversion
- [Tenant Export and Deletion](./tenant-export-deletion) — data export / Space
  deletion / hard-delete window

## Operations

運用タスクと制限。

- [Schema Evolution](./migration-upgrade) — rolling upgrade / rollback / kernel
  ↔ runtime-agent skew
- [Quota / Rate Limit](./quota-rate-limit) — per-tenant metering / rate limit
  policy
- [Compliance Retention](./compliance-retention) — PCI-DSS / HIPAA / SOX
  retention map
- [Bootstrap Protocol](./bootstrap-protocol) — kernel 初回起動 / default Space /
  initial CatalogRelease
- [Backup and Restore](./backup-restore) — backup / restore protocol と境界
- [Telemetry and Metrics](./telemetry-metrics) — OpenTelemetry / Prometheus
  export 規約
- [Logging Conventions](./logging-conventions) — structured log / level / PII
  redaction
- [Observability Stack](./observability-stack) — managed vs self-hosted
  ownership and SLI / SLO targets

## PaaS operations

multi-tenant PaaS provider 固有の運用 surface。

- [Quota Tiers](./quota-tiers) — tier catalog / quota envelope / tier transition
- [Cost Attribution](./cost-attribution) — usage event / per-Space attribution /
  billing export
- [SLA Breach Detection](./sla-breach-detection) — SLA 5-state / breach
  detection / recovery
- [Zone Selection](./zone-selection) — zone catalog / placement policy /
  failover
- [Incident Model](./incident-model) — incident state 6-value / severity 4-value
  / postmortem
- [Support Impersonation](./support-impersonation) — grant lifecycle / approval
  / scope and audit
- [Notification Emission](./notification-emission) — channel / delivery / dedup
  / retention

## Catalog & extension

Component kind catalog / provider / artifact 拡張面。

- [Component Kind Catalog](./component-kind-catalog) — curated 4 built-in kind +
  operator-defined kind の spec / outputs / publish / listen 仕様
- [JSON-LD Kind Catalog](./json-ld-kind-catalog) —
  `https://takosumi.com/kinds/v1/*` の JSON-LD 形式と operator-defined kind の
  publish 手順
- [Provider Plugins](./providers) — v1 provider matrix / KernelPlugin attach
- [Artifact Kinds](./artifact-kinds) — DataAsset kind registry /
  registerArtifactKind
- [Connector Contract](./connector-contract) — `connector:<id>` / acceptedKinds
  / envelope versioning
- [DataAsset Policy](./data-asset-policy) — upload cap / accepted-kind
  enforcement / artifact auth boundaries
- [Artifact GC](./artifact-gc) — artifact GC / ActivationSnapshot history export

## Manifest & wire formats

- [Manifest Validation](./manifest-validation) — closed grammar / validation
  phase / error code
- [AppSpec Dependency Semantics](./manifest-expand-semantics) — `publish` /
  `listen` namespace graph / binding rules
- [Plan Output Schema](./plan-output) — `takosumi plan` / `mode: "plan"` 出力
- [Status Output Schema](./status-output) — internal Installation / Deployment
  ledger read boundary
- [Resource IDs](./resource-ids) — kind grammar / suffix format / 安定性
- [Digest Computation](./digest-computation) — JCS canonicalization / sha256 /
  各 digest の input scope
- [Time and Clock Model](./time-clock-model) — wall / monotonic / Lamport /
  clock skew

## Configuration

- [Environment Variables](./env-vars) — kernel / CLI / runtime-agent の v1 env
  catalog

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
