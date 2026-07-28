# 設定リファレンス

Takosumi の endpoint を動かす側が設定する環境変数の一覧です。Cloudflare 構成では
`[vars]` と `wrangler secret put`、Bun と PostgreSQL の構成ではプロセスの環境変数として
渡します。導入の手順は[自分で動かす](../concepts/self-host.md)にあります。

秘密の値は「必須」欄に**秘密**と書いてあります。これらは設定ファイルに書かず、
secret ストアから渡してください。

## サービス全体

| 変数 | 必須 | 既定値 | 決めること |
| --- | --- | --- | --- |
| `TAKOSUMI_ENVIRONMENT` | 任意 | `local` | `local` / `development` / `test` / `staging` / `production` のどれか。`staging` と `production` では暗号鍵と永続ストアの検査が fail-closed になります。`NODE_ENV`、`ENVIRONMENT` も同じ順で読みます |
| `TAKOSUMI_DEV_MODE` | 任意 | 未設定 | `1` / `true` / `yes` / `on` / `enabled` のどれかにすると、非本番で暗号鍵を設定しないまま起動できます。`staging` と `production` では効きません |
| `PORT` | 任意 | `8788` | `bun core/index.ts` で起動したときの待ち受けポート |
| `TAKOSUMI_DATABASE_URL` | `bun core/index.ts` で control plane を単体で動かすとき必須 | なし | control plane の PostgreSQL 接続先。`DATABASE_URL` も同じ用途で読みます。同梱の compose は control plane と accounts を 1 つの接続で動かすので、そちらでは `TAKOSUMI_ACCOUNTS_DATABASE_URL` だけを設定します |
| `TAKOSUMI_DB_AUTO_MIGRATE` | 任意 | `false` | `bun core/index.ts` の起動時にマイグレーションを適用するか。既定では適用せず、読み取りだけで検証します。`staging` と `production` で `true` にすると起動が失敗します |
| `TAKOSUMI_DEPLOY_CONTROL_TOKEN` | 実運用では必須・**秘密** | なし | operator 専用 API の bearer。CLI と operator client が使います。Cloudflare 構成でこれを設定しないと、`/v1/resources` から `/v1/form-activations` までの Resource 系 API がまるごと `404` になります |
| `TAKOSUMI_METRICS_SCRAPE_TOKEN` | 任意・**秘密** | なし | `/metrics` を読むための bearer。未設定のあいだ `/metrics` は `404` を返します |

```bash
export TAKOSUMI_ENVIRONMENT=production
export TAKOSUMI_DATABASE_URL="postgres://takosumi:<password>@db.example.com:5432/takosumi"
export TAKOSUMI_DEPLOY_CONTROL_TOKEN="$(openssl rand -hex 32)"
```

## 秘密の保護

| 変数 | 必須 | 既定値 | 決めること |
| --- | --- | --- | --- |
| `TAKOSUMI_SECRET_STORE_PASSPHRASE` | `staging` / `production` で必須・**秘密** | なし | ProviderConnection、state、plan を封印する AES-GCM 鍵のもと。UTF-8 で 32 バイト以上が必要です。`TAKOSUMI_SECRET_STORE_KEY` も同じ用途で読みます |
| `TAKOSUMI_SECRET_STORE_PARTITION_PASSPHRASES` | 任意・**秘密** | なし | 区画ごとに別の鍵を使う場合の `区画名 → passphrase` の JSON。省略すると全区画が上の鍵から導出されます |
| `TAKOSUMI_DATABASE_ENCRYPTION_AT_REST` | `bun core/index.ts` を `staging` / `production` で使うとき必須 | なし | 保存時暗号化を確認済みとして宣言します。値は `verified` だけです |
| `TAKOSUMI_DATABASE_ENCRYPTION_EVIDENCE` | 任意 | `operator-attested` | 何をもって確認したかを書いた非 secret の文字列 |

```bash
export TAKOSUMI_SECRET_STORE_PASSPHRASE="$(openssl rand -base64 48)"
export TAKOSUMI_DATABASE_ENCRYPTION_AT_REST=verified
export TAKOSUMI_DATABASE_ENCRYPTION_EVIDENCE="rds-storage-encrypted-kms-key-abc123"
```

保存時暗号化は、接続文字列の形から推測することなく、宣言された証跡だけで判断します。
`bun core/index.ts` で起動する control plane は、`staging` と `production` でこの宣言を
求めます。storage adapter 側の証跡があれば、そちらでも通ります。

## サインインと OIDC

accounts は OIDC の issuer そのものです。ここで決めた issuer が、dashboard と、
Takosumi にサインインする製品の入口になります。

