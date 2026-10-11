# Runtime lifecycle invariants (alarms, polls, edge routing)

このドキュメントは、runtime 側の 4 つの不変条件と、それを「守る」のではなく
「破れない形にする」ための機構をまとめる。

## 1. alarm を再武装するコードは、必ず上限と ledger を持つ

正本 (正とする情報): [`core/shared/lifecycle/schedule.ts`](../../core/shared/lifecycle/schedule.ts)

- `RetrySchedule` — 失敗の再試行。`maxAttempts` に達したら `exhausted` を返し、
  呼び出し側は必ずそれを処理しなければならない (union 型なので無視できない)。
- `PollSchedule` — 「相手がまだ落ち着いていない」正常待ち。失敗ではないので
  attempt 予算を消費しないが、`deadlineMs` の wall-clock 予算で必ず終わる。

両方とも `minDelayMs` / `maxDelayMs` / `jitter` が必須で、`jitter: "none"` は
型に存在しない。つまり `setAlarm(now + 1000)` 相当を書くには、下限と上限の両方を
明示的に書く必要がある。

**なぜ 2 種類あるか**: `OpenTofuRunOwnerObject` は control ledger の読み取りが
失敗しても、run が `queued` のままでも、同じ「1 秒後に再 dispatch」を実行して
いた。attempt は加算されず、log も出ず、`RUN_OWNER_MAX_ATTEMPTS` は別経路でしか
参照されないため、1 つの Durable Object が 1 Hz で永久に controller を叩き続けた。
正常待ちと失敗再試行を型で分けること自体が、この欠陥の修正である。

deadline 到達時、run owner は record を terminal にして alarm を外す。非終端の
run は scheduled run repair sweep が拾い直すので、ここで止めても run は失われない。

## 2. 定期 sweep は「全件読んで先頭を切る」をしてはならない

`repairStaleOpenTofuRuns` (`deploy/platform/worker.ts`) は、修復対象の run を
先に引き、その run が指す Workspace だけを keyed lookup する。Workspace 全件を
読んで先頭 100 件だけ残す実装は、101 件目以降の Workspace の run を恒久的に
飢餓させ (他に回復経路がない)、かつ読み取り量が deployment 規模に比例して
無制限に増える。`OpenTofuRunRepairOperations.workspaces` は
`listWorkspacesByIds` だけを公開しており、「全件ください」を型として要求できない。

Workspace の keyed lookup は D1 の 100 bound parameter 上限があるため 90 件ずつ
chunk する。

## 3. edge の path gate は route inventory から導出する

正本: [`core/api/edge_public_paths.ts`](../../core/api/edge_public_paths.ts)

host worker は service を作る前に routing を決めるので、静的な答えが要る。その
静的な答えを worker 側に手書きしていた結果、`/v1/form-availability` と
`forms.takoform.com/v1alpha1` facade 一式が「mount されていて discovery が
広告していて、edge では 404」という状態になっていた。

現在は `ROUTE_FAMILIES` から導出する:

- `EDGE_EXPOSURE_BY_FAMILY` は `Record<RouteFamilyId, EdgeExposure>` なので、
  route family を足して exposure を決め忘れると型エラーになる。
- matcher は各 endpoint の宣言 path から生成されるので、exposed family に
  endpoint を足せばその瞬間に edge から届く。
- `tests/core/api/edge_public_paths_test.ts` が実際の Hono router を歩いて、
  mount 済み path が 1 つでも未分類なら落ちる。

現在の OSS edge では historical Resource/Form Host path は無条件 `404` で、host code
の binding で再度 mount できる例外はない。Takosumi は TargetPool / Resource Shape
設定を capabilities や Worker binding として広告せず、retained row を扱う typed
Host migration surface も提供しない。

従って PostgreSQL v110 / D1 v66 で入る物理的な廃止は route では解決
しない。廃止済み table に row があれば forward migration は fail-closed で停止する。
operator は immediate predecessor または out-of-band database tooling で inventory / export
を取り、explicit disposition を記録してから empty-state migration を再実行する。

