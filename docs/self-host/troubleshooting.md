# トラブルシューティング

ローカル smoke-test project で起動しない場合は、初回起動と同じ shell で
`local_compose` helper を使って状態と診断出力を確認します。production では初回起動時の
同じ project と Compose file 引数を helper に設定してください。

```bash
set -euo pipefail
local_files=(-f docker-compose.yml -f "$local_dir/compose.local-test.yml")
local_compose() { docker compose -p "$local_project" "${local_files[@]}" "$@"; }
local_compose ps
local_compose logs --tail=100 postgres migrations accounts
curl -i http://localhost:26401/healthz # loopback-only local test
```

`migrations` が失敗していれば `accounts` は起動しません。migration error と適用済み状態を
保全してから修復します。`accounts` の health check は PostgreSQL 接続も確認します。
production Caddy 構成では `https://<公開hostname>/healthz` を確認します。

Run の問題は dashboard または認可された `GET /api/v1/runs/:runId` で status/errorCode を確認し、
`GET /api/v1/runs/:runId/logs` と events で止まった phase を特定します。

| 症状 | 確認するもの |
| --- | --- |
| source の取得失敗 | Git URL/ref、SourceSnapshot、Git 接続 |
| 承認待ち | 保存済み Plan の内容と承認者 |
| queued のまま | 同じ Capsule の実行中 Run、runner の配線と capacity、Run owner の dispatch |
| runner_capability_missing | Bun/PostgreSQL の stock 配布には runner が無い。組み込みの実配線を確認 |
| migration が失敗する | `local_compose logs migrations postgres`、DB 接続、適用済み migration を確認。down migration は実行しない |
| `/healthz` が応答しない | `local_compose ps`、accounts logs、公開 port と bind を確認。local test は `localhost:26401` |
| dashboard は表示されるが sign-in できない | issuer、origin、redirect URI、upstream `clientSecretEnv` の明示 mapping を確認 |
| provider の認証拒否 | その phase に渡る ProviderConnection、recipe、権限、失効 |
| state/fence/receipt の不整合 | 保存済みの証拠と現行 state。Apply を連打せず、判定不能な mutation は operator が調査 |

Cloudflare の回復 sweep は `scheduled.run_repair_failures` と
`takosumi_run_repair_total{outcome="ordinary_failure"}` / `{outcome="retirement_failure"}` で失敗件数を示します。
source poll、stale auto-plan、drift の警告は phase を示し、例外本文や認証情報を出しません。

新しい Plan で直せる validation error と、provider mutation の結果が不明な失敗を区別します。
後者は新しい Plan を作るだけでは解決しません。[実行モデル](../concepts/run-model.md)と
[状態と出力](../concepts/state-and-outputs.md)を参照してください。
