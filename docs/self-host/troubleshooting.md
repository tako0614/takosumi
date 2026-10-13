# トラブルシューティング

まず dashboard または認可された `GET /api/v1/runs/:runId` で status/errorCode を確認し、
`GET /api/v1/runs/:runId/logs` と events で止まった phase を特定します。

| 症状 | 確認するもの |
| --- | --- |
| source の取得失敗 | Git URL/ref、SourceSnapshot、Git 接続 |
| 承認待ち | 保存済み Plan の内容と承認者 |
| queued のまま | 同じ Capsule の実行中 Run、runner の配線と capacity、Run owner の dispatch |
| runner_capability_missing | Bun/PostgreSQL の stock 配布には runner が無い。組み込みの実配線を確認 |
| provider の認証拒否 | その phase に渡る ProviderConnection、recipe、権限、失効 |
| state/fence/receipt の不整合 | 保存済みの証拠と現行 state。Apply を連打せず、判定不能な mutation は operator が調査 |

Cloudflare の回復 sweep は `scheduled.run_repair_failures` と
`takosumi_run_repair_total{outcome="ordinary_failure"}` / `{outcome="retirement_failure"}` で失敗件数を示します。
source poll、stale auto-plan、drift の警告は phase を示し、例外本文や認証情報を出しません。

新しい Plan で直せる validation error と、provider mutation の結果が不明な失敗を区別します。
後者は新しい Plan を作るだけでは解決しません。[実行モデル](../concepts/run-model.md)と
[状態と出力](../concepts/state-and-outputs.md)を参照してください。
