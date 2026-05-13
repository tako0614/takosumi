# PaaS Provider Architecture

> このページでわかること: PaaS provider architecture の設計。

本ドキュメントは、Takosumi を "PaaS として" 提供する際に公開すべきアーキテクチャ
層の surface を定義する。deployment topology、multi-tenant 境界、trust chain、
operator 向け surface 集合、operator が Takosumi を tenant 持ちサービスとして
運用するために必要な観測可能 signal を記録する。

本書はアーキテクチャ層のみを扱う。wire-level の shape は reference ドキュメント
にある。

## PaaS deployment topology

v1 の対象 topology は 1 つ。他の行は誤って scope が広がらないように記録する
却下概念である。

```text
single-operator       one operator runs one Takosumi kernel and hosts N Spaces
multi-operator        not adopted; separate operators run separate installations
platform federation   not adopted; kernels do not exchange catalog releases or shares
```

Takosumi v1 は **single-operator + multi-Space tenant モデル** を狙う。
multi-operator sharing や platform federation は Takosumi プラットフォーム機能
ではなく、アーキテクチャ判断で前提にしてはならない。アプリケーション層の
federation がある場合、それはプラットフォーム層の外のアプリに属する。

## Multi-tenant 境界

`Space` が v1 の tenant 境界である。

```text
Space = tenant boundary baseline
```

operator は tenant マッピング方針を選ぶ。

```text
1 Space = 1 tenant      strict isolation per customer
N Space = 1 tenant      one tenant runs prod / staging / dev as separate Spaces
1 Space = N tenant      not supported in v1; tenants must not share a Space
```

`Space` より大きな tenant identity は operator 定義であり、kernel state の外側
に存在する。kernel は Space レベルの invariant のみを強制する。

## Tenant isolation invariant

Space レベルの invariant 集合が v1 の tenant 保証である。下表のすべての state
surface は Space scope である。

```text
namespace        namespace registry visibility is Space-scoped
secret           secret partition is Space-scoped
artifact         DataAsset visibility is Space-scoped
journal          OperationJournal entries belong to one Space
observation      ObservationSet, DriftIndex are Space-scoped
approval         Approval and PolicyDecision are Space-scoped
debt             RevokeDebt ownership is Space-scoped per the import side rule
activation       ActivationSnapshot and GroupHead are Space-local
```

Space 跨ぎ surface はデフォルトで拒否される。Space 跨ぎ export / share 語彙は
Space に許可された operator 所有 namespace export だけに依存しうる。

## Billing readiness surface

billing は外部にある。kernel は billing ロジックを実装しない。ただしアーキテ
クチャは、外部 billing system が内部 storage を scrape せずに attach できる
ように測定 hook を公開しなければならない。

アーキテクチャ層で必要な測定 surface は 3 つ。

```text
ActivationSnapshot history       per-Space activation events drive "what is running" usage
OperationJournal retention       per-Space apply / activate / destroy volume drives "operational" usage
ObservationSet cardinality       per-Space object / link / export count drives "footprint" usage
```

アーキテクチャ規則:

- 各 surface は `spaceId` 単位で query 可能。
- 各 surface は monotonic な event id を発行し、外部 collector が resume
  できる。
- kernel は billing-derived state を保持しない。raw signal のみ公開する。

## Supply chain trust

v1 supply chain trust は **TLS + digest pin + 1 signing domain (OIDC)** である。
kernel 自身は universal signing model を運用せず、各境界が必要最小の機構を使う。
canonical な chain of custody は [Supply Chain Trust](../supply-chain-trust.md)
を参照。下表は kernel が触れる step を要約する。

```text
CatalogRelease       operator-pinned sha256 digest (CATALOG_DIGEST), TLS fetch + digest verify
Connector            operator-installed, identified by operator config, kernel verifies registration via deploy token
Implementation       provider/runtime-agent contract, registration is operator-policy-gated (no kernel-side signing)
```

trust 規則:

- CatalogRelease trust は operator-pinned digest であり、publisher signing では
  ない。kernel は operator 設定から `CATALOG_DIGEST` を読み、fetch した catalog
  の sha256 が一致しなければ fail-closed する。
- kernel は v1 で operator 間の trust を federate せず、CatalogRelease trust も
  federate しない。
- trust state は `ResolutionSnapshot` に記録される。信頼できない artifact に
  対する resolution は Risk を surface し、黙って成功してはならない。
- kernel が内部で発行する唯一の署名付き runtime 境界は、runtime-agent への
  Ed25519 署名済み gateway manifest (kernel ↔ runtime-agent 認証) である。
  これは内部インフラで、public-facing な publisher signing domain ではない。

## Operator UX surface

operator 向け surface は 3 channel に分かれる。すべての operator アクションは
アーキテクチャ層で正確に 1 つに属する。