| 変数 | 必須 | 既定値 | 決めること |
| --- | --- | --- | --- |
| `TAKOSUMI_ACCOUNTS_ISSUER` | Cloudflare 構成では必須 | PostgreSQL 構成では `http://localhost:<port>` | 公開する issuer URL。Cloudflare 構成はリクエスト URL から推測せず、未設定なら起動しません |
| `TAKOSUMI_ACCOUNTS_DATABASE_URL` | PostgreSQL 構成で必須 | なし | accounts の PostgreSQL 接続先。`takosumi accounts migrate` もこれを読みます |
| `TAKOSUMI_ACCOUNTS_ES256_PRIVATE_JWK` | https の issuer で必須・**秘密** | なし | id_token に署名する P-256 の JWK。秘密の `d` を含みます。未設定だとプロセスごとに鍵が変わり、再起動やレプリカ追加で検証が壊れます |
| `TAKOSUMI_ACCOUNTS_ES256_KEY_ID` | 任意 | JWK の `kid` | JWKS に載せる鍵 ID。JWK に `kid` も無い場合は配布ごとの固定値になります |
| `TAKOSUMI_ACCOUNTS_ES256_PREVIOUS_PUBLIC_JWKS` | 任意 | なし | 鍵の入れ替え中に併記する 1 つ前の公開鍵 JWKS。秘密の `d` は入れません |
| `TAKOSUMI_ACCOUNTS_OIDC_PAIRWISE_SUBJECT_SECRET` | 署名鍵を設定したとき必須・**秘密** | なし | client ごとの subject を導出する secret。署名鍵だけ設定して省くと起動しません |
| `TAKOSUMI_ACCOUNT_SESSION_HASH_SALT` | 必須・**秘密** | なし | セッション ID を保存時にハッシュする salt。Cloudflare では未設定だと起動せず、Bun では `NODE_ENV=production` または `TAKOSUMI_ENV=production` のときに起動しません |
| `TAKOSUMI_ACCOUNTS_CLIENTS` | 任意 | なし | 静的に登録する OIDC client の JSON 配列。`clientId` と `redirectUris` が必須で、`tokenEndpointAuthMethod` と `allowedScopes` を添えられます |
| `TAKOSUMI_ACCOUNTS_CLIENT_ID` / `TAKOSUMI_ACCOUNTS_REDIRECT_URIS` | 任意 | なし | client を 1 つだけ登録する短い書き方。両方そろえて設定します |
| `TAKOSUMI_ACCOUNTS_CLIENT_SECRET` | 任意・**秘密** | なし | 上の client を機密 client にする場合の secret。PKCE だけの公開 client では空にします |
| `TAKOSUMI_ACCOUNTS_CLIENT_AUTH_METHOD` | 任意 | secret があれば `client_secret_post`、無ければ `none` | `client_secret_basic` / `client_secret_post` / `none` のどれか |
| `TAKOSUMI_ACCOUNTS_ALLOWED_SCOPES` | 任意 | なし | 上の client に許す scope のカンマ区切り |
| `TAKOSUMI_ACCOUNTS_UPSTREAM_PROVIDERS` | 任意 | なし | 上流の OAuth / OIDC provider の記述子の JSON 配列。endpoint と client id と secret の**変数名**を書きます |
| `TAKOSUMI_ACCOUNTS_SUBJECT_SECRET` | 上流 provider を設定したとき必須・**秘密** | なし | 上流の subject を Takosumi の subject に写すときのハッシュ secret |
| `TAKOSUMI_ACCOUNTS_UPSTREAM_SESSION_TTL_MS` | 任意 | なし | 上流サインインで作るセッションの寿命 (ミリ秒)。上流 provider と一緒に設定します |
| `TAKOSUMI_ACCOUNTS_PASSKEY_RP_ID` / `TAKOSUMI_ACCOUNTS_PASSKEY_RP_NAME` / `TAKOSUMI_ACCOUNTS_PASSKEY_ORIGIN` | 任意 | なし | passkey を使う場合の relying party。3 つそろえないと起動しません。PostgreSQL 構成は origin を `TAKOSUMI_ACCOUNTS_PASSKEY_RP_ORIGIN` からも読みます |
| `TAKOSUMI_ACCOUNTS_PRIVACY_OPERATIONS_TOKEN` | 任意・**秘密** | なし | プライバシー要求の完了を記録する operator token |

client の登録は次の形です。

