# オペレーター {#operator}

operator は Takosumi kernel を起動し、どの provider implementation、storage、
secret、runtime execution を使うかを決めます。account / billing / signup flow は
operator account-plane の資料で扱います。Takosumi Cloud を使う場合は
[Takosumi Cloud](../reference/takosumi-cloud.md) から参照します。

### 前提知識

- [Deno](https://docs.deno.com/runtime/getting_started/installation/) 2.x
  runtime の基本的な使い方
- Postgres の運用経験（metadata store として使用）
- DNS / TLS 設定の基礎知識（public ingress を構成する場合）

## 読む順序

1. [Bootstrap](./bootstrap.md) — reference kernel に kind alias map と provider
   implementation を渡す。
2. [セルフホスト運用](./self-host.md) — provider attach 済み server
   を前提に、production env、secret、 storage、backup 対象を確認する。
3. [runtime-agent 分離](./runtime-agent.md) — provider credential と executor を
   kernel host から分離する。
4. [Operator build-service profile](./build-service-profile.md) — build service
   が prepared source を作る場合の非 normative profile 例を確認する。
5. [Version Alignment](./upgrade.md) — package version / schema upgrade を確認
   する。
6. [Readiness Probes](../reference/readiness-probes.md) — `/readyz` / `/livez`
   と operator ingress / supervisor の分担を確認する。

## Operator が決めること

| 領域                 | 例                                                              |
| -------------------- | --------------------------------------------------------------- |
| source intake        | git source、prepared source、dev / operator-local source        |
| Space / actor policy | token claim、Space visibility、external publication grant       |
| kind resolution      | alias map、descriptor、provider implementation visibility       |
| state / secret store | Postgres、secret encryption key、backup / restore               |
| runtime execution    | embedded connector、別 host runtime-agent、cloud API credential |
| optional extensions  | DataAsset route、observability、operator UI                     |

## 関連 reference

- [Environment Variables](../reference/env-vars.md)
- [Installer API](../reference/installer-api.md)
- [Prepared Source Handoff](../reference/build-spec.md)
- [Provider Implementations](../reference/providers.md)
- [Readiness Probes](../reference/readiness-probes.md)
- [Backup and Restore](../reference/backup-restore.md)
