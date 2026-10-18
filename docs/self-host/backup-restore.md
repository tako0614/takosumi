# バックアップと復旧

復旧できるよう、データベース、暗号・署名鍵、実際に使う artifact/source/state store、
配置情報を一組として保全します。

Bun/PostgreSQL の参照 Compose は PostgreSQL、Caddy と `takosumi-runtime` volume を
永続化します。control / pre-destroy export は `TAKOSUMI_BACKUP_ARTIFACTS_DIR`
(既定 `/var/lib/takosumi/backups`) に保存します。directory は実行ユーザー所有の 0700、
file は 0600 で、bundle は既存の secret-store の鍵で暗号化して（sealed）保存します。public artifact
manifest だけは平文です。保存名は、中身を表さない参照名（opaque ref）の SHA-256 hex に `.artifact` を付けたものです。
runner は同梱されません。独自の runner/state/artifact store の保存先も backup 対象に加えます。

`TAKOSUMI_BACKUP_ARTIFACTS_DIR` は destroy 前の export を保存するために事実上必須です。
参照 Compose は既定値を渡しますが、Compose を使わずに起動する場合も永続化した保存先を
明示してください。未設定だと export は `skipped` (`backups_unavailable`) と記録され、
export が無いまま destroy に進みます。

## PostgreSQL Compose

Accounts と control plane の schema は同じ PostgreSQL database
`takosumi_accounts` にあります。以下の例は `deploy/node-postgres` から追加の `-p` / `-f`
なしで起動した既存の default Compose project を対象にします。別 project や Compose file で
起動した場合は、その起動時と同じ project/file 引数を全操作に使ってください。backup は checkout
の外に保存します。

```bash
cd deploy/node-postgres
set -euo pipefail
umask 077
backup_dir=/var/backups/takosumi
mkdir -p "$backup_dir"
chmod 700 "$backup_dir"
backup_file="$backup_dir/takosumi-$(date -u +%Y%m%dT%H%M%SZ).dump"
compose() { docker compose "$@"; }
compose stop accounts
compose exec -T postgres pg_dump -U takosumi -d takosumi_accounts -Fc > "$backup_file"
chmod 600 "$backup_file"
compose exec -T postgres pg_restore --list < "$backup_file" >/dev/null
compose up -d --wait accounts
```

