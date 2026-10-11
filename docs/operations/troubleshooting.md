# Operations: Troubleshooting Playbook

> このページでわかること: 実運用 (operator 向け) で頻出する failure シナリオと
> その対処手順。 Run の `status` / `errorCode` と runner phase
> (source / plan / apply / destroy) を起点に、 原因切り分け → 暫定復旧 →
> 恒久対策の順に確認する。

正本 (正とする情報) の model は [`../internal/core-spec.md`](../internal/core-spec.md)。 Run の確認は dashboard の Activity か
`GET /api/v1/runs/:runId` / `GET /api/v1/runs/:runId/logs` を使う。

## 早見表

| シナリオ                                | 主なシグナル                                                                                               | 1st action                                                                                                                                                                  |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| source_sync が失敗する                  | Run `failed` + source phase の git エラー                                                                  | Source URL / ref と auth Connection (token / SSH key) の status を確認                                                                                                      |
| plan が policy で止まる                 | Run `policyStatus: deny` / `warn`                                                                          | plan JSON の policy 評価結果 (provider / resource allowlist / scope / secret-backed provider policy / egress) を確認                                                        |
| apply が plan 検証で拒否される          | plan digest / source snapshot / compatibility report / dependency snapshot / state generation の検証エラー | re-plan して新しい saved plan を作る (apply は saved plan のみ)                                                                                                             |
| 旧 saved plan が preparation 検証で拒否される | PlanRun に `executionInputsDigest` がない                                                                    | private inputs を推測・backfillせず、現在の Source / dependency / ProviderBinding から新しい Plan を作る                                                                    |
| 上限際の旧 saved plan が apply 前に拒否される | Apply が provider 実行前に失敗する (runner DO の応答は `artifact_size_limit_exceeded`)。修正前の PlanRun は `planArtifact.sizeBytes` に暗号文長を記録しており、平文が plan 上限に近い (v2 暗号化形式では差が 33 byte 以内、それより古い base64 形式ではさらに広い) | 新しい Plan を作る。旧 PlanRun の暗号文長は、認証済み object の長さと完全一致するときだけ受け入れる。読み込み前の検査は平文の上限のまま広げない |
| plan が compatibility report で止まる   | `compatibility_report_module_path_mismatch`                                                                | report は分析した module path の証跡でしかない。InstallConfig の modulePath で compatibility check を取り直す                                                               |
| approval 待ちで進まない                 | Run `waiting_approval`                                                                                     | approver に escalation。 destroy は destroy_plan → approval → destroy_apply の 2 段                                                                                         |
| 同じ Capsule の run が進まない          | lease 取得待ち / Run `queued` のまま                                                                       | configured lease adapter の保持 run を確認、expired なら fenced takeover を待つ                                                                                             |
| provider credential が拒否される        | plan/apply phase の provider エラー                                                                        | Connection を test、 revoked / expired なら rotate して再 mint                                                                                                              |
| unknown provider が runnable にならない | Compatibility Report の provider finding / missing Provider Connection                                     | declared-env CredentialRecipe、ProviderConnection status、runner profile provider allowlist、egress policy を確認                                                           |
| producer 更新後に downstream が古い     | Capsule `stale` マーク                                                                                     | dependency graph を確認し、 Workspace update として DAG 順に plan/apply                                                                                                     |
| runner が起動しない                     | dispatch timeout / runner infrastructure error                                                             | selected RunnerProfile / executor adapter / pool capacity を確認し、queue 使用時は DLQ を確認                                                                               |
| install / deploy が遅い                 | phase timings で `source_clone` / `tofu_init` / `tofu_apply` のどれかが長い                                | SourceSnapshot reuse、provider mirror/cache、app repo 側の image/build 最適化を分けて確認。Run-scoped Cloudflare container は完了後に破棄されるため、keepalive を cold-start 対策にしない |
| Cloudflare で Plan / Apply が約 13 分で止まる | Plan は failure code `run_deadline_exceeded`。Apply / Destroy は元の failure code に加えて warning の diagnostic `run_deadline_exceeded`、provider 実行後なら `providerExecutionFailure` 付きで部分 StateVersion が残る | 下記「Cloudflare composition の Run 実行時間の上限」を参照。上限は延ばせないので、遅い provider 側を直してから re-plan / apply、または destroy する |

## 切り分けの基本

1. **Run を特定する**: dashboard の Activity か `GET /api/v1/runs/:runId` で
   `status` / `errorCode` / `policyStatus` を確認する。
