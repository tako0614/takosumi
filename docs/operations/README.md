# Takosumi Operator Runbooks

このディレクトリは、Takosumi を自分の利用者向けに運用する人のための runbook です。
利用者向けの機能説明ではなく、deploy、migration、backup、障害対応などの具体的な作業を
扱います。これらは not published product docs であり、not customer-facing です。
公開 website には含めません。

Takosumi Cloud は退役した historical identity です。Stripe、retail、managed capacity、
Takoserver provider credential、本番環境の hosted service 手順はこの OSS runbook の責任
ではありません。Takosumi Hosted は retail/commerce/client composition、Takoserver は
managed supply、capacity、Offering、provider execution の runbook をそれぞれ所有します。

## 最初に確認すること

本番環境では、変更を始める前に次を用意してください。

1. 対象 commit と、そこから作った artifact の digest
2. database migration の plan と backup
3. deploy 後に確認する endpoint と期待結果
4. 以前の版へ戻す手順。戻せない変更なら forward repair の手順
5. secret、認証、課金、データ削除を変える場合の独立した review

リポジトリの総合検査は `bun run check`、deploy contract の確認は
`bun run deploy -- --contract` です。実際の deploy は、その出力と各 runbook を読んで
から行います。

編集中の内周ループには `bun run check:fast` があります。これは `bun run check` から
dashboard bundle build と 2 つの browser suite だけを外した同じ phase 列で、他は
一切省きません。handoff の gate は `bun run check` のままで、`check:fast` は
その代わりにはなりません。

## 目的から選ぶ

### Deploy と rollback

- [platform worker を deploy する](./platform-worker-deploy.md)
- [構成ごとの注意点](./deploy-topology-notes.md)
- [release artifact](./release-artifacts.md)
- [v1 release](./takosumi-v1-release.md)
- [rollback](./rollback-sop.md)

### Database と保存データ

- [D1 schema の事前反映](./control-d1-schema-predeploy.md)
- [online migration](./online-db-migrations.md)
- [backup と restore の訓練](./backup-restore-drills.md)
- [disaster recovery](./disaster-recovery.md)
- [Resource state の取り込み](./resource-state-adoption.md)
- [Output / Interface migration](./output-interface-migration.md)
- [FormRef migration](./exact-formref-migration.md)

### Security

- [threat model](./security-threat-model.md)
- [runner sandbox](./runner-sandbox-security.md)
- [secret rotation](./secret-rotation.md)
- [patch management](./patch-management.md)
- [vulnerability response](./vulnerability-response.md)

### 日常運用と障害対応

- [troubleshooting](./troubleshooting.md)
- [incident response](./incident-response.md)
- [on-call](./oncall.md)
- [cost monitoring](./cost-monitoring.md)
- [ローカルネットワークでの開発](./lan-dev-setup.md)

### Retired Resource と Form migration

- [Form package の導入](./form-package-installation.md) (migration only)
- [Form Host Support と activation](./form-host-support.md) (migration only)

Resource Shape、Form Registry、FormActivation、TargetPool、SpacePolicy と Generic
Offering の route/store は supported authoring ではありません。ここにある手順は既存
データの migration/delete custody のためだけです。managed Offering と Host は Takoserver
の authority です。

## 公開仕様との関係

利用者に保証する挙動は [software docs](../index.md) と
[API reference](../reference/api.md)に書きます。runbook にしかない手順や内部名を、
利用者向け仕様として扱わないでください。

逆に、利用者に見える動作を変えた場合は runbook だけで終わらせず、公開 docs も更新します。
