# バックアップと復旧

| 守るもの | 保存先・確認先 |
| --- | --- |
| Accounts と control plane の記録 | PostgreSQL の両 schema、またはそれぞれの D1 |
| source、state、成果物 | 実際に組み込んだ artifact store のディレクトリ、または各 R2 bucket |
| 復号・署名に必要な鍵 | operator の secret store。データと別に保全 |
| 配置と互換性の記録 | 使用 commit、イメージ digest、config、migration head、restore 手順 |

Bun/PostgreSQL の参照 Compose が永続化するのは PostgreSQL と Caddy の volume です。
runner や artifact store の専用 volume は含まれません。独自に runner/artifact store を
組み込んだ環境では、その実際の保存先も backup 対象に加えます。

PostgreSQL の backup/restore は[配布構成の README](https://github.com/tako0614/takosumi/blob/main/deploy/node-postgres/README.md)
を、Cloudflare の復旧は[災害復旧](https://github.com/tako0614/takosumi/blob/main/docs/operations/disaster-recovery.md)と
[backup/restore 演習](https://github.com/tako0614/takosumi/blob/main/docs/operations/backup-restore-drills.md)を参照してください。
秘密値や raw backup は公開 repo、PR、運用ログに保存しません。

製品の Workspace export は DB 全体、artifact store、鍵の backup の代わりにはなりません。
stock Bun/PostgreSQL 配布には backup artifact store が配線されていないため、export が使えると
仮定しません。restore は隔離した空の環境で演習し、サインイン、既存記録、復号、state 読み取りまで
確認します。provider 側の実リソースは、この backup だけでは復元されません。
