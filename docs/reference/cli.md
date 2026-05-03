# CLI Reference

`takosumi` CLI は kernel と通信するための薄いフロントエンドです。 全
subcommand は `packages/cli/src/commands/*.ts` の cliffy `Command` 定義から
描き起こしています。

## Install

```bash
deno install -gA -n takosumi jsr:@takos/takosumi-cli
takosumi version
```

CLI は kernel / runtime-agent と無関係に install できます — manifest を flag
だけで完結させたい場合は `--remote` を毎回指定すれば、CLI host 側に環境変数
を残す必要はありません。

## Subcommand 一覧

| Command                        | 概要                                                                        |
| ------------------------------ | --------------------------------------------------------------------------- |
| `deploy <manifest>`            | Apply a Takosumi manifest                                                   |
| `destroy <manifest>`           | Destroy resources declared in a Takosumi manifest                           |
| `status [name]`                | Show current deployment status (remote kernel only)                         |
| `plan <manifest>`              | Print the resolved plan without applying                                    |
| `server`                       | Start the Takosumi kernel HTTP server                                       |
| `migrate`                      | Run Takosumi DB migrations                                                  |
| `init [output]`                | Scaffold a Takosumi manifest                                                |
| `artifact <push\|list\|rm\|gc\|kinds>` | Manage Takosumi-kernel artifact uploads (push / list / rm / gc / kinds) |
| `runtime-agent <serve\|list\|verify>`  | Operate the Takosumi runtime-agent                                  |
| `completions <shell>`          | Cliffy 同梱 (bash / zsh / fish の completion script を出力)                |
| `version`                      | Show takosumi CLI version                                                   |

---

### `takosumi deploy <manifest>`

> Apply a Takosumi manifest

| Flag                    | 説明                                                            |
| ----------------------- | --------------------------------------------------------------- |
| `--remote <url:string>` | Remote kernel URL                                               |
| `--token <token:string>` | Auth token                                                     |
| `--dry-run`             | Validate only, do not apply                                     |

`--remote` が無いときは in-process kernel を起動して local 適用 (state
は process 終了で消えます)。

```bash
takosumi deploy ./manifest.yml
takosumi deploy ./manifest.yml --remote https://kernel.example.com --token $TAKOSUMI_DEPLOY_TOKEN
takosumi deploy ./manifest.yml --dry-run
```

### `takosumi destroy <manifest>`

> Destroy resources declared in a Takosumi manifest

| Flag                     | 説明                                                                                                                                           |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `--remote <url:string>`  | Remote kernel URL                                                                                                                              |
| `--token <token:string>` | Auth token                                                                                                                                     |
| `--force`                | Force destroy by resource name even when no prior apply record exists. Safe for self-hosted resources (filesystem, docker, systemd); cloud resources whose handle differs from the resource name will likely fail to delete. |

```bash
takosumi destroy ./manifest.yml --remote https://kernel.example.com --token $TAKOSUMI_DEPLOY_TOKEN
takosumi destroy ./manifest.yml --force      # local / selfhosted only
```

### `takosumi status [name]`

> Show current deployment status (remote kernel only)

| Flag                     | 説明              |
| ------------------------ | ----------------- |
| `--remote <url:string>`  | Remote kernel URL |
| `--token <token:string>` | Auth token        |

local mode では deployment state を持たないため、`--remote` 指定が必須です。
`GET /v1/deployments` または `GET /v1/deployments/<name>` を叩いて結果を表で
描画します。

```bash
takosumi status --remote https://kernel.example.com --token $T
takosumi status my-app --remote https://kernel.example.com --token $T
```

### `takosumi plan <manifest>`

> Print the resolved plan without applying

flag は無し。`manifest_loader` が読んだ JSON / YAML を解決後の JSON として
stdout に整形出力します。

```bash
takosumi plan ./manifest.yml
```

### `takosumi server`

> Start the Takosumi kernel HTTP server

| Flag                       | 説明                                                                                                                                       | Default     |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ----------- |
| `--port <port:number>`     | Port to listen on                                                                                                                          | `8788`      |
| `--agent-port <port:number>` | Port for the embedded runtime-agent (only used when `TAKOSUMI_AGENT_URL` is unset)                                                       | `8789`      |
| `--no-agent`               | Skip starting the embedded runtime-agent (operator must run one separately)                                                                | (off)       |
| `--detach`                 | Print a recommended systemd unit for production daemonization and exit immediately. Deno does not provide a portable detach primitive, so we surface the supervisor template instead of half-baked daemonising. | (off) |

::: tip --detach は template print
`--detach` は実際に detach せず、systemd unit / docker-compose snippet / nohup
one-liner を stdout に出して終了します (Deno に portable な detach primitive
が無いため supervisor 任せにします)。
:::

