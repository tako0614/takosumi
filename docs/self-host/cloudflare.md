# Cloudflare に置く

構成の選び方と費用は[自分で動かす](../concepts/self-host.md)にあります。このページは、Cloudflare の雛形
`deploy/platform/` を自分のアカウントに置く手順です。

次のものを用意します。

- Workers Paid プランの Cloudflare アカウント。runner に Cloudflare Containers を使うため、
  Free プランでは動きません。
- R2 を有効にしておくこと。無料枠の範囲で使う場合も、Cloudflare のダッシュボードの R2 で
  一度購入手続きを済ませるまでバケットを作れません。
- Cloudflare で DNS を管理しているドメイン。`routes` の hostname を custom domain として
  登録し、その origin を Accounts の issuer にします。
- `wrangler deploy` を実行するマシンで動いている Docker。deploy の途中で
  `runner/Dockerfile` から runner のイメージをビルドします。
- Bun と、このリポジトリのチェックアウト。dashboard のビルドと、Accounts の D1 スキーマを
  適用する `takosumi` CLI に使います。

必要な binding は `deploy/platform/wrangler.toml` にすべて書いてあります。

| binding | 役割 |
| --- | --- |
| `TAKOSUMI_ACCOUNTS_DB` (D1) | セッション、OIDC、PAT を保存します |
| `TAKOSUMI_CONTROL_DB` (D1) | Run、StateVersion、Output の記録です |
| `R2_ARTIFACTS` | plan と state の成果物を置きます |
| `R2_SOURCE` | SourceSnapshot（commit に固定したソース）を tar.zst で置きます |
| `R2_STATE` | OpenTofu の state backend です |
| `R2_BACKUPS` | backup と export の束を置きます |
| `COORDINATION` / `RUN_OWNER` / `RUNNER` (Durable Object) | 排他制御、Run の所有、runner コンテナを担当します |
| `ASSETS` | dashboard の配布物を配ります |

Run は作成時に `RUN_OWNER` へ直接 schedule されます。この構成では、Cloudflare Queue も、
失敗した処理を退避させる dead-letter queue も使いません。`RUN_OWNER` が再試行と最終的な失敗の
扱いを受け持ち、binding がなければ Run を実行に回しません（fail closed）。

このリポジトリが固定している wrangler を入れてログインします。以下の `bun run wrangler` は
この版を使います。

```bash
bun install
bun run wrangler -- login
```

リソースを作ります。名前は雛形に合わせています。

```bash
bun run wrangler -- d1 create takosumi-accounts
bun run wrangler -- d1 create takosumi-deploy
bun run wrangler -- r2 bucket create takos-artifacts
bun run wrangler -- r2 bucket create takosumi-source
bun run wrangler -- r2 bucket create takosumi-state
bun run wrangler -- r2 bucket create takosumi-backups
```

## 自分用の設定を作る

雛形の `deploy/platform/wrangler.toml` は書き換えず、チェックアウトの外に写します。あとで使う
`takosumi accounts migrate-d1` は、変更のないチェックアウトでしか動かないためです。

```bash
install -d -m 700 "$HOME/.takosumi-private"
cp deploy/platform/wrangler.toml "$HOME/.takosumi-private/wrangler.toml"
```

写した設定で次を書き換えます。`<checkout>` はこのリポジトリの絶対パスです。雛形の相対パスは
設定ファイルの場所から解決されるため、写した先では絶対パスにします。

| 項目 | 書く値 |
| --- | --- |
| 2 つの `database_id` | `d1 create` が表示した ID |
| `[[routes]]` の `pattern` | 公開する hostname |
| `[vars]` の `TAKOSUMI_ACCOUNTS_ISSUER` | dashboard を配る origin（`https://` から） |
| `main`（先頭に追加） | `"<checkout>/deploy/platform/entry-worker.ts"` |
| `[assets]` の `directory`（追加） | `"<checkout>/dashboard/dist"` |
| `[[containers]]` の `image` と `image_build_context` | `"<checkout>/runner/Dockerfile"` と `"<checkout>"` |
| `[vars]` の `TAKOSUMI_ACCOUNTS_D1_SCHEMA_MODE`（追加） | `"predeployed"`。Accounts D1 のスキーマは下の CLI で入れ、Worker には作らせません |
| `[vars]` の `TAKOSUMI_ACCOUNTS_UPSTREAM_PROVIDERS`（追加） | サインインに使う上流の ID プロバイダの記述子を JSON にした**文字列**。`'[{"providerId": ...}]'` のように TOML の literal string で書きます |

