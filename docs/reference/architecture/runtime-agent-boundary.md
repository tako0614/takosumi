# Runtime-Agent 境界 {#implementation-and-runtime-agent-boundary}

::: info
内部設計メモ public contract は [Installer API](../installer-api.md) を参照。
:::

本ドキュメントは Takosumi reference implementation における operator-internal な Takosumi / runtime-agent 境界と、両者が交換する operation envelope を記録する。 runtime-agent は operator execution surface です。wire-level の field 表は [Reference Runtime-Agent Execution Surface](../runtime-agent-api.md) と [Lifecycle Protocol](../lifecycle.md) にある。本ページはアーキテクチャ意図を記録する—各側が何を担当し、trust chain がどこで切れ、どの invariant が分割を強制するか。

## 境界の宣言

Takosumi core/control-plane role は state を orchestrate する。Space、 ResolvedPlan、TargetState、 OperationPlan、Write-Ahead Journal、policy evaluation evidence、operator の approval 設定から渡された approval evidence、 CleanupBacklog を管理する。approval decision と account layer policy state は operator の設定が決める。Takosumi core は cloud / OS credential を保持せず、resource を materialize する side-effecting な外部 I/O も実行しない。

runtime-agent は実行を担当する。connector code を host し、自身が動いている host 環境の cloud SDK / OS API credential を保持し、すべての外部 I/O を実行し、観測された state を `describe` で Takosumi に返す。runtime-agent は credential を正当に持つ host 上で動作する—典型的には operator の deploy account 上で動くため、credential の blast radius は runtime-agent host に閉じ、Takosumi には及ばない。

この分割は構造的な境界です。cloud SDK、docker socket、systemd unit に触れるものは runtime-agent の connector に存在し、そのような操作が許されるかどうかを判断するものは Takosumi に存在する。

## Packaging の自由度

reference Takosumi runtime-agent topology では、Takosumi と runtime-agent の間で lifecycle / connectors RPC surface と operation envelope を使います。 packaging は operator が選びます。connector 実装は Deno バイナリ、in-process module、HTTP service、WASM module、コンテナ、SaaS をラップする外部 gateway、 operator-private daemon のいずれでもよい。operator は自身の credential 境界と fleet topology を選ぶ。同一 binary / host に co-locate する場合も、credential を持つ execution role は Takosumi core/control-plane role から分けて扱う。production 推奨 topology は runtime-agent 分離で、embedded execution は dev、credential-free minimal profile、または operator が明示的に管理する単一 host profile に限定する。 operator は自身のセキュリティ要件に合った packaging を選ぶ。

compatible implementation は別の execution boundary を使えます。守る public contract は manifest と Installer API、そして Installation / Deployment の observable lifecycle です。

## Operation envelope

Takosumi は OperationPlan の materializing step ごとに OperationRequest を runtime-agent に送る。

```yaml
OperationRequest:
  spaceId: space_acme_prod
  operationId: operation:...
  operationAttempt: 2
  journalCursor: journal:...
  idempotencyKey: ...
  desiredGeneration: 7
  desiredSnapshotId: desired:...
  resolutionSnapshotId: res_...
  operationKind: materialize-link
  inputRefs: []
  preRecordedGeneratedObjectIds: []
  expectedExternalIdempotencyKeys: []
  approvedEffects: {}
  recoveryMode: normal | continue | compensate | inspect
```

Field の責務:

- `spaceId` —隔離キー。runtime-agent は外部呼び出し、生成 object、secret をすべてこの Space に scope する。
- `operationId` / `operationAttempt` / `journalCursor` — WAL 座標。同じ三組の replay は idempotent でなければならない。
- `idempotencyKey` — Takosumi が導出する `(spaceId, operationPlanDigest, journalEntryId)` 三組を connector の idempotency 空間に projection したもの。
- `desiredGeneration` / `desiredSnapshotId` / `resolutionSnapshotId` — Takosumi が commit した snapshot。runtime-agent は手渡されていない snapshot を読んではならない。
- `operationKind` — connector の lifecycle operation を選ぶ。
- `inputRefs` / `preRecordedGeneratedObjectIds` / `expectedExternalIdempotencyKeys` — Takosumi 側の事前確保。retry で生成 object が重複しないようにする。
- `approvedEffects` —この operation の policy 上限。
- `recoveryMode` —後述の Recovery mode を参照。

