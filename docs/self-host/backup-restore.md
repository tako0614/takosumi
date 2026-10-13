# バックアップと復旧

| 守るもの | 保存先・確認先 |
| --- | --- |
| Accounts と control plane の記録 | PostgreSQL の両 schema、またはそれぞれの D1 |
| source、state、成果物 | 実際に組み込んだ artifact store のディレクトリ、または各 R2 bucket |
| 復号・署名に必要な鍵 | operator の secret store。データと別に保全 |
| 配置と互換性の記録 | 使用 commit、イメージ digest、config、migration head、restore 手順 |

Bun/PostgreSQL の参照 Compose は PostgreSQL、Caddy と `takosumi-runtime` volume を
永続化します。control / pre-destroy export は `TAKOSUMI_BACKUP_ARTIFACTS_DIR`
(既定 `/var/lib/takosumi/backups`) に保存します。directory は実行ユーザー所有の 0700、
file は 0600 で、bundle は既存の secret-store 鍵で sealed 保存します。public artifact
manifest だけは平文です。保存名は opaque ref の SHA-256 hex に `.artifact` を付けたものです。
runner は同梱されません。独自の runner/state/artifact store の保存先も backup 対象に加えます。

PostgreSQL の backup/restore は[配布構成の README](https://github.com/tako0614/takosumi/blob/main/deploy/node-postgres/README.md)
を、Cloudflare の復旧は[災害復旧](https://github.com/tako0614/takosumi/blob/main/docs/operations/disaster-recovery.md)と
[backup/restore 演習](https://github.com/tako0614/takosumi/blob/main/docs/operations/backup-restore-drills.md)を参照してください。
秘密値や raw backup は公開 repo、PR、運用ログに保存しません。

製品の Workspace export は DB 全体、artifact store、鍵の backup の代わりにはなりません。
参照 Compose は file backup store を配線します。uninstall の 7 日 grace 中は Capsule backup
API で export でき、期限後の finalizer も destroy 前に export を試みます。適用済み state を含める
独自 runner 構成では、その sealed state store の `backupStateObjectReader` を host から明示的に
接続します。読み取り口や state object が無い場合は export 失敗として記録され、#422 の既存方針では
失敗後も teardown が進みます。volume と鍵は別に保全します。
restore は隔離した空の環境で演習し、サインイン、既存記録、復号、state 読み取りまで
確認します。provider 側の実リソースは、この backup だけでは復元されません。
