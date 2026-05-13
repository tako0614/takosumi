# Implementation and Runtime-Agent Boundary

> このページでわかること: implementation と runtime-agent の境界設計。

本ドキュメントは Takosumi kernel と runtime-agent プロセスの v1 境界、および両者
が交換する operation envelope を固定する。wire-level の field 表は
[Runtime-Agent API](/reference/runtime-agent-api) と
[Lifecycle Protocol](/reference/lifecycle) にある。本ページはアーキテクチャ意図
を記録する — 各側が何を所有し、trust chain がどこで切れ、どの invariant が分割
を強制するか。

## 境界の宣言

kernel は state を orchestrate
する。Space、ResolutionSnapshot、DesiredSnapshot、 OperationPlan、Write-Ahead
Journal、policy 評価、Approval 簿記、RevokeDebt を 所有する。kernel プロセスは
cloud / OS credential を保持してはならず、resource を materialize する
side-effecting な外部 I/O も行ってはならない。

runtime-agent は実行を所有する。connector code を host し、自身が動いている host
環境の cloud SDK / OS API credential を保持し、すべての外部 I/O を実行し、
観測された state を `describe` で kernel に返す。runtime-agent は credential を
正当に所有する host 上で動作する — 典型的には operator の deploy account 上で動
くため、credential の blast radius は runtime-agent host に閉じ、kernel には及
ばない。

この分割は構造的なものであり、助言的なものではない。cloud SDK、docker socket、
systemd unit に触れるものはすべて runtime-agent の connector に存在し、そのよう
な操作が許されるかどうかを判断するものは kernel に存在する。

## Packaging の自由度

runtime-agent は固定 protocol で定義され、固定 packaging では定義されない。
connector 実装は Deno バイナリ、in-process module、HTTP service、WASM module、
コンテナ、SaaS をラップする外部 gateway、operator-private daemon のいずれでも
よい。lifecycle / connectors RPC surface と operation envelope の shape だけが
固定されている。operator は自身の credential 境界と fleet topology に合った
packaging を選ぶ。

## Operation envelope

kernel は OperationPlan の materializing step ごとに OperationRequest を
runtime-agent に送る。

```yaml
OperationRequest:
  spaceId: space:acme-prod
  operationId: operation:...
  operationAttempt: 2
  journalCursor: journal:...
  idempotencyKey: ...
  desiredGeneration: 7
  desiredSnapshotId: desired:...
  resolutionSnapshotId: resolution:...
  operationKind: materialize-link
  inputRefs: []
  preRecordedGeneratedObjectIds: []
  expectedExternalIdempotencyKeys: []
  approvedEffects: {}
  recoveryMode: normal | continue | compensate | inspect
```

Field の責務:

- `spaceId` — 隔離キー。runtime-agent は外部呼び出し、生成 object、secret を
  すべてこの Space に scope する。
- `operationId` / `operationAttempt` / `journalCursor` — WAL 座標。同じ三組の
  replay は idempotent でなければならない。
- `idempotencyKey` — kernel が導出する
  `(spaceId, operationPlanDigest, journalEntryId)` 三組を connector の
  idempotency 空間に projection したもの。
- `desiredGeneration` / `desiredSnapshotId` / `resolutionSnapshotId` — kernel が
  commit した snapshot。runtime-agent は手渡されていない snapshot を読んで
  はならない。
- `operationKind` — connector の lifecycle operation を選ぶ。
- `inputRefs` / `preRecordedGeneratedObjectIds` /
  `expectedExternalIdempotencyKeys` — kernel 側の事前確保。retry で生成 object
  が重複しないようにする。
- `approvedEffects` — この operation の policy 上限。
- `recoveryMode` — 後述の Recovery mode を参照。

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
  grantHandles: []
  observations: []
  retryHint: {}
  compensationHint: {}
  errorCode: optional