## Operation result

runtime-agent は OperationResult を返す。

```yaml
OperationResult:
  operationId: operation:...
  status: succeeded | failed | partial | requires-approval | compensation-required
  actualEffects: {}
  generatedObjects: []
  secretRefs: []
  endpointRefs: []
  authorizationRefs: []
  observations: []
  retryHint: {}
  compensationHint: {}
  errorCode: optional
```

Status enum の責務 (closed、5 値):

- `succeeded` —承認済み effect がすべて適用された。Takosumi は WAL を `commit` まで進め、`actualEffects` を operation evidence / observation record として Deployment に紐付ける。`ResolvedPlan` は immutable のまま変更しない。
- `failed` —観測可能な side effect は発生しなかった。同じ idempotency key で安全に retry できる。`errorCode` は必須。
- `partial` —一部の effect が landed し、残りはしなかった。Takosumi は partial 集合を journal に記録し、別の `commit` 試行で reconcile できなければ CleanupBacklog を open する。
- `requires-approval` — dry materialization が `approvedEffects` を超える effect を予測した。reference Takosumi は `pre-commit` の先に進まず、予測 digest と共に operator の approval 設定へ route する。
- `compensation-required` — runtime-agent が forward progress が unsafe な state を観測した。Takosumi はこの operation と commit 済みの下流 operation に対して `compensate` を実行しなければならない。

## Effect rule

`actualEffects` は `approvedEffects` を超えてはならない。WAL の `pre-commit` stage では runtime-agent の dry / predicted effect 集合を `approvedEffects` と比較し、`commit` への遷移を許可するか判断する (= バリデーション)。`actualEffects` は `commit` / `post-commit` で観測・記録される。actual が承認範囲を超えた場合は `actual-effects-overflow` risk として journal に記録し、pause / compensate / debt handling に進める。`approvedEffects` 内に収まらない connector は、dry materialization 中に `requires-approval` を返さなければならず、commit して overflow させてはならない。

## Dry materialization

side-effecting な operation は、commit せずに effect 集合を予測する dry phase を公開する: 生成 object、authorization、credential、secret projection、endpoint、 network 変更、traffic 変更。Takosumi は予測を `expectedEffectsDigest` に hash し、その digest を発行された Approval に bind する。

Approval が replay されたとき、Takosumi は dry materialization を再実行し、新しい digest を bind 済みのものと比較する。不一致は番号付き Approval invalidation trigger の 1 つであり、新しい Approval round を強制する。既存の Approval は異なる予測 effect 集合に対して consume できない。これにより、Takosumi 再起動を跨いでも、approval 発行と apply の間の operator clock drift があっても、 Approval semantics が意味を保つ。

## Recovery mode

`recoveryMode` は envelope に載る closed な 4 値 enum で、runtime-agent に Takosumi が再起動や前回試行の失敗の後にどんな姿勢を取っているかを伝える。

- `normal` — default の forward apply。WAL stage が次のステップを clean に特定できる場合に使う。
- `continue` —前回の `commit` 試行が外部 side effect を leak した可能性がある。同じ idempotency key で `commit` を完了させる。
- `compensate` —以前 commit された effect を逆操作で巻き戻す。該当時には `activation-rollback` 理由で CleanupBacklog を open する。
- `inspect` — effect を適用せず WAL と live state の diff を出力する。

