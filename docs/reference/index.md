# リファレンス {#reference}

## 章の分け方

Takosumi docs は、Takosumi 本体仕様と Takosumi 公式型仕様を同じ docs site
に置きます。ただし章は分けます。operator distribution の具体的な account-plane
仕様は、その distribution の docs を正本にします。

Takosumi core の public concepts は AppSpec / Installation / Deployment です。
component kind の schema と material vocabulary は Takosumi official type
catalog が扱います。Cloud account-plane、dashboard、billing、identity、deploy
facade の具体仕様は `takosumi-cloud/docs/` 側に置きます。

## Takosumi 本体仕様

- [Specification Boundaries](./spec-boundaries.md) — Takosumi core、official
  type catalog、operator distribution の責務分離。
- [Takosumi Core Specification](./core-spec.md) — AppSpec / Installation /
  Deployment、Installer API、source/digest guard、publish/listen grammar。
- [AppSpec (`.takosumi.yml`)](./app-spec.md) — source root に置く declarative
  spec。root は `apiVersion` / `metadata` / `components`。
- [External publications](./external-publications.md) — AppSpec 外の publisher
  が offer する material を通常の `listen.from` から consume する model。
- [Installer API](./installer-api.md) — Installation / Deployment を作成・更新・
  rollback する 5 endpoint の public Installer API。
- [Plan Output](./plan-output.md) — dry-run response shape と expected guard。
- [Glossary](./glossary.md) — AppSpec / Installation / Deployment と隣接する
  用語の短い定義。

## Takosumi 公式型仕様

- [Takosumi Official Type Catalog Specification](./type-catalog.md) — Takosumi
  が公開する kind descriptor vocabulary、material contracts、projection
  families、JSON-LD catalog metadata。
- [Access Modes](./access-modes.md) — external publication material の access
  metadata vocabulary。

## Takosumi Cloud 入口

Takosumi Cloud は別の operator distribution 仕様です。この docs site
では入口だけ を持ち、規定本文は `takosumi-cloud/docs/` に置きます。

- [Takosumi Cloud distribution bridge](./takosumi-cloud.md) — Takosumi core /
  official catalog から別管理の Cloud docs へ進む入口。

## 作成補助 / 例

- [CLI](./cli.md) — Installer API を呼ぶ `takosumi` command surface。
- [HTTP Exposure](./http-exposure.md) — public app endpoint を workload
  publication + adopted gateway/ingress descriptor として表現し、runtime request
  path を確認する。

## Build service handoff

- [Build service handoff](./build-spec.md) — build service / CI が prepared
  source snapshot を作るための convention。
- [Digest computation](./digest-computation.md) — `manifestDigest`、prepared
  source digest、reference DataAsset extension digest の計算。

## 仕様メンテナンス

- [Spec Maintenance Map](./public-spec-source-map.md) — public contract と隣接
  operator reference の source of truth。

## Operate The Reference Kernel

Reference implementation operations for running the Takosumi kernel.

- [Environment Variables](./env-vars.md) — kernel / CLI / runtime-agent の env。

## Extend Provider Bindings

Provider and adapter docs for adding implementation bindings behind adopted kind
descriptors.

- [Provider Implementations](./providers.md) — provider implementation の
  attach、metadata、selection。
- [Provider package examples](./provider-packages.md) — reference provider
  package と provider metadata の例。
- [Reference Adapter Loading](./plugin-loading.md) — reference kernel の
  Vite-like provider attach model。
- [Connector Guide](./connector-contract.md) — runtime-agent connector の
  envelope と accepted DataAsset metadata。

## Internal Route / RPC Notes

Operator-internal HTTP and runtime-agent surfaces. AppSpec authors do not need
these pages.

- [Reference Runtime-Agent Execution Surface](./runtime-agent-api.md) —
  reference kernel から agent に送る operator-internal lifecycle RPC。
- [Reference Kernel Route Inventory](./kernel-http-api.md) — public installer
  API、internal API、 runtime-agent RPC の境界。

## DataAsset extension

operator distribution が DataAsset lifecycle を持つ場合の extension guide。

- [Operator DataAsset Extension](./data-asset-policy.md) — DataAsset access
  policy と lifecycle。
- [DataAsset GC](./data-asset-gc.md) — DataAsset retention と activation
  history。

