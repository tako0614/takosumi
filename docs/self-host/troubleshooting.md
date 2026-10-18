# トラブルシューティング

ローカル smoke-test project で起動しない場合は、初回起動と同じ shell で
`local_compose` helper を使って状態と診断出力を確認します。ローカル確認の `local_project` と
`local_dir` は、[ローカルで安全に起動して確認する](../concepts/self-host.md#ローカルで安全に起動して確認する)
で設定したものです。production では、初回起動時と同じ project と Compose file 引数を helper に
設定してください。

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

## Bun と PostgreSQL の起動時に出るログ

`local_compose logs accounts`（production では同じ helper の `logs accounts`）を見ます。起動を
止めた原因は、`"event":"server.fatal"` の行の `error.message` に出ます。

| ログに含まれる文字列 | 原因と直し方 |
| --- | --- |
| `secret-store encryption key missing` | `TAKOSUMI_SECRET_STORE_PASSPHRASE` が無い。`.env` に入れる。production 以外の環境ではメッセージが `TAKOSUMI_DEV_MODE=1` も挙げるが、手元の確認用なので本番では使わない |
| `secret-store globalPassphrase is too short` | `TAKOSUMI_SECRET_STORE_PASSPHRASE` が 32 バイト未満。`openssl rand -hex 32` で作った値にする |
| `refusing to boot an https issuer` | issuer が https なのに安定した署名鍵が無い。`TAKOSUMI_ACCOUNTS_ES256_PRIVATE_JWK` と `TAKOSUMI_ACCOUNTS_OIDC_PAIRWISE_SUBJECT_SECRET` を入れる |
| `Stable OIDC signing requires TAKOSUMI_ACCOUNTS_OIDC_PAIRWISE_SUBJECT_SECRET` | 署名鍵だけを入れ、`TAKOSUMI_ACCOUNTS_OIDC_PAIRWISE_SUBJECT_SECRET` が無い |
| `Invalid keyData` | `TAKOSUMI_ACCOUNTS_ES256_PRIVATE_JWK` を鍵として読めない。`.env.example` の仮の値（`replace-with-private-d`）が残っていないか確かめ、生成した JWK に置き換える |
| `TAKOSUMI_ACCOUNTS_UPSTREAM_PROVIDERS requires TAKOSUMI_ACCOUNTS_SUBJECT_SECRET` | 上流の ID プロバイダを設定したのに `TAKOSUMI_ACCOUNTS_SUBJECT_SECRET` が無い |
| `clientSecretEnv references missing runtime secret` | 記述子の `clientSecretEnv` に書いた名前の secret がコンテナに届いていない。`docker-compose.override.yml` の `accounts.environment` で渡す |
| `dashboard SPA build not found` | dashboard の build が無く、画面が出ない（起動は続く）。Compose の image には入っている。手で起動する場合は `bun run build:dashboard` を実行するか、`index.html` のあるディレクトリを `TAKOSUMI_ACCOUNTS_STATIC_DIR` に設定する |

https で開けない、証明書が出ないときは `logs caddy` を見ます。公開する hostname がこのホストを
指し、80 番と 443 番に外から届く必要があります。`/readyz` が `503` で `internalApiSecret` を返すのは、
[動いていることを確かめる](../concepts/self-host.md#動いていることを確かめる)のとおりです。

Run の問題は dashboard または認可された `GET /api/v1/runs/:runId` で status/errorCode を確認し、
`GET /api/v1/runs/:runId/logs` と events で止まった phase を特定します。

| 症状 | 確認するもの |
| --- | --- |
| source の取得失敗 | Git URL/ref、SourceSnapshot、Git 接続 |
| 承認待ち | 保存済み Plan の内容と承認者 |
| queued のまま | 同じサービス（Capsule）で別の Run が実行中なら、終わるまで待ちます。dashboard の デプロイ履歴で確認します。Cloudflare では、同時に動かせる runner コンテナ（`wrangler.toml` の `max_instances`、雛形は 10）が埋まっていると空きを待ちます。15 分ほど待っても空かなければ待つのをやめ、`bunx wrangler tail` のログに `takosumi.run_owner.controller_poll_deadline_exceeded` を出します。その後も Run は queued のまま残り、下の定期的な修復処理（sweep）が拾います。自分の `wrangler.toml` に雛形の `RUNNER` binding があるかも確認します |
| runner_capability_missing | Bun と PostgreSQL の標準の構成には runner がありません。plan と apply には runner を組み込んだ構成が要ります（[構成を選ぶ](../concepts/self-host.md#構成を選ぶ)） |
| migration が失敗する | `local_compose logs migrations postgres`、DB 接続、適用済み migration を確認。down migration は実行しない |
| `/healthz` が応答しない | `local_compose ps`、accounts logs、公開 port と bind を確認。local test は `localhost:26401` |
| dashboard は表示されるが sign-in できない | issuer、origin、redirect URI、upstream `clientSecretEnv` の明示 mapping を確認 |
| provider の認証拒否 | その phase に渡る ProviderConnection、recipe、権限、失効 |
| state・排他制御の印（fence）・実行記録（receipt）が食い違う | 保存済みの記録、fence、現在の state を照合。apply を繰り返さず、結果を判定できない変更は operator が調査 |

Cloudflare の修復処理（定期的な sweep）は、止まったままの Run を拾い直し、その件数を
`takosumi_run_repair_total{outcome="rescheduled"}` で示します。失敗件数は
`scheduled.run_repair_failures` と
`takosumi_run_repair_total{outcome="ordinary_failure"}` / `{outcome="retirement_failure"}` で示します。
source poll、stale auto-plan、drift の警告は phase を示し、例外本文や認証情報を出しません。

新しい Plan で直せる validation error と、provider mutation の結果が不明な失敗を区別します。
後者は新しい Plan を作るだけでは解決しません。[実行モデル](../concepts/run-model.md)と
[状態と出力](../concepts/state-and-outputs.md)を参照してください。
