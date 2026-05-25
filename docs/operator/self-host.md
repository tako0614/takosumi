# セルフホスト運用 {#self-host}

## 最小構成 {#minimal-shape}

単一 VM の場合:

| 役割                       | 例                                                                       |
| -------------------------- | ------------------------------------------------------------------------ |
| kernel                     | `createPaaSApp()` bootstrap server with reference adapter array          |
| metadata store             | Postgres                                                                 |
| optional data blob storage | local filesystem または object store                                     |
| runtime execution          | 別 host の runtime-agent、または明示的に分離した embedded execution role |

## 本番必須設定 {#production-required-settings}

| 設定                                                                  | 目的                                                |
| --------------------------------------------------------------------- | --------------------------------------------------- |
| `TAKOSUMI_ENVIRONMENT=production`                                     | production guard を有効化する                       |
| `TAKOSUMI_DATABASE_URL`                                               | Installation / Deployment record を永続化する       |
| `TAKOSUMI_SECRET_STORE_PASSPHRASE` または `TAKOSUMI_SECRET_STORE_KEY` | secret material を暗号化する                        |
| `TAKOSUMI_INSTALLER_TOKEN`                                            | 5 endpoint Installer API を呼ぶ actor を認証する    |
| `TAKOSUMI_DEV_MODE` を unset                                          | 開発用の緩い secret / storage fallback を無効化する |

→ [環境変数](../reference/env-vars.md)

production は persistent storage、secret store、locks、provider bindings を実注
入した operator bootstrap server で起動します。reference kernel は production /
staging 起動時に strict adapter set を検査します。credential を持つ provider
execution は runtime-agent に分離するのが推奨です。embedded self-host connector
を使う場合も、kernel core/control-plane role と credential-bearing execution
role を設定上分け、単一 host profile として operator が明示管理します。本番は
`takosumi server` では なく、`createPaaSApp()` に `kindAliases` と reference
adapter array (`plugins` option) を渡す operator bootstrap server
か、takosumi-cloud の reference distribution を使ってください。

## 単一 VM で動かす {#single-vm}

この例は [operator bootstrap](./bootstrap.md) で provider を attach した
TypeScript bootstrap server を起動する前提。

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
    publish:
      connection:
        as: service-binding
  api:
    kind: web-service
    listen:
      db:
        from: db.connection
        as: secret-env
        prefix: DATABASE
    spec:
      image: ghcr.io/example/api:sha-...
      port: 8080
      scale:
        min: 1
        max: 2
```

storage path を固定する:

```bash
export TAKOSUMI_ENVIRONMENT=production
export TAKOSUMI_DATABASE_URL=postgresql://localhost/takosumi
export TAKOSUMI_SECRET_STORE_PASSPHRASE=$(openssl rand -base64 32)
export TAKOSUMI_INSTALLER_TOKEN=$(openssl rand -hex 32)

export TAKOSUMI_SELFHOSTED_OBJECT_STORE_ROOT=/var/lib/takosumi/objects
export TAKOSUMI_SELFHOSTED_SYSTEMD_UNIT_DIR=/etc/systemd/system

deno run -A ./server.ts
```

::: danger passphrase は必ず永続化してください
`TAKOSUMI_SECRET_STORE_PASSPHRASE` はシェルセッション終了で消失します。紛失
すると暗号化済みの全 secret material が復号不能になります。生成後すぐに永続化
してください。

```bash
# 例: ファイルに保存する場合
echo "$TAKOSUMI_SECRET_STORE_PASSPHRASE" > /etc/takosumi/passphrase
chmod 600 /etc/takosumi/passphrase
```

本番では secret manager（HashiCorp Vault、AWS Secrets Manager 等）での管理を
推奨します。`TAKOSUMI_INSTALLER_TOKEN` も同様に永続化してください。 :::

`server.ts` は [オペレーターブートストラップ](./bootstrap.md) の reference
adapter array (`plugins` option) 例を使います。 `takosumi server` は stock dev /
wrapper entrypoint であり、この section の self-host provider array
は読み込みません。

別 shell から apply します。

```bash
takosumi install --space space:personal --source . \
  --remote http://localhost:8788 \
  --token "$TAKOSUMI_INSTALLER_TOKEN"
```

`--source .` は kernel process から同じ filesystem path が見える単一 VM /
operator local 構成で使います。kernel と source checkout が分かれる構成では、git
source または build service が作った prepared source を渡します。
`http://localhost` remote は kernel と CLI が同じ machine / trust boundary
にある operator-local loopback 専用です。LAN 上の別 client や public hostname
から使う場合は HTTPS で公開した kernel / account-plane endpoint を指定します。

## 本番で分離するもの {#production-split}

本番では以下を分離する:

| 分離対象                   | 理由                                                           |
| -------------------------- | -------------------------------------------------------------- |
| kernel と Postgres         | metadata store の backup / upgrade を独立させる                |
| kernel と runtime-agent    | cloud credential や OS executor を kernel process から離す     |
| optional data blob storage | DataAsset upload / retention を使う場合に kernel disk と分ける |
| ingress / TLS              | public hostname、CORS、CSRF、OAuth callback を一元管理する     |

→ [runtime-agent 分離](./runtime-agent.md)

## Optional DataAsset extension {#artifact-limits}

DataAsset upload / discovery extension を有効化する operator distribution では、
upload を memory に載せすぎないように size guard と storage を固定します。

- DataAsset storage を local temporary disk ではなく永続 store に置く。
- `TAKOSUMI_ARTIFACT_FETCH_TOKEN` を installer token と別にする。
- CI からの upload size が provider / reverse proxy の request size 上限に収まる
  ことを確認する。

## Backup {#backup}

最低限の backup 対象:

- **secret store key または passphrase（最重要—紛失すると全 secret
  が復号不能）**
- Postgres database
- DataAsset storage (extension を有効化している場合)
- operator が runtime-agent / provider に渡す credential の保管場所

→ [Backup / Restore](../reference/backup-restore.md)

## Observability {#observability}

kernel / runtime-agent / Deployment の logs を `operationId` で追跡する。

→ [Observability](../reference/observability-stack.md) /
[Telemetry](../reference/telemetry-metrics.md)

## トラブルシューティング {#troubleshooting}

| 症状                                           | 確認事項                                                                                                |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `takosumi server` 起動時に DB 接続エラー       | `TAKOSUMI_DATABASE_URL` の値と Postgres の起動状態を確認。接続文字列の host / port / database 名。      |
| ポート競合で起動できない                       | `--port` で別ポートを指定するか、競合するプロセスを停止。                                               |
| install / deploy で 401 が返る                 | `TAKOSUMI_INSTALLER_TOKEN` が server 側と client 側で一致しているか確認。                               |
| secret material の復号エラー                   | `TAKOSUMI_SECRET_STORE_PASSPHRASE` が前回起動時と同じ値か確認。異なる値では既存 secret を復号できない。 |
| `kind` が解決できない（`unknown kind` エラー） | operator bootstrap で `kindAliases` が設定されているか確認。CLI の dev mode では reference alias のみ。 |
