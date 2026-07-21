# Runtime lifecycle invariants (alarms, polls, edge routing)

このドキュメントは、runtime 側の 3 つの不変条件と、それを「守る」のではなく
「破れない形にする」ための機構をまとめる。

## 1. alarm を再武装するコードは、必ず上限と ledger を持つ

正本: [`core/shared/lifecycle/schedule.ts`](../../core/shared/lifecycle/schedule.ts)

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

`public` は Takoform contract 上 unauthenticated な `/.well-known/takoform`
だけで、host は caller の credential / trusted-context header を剥がしてから
core app に渡す。operator bearer 面 (`/v1/form-activations`) は意図的に
edge gate に載せない — session seam は deploy-control bearer を注入するため。

## テスト側の機構

`tests/helpers/lifecycle/virtual_alarm_clock.ts` は alarm を自分で駆動し、
`maxDispatches` を超えた再武装と `minDelayMs` を下回る再武装を失敗にする。
「alarm を 2 回呼んで counter を assert する」テストは、ループが止まることを
何も証明しない (テストが止まっただけ) ため、この harness を通す。
