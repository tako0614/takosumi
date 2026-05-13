# Provider Implementation Contract

> このページでわかること: provider plugin の実装契約と必須メソッド。

本ページは、provider plugin の Implementation が runtime-agent 内で host される
ときに満たすべき **wire-level lifecycle contract** を定義する。
[Runtime-Agent API](/reference/runtime-agent-api) は kernel ↔ runtime-agent の
HTTP RPC envelope を、 [Connector Contract](/reference/connector-contract) は
`connector:<id>` の identity と accepted-kind vector
を扱う。本ページはその中間にある: Implementation が runtime-agent dispatcher
から受け取る request / response envelope、返さ なければならない closed status
enum、守るべき effect bound、実装すべき recovery / dry-materialization / verify
動作を規定する。

contract は wire 形のみを縛る。packaging は自由: Implementation は Deno module、
バイナリ、HTTP service、WASM module、コンテナイメージのいずれでも ship できる。
runtime-agent dispatcher が下記 operation envelope を呼び出しに realize できる
限り、Implementation は適合している。

## Operation request envelope

runtime-agent は次の envelope で Implementation を呼び出す。フィールド順は
normative。欠落フィールドは省略ではなく明示的 null とする。

```yaml
OperationRequest:
  spaceId: space:<name>
  operationId: operation:<ulid>
  operationAttempt: integer >= 1
  journalCursor: journal:<ulid>
  idempotencyKey: <opaque string>
  desiredGeneration: integer >= 1
  desiredSnapshotId: desired:<sha256>
  resolutionSnapshotId: resolution:<sha256>
  operationKind: <enum>
  inputRefs: [<id>, ...]
  preRecordedGeneratedObjectIds: [generated:..., ...]
  expectedExternalIdempotencyKeys: [<opaque string>, ...]
  approvedEffects: [<closed effect descriptor>, ...]
  recoveryMode: normal | continue | compensate | inspect
  walStage: prepare | pre-commit | commit | post-commit | observe | finalize | abort | skip
  deadline: <RFC 3339 timestamp>
```

Field semantics:

- `operationAttempt` increments on every retry of the same `operationId`. The
  Implementation must treat all attempts of the same `operationId` as the same
  logical operation.
- `journalCursor` is the WAL cursor at which this attempt was dispatched. It is
  informational; the Implementation does not write the WAL itself.
