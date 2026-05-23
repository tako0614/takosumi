# セルフホスト運用 {#self-host}

> このページでわかること: Takosumi kernel を自分の VM / private network で運用
> する最小構成と、本番で必ず固定する設定。

まず動かすだけなら [クイックスタート](../getting-started/quickstart.md) から始め
てください。このページは、開発用の一時起動ではなく、Deployment record と secret
を失わない運用構成を作るための runbook です。

## 最小構成 {#minimal-shape}

単一 VM で始める場合、役割は次の 4 つです。

| 役割              | 例                                                          |
| ----------------- | ----------------------------------------------------------- |
| kernel            | `takosumi server`                                           |
| metadata store    | Postgres                                                    |
| artifact storage  | local filesystem または object store                        |
| runtime execution | embedded self-host connector または別 host の runtime-agent |

開発用途では in-memory store や local filesystem で十分です。本番では Postgres
を使い、暗号化 key も必ず明示します。

## 本番必須設定 {#production-required-settings}

| 設定                                                                  | 目的                                                    |
| --------------------------------------------------------------------- | ------------------------------------------------------- |
| `TAKOSUMI_ENVIRONMENT=production`                                     | production guard を有効化する                           |
| `TAKOSUMI_DATABASE_URL`                                               | Installation / Deployment record を永続化する           |
| `TAKOSUMI_SECRET_STORE_PASSPHRASE` または `TAKOSUMI_SECRET_STORE_KEY` | secret material を暗号化する                            |
| `TAKOSUMI_INSTALLER_TOKEN`                                            | `/v1/installations/*` を呼ぶ actor を認証する           |
| `TAKOSUMI_ARTIFACT_FETCH_TOKEN`                                       | artifact fetch / delete route を installer token と分離 |
| `TAKOSUMI_DEV_MODE` を unset                                          | 開発用の緩い secret / storage fallback を無効化する     |

各 env の詳細は [環境変数](../reference/env-vars.md) を参照してください。

## 単一 VM で動かす {#single-vm}

source root には AppSpec として `.takosumi.yml` を置きます。

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
      - com.example.api.db
  api:
    kind: web-service
    listen:
      com.example.api.db:
        as: env
        prefix: DATABASE
    spec:
      image: ghcr.io/example/api:sha-...
      port: 8080
      scale:
        min: 1
        max: 2
```

source から artifact を作る場合は、同じ source root に `.takosumi.build.yml`
を置きます。build service / CI で先に resolved bundle を作ります。kernel は VM
上で build command を直接実行しません。

VM 側では kernel と self-host provider が使う storage path を固定します。

```bash
export TAKOSUMI_ENVIRONMENT=production
export TAKOSUMI_DATABASE_URL=postgresql://localhost/takosumi
export TAKOSUMI_SECRET_STORE_PASSPHRASE=$(openssl rand -base64 32)
export TAKOSUMI_INSTALLER_TOKEN=$(openssl rand -hex 32)
export TAKOSUMI_ARTIFACT_FETCH_TOKEN=$(openssl rand -hex 32)

export TAKOSUMI_SELFHOSTED_OBJECT_STORE_ROOT=/var/lib/takosumi/objects
export TAKOSUMI_SELFHOSTED_SYSTEMD_UNIT_DIR=/etc/systemd/system

takosumi server --port 8788
```

別 shell から apply します。

```bash
takosumi install --space space_personal --source . \
  --remote http://localhost:8788 \
  --token "$TAKOSUMI_INSTALLER_TOKEN"
```

## 本番で分離するもの {#production-split}

単一 VM は動作確認に向いています。本番では次を分けると、credential の到達範囲と
障害の切り分けが明確になります。

| 分離対象                | 理由                                                       |
| ----------------------- | ---------------------------------------------------------- |
| kernel と Postgres      | metadata store の backup / upgrade を独立させる            |
| kernel と runtime-agent | cloud credential や OS executor を kernel process から離す |
| artifact storage        | 大きい artifact upload / retention を kernel disk と分ける |
| ingress / TLS           | public hostname、CORS、CSRF、OAuth callback を一元管理する |

runtime-agent を別 host に置く手順は [runtime-agent 分離](./runtime-agent.md)
を参照してください。

## Artifact と upload 上限 {#artifact-limits}

kernel は artifact upload を memory に載せすぎないように size guard を持ちます。
大きい artifact を扱う operator は、次を固定してください。

- artifact storage を local temporary disk ではなく永続 store に置く。
- `TAKOSUMI_ARTIFACT_FETCH_TOKEN` を installer token と別にする。
- CI からの upload size が provider / reverse proxy の request size 上限に収まる
  ことを確認する。

## Backup {#backup}

最低限 backup する対象は次です。

- Postgres database
- secret store key または passphrase
- artifact storage
- operator が runtime-agent / provider に渡す credential の保管場所

restore 手順と retention は [Backup / Restore](../reference/backup-restore.md)
を参照してください。

## Observability {#observability}

self-host でも kernel logs、runtime-agent logs、Deployment condition、provider
observation を同じ `operationId` で追えるようにしてください。metric 名と panel
設計は [Observability](../reference/observability-stack.md) と
[Telemetry / Metrics](../reference/telemetry-metrics.md) を参照してください。
