# Declarable Hooks

> **DEPRECATED — policy reversed.** This document records a kernel-side
> Declarable Hook extension point that was previously reserved for
> manifest-level hook bindings invoking workflow-style execution. The
> reservation has been **withdrawn**: the kernel ships no declarable-hook
> dispatch / store / route. Lifecycle hooks that operators want to attach to
> deployments are implemented above the kernel by `takosumi-git`, which can
> sequence build / notification / migration steps before or after a
> `POST /v1/deployments` call. Catalog-supplied internal pre/post-commit hooks
> at the WAL stage level remain unchanged. See
> [Workflow Placement Rationale](/reference/architecture/workflow-extension-design)
> for the current policy. This page is retained as historical design context and
> will be removed in a follow-up cleanup.

> Stability: deprecated Audience: historical reference

Takosumi v1 で以前 reserve されていた user / plugin layer 向け **Declarable
Hooks** extension contract の歴史的記録です。kernel は declarable hook の
declaration syntax / persistent store / dispatch route を **持たない** 方針に
変更されました。Catalog-supplied internal WAL hook は引き続き有効ですが、本 doc
が定義する operator-declared hook binding は kernel に実装されません。

## Overview

Catalog-supplied pre/post-commit hook ([WAL Stages](/reference/wal-stages))は
kernel-internal な extension で、 WAL stage 内部で発火する。Declarable hook は
user / plugin layer の extension であり、operator が manifest `resources[]` 上に
hook resource を declare し、 対象 deployment の lifecycle phase 通過に bind
する。

- hook は manifest `resources[]` で declare、対象 deployment / Object を
  `${ref:...}` で binding する
- hook 実装は plugin が shape として提供する (例: `pre-apply-hook@v1`)
- hook fire は kernel が [`execute-step`](/reference/execute-step-operation)
  operation を生成し、 WAL に追加する
- hook 実装 (migration runner / smoke test runner / notification poster 等) は
  plugin が shape として提供する。kernel は hook resource の declaration /
  dispatch / journal / failurePolicy enforcement のみを行う

## Hook resource declaration syntax

```yaml
- shape: pre-apply-hook@v1
  name: db-migration
  provider: "@some-org/migration-runner"
  spec:
    bindToDeployment: ${ref:my-deployment}
    bundle:
      kind: oci-image
      uri: ghcr.io/example/migrator@sha256:abcd...
    inputs:
      DATABASE_URL: ${ref:db.connectionString}
    hookOrder: pre-apply
    failurePolicy: abort | warn
    timeout: 300s
```

`bindToDeployment` は対象 deployment への参照、`bundle` は hook 実装の immutable
artifact ref、`inputs` は plugin shape が解釈する opaque map で kernel は shape
を validate しない。`hookOrder` / `failurePolicy` / `timeout` は kernel が
enforce する closed vocabulary。

## Hook lifecycle binding

[Lifecycle Phases](/reference/lifecycle-phases) の 6 値 (`apply` / `activate` /
`destroy` / `rollback` / `recovery` / `observe`) と組み合わせて発火 timing を
declare する。

`hookOrder` は v1 closed enum 3 値:

- `pre-X`: phase X 開始前に dispatch
- `post-X`: phase X 完了後に dispatch
- `side-X`: phase X と並走 (advisory、phase 結果に影響しない)

表記は `pre-apply` / `post-activate` / `side-observe` 等の組合せで、対応 phase
値 6 × order 3 = 18 通りの closed vocabulary を成す。1 deployment で 複数 hook
を declare 可能で、同 phase 内では declared 順に dispatch する。

## Hook 発火順序の disambiguation

- 同 phase / 同 hookOrder の hook が複数 declare されている場合: manifest
  `resources[]` 内の declared 順に dispatch する
- cross-deployment hook (異なる deployment に bind する hook) は target
  deployment の lifecycle phase 通過時に kernel が collect する
- `${ref:...}` 解決で hook 実装の bundle / inputs が確定した後に dispatch する
- `side-X` は phase 開始と同時に並走 dispatch、phase 完了を待たない

## Hook 失敗時の挙動

`failurePolicy` の closed v1 enum は `abort` / `warn`。

