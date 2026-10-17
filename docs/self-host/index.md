# 運用ガイド

自分の環境に置いた Takosumi の更新、バックアップ、障害切り分けをまとめます。
構成の境界と初回起動は[自分で動かす](../concepts/self-host.md)を参照してください。
Bun と PostgreSQL の標準の構成を手元で試す場合は、そのページの
[ローカルで安全に起動して確認する](../concepts/self-host.md#ローカルで安全に起動して確認する)
の一時的な上書き設定（`compose.local-test.yml`）を使います。

- [更新する](./upgrade.md)
- [バックアップと復旧](./backup-restore.md)
- [トラブルシューティング](./troubleshooting.md)

監視の出発点は `deploy/observability/grafana/takosumi-deploy-overview.json` です。
`/metrics` は `TAKOSUMI_METRICS_SCRAPE_TOKEN` の bearer で保護されます。
Workspace/Capsule ID は scrape ラベルに含めません。個別の記録は認可された API で確認します。

dashboard の **ストア** に並ぶサービスは、TCS 2.0 互換の Store から読みます。読む先は、
サーバーに設定した Store と、利用者がブラウザーで追加した Store です。サーバーに設定するには、
使う Store の公開 HTTP(S) URL を環境変数 `TAKOSUMI_TCS_STORE_URL` に入れ、サーバーを再起動
します（Cloudflare では Worker を再デプロイします）。Takosumi は `/.well-known/takosumi` の
`endpoints.extensions["takosumi.tcs-store.v1"]` でその URL を dashboard に知らせるため、
dashboard の再ビルドは要りません。反映されたかは `curl https://<公開hostname>/.well-known/takosumi`
で確かめます。URL に username、password、query、fragment を含めると、その値は無視されて
何も知らされません。サーバーに設定がなければ dashboard のビルド時の
`VITE_TAKOSUMI_TCS_STORE_URL` を使い、どちらもなければ既定の Store はありません。Store との
連携の境界は [Store API](../reference/store-api.md) にあります。

Store の URL を設定しても、Bun と PostgreSQL の標準の構成に runner と runner の成果物の
保存先は加わりません。control / pre-destroy export の保存先は
[バックアップと復旧](./backup-restore.md)を参照してください。
