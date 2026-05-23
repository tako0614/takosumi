# オペレーター {#operator}

operator は Takosumi kernel と runtime-agent を起動し、provider plugin、
credential、storage、network boundary を選びます。Takosumi kernel は
account-plane ではないため、account / billing / signup flow はここでは扱い
ません。OIDC issuer など外部 surface は、必要な場合だけ namespace export として
接続します。

## 読む順序

1. [Bootstrap](./bootstrap.md) — `createPaaSApp({ kindAliases, plugins })` で
   provider plugin を attach する。
2. [セルフホスト運用](./self-host.md) — production 起動前の env、secret、
   artifact retention を確認する。
3. [runtime-agent 分離](./runtime-agent.md) — provider credential と executor を
   kernel host から分離する。
4. [Version Alignment](./upgrade.md) — package version と schema upgrade の前提
   を揃える。

## 関連 reference

- [Environment Variables](../reference/env-vars.md)
- [Installer API](../reference/installer-api.md)
- [Kernel HTTP API](../reference/kernel-http-api.md)
- [Runtime-Agent API](../reference/runtime-agent-api.md)
- [Provider plugin](../reference/providers.md)
- [Migration / Upgrade](../reference/migration-upgrade.md)
- [Backup and Restore](../reference/backup-restore.md)
- [Observability Stack](../reference/observability-stack.md)