- `idempotencyKey` is derived from
  `(spaceId, operationPlanDigest, journalEntryId)` (see
  [WAL Stages — Idempotency key](/reference/wal-stages#idempotency-key)). The
  same key always implies the same expected effect digest.
- `desiredGeneration` is the monotonically increasing generation of the Space's
  DesiredSnapshot. Implementations use it to detect that a prior in-flight
  operation was superseded.
- `inputRefs` lists the resolved object / generated / link IDs the
  Implementation may read from.
- `preRecordedGeneratedObjectIds` lists
  `generated:<owner-kind>:<owner-id>/<reason>` IDs the kernel has already
  minted; the Implementation must use those exact IDs when it reports
  `generatedObjects[]`.
- `expectedExternalIdempotencyKeys` lists the external API idempotency keys the
  kernel expects the Implementation to forward to its connector.
- `approvedEffects` is the closed bound the apply pipeline obtained through
  approval. The Implementation must not exceed it.
- `recoveryMode` selects how the Implementation should treat partial prior state
  (see below).
- `walStage` is the stage on whose behalf this dispatch runs. The Implementation
  does not advance WAL stages itself.
- `deadline` is an absolute deadline, not a duration. The Implementation must
  abort and return `failed` with a `retryable` error before the deadline
  elapses.

現行 v1 ブリッジ: public deploy route は WAL stage を記録した後、対応する
operation tuple を `PlatformContext.operation` として provider 呼び出しに渡す。
runtime-agent backed の provider はそれを `LifecycleApplyRequest` /
`LifecycleDestroyRequest.idempotencyKey`、`operationRequest`、
`metadata.takosumiOperation` として forward する。`LifecycleCompensateRequest`
は connector-native の reverse effect 用にも公開され、connector が専用 operation
を実装しない場合は handle-keyed `destroy` への runtime-agent fallback を持つ。
v1 の `operationRequest` projection は WAL 座標、idempotency key、recovery
mode、 予想される外部 request token、現在の `walStage` を運ぶ。非空の
`approvedEffects` や pre-recorded な生成 object ID のような public route
がまだ導出しない フィールドは、明示的に空配列として送られる。

## Operation result envelope

Implementation は次の envelope を返す。Implementation が生成しないフィールドは
省略ではなく明示的な空配列とする。

```yaml
OperationResult:
  operationId: operation:<ulid>
  status: succeeded | failed | partial | requires-approval | compensation-required
  actualEffects: [<closed effect descriptor>, ...]
  generatedObjects: [{ id: generated:..., ... }, ...]
  secretRefs: [<secret partition handle>, ...]
  endpointRefs: [<endpoint descriptor>, ...]
  grantHandles: [<grant descriptor>, ...]
  observations: [<observation tuple>, ...]
  retryHint: { retryable: bool, after: <duration?>, reason?: <code> }
  compensationHint: { kind: <enum>, debt?: <descriptor> }
  errorCode: <LifecycleErrorBody code | DomainErrorCode | connector-extended:* | null>
  walStageAck: prepare | pre-commit | commit | post-commit | observe | finalize | abort | skip
```

Implementation は新規 identity prefix を発明しない。request で供給された ID
(`operationId`、`preRecordedGeneratedObjectIds`) を verbatim にエコーする。

## Operation status enum (5 values)

`status` field は closed な 5 値 enum。各値は apply pipeline が依存する厳密な
semantic 意味を持つ。

| Status                  | Meaning                                                                                                                          |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `succeeded`             | The operation completed and `actualEffects` is final.                                                                            |
| `failed`                | The operation could not proceed; the WAL stage transitions to `abort`.                                                           |
| `partial`               | Some effects materialized but more work is needed; the kernel may dispatch a follow-up attempt.                                  |
| `requires-approval`     | The Implementation discovered an effect that needs explicit approval; the apply pipeline pauses and surfaces a Risk.             |
| `compensation-required` | Prior partial state must be rolled back; the WAL stage transitions to `abort` and `compensationHint` drives compensate recovery. |

非終端 status は `partial` だけである。他の 4 つは現 attempt の終端であり、
apply pipeline は必要に応じて approval / compensation を再解決した後にのみ 新規
attempt を再スケジュールする。

## Recovery mode behaviour

`recoveryMode` は Implementation が事前状態についてどんな前提を置くべきかを
伝える closed 4 値 enum である。

- `normal`: no prior partial state exists; the Implementation acts as if this is
  a first attempt for the `idempotencyKey`.
- `continue`: a prior attempt for the same `idempotencyKey` made forward
  progress; the Implementation must finish it idempotently and return the same
  effect digest as the prior attempt would have.
- `compensate`: prior partial state must be rolled back; the Implementation must
  reverse `actualEffects` it has already reported under the same
  `idempotencyKey`. Effects that cannot be reversed surface as
  `compensation-required` with a populated `compensationHint.debt` so the kernel
  can enqueue a RevokeDebt entry.
- `inspect`: the Implementation must report observed external state without
  performing any mutating call. This mode is used by `actual-effects-overflow`
  triage and by recovery dry-runs.

`inspect` モードは現在の stage を超えて WAL を進めない。Implementation は観測
された外部状態を反映した `actualEffects` と、入力の `walStage` と等しい
`walStageAck` を持つ `succeeded` を返す。

## Effect bound rule

Implementation は次の厳密な invariant の下で動作する。

```text
actualEffects ⊆ approvedEffects
```

Implementation は外部 mutation を行う前に自身の intended effect 集合を計算し、
intended 集合が `approvedEffects` を逸脱するなら処理を拒否しなければならない。
外部の実状態が乖離して Implementation が `approvedEffects` 外の effect を生成
したと気付いた場合、次を行う必要がある。

1. Stop further mutation.
2. Return `status = failed` with `errorCode = actual-effects-overflow`.
3. Populate `actualEffects` with the full observed effect set, including the
   overflow.
4. Set `compensationHint.kind = overflow` so the apply pipeline can schedule
   compensate recovery.

`actual-effects-overflow` は closed な Risk である
([Risk Taxonomy — `actual-effects-overflow`](/reference/risk-taxonomy) 参照)。
kernel はこれに応じて `approvedEffects` を黙って広げることはない。

## Dry materialization phase

apply pipeline が approval を bind する前に、各 Implementation に actual effect
を予測させる。runtime-agent はこれを通常の `OperationRequest` として
次の制約付きで dispatch する。

- `walStage = prepare`.
- `recoveryMode = inspect`.
- The Implementation must not perform any external mutation.
- The Implementation populates `actualEffects` with its **predicted** effect
  set.

kernel は [digest 計算ルール](/reference/digest-computation) で予測集合を hash
し、結果を OperationPlan の `predictedActualEffectsDigest` として bind する。
以降の `commit` / `post-commit` attempt はその digest に bound される: 逸脱は
`actual-effects-overflow` を引き起こす。

Dry materialization は contract 上 side-effect free。決定的な予測を生成できない
Implementation は説明的な `errorCode` 付きで `status = requires-approval` を
返すこと。apply pipeline がそれを plan-level の Risk として surface する。

## Idempotency contract

単一の `idempotencyKey` について:

- The Implementation must produce the **same** `actualEffects` digest on every
  successful attempt. Returning a different digest under the same key is a
  hard-fail at the kernel; the apply pipeline rejects the result and refuses to
  advance the WAL.
- The Implementation must reuse `expectedExternalIdempotencyKeys` when
  forwarding mutations to its connector. Inventing new external keys defeats
  end-to-end idempotency.
- Retries for the same `idempotencyKey` carry incrementing `operationAttempt`
  values. The Implementation must not treat a higher attempt number as license
  to widen the effect set.

## Connector relationship

Implementation は外部 credential を保持しない。mutate する呼び出しは
[Connector Contract](/reference/connector-contract) に定義された operator が
インストールする Connector を経由する。

- The active `connector:<id>` for the Implementation is part of the resolved
  `inputRefs` set; the runtime-agent supplies the resolved Connector record
  (`acceptedKinds`, `signingExpectations`, `envelopeVersion`) but never the
  Connector's credentials.
- DataAsset delivery to the Connector follows
  [DataAsset Kinds — accepted-kind vector](/reference/artifact-kinds) and is
  bound by the Connector's `acceptedKinds` vector. An Implementation that asks
  the Connector to accept a kind outside that vector receives an
  `artifact_kind_mismatch` failure that surfaces as
  `errorCode = artifact_kind_mismatch` in the OperationResult.
- Implementations consume artifact bytes by hash through the runtime-agent's
  artifact partition; the deploy bearer never reaches the Implementation.

## Verify operation

`POST /v1/lifecycle/verify`
([Runtime-Agent API — `/v1/lifecycle/verify`](/reference/runtime-agent-api)
参照) は次の verify 形式 OperationRequest を dispatch する。

- `operationKind = verify-object`.
- `walStage = prepare` (verify never advances the WAL).
- `recoveryMode = inspect`.

Implementation は Connector に対する read-only な health チェックを行い、
次を返さなければならない。

- `status = succeeded` with empty `actualEffects` on a healthy probe.
- `status = failed` with `errorCode` set to a closed `LifecycleErrorBody` code
  on an unhealthy probe.

verify operation は WAL entry を生成せず、`approvedEffects` を広げず、
RevokeDebt も queue しない。

## Failure mode to journal entry mapping

各終端 status は固定 WAL 遷移にマップされる。

| Status                  | WAL effect                                             | Journal entry recorded                                                               |
| ----------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| `succeeded`             | Stage advances to `walStageAck`.                       | Effect digest persisted; observations appended.                                      |
| `failed`                | Stage transitions to `abort`.                          | `errorCode` persisted; `compensationHint` informs the abort plan.                    |
| `partial`               | Stage retains current value; attempt counter advances. | Partial effects persisted; next attempt resumes from the same WAL cursor.            |
| `requires-approval`     | Stage transitions to `skip` for this attempt.          | Approval re-validation Risk surfaces; the apply pipeline waits for a fresh approval. |
| `compensation-required` | Stage transitions to `abort`.                          | RevokeDebt enqueued via `compensationHint.debt`; compensate recovery scheduled.      |

Implementation が WAL を直接書くことはない。runtime-agent が OperationResult を
kernel に forward し、WAL ledger の唯一の書き手は kernel である。

## Packaging freedom

上記 contract は wire 形を縛り、実装言語や runtime を縛らない。適合する
Implementation は次のいずれでもよい。

- A Deno module loaded by the runtime-agent in-process.
- A standalone binary the runtime-agent invokes through a stable on-host
  transport (Unix domain socket, named pipe, stdio).
- A remote HTTP service the runtime-agent dispatches to over a trusted local
  network.
- A WASM module the runtime-agent instantiates per attempt.
- A container the runtime-agent runs through a host-local container runtime.

runtime-agent dispatcher が、各形式を OperationRequest / OperationResult
envelope に適合させる境界である。envelope、status enum、effect bound、
idempotency 規則が満たされている限り、Implementation は適合する。

## Related architecture notes

- docs/reference/architecture/paas-provider-architecture.md
- docs/reference/architecture/implementation-operation-envelope.md
- docs/reference/architecture/operation-plan-write-ahead-journal-model.md
- docs/reference/architecture/policy-risk-approval-error-model.md
- docs/reference/architecture/data-asset-model.md

## 関連ページ

- [Runtime-Agent API](/reference/runtime-agent-api)
- [Connector Contract](/reference/connector-contract)
- [WAL Stages](/reference/wal-stages)
- [Risk Taxonomy](/reference/risk-taxonomy)
- [Closed Enums](/reference/closed-enums)
