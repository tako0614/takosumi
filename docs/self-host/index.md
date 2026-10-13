# 運用ガイド

自分の環境に置いた Takosumi の更新、バックアップ、障害切り分けをまとめます。
構成の境界と初回起動は[自分で動かす](../concepts/self-host.md)を参照してください。
Bun/PostgreSQL stock 構成をローカルで試す場合は、その手順の一時 override を使います。

- [更新する](./upgrade.md)
- [バックアップと復旧](./backup-restore.md)
- [トラブルシューティング](./troubleshooting.md)

監視の出発点は `deploy/observability/grafana/takosumi-deploy-overview.json` です。
`/metrics` は `TAKOSUMI_METRICS_SCRAPE_TOKEN` の bearer で保護されます。
Workspace/Capsule ID は scrape ラベルに含めません。個別の記録は認可された API で確認します。

外部の TCS store を使う場合は、composed app の environment に公開 HTTP(S) URL を
`TAKOSUMI_TCS_STORE_URL` として設定します。service は
`/.well-known/takosumi` の `endpoints.extensions["takosumi.tcs-store.v1"]` に URL string を
広告します。dashboard の `runtimeStoreUrl()` が extension を読むため、SPA の再ビルドは不要です。URL の
username、password、query、fragment は受け付けません。runtime 設定がなければ build 時の
`VITE_TAKOSUMI_TCS_STORE_URL` を使い、どちらもなければ既定の store はありません。
Bun/PostgreSQL stock には runner と artifact store が含まれないため、TCS store の URL を
設定してもそれらの capability は追加されません。