## 4. 外部実行は、host invocation より先に自分の期限で止まる

正本: [`worker/src/durable/OpenTofuRunOwnerObject.ts`](../../worker/src/durable/OpenTofuRunOwnerObject.ts)
(`RUN_OWNER_DISPATCH_BUDGET_MS`)、[`runner/lib/run_deadline.ts`](../../runner/lib/run_deadline.ts)

Cloudflare composition の run owner は、dispatch 全体を Durable Object alarm の中で
await する。alarm の wall time は 15 分で、Core の lease / heartbeat 更新にも、
runner の command ごとの `maxRunSeconds` にも、それより短い上限は無かった。
内側の期限がすべて外側の wall 以上だと、いちばん粗い打ち切り (platform による
alarm の kill) が必ず勝つ。2026-10-11 の install-serving E2E では、この打ち切りで
runner の応答に受け手がいなくなり、tofu は caller の abort で SIGKILL され、部分
state は container の一時ディスクと一緒に消えた。completion receipt が無いので
takeover は `runner_mutation_indeterminate` としか答えられず、provider 側に作られた
8 resource が state の外に残った。

不変条件: **期限は、wall を知っている部品から、tofu を確定的に止められる部品まで
明示的に渡し、内側ほど早く切れるようにする。**

- run owner は alarm 開始 + 13 分を `deadlineAt` として dispatch に渡す。残り
  2 分は応答、部分 state と completion receipt、ledger commit のための予備。
  controller の再試行は同じ alarm の中では行わず、新しい期限を持つ次の alarm に
  回す。
- Core は `RunExecutionControl.deadlineAt` を解釈せず、Plan / Apply / Destroy と
  `post_apply` / `pre_destroy` の release activation の adapter に渡すだけ。
  substrate の制限を Core が知らないままにするため。
- runner Durable Object は転送の瞬間の残り時間を相対値で container に渡す。値は
  run body の外 (header) にあるので mutation identity に入らず、takeover が別の
  期限で再送しても同じ dispatch 権限として扱われる。残りが最小値 (Plan / Apply /
  Destroy は 5 分、release は 60 秒) を切っていれば dispatch せず、preparation を
  解放して retryable な 503 で答える。原因は呼び出し側の invocation で、Plan の
  中身ではないので、Run を終わらせずに新しい期限で再送させる。
- container は Run のすべての command を `min(command の timeout, Run の残り)` で
  打ち切り、Run の期限で打ち切るときだけ手前で SIGINT、猶予の後に SIGKILL
  する。期限で止まった apply は既存の `providerExecutionFailure` 経路に乗り、
  部分 state が保存される。止めた原因は固定の `runDeadlineExceeded` 印で返す。
  adapter は Plan ではそれを failure code `run_deadline_exceeded` にし、Apply /
  Destroy では元の failure code (provider 実行前かどうかの根拠) を残したまま、
  補助の warning diagnostic として付ける。

期限に関わる挙動は、header が無ければどの層も従来どおりになる。古い Durable Object
と新しい image、新しい Durable Object と古い image のどちらの組み合わせでも、
期限が効かないだけで以前と同じに動く。これとは別に、plan JSON (`tofu show -json`)
を読めない Plan は期限の有無にかかわらず失敗にし、Core も resource の変更が
分からない (一覧が無い、または読めない行を含む) Plan を自動で Apply しない。空の
一覧は「変更なし」として扱う。期限そのものを延ばす手段は無く、約 13 分を
超える実行は alarm の外へ出す設計 (architecture audit A-01、
[mutation の切り離しの設計メモ](./runner-mutation-detachment-design.md)) が必要。

## テスト側の機構

`tests/helpers/lifecycle/virtual_alarm_clock.ts` は alarm を自分で駆動し、
`maxDispatches` を超えた再武装と `minDelayMs` を下回る再武装を失敗にする。
「alarm を 2 回呼んで counter を assert する」テストは、ループが止まることを
何も証明しない (テストが止まっただけ) ため、この harness を通す。
