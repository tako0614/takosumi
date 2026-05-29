# Known gaps — reference kernel deploy pipeline

::: info
内部実装メモ。public contract は [Installer API](./installer-api.md) を参照。
ここに列挙するのは reference kernel (`packages/kernel`) の deploy / apply
pipeline で「仕様・docstring 上は存在するが production caller に未配線」あるいは
「意図的に粗い」挙動です。各項目は honest な現状記録であり、解消するまで上位 docs
が durability / diff / per-resource recovery を約束しすぎないようにするための正本です。
:::

## 1. apply pipeline が 3 経路に分岐し、`applyV2` は production 未到達

reference kernel には 3 つの apply 経路があります:

1. **InstallerPipeline** (`domains/installer/mod.ts`) — public Installer API の
   実体。rollback は GroupHead pointer move のみで、apply 途中失敗時の provider
   compensation は無い。
2. **`createDeploymentApplyFacade`** (`app_context.ts`) — default
   `DeploymentService` apply facade。graph-projection / GroupHead-pointer 経路
   (`apply_phase` / `apply_orchestrator`) を通り、`applyV2` には dispatch しない。
3. **`applyV2`** (`domains/deploy/apply_v2.ts`) — `ApplyService.applyManifest`
   で `resources[]` manifest を渡したときだけ到達。provider compensate/destroy
   rollback・fingerprint idempotency・replace-on-mismatch・WAL を実装。

結果として `applyV2` の robust な rollback / idempotency / WAL は **どの
production caller も実行していない**。`applyV2` は convergence target かつ
unit-test 済なので削除せず保持しているが、ここのコードが production で走ると仮定
しないこと。converge するまで本ファイルが正本のステータス記録。

## 2. Operation journal (WAL) が production apply facade に未配線

`bootstrap.ts` は `resolveOperationJournalStore` で store (SqlClient 構成時は
`SqlOperationJournalStore`、それ以外は in-memory) を resolve するが、その store を
production apply 経路に渡していない (`void operationJournalStore`)。WAL は
`operationJournalStore` と non-dry-run `operationPlanPreview` の両方が揃ったとき
だけ発火するが、default facade は `applyV2` を通らず non-dry-run preview を作らない。
よって `prepare`/`commit` WAL records、commit-before-prepare guard
(`assertPrepareJournaled`)、effect-digest replay guard、`SqlOperationJournalStore`
は production で到達不能。facade を `applyV2` 上に converge するか、store を
`ApplyService` に thread するまで durable crash-recovery は約束しないこと。

## 3. WAL commit stage が per-loop で粗い

`applyV2` の WAL は loop 全体の成功後に `commit` を **一度だけ** append し、
per-operation の `pre-commit` / `post-commit` / `observe` / `finalize`
([wal-stages.md](./wal-stages.md) と `OperationPlanPreview.walStages` が広告する
stage) は書かない。provider.apply を数件実行した後・bulk commit append の前に
crash すると、実際には materialize 済の resource が WAL 上 `prepare` のみとなり、
replay が per-resource で「applied / not applied」を区別できない。per-operation
commit を書くか、未使用の fine-grained walStages を preview から落とすのが解消策。
(項目 1/2 と同じく現状 production 未到達経路。)

## 4. dry-run plan が create-only (observed-state diff 無し)

`applyV2` の dry-run と installer の `computeFreshInstallChangeSet` は全 resource を
`op: "create"` として列挙し、observed/prior state との diff を取らない。無変更の
Installation を再 apply しても dry-run は全 resource を `create` と表示し、
`update` / `no-op` / `delete` 分類を surface しない。`PlannedResource.op` に
`"update"` / `"no-op"` member を足すには observed-state probe が必要で、probe 無しに
member だけ足すと WAL apply-context filter (`op === "create"`) が resource を
silently drop してしまうため、現状は create-only を維持。詳細は
[plan-output.md](./plan-output.md)。

## 5. `applyV2` idempotency / replace-on-mismatch が `priorApplied` 待ち

fingerprint-based idempotent skip と destroyPriorSnapshot replace-on-mismatch は
caller が `priorApplied` snapshot を渡したときだけ動くが、`DeploymentStore` に
prior-apply snapshot を永続化する layer がまだ無いため、production caller は誰も
渡していない。よって毎 apply が provider.apply を再実行し、leak-prevention destroy
は走らない。snapshot 永続化 (specFingerprint / handle / outputs / providerId) を
`DeploymentStore` に追加して apply 前に load するのが解消策。logic 自体は applyV2
layer で unit-test 済。

## Fail-closed になっている関連挙動 (gap ではない)

以下は本 wave で fail-closed に修正済の項目。gap ではなく invariant として記録:

- **Synthetic provider adapter**: `DeploymentService` は `environment` が
  `production` / `staging` のとき、`providerAdapter` 未配線なら construction で
  hard-fail する。`SYNTHETIC_PROVIDER_ADAPTER` (apply/rollback を no-op success)
  への fallback は dev/test のみで、その outcome も reason `"Synthetic"` で stamp
  される。production で provider work 0 のまま `ActivationCommitted` success が
  記録されることはない。
- **Rollback preflight validators**: production / staging で store も caller も
  rollback validator を供給しない場合、`STRICT_ROLLBACK_VALIDATORS` (fail-closed,
  `ok=false`) が選ばれ rollback を **拒否** する。drift / availability / digest を
  live snapshot 無しで verify できないとき silently pass しない。dev/test は
  `DEFAULT_ROLLBACK_VALIDATORS` (fail-open, reason stamp 付き) で local rollback を
  妨げない。