```

Status enum の責務 (closed、6 値):

- `succeeded` — 承認済み effect がすべて適用された。kernel は WAL を `commit`
  まで進め、`actualEffects` を ResolutionSnapshot に projection する。
- `failed` — 観測可能な side effect は発生しなかった。同じ idempotency key で
  安全に retry できる。`errorCode` は必須。
- `partial` — 一部の effect が landed し、残りはしなかった。kernel は partial
  集合を journal に記録し、別の `commit` 試行で reconcile できなければ
  RevokeDebt を open する。
- `requires-approval` — dry materialization が `approvedEffects` を超える effect
  を予測した。kernel は `pre-commit` の先に進まず、予測 digest と共に Approval
  へ route する。
- `compensation-required` — runtime-agent が forward progress が unsafe な state
  を観測した。kernel はこの operation と commit 済みの下流 operation に対して
  `compensate` を実行しなければならない。

## Effect rule

`actualEffects` は `approvedEffects` を超えてはならない。WAL の `pre-commit`
stage が enforcement point である: kernel は runtime-agent の予測 (または
just-applied) effect 集合を `approvedEffects` と比較し、`commit` への遷移を
許可するかどうか判断する。不一致は `actual-effects-overflow` risk として記録
され、operation を abort する。`approvedEffects` 内に収まらない connector は、
dry materialization 中に `requires-approval` を返さなければならず、commit して
overflow させてはならない。

## Dry materialization

side-effecting な operation は、commit せずに effect 集合を予測する dry phase
を公開する: 生成 object、grant、credential、secret projection、endpoint、
network 変更、traffic 変更。kernel は予測を `predictedActualEffectsDigest` に
hash し、その digest を発行された Approval に bind する。

Approval が replay されたとき、kernel は dry materialization を再実行し、新しい
digest を bind 済みのものと比較する。不一致は番号付き Approval invalidation
trigger の 1 つであり、新しい Approval round を強制する。既存の Approval は
異なる予測 effect 集合に対して consume できない。これにより、kernel 再起動を
跨いでも、approval 発行と apply の間の operator clock drift があっても、
Approval semantics が意味を保つ。

## Recovery mode

`recoveryMode` は envelope に載る closed な 4 値 enum で、runtime-agent に
kernel が再起動や前回試行の失敗の後にどんな姿勢を取っているかを伝える。

- `normal` — default の forward apply。WAL stage が次のステップを clean に特定
  できる場合に使う。
- `continue` — 前回の `commit` 試行が外部 side effect を leak した可能性がある。
  同じ idempotency key で `commit` を完了させる。
- `compensate` — 以前 commit された effect を逆操作で巻き戻す。該当時には
  `activation-rollback` 理由で RevokeDebt を open する。
- `inspect` — effect を適用せず WAL と live state の diff を出力する。

kernel は WAL の証拠 — 最後に記録された stage、partial effect の有無、recovery
中の operator override — から mode を選ぶ。runtime-agent は mode を選ばず、
kernel が渡したものを実行する。connector の既知 state と `recoveryMode` が
矛盾するリクエストは reject する。operator 向けの選択ガイダンスは
[Lifecycle Protocol — Recovery modes](/reference/lifecycle#recovery-modes)
に固定されている。

## Idempotency contract

`(spaceId, operationPlanDigest, journalEntryId)` の 3 つ組は kernel 側で
`prepare` 時に生成され、canonical idempotency key となる。同じ 3 つ組を 2 回
受け取った runtime-agent は同じ effect 集合を返さなければならない: 同じ生成
object ID、同じ handle、同じ secret ref。connector はこの 3 つ組を backend の
idempotency 機構 (cloud-native idempotency token、決定的 resource name、
connector 側の dedupe ledger) に projection することでこれを実現する。
非決定的な connector は v1 準拠ではない。

## Connector と implementation

`connector:<id>` と `implementation` は runtime-agent 内で重ねられた role
である。 `connector:<id>` は operator がインストールする adapter で、ある
`(shape, provider)` ペアの DataAsset / handle shape を定義し、lifecycle
operation を公開する。implementation は connector の上で OperationPlan の step
を実行する operation-level のロジックである。両 role とも同じ runtime-agent
プロセスに host されるが、責務は混ざらない: connector lifecycle は永続的で
handle-key 付きの object であり、implementation は connector を借りて下層 SDK
を駆動する per-operation の実行である。

## Verify semantics

`POST /v1/lifecycle/verify` は登録済み connector に対する credential /
reachability の smoke test である。WAL を進めず、Snapshot を materialize せず、
`LifecycleStatus` を変えない。`describe` は「この handle の live state は何か」
に答え、`verify` は「この connector は backend に到達できるか」に答える。 health
は `LifecycleVerifyResult.ok` をもとに kernel / operator dashboard で
判定され、runtime-agent は報告するだけである。意図される配置は pre-flight、
`apply` の前であり、`connector_not_found` や `connector-extended:*` の失敗が WAL
stage に触れる前に surface するようにする。

## Signature chain

kernel → runtime-agent 方向は Ed25519 gateway-manifest 署名で認証される。kernel
は runtime-agent が host を許される `(shape, provider)` ペアを記述する manifest
に署名し、runtime-agent は enrollment 時と各 manifest refresh で署名を検証する。
これにより、runtime-agent の能力が operator が承認した kernel identity に bind
される。

runtime-agent → kernel 方向は別の auth path である: enrollment token が identity
を確立し、heartbeat / lease token で runtime-agent を attach し続け、agent
bearer (`TAKOSUMI_AGENT_TOKEN`) が lifecycle / connectors RPC を保護する。両方向
は鍵素材を共有せず、片方の侵害でもう片方が崩れることはない。

## Space 隔離

`spaceId` はすべての envelope とすべての lifecycle request に届く。
implementation と connector は、operation 入力が namespace import semantics で
ない限り、別 Space の object、secret、artifact、grant、namespace export を読み
書きしてはならない。current v1 にはそのような入力はない。Space 越えのアクセス は
contract 違反であり、`actual-effects-overflow` risk に closed される。

## Failure mode

- **Partial failure.** runtime-agent が承認済み effect の一部を commit したが
  全部ではなかった。status は `partial` となり、kernel はどの effect が landed
  したかを journal し、同じ idempotency key で欠けている subset を retry
  するか、 leak した subset に対して RevokeDebt を open する。
- **Compensation.** runtime-agent が `compensation-required` を返すか、
  `recoveryMode: compensate` が有効である。kernel は記録済み effect に対して
  connector の compensate operation を実行し、`activation-rollback` 理由で
  RevokeDebt を emit する。
- **Debt.** effect が適用されたが desired state と reconcile できないとき
  (overflow、partial、完全 reverse なしの compensate) — kernel は RevokeDebt
  entry を open する。debt の status enum と reason enum は closed である。解決
  には、compensate の成功、operator による手動 close-out、または
  `approvedEffects` を遡って leak 集合をカバーするように広げる Approval
  のいずれかが必要である。 Debt は kernel が「何が approved
  か」と「何が実在するか」を矛盾を黙って drop せずに sync 状態に保つための v1
  機構である。

## 関連

- [Runtime-Agent API](/reference/runtime-agent-api)
- [Lifecycle Protocol](/reference/lifecycle)
- [Execution Lifecycle](/reference/architecture/execution-lifecycle)
- [OperationPlan / Write-Ahead Journal Model](/reference/architecture/operation-plan-write-ahead-journal-model)
