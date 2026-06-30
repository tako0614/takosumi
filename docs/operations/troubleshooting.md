# Operations: Troubleshooting Playbook

> このページでわかること: 実運用 (operator 向け) で頻出する failure シナリオと
> その対処手順。 Run の `status` / `errorCode` と runner phase
> (source / plan / apply / destroy) を起点に、 原因切り分け → 暫定復旧 →
> 恒久対策の順に確認する。

正本 model は [`../core-spec.md`](../core-spec.md)。 Run の確認は dashboard の Activity か
`GET /api/v1/runs/:runId` / `GET /api/v1/runs/:runId/logs` を使う。

## 早見表

| シナリオ                                | 主なシグナル                                                                                               | 1st action                                                                                                           |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| source_sync が失敗する                  | Run `failed` + source phase の git エラー                                                                  | Source URL / ref と auth Connection (token / SSH key) の status を確認                                               |
| plan が policy で止まる                 | Run `policyStatus: deny` / `warn`                                                                          | plan JSON の policy 評価結果 (provider / resource allowlist / scope / secret-backed provider policy / egress) を確認 |
| apply が plan 検証で拒否される          | plan digest / source snapshot / compatibility report / dependency snapshot / state generation の検証エラー | re-plan して新しい saved plan を作る (apply は saved plan のみ)                                                      |
| approval 待ちで進まない                 | Run `waiting_approval`                                                                                     | approver に escalation。 destroy は destroy_plan → approval → destroy_apply の 2 段                                  |
| 同じ Capsule の run が進まない          | lease 取得待ち / Run `queued` のまま                                                                       | CoordinationObject lease の保持 run を確認、 expired なら takeover を待つ                                            |
| provider credential が拒否される        | plan/apply phase の provider エラー                                                                        | Connection を test、 revoked / expired なら rotate して再 mint                                                       |
| unknown provider が runnable にならない | Compatibility Report の provider finding / missing Provider Connection                                     | declared-env CredentialRecipe、ProviderConnection status、runner profile provider allowlist、egress policy を確認   |
| producer 更新後に downstream が古い     | Capsule `stale` マーク                                                                                     | dependency graph を確認し、 Workspace update として DAG 順に plan/apply                                              |
| Runner Container が起動しない           | dispatch timeout / container error                                                                         | runner image / Container 設定を確認、 queue DLQ を確認                                                               |
| install / deploy が遅い                 | phase timings で `source_clone` / `tofu_init` / `tofu_apply` のどれかが長い                                | SourceSnapshot reuse、provider mirror/cache、app repo 側の image/build 最適化を分けて確認。run-scoped Cloudflare runner では keepalive は cross-run cache にならない |

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
   `TAKOSUMI_RUNNER_KEEPALIVE_SECONDS` は current run container の寿命だけを
   変える。Cloudflare runner が run-scoped の間は positive value が
   `max_instances` を埋めやすいので、production は `0` を優先する。app bundle /
   container image / DB migration の最適化は app repo / CI / OpenTofu module 側で
   行う。

## エスカレーション

- state / secret 関連の異常 (生成不一致、 復号失敗) は
  [secret-rotation-policy.md](secret-rotation-policy.md) と
  [disaster-recovery.md](disaster-recovery.md) に従う。
- platform worker 全体の障害は [incident-response.md](incident-response.md)。

## 関連ドキュメント

- [Core Specification](../core-spec.md)
- [Incident Response](incident-response.md)
- [Rollback SOP](rollback-sop.md)
- [Secret Rotation Policy](secret-rotation-policy.md)
