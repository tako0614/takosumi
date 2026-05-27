# Operator-managed 運用 {#operator-managed}

::: info
内部設計メモ public contract は [Installer API](../reference/installer-api.md) を参照。[Operator Overview](./index.md) から始めてください。
:::

## 最小構成 {#minimal-shape}

単一 VM の場合:

| 役割                       | 例                                                                       |
| -------------------------- | ------------------------------------------------------------------------ |
| Takosumi サーバー          | `createPaaSApp()` bootstrap server with reference adapter array          |
| metadata store             | Postgres                                                                 |
| optional data blob storage | local filesystem または object store                                     |
| runtime execution          | 別 host の runtime-agent、または明示的に分離した embedded execution role |

## 本番必須設定 {#production-required-settings}

| 設定                                                                  | 目的                                                |
| --------------------------------------------------------------------- | --------------------------------------------------- |
| `TAKOSUMI_ENVIRONMENT=production`                                     | production guard を有効化する                       |
| `TAKOSUMI_DATABASE_URL`                                               | Installation / Deployment の記録を永続化する        |
| `TAKOSUMI_SECRET_STORE_PASSPHRASE` または `TAKOSUMI_SECRET_STORE_KEY` | secret の出力データを暗号化する                     |
| `TAKOSUMI_INSTALLER_TOKEN`                                            | Installer API を呼ぶ actor を認証する               |
| `TAKOSUMI_DEV_MODE` を unset                                          | 開発用の緩い secret / storage fallback を無効化する |

→ [環境変数](../reference/env-vars.md)

production は persistent storage、secret store、locks、provider 接続設定を実注入した operator bootstrap server で起動します。reference Takosumi は production / staging 起動時に strict adapter set を検査します。

credential を持つ provider execution は runtime-agent に分離するのが推奨です。embedded local adapter connector を使う場合も、Takosumi の control-plane role と credential-bearing execution role を設定上分けてください。単一 host 構成として operator が明示管理します。

本番は `takosumi server` ではなく、以下のどちらかを使います:

- `createPaaSApp()` に `kindAliases` と reference adapter array (`plugins` option) を渡す operator bootstrap server
- takosumi-cloud の reference distribution

## 単一 VM で動かす {#single-vm}

この例は [operator bootstrap](./bootstrap.md) で kind package adapter を attach した TypeScript bootstrap server を起動する前提。

```yaml
apiVersion: v1
metadata:
  id: com.example.api
  name: Example API
components:
  db:
    kind: postgres
    spec:
      version: "16"
      size: small
  api:
    kind: web-service
    connect:
      db:
        output: db.connection
        inject: secret-env
        prefix: DATABASE
    spec:
      image: ghcr.io/example/api:sha-...
      port: 8080
      scale:
        min: 1
        max: 2
publish:
  api-database:
    output: db.connection
    path: acme.database.reporting
```

storage path を固定する:

```bash
export TAKOSUMI_ENVIRONMENT=production
export TAKOSUMI_DATABASE_URL=postgresql://localhost/takosumi
export TAKOSUMI_SECRET_STORE_PASSPHRASE=$(openssl rand -base64 32)
export TAKOSUMI_INSTALLER_TOKEN=$(openssl rand -hex 32)

export TAKOSUMI_LOCAL_ADAPTER_OBJECT_STORE_ROOT=/var/lib/takosumi/objects
export TAKOSUMI_LOCAL_ADAPTER_SYSTEMD_UNIT_DIR=/etc/systemd/system

deno run -A ./server.ts
```

::: danger passphrase は必ず永続化してください `TAKOSUMI_SECRET_STORE_PASSPHRASE` はシェルセッション終了で消失します。紛失すると暗号化済みの全 secret データが復号不能になります。生成後すぐに永続化してください。

```bash
# 例: ファイルに保存する場合
echo "$TAKOSUMI_SECRET_STORE_PASSPHRASE" > /etc/takosumi/passphrase
chmod 600 /etc/takosumi/passphrase
```

本番では secret manager（HashiCorp Vault、AWS Secrets Manager 等）での管理を推奨します。`TAKOSUMI_INSTALLER_TOKEN` も同様に永続化してください。 :::

`server.ts` は [オペレーターブートストラップ](./bootstrap.md) の reference adapter array (`plugins` option) 例を使います。 `takosumi server` は stock dev entrypoint であり、この section の local adapter array は読み込みません。

別 shell から apply します。

```bash
takosumi install --space space:personal --source . \
  --remote http://localhost:8788 \
  --token "$TAKOSUMI_INSTALLER_TOKEN"
```

`--source .` は Takosumi プロセスから同じ filesystem path が見える単一 VM / operator local 構成で使います。Takosumi と source checkout が分かれる構成では、git source または build service が作ったビルド済みアーカイブを渡します。

`http://localhost` remote は Takosumi と CLI が同じ machine / trust boundary にある operator-local loopback 専用です。LAN 上の別 client や public hostname から使う場合は HTTPS で公開した Takosumi / アカウント管理 endpoint を指定します。

## 本番で分離するもの {#production-split}

本番では以下を分離する:

| 分離対象                   | 理由                                                         |
| -------------------------- | ------------------------------------------------------------ |
| Takosumi と Postgres       | metadata store の backup / upgrade を独立させる              |
| Takosumi と runtime-agent  | cloud credential や OS executor を Takosumi プロセスから離す |
| optional data blob storage | asset upload / retention を使う場合に Takosumi disk と分ける |
| ingress / TLS              | public hostname、CORS、CSRF、OAuth callback を一元管理する   |

→ [runtime-agent 分離](./runtime-agent.md)

## Optional asset extension {#asset-limits}

asset upload / discovery extension を有効化する operator の設定では、 upload を memory に載せすぎないように size guard と storage を固定します。

- asset storage を local temporary disk ではなく永続 store に置く。
- `TAKOSUMI_ARTIFACT_FETCH_TOKEN` を installer token と別にする。
- CI からの upload size が backend / reverse proxy の request size 上限に収まることを確認する。

## Backup {#backup}

最低限の backup 対象:

- **secret store key または passphrase（最重要 -- 紛失すると全 secret データが復号不能）**
- Postgres database
- asset storage (extension を有効化している場合)
- operator が runtime-agent / backend binding に渡す credential の保管場所

→ [Backup / Restore](../reference/backup-restore.md)

## Observability {#observability}

Takosumi / runtime-agent / Deployment の logs を `operationId` で追跡する。

→ [Observability](../reference/observability-stack.md) / [Telemetry](../reference/telemetry-metrics.md)

## トラブルシューティング {#troubleshooting}

| 症状                                           | 確認事項                                                                                                |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `takosumi server` 起動時に DB 接続エラー       | `TAKOSUMI_DATABASE_URL` の値と Postgres の起動状態を確認。接続文字列の host / port / database 名。      |
| ポート競合で起動できない                       | `--port` で別ポートを指定するか、競合するプロセスを停止。                                               |
| install / deploy で 401 が返る                 | `TAKOSUMI_INSTALLER_TOKEN` が server 側と client 側で一致しているか確認。                               |
| secret データの復号エラー                      | `TAKOSUMI_SECRET_STORE_PASSPHRASE` が前回起動時と同じ値か確認。異なる値では既存 secret を復号できない。 |
| `kind` が解決できない（`unknown kind` エラー） | operator bootstrap で `kindAliases` が設定されているか確認。CLI の dev mode では reference alias のみ。 |
