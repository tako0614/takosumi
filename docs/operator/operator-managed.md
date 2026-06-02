# Operator-Managed 運用 {#operator-managed}

::: info
Public contract は [Installer API](../reference/installer-api.md) を参照。
[Operator Overview](./index.md) から始めてください。
:::

## 最小構成 {#minimal-shape}

| 役割                       | 例                                                               |
| -------------------------- | ---------------------------------------------------------------- |
| Takosumi server            | `createTakosumiService()` bootstrap server with selected adapter array   |
| metadata store             | Postgres                                                         |
| optional data blob storage | local filesystem または object store                             |
| runtime execution          | runtime-agent、または明示的に分離した embedded execution role    |
| PlatformService inventory  | static config、OpenTofu output、cloud API、account-plane record |

## 本番必須設定 {#production-required-settings}

| 設定                                                                  | 目的                                         |
| --------------------------------------------------------------------- | -------------------------------------------- |
| `TAKOSUMI_ENVIRONMENT=production`                                     | production guard を有効化する                |
| `TAKOSUMI_DATABASE_URL`                                               | Installation / Deployment の記録を永続化する |
| `TAKOSUMI_SECRET_STORE_PASSPHRASE` または `TAKOSUMI_SECRET_STORE_KEY` | secret の出力データを暗号化する              |
| `TAKOSUMI_INSTALLER_TOKEN`                                            | Installer API を呼ぶ actor を認証する        |
| `TAKOSUMI_DEV_MODE` を unset                                          | 開発用の緩い secret / storage fallback を無効化する |

production は persistent storage、secret store、locks、provider 接続設定を
実注入した operator bootstrap server で起動します。credential を持つ provider
execution は runtime-agent に分離するのが推奨です。

本番は `takosumi server` ではなく、以下のどちらかを使います:

- `createTakosumiService()` に operator-selected adapter array を渡す bootstrap server
- `takosumi` reference distribution

## Source Install Flow

Source repo は Takosumi 専用 source metadata file を持ちません。operator は account-plane UI、
policy、request body、または inventory automation から `BindingSelection` を作り、
Takosumi は PlatformService inventory から解決した binding snapshot を Deployment
に記録します。

1. `POST /v1/installations/dry-run` で `InstallPlan` と `planSnapshotDigest` を確認する。
2. reviewed source と binding selection を `expected.planSnapshotDigest` で guard して
   `POST /v1/installations` を実行する。
3. 以後の変更は deployments dry-run/apply endpoints を使う。

## Troubleshooting

| 症状                                     | 確認事項 |
| ---------------------------------------- | -------- |
| DB 接続エラー                            | `TAKOSUMI_DATABASE_URL` と Postgres の起動状態 |
| ポート競合                               | `--port` で別ポートを指定する |
| install / deploy で 401                  | `TAKOSUMI_INSTALLER_TOKEN` が一致しているか |
| secret データの復号エラー                | secret store key / passphrase が前回起動時と同じか |
| PlatformService が解決できない           | operator inventory に対象 service が公開され、binding selection が正しいか |
| adapter が見つからない                   | bootstrap server の selected adapter array に対象 backend adapter が含まれるか |

## 関連ページ

- [Operator Bootstrap](./bootstrap.md)
- [Installer API](../reference/installer-api.md)
- [Platform Services](../reference/platform-services.md)
