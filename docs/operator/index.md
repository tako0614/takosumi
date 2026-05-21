# オペレーター {#operator}

operator は Takosumi kernel と runtime-agent を起動し、provider plugin、
credential、storage、network boundary を選びます。Takosumi kernel は
account-plane ではないため、billing / OIDC issuer / signup flow はここでは扱い
ません。

## 読む順序

1. [Bootstrap](./bootstrap.md) — `createPaaSApp({ plugins })` で provider plugin
   を attach する。
2. [Self-host Notes](./self-host.md) — production 起動前の env、secret、
   runtime-agent、artifact retention を確認する。
3. [Version Alignment](./upgrade.md) — package version と schema upgrade の前提
   を揃える。

## 関連 reference

- [Environment Variables](../reference/env-vars.md)
- [Installer API](../reference/installer-api.md)
- [Kernel HTTP API](../reference/kernel-http-api.md)
- [Runtime-Agent API](../reference/runtime-agent-api.md)
- [Provider Plugins](../reference/providers.md)
- [Migration / Upgrade](../reference/migration-upgrade.md)
- [Backup and Restore](../reference/backup-restore.md)
- [Observability Stack](../reference/observability-stack.md)
