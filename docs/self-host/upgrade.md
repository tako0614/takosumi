# Takosumi 本体を更新する（アップグレード）

このページは、自分で運用している Takosumi 本体の更新です。追加したサービスを新しい版に
するときは[追加したサービスの更新・戻す・削除](../getting-started/after-adding.md)を
参照してください。

更新する commit、両データベースの migration、runner の互換性を先に確認します。
マイグレーションは前にしか進めません（forward-only）。コードを戻せるかどうかは、その版が更新後の
スキーマを受け入れるかで決まり、列の追加だけでも安全とは限りません。

## Bun と PostgreSQL

[配布構成の README](https://github.com/tako0614/takosumi/blob/main/deploy/node-postgres/README.md)に従って、変更対象の migration と
互換性を確認し、直前に backup を取得します。default Compose project で運用している場合は、
`deploy/node-postgres` で実行し、起動時と同じ default project と自動読込 override を維持します。
独自の `-p` / `-f` を使って起動した環境では、同じ引数をすべての operation に渡してください。
適用済みの migration は、control plane は `storage_migrations`、Accounts は
`accounts_v1.schema_migrations` に記録されています。`bun run db:migrate:dry-run` が表示するのは
catalog 全体で、この database にまだ適用していないものではありません。次で適用済みの版を
確かめ、新しい commit の catalog と見比べます。

```bash
cd deploy/node-postgres
docker compose exec -T postgres psql -U takosumi -d takosumi_accounts \
  -c 'select id, version, applied_at from storage_migrations order by version desc limit 5'
docker compose exec -T postgres psql -U takosumi -d takosumi_accounts \
  -c 'select version, name from accounts_v1.schema_migrations order by version desc limit 5'
```

新しい commit に切り替えてから（`git switch --detach <commit>` など）、次の順で更新します。
migration は control-plane schema の後に Accounts schema を適用します。

```bash
set -euo pipefail
cd deploy/node-postgres
compose() { docker compose "$@"; }
compose stop accounts
compose build accounts migrations
migrate_log="$HOME/takosumi-migrate-$(date -u +%Y%m%dT%H%M%SZ).log"
compose run --rm migrations 2>&1 | tee "$migrate_log"
# migrations が成功した後、production では Caddy も起動する
compose up -d --wait accounts caddy
compose ps
curl -fsS https://app.example.com/healthz # replace with the configured public hostname
```

`accounts` を止めてから migration を実行し、成功前に新しい service を公開しません。migration が
失敗すると、ここで止まり、`accounts` は止まったままになります。migration は前にしか進まないため、
失敗した migration を戻すコマンドはありません。migration は 1 本ずつ確定するので、失敗する前に
終わったものは適用済みのまま残ります。`migrations` の container は終わると消えるため、出力は
`$migrate_log` のファイルで確かめます。shell が閉じて変数が消えた場合は
`ls -t "$HOME"/takosumi-migrate-*.log` で見つけます。止まった migration を確かめ、直前の backup を
[復旧演習](./backup-restore.md)と同じ手順で別の project に戻して中身を確かめてから、対処を
決めます。

ローカル test project で試す場合は起動時と同じ専用 project と composition file を使い続け
（`local_project` と `local_dir` は[ローカルで安全に起動して確認する](./bun-postgres.md#ローカルで安全に起動して確認する)で設定したもの）、
次のように helper に固定します。`docker-compose.override.yml` は読み込まず、必要な secret mapping
だけを一時 override に追加します。

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

`--wait` は Docker Compose v2 が必要です。標準の構成に runner が
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

Accounts D1 は、新しく構築するときと同じ `takosumi accounts migrate-d1` の backup-status、
plan、apply、verify の順で上げます（[Cloudflare に置く](./cloudflare.md)）。
Worker ごとに受け付ける Accounts D1 の版が決まっているため、適用と Worker のデプロイの
どちらを先にするかは版によって変わります。v3 の Accounts D1 から上げる場合は、bridge Worker を
デプロイしてから v4 を適用し、その後で v4 以降だけを受け付ける Worker に替える、という決まった
順序があります。apply は v4 を適用する直前に、既存の OIDC client の記録を 100 行ずつ補います。
v4 を適用した後は、v3 だけを受け付ける Worker には戻せません。この順序と注意は
[online DB migrations](https://github.com/tako0614/takosumi/blob/main/docs/operations/online-db-migrations.md)
に従ってください。

## 廃止したテーブルに行が残っているとき

以前の Resource Shape、Form Host、TargetPool、SpacePolicy、Offering などの記録を置いていたテーブルは、
PostgreSQL の migration 110（`retired.host_schema.drop_empty`）と、Cloudflare の D1 の migration 66
（`d1_retired_host_schema_drop_empty`）が削除します。どちらも、対象のテーブルがすべて空のときだけ削除し、
行が 1 つでも残っていると、その migration で止まります。

止まったときは、次の順に進めます。

1. 直前の release か外部のデータベースのツールで、残っている行を一覧にして書き出します。
2. それぞれの行をどう扱うかを、明示的に記録します。
3. その記録に従って、廃止したテーブルを空にします。
4. migration をもう一度実行します。

Takosumi の今の版には、これらの記録を移す操作や設定はありません。

## 失敗した場合

schema に触れる前の失敗と、触れた後の失敗を分けて記録します。後者では排他制御の印（fence）と
実行記録を残し、適用済みの schema を確かめてから、前に進める修正（前方修復）で直します。前の Worker Version やイメージがあるだけでは
データベースとの互換性は証明できません。自動の down migration や、原因を確かめないままの再試行（blind retry）は行いません。