| order  | policy | 挙動                                                                           |
| ------ | ------ | ------------------------------------------------------------------------------ |
| pre-X  | abort  | 対象 phase 全体を abort、journal に `phase-aborted-by-hook` 記録               |
| pre-X  | warn   | warning として journal、phase 継続                                             |
| post-X | abort  | phase 結果は維持、overall deployment は failed 扱い、compensate 経路へ         |
| post-X | warn   | warning のみ、phase / deployment 結果に影響しない                              |
| side-X | abort  | phase 結果に影響しない (advisory) ため warning に降格、journal は failure 記録 |
| side-X | warn   | warning のみ                                                                   |

operator policy で failurePolicy default を override できる
([RBAC Policy](/reference/rbac-policy) 経由)。

## Hook 実装契約

hook plugin (例: `pre-apply-hook@v1` provider) は kernel から呼ばれて
[`execute-step`](/reference/execute-step-operation) operation の StepEnvelope
を返す責務を持つ。kernel が WAL に execute-step を追加し、runtime-agent で
実行する。

- hook plugin 自体に execution logic は不要、StepEnvelope (bundle ref / inputs /
  timeout) を返すだけ
- hook completion で StepResult を kernel が回収し、`failurePolicy` に 従って
  phase 進行を判定する
- hook step は通常の execute-step と同じ idempotency / replay semantics に 従う

## Hook record (HookBinding) schema

```yaml
HookBinding:
  id: hook-binding:<ulid>
  spaceId: space:...
  resourceRef: object:hook-binding/db-migration # resources[] 由来 Object
  hookOrder: pre-apply | post-apply | pre-activate | ...
  bindToDeploymentId: deployment:...
  bundleRef: dataasset:...
  failurePolicy: abort | warn
  timeout: duration
  createdAt: timestamp
```

`resourceRef` は manifest `resources[]` entry から resolve された Object
reference。`bundleRef` は immutable な [DataAsset](/reference/artifact-kinds)
ref で、cross-deployment hook でも 全 deployment が同 bundle
を見ることを保証する。

## Audit events

[Audit Events](/reference/audit-events) の closed enum に以下 3 値を追加:

- `hook-fired`: phase 通過時に hook が dispatch
- `hook-completed`: hook step が success
- `hook-failed`: hook step が failure (failurePolicy 依存で deployment へ
  伝播するか否かは payload 参照)

これらは既存 phase audit (`apply-completed` / `activate-completed` 等) と
並列発火する。`hook-fired` は phase 開始 audit と同 hash chain に書かれる。

## Approval / Risk integration

- hook bundle の digest 変化は
  [Approval Invalidation](/reference/approval-invalidation) trigger 1 (digest
  change) を発火し、approval を `invalidated` に落とす
- hook が touch する effect は既存 `approvedEffects` に集約される。`pre-X` hook
  の effect は phase X の `approvedEffects` に含まれ、effect-detail change
  (trigger 2) で再 approval 対象になる
- actual-effects-overflow ([Risk Taxonomy](/reference/risk-taxonomy)) は hook
  由来の effect でも同 enforcement が適用される

## Cross-deployment hook の semantics

hook が複数 deployment に bind する場合 (例: shared migration hook):

- 各 deployment の lifecycle phase 通過時に独立 dispatch する
- `bundleRef` が immutable なため、全 deployment が同一 bundle を見る
- 各 dispatch は独立した execute-step として WAL に append され、 idempotency
  tuple は `(spaceId, deploymentId, hookBindingId, phase, order)` で一意化される

## Catalog-supplied hook との関係

既存 catalog-supplied pre/post-commit hook ( [WAL Stages](/reference/wal-stages)
参照) は kernel-internal な extension で declarable hook より低 layer
に位置する。Declarable hook は user / plugin layer であり、両者は併存する。

dispatch 順序は **catalog hook → declarable hook** の順。WAL stage 内部 hook
が完了した後、対応 lifecycle phase の declared hook が dispatch される。

## Boundary

- kernel は hook resource の declaration / dispatch / journal / failurePolicy
  enforcement のみを担当する
- hook 実装 (migration runner / smoke test runner / notification poster 等) は
  plugin が shape として提供する
- 顧客向け hook 監視 UI / hook 実行 dashboard は takosumi の外側に置き、 audit
  event stream を consume して構築する

## Related design notes

- [`docs/reference/architecture/workflow-extension-design.md`](/reference/architecture/workflow-extension-design)
