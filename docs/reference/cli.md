# CLI リファレンス {#cli-reference}

> このページでわかること: Takosumi CLI のコマンド一覧とオプション。

`takosumi` CLI は **source を kernel に送る薄い client** です。 5 endpoint
([Installer API](./installer-api.md)) に対応する subcommand を持ちます。

```text
CLI の役割:
  - source を送る (= POST /v1/installations / deployments)
  - dry-run を表示する
  - rollback を呼ぶ
  - kernel server を起動する
  - migration / runtime-agent helper を提供する
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

サポート runtime は Deno 2.x。CLI 単体で動きます。

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
env、 config file の `remote_url` から resolve します。

## サブコマンド {#subcommand}

### `takosumi install --source <source>`

新規 Installation を作成。Installer API に送る source は `git`、`prepared`、
または dev / operator-local の `local` です。

```bash
# git source
takosumi install --remote https://kernel.example.com \
  --space space:personal \
  --source git:https://github.com/example/notes#main

# prepared source from an external build service
takosumi install --remote https://kernel.example.com \
  --space space:personal \
  --source prepared:https://build.example.com/snapshots/app-123.tar#sha256:...

# local path visible to the kernel process
takosumi install --remote http://localhost:8788 \
  --space space:personal \
  --source .
```

`--space <id>` は必須。`--source .` は kernel process から同じ path が見える
local dev / operator-local 起動で使います。managed remote operator では `git:`
または `prepared:` を使います。dry-run は次の subcommand で表示。

`--source` の文字列 grammar:

```text
git:<url>[#<ref>]
prepared:<url>#<sha256:hex>
<local-path>
```

`#` は最後の separator だけを source ref / digest として扱います。URL 自体に
fragment が必要な場合は encode してください。`prepared:` は build service / CI
が作った tar snapshot と digest を渡す形式です。

dry-run の expected digest guard を apply に渡す場合は次の flag を使います。

| Flag                         | 対象 source                  |
| ---------------------------- | ---------------------------- |
| `--expected-manifest-digest` | `git` / `prepared` / `local` |
| `--expected-commit`          | `git`                        |
| `--expected-source-digest`   | `prepared`                   |

### `takosumi install dry-run --source <source>`

```bash
takosumi install dry-run --space space:personal \
  --remote http://localhost:8788 \
  --source .
```

response (`changes[]` / `expected.commit` / `expected.manifestDigest` /
`expected.sourceDigest`、および operator extension field) を JSON で表示。

### `takosumi deploy <installation-id> [--source <source>]`

既存 Installation に対する apply。 `--source` 省略時は Installation 元の source
を再 fetch。dry-run から apply へ進む場合は `install` と同じ expected digest
guard flag を渡します。

```bash
takosumi deploy installation:01HM9N7XK4QY8RT2P5JZF6V3W9 --source git:https://github.com/example/notes#main
```

### `takosumi deploy dry-run <installation-id> [--source <source>]`

新 source の dry-run。

### `takosumi rollback <installation-id> <deployment-id>`

過去 Deployment を元に新 Deployment を作って巻き戻す。

```bash
takosumi rollback installation:01HM9N7XK4QY8RT2P5JZF6V3W9 deployment:01HM9N7XK4QY8RT2P5JZF6V3WA
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

## Operator extension helpers {#operator-extension-helpers}

### `takosumi artifact ...`

operator が DataAsset extension を有効化した場合だけ使う optional helper です。
upload / list / delete / GC の write 系は `TAKOSUMI_DEPLOY_TOKEN` を使う。
installer token とは分離する。

`artifact` は operator DataAsset record を扱う helper command です。prepared
source snapshot の作成や build handoff は build-service 側で扱います。

### `takosumi version`

CLI version を表示。

## グローバルフラグ {#global-flags}

| Flag             | 説明                                     |
| ---------------- | ---------------------------------------- |
| `--remote <url>` | remote kernel URL (= remote mode に切替) |
| `--token <t>`    | installer bearer token                   |
| `--space <id>`   | 対象 Space id (install で必須)           |

## 設定ファイル {#config-file}

`~/.takosumi/config.yml` :

```yaml
remote_url: https://kernel.example.com
token: <installer-token>
```

CLI flag > env > config file の優先順位。

## 関連ページ

- [Installer API](./installer-api.md) — CLI が呼ぶ HTTP endpoint
- [AppSpec](./app-spec.md) — `.takosumi.yml` 仕様
- [Reference Kernel Route Inventory](./kernel-http-api.md) — 全 HTTP surface
