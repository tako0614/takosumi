# CLI Reference

> このページでわかること: Takosumi CLI のコマンド一覧とオプション。

`takosumi` CLI は **source を kernel に送る薄い client** です。 5 endpoint
([Installer API](./installer-api.md)) に対応する subcommand を持ちます。

```text
CLI の役割:
  - source を送る (= POST /v1/installations / deployments)
  - dry-run を表示する
  - rollback を呼ぶ
  - kernel server を起動する
  - artifact / migration / runtime-agent helper を提供する
```

## モード

installer command (`install` / `deploy` / `rollback`) は remote kernel を必須
とします。 `--remote`、 `TAKOSUMI_REMOTE_URL`、 または `~/.takosumi/config.yml`
で kernel URL を渡します。 ローカル開発時は `takosumi server` で kernel
を起動して、その URL を installer command に渡します。

## インストール

```bash
deno install -gA -n takosumi jsr:@takos/takosumi-cli
takosumi version
```

サポート runtime は Deno 2.x。 CLI 単体で動き、 kernel / runtime-agent の
install は不要です。

## 認証

remote command は bearer token で kernel に認証します。

| Env                        | 用途                          |
| -------------------------- | ----------------------------- |
| `TAKOSUMI_INSTALLER_TOKEN` | `/v1/installations/*` 全体    |
| `TAKOSUMI_AGENT_TOKEN`     | runtime-agent 系 internal RPC |

token は次の順序で resolve します。

1. command flag (`--token`)
2. `TAKOSUMI_INSTALLER_TOKEN` env
3. config file の `token` field

remote URL は `--remote https://kernel.example.com` か `TAKOSUMI_REMOTE_URL`
env、 config file の `remote.url` から resolve します。

## Subcommand

### `takosumi install <source>`

新規 Installation を作成。 source は git URL / local path / catalog id を受理。

```bash
# git source
takosumi install --remote https://kernel.example.com \
  --space space_personal \
  --source git:https://github.com/example/notes#main

# local source
takosumi install --remote https://kernel.example.com \
  --space space_personal \
  --source ./

# catalog id
takosumi install --remote https://kernel.example.com \
  --space space_personal \
  --source catalog:com.example.notes@1.0.0
```

`--space <id>` は必須。 dry-run は次の subcommand で表示。

### `takosumi install dry-run <source>`

```bash
takosumi install dry-run --space space_personal \
  --source git:https://github.com/example/notes#main
```

response (`changes[]` / `estimatedCost` / `expected.commit` /
`expected.manifestDigest`) を JSON で表示。

### `takosumi deploy <installation-id> [--source <source>]`

既存 Installation に対する apply。 `--source` 省略時は Installation 元の source
を再 fetch。

```bash
takosumi deploy ins_abc123 --source git:https://github.com/example/notes#main
```

### `takosumi deploy dry-run <installation-id> [--source <source>]`

新 source の dry-run。

### `takosumi rollback <installation-id> <deployment-id>`

過去 Deployment を元に新 Deployment を作って巻き戻す。

```bash
takosumi rollback ins_abc123 dep_previous
```

### `takosumi server`

kernel server を foreground 起動。 remote installer command の接続先として
使える。

```bash
takosumi server                    # port 8788
takosumi server --port 9000
```

### `takosumi init [output]`

`.takosumi.yml` AppSpec scaffold を生成。

```bash
takosumi init .takosumi.yml
takosumi init --template empty
```

### `takosumi artifact ...`

artifact store の upload / list / delete / GC。 write 系は
`TAKOSUMI_DEPLOY_TOKEN` を使う。 installer token とは分離する。

### `takosumi version`

CLI version を表示。

## Global flags

| Flag             | 説明                                     |
| ---------------- | ---------------------------------------- |
| `--remote <url>` | remote kernel URL (= remote mode に切替) |
| `--token <t>`    | installer bearer token                   |
| `--space <id>`   | 対象 Space id (install で必須)           |

## Config file

`~/.takosumi/config.yml` :

```yaml
remote_url: https://kernel.example.com
token: <installer-token>
```

CLI flag > env > config file の優先順位。

## 関連ページ

- [Installer API](./installer-api.md) — CLI が呼ぶ HTTP endpoint
- [AppSpec](./app-spec.md) — `.takosumi.yml` 仕様
- [Kernel HTTP API](./kernel-http-api.md) — 全 HTTP surface
