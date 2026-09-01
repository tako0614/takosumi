# トラブルシューティング

Run が進まないときは、まず Run を特定し、次に phase を特定します。

1. dashboard の Activity か `GET /api/v1/runs/:runId` で `status` と
   `errorCode` を見る。
2. `GET /api/v1/runs/:runId/logs` で source / plan / apply のどの phase で
   止まったかを見る。phase ごとに渡る認証情報が違うので (source → git のみ、
   plan / apply → provider のみ)、credential 系のエラーは phase で絞れます。

## 早見表

| 症状 | 主なシグナル | まずやること |
| --- | --- | --- |
| source の取得が失敗する | Run `failed` + source phase の git エラー | Source の URL / ref と Git 接続の状態を確認 |
| 承認待ちで進まない | Run `waiting_approval` | 承認者を確認。削除は plan → 承認 → 実行の 2 段です |
| 同じサービスの Run が進まない | `queued` のまま | 同じ Capsule の実行中 Run を確認。心拍が止まった Run は約 10 分で自動的に引き継がれます |
| インストールが途中で止まった | サービスに「対応が必要」 | 詳細画面の「変更の確認」からやり直すか、削除してやり直す |
| provider の認証が拒否される | plan / apply phase の provider エラー | 接続済みアカウントを test し、失効していれば更新 |
| runner が起動しない | dispatch timeout / runner infrastructure error | compose なら `opentofu-runner` コンテナの health と `TAKOSUMI_RUNNER_SHARED_TOKEN` の一致を確認 |
| 削除予約が実行されない | 「削除予定」のまま期限超過 | 定期処理の失敗を確認 (下記の指標)。work item は最大 3 回まで自動再試行します |

## 自動回復の仕組みと、その監視

止まった Run は定期処理 (5 分周期) が拾い直します。この回復レーン自体が
死んでいると何も自己修復しなくなるので、次の指標を見てください。

- `takosumi_run_repair_total{outcome="failed"}` — 回復処理の失敗
- `takosumi_run_queue_oldest_age_seconds` — 最も古い待機 Run の待ち時間
- `takosumi_billing_capture_pending` — 課金確定が終わっていない apply の数
- `takosumi_work_items_backlog` — 予約済み処理 (削除予約など) の滞留

同梱のアラート定義 (`deploy/observability/prometheus/takosumi-alerts.yaml`) は
この 4 つすべてに閾値を持っています。

## 検証エラーは再 plan

apply は保存済みの plan だけを実行し、plan の digest、source snapshot、state の
世代を検証します。検証エラーは「状態が先に進んだ」合図です。壊れたのではなく、
もう一度 plan を作れば新しい前提で続きから進めます。