2. **phase を特定する**: logs (`GET /api/v1/runs/:runId/logs`) で
   source / plan / apply のどの phase で失敗したかを見る。 phase ごとに
   渡る credential が異なる (source → git のみ、 plan/apply →
   provider のみ) ので、 credential 系エラーは phase で原因が絞れる。
3. **検証エラーは再 plan**: apply は saved plan のみを実行し、 plan digest /
   source snapshot / dependency snapshot / state generation を検証する。 検証
   エラーは状態が進んだサイン。 ロールバック的な操作も retained
   StateVersion / source identity / Output evidence から Capsule rollback plan
   を作り、通常の Run として承認・適用し直す。
4. **依存起因は graph で見る**: producer の outputs が変わると downstream は
   stale になる。 単発で直すより Workspace update として DAG 順に流す。
5. **遅さは phase timings で見る**: `source_clone` が長いなら Git/ref/path と
   SourceSnapshot reuse、`tofu_init` が長いなら provider mirror/cache、
   `tofu_apply` が長いなら provider 側 API / resource 作成待ちを確認する。
   reviewed plan artifact は durable storage から Apply / Destroy の別 Run
   container へ復元する。Run-scoped Cloudflare container は完了後に破棄され、
   keepalive / warm reuse を前提にしない。deploy 直後の
   compatibility preflight timeout は configured compatibility-check timeout
   を確認する。Cloudflare Container reference adapter を使う場合だけ
   legacy compatibility input の `TAKOSUMI_RUNNER_KEEPALIVE_SECONDS`、
   `TAKOSUMI_RUNNER_CAPACITY_RETRY_ATTEMPTS`、
   `TAKOSUMI_RUNNER_CAPACITY_RETRY_BASE_MS`、`max_instances` を追加確認する。
   他の adapter は自身の typed infrastructure error と pool policy を使う。
   app bundle / container image /
   DB migration の最適化は app repo / CI / OpenTofu module 側で行う。

## Cloudflare composition の Run 実行時間の上限

Cloudflare reference composition (`deploy/platform`) では、1 つの Plan / Apply /
Destroy は `OpenTofuRunOwnerObject` の Durable Object alarm 1 回の中で実行されます。
alarm の wall time は Cloudflare 側で 15 分に制限されており、lease 取得、
credential mint、container 起動、source / plan / state の復元、source build、
`tofu init`、`tofu plan` / `tofu apply`、state の永続化、`post_apply` /
`pre_destroy` の release command、ledger の commit がすべてこの 15 分に入ります。

このため run owner は alarm 開始時刻から **13 分後** を期限として dispatch に渡し、
残り 2 分を runner の応答、部分 state と completion receipt の書き込み、ledger の
commit のために残します。期限は次のように伝わります。

1. run owner が `deadlineAt` (alarm 開始 + 13 分) を Core に渡す。runner
   infrastructure の requeue があっても同じ alarm の中では再試行せず、すぐ次の
   alarm を予約して、そちらに新しい期限を持たせる。
2. Core は値を解釈せず、runner adapter の `RunExecutionControl.deadlineAt` に
   渡す。Plan、Apply、Destroy と、その中の `post_apply` / `pre_destroy` の release
   activation が対象。
3. adapter は `x-takosumi-run-deadline-at` header で runner Durable Object に渡す。
4. runner Durable Object は転送の瞬間の残り時間を `x-takosumi-runner-budget-ms`
   として container に渡す。残りが足りないとき (Plan / Apply / Destroy は 5 分未満、
   release command は 60 秒未満) は container に渡さず、retryable な 503
   (`runner_run_deadline_exceeded`) で答える。provider には届いていないので、
   Core は同じ Run を requeue し (`run_deadline_exceeded`、通常の runner
   infrastructure と同じ回数上限)、次の alarm が新しい期限で実行する。
   `pre_destroy` の release command が断られた場合も、何も実行されていないので
   Destroy を同じように requeue する。`post_apply` の場合は provider の Apply が
   終わった後なので requeue できず、未実行 (`actionDispatched: false`) の
   lifecycle action の失敗として記録される。
5. container はその Run のすべての command (source build、init、plan、
   `show -json`、apply、output、release command) を、command 自身の timeout と
   Run 全体の残り時間の短い方で打ち切る。Run の期限で打ち切るときだけ、直前に
   SIGINT を送り、猶予 (上限 30 秒、残り時間の 1/4 以内) の後に SIGKILL する。
   OpenTofu は SIGINT で provider を止めて state を書いてから終了するので、
   state ファイルが書きかけで残りにくい。command 自身の timeout で打ち切る場合は
   従来どおり SIGKILL だけで、前倒しの中断はしない。

