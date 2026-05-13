# CLI Reference

> このページでわかること: Takosumi CLI のコマンド一覧とオプション。

`takosumi` は Takosumi PaaS kernel に対応する CLI です。 Manifest の作成・送
信、 content-addressed DataAsset の管理、 runtime-agent の操作、 kernel server
の起動を行います。 CLI 自体は decision authority ではなく、 resolution /
planning / journaling / activation の権威ある判断は kernel が deploy bearer
に対応する public deploy Space、 または operator routes 向けの control-plane
Space context で行います。

## モード

`takosumi` は 2 モードで動作します。

| Mode     | Trigger                                            | State                                          | 用途                                     |
| -------- | -------------------------------------------------- | ---------------------------------------------- | ---------------------------------------- |
| `local`  | remote URL が resolve されない                     | in-process kernel、 ephemeral、 終了時に消える | 著者作業、 単一ホスト実験、 test fixture |
| `remote` | remote URL が resolve される (flag / env / config) | remote kernel が persist                       | 共有開発、 staging、 production          |

local mode は Space 状態を保持せず、 同一プロセス内 bundle の shape / provider
registry に対して resolution します。 remote mode は Takosumi kernel HTTP server
と通信し、 Space scope の resolution / planning / journaling を
[WAL Stages](/reference/wal-stages) に従って実行します。

## インストール

```bash
deno install -gA -n takosumi jsr:@takos/takosumi-cli
takosumi version
```

サポート runtime は Deno 2.x。 CLI 自体は kernel / runtime-agent の install
を必要としないため、 CLI host だけで動かせます。

## 認証

remote mode の command は bearer token で kernel に対して認証します。 CLI に
渡す token は operator 発行の `TAKOSUMI_DEPLOY_TOKEN` (deploy / DataAsset
endpoint scope)。 runtime-agent subcommand は別の bearer
(`TAKOSUMI_AGENT_TOKEN`) を使います。

public deploy bearer は kernel 側で 1 つの public deploy Space / tenant scope
に対応します。 operator は `TAKOSUMI_DEPLOY_SPACE_ID` で設定し、 未設定時は
`takosumi-deploy`。 manifest に Space field は載せません。

token は次の順序で resolve します。

1. command flag (`--token`)
2. `TAKOSUMI_DEPLOY_TOKEN` env (deploy / artifact 系) または
   `TAKOSUMI_AGENT_TOKEN` env (runtime-agent 系)
3. config file の `token` field

remote URL は次の順序で resolve します。

1. `--remote` flag
2. `TAKOSUMI_REMOTE_URL` env
3. config file の `remote_url` field

flag / source のいずれも無ければ local mode。 remote 必須の endpoint (`status`、
`artifact ...`) はこの場合 exit code 2 で終了します。

## 設定ファイル

CLI はプロセス毎に 1 度 `~/.takosumi/config.yml` を読み込みます。 パスは
`TAKOSUMI_CONFIG_FILE` で上書き可。 schema は閉じています。

```yaml
remote_url: <string, optional> # kernel HTTP server の URL
token: <string, optional> # kernel への bearer token
```

挙動:

- `$HOME` (Windows は `$USERPROFILE`) 未設定で `TAKOSUMI_CONFIG_FILE` も無い:
  silently skip
- file 不在または空: silently skip
- YAML mapping でない: stderr に 1 度警告を出し ignore
- その他読込エラー: stderr に 1 度警告を出し ignore

env は config file を上書きし、 明示 flag は両方を上書きします。

## Commands

### `takosumi server`

kernel HTTP server を起動します。

```text
takosumi server [--port <n>] [--agent-port <n>] [--no-agent] [--detach]
```

| Flag           | 型     | Default | 説明                                                               |
| -------------- | ------ | ------- | ------------------------------------------------------------------ |
| `--port`       | number | `8788`  | kernel HTTP の listen port                                         |
| `--agent-port` | number | `8789`  | 同居 runtime-agent の port (`TAKOSUMI_AGENT_URL` 未設定時のみ使用) |
| `--no-agent`   | switch | off     | 同居 runtime-agent を起動しない (別途 operator が起動する前提)     |
| `--detach`     | switch | off     | systemd / docker / nohup 向けテンプレートを表示して終了            |

`--detach` はプロセスを fork しません (Deno に portable な detach API がない
ため)。 CLI が supervisor テンプレートを出力するので、 operator が systemd /
docker compose / nohup を自分で配線します。

例:

```bash
takosumi server
takosumi server --port 9000 --agent-port 9001
takosumi server --no-agent
takosumi server --detach > takosumi-api.service
```

Exit codes: `0` SIGINT/SIGTERM での正常終了、 `1` bind 失敗または kernel boot
エラー。

`takosumi server` の rolling upgrade / drain / kernel ↔ runtime-agent skew
[Migration / Upgrade](/reference/migration-upgrade) を参照してください。

### `takosumi deploy [<manifest>]`

Manifest を apply 用に送信します。

```text
takosumi deploy [<manifest>] [--manifest <path>] [--remote <url>] [--token <t>] [--dry-run]
```

| Flag         | 型     | 説明                                               |
| ------------ | ------ | -------------------------------------------------- |
| `--manifest` | path   | manifest path の明示 (`<manifest>` 位置引数と等価) |
| `--remote`   | url    | resolve した remote URL を上書き                   |
| `--token`    | string | resolve した token を上書き                        |
| `--dry-run`  | switch | 検証と plan のみ。 apply しない                    |

挙動:

- remote: `POST /v1/deployments` に body `{ mode: "apply" | "plan", manifest }`
  を送信。 public deploy Space は kernel 設定 (`TAKOSUMI_DEPLOY_SPACE_ID`、 既定
  `takosumi-deploy`) で決まる。 各 remote write は fresh `X-Idempotency-Key`
  を伴うため、 transport retry は apply の再実行ではなく 最初の kernel response
  を replay する
- local: 同梱の Shape / provider registry で compile 済 `resources[]` manifest
  を検証し、 in-process apply (`--dry-run` 時は plan) を実行。 状態
  は終了時に破棄

Exit codes: `0` 受理、 `1` validation / apply 失敗、 `2` flag 不正。

例:

```bash
takosumi deploy ./manifest.yml
takosumi deploy ./manifest.yml --dry-run
takosumi deploy ./manifest.yml --remote https://kernel.example.com --token $TAKOSUMI_DEPLOY_TOKEN
```

GitHub Actions から `takosumi-git` を介さず raw deploy する例:

```yaml
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: tako0614/takosumi/actions/deploy@v1
        with:
          manifest: ./manifest.yml
          remote-url: ${{ secrets.TAKOSUMI_REMOTE_URL }}
          token: ${{ secrets.TAKOSUMI_DEPLOY_TOKEN }}
```

repository fixture `examples/direct-deploy/` がこの action 用の sample。
`.takosumi/` や `takosumi-git` を使わず、 `manifest.yml` と
`.github/workflows/deploy.yml` のみ含みます。

action は `takosumi deploy <manifest> --remote ... --token ...` を実行し、
`POST /v1/deployments` に POST します。 AppInstallation ownership / AppBinding /
billing / grant record は作成しません。 これらが必要な install は operator の
Takosumi Accounts install flow を使ってください。

### `takosumi plan [<manifest>]`

apply せずに resolved plan を表示します。

```text
takosumi plan [<manifest>] [--manifest <path>] [--remote <url>] [--token <t>]
```

| Flag         | 型     | 説明                                               |
| ------------ | ------ | -------------------------------------------------- |
| `--manifest` | path   | manifest path の明示 (`<manifest>` 位置引数と等価) |
| `--remote`   | url    | resolve した remote URL を上書き                   |
| `--token`    | string | resolve した token を上書き                        |

remote mode の `plan` は `POST /v1/deployments` を `mode: "plan"` で送信し、
kernel response body をそのまま表示します。 plan には provider 副作用が無く
ても、 `deploy` と同様 fresh `X-Idempotency-Key` を伴います。 local mode は
同梱の validator を in-process で走らせ、 stdout に `{ status, outcome }` を
JSON で出力します。 両モードとも `outcome.operationPlanPreview` には決定的な
DesiredSnapshot / OperationPlan digest と WAL idempotency tuple
のプレビューが入り、 WAL entry は書かれま せん。

Exit codes: `0` 成功、 `1` 失敗。

### `takosumi destroy [<manifest>]`

以前 apply した manifest が宣言する resource を破棄します。

```text
takosumi destroy [<manifest>] [--manifest <path>] [--remote <url>] [--token <t>] [--force]
```

| Flag         | 型     | 説明                                                                                             |
| ------------ | ------ | ------------------------------------------------------------------------------------------------ |
| `--manifest` | path   | manifest path の明示 (`<manifest>` 位置引数と等価)                                               |
| `--remote`   | url    | resolve した remote URL を上書き                                                                 |
| `--token`    | string | resolve した token を上書き                                                                      |
| `--force`    | switch | apply 記録が無くても resource 名で destroy する。 handle が resource 名と一致する self-hosted 用 |