この設定は自分の環境の値を含むので、公開しない場所で管理します。雛形の `[vars]` には
`TAKOSUMI_ENVIRONMENT = "production"` がすでに設定されています。この値が `production` か
`staging` のとき、暗号鍵と永続ストアの検査に通らなければ、警告で済ませずに起動しません
（fail closed）。値の意味は[設定リファレンス](../reference/configuration.md)にまとめてあります。

最初のアカウントは、上流の ID プロバイダでサインインして作ります。passkey は、サインイン
済みのアカウントに後から追加する手段です。`TAKOSUMI_ACCOUNTS_UPSTREAM_PROVIDERS` の書き方は
[設定リファレンス](../reference/configuration.md)にあります。provider の client secret と
`TAKOSUMI_ACCOUNTS_SUBJECT_SECRET` は、下の secret と一緒に送ります。記述子の `redirectUri` は
`https://<公開する origin>/sign-in/callback` で、ID プロバイダにもこの URI をそのまま登録します。Cloudflare 構成では、記述子の中身が壊れて
いるとサインインの手段が出ず、ログに `auth_providers_upstream_oauth_disabled` が残ります。値を
TOML の配列で書くと Worker に文字列として届かず、ログを出さずにサインインの手段が出ません。

dashboard をビルドします。`ASSETS` はこの出力を配ります。dashboard はルートの workspace に
含まれないため、`build:dashboard` が dashboard 自身の lockfile で依存を入れてからビルドします。

```bash
bun run build:dashboard
```

## Accounts D1 のスキーマを入れる

accounts 側の D1 スキーマは、チェックアウトの `takosumi` CLI で、deploy の前に適用します。
用意の仕方は [CLI](../reference/cli.md) にあります。Accounts D1 が対応する版でないと Worker は
要求を処理せず、ログに `accounts_d1_schema_incompatible` を出します。上の表で
`predeployed` にしたので、Worker は Accounts D1 に DDL を出さず、版の確認だけを行います。

次の値を環境変数に入れます。

| 変数 | 中身 |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | D1 の Edit 権限を持つ Cloudflare API トークン。CLI は値を表示しません |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare のアカウント ID |
| `CLOUDFLARE_DATABASE_ID` | `takosumi-accounts` の database ID |
| `SOURCE_COMMIT` | 変更のないチェックアウトの commit（`git rev-parse HEAD`）。一致しないと CLI は外部に触れずに止まります |

各段階は結果を JSON で表示します。`BACKUP_EVIDENCE_DIGEST` には backup-status が表示する
`backupEvidenceDigest` を入れます。`SOURCE_DIGEST`、`CATALOG_DIGEST`、`TARGET_DIGEST`、
`CONFIGURATION_DIGEST` には、plan が表示する `sourceDigest`、`catalogDigest`、`targetDigest`、
`configurationDigest` を入れます。`--out` には毎回新しいファイル名を指定します。同じ名前の
ファイルがあると止まります。

```bash
# 1. 適用前の状態を記録する。Time Travel の bookmark を非公開のファイルに書き出し、
#    backupEvidenceDigest を表示します
takosumi accounts migrate-d1 backup-status \
  --environment production \
  --account-id "$CLOUDFLARE_ACCOUNT_ID" \
  --database-id "$CLOUDFLARE_DATABASE_ID" \
  --source-commit "$SOURCE_COMMIT" \
  --out "$HOME/.takosumi-private/accounts-d1-backup-$(date +%Y%m%d%H%M%S).json"
# 2. 適用する内容を確かめる。遠隔の呼び出しはしません
takosumi accounts migrate-d1 plan \
  --environment production \
  --account-id "$CLOUDFLARE_ACCOUNT_ID" \
  --database-id "$CLOUDFLARE_DATABASE_ID" \
  --source-commit "$SOURCE_COMMIT" \
  --backup-evidence-digest "$BACKUP_EVIDENCE_DIGEST"
# 3. plan が表示した 4 つの digest を確かめてから適用する
#    （... には plan と同じ指定をすべて書きます）
takosumi accounts migrate-d1 apply ... \
  --confirm-source-digest "$SOURCE_DIGEST" \
  --confirm-catalog-digest "$CATALOG_DIGEST" \
  --confirm-target-digest "$TARGET_DIGEST" \
  --confirm-configuration-digest "$CONFIGURATION_DIGEST"
# 4. 読み取りだけで結果を確かめる
takosumi accounts migrate-d1 verify ...
```

