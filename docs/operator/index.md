# オペレーター {#operator}

operator は Takosumi kernel を起動し、どの provider implementation、storage、
secret、runtime execution を使うかを決めます。account / billing / signup flow は
operator account-plane の資料で扱います。

まずは production で失ってはいけない state と credential の置き場所を決めます。
provider の attach code はその後に読めば十分です。

## 読む順序

1. [セルフホスト運用](./self-host.md) — 最小構成、production env、secret、
   storage、backup 対象を確認する。
2. [Bootstrap](./bootstrap.md) — reference kernel に kind alias map と provider
   implementation を渡す。
3. [runtime-agent 分離](./runtime-agent.md) — provider credential と executor を
   kernel host から分離する。
4. [Version Alignment](./upgrade.md) — package version / schema upgrade を確認
   する。

## Operator が決めること

| 領域                 | 例                                                              |
| -------------------- | --------------------------------------------------------------- |
| source intake        | git source、prepared source、dev / operator-local source        |
| Space / actor policy | token claim、Space visibility、namespace grant                  |
| kind resolution      | alias map、descriptor、provider implementation visibility       |
| state / secret store | Postgres、secret encryption key、backup / restore               |
| runtime execution    | embedded connector、別 host runtime-agent、cloud API credential |
| optional extensions  | DataAsset route、observability、operator UI                     |

AppSpec author は portable な intent を書きます。operator はその intent をどの
provider / runtime で実行するかを決め、Space に見える implementation set を管理
します。

## 関連 reference

- [Environment Variables](../reference/env-vars.md)
- [Installer API](../reference/installer-api.md)
- [Provider Implementations](../reference/providers.md)
- [Reference Kernel Route Inventory](../reference/kernel-http-api.md)
- [Runtime-Agent API](../reference/runtime-agent-api.md)
- [Migration / Upgrade](../reference/migration-upgrade.md)
- [Backup and Restore](../reference/backup-restore.md)
- [Observability Stack](../reference/observability-stack.md)