remote mode は `POST /v1/deployments` を `mode: "destroy"` で送信。 kernel は
persist 済 handle を引き、 runtime-agent に発送します。 retry が provider
destroy を二重実行しないよう fresh `X-Idempotency-Key` を付けます。 local mode
は in-process で破棄し、 事前 state が無ければ best-effort になります。

Exit codes: `0` 全破棄成功、 `1` 部分失敗または validation 失敗。

### `takosumi status [<name>]`

deployment 状態を kernel から取得します。 remote のみ。

```text
takosumi status [<name>] [--remote <url>] [--token <t>]
```

`<name>` 無しは `GET /v1/deployments` で全 deployment を一覧。 `<name>` 指定
時は `GET /v1/deployments/:name` で 1 件を取得。 いずれも
[Status Output](/reference/status-output) document を返し、 CLI は
`deployment / id / resource / shape / provider / status` を表で表示します。

Exit codes: `0` 表示、 `1` kernel error / 未対応 route、 `2` remote / token
未指定。

### `takosumi audit show <deployment-id-or-name>`

1 deployment の public deploy WAL / provenance / rollback cause chain を
表示します。 remote のみ。

```text
takosumi audit show <deployment-id-or-name> [--remote <url>] [--token <t>]
```

まず `GET /v1/deployments/:name/audit` を呼び、 引数が manifest `metadata.name`
ではなく deployment id の場合は `GET /v1/deployments` で id から name を解決して
audit endpoint を取得します。

出力に含まれるもの:

- deployment id / name / status / tenant
- 最新 WAL の phase / stage / status / OperationPlan digest
- upstream provenance (`workflowRunId`、 git commit / ref / repository、
  artifact URI)
- public WAL entry から組み立てた cause chain (rollback / abort 理由、 記録 済
  outcome status を含む)
- compensation / rollback path で作成された RevokeDebt record

Exit codes: `0` 表示、 `1` kernel error / 該当なし、 `2` flag 不正。

### `takosumi migrate`

kernel database の migration を実行します。

```text
takosumi migrate [--env <name>] [--dry-run]
```

| Flag        | 型     | Default | 説明                                                                |
| ----------- | ------ | ------- | ------------------------------------------------------------------- |
| `--env`     | string | `local` | `local` / `staging` / `production`、 または operator が定義した名前 |
| `--dry-run` | switch | off     | 適用せず planned migration を表示                                   |

`--env` の値で env 固有 `*_DATABASE_URL` の優先順位が決まります
([Environment Variables](/reference/env-vars))。 dry-run は staging / production
であっても URL を要求しません。

Exit codes: `0` migration 完了 / dry-run 表示、 `1` migration error / kernel
script 不在、 `2` non-dry-run の staging / production で必須 env 未 設定。

### `takosumi init [<output>]`

compile 済 Shape manifest を生成し、 path を `takosumi deploy` に渡せるよう
にします。 project layout の scaffold は `takosumi-git` の責務です。

```text
takosumi init [<output>]
```

`<output>` 指定時は `resources[]` manifest を当該 path に出力、 無指定時は
stdout に表示。 top-level `template` は現行 kernel の public field ではあり
ません。

### `takosumi doctor`

CLI が使う manifest / target mode / auth 状態を表示します。

```text
takosumi doctor [--manifest <path>] [--remote <url>] [--token <t>]
```

`deploy` / `plan` / `destroy` と同じく `--manifest <path>` が必須で、 local /
remote 解決を共有します。 出力: 選択した manifest path、 解決済 resource 数、
deployment 名 (存在すれば)、 local vs remote、 token 有無、 次に実行すべき
command。 manifest が無い / 不正なら `1` で終了。

### `takosumi artifact <push | list | rm | gc | kinds>`

kernel artifact store の content-addressed DataAsset を管理します。 全
subcommand に remote URL と deploy scope の token が必要。 不足時は exit code
2。

```text
takosumi artifact push <file> --kind <kind> [--metadata k=v ...] [--remote <url>] [--token <t>]
takosumi artifact list                       [--limit <n>] [--remote <url>] [--token <t>]
takosumi artifact rm <hash>                  [--remote <url>] [--token <t>]
takosumi artifact gc                         [--dry-run] [--remote <url>] [--token <t>]
takosumi artifact kinds                      [--table] [--remote <url>] [--token <t>]
```

