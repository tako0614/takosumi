# Runner mutation の切り離し (第 2 段の設計メモ)

Status: 設計メモのみ。実装していない。live 環境での確認が前提で、
[Core Spec](./core-spec.md) の at-most-once mutation 契約を上書きしない。

## 背景

第 1 段 ([runtime lifecycle §4](./runtime-lifecycle.md)) で、Cloudflare
composition の Plan / Apply は alarm の wall より前に runner 自身の期限で止まる
ようになった。期限で止まった Apply は部分 state と completion receipt を残し、
takeover はそれを採用できる。

残っているのは、期限以外の理由で caller がいなくなる場合である。lease の更新失敗、
isolate の再起動、alarm の想定外の停止などで caller の request が取り消されると、
runner Durable Object から container への request も同じ `request.signal` で
取り消される (`worker/src/durable/OpenTofuRunnerObject.ts` の
`dispatchRequest`)。container は tofu を SIGKILL し、部分 state は container の
一時ディスクと一緒に消える。completion receipt が無いので、takeover は
`runner_mutation_indeterminate` としか答えられない。

第 2 段の目的は、caller がいなくなっても mutation の結果 (少なくとも部分 state) を
失わないことである。provider の再実行は今と同じく許さない。

## 設計案

1. **container への request を caller から切り離す。** Apply / Destroy の
   container request には caller の `request.signal` ではなく、runner Durable
   Object 自身が持つ AbortController の signal を渡す。Plan と読み取り専用の
   作業は今の挙動のままにする。
2. **caller がいなくなったら、止めてから集める。** caller の `request.signal` の
   abort を受けた Durable Object は、container に graceful stop を依頼する
   (新しい private endpoint、例: `POST /runs/:id/interrupt` で tofu に SIGINT)。
   猶予の後も終わらなければ SIGKILL する。その後、container に残った state を
   今と同じ経路で R2 に保存し、`providerExecutionFailed` の completion receipt を
   記録する。「lease を失った executor は外部作業を止める」という不変条件
   (`run_engine.ts` の `#withRunRenewal`) は、止める点では守ったまま、state だけを
   残すことになる。
3. **実行中の再送には「まだ終わっていない」と答える。** 記録が `dispatched` で、
   同じ isolate に切り離された mutation が生きている間の再送には、indeterminate
   ではなく retryable な型付きの「進行中」を返す。Core の takeover と run owner は
   それを poll の対象として扱う (`PollSchedule` の範囲内)。完了後の再送は今と
   同じく receipt を採用する。
4. **credential と lease は延長しない。** caller がいなくなった後は、誰も
   renewable credential を更新しない。止めてから集めるまでを猶予と state の保存
   (目安 1〜2 分) に収め、capsule lease の TTL (15 分) より十分短く保つ。
   後継の owner は採用しかできず、同じ Capsule の別 mutation は lease が切れる
   まで始まらない。

## 実装前に staging で確かめること

- caller の request が取り消された後も、Durable Object が container への fetch を
  待ち続け、storage と R2 に書けるか。Cloudflare の文書は「request、RPC、
  pending I/O がある間は active」とだけ書いており、取り消された handler の扱いは
  明記していない。
- `@cloudflare/containers` の activity 判定 (`sleepAfter`) が、caller の無い
  container fetch の間も container を止めないか。止めるなら、切り離した mutation
  の間は activity を更新し続ける必要がある。
- mutation の途中で Durable Object の isolate が再起動した場合の挙動。この場合は
  誰も state を集められないので、今と同じ indeterminate が残る。container 側が
  直接 R2 に書く案は、container に R2 の credential を渡すことになるので採らない。

## リスク

- 止めずに最後まで走らせる案は採らない。後継の owner と並んで provider を操作する
  executor が生まれ、lease の不変条件が崩れるため。
- 「進行中」の応答を足すと、Core と run owner に新しい待ち状態が増える。
  `RetrySchedule` / `PollSchedule` の上限の中に収め、無期限の待ちを作らない。
- 第 2 段は暫定策で、長い実行を alarm から出す本来の設計は architecture audit
  A-01 (Workflow かステップ台帳、alarm は短い tick だけ) である。第 2 段を入れる
  場合も、A-01 で置き換えられる形に留める。