```bash
export TAKOSUMI_ACCOUNTS_CLIENTS='[{"clientId":"takosumi-dashboard","redirectUris":["https://takosumi.example.com/sign-in/callback"],"tokenEndpointAuthMethod":"none"}]'
```

上流の provider は、記述子と secret を分けて渡します。記述子に secret の値そのものを
書くと起動しません。

```bash
export TAKOSUMI_ACCOUNTS_UPSTREAM_PROVIDERS='[{"providerId":"company-sso","label":"Company SSO","issuer":"https://id.example.com","authorizationEndpoint":"https://id.example.com/oauth/authorize","tokenEndpoint":"https://id.example.com/oauth/token","userInfoEndpoint":"https://id.example.com/oauth/userinfo","clientId":"accounts-client","clientSecretEnv":"COMPANY_SSO_CLIENT_SECRET","redirectUri":"https://takosumi.example.com/sign-in/callback","scopes":["openid","profile","email"]}]'
export COMPANY_SSO_CLIENT_SECRET="<upstream client secret>"
```

`providerId` は表示と識別のための名前で、挙動は選びません。何個でも並べられます。

## Resource の型を開ける

Takosumi は既定では Resource の型を 1 つも受け付けません。使えるようにする型は
ここで明示します。

| 変数 | 必須 | 既定値 | 決めること |
| --- | --- | --- | --- |
| `TAKOSUMI_RESOURCE_SHAPES` | 任意 | なし (公開する型なし) | `/v1/resources` に出す Resource の型。カンマか空白区切り、JSON の文字列配列、または `all` |
| `TAKOSUMI_RESOURCE_ADAPTERS` | 任意 | なし | `/v1/capabilities` に出す adapter の capability token。書式は上と同じです。型を 1 つも開けていないあいだは何を書いても出ません |
| `TAKOSUMI_OPERATOR_CAPABILITIES` | 任意 | なし | `/v1/capabilities` に出す運用系 capability。`all` も使えます |
| `TAKOSUMI_RESOURCE_PROVIDER_BASE_URL_ALLOWLIST` | 任意 | なし | TargetPool の実装オプションに書いてよい provider API の base URL。未設定なら上書きを拒否します |

```bash
export TAKOSUMI_RESOURCE_SHAPES="ObjectBucket,EdgeWorker"
```

型の名前として書けるのは、この host にスキーマが入っているものだけです。入っていない
名前を書くと、その時点で起動が失敗します。スキーマ自体はコードとして持ち込むもので、
環境変数では追加できません。

## 定期観測

`TAKOSUMI_RESOURCE_SHAPES` で型を 1 つ以上開けると、Ready な Resource の定期観測が
既定で動きます。観測は読み取り専用で、固定済みの配置先と実装に対して差分を見るだけです。

| 変数 | 必須 | 既定値 | 決めること |
| --- | --- | --- | --- |
| `TAKOSUMI_RESOURCE_OBSERVATION_ENABLED` | 任意 | 型を開けていれば有効 | `1` で動かします。設定したうえで `1` 以外を書くと、`true` でも `yes` でも止まります |
| `TAKOSUMI_RESOURCE_OBSERVATION_BATCH` | 任意 | `8` | 1 回の起動で受け持つ Resource の数。`1` から `32` まで |
| `TAKOSUMI_RESOURCE_OBSERVATION_CONCURRENCY` | 任意 | `4` | 同時に走らせる観測の数。`1` から `8` まで。1 回で受け持つ数より大きくは走りません |
| `TAKOSUMI_RESOURCE_OBSERVATION_INTERVAL_SECONDS` | 任意 | `3600` | 同じ Resource を続けて観測しない間隔。`300` から `604800` まで |
| `TAKOSUMI_RESOURCE_OBSERVATION_LEASE_SECONDS` | 任意 | `900` | 放置された観測を他が引き取れるようになるまでの時間。`600` から `7200` まで |

```bash
export TAKOSUMI_RESOURCE_OBSERVATION_INTERVAL_SECONDS=7200
export TAKOSUMI_RESOURCE_OBSERVATION_CONCURRENCY=2
```

範囲の外の値や数値でない値を書くと、既定値に戻ります。runner の空き容量に合わせて
小さく保ってください。

## Run と runner