- `push`: `POST /v1/artifacts` で bytes を upload し、
  `{ hash, kind, size, uploadedAt }` envelope を表示。 hash を manifest に埋
  め込んで使う
- `list`: `GET /v1/artifacts` の paginated 結果を辿る
- `rm`: 単一 hash を削除
- `gc`: persist 済 DesiredSnapshot 参照グラフに対する mark-and-sweep
- `kinds`: `GET /v1/artifacts/kinds` を呼び、 kernel が認識する kind 一覧を 返す

semantics は [DataAsset Kinds](/reference/artifact-kinds) を参照。

### `takosumi runtime-agent <serve | list | verify>`

cloud credential を保持し、 kernel の代わりに lifecycle 作業を行う Takosumi
runtime-agent を操作します。

```text
takosumi runtime-agent serve  [--port <n>] [--hostname <h>] [--token <t>] [--env-file <path>]
takosumi runtime-agent list   [--url <url>] [--token <t>]
takosumi runtime-agent verify [--url <url>] [--token <t>] [--shape <s>] [--provider <p>]
```

- `serve`: agent HTTP server を起動 (既定 `127.0.0.1:8789`)。 `--token` と
  `TAKOSUMI_AGENT_TOKEN` がいずれも未設定なら、 random token を生成して表示
- `list`: `GET /v1/connectors` を呼ぶ
- `verify`: `POST /v1/lifecycle/verify` を呼び、 connector ごとの read-only
  smoke test を実行。 失敗 connector があれば exit code 2

## Trigger / Step subcommand

trigger / step CLI subcommand は提供しません。 kernel は trigger / hook /
execute-step primitive を持たず、 workflow / cron / hook は plugin が提供 する
manifest resource として宣言し、 通常の `takosumi deploy` で送信し、 実行は
`takosumi-git` 等の上流 product が担当します。 詳細は
[Workflow Placement Rationale](/reference/architecture/workflow-extension-design)
を参照。

## Project Layout

`deploy` / `plan` / `destroy` / `doctor` は **manifest path の明示** が必須 で、
位置引数 `<manifest>` か `--manifest <path>` のいずれかで渡します。 CLI
組み込みの project layout discovery はありません (kernel CLI は manifest deploy
engine に徹し、 working tree root の `.takosumi/manifest.yml` や `manifest.yml`
は探さない)。

repository レベルの project 慣習 (`.takosumi/` ディレクトリ、
`.takosumi/workflows/*.yml`、 git push / webhook / build pipeline / cron / hook
配線) は **`takosumi-git`** が所有します。 `takosumi-git` は project repository
を生成 `Manifest` に変換し、 kernel の `POST /v1/deployments` に 送信します。
境界は
[Workflow Placement Rationale](/reference/architecture/workflow-extension-design)
を参照。

### `takosumi completions <shell>`

`bash` / `zsh` / `fish` 用の completion script を出力します (cliffy completions
command で生成)。

```bash
takosumi completions bash > /etc/bash_completion.d/takosumi
takosumi completions zsh  > "${fpath[1]}/_takosumi"
takosumi completions fish > ~/.config/fish/completions/takosumi.fish
```

### `takosumi version`

CLI version を表示。 flag 無し。

## Exit codes

CLI が使う小さな予約集合:

| Code | 意味                                                                                                                                                  |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | 成功                                                                                                                                                  |
| `1`  | command 固有の失敗 (kernel が ≥ 400 を返した、 plan / apply 失敗、 partial destroy、 migration 失敗)                                                  |
| `2`  | usage error / precondition 失敗 (flag 値不正、 必須 env 欠落、 remote 必須 command で remote URL 無し、 `verify` が failed connector を報告した、 等) |

`70` 以上は将来の signal 駆動 exit のために予約 (現状は未使用)。 CLI は process
signal を個別の exit code に mirror しません。

## 関連

- リファレンス: [Manifest](/manifest)、
  [Environment Variables](/reference/env-vars)、
  [DataAsset Kinds](/reference/artifact-kinds)、
  [Migration / Upgrade](/reference/migration-upgrade)

## 関連 architecture notes

- `docs/reference/architecture/cli-companion-architecture-note.md` — CLI surface
  の設計

## 関連ページ

- [Kernel HTTP API](/reference/kernel-http-api)
- [Environment Variables](/reference/env-vars)
- [Migration & Upgrade](/reference/migration-upgrade)