## Reference Kernel Internal Notes

reference kernel の apply / rollback mechanics と operational state。
Installation / Deployment status enum は
[Installer API](./installer-api.md#entity-fields) に集約します。

- [Lifecycle Protocol](./lifecycle.md) — apply / rollback の 6 phase と recovery
  model。
- [Lifecycle Phases](./lifecycle-phases.md) — 各 phase の入出力と状態遷移。
- [WAL Stages](./wal-stages.md) — Write-Ahead Log の stage enum と遷移ルール。
- [GroupHead Rollout](./group-head-rollout.md) — traffic assignment pointer
  の更新ルール。
- [Readiness Probes](./readiness-probes.md) — kernel control plane readiness と
  `/readyz` response。
- [Status Output](./status-output.md) — Installation / Deployment の read
  projection semantics。reference kernel internal routes と public enum は
  [Installer API entity fields](./installer-api.md#entity-fields)。

## Storage / policy / observability

reference kernel / operator implementation の storage、policy、observability
material。

- [Storage Schema](./storage-schema.md) — kernel の SQL table 構造。
- [Audit Events](./audit-events.md) — audit log の event 種別と payload。
- [Enum and Value Index](./closed-enums.md) — public enum、reference enum、open
  operator value の索引。
- [Risk Taxonomy](./risk-taxonomy.md) — apply 時に検出される risk の分類。
- [Approval Invalidation](./approval-invalidation.md) — approval
  を無効化するトリガー。
- [Access Modes](./access-modes.md) — external publication の access mode enum。
- [RevokeDebt Model](./revoke-debt.md) — destroy 失敗時の debt
  記録と解消フロー。
- [Observation Retention](./observation-retention.md) — ObservationSet の
  retention policy。
- [Drift Detection](./drift-detection.md) — activate 後の runtime drift 検出。
- [Telemetry / Metrics](./telemetry-metrics.md) — metric 名と panel 設計。
- [Logging Conventions](./logging-conventions.md) — structured log の field
  規約。
- [Observability Stack](./observability-stack.md) — logs / metrics / traces
  の構成。

## Security / operation

reference kernel / operator implementation の security と operation material。

- [Secret Partitions](./secret-partitions.md) — secret の分離と暗号化境界。
- [Cross-Process Locks](./cross-process-locks.md) —複数 kernel instance
  の排他制御。
- [Supply Chain Trust](./supply-chain-trust.md) — implementation / provider
  の取得と検証。
- [Bootstrap Protocol](./bootstrap-protocol.md) — kernel 初回起動時の初期化。
- [Backup and Restore](./backup-restore.md) — backup 対象と restore 手順。
- [Migration / Upgrade](./migration-upgrade.md) — schema migration と version
  upgrade。
- [Workers Backend](./workers-backend.md) — Cloudflare Workers backend
  の実装詳細。

## Architecture notes

kernel contributor / operator implementation author 向けの内部設計メモです。
runtime request data plane は provider-native ingress が扱い、kernel installer
API process を request path に挟む前提ではありません。

- [内部設計の概要](./architecture/index.md)
- [Kernel](./architecture/kernel.md)
- [Control Plane](./architecture/control-plane.md)
- [Object Model](./architecture/object-model.md)
- [Snapshot Model](./architecture/snapshot-model.md)
- [Space Model](./architecture/space-model.md)
- [Deploy System](./architecture/deploy-system.md)
- [Link / Projection Model](./architecture/link-projection-model.md)
- [Execution Lifecycle](./architecture/execution-lifecycle.md)
- [Runtime Routing](./architecture/runtime-routing.md)
- [Runtime Deployment](./architecture/runtime-deployment-model.md)
- [API Surface](./architecture/api-surface-architecture.md)
- [Kind Resolution Model](./architecture/kind-resolution-model.md)
- [External Publication Model](./architecture/external-publication-model.md)
- [External Descriptor Registry](./architecture/external-descriptor-registry-model.md)
- [Operator Boundaries](./architecture/operator-boundaries.md)

## RFC / design record

- [RFC 0001 — Kernel kind-agnostic 化](../rfc/0001-kernel-kind-agnostic.md)

account / billing / OIDC are operator-distribution surfaces. Start from the
[Takosumi Cloud](./takosumi-cloud.md).