期限で止まった Apply は、通常の provider 実行失敗として扱われます。runner
Durable Object は部分 state を R2 に書き、completion receipt を記録し、Core は
部分 StateVersion 付きの `failed` として commit します。Capsule の runtime safety
は `unknown` になりますが、state が残っているので Destroy や、新しい Plan からの
Apply で回復できます。takeover が同じ ApplyRun を再送しても completion
receipt を採用するだけで、provider を再実行しません。

期限で止まったことは code `run_deadline_exceeded` で確認できます。Plan では
failure code そのものになります。Apply / Destroy では元の failure code
(例: `opentofu_init_failed`) を残したまま、warning の diagnostic として付きます。
元の code が provider 実行前の失敗を示していれば、期限で止まっても Run は
provider 未到達として扱われ、Capsule の runtime safety は変わりません。detail の
`(run deadline)` の行は長い出力では省略されることがあるので、code の方を見て
ください。takeover が R2 から採用した結果には、この code が付かないことがあります。

Plan の `tofu show -json` が失敗した場合 (期限によるものを含む) は、Plan そのものを
失敗にします。plan JSON が無いと resource の変更が分からず、delete / replace の
承認や resource type allowlist、scope、quota を判定できないためです。これは期限
の有無に関係なく常に効きます。Core の側でも、resource の変更が分からない Plan は
自動で Apply せず、resource 系の policy が設定された Capsule では Plan を失敗に
します。「分からない」は変更一覧が無い場合と、読めない行を含む場合だけです。
空の一覧 (output だけの module、その destroy、refresh-only の Plan) は「変更なし」
として扱い、policy を通り、自動 Apply も従来どおり続きます。

**約 13 分を超える Plan / Apply は、Cloudflare composition では実行できません。**
これは alarm の wall time から来る上限で、設定で延ばす手段はありません。長い実行を
alarm の外へ出す設計 (architecture audit A-01、
[mutation の切り離しの設計メモ](../internal/runner-mutation-detachment-design.md))
が入るまでこの上限が続きます。Bun + Postgres composition (`deploy/node-postgres`)
には alarm が無く、この期限も渡らないので、従来どおり command ごとの
`maxRunSeconds` だけが上限です。

runner profile の `maxRunSeconds` (既定 900 秒) は、この上限の代わりになりません。
command ごとの上限で、しかも alarm より後に数え始めるので、Cloudflare では必ず
alarm の wall より後に発火します。期限の伝達が入った後は Run 全体の期限が先に
効くので、`maxRunSeconds` を下げる必要はありません。

### 既知の挙動

- 猶予中に command が終わっても、その command は timeout (exit 124) として扱います。
  そのため、本当に最後まで完了した Apply でも `failed` になることがあります。この
  とき Output は新しくならず、新しい Plan を Apply し直すまで Capsule の Output は
  戻りません。
- 期限切れで `tofu apply` を起動する前に止まった場合も、Apply は
  `providerExecutionFailure` として記録されます。実際には provider に触れて
  いませんが、安全側に倒した記録です。runner Durable Object が 5 分未満の
  dispatch を断るので、build と init だけで 5 分以上かかったときにしか起きません。
- 猶予を過ぎても終わらない command は SIGKILL するので、provider が中断に応じない
  と、作成途中の resource が state に載らないことや、state ファイルが書きかけで
  残ることがあります。
- container に渡すのは相対値の残り時間です。container の時計と Worker の時計は
  比べないので、時計のずれは期限に影響しません。
- operator 向けの webhook release activator は `deadlineAt` を使いません。外部の
  materializer が受け持つ release は、この期限では止まりません。

期限で止まった Apply の残骸は、普段の失敗と同じ手順で片付けます。provider 側で
どの resource が作られたかは部分 StateVersion に残っています。期限の伝達より前の
runner image で起きた `runner_mutation_indeterminate` (alarm が
`exceededWallTime` で切れたもの) は state が残っていないので、provider 側の
resource を operator が個別に確認して片付ける必要があります。

## エスカレーション

- state / secret 関連の異常 (生成不一致、 復号失敗) は
  [secret-rotation-policy.md](secret-rotation-policy.md) と
  [disaster-recovery.md](disaster-recovery.md) に従う。
- platform worker 全体の障害は [incident-response.md](incident-response.md)。

## 関連ドキュメント

- [Core Specification](../internal/core-spec.md)
- [Incident Response](incident-response.md)
- [Rollback SOP](rollback-sop.md)
- [Secret Rotation Policy](secret-rotation-policy.md)
