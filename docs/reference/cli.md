# CLI リファレンス {#cli-reference}

`takosumi` CLI は **source を Takosumi server に送る薄い client** です。 [Installer API](./installer-api.md) に対応する subcommand を持ちます。

```text
CLI の役割:
  - source を送る (= POST /v1/installations / deployments)
  - dry-run を表示する
  - rollback を呼ぶ
  - Takosumi server を起動する
```

## モード

installer command (`install` / `deploy` / `rollback`) は remote Takosumi server を必須とします。`--remote`、`TAKOSUMI_REMOTE_URL`、または `~/.takosumi/config.yml` で server URL を渡します。ローカル開発時は `takosumi server` で Takosumi server を起動して、その URL を installer command に渡します。

## インストール

```bash
deno install -gA -n takosumi npm:@takosjp/takosumi
takosumi version
```

サポート runtime は Deno 2.x。CLI 単体で動きます。

## 認証

remote command は bearer token で Takosumi server に認証します。

| Env                        | 用途          |
| -------------------------- | ------------- |
| `TAKOSUMI_INSTALLER_TOKEN` | Installer API |

token は次の順序で resolve します。

1. command flag (`--token`)
2. `TAKOSUMI_INSTALLER_TOKEN` env
3. config file の `token` field

remote URL は `--remote https://takosumi.example.com` か `TAKOSUMI_REMOTE_URL` env、 config file の `remote_url` から resolve します。

## サブコマンド {#subcommand}

### `takosumi install --source <source>`

新規 Installation を作成。Installer API に送る source は `git`、`prepared`、または dev / operator-local の `local` です。

```bash
# git source
takosumi install --remote https://takosumi.example.com \
  --space space_personal \
  --source git:https://github.com/example/notes#v1.2.3

# prepared source from an external build service
takosumi install --remote https://takosumi.example.com \
  --space space_personal \
  --source prepared:https://source.example/prepared/notes.tar#sha256:...

# local path visible to the kernel process
takosumi install --remote http://localhost:8788 \
  --space space_personal \
  --source .
```

`--space <id>` は必須。`--source .` は kernel process から同じ path が見える local dev / operator-local 起動で使います。managed remote operator では `git:` または `prepared:` を使います。dry-run は次の subcommand で表示。 `http://localhost` / `http://127.0.0.1` remote は single-host loopback dev 専用です。production と LAN dev hostname では HTTPS remote を使います。

`--source` の文字列 grammar:

```text
git:<url>#<ref>
prepared:<url>#<sha256:hex>
<local-path>
```

`#` は最後の separator だけを source ref / digest として扱います。URL 自体に fragment が必要な場合は encode してください。`prepared:` は build service / CI が作った prepared source archive URL と archive payload digest を渡す形式です。 git source の ref と prepared source の digest は remote source identity の必須 guard です。CLI は `prepared:<url>` のように `#sha256:...` を欠く prepared source を client-side invalid として扱います。

dry-run の expected guard を apply に渡す場合は次の flag を使います。

| Flag                         | 対象 source                  |
| ---------------------------- | ---------------------------- |
| `--expected-manifest-digest` | `git` / `prepared` / `local` |
| `--expected-commit`          | `git`                        |
| `--expected-source-digest`   | `prepared`                   |

### `takosumi install dry-run --source <source>`

```bash
takosumi install dry-run --space space_personal \
  --remote http://localhost:8788 \
  --source .
```

response (`changes[]` / `expected.commit` / `expected.manifestDigest` / `expected.sourceDigest`、および operator extension field) を JSON で表示。

### `takosumi deploy <installation-id> [--source <source>]`

既存 Installation に対する apply。 `--source` 省略時は current Deployment に記録された immutable source の記録 を再利用します。対象は git source の resolved commit / ref と prepared source archive URL + digest です。`local` source は portable な source byte identity を持たないため、deploy dry-run / apply で `--source` を毎回渡します。dry-run から apply へ進む場合は `install` と同じ expected guard flag に加えて `--expected-current-deployment-id` を渡します。 dry-run response の `expected.currentDeploymentId` が `null` の場合は、CLI では literal `null` を渡します。

```bash
takosumi deploy inst_01HM9N7XK4QY8RT2P5JZF6V3W9 --source git:https://github.com/example/notes#v1.2.4
```

deploy expected guard flag:

| Flag                               | 対象                   |
| ---------------------------------- | ---------------------- |
| `--expected-current-deployment-id` | deploy base pointer    |
| `--expected-manifest-digest`       | source manifest digest |
| `--expected-commit`                | git source             |
| `--expected-source-digest`         | prepared source        |

### `takosumi deploy dry-run <installation-id> [--source <source>]`

新 source の dry-run。response は `expected.currentDeploymentId` を含みます。

### `takosumi rollback <installation-id> <deployment-id>`

過去 Deployment を current pointer に戻す。新しい Deployment は作らない。

```bash
takosumi rollback inst_01HM9N7XK4QY8RT2P5JZF6V3W9 dep_01HM9N7XK4QY8RT2P5JZF6V3WA
```

### `takosumi server`

Takosumi server を foreground 起動。remote installer command の接続先として使える。

```bash
takosumi server                    # port 8788
takosumi server --port 9000
```

### `takosumi init [output]`

`.takosumi.yml` manifest scaffold を生成。`init` は manifest だけを作ります。

生成しないもの:

- `src/worker.ts` のような runtime file
- `.takosumi.build.yml`

参照先 file は自分で作ってください。build service / CI を使う場合は prepared source handoff を追加してください。

```bash
takosumi init .takosumi.yml
takosumi init --template empty
```

### `takosumi version`

CLI version を表示。

## グローバルフラグ {#global-flags}

| Flag             | 説明                                              |
| ---------------- | ------------------------------------------------- |
| `--remote <url>` | remote Takosumi server URL (= remote mode に切替) |
| `--token <t>`    | installer bearer token                            |
| `--space <id>`   | 対象 Space id (install で必須)                    |

## 設定ファイル {#config-file}

`~/.takosumi/config.yml` :

```yaml
remote_url: https://takosumi.example.com
token: <installer-token>
```

CLI flag > env > config file の優先順位。

## 関連ページ

- [Installer API](./installer-api.md) — CLI が呼ぶ HTTP endpoint
- [manifest](./manifest.md) — `.takosumi.yml` 仕様
- [ビルドサービス境界](./build-spec.md) — prepared source handoff
