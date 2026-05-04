# Status Output

> Stability: stable
> Audience: operator
> See also: [CLI](/reference/cli), [Kernel HTTP API](/reference/kernel-http-api), [GroupHead and Rollout](/reference/group-head-rollout), [RevokeDebt Model](/reference/revoke-debt), [Drift Detection](/reference/drift-detection), [Quota / Rate Limit](/reference/quota-rate-limit), [Readiness Probes](/reference/readiness-probes), [Closed Enums](/reference/closed-enums)

`takosumi status` の出力 schema 正本。本 schema は public deploy surface
の `GET /v1/deployments` (一覧) および `GET /v1/deployments/:name` (単一
deployment) の response shape として返されます (詳細は
[Kernel HTTP API](/reference/kernel-http-api#get-v1deployments) 参照)。
Status query は **read-only** で、polling 安全 (rate limit のみ)。
Plan / apply の進行に side-effect を与えない。

Status output は 1 query につき 1 つの `StatusOutput` JSON document。
出力サイズは Space / filter によっては大きくなり得るため、deployment /
activation / pendingApprovals / revokeDebts は cursor pagination を持つ。

## Top-level shape

```yaml
StatusOutput:
  requestId: string                # "req:<ulid>"
  queriedAt: string                # RFC3339 UTC
  spaceId: string?                 # filter があれば single Space id
  deployments: DeploymentStatus[]
  activations: ActivationStatus[]
  pendingApprovals: PendingApproval[]
  revokeDebts: RevokeDebtSummary
  drift: DriftSummary
  quotaUsage: QuotaUsage
  health: KernelHealth
  pagination: PaginationCursors
```

`spaceId` は auth context から resolve された Space を反映する。Operator
権限で `--space *` を指定した場合のみ複数 Space をまたいだ出力が返る。

## DeploymentStatus

Deployment は manifest の `metadata.name` に対応する 1 つの top-level
record。

```yaml
DeploymentStatus:
  id: string                          # "deployment:<ulid>"
  spaceId: string                     # "space:<id>"
  name: string                        # metadata.name
  lifecycleClass: enum                # managed | generated | external | operator | imported
  currentDesiredGeneration: integer   # 単調増加
  latestActivationSnapshotId: string? # "snapshot:<ulid>"
  lastAppliedAt: string?              # RFC3339 UTC
  lastDestroyedAt: string?            # RFC3339 UTC
  inProgress:
    operationPlanDigest: string?      # 進行中 plan
    phase: enum?                      # apply | activate | destroy | rollback | recovery | observe
    walStage: enum?                   # 8 値
    startedAt: string?
    operatorBlocked: boolean          # approval 待ち / operator-fix 待ち
```

`lifecycleClass` は対象 deployment の primary 分類。1 つの deployment が
複数 class の object を抱えても、deployment 自身の class はその 5 値の
1 つに正規化される。

`inProgress` が `null` のとき deployment は steady state (apply 完了 or
destroyed)。`operatorBlocked = true` は対応 approval / fix を待っている
状態で、kernel は自律進行しない。

## ActivationStatus

Activation は GroupHead の rollout 単位ごとの観測値。

```yaml
ActivationStatus:
  id: string                       # "activation:<ulid>"
  deploymentId: string             # "deployment:<ulid>"
  groupHeadId: string              # "group-head:<id>"
  health: enum                     # 5 値
  sourceObservationDigest: string  # sha256:...
  observedAt: string               # RFC3339 UTC
  rolloutState: enum               # 7 値
  trafficShare: number             # 0.0 - 1.0
```

`health` は [Closed Enums — Health states](/reference/closed-enums#health-states):

```text
unknown | observing | healthy | degraded | unhealthy
```

`rolloutState` は [GroupHead and Rollout](/reference/group-head-rollout)
の 7 値:

```text
idle | preparing | canary-active | shadow-active
full-rollout | rolling-back | rolled-back
```

`sourceObservationDigest` は当該 activation の health 判定に使った
ObservationSet bytes に対する sha256。

## PendingApproval

Approval pipeline で operator action 待ちのもの。

```yaml
PendingApproval:
  bindingId: string             # "approval:<ulid>"
  spaceId: string
  deploymentId: string
  operationPlanDigest: string
  riskItemIds: string[]
  createdAt: string
  expiresAt: string?
```

Status output には `pending` 状態の approval だけが出る。`approved` /
`denied` / `consumed` 等の終端状態は含めない。終端含む全件は
`/api/internal/v1/approvals` で query する。

## RevokeDebtSummary

```yaml
RevokeDebtSummary:
  perSpace:
    - spaceId: string
      countByStatus:
        open: integer
        operator-action-required: integer
        cleared: integer
  operatorActionRequired:
    - debtId: string             # "revoke-debt:<ulid>"
      reason: enum               # 5 値: external-revoke | link-revoke | activation-rollback | approval-invalidated | cross-space-share-expired
      ageSeconds: integer
      subjectId: string
```

`countByStatus.cleared` は最近 cleared された件数の trailing window。
window 長は kernel config で operator 設定可能 (default 24h)。Rationale:
24 時間は daily on-call rotation handover の単位と整合し、前日に cleared
された debt を引き継ぎ時に確認しやすい。短いと cleared 件数が見えにくく
operator が clear を見落とし、長いと既に運用判断済の debt が status output
を膨らませる。

`operatorActionRequired[]` は escalation 済の id list。Operator が
個別対応する優先順位付けに使う。

## DriftSummary

```yaml
DriftSummary:
  driftIndexDigest: string       # sha256:...
  generatedAt: string
  entries:
    bySeverity:
      info: integer
      warning: integer
      error: integer
  sampleSubjects:
    - subjectId: string
      severity: enum
      kind: string                # drift kind
```

`sampleSubjects[]` は最大 32 件の代表 entry。完全な enumeration は
`/api/internal/v1/drift` を query する。

## QuotaUsage

```yaml
QuotaUsage:
  dimensions:
    - dimension: string           # "deployments-per-space" 等
      current: integer
      limit: integer
      windowSeconds: integer?     # rate-limit 系のみ
      saturationRatio: number     # current / limit
```

Dimension 名と limit の意味は
[Quota / Rate Limit](/reference/quota-rate-limit) で定義する。

## KernelHealth

```yaml
KernelHealth:
  ports:
    public: enum                  # ok | degraded | down
    internal: enum
    runtimeAgent: enum
    discovery: enum               # /readyz / /livez
  walReplayInProgress: boolean
  lockHolderCount: integer
  buildVersion: string
  schemaVersion: integer
```

`/readyz` の判定基準は
[Readiness Probes](/reference/readiness-probes) と整合する。

## PaginationCursors

```yaml
PaginationCursors:
  deployments:
    nextCursor: string?
    hasMore: boolean
  activations:
    nextCursor: string?
    hasMore: boolean
  pendingApprovals:
    nextCursor: string?
    hasMore: boolean
```

Cursor は opaque string。`?cursor=<value>` で次 page を取得する。Cursor
は最大 1 時間有効。expire 後は `failed_precondition` で reject される。

## Filter / pagination flags

CLI / HTTP の query flag:

| Flag           | 効果                                                    |
| -------------- | ------------------------------------------------------- |
| `--space`      | 単一 Space に絞る (operator 権限で `*` 指定可)           |
| `--group`      | 特定 GroupHead に紐付く activation のみ返す              |
| `--since`      | RFC3339; 当該時刻以降に observe / state change したもの  |
| `--kind`       | `deployments` / `activations` / `approvals` / `debts` のいずれかに output を絞る |
| `--cursor`     | pagination cursor                                       |
| `--limit`      | per-section の最大件数 (1..200, default 50)              |

`--kind` で section を絞ったときも top-level shape は維持され、対象外
section は空配列 / null になる。

## Read-only / polling 安全

Status query は次を保証する。

- WAL に書き込みを行わない
- approval / RevokeDebt / Drift の状態を変えない
- runtime-agent への lifecycle RPC を発行しない
- Quota counter は read-only に inspect される

これにより `/status` を CI / dashboard / alert system から短間隔で polling
しても plan / apply 進行に副作用を与えない。Rate limit のみが上限を与える
([Quota / Rate Limit](/reference/quota-rate-limit))。

## Related design notes

- `docs/design/observation-drift-revokedebt-model.md`
- `docs/design/snapshot-model.md`
- `docs/design/exposure-activation-model.md`
- `docs/design/policy-risk-approval-error-model.md`
- `docs/design/space-model.md`