```text
CLI                  takosumi-cli for human / scripted operator workflows
internal API         kernel internal HTTP endpoints for automation
operator console     UI surface that consumes the internal API
```

surface 一覧:

| Surface                     | CLI      | internal API | operator console |
| --------------------------- | -------- | ------------ | ---------------- |
| Space CRUD                  | yes      | yes          | yes              |
| Catalog release assignment  | yes      | yes          | yes              |
| Approval issue / revoke     | optional | yes          | yes              |
| RevokeDebt resolution       | yes      | yes          | yes              |
| Runtime-agent enrollment    | yes      | yes          | optional         |
| Implementation registration | yes      | yes          | optional         |
| Connector registration      | yes      | yes          | optional         |

internal API が canonical surface である。CLI と operator console はその API の
client である。public deploy client は operator surface に直接アクセスしない。

## SLA 観測可能 surface

99.x% の可用性約束は operator のコミットメントであり、kernel の保証ではない。
kernel はそのような約束を監査可能にするための指標を公開する。

```text
apply latency                preview to OperationPlan accepted
activation latency           ActivationSnapshot prepared to GroupHead advanced
WAL replay time              kernel restart to journal-consistent steady state
drift detection latency      ObservationSet observedAt to DriftIndex emitted
RevokeDebt aging             RevokeDebt createdAt to status terminal transition
```

各指標は Space 単位かつ時間 bucket 化される。アーキテクチャ層では「アラーム
閾値」ではない。観測可能な surface である。閾値設定は operator policy。

## Disaster recovery 境界

backup 境界は recovery-critical と regenerable に分かれる。

```text
recovery-critical (must be backed up)
  Space registry
  CatalogRelease assignments
  ResolutionSnapshot, DesiredSnapshot
  OperationJournal
  Approval and PolicyDecision
  RevokeDebt
  ActivationSnapshot history
  secret-store partition references (not values)

regenerable (must not be relied on as authority)
  ObservationSet (re-observed)
  DriftIndex (recomputed)
  ExportMaterial cache (re-projected)
  generated objects whose source is intact
```

restore 規則: restore が整合するのは、recovery-critical backup が共通の journal
cut に揃っている場合のみ。regenerable surface は restore 後に observation から
再構築すべきで、backup から authority として復元してはならない。

## Tenant operation 向けの kernel 側 primitive

上記 surface (multi-tenant 境界、billing readiness、supply chain trust、operator
UX、SLA 観測可能性、災害復旧) は、tenant 持ちサービスのために kernel が公開する
ものを記述する。per-tenant primitive の詳細な根拠は 3 つの姉妹アーキテクチャ
ドキュメントに分割され、それぞれが 1 つの関心事に scope する。

- [Identity and Access Architecture](./identity-and-access-architecture.md) —
  なぜ Actor、Organization、Membership、RBAC、API key、auth provider が kernel
  primitive なのか。なぜ role enum は closed で provider binding は immutable
  なのか。
- [Tenant Lifecycle Architecture](./tenant-lifecycle-architecture.md) — なぜ
  provisioning は closed な 7 段 idempotent sequence なのか。trial Space は
  なぜ別 lifecycle なのか。export と 2-phase deletion が audit chain 整合性を
  どう保つか。
- [PaaS Operations Architecture](./paas-operations-architecture.md) — なぜ quota
  tier は operator 命名 / kernel 強制なのか。なぜ cost attribution は opaque
  メタデータなのか。なぜ SLA detection と incident は kernel 側なのか。 なぜ
  support impersonation は別の auth path なのか。なぜ notification は pull only
  なのか。

本書の surface と合わせて、これら 3 つは v1 PaaS operation の kernel 側 scope
を定義する。顧客サインアップ UI、決済フロー、ステータスページ、ブランド付き
notification、チケットシステム、SLA credit 公式、admin エスカレーション workflow
はこれらの primitive の上に組み立てられるが、Takosumi の外側 (典型 的には
`takos-private/` または別の operator 所有 distribution) に住む。

## クロスリファレンス

- [Operator Boundaries](./operator-boundaries.md)
- [Space Model](./space-model.md)
- [Identity and Access Architecture](./identity-and-access-architecture.md)
- [Tenant Lifecycle Architecture](./tenant-lifecycle-architecture.md)
- [PaaS Operations Architecture](./paas-operations-architecture.md)
- [Observation, Drift, and RevokeDebt Model](./observation-drift-revokedebt-model.md)
- [Operation Plan and Write-ahead Journal Model](./operation-plan-write-ahead-journal-model.md)
- [Operational Hardening Checklist](./operational-hardening-checklist.md)
- Reference: [CLI](../cli.md), [Kernel HTTP API](../kernel-http-api.md),
  [Lifecycle](../lifecycle.md)
