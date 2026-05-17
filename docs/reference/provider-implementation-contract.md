# Provider Implementation Contract

> このページでわかること: provider Implementation が runtime-agent に対して守
> るべき wire-level lifecycle contract。

[Runtime-Agent API](/reference/runtime-agent-api) は kernel ↔ runtime-agent の
HTTP RPC envelope、 [Connector Contract](/reference/connector-contract) は
`connector:<id>` の identity / accepted-kind vector を扱います。 本ページは
その中間で、 Implementation が runtime-agent dispatcher から受け取る request /
response envelope、 返すべき closed status enum、 effect bound、 recovery /
dry-materialization / verify 動作を規定します。

contract は wire 形のみを縛り、 packaging は自由 (Deno module / バイナリ / HTTP
service / WASM / container いずれも可)。 dispatcher が下記 envelope を呼 出に
realize できる限り適合します。

## Operation request envelope

runtime-agent は次の envelope で Implementation を呼び出します。 field 順は
normative。 欠落 field は省略ではなく明示的 null とします。

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

> v1 bridge: public deploy route は WAL stage を記録後、 operation tuple を
> `PlatformContext.operation` として provider 呼出に渡します。 runtime-agent
> backed provider は `LifecycleApplyRequest` /
> `LifecycleDestroyRequest.idempotencyKey`、 `operationRequest`、
> `metadata.takosumiOperation` として forward。 `LifecycleCompensateRequest` は
> reverse effect 用で、 専用 operation 不在時は handle-keyed `destroy` に
> fallback。 v1 の `operationRequest` projection は WAL 座標 / idempotency key /
> recovery mode / 予想される外部 request token / `walStage` を運びます。 非空
> `approvedEffects` / pre-recorded 生成 object ID のような未導出 field
> は明示的に空配列として送られます。

## Operation result envelope

Implementation は次の envelope を返します。 生成しない field は省略ではなく
明示的な空配列とします。

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

Implementation は新規 identity prefix を発明しません。 request で供給された ID
(`operationId`、 `preRecordedGeneratedObjectIds`) を verbatim にエコーします。

## Operation status enum (5 values)

`status` は closed な 5 値 enum。 apply pipeline が依存する厳密な semantic を
持ちます。

| Status                  | Meaning                                                                                                                          |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `succeeded`             | The operation completed and `actualEffects` is final.                                                                            |
| `failed`                | The operation could not proceed; the WAL stage transitions to `abort`.                                                           |
| `partial`               | Some effects materialized but more work is needed; the kernel may dispatch a follow-up attempt.                                  |
| `requires-approval`     | The Implementation discovered an effect that needs explicit approval; the apply pipeline pauses and surfaces a Risk.             |
| `compensation-required` | Prior partial state must be rolled back; the WAL stage transitions to `abort` and `compensationHint` drives compensate recovery. |

非終端 status は `partial` のみ。 他 4 つは現 attempt の終端で、 apply pipeline
は必要に応じて approval / compensation を再解決した後にのみ新規 attempt
を再スケジュールします。

## Recovery mode behaviour

`recoveryMode` は事前状態についての前提を伝える closed 4 値 enum です。

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

`inspect` mode は現 stage を超えて WAL を進めません。 Implementation は観測
した外部状態を反映した `actualEffects` と、 入力の `walStage` と等しい
`walStageAck` を持つ `succeeded` を返します。

## Effect bound rule

Implementation は次の invariant で動作します。

```text
actualEffects ⊆ approvedEffects
```

Implementation は外部 mutation 前に intended effect 集合を計算し、
`approvedEffects` を逸脱するなら処理を拒否しなければなりません。 外部実状態の
乖離で `approvedEffects` 外の effect を生成したと気付いた場合は次を行います:

1. Stop further mutation.
2. Return `status = failed` with `errorCode = actual-effects-overflow`.
3. Populate `actualEffects` with the full observed effect set, including the
   overflow.
4. Set `compensationHint.kind = overflow` so the apply pipeline can schedule
   compensate recovery.

`actual-effects-overflow` は closed Risk
([Risk Taxonomy](/reference/risk-taxonomy) 参照)。 kernel はこれに応じて
`approvedEffects` を黙って広げません。

## Dry materialization phase

apply pipeline は approval bind 前に各 Implementation に actual effect を予測
させます。 runtime-agent は通常の `OperationRequest` を次の制約で dispatch:

- `walStage = prepare`.
- `recoveryMode = inspect`.
- The Implementation must not perform any external mutation.
- The Implementation populates `actualEffects` with its **predicted** effect
  set.

kernel は [digest 計算ルール](/reference/digest-computation) で予測集合を hash
し、 OperationPlan の `predictedActualEffectsDigest` として bind します。 以降
の `commit` / `post-commit` attempt はその digest に bound され、 逸脱は
`actual-effects-overflow` を引き起こします。

Dry materialization は contract 上 side-effect free。 決定的予測を生成できない
Implementation は説明的 `errorCode` 付き `status = requires-approval` を返し、
apply pipeline が plan-level Risk として surface します。

## Idempotency contract

単一 `idempotencyKey` について:

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

Implementation は外部 credential を保持しません。 mutate 呼出は
[Connector Contract](/reference/connector-contract) で定義された operator
install の Connector 経由で行います。

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

`POST /v1/lifecycle/verify` ([Runtime-Agent API](/reference/runtime-agent-api)
参照) は次の verify 形式 OperationRequest を dispatch:

- `operationKind = verify-object`.
- `walStage = prepare` (verify never advances the WAL).
- `recoveryMode = inspect`.

Implementation は Connector に対する read-only health check を行い、 次を返
します:

- 健全時: `status = succeeded` で `actualEffects` 空
- 不健全時: `status = failed` で `errorCode` を closed `LifecycleErrorBody` code
  に設定

verify は WAL entry を生成せず、 `approvedEffects` を広げず、 RevokeDebt も
queue しません。

## Failure mode to journal entry mapping

各終端 status は固定 WAL 遷移にマップされます。

| Status                  | WAL effect                                             | Journal entry recorded                                                               |
| ----------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| `succeeded`             | Stage advances to `walStageAck`.                       | Effect digest persisted; observations appended.                                      |
| `failed`                | Stage transitions to `abort`.                          | `errorCode` persisted; `compensationHint` informs the abort plan.                    |
| `partial`               | Stage retains current value; attempt counter advances. | Partial effects persisted; next attempt resumes from the same WAL cursor.            |
| `requires-approval`     | Stage transitions to `skip` for this attempt.          | Approval re-validation Risk surfaces; the apply pipeline waits for a fresh approval. |
| `compensation-required` | Stage transitions to `abort`.                          | RevokeDebt enqueued via `compensationHint.debt`; compensate recovery scheduled.      |

Implementation は WAL を直接書きません。 runtime-agent が OperationResult を
kernel に forward し、 WAL ledger の唯一の書き手は kernel です。

## Packaging freedom

上記 contract は wire 形のみを縛り、 実装言語 / runtime は縛りません。 適合
Implementation は次のいずれでも構いません:

- runtime-agent に in-process load される Deno module
- 安定した on-host transport (Unix domain socket / named pipe / stdio) で invoke
  される standalone binary
- trusted local network 越しに dispatch される remote HTTP service
- per-attempt instantiate される WASM module
- host-local container runtime で起動される container

runtime-agent dispatcher が各形式を envelope に適合させる境界です。 envelope /
status enum / effect bound / idempotency 規則を満たす限り適合します。

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