Takosumi は WAL の証拠—最後に記録された stage、partial effect の有無、recovery 中の operator override —から mode を選ぶ。runtime-agent は mode を選ばず、 Takosumi が渡したものを実行する。connector の既知 state と `recoveryMode` が矛盾するリクエストは reject する。operator 向けの選択ガイダンスは [Lifecycle Protocol — Recovery modes](../lifecycle.md#recovery-modes) に固定されている。

## Idempotency contract

`(spaceId, operationPlanDigest, journalEntryId)` の 3 つ組は Takosumi 側で `prepare` 時に生成され、canonical idempotency key となる。同じ 3 つ組を 2 回受け取った runtime-agent は同じ effect 集合を返さなければならない: 同じ生成 object ID、同じ handle、同じ secret ref。connector はこの 3 つ組を backend の idempotency 機構 (cloud-native idempotency token、決定的 resource name、 connector 側の dedupe ledger) に projection することでこれを実現する。 v1 connector はこの決定性を満たす。

## Connector と implementation

`connector:<id>` と `(shape, provider)` は runtime-agent 内で別 role です。 `connector:<id>` は operator inventory identity であり、install / replace / revoke の対象になる。lifecycle RPC の dispatch key は `(shape, provider)` で、 connector module はその pair の asset / handle shape と lifecycle operation を公開する。implementation は connector の上で OperationPlan の step を実行する operation-level のロジックである。両 role とも同じ runtime-agent プロセスに host されるが、責務は混ざらない: connector lifecycle は永続的で handle-key 付きの object であり、implementation は connector を借りて下層 SDK を駆動する per-operation の実行である。

## Verify semantics

reference runtime-agent の `verify` request は登録済み connector に対する credential / reachability の smoke test である。WAL を進めず、Snapshot を materialize せず、`LifecycleStatus` を変えない。`describe` は「この handle の live state は何か」に答え、`verify` は「この connector は backend に到達できるか」に答える。 health は `LifecycleVerifyResult.ok` をもとに Takosumi / operator UI で判定され、runtime-agent は報告するだけである。意図される配置は pre-flight、 `apply` の前であり、`connector_not_found` や `connector-extended:*` の失敗が WAL stage に触れる前に surface するようにする。

## Runtime-agent auth chain

Takosumi → runtime-agent 方向の認証方式は operator の設定の internal runtime auth です。kind package は通常の operator import として読み込まれ、 runtime-agent の host 権限は enrollment / heartbeat / lease material に bind された `(shape, provider)` ペアで表す。runtime-agent はその material に基づいて lifecycle request を受けます。

runtime-agent → Takosumi 方向は別の auth path である: enrollment token が identity を確立し、heartbeat / lease token で runtime-agent を attach し続け、agent bearer (`TAKOSUMI_AGENT_TOKEN`) が lifecycle / connectors RPC を保護する。両方向は鍵素材を分け、blast radius を片側の auth path に閉じる。

## Space 隔離

`spaceId` はすべての envelope とすべての lifecycle request に届く。 implementation と connector は、operation 入力が explicit cross-Space publication share でない限り、別 Space の object、secret、asset、authorization material、platform service を読み書きしてはならない。current v1 にはそのような cross-Space publication input はない。Space 越えのアクセスは contract 違反であり、`actual-effects-overflow` risk に closed される。

## Failure mode

- **Partial failure.** runtime-agent が承認済み effect の一部を commit したが全部ではなかった。status は `partial` となり、Takosumi はどの effect が landed したかを journal し、同じ idempotency key で欠けている subset を retry するか、 leak した subset に対して CleanupBacklog を open する。
- **Compensation.** runtime-agent が `compensation-required` を返すか、 `recoveryMode: compensate` が有効である。Takosumi は記録済み effect に対して connector の compensate operation を実行し、`activation-rollback` 理由で CleanupBacklog を emit する。
- **Debt.** effect が適用されたが desired state と reconcile できないとき (overflow、partial、完全 reverse なしの compensate) — Takosumi は CleanupBacklog entry を open する。debt の status enum と reason enum は closed である。解決には、compensate の成功、operator による手動 close-out、または landing 済み effect を明示的に認める新しい approval / debt-clearance record が必要である。 historical `approvedEffects` は遡って変更しない。Debt は Takosumi が「何が approved か」と「何が実在するか」を矛盾を黙って drop せずに sync 状態に保つための v1 機構である。

## クロスリファレンス {#cross-references}

- [Reference Runtime-Agent Execution Surface](../runtime-agent-api.md)
- [Lifecycle Protocol](../lifecycle.md)
- [Execution Lifecycle](./execution-lifecycle.md)
- [Operation Plan & Write-Ahead Journal](./runtime-deployment-model.md#operation-plan--write-ahead-journal)