```bash
takosumi server                                # local: kernel + embedded agent
takosumi server --port 9000 --agent-port 9001
takosumi server --no-agent                     # external agent を別に起動済み
takosumi server --detach > takosumi-api.service
```

### `takosumi migrate`

> Run Takosumi DB migrations

| Flag                  | 説明                                              | Default  |
| --------------------- | ------------------------------------------------- | -------- |
| `--dry-run`           | Show planned migrations without applying          | (off)    |
| `--env <env:string>`  | Target environment (local, staging, production)  | `local`  |

`--env` ごとに優先される DATABASE_URL keys は次の通りです:

| Env         | 優先順                                                                       |
| ----------- | ---------------------------------------------------------------------------- |
| local       | `TAKOSUMI_DATABASE_URL` → `DATABASE_URL`                                     |
| staging     | `TAKOSUMI_STAGING_DATABASE_URL` → `TAKOSUMI_DATABASE_URL` → `DATABASE_URL`   |
| production  | `TAKOSUMI_PRODUCTION_DATABASE_URL` → `TAKOSUMI_DATABASE_URL` → `DATABASE_URL` |

```bash
takosumi migrate --env local --dry-run
TAKOSUMI_DATABASE_URL=postgres://localhost/takosumi takosumi migrate --env local
TAKOSUMI_PRODUCTION_DATABASE_URL=postgres://prod/takosumi takosumi migrate --env production
```

### `takosumi init [output]`

> Scaffold a Takosumi manifest

| Flag                       | 説明                                                  | Default                  |
| -------------------------- | ----------------------------------------------------- | ------------------------ |
| `--template <name:string>` | Template (`selfhosted-single-vm` \| `empty`)          | `selfhosted-single-vm`   |

`output` 引数を渡すとそのファイルに書き出し、省略すると stdout に出力します。

```bash
takosumi init manifest.yml
takosumi init --template empty manifest.yml
takosumi init                              # stdout
```

### `takosumi artifact ...`

> Manage Takosumi-kernel artifact uploads (push / list / rm / gc / kinds)

artifact 系は **すべて remote 必須**: `--remote` + `--token` (または
`TAKOSUMI_REMOTE_URL` + `TAKOSUMI_DEPLOY_TOKEN`) を解決できないと exit code 2
で失敗します。

#### `artifact push <file>`

> Upload a file as a content-addressed artifact

| Flag                       | 説明                                                          |
| -------------------------- | ------------------------------------------------------------- |
| `--kind <kind:string>` *(required)* | Artifact kind (e.g. `js-bundle`, `lambda-zip`, `oci-image`) |
| `--metadata <kv:string>`   | Metadata as `key=value` (repeat for multiple)                 |
| `--remote <url:string>`    | Kernel base URL                                               |
| `--token <token:string>`   | Bearer token                                                  |

#### `artifact list`

> List artifacts stored in the kernel

| Flag                     | 説明                                                          |
| ------------------------ | ------------------------------------------------------------- |
| `--remote <url:string>`  | Kernel base URL                                               |
| `--token <token:string>` | Bearer token                                                  |
| `--limit <n:number>`     | Per-page limit; CLI follows pagination automatically          |

#### `artifact rm <hash>`

> Remove an artifact by hash

| Flag                     | 説明              |
| ------------------------ | ----------------- |
| `--remote <url:string>`  | Kernel base URL   |
| `--token <token:string>` | Bearer token      |

#### `artifact gc`

> Garbage-collect artifacts not referenced by any persisted deployment

| Flag                     | 説明                                                |
| ------------------------ | --------------------------------------------------- |
| `--remote <url:string>`  | Kernel base URL                                     |
| `--token <token:string>` | Bearer token                                        |
| `--dry-run`              | Report what would be deleted without actually deleting |

#### `artifact kinds`

> List the artifact kinds the deployed kernel understands (`GET /v1/artifacts/kinds`)

| Flag                     | 説明                                                |
| ------------------------ | --------------------------------------------------- |
| `--remote <url:string>`  | Kernel base URL                                     |
| `--token <token:string>` | Bearer token                                        |
| `--table`                | Format output as a plain-text table instead of JSON |

```bash
takosumi artifact push ./bundle.zip --kind js-bundle --metadata commit=$GIT_SHA --remote $URL --token $T
takosumi artifact list --remote $URL --token $T
takosumi artifact kinds --table --remote $URL --token $T
takosumi artifact gc --dry-run --remote $URL --token $T
takosumi artifact rm sha256-... --remote $URL --token $T
```

### `takosumi runtime-agent ...`

> Operate the Takosumi runtime-agent

#### `runtime-agent serve`

> Start the runtime-agent HTTP server

