# Runtime lifecycle invariants (alarms, polls, edge routing)

このドキュメントは、runtime 側の 3 つの不変条件と、それを「守る」のではなく
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

## テスト側の機構

`tests/helpers/lifecycle/virtual_alarm_clock.ts` は alarm を自分で駆動し、
`maxDispatches` を超えた再武装と `minDelayMs` を下回る再武装を失敗にする。
「alarm を 2 回呼んで counter を assert する」テストは、ループが止まることを
何も証明しない (テストが止まっただけ) ため、この harness を通す。

## Mutating Run の private continuation

Cloudflare の Apply / Destroy は、RUN_OWNER alarm が OpenTofu の完了まで一回の
`fetch` を待たない。Core は既存の ApplyRun と Coordination lease を先に確保し、
RUN_OWNER は両 token と非秘密の phase を main owner record とは別の private
storage key に書き終えてから次の一歩を実行する。main record を返す debug route に
lease token、credential value、operator job URL を載せない。

各 alarm は Run heartbeat と Coordination lease の同一 token を更新した後、
既存 Runner DO の exact claim に一回だけ submit するか、immutable target witness
に一致する value-free selector で observe する。selector は権限そのものではなく、
private Core→Runner binding と現在の Run/lease custody が前提である。失われた
submit ACK、DO 再構築、container 消失は新しい provider POST の許可ではない。
Core は provider selector と `observing` phase を最初の POST より前に保存する。
POST が届かなかった場合も、再開時は新しい credential を mint／再 submit せず、
exact claim/receipt の readback がなければ indeterminate とする。
`preparing` と `dispatched` の境界、exact R2 receipt、Core の Run/State/Output/Capsule
atomic CAS がそれぞれ別の証拠を持つ。diagnostic inspection の witness は単独の
adoption authority ではない。
Runner DO の private observation は稼働中 container のみへ no-start で接続し、
有効な Run/lease から来た pending 観測だけが activity timeout を延長する。
通常 cadence は 10 秒で、owner 停止後は延長されず container が停止し得る。
この場合も結果不明を再 dispatch しない。durable receipt 消費後には exact result
ACK を再試行し、container 内の terminal response を破棄する。

Destroy の `pre_destroy` runner command → operator job → provider teardown、Apply の
provider mutation → `post_apply` runner command → operator job → atomic terminal commit
という順序を保つ。RUN_OWNER は各 runner/partner POST の前に private send fence を
checkpoint し、再開時には runner release claim または保存済み operator job reference
だけを observe する。operator POST ACK を失って job reference が不明なら再 POST
せず indeterminate にする。provider receipt だけでは post-apply 完了でも Capsule
active でもない。pre-destroy success audit は provider teardown より前に Core CAS
で保存する。

Runner の accepted credential sequence/expiry は値なしで照合し、更新が必要な時だけ
broker から sequence `N+1` を mint する。PUT ACK 消失は Runner の同一 sequence
readback でのみ解決する。旧 sequence 0 を poll ごとに mint し直さない。lease 喪失、
資格更新失敗、または cancel で停止要求を送れても、stop ACK は provider の不実行や
成功を証明しない。exact receipt がない限り同 scope の別 write を許さず、operator
による明示的な解決を要する。
同一 Plan の別 Apply は create/update/destroy すべてで、先行 queued Run、実行中 Run、
dispatch 後未解決 Run によって遮断する。queued 同士は作成時刻と ID の安定順で
先行 Run のみを優先し、互いの待ちによる停止を避ける。
