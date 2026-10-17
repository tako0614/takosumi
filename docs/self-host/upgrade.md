# 更新する

更新する commit、両データベースの migration、runner の互換性を先に確認します。
マイグレーションは前にしか進めません（forward-only）。コードを戻せるかどうかは、その版が更新後の
スキーマを受け入れるかで決まり、列の追加だけでも安全とは限りません。

## Bun と PostgreSQL

[配布構成の README](https://github.com/tako0614/takosumi/blob/main/deploy/node-postgres/README.md)に従って、変更対象の migration と
互換性を確認し、直前に backup を取得します。default Compose project で運用している場合は、
`deploy/node-postgres` で実行し、起動時と同じ default project と自動読込 override を維持します。
独自の `-p` / `-f` を使って起動した環境では、同じ引数をすべての operation に渡してください。
新しい commit に切り替えてから、次の順で更新します。migration は control-plane schema の後に
Accounts schema を適用します。

```bash
set -euo pipefail
cd deploy/node-postgres
compose() { docker compose "$@"; }
compose stop accounts
compose build accounts migrations
compose run --rm migrations
# migrations が成功した後、production では Caddy も起動する
compose up -d --wait accounts caddy
compose ps
curl -fsS https://app.example.com/healthz # replace with the configured public hostname
```

`accounts` を止めてから migration を実行し、成功前に新しい service を公開しません。
ローカル test project で試す場合は起動時と同じ専用 project と composition file を使い続け、
次のように helper に固定します。`docker-compose.override.yml` は読み込まず、必要な secret mapping
だけを一時 override に追加します。

`local_project` と `local_dir` は、[ローカルで安全に起動して確認する](../concepts/self-host.md#ローカルで安全に起動して確認する)で起動したときに設定したものです。

```bash
set -euo pipefail
local_files=(-f docker-compose.yml -f "$local_dir/compose.local-test.yml")
local_compose() { docker compose -p "$local_project" "${local_files[@]}" "$@"; }
local_compose stop accounts
local_compose build accounts migrations
local_compose run --rm migrations
local_compose up -d --wait accounts
local_compose ps
curl -fsS http://localhost:26401/healthz
```

`--wait` は Docker Compose v2 が必要です。stock 構成に runner が
ないため runner の互換性確認対象もありません。runner を組み込んだ custom composition は
その実 protocol、artifact 保存先、state 保存先も個別に確認します。

更新後はサインイン、既存 Capsule/Run の読み取り、認証情報を使う操作を自分の検証 Workspace
で確認してください。確認できるまでは旧 image reference と backup を保持します。

## Cloudflare

Accounts D1 と control D1 の schema は別の owner surface です。デプロイ前にそれぞれの
plan、backup evidence、適用手順を確認します。control D1 は
[Control D1 schema predeploy](https://github.com/tako0614/takosumi/blob/main/docs/operations/control-d1-schema-predeploy.md)、Worker は
[platform worker deploy](https://github.com/tako0614/takosumi/blob/main/docs/operations/platform-worker-deploy.md)を参照してください。
リクエストによる schema bootstrap を既存環境の更新手順として扱いません。

## 失敗した場合

schema に触れる前の失敗と、触れた後の失敗を分けて記録します。後者では排他制御の記録（fence）と
実行記録を残し、適用済みの schema を確かめてから、前に進める修正（前方修復）で直します。前の Worker Version やイメージがあるだけでは
データベースとの互換性は証明できません。自動の down migration や、原因を確かめないままの再試行（blind retry）は行いません。
