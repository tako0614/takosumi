# Reference

> Stability: stable Audience: operator See also: navigation hub for all v1
> reference docs

Takosumi v1 の正式な API surface 仕様 / closed enum 定義 / wire schema / 運用
protocol を集約する。各 doc は self-contained で、実装者・operator
が直接参照できる粒度で書かれている。

## API surfaces

クライアントとサーバーの間で交わされる surface。

- [Kernel HTTP API](./kernel-http-api) — public deploy / internal control plane
  / artifact upload
- [Runtime-Agent API](./runtime-agent-api) — kernel ↔ runtime-agent の lifecycle
  RPC
- [CLI](./cli) — `takosumi` command surface
- [Lifecycle Protocol](./lifecycle) — phase 連携と cross-process lock
- [Provider / Implementation Contract](./provider-implementation-contract) —
  runtime-agent 側 Implementation の wire-level contract

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
  Approval / SpaceExportShare の論理 wire schema
- [Journal Compaction](./journal-compaction) — compaction policy / retention
- [Audit Events](./audit-events) — event taxonomy / hash chain
- [Observation Retention](./observation-retention) — ObservationSet retention /
  ObservationHistory opt-in / freshness propagation
- [Drift Detection](./drift-detection) — DriftIndex compute / annotation /
  RevokeDebt linkage

## Identity & Access

actor / role / credential 体系と認証 plug-in surface。

- [Actor / Organization Model](./actor-organization-model) — Actor /
  Organization / Membership / 4 actor type
- [RBAC Policy](./rbac-policy) — 7 role closed enum / capability matrix / Space
  scope
- [API Key Management](./api-key-management) — 4 key type / prefix grammar /
  rotation / revocation
- [Auth Providers](./auth-providers) — 4 provider type / verification protocol /
  claim mapping

## Security & trust

operator が production 運用するための trust 境界。

- [Secret Partitions](./secret-partitions) — AES-GCM partition / HKDF salt /
  multi-cloud override
- [Cross-Process Locks](./cross-process-locks) — heartbeat / TTL / recovery
- [Catalog Release Trust](./catalog-release-trust) — signature / publisher key
  enrollment
- [External Participants](./external-participants) — registration / verification
  / external implementation

## Triggers & Hooks

Workflow extension primitives (予約済み kernel-side contract。現行実装では
plugin shape を通常の `resources[]` として deploy する)。

- [Triggers](./triggers) — manual / schedule / external-event の 3 closed kind
- [Execute-Step Operation](./execute-step-operation) — `execute-step` operation
  kind の wire-level contract
- [Declarable Hooks](./declarable-hooks) — manifest で declare 可能な lifecycle
  hook

## Tenant lifecycle

Space provisioning / trial / export / deletion の正本 protocol。

- [Tenant Provisioning](./tenant-provisioning) — Space onboarding / initial
  CatalogRelease binding
- [Trial Spaces](./trial-spaces) — trial lifecycle 5-state / auto-expire /
  conversion
- [Tenant Export and Deletion](./tenant-export-deletion) — data export / Space
  deletion / hard-delete window

## Operations

運用タスクと制限。

- [Migration / Upgrade](./migration-upgrade) — rolling upgrade / rollback /
  kernel ↔ runtime-agent skew
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

shape catalog / provider / template / artifact 拡張面。

- [Shape Catalog](./shapes) — v1 shapes / outputFields / capability extension
- [Provider Plugins](./providers) — v1 provider matrix / registerProvider
- [Plugin Marketplace](./plugin-marketplace) — remote install / signed package
  index / executable hook package
- [Templates](./templates) — registerTemplate / expand immutability
- [Artifact Kinds](./artifact-kinds) — DataAsset kind registry /
  registerArtifactKind
- [Connector Contract](./connector-contract) — `connector:<id>` / acceptedKinds
  / envelope versioning
- [DataAsset Policy](./data-asset-policy) — upload cap / accepted-kind
  enforcement / artifact auth boundaries
- [Artifact GC](./artifact-gc) — artifact GC / ActivationSnapshot history export
- [Space Export Share](./space-export-share) — share lifecycle protocol / TTL /
  revoke

## Manifest & wire formats

- [Manifest Validation](./manifest-validation) — closed grammar / validation
  phase / error code
- [Manifest Expand Semantics](./manifest-expand-semantics) — `${ref:...}` 解決 /
  cycle detection
- [Plan Output Schema](./plan-output) — `takosumi plan` / `mode: "plan"` 出力
- [Status Output Schema](./status-output) — `takosumi status` /
  `/v1/deployments` 出力
- [Resource IDs](./resource-ids) — kind grammar / suffix format / 安定性
- [Digest Computation](./digest-computation) — JCS canonicalization / sha256 /
  各 digest の input scope
- [Time and Clock Model](./time-clock-model) — wall / monotonic / Lamport /
  clock skew

## Configuration

- [Environment Variables](./env-vars) — kernel / CLI / runtime-agent の v1 env
  catalog

## Stability

各 doc は冒頭に `Stability:` を明記する。stability の意味は以下:

- **stable**: wire shape (closed enum 値、record schema field 名、HTTP endpoint
  path、CLI subcommand 名、audit event 名、env var 名) は v1 で freeze、変更には
  `CONVENTIONS.md` §6 RFC が必須。一方、operator-tunable な default 値
  (TTL、grace window、threshold、batch size、quota tier cap 値、polling interval
  等) は operator が env / config で override 可能で、これは stable
  範疇に含まれない。default 値変更は wire 互換性 破壊ではないため、CHANGELOG
  への記載は行うが RFC は不要。
- **beta**: wire 互換維持の対象だが、minor evolution が許容される。 breaking
  変更には RFC が必須。
- **experimental**: 変更可能性あり、production 採用前に operator が CHANGELOG
  を確認。

stable doc 内に "operator-tunable" / "operator-decided" / "policy-controlled"
と書かれた値は default を tuning できる operator policy であり、wire shape の
stability とは独立に評価する。