| 変数 | 必須 | 既定値 | 決めること |
| --- | --- | --- | --- |
| `TAKOSUMI_ENABLED_RUNNER_PROFILES` | 任意 | `opentofu-default` | 有効にする実行プロファイルの ID をカンマ区切りで。空にすると既定の 1 つだけになります |
| `TAKOSUMI_DEFAULT_RUNNER_PROFILE_ID` | 任意 | `opentofu-default` | プロファイルを指定しない要求が使うプロファイル。上で有効にしたものに限ります |
| `TAKOSUMI_OPENTOFU_PLUGIN_CACHE_DIR` | 任意 | runner コンテナでは `/tmp/takosumi-provider-cache` | provider のバイナリを置いて Run 間で使い回すパス。認証情報、生成した root、plan、state はここに入りません |
| `TAKOSUMI_SOURCE_BUILD_CACHE_DIR` | 任意 | なし | `sourceBuild` を走らせるときの依存パッケージのキャッシュ置き場。絶対パスで書きます。この下の `bun` / `npm` / `xdg` を Bun と npm に渡します |
| `TAKOSUMI_RUNNER_KEEPALIVE_SECONDS` | 任意 | `0` | Run を終えたコンテナを何秒生かすか。上限は `900` です。runner の Durable Object は Run ごとなので、増やしても次の Run では使い回しません |
| `TAKOSUMI_SOURCE_ARCHIVE_ZSTD_LEVEL` | 任意 | `3` | SourceSnapshot を固める zstd の圧縮レベル。`1` から `19` まで。低いほど書庫は大きく、初回の取り込みは速くなります |
| `TAKOSUMI_SCHEDULED_SOURCE_POLL_BATCH` | 任意 | `5` | 定期ポーリング 1 回で拾う自動同期 Source の上限 |
| `TAKOSUMI_COMPATIBILITY_CHECK_TIMEOUT_MS` | 任意 | `45000` | 互換チェックのソース展開をリクエスト経路で待つ上限 (ミリ秒) |

`TAKOSUMI_OPENTOFU_PLUGIN_CACHE_DIR` を空にすると、runner は Run ごとの作業領域に
provider を展開します。共有しない代わりに、Run のあいだの取り違えが起きません。

```bash
export TAKOSUMI_ENABLED_RUNNER_PROFILES="opentofu-default"
export TAKOSUMI_OPENTOFU_PLUGIN_CACHE_DIR="/tmp/takosumi-provider-cache"
```

## 署名済み Form Package を受け入れる

署名済みの Form Package を使う場合だけ設定します。Cloudflare 構成では
`R2_FORM_PACKAGES` binding と対にします。片方だけ設定すると起動しません。

| 変数 | 必須 | 既定値 | 決めること |
| --- | --- | --- | --- |
| `TAKOSUMI_FORM_PACKAGE_TRUST_POLICY` | 任意 | なし | package を読む R2 の接頭辞、digest を固定した Sigstore の TrustedRoot、受け入れる publisher を書いた非 secret の JSON |

```bash
export TAKOSUMI_FORM_PACKAGE_TRUST_POLICY='{"schemaVersion":1,"artifactPrefix":"packages/","trustedRoot":{"key":"trust/trusted-root.json","digest":"sha256:0000000000000000000000000000000000000000000000000000000000000000"},"publishers":[{"oidcIssuer":"https://token.actions.githubusercontent.com","sourceRepository":"example/forms","workflow":".github/workflows/release.yml","tagPattern":"refs/tags/v*"}]}'
```

書ける鍵はこの 4 つずつだけで、余分な鍵があると読み込みに失敗します。
`artifactPrefix` は `/` で終える必要があります。`tagPattern` は `refs/tags/` で
始める完全な ref で書き、`*` はスラッシュをまたがない 1 区画に一致します。
`workflow` は `.github/workflows/` の下の `.yml` か `.yaml` だけを指せます。
この設定だけでは package は 1 つも導入されません。どの package を入れるかは別に
決めます。

## Cloudflare 構成で使うもの

| 変数 | 必須 | 既定値 | 決めること |
| --- | --- | --- | --- |
| `TAKOSUMI_CONTROL_D1_SCHEMA_MODE` | 任意 | `bootstrap` | `bootstrap` はリクエスト時にスキーマを用意します。`predeployed` はそれを止め、マイグレーション台帳が揃っていることを読み取り専用で確かめます |
| `TAKOSUMI_PRODUCTION_HARDENING_GATE` | 任意 | `observe` | `observe` は不足を報告するだけです。`enforce` は証跡が欠けているあいだ内部の点検 endpoint が `503` を返します |
| `TAKOSUMI_PLATFORM_HARDENING_EVIDENCE` | `enforce` のとき必須 | なし | 上の点検に答える非 secret の JSON |
| `TAKOSUMI_RELEASE_ACTIVATOR_URL` | 任意 | なし | apply の後にアプリ公開を引き受ける webhook の URL |
| `TAKOSUMI_RELEASE_ACTIVATOR_TOKEN` | 上を設定したとき必須・**秘密** | なし | その webhook に渡す bearer |
| `TAKOSUMI_RELEASE_SOURCE_BUCKET` | 任意 | なし | webhook に渡す SourceSnapshot の bucket 名 |

