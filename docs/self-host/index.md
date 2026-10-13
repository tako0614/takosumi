# 運用ガイド

自分の環境に置いた Takosumi の更新、バックアップ、障害切り分けをまとめます。
構成と初回起動は[自分で動かす](../concepts/self-host.md)を参照してください。

- [更新する](./upgrade.md)
- [バックアップと復旧](./backup-restore.md)
- [トラブルシューティング](./troubleshooting.md)

監視の出発点は `deploy/observability/grafana/takosumi-deploy-overview.json` です。
`/metrics` は `TAKOSUMI_METRICS_SCRAPE_TOKEN` の bearer で保護されます。
Workspace/Capsule ID は scrape ラベルに含めません。個別の記録は認可された API で確認します。

ストアを選ぶ場合は、公開 HTTP(S) URL を `TAKOSUMI_TCS_STORE_URL` に設定できます。
`/.well-known/takosumi` の `endpoints.extensions["takosumi.tcs-store.v1"]` が dashboard に伝え、
SPA の再ビルドは不要です。URL のユーザー名、パスワード、query、fragment は受け付けません。
未設定なら build 時の `VITE_TAKOSUMI_TCS_STORE_URL` を使い、どちらも無ければ既定のストアはありません。
