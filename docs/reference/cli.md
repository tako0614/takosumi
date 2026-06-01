# CLI リファレンス {#cli-reference}

`takosumi` CLI は Installer API を呼ぶ薄い client です。

```text
takosumi install --space <id> --source <source>
takosumi install dry-run --space <id> --source <source>
takosumi deploy <installation-id> [--source <source>]
takosumi deploy dry-run <installation-id> [--source <source>]
takosumi rollback <installation-id> <deployment-id>
takosumi server [--port 8788]
takosumi init [output]
takosumi version
```

## Install

```bash
takosumi install --remote https://takosumi.example.com \
  --space space_personal \
  --source git:https://github.com/example/notes#v1.2.3
```

Source grammar:

```text
git:<url>#<ref>
prepared:<url>#<sha256:hex>
<local-path>
```

managed remote operator では `git:` または `prepared:` を使います。`<local-path>` は kernel process から同じ path が見える
single-host dev / operator-local 用です。

Dry-run の expected guard を apply に渡す場合:

| Flag | 対象 |
| --- | --- |
| `--expected-plan-snapshot-digest` | dry-run で review した InstallPlan snapshot |
| `--expected-commit` | git source |
| `--expected-source-digest` | prepared source |

## Install dry-run

```bash
takosumi install dry-run --space space_personal \
  --remote http://localhost:8788 \
  --source .
```

response は JSON で表示されます。主な field は `installPlan`、`planSnapshotDigest`、`changes[]`、`expected` です。

## Deploy

```bash
takosumi deploy inst_01HM9N7XK4QY8RT2P5JZF6V3W9 \
  --source git:https://github.com/example/notes#v1.2.4
```

既存 Installation に対する apply です。dry-run から apply へ進む場合は `--expected-current-deployment-id` も渡します。

## Rollback

```bash
takosumi rollback inst_01HM9N7XK4QY8RT2P5JZF6V3W9 dep_01HM9N7XK4QY8RT2P5JZF6V3WA
```

Installation の current Deployment pointer を過去 Deployment に戻します。新しい Deployment は作りません。

## Server

```bash
takosumi server
takosumi server --port 9000
```

ローカル Installer API server を foreground 起動します。

## Init

```bash
takosumi init
takosumi init package.json
```

`init` は Takosumi 専用 source metadata file ではなく、generic repo metadata の starter を作ります。

## 設定

Remote URL:

1. `--remote`
2. `TAKOSUMI_REMOTE_URL`
3. `~/.takosumi/config.yml`

Token:

1. `--token`
2. `TAKOSUMI_INSTALLER_TOKEN`
3. `~/.takosumi/config.yml`

```yaml
remote_url: https://takosumi.example.com
token: <installer-token>
```

## 関連ページ

- [Installer API](./installer-api.md)
- [プラットフォームサービス](./platform-services.md)
- [ビルドサービス境界](./build-spec.md)