ローカル smoke-test project を backup する場合、default Compose の上記コマンドは使いません。
初回起動と同じ shell / project / override 変数（`local_project` と `local_dir` は
[ローカルで安全に起動して確認する](../concepts/self-host.md#ローカルで安全に起動して確認する)で設定したもの）を使い、
次を実行します。

```bash
set -euo pipefail
umask 077
backup_dir=/var/backups/takosumi
mkdir -p "$backup_dir"
chmod 700 "$backup_dir"
backup_file="$backup_dir/takosumi-local-$(date -u +%Y%m%dT%H%M%SZ).dump"
local_files=(-f docker-compose.yml -f "$local_dir/compose.local-test.yml")
local_compose() { docker compose -p "$local_project" "${local_files[@]}" "$@"; }
local_compose stop accounts
local_compose exec -T postgres pg_dump -U takosumi -d takosumi_accounts -Fc > "$backup_file"
chmod 600 "$backup_file"
local_compose exec -T postgres pg_restore --list < "$backup_file" >/dev/null
local_compose up -d --wait accounts
```

バックアップと別の operator secret store に、`POSTGRES_PASSWORD`、
`TAKOSUMI_SECRET_STORE_PASSPHRASE`、`TAKOSUMI_ACCOUNT_SESSION_HASH_SALT`、
`TAKOSUMI_ACCOUNTS_ES256_PRIVATE_JWK`、`TAKOSUMI_ACCOUNTS_OIDC_PAIRWISE_SUBJECT_SECRET`、
`TAKOSUMI_DEPLOY_CONTROL_TOKEN` と、設定していれば upstream provider secrets を保管します。
封印鍵や署名鍵を失うと、保管したデータを読めないか、既存 token を検証できなくなります。
`TAKOSUMI_SECRET_STORE_PASSPHRASE` の変更後は新しい値で過去の export を復号できず、
export 作成時の値を紛失すると復号できなくなります。
設定、Git commit、image digest、migration head も記録します。Caddy volume の証明書状態は
再発行できますが、バックアップすれば ACME 再取得を避けられます。

復旧演習は別の Compose project にある空の database で行います。project 名が専用の新しい
volume を作るため、元の database に触れません。`--clean` は使わず、既存 checkout の `.env` を
読み込んで同じ image / migration を使います。復旧中は Caddy を起動しません。確認対象は health と
匿名 dashboard shell です。認証済みの記録を読む場合は restore-specific provider/client 設定が要ります。
復旧 block は先の backup と同じ shell で実行し、`backup_file` 変数にその archive path が入っている
状態にします。別 shell なら block の前に `backup_file` を実際の archive path に設定します。

```bash
set -euo pipefail
# In a new shell, point this at the exact custom-format archive created above.
# backup_file=/path/to/verified-backup.dump
restore_project="takosumi-restore-check-$(date +%s)-$$"
restore_dir="$(mktemp -d)"
cat > "$restore_dir/compose.restore-check.yml" <<'YAML'
services:
  accounts:
    environment:
      TAKOSUMI_ACCOUNTS_UPSTREAM_PROVIDERS: ""
      TAKOSUMI_ACCOUNTS_ISSUER: http://localhost:26402
      TAKOSUMI_ACCOUNTS_REDIRECT_URIS: http://localhost:26402/oauth/callback
      TAKOSUMI_ACCOUNTS_PASSKEY_RP_ID: localhost
      TAKOSUMI_ACCOUNTS_PASSKEY_RP_ORIGIN: http://localhost:26402
    ports:
      - "127.0.0.1:26402:8787"
YAML
restore_files=(-f docker-compose.yml -f "$restore_dir/compose.restore-check.yml")
restore_compose() { docker compose -p "$restore_project" "${restore_files[@]}" "$@"; }
restore_compose up -d --wait postgres
restore_compose exec -T postgres \
  pg_restore -U takosumi -d takosumi_accounts --exit-on-error --no-owner < "$backup_file"
restore_compose run --rm migrations
restore_compose up -d --wait accounts
curl -fsS http://localhost:26402/healthz
```

Docker Compose v2 の `up --wait` が必要です。明示した `-f` は `docker-compose.override.yml` を自動で
読み込みません。必要な upstream secret mapping は restore 用の一時 override に個別に追加し、
operator override 全体は読み込まないでください。通常 override は追加の host port を公開する場合があります。
restore project の issuer、upstream provider descriptor の `redirectUri`、client JSON の
`redirectUris`、passkey origin を必要に応じ `localhost:26402` にそろえ、IdP callback と secret mapping
も用意します。`TAKOSUMI_ACCOUNTS_CLIENTS` がある場合、singular `TAKOSUMI_ACCOUNTS_REDIRECT_URIS` は
無視されます。restore-specific 認証設定がなければ health と未認証 dashboard 表示までを確認し、
sign-in 成功を前提にしません。migration と health check の成功後、未認証 dashboard が表示されることを
確認します。sign-in を追加検証する場合は temporary override に restore 用の provider descriptor/client
JSON、secret mapping を追加し、`restore_compose up -d --wait accounts` で反映してから試します。
認証済み記録を読む場合もこの追加設定を用意してから行います。
確認後は専用 project の container と volume を確認してから片付けます。元の deployment project や
volume は対象にしません。`restore_dir` の一時設定も最後に削除します。restore-specific
認証設定を用意した場合はサインイン、既存 Accounts / Workspace / Run 記録、ProviderConnection の復号も確認します。
標準の配布に runner は含まれず、Git source、plan artifact、provider 側の実リソースは
この PostgreSQL backup から復元されません。`takosumi-runtime` volume と custom composition の
実際の永続化された store も個別に復旧します。

Workspace export は DB 全体、artifact store、鍵の backup の代わりにはなりません。
参照 Compose は file backup store を配線します。uninstall の 7 日 grace 中は Capsule backup
API で export でき、期限後の finalizer も destroy 前に export を試みます。適用済み state を含める
独自 runner 構成では、その sealed state store の `backupStateObjectReader` を host から明示的に
接続します。読み取り口や state object が無い場合は export 失敗として記録されますが、
[削除の予約](../concepts/scheduled-uninstall.md)のとおり、書き出しに失敗しても削除は止まりません。volume と鍵は別に保全します。

Cloudflare 構成は [災害復旧](https://github.com/tako0614/takosumi/blob/main/docs/operations/disaster-recovery.md) と
[backup/restore 演習](https://github.com/tako0614/takosumi/blob/main/docs/operations/backup-restore-drills.md)を参照してください。
秘密値と raw backup は public repository、PR、運用ログに保存しません。
