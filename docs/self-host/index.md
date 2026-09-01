# 運用ガイド

このセクションは、Takosumi を自分の環境で動かしている人のための運用手順です。
立て方そのものは[自分で動かす](../concepts/self-host.md)にあります。ここでは
立てたあとに必ず来る 3 つ — 更新、バックアップと復旧、詰まったときの切り分け —
を扱います。

- [更新する](./upgrade.md) — 新しい版への追従と、マイグレーションの流儀
- [バックアップと復旧](./backup-restore.md) — 何を守れば全損しないか
- [トラブルシューティング](./troubleshooting.md) — Run が進まないときの切り分け

監視を立てる場合は、同梱のアラート定義
(`deploy/observability/prometheus/takosumi-alerts.yaml`) と Grafana ダッシュボード
(`deploy/observability/grafana/takosumi-deploy-overview.json`) から始められます。
`/metrics` は `TAKOSUMI_METRICS_SCRAPE_TOKEN` の bearer で保護された Prometheus
形式です。