| Flag                            | 説明                                                                            | Default      |
| ------------------------------- | ------------------------------------------------------------------------------- | ------------ |
| `--port <port:number>`          | Port to listen on                                                               | `8789`       |
| `--hostname <hostname:string>`  | Hostname to bind                                                                | `127.0.0.1`  |
| `--token <token:string>`        | Bearer token (defaults to `TAKOSUMI_AGENT_TOKEN` env or random)                 | random       |
| `--env-file <path:file>`        | Load extra env vars from a dotenv-style file before building connectors         | (none)       |

#### `runtime-agent list`

> List connectors registered on a runtime-agent

| Flag                     | 説明                                                          |
| ------------------------ | ------------------------------------------------------------- |
| `--url <url:string>`     | Agent URL (defaults to `TAKOSUMI_AGENT_URL` env)              |
| `--token <token:string>` | Bearer token (defaults to `TAKOSUMI_AGENT_TOKEN` env)         |

#### `runtime-agent verify`

> Smoke-test connector credentials & connectivity (read-only API call per connector)

| Flag                          | 説明                                                          |
| ----------------------------- | ------------------------------------------------------------- |
| `--url <url:string>`          | Agent URL (defaults to `TAKOSUMI_AGENT_URL` env)              |
| `--token <token:string>`      | Bearer token (defaults to `TAKOSUMI_AGENT_TOKEN` env)         |
| `--shape <shape:string>`      | Restrict to connectors implementing this shape                |
| `--provider <provider:string>` | Restrict to a single provider id                              |

`verify` は失敗した connector があると exit code 2 で終了します。

```bash
takosumi runtime-agent serve --port 8789
takosumi runtime-agent list   --url http://127.0.0.1:8789 --token $TAKOSUMI_AGENT_TOKEN
takosumi runtime-agent verify --shape object-store@v1
```

### `takosumi completions <shell>`

cliffy 同梱の completion generator (`bash` / `zsh` / `fish`)。

```bash
takosumi completions bash > /etc/bash_completion.d/takosumi
takosumi completions zsh  > "${fpath[1]}/_takosumi"
takosumi completions fish > ~/.config/fish/completions/takosumi.fish
```

### `takosumi version`

> Show takosumi CLI version

flag は無し。

```bash
takosumi version
```

---

## Resolution order — `--remote` / `--token`

`packages/cli/src/config.ts` で実装されている解決順 (高優先 → 低優先):

1. CLI flag (`--remote`, `--token`) — explicit wins
2. Command-specific env (`TAKOSUMI_DEPLOY_TOKEN` for deploy / artifact;
   `TAKOSUMI_AGENT_URL` / `TAKOSUMI_AGENT_TOKEN` for runtime-agent)
3. Generic env: `TAKOSUMI_REMOTE_URL` / `TAKOSUMI_TOKEN`
4. `~/.takosumi/config.yml` (`remote_url`, `token`)
5. Deprecated env aliases: `TAKOSUMI_KERNEL_URL` (warns once, then resolves
   like `TAKOSUMI_REMOTE_URL`)

::: warning Deprecation warnings
`TAKOSUMI_KERNEL_URL` を使うと `[takosumi] TAKOSUMI_KERNEL_URL is deprecated; use TAKOSUMI_REMOTE_URL`
が一度だけ stderr に出ます。 `TAKOSUMI_TOKEN` を `TAKOSUMI_DEPLOY_TOKEN` 無しで
使うと `prefer TAKOSUMI_DEPLOY_TOKEN for kernel deploy / artifact endpoints`
の警告が一度だけ出ます。
:::

## Config file — `~/.takosumi/config.yml`

YAML mapping。 現在のスキーマは 2 field のみ:

```yaml
remote_url: https://kernel.example.com
token: tk_deploy_xxxxxxxxxxxxxxxxxxxx
```

挙動:

- `$HOME` が無い / ファイルが存在しない / 中身が空 → 無視 (env / flag は引き続き使える)
- YAML mapping 以外 → stderr に warning を 1 回出して無視
- ファイルパスは `TAKOSUMI_CONFIG_FILE` で上書き可能

```bash
mkdir -p ~/.takosumi
cat > ~/.takosumi/config.yml <<'YAML'
remote_url: https://kernel.example.com
token: tk_deploy_xxxxxxxxxxxxxxxxxxxx
YAML

takosumi status                      # ↑ で remote_url / token を解決
takosumi deploy ./manifest.yml       # 同上 (manifest path だけ書けばよい)
TAKOSUMI_CONFIG_FILE=/etc/takosumi/admin.yml takosumi status
```

## 関連

- [Quickstart](/getting-started/quickstart) — `takosumi server` から first deploy まで
- [Manifest](/manifest) — `resources[]` / `template:` / `${ref:...}` syntax
- [Environment Variables](/reference/env-vars) — kernel / runtime-agent / CLI 全 env の catalog