新しく作った D1 には、apply が最初の版から最新の版まで順に適用します。apply は migration
ごとに 1 回だけ atomic な batch を送り、途中で失敗しても自動では再試行しません。読み取りだけの
`status` で状態を確かめてから、次の操作を決めます。CLI はデータベースを復元しません。書き出した
bookmark は復元の手がかりになるため、チェックアウトの外で非公開のまま保管します。適用した後は、
その版を受け付けない古い Worker には戻せません。すでに動いている環境の Accounts D1 を上げる
場合は、[Takosumi 本体を更新する](./upgrade.md)を参照してください。

control plane 側の D1 にマイグレーションは要りません。`TAKOSUMI_CONTROL_D1_SCHEMA_MODE`
が既定の `bootstrap` のあいだ、最初のリクエストでスキーマが整います。事前に用意した
スキーマだけで動かしたい場合は `predeployed` にします。

## secret と一緒に deploy する

wrangler は、環境変数の `CLOUDFLARE_API_TOKEN` を `wrangler login` より優先して使います。D1 の
権限しか持たないトークンで deploy しないよう、先に外します。

Worker がまだ無いうちは `wrangler secret put` で secret を入れられません。secret は非公開の
JSON ファイルにまとめ、最初の deploy と一緒に送ります。入れるのは
`TAKOSUMI_ACCOUNT_SESSION_HASH_SALT`、`TAKOSUMI_ACCOUNTS_ES256_PRIVATE_JWK`、
`TAKOSUMI_ACCOUNTS_OIDC_PAIRWISE_SUBJECT_SECRET`、`TAKOSUMI_SECRET_STORE_PASSPHRASE`
（認証情報と state の封印鍵）、`TAKOSUMI_DEPLOY_CONTROL_TOKEN`（operator 専用 API の
bearer）と、上流の ID プロバイダの client secret と `TAKOSUMI_ACCOUNTS_SUBJECT_SECRET` です。
値の作り方は [Bun と PostgreSQL に置く](./bun-postgres.md)と同じです。値はすべて文字列に
します。ES256 の JWK も、生成した JSON をエスケープした文字列として入れます。client secret の
名前は、記述子の `clientSecretEnv` と同じにします。

```json
{
  "TAKOSUMI_ACCOUNTS_ES256_PRIVATE_JWK": "{\"kty\":\"EC\",\"crv\":\"P-256\",\"d\":\"...\",\"x\":\"...\",\"y\":\"...\"}",
  "TAKOSUMI_ACCOUNT_SESSION_HASH_SALT": "...",
  "COMPANY_SSO_CLIENT_SECRET": "..."
}
```

```bash
unset CLOUDFLARE_API_TOKEN
# $HOME/.takosumi-private/secrets.json に上の形で書く
chmod 600 "$HOME/.takosumi-private/secrets.json"
bun run wrangler -- deploy \
  --config "$HOME/.takosumi-private/wrangler.toml" \
  --secrets-file "$HOME/.takosumi-private/secrets.json"
```

以後の deploy でも、同じファイルを `--secrets-file` で渡します。secrets.json はほかの秘密と
同じように扱い、非公開の場所に置きます。

## apply と destroy について

この手順で置いた Worker では、変更の確認（plan）までは動きますが、apply と destroy は
止まります。apply と destroy には、実行物を示す 3 つの digest
（`TAKOSUMI_CONTROLLER_ARTIFACT_DIGEST`、`TAKOSUMI_RUNNER_ARTIFACT_DIGEST`、
`TAKOSUMI_EXECUTOR_ARTIFACT_DIGEST`）が要ります。今はこれらを Takosumi の release tool だけが
作り、self-host 向けに用意する手順はまだありません。digest の無い Worker は、apply と
destroy の Run を、provider 側には触れずに `execution_evidence_authority_unavailable` で失敗に
します。