これらは `wrangler.toml` の `[vars]` に書くか、secret として押し込みます。

```bash
bunx wrangler secret put TAKOSUMI_RELEASE_ACTIVATOR_TOKEN \
  --config deploy/platform/wrangler.toml
```

## PostgreSQL 構成で使うもの

| 変数 | 必須 | 既定値 | 決めること |
| --- | --- | --- | --- |
| `TAKOSUMI_ACCOUNTS_PUBLIC_HOSTNAME` | Caddy を使う場合は必須 | `app.example.com` | 利用者が叩く公開ホスト名。Caddy はこの名前で ACME の証明書を取ります |
| `TAKOSUMI_ACCOUNTS_BIND_HOST` | 任意 | `0.0.0.0` | コンテナの中で待ち受けるアドレス |
| `TAKOSUMI_ACCOUNTS_PORT` | 任意 | `8787` | 待ち受けるポート。`PORT` を設定するとそちらが優先されます |
| `TAKOSUMI_ACCOUNTS_STATIC_DIR` | 任意 | リポジトリ内の dashboard ビルド | dashboard の配布物を置いた場所 |
| `TAKOSUMI_ACCOUNTS_PG_POOL_MAX` | 任意 | `20` | 接続プールの上限 |
| `TAKOSUMI_ACCOUNTS_PG_IDLE_TIMEOUT_MS` | 任意 | `30000` | 遊んでいる接続を切るまでの時間 |
| `TAKOSUMI_ACCOUNTS_PG_CONNECT_TIMEOUT_MS` | 任意 | `5000` | 接続の確立を待つ時間 |
| `TAKOSUMI_ACCOUNTS_PG_STATEMENT_TIMEOUT_MS` | 任意 | `30000` | 1 文を待つ時間 |
| `TAKOSUMI_ACCOUNTS_PG_SSL_MODE` | 任意 | `disable` | `disable` / `require` / `verify-ca` / `verify-full` |
| `TAKOSUMI_ACCOUNTS_PG_SSL_ROOT_CERT` | `verify-ca` / `verify-full` で必須 | なし | PEM の CA バンドル |
| `POSTGRES_PASSWORD` | compose を使う場合は必須・**秘密** | なし | 同梱の compose が PostgreSQL に設定するパスワード |
| `TAKOSUMI_REVIEWED_PROVIDER_ASSET_ROOT` | イメージをビルドする場合は必須 | なし | レビュー済み provider ミラーの絶対パス。ビルドの入力で、実行時には渡りません |

同梱の compose は `deploy/node-postgres/.env` からこれらを読みます。

```bash
cat >> deploy/node-postgres/.env <<'ENV'
TAKOSUMI_ACCOUNTS_PUBLIC_HOSTNAME=takosumi.example.com
TAKOSUMI_ACCOUNTS_PG_SSL_MODE=require
ENV
```

## CLI が読むもの

| 変数 | 必須 | 既定値 | 決めること |
| --- | --- | --- | --- |
| `TAKOSUMI_DEPLOY_CONTROL_URL` | `--url` を省くとき必須 | なし | CLI が話しかける Takosumi の origin |
| `TAKOSUMI_DEPLOY_CONTROL_TOKEN` | `--token` を省くとき必須・**秘密** | なし | その origin に渡す bearer |
| `TAKOSUMI_ACCOUNTS_URL` | `--accounts-url` を省くとき必須 | なし | `takosumi accounts tokens` が話しかける accounts の URL |
| `TAKOSUMI_ACCOUNTS_DATABASE_URL` | `--database-url` を省くとき必須 | なし | `takosumi accounts migrate` の接続先 |
| `TAKOSUMI_LANG` | 任意 | `LANG` などから判定 | `ja` で始まる値にすると CLI のヘルプが日本語になります。`TAKOSUMI_LOCALE` も読みます |

```bash
export TAKOSUMI_DEPLOY_CONTROL_URL=https://takosumi.example.com
export TAKOSUMI_DEPLOY_CONTROL_TOKEN="$(cat ~/.config/takosumi/token)"
takosumi connections list
```

## 関連

- [自分で動かす](../concepts/self-host.md)
- [CLI](./cli.md)
- [Resource](../concepts/resources.md)
- [製品の境界](../concepts/boundaries.md)
