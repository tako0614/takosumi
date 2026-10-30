---
outline: [2, 3]
---

# Takosumi API

Takosumi API は、Git を正とする OpenTofu / Terraform control plane、provider 接続、Run、
Interface / InterfaceBinding を公開します。Workspace / Capsule / Run などの用語は
[用語集](./glossary.md) を参照してください。

外部インフラには既存 provider と標準 API を使います。Takoform は通常の OpenTofu
provider です。その他の API / instance lifecycle は、それを提供する external Host が
所有します。

## 最初に呼んでみる

1. dashboard で API キーを作ります（[トークンを発行する](./cli.md#トークンを発行する)）。
   読むだけなら **読み取り**、変更もするなら **読み取り** と **書き込み** を選びます。
   次の例で使える Workspace をすべて読むため、**現在のワークスペースだけで使用できるように
   する** はオフにします。オンのままだと、そのワークスペースだけが返ります。

   サーバーの設定にも同じ名前の `TAKOSUMI_DEPLOY_CONTROL_TOKEN` がありますが、そちらはすべての
   Workspace に作用する operator 用の秘密です。**利用者には渡さず、ふつうの CLI や API の呼び出しにも
   使わないでください。** 使うのは、operator のマシンで `takosumi connections` のような operator 専用の
   操作をするときだけです。
2. 使える Workspace を読みます。`TAKOSUMI_DEPLOY_CONTROL_URL` には、dashboard に
   サインインしている origin を入れます。API の path は、その origin の `/api/v1/...` です。

   ```bash
   export TAKOSUMI_DEPLOY_CONTROL_URL=https://takosumi.example.com
   export TAKOSUMI_DEPLOY_CONTROL_TOKEN=<作った API キー>

   curl -sS "$TAKOSUMI_DEPLOY_CONTROL_URL/api/v1/workspaces" \
     -H "authorization: Bearer $TAKOSUMI_DEPLOY_CONTROL_TOKEN"
   ```

   応答の例です（一部を省いています）。

   ```json
   {
     "workspaces": [
       { "id": "ws_example", "handle": "alice", "displayName": "Alice", "type": "personal" }
     ],
     "returned": 1,
     "limit": 100,
     "truncated": false
   }
   ```

   `id` を、ほかの API の `workspaceId` に使います。1 回に返るのは最大 100 件です。続きが
   あるときは `nextCursor` が入ります。
3. 失敗したときの応答は 2 通りです。
   - API キーが無い、違う、期限切れのときは `401` で、本文は `{"error":"invalid_token"}`
     です。`WWW-Authenticate` header も付きます。
   - それ以外（権限が足りない `403` など）は、`error.code`、`error.message`、
     `error.requestId` を持つ JSON です（[エラーの形式](#エラーの形式)）。問い合わせるときは
     `requestId` を添えます。

作成する API のいくつかは `Idempotency-Key` header が必須です。どの API に必要かと、同じ
キーで送り直したときの扱いは、下の各節に書いてあります。

## 基本方針

| 状況                                                | 扱い方                                                         |
| --------------------------------------------------- | -------------------------------------------------------------- |
| 外部 resource に標準 API / OpenTofu provider がある | Git の module からその provider をそのまま使う（Stack flow） |
| Form を提供する Host がある                         | その Host が定義・instance・lifecycle を所有する |
| 一回限りの不足                                      | 環境変数で認証情報を渡す汎用の接続（`--recipe generic-env --auth-mode env`）と通常の OpenTofu module で扱う |

Takosumi は自前の Terraform / OpenTofu provider を配布しません。Takoform は通常の
provider として使います。外部 provider は Git の module からそのまま実行され、
Interface / InterfaceBinding は provider-neutral な接続認可を表します。
Cloudflare 固有の import/deploy compatibility profile は廃止済みです。この API の一部ではありません。

## エンドポイントの探索

すべての Takosumi endpoint は、次の discovery endpoint を公開します。

```http
GET /.well-known/takosumi
GET /api/v1/capabilities
GET /openapi.json
```

CLI、dashboard、Takoform client とその他の API client は、edition 名ではなく
capability を参照します。

例を示します。

```json
{
  "product": "takosumi",
  "name": "Takosumi",
  "auth": {
    "oidc": true,
    "password": false
  },
  "apiBaseUrl": "https://takosumi.example.com/api/v1",
  "api_versions": ["takosumi.dev/v1alpha1"],
  "features": {
    "stacks": true,
    "opentofu_runner": true,
    "oidc": true,
    "workload_identity": true,
    "interfaces": true
  },
  "endpoints": {
    "api": "https://takosumi.example.com/api/v1",
    "capabilities": "https://takosumi.example.com/api/v1/capabilities",
    "openapi": "https://takosumi.example.com/openapi.json",
    "oidc_issuer": "https://takosumi.example.com"
  }
}
```

field 名は大文字と小文字を区別します。ほとんどは snake_case ですが、`apiBaseUrl` と
`oidcClientId` は camelCase です。`product` は常に `takosumi` で、client は最初にこれを
確認します。`endpoints.api` は origin そのものではなく `<origin>/api/v1` です。
`features.opentofu_runner` は、その endpoint に OpenTofu runner が構成されている
ときだけ `true` です。runner の無い構成 (Bun + PostgreSQL の reference など) は
`false` を返します。

`endpoints.oidc_issuer` は、運用者が設定した Accounts の issuer
(`TAKOSUMI_ACCOUNTS_ISSUER`) です。request の origin とは限りません。client は OIDC の
discovery をこの issuer から読みます。

`oidcClientId` は Takosumi Mobile が使う public な OIDC client の id です。どの instance でも
既定で組み込みの `takosumi-mobile` を返します (redirect は `takosumi://oauth/callback`、
scope は `openid profile offline_access capsules:read capsules:write`、PKCE S256 が必須)。
この client への許可には毎回同意の画面が出ます。運用者が
`TAKOSUMI_MOBILE_OIDC_BUILTIN_CLIENT=false` で組み込みの client を止め、
`TAKOSUMI_MOBILE_OIDC_CLIENT_ID` も設定していない endpoint は `oidcClientId` を返しません。
追加の endpoint family を公開する
endpoint は `endpoints.extensions` を併せて返します。

## 認証

API client は endpoint の設定に応じて session cookie または bearer token を使います。

```http
Authorization: Bearer <token>
```

どの Takosumi endpoint も、operator が有効化した session / bearer token 方式を
capability として公開します。Takosumi API key は、Takosumi Accounts の
personal access token です。S3-compatible endpoint のように標準 protocol 自体が
署名方式を持つ場合は、その protocol の署名を使います。

### Accounts personal access token

PAT の公開 Accounts surface は次のとおりです。これらの応答は成功・認証失敗・入力
エラーを含め、必ず `Cache-Control: no-store` と `Pragma: no-cache` を返します。

| メソッド | パス                                      | 認証                               | 説明                                |
| -------- | ----------------------------------------- | ---------------------------------- | ----------------------------------- |
| GET      | `/api/v1/account/tokens`                  | account session                    | 対話的一覧                          |
| GET      | `/api/v1/account/tokens/scopes`           | account session                    | 現在の self-service scope catalog   |
| POST     | `/api/v1/account/tokens`                  | account session                    | PAT を作成する                      |
| POST     | `/api/v1/account/tokens/{tokenId}/revoke` | account session                    | PAT を失効する                      |
| GET      | `/api/v1/account/tokens/inventory.v1`     | account session                    | 完全な versioned metadata inventory |
| GET      | `/api/v1/account/tokens/current`          | `Authorization: Bearer <PAT>` のみ | 提示した PAT 自身の現在の authority |

scope catalog は core の `read` / `write` と、同じ owning route が
`selfServicePatScopes` で明示した allowlist 済み extension scope だけを
self-service として返します。Takosumi hosted AI の `ai.models.read` / `ai.chat` /
`ai.embeddings` と `resources:read` に Workspace binding は要りません (TASK-0118 9.1。
catalog はすべての scope で `workspaceBinding: "optional"` を返します)。これらの token は
`appIds` でアプリに限る (作成時に呼び出し元がそのアプリの所有者かメンバーであることを確かめ、
アプリを対象にするリクエストのたびに今の役割を確かめ直します) か、アカウント自身の権限で動きます。旧来の `workspace_id` 指定は当面
受け付け、Phase 9.3 で `400` にします。extension scope が core のアカウント API
(`read` / `write` の route) に広がることはなく、まだ Workspace を要る host の route は、
範囲を確かめられない token を引き続き拒否します。dashboard の key 作成画面は、host の route が
アプリ単位・アカウント単位の key を受け付けるまで `read` / `write` だけを出します。`admin` や
route が明示していない scope を request scope から推測して公開しません。

`GET /api/v1/account/tokens/inventory.v1` は既存 dashboard 用一覧を置き換えません。既定
`limit` は 50、最大は 100 で、`created_at`、次に `token_id` の昇順です。応答 kind は
`takosumi.account-pat-inventory@v1` で、閉じた envelope の field は `kind`、`tokens`、
`total`、`returned`、`limit`、`truncated`、`next_cursor` です。`total` は cursor 適用前の
active / revoked を含む subject 所有 PAT 全数で、同じ一つの storage statement が count、
cursor anchor、`limit + 1` page を読みます。各 token は `token_id`、`subject`、`name`、
`prefix`、`scopes`、`workspace_id`、`created_at`、`expires_at`、`revoked_at`、
`last_used_at` だけを持ち、任意 metadata は `null` です。secret は返しません。cursor は
opaque で、malformed または subject に属する exact anchor が失われた cursor は 400
`invalid_request` です。

`GET /api/v1/account/tokens/current` は ambient cookie、
`x-takosumi-account-session`、query/body の token を使いません。提示された opaque bearer
を account session、OAuth access token、PAT の全 store に照合し、衝突、non-PAT、失効、
期限切れは 401 `invalid_token` です。成功 kind は
`takosumi.account-pat-authority@v1` で、field は `kind`、`token_id`、`subject`、`scopes`、
`workspace_id`、`expires_at`、`workspace_role` だけです。generic PAT では Workspace field
は `null` です。Workspace-bound PAT は現在の active membership を専用の一件 SELECT
で検証します。検証不能は 503 `verification_unavailable`、inactive / 不一致は 403
`workspace_membership_inactive` です。この read は `last_used_at`、audit、session、Control
schema、Workspace / Project / TargetPool を更新・bootstrap しません。

## OpenTofu Stack API

Stack API は通常の OpenTofu / Terraform module を Git から実行します。
この flow では既存 provider をそのまま使います。

module graph は immutable SourceSnapshot 内の tracked regular files と vendored local
source（`./` / `../`）だけを辿ります。pinned を含む remote module source は v1 では
未対応で、`tofu init` への network fetch authority にはなりません。scan / compatibility
は部分的な provider set を公開せず fail closed するため、dependency は repository tree
へ vendor してください。

stock composition は、すべての正しい provider source に provider-neutral な
`opentofu-default` 実行経路を使います。operator は別の capability profile を明示
選択できます。Credential Recipe は env/file の設定を簡単にする補助情報です。Recipe が
ない provider も、generic な env/file の ProviderConnection を作れば実行できます。

`providerConfig` と `moduleInputDefaults` は非 secret の metadata です。endpoint、
region、通常の module default をここに書きます。credential らしい field は拒否されます。
token / password / private key などは、ProviderConnection の write-only な
`values` / `files` に保存します。Run では Credential Recipe を経由して一時注入します。

provider cache / mirror があれば `tofu init` はそれを利用し、なければ通常の
OpenTofu registry 経路を利用します。mirror を必須にする場合は operator policy
として明示します。

Takosumi の公開 JSON API はすべて `/api/v1` の下にあります。旧 `/v1` は公開 API
ではなく、既知の旧 path は 404 で fail closed します。OIDC/OAuth、well-known、
health/metrics、operator-only `/internal/v1` はそれぞれ独立した protocol/authority です。

正本 (正とする情報) は `accounts/service/src/control-route-inventory.ts` で、公開されているのは
次の 114 件です。 Accountsを組み込んだ構成は同じ一覧を `/openapi.json` に含め、`x-takos-public-session-endpoint-count` に件数を示します。Coreだけのプロセスには未mountのAccounts routeを載せません。

### アプリの所有と個人の接続・使用量

`GET /api/v1/apps?cursor&limit` は、自分が所有または管理するアプリを、現在の `role`・所有者の表示名・状態・主な操作とともに返します。アプリを使うだけの人には管理権限を付与しません。

| メソッド | パス | 権限と入力 |
| --- | --- | --- |
| GET | `/api/v1/capsules/{capsuleId}/members` | 所有者・メンバー。メールは所有者にだけ表示 |
| POST | `/api/v1/capsules/{capsuleId}/members` | 所有者。`{ email, consent: "connections_and_code" }`。確認済みアカウントを追加 |
| DELETE | `/api/v1/capsules/{capsuleId}/members/{accountId}` | 所有者または離脱本人。本人の待機・承認待ちRunを同じ書き込みで取消 |
| GET | `/api/v1/capsules/{capsuleId}/ownership-transfers?state=pending` | 所有者・受取人。`{ ownershipTransfers: [...] }`。各要素にアプリ名と送信者の表示名を含む |
| GET | `/api/v1/ownership-transfers?state=pending` | 本人宛の保留中譲渡を最大50件返す。各要素にアプリ名と送信者の表示名を含む |
| POST | `/api/v1/capsules/{capsuleId}/ownership-transfers` | 所有者。`{ toAccountId }`。受取人の保留中譲渡は最大50件、送信者の作成は1時間に最大10件 |
| POST | `/api/v1/ownership-transfers/{transferId}/accept` | 受取人。実行をdrainし、所有epochを増加、接続bindingをリセット |
| DELETE | `/api/v1/ownership-transfers/{transferId}` | 所有者。保留中の譲渡を取消 |
| GET, POST | `/api/v1/connections` | 本人の個人接続とoperatorのbindable接続。新規接続の所有者は本人 |
| GET | `/api/v1/connections?capsuleId=…&projection=labels` | 所有者・メンバー本人のセッションまたは個人アクセストークン（appIds付きを含む）。このアプリに結べる接続（所有者の検証済み接続、operatorが提供するbindable接続、いまbindingされている接続）を `{ id, provider, displayName }` だけで返し、メンバーはこの中から選び直せる。値・状態・scopeなどの詳細は返さない。インストール済みアプリのOAuthトークンには、そのアプリにbinding済みの接続だけを返す。1回のリクエストで読む所有者の接続は決まった大きさの1ページまで（`owner_account_id` にはまだindexがない）で、`nextCursor` で続きを返す。選べない接続を飛ばすため、件数が `limit` 未満でも続きがあることがある。bindingと資格情報発行の検査（接続の所有者＝アプリの所有者）が最終判断 |
| POST | `/api/v1/connections/oauth/{helperId}/start` | アカウント資格情報 (Workspaceに束縛した資格情報は不可)。OAuthのstateにWorkspaceは入らず、callbackは署名された本人だけで判定し、できる接続は本人のもの。workspaceId省略時は個人接続。互換のためworkspaceIdを付けた要求はWorkspace scopeの接続を求める意味になり、指定したWorkspaceは読まず、本人の個人の場所に記録する。Workspaceを含む古いstateのcallbackは作らずに `oauth_failed` |
| GET | `/api/v1/connections?workspaceId=…`、`/api/v1/provider-connections?workspaceId=…` | 互換の一覧。そのWorkspaceを記録した接続のうち本人が所有するものだけ (provider-connectionsはoperatorのbindable接続も)。Workspaceのメンバーであっても他人の接続は見えない |
| POST | `/api/v1/connections/{connectionId}/test`・`/revoke` | 接続の所有者だけ。Workspace scopeの接続も所有者のもので、Workspaceの所有者・管理者であることは権限にならない (所有者の記録が無い古い行だけ、記録されたWorkspaceの所有者を所有者とみなす)。それ以外は存在を明かさない `404 connection_not_found` |
| POST | `/api/v1/sources`、`PATCH /api/v1/sources/{sourceId}` の `authConnectionId` | どのアプリも所有しないSourceには本人の接続だけ。アプリのSourceにはアプリの所有者の接続だけ (Sourceサービスが判定)。Workspaceのメンバーであっても他人の資格情報は使えない |
| GET | `/api/v1/source-ref-resolutions?url=…` | write scopeを持つアカウント資格情報。runnerを起動して公開Git sourceのstable SemVerタグを解決 |
| POST | `/api/v1/install-plans` | アカウント資格情報。`mode: "attempt"`、workspace指定なし。本人がアプリ所有者 |
| GET | `/api/v1/usage` | アカウント資格情報。本人が支払人の使用量だけ。アプリ単位の独立した計測は、使用期間（計測時刻の前後2時間。アプリ作成より前と記録時刻より後は含めない）が受諾済みの所有権移転で区切られた1つの所有期間に収まるときだけ、その所有者が支払人。収まらない場合や移転履歴が欠けている場合は支払人なし |

operator が `TAKOSUMI_APP_OWNERSHIP_MUTATIONS=frozen` を設定している間、メンバーの追加・削除・脱退と譲渡の申し出・受諾・取消は、アプリを読む前に `409 failed_precondition` (`details.reason: "app_ownership_mutations_frozen"`) を返します。メンバー追加は、確認済みアカウントの有無にかかわらず `202 { accepted: true }` を返します。所有者の `connections_and_code` 同意を監査記録へ保存します。譲渡を受諾すると既存メンバーを全員削除し、監査記録に通知対象を残します。メンバー管理・譲渡・受諾・取消・アンインストールには本人のセッションまたは明示的scopeを持つPATが必要で、インストール済みアプリのOAuthアクセストークンは使えません。

PATには `appIds` を指定できます。実効権限はscopeと現在のアプリ内の役割の積です。アプリに束縛したPATはアカウント全体の個人接続や使用量を読めません。旧Workspace route・claimは互換期間だけ維持します。インストールされたアプリへのOIDCサインインは全アカウントに開き、`takosumi.capsule_id` でアプリを示します。現在の所有者・メンバーだけに `takosumi.app_role` を発行します。

### アプリ管理の権限

アプリに所有記録 (`capsules.owner_account_id`) があるとき、管理操作の可否はそのアプリでの役割だけで決まります。Workspaceの所有者・管理者であっても、アプリの所有者・メンバーでなければ管理できません。逆に、アプリの所有者・メンバーはWorkspaceのメンバーでなくても管理できます。アプリを使うだけの人はメンバーではなく、アプリ自身のURLとアクセス規則で利用します。

| 操作 (`AppAction`) | 所有者 | メンバー | 主なroute |
| --- | --- | --- | --- |
| 表示 (`view`) | 可 | 可 | `GET /capsules/{id}` と配下のGET、そのアプリのRun・StateVersion・Source・InstallConfig・互換レポートのGET |
| 設定変更 (`change_settings`) | 可 | 可 | `PATCH /capsules/{id}`、`configuration-plans`、`install-config-re-adoptions`、`backups`、所有Sourceの `PATCH`・hook secret |
| 更新 (`update`) | 可 | 可 | `plan`、`revision-plans`、`drift-check`、所有Sourceの `sync`・`compatibility-check`、通常のRunの承認・適用・取消 |
| ロールバック (`rollback`) | 可 | 可 | `POST /state-versions/{id}/rollback-plan`、restore Runの承認 |
| 接続の選択 (`choose_connection`) | 可 | 可 | `providerBindings` を含む `configuration-plans`。選べるのは所有者の接続とoperatorのbindable接続だけ |
| Interface linkの変更 (`change_interface_link`) | 可 | 可 | `PUT`・`DELETE /capsules/{id}/interface-links/{key}`、提供側アプリとしての `interface-links/requests` の一覧と `approve`・`decline` |
| アンインストール (`uninstall`) | 可 | 不可 | `DELETE /capsules/{id}`、`uninstall`・`cancel-uninstall`・`abandon`・`destroy-plan`、destroy Runの承認・適用・取消、所有Sourceの `DELETE` |
| 所有者の譲渡 (`transfer_ownership`) | 可 | 不可 | `ownership-transfers` |
| メンバー管理 (`manage_members`) | 可 | 不可 | `members` の追加・削除 (メンバー本人の離脱は可) |

拒否は `403 app_access_denied` (役割がない) または `403 app_owner_only` (所有者だけの操作) です。所有記録の確認と役割の読み取りの間に所有者が変わった場合は `409 conflict` を返し、再試行を求めます。完了したアンインストール後も、残っている所有記録の所有者・メンバーは履歴を表示できます。

Sourceは所有アプリ (`ownerCapsuleId`) のものです。所有アプリの無い既存のSourceは、それを使う稼働中のアプリすべてのものとして扱います。操作には、それらのアプリすべてで、各アプリの規則で許されることが必要です。所有記録のあるアプリはアプリでの判定、所有記録の無いアプリは従来のWorkspace判定です。片方の規則がもう片方の代わりになることはありません。そのSourceの `source_sync` Runと互換レポートも同じです。Sourceが削除済みのRunはアプリに属さないものとしてWorkspace判定で決めます。

Interface linkは、要求者が提供側アプリでも `change_interface_link` を持つとき (所有記録の無い提供側はWorkspace判定) だけ作成時に承認されます。それ以外は `pending_approval` で作られます。インストール時に作るlink (明示的な選択と、候補が1つだけのときの自動選択) も同じ規則です。さらに、インストールを進める人がインストール計画の作成者 (承認者として記録される人) であることも必要です。

`pending_approval` のlinkは、提供側アプリの所有者かメンバー (所有記録の無い提供側はWorkspace判定) が `POST /capsules/{providerId}/interface-links/{linkId}/approve` で承認すると active になり、`decline` で断ると `declined` になります。判定は提供側アプリの `change_interface_link` で、利用側アプリの所有者・メンバーであることは何も与えません。承認・拒否のどちらも、linkがまだ承認待ちで今のlinkであること、`expectedGeneration` が一致すること、提供側と利用側の両方のアプリが稼働中 (`active` か `stale`) でアンインストール予定でないことを確かめ、書き込みの直前に呼び出し元の役割 (所有者の譲渡によるepochの変化を含む) をもう一度確かめます。承認は要求された権限をそのまま渡します。一部だけの承認はまだ扱わず、`approvedPermissions` を送るときは要求と同じ組 (順不同) でなければ `400 invalid_request` です (一部だけを承認すると、利用側に再承認の警告が残り続け、取り消す以外に頼み直す方法が無いためです)。承認後、利用側アプリを使う人には、作成時に承認されたlinkと同じく次のサインインでBindingが作られます。どちらの側からも `DELETE` で取り消せます。断られた後や承認された後も、利用側は改めて提供元を選べます。

既存のlinkの付け替えで、新しいlinkが `pending_approval` になる場合は `409 interface_link_approval_required` で拒否し、今のlink (activeでもpendingでも) をそのまま残します。承認されるまでアプリがInterfaceを失わないようにするためです。承認を求めるときは、今のlinkを `DELETE` してから選び直すと、新しいlinkが `pending_approval` で作られ、提供側アプリの所有者かメンバーが承認できます。`pending_approval` のlinkは、同じ提供側を指定して `PUT` しても今のlinkがそのまま返り、有効になりません。

資格情報の制限は役割より先に適用します。PATの `appIds` に含まれないアプリ、Workspaceに束縛したPATやOAuthトークンの別Workspaceのアプリは拒否します。インストールされたアプリ自身のOAuthアクセストークン (アプリごとのOIDC clientに発行され、そのアプリに束縛されたtoken) は、そのアプリ自身だけに使えます。別のアプリのroute、別のアプリに属するRun・Source・インストール計画、Workspace単位のroute (一覧、`install-plans` の作成など) は `403` です。自分のアプリでも、アプリでの役割と従来のWorkspace判定の両方を満たすときだけ通ります。アンインストール (`destroy-plan`、`DELETE /capsules/{id}`、destroy Runの承認・適用を含む)・譲渡・メンバー管理・新しい接続の選択には使えず、他のアプリのInterfaceを承認することもありません (下の代理指定のアプリを除く)。承認待ちのlinkの一覧・承認・拒否 (`interface-links/requests`・`approve`・`decline`) には、自分のアプリについても使えず `403 app_access_denied` です。例外は、operatorが `TAKOSUMI_ACCOUNTS_DELEGATED_APP_SOURCES` で指定したリポジトリと許可したrefから現在適用されているアプリ (Takosのように利用者の代わりにアプリをインストールするアプリ) だけです。判定はサーバー側で、tokenに束縛されたアプリが同じWorkspaceで稼働中 (無効化・アンインストール予定でない) であり、そのアプリのSource (URLは変更できない) と適用中のrevisionのpathが指定と一致し、さらにrunnerがそのrevisionのsnapshotに記録した完全なref名 (`resolvedRef`) が許可した `refs/heads/…`・`refs/tags/…` に一致するかで行います。インストール時に指定したrefの名前 (`main`、`HEAD` など) は使いません (`git ls-remote` は名前の末尾で照合するため、`1/head` のような名前が `refs/pull/1/head` に解決されることがあるためです)。refを指定しないインストールの `HEAD` は、runnerが既定のbranch (`refs/heads/…`) として記録します。`resolvedRef` の無いsnapshot (commit SHAで取得したもの、この記録を始める前に取得したもの)、`refs/pull/*` など `refs/heads/`・`refs/tags/` 以外のrefは対象外で、clientの申告は使いません。代理に指定されたアプリの配備内容 (revision plan、`rollback-plan`、Sourceの `defaultRef`・`defaultPath`、InstallConfigの再採用) を変えられるのは所有者だけです (所有記録の無いアプリではWorkspaceの所有者だけ)。代理に指定されたアプリのtokenは、利用者が所有者である他のアプリ (所有記録の無いアプリではWorkspaceの所有者) をアンインストールできますが、自分自身のアプリのアンインストール・譲渡・メンバー管理はできません。Interface linkは、利用者が提供側アプリでも `change_interface_link` を持つときだけ作成時に承認します。承認待ちのlinkの承認・拒否も、利用者が提供側アプリの所有者かメンバーであるときだけで、自分自身のアプリへのlinkは決められません。代理でないアプリのtokenは自分のアプリのplanを作れますが、Runの承認・適用・取消はできません (人のセッションかPATが必要)。Runには作った人 (tokenの利用者と同じ) しか記録されず、どのclientが作ったかを区別できないため、取消も一律に拒否します。Sourceの接続 (`authConnectionId`) を変えることや、`compatibility-check` でWorkspaceのInstallConfigを作ること・他のアプリのInstallConfigを指定することもできません。指定されたアプリのtokenは、束縛されたWorkspaceの中で、アプリでの役割とWorkspace判定の両方を満たす範囲だけ使えます。operatorが登録するstatic client (アプリに束縛されないtoken) は従来どおりです。現在のmembershipを要求する共有アカウント構成 (`requireCurrentMembership`) も、アプリでの役割とWorkspace判定の両方を要求します。

Workspace単位のroute (一覧、Workspace設定、Workspace作成、所有者のいないpreflight Source、Workspaceの接続) はPhase 9まで従来のWorkspace判定で互換提供します。ただし一覧 (`/workspaces/{id}/capsules`・`runs`・`activity`・`current-state-versions`・`backups`・`usage`・`installed-apps`・`interface-materialization-failures`、`/dashboard/overview`、`/sources?workspaceId=`) は、所有記録のあるアプリのうち呼び出し元が表示できないアプリの行を含めません。表示できるのは、そのアプリの所有者とactiveなメンバーです (アンインストール後も、残っている所有記録の所有者・メンバーは表示できます)。PATの `appIds` に含まれない所有アプリは表示しません。`/workspaces/{id}/usage` も、表示できないアプリの利用量と費用を含めません。支払者としての自分の利用量は `GET /api/v1/usage` で読みます。所有記録のあるアプリへの操作はアプリでの判定を通ります。

cursorで続きを読む一覧 (`capsules`・`current-state-versions`・`runs`・`backups`・`usage`、`/dashboard/overview`、`/sources?workspaceId=`) は、表示できる行だけをstoreのquery (memory・Postgres・D1) で選びます。表示できない行がいくつ続いても、ページは表示できる行で埋まり、最後まで読み進められます。`nextCursor` はstoreが返す表示できる行のcursorで、表示できない行のIDや時刻は入りません。行の持ち主は次のとおりです。Runは自分のCapsule (Capsuleを持たない古いapply行はそのplanのCapsule)、無ければSourceのアプリです。Sourceは所有アプリ、所有アプリの無いSourceはそれを使う稼働中のアプリすべてです。backupは自分のCapsule、Capsuleを示さないbackupは稼働中の全アプリです。usageは自分のCapsule、無ければRunのアプリです。Runが残っていないusageは、所有記録のあるアプリがWorkspaceにある間は表示しません。行の持ち主のアプリが1つでも表示できなければ、その行は表示しません。所有記録のschemaが無いtarget (D1 v77・Postgres v123より前) では絞り込みません。所有ストアを持つhostがこの絞り込み付きの読み取りを提供しない場合、一覧は絞り込まずに返すのではなく `503` になります。

Activityは、対象のCapsule、metadataのCapsule ID (run groupの `memberCapsuleIds` は全員)、Interfaceの所有アプリ (`ownerId`)、bindingの対象Capsule (`subjectId`) と、binding・tokenのInterfaceの提供側アプリ、Source (それを使うアプリ、または所有アプリ)、それでもアプリが分からないときはRun (`runId`、Run対象、`metadata.runId`・`planRunId`・`applyRunId`) でアプリに結び付けます。アプリを示さないbackupはWorkspace全体のbackupで、稼働中の全アプリに属します。所有記録のあるアプリがWorkspaceにある間は、アプリを決められないイベント (Run・Interfaceが見つからない、このWorkspaceに無いCapsuleのIDを指す、読み取りの上限を超えた、手がかりが無い) を表示しません。ほかの手がかりでアプリが分かっても同じです。`workspace`・`connection` のイベントと、アプリに属さないと分かったイベント (どのアプリも使わないRun・Source、削除済みのSource) はWorkspace判定のまま表示します。`/dashboard/bootstrap?includeNotifications=true` の通知は、代わりに呼び出し元のアプリから作ります (次の節)。読み取りは、WorkspaceのCapsule一覧と所有記録の一括読み取りが先です。所有記録のあるアプリが無ければ (v75では全アプリ)、それ以上読みません。ある場合のRun・Source・Interfaceの読み取りは、重複を除いて並列に行い、1リクエスト50件までです。Workspace一括操作 (`plan-update`、`drift-check`、Workspace backup、Interface materializationの再試行) は、Workspace判定に加えて、所有記録のある各アプリでその操作が許されることを要求します。

**移行中の扱い。** 所有記録がまだ使えないアプリは、そのリクエストに限り従来のWorkspace判定で決めます。対象は、所有ストアがない構成、D1 v77 / Postgres v123 より前のschema、backfillがまだ所有記録を書いていないアプリです。所有記録が書かれた時点から、そのアプリはアプリでの判定だけになります。従来判定を使ったことは、IDを含まない構造化ログ `app_authorization_workspace_fallback` (`reason` は `ownership_store_unavailable`・`ownership_schema_unavailable`・`capsule_not_backfilled`) に、isolateごとに5分に1回まとめて残します。判定ごとに所有記録を1回読み、所有記録があるときは役割の解決でもう一度読みます。所有ストアの既存のschema確認を使い、D1 v77より前では「schemaが無い」結果を60秒保持するので、判定ごとの確認queryは発生しません。

### Workspaceを使わないアプリの読み取り

次のrouteは、Workspaceを指定する読み取りの置き換えです (TASK-0118 Phase 9.1)。どれもWorkspaceのメンバーかどうかを読みません。アプリを指定するrouteは前の節のアプリでの判定 (読み取りは `view`、再試行は `update`) を使い、アカウント単位のrouteは呼び出し元が所有またはメンバーのアプリだけを対象にします。資格情報の制限は先に効きます。PATの `appIds` は対象のアプリを絞り、インストール済みアプリ自身のOAuthトークンは自分のアプリだけを対象にします (アプリでの判定のほかの制限もそのまま)。`appIds` の無い旧Workspace束縛のPATはアカウント単位のrouteを使えません (`403 app_access_denied`)。Workspaceを指定するrouteは互換のため残します。

| メソッド | パス | 権限と結果 |
| --- | --- | --- |
| GET | `/api/v1/install-plans?open=1` | アカウント資格情報 (セッション、または `workspaceId`・`appIds` の無いPAT)。本人が始めた未完了のinstall attemptと、attemptでない未完了のinstallを、全ての内部namespaceから新しい順に最大20件、`{ installPlans: [...] }` (Workspace routeと同じ形) で返す。attemptは始めた本人のものなので、アプリのメンバーには所有者のattemptは見えない。`open=1` (または `true`) が必須 |
| GET | `/api/v1/activity?cursor&limit` | 呼び出し元が所有またはメンバーのアプリのActivityを新しい順に返す (`limit` は1〜100、既定50)。`{ events, nextCursor? }` |
| GET | `/api/v1/capsules/{capsuleId}/activity?cursor&limit` | そのアプリの `view`。そのアプリのActivityを同じ形で返す |
| GET | `/api/v1/capsules/{capsuleId}/backups?cursor&limit` | `view`。このアプリを指定して取ったbackup (backupに `capsuleId` があるもの) を新しい順に返す。アプリを示さないWorkspace全体のbackupは含めない |
| GET | `/api/v1/capsules/{capsuleId}/interface-materialization-failures?limit` | `view`。そのアプリの、値を含まないInterface materializationの失敗 (dead letter) を返す (`limit` は1〜100)。`{ failures }` |
| POST | `/api/v1/capsules/{capsuleId}/interface-materialization-failures/{intentId}/retries` | `update`。bodyとdigest・stateのCASはWorkspace routeと同じ。ほかのアプリの失敗は `404` |
| GET | `/api/v1/sources?capsuleId=` | `view`。そのアプリの元のSourceを `{ sources }` で返す (所有アプリの無い旧Sourceは、それを使う全アプリの `view` も要る)。`workspaceId` と同時には指定できない |
| GET | `/api/v1/capsule-configs?capsuleId=` | `view`。そのアプリの今のInstallConfigを `{ installConfigs }` で返す。`workspaceId` と同時には指定できない |
| GET | `/api/v1/provider-connections` | アカウント資格情報。本人のProvider Connection (Source用のgit接続は除く) と、releaseが持つbindableなoperator接続を `{ providerConnections }` で返す。`projection=release-owned` はreleaseが持つものだけ (永続storeは読まない) |
| GET | `/api/v1/provider-connections?capsuleId=&projection=release-owned` | `view`。そのアプリに結べる、releaseが持つ接続。アプリが選べる接続は `GET /api/v1/connections?capsuleId=&projection=labels` |
| GET | `/api/v1/ui-surfaces?cursor&limit&capsuleId` | 対象のアプリのうち `active`・`stale` のもののランチャー用UI surface (`interface.ui.surface` v1、`Resolved`) を `{ interfaces, nextCursor? }` で返す。呼び出し元に `ui.open` の今有効なPrincipal Bindingが要るのは従来どおり。ページはアプリのID順 (`limit` は1ページのアプリ数で1〜50、既定20)。`capsuleId` で1アプリに絞る。インストール済みアプリ自身のトークンは自分のアプリだけ、operatorが指定した代理アプリ (Takos) のトークンは、アプリでの判定のもとで利用者のアプリを対象にする。判定はそのページで返すアプリにだけ行う (1ページで判定するのは `limit` の4倍まで、残りは `nextCursor` で続ける)。`incomplete: true` は、1回のアカウント単位の読み取りで数え切れない (2000を超える) 数のアプリを管理していることを示す |

Activityは内部の区画 (各アプリが記録する、固定された名前空間) ごとに保存しています。1ページは対象のアプリの区画 (1リクエスト最大96) から読み、前の節の規則でイベントごとにアプリへ結び付けて絞ります。イベントが属するアプリが全て対象のときだけ表示するので、Interface連携のイベントが、相手のアプリを見られない人に相手を明かすことはありません。アプリを決められないイベントと、アプリに属さないイベント (`workspace`・`connection` のイベント、どのアプリも使わないRun・Source) は表示しません。1リクエストで読むstoreのページは最大4つなので、件数が `limit` 未満 (0件のこともある) でも `nextCursor` が付くことがあります。cursorはstoreの不透明な `(createdAt, id)` cursorです。アカウント単位のActivityに出るのは所有者・メンバーが一覧できるアプリなので、アンインストールしたアプリの履歴は、残っている所有記録の所有者・メンバーが `GET /api/v1/capsules/{capsuleId}/activity` で読みます。

Interface API (`/api/v1/interfaces…`) もWorkspaceなしで使えます。

- インストール済みアプリ自身のOAuthトークン (そのアプリに結び付いたもの。Workspaceの有無は問わない) は実行時のprincipalです。Workspaceが無い場合は、`workspaceId` を付けずに `GET /api/v1/interfaces` を呼びます (`permission` は必須。`capsuleId` で提供側の1アプリに絞れる。`workspaceId` を付けると `400`)。結果は、そのトークンにその権限の今有効なPrincipal BindingがあるInterfaceだけで、`limit` と `cursor` でページを分け、続きがあれば `nextCursor` を返します。そのBindingは、トークンのアプリ自身の根拠である場合だけ数えます。つまり、そのアプリの有効なInterface連携から作られたBindingか、そのアプリ自身が所有するInterfaceのBindingです (アプリのpairwise subjectは呼び出し先の提供者に見えます。また、ある区画にBindingを書ける人は、共有された旧来の区画のほかの利用者も含めて、そこで任意のsubjectにBindingを作れます。そのため、アプリが所有していないInterfaceの手作りのBindingは根拠になりません)。`GET /api/v1/interfaces/{id}`、その `bindings`、`POST /api/v1/interfaces/{id}/token` も同じ規則で、根拠の無いInterfaceは `404`、実行時のprincipalは変更できません。アプリに結び付いていない、Workspaceも無い実行時のprincipalは拒否します。こうして発行するトークンは、そのInterfaceの区画で発行します。Workspaceに結び付いた実行時のトークンは、従来どおりそのWorkspaceに限ります。
- Workspaceの制限が無いアカウントのセッションやPATは、`GET /api/v1/interfaces?capsuleId=` で1アプリのInterfaceを一覧できます (そのアプリの `view`。そのアプリが所有するInterfaceだけ)。`workspaceId` と `capsuleId` は同時に指定できず、どちらも無いと `400` です。
- 同梱のAccounts host (self-host) では、Workspaceの制限が無いアカウントの呼び出し元が、IDで指定したCapsule所有のInterfaceを扱うとき、アプリに所有記録があればアプリで判定します (読み取りは `view`、InterfaceとBindingの変更は `change_settings`)。所有記録の無いアプリと、Workspace所有のInterfaceは従来のWorkspace判定のままです。`appIds` 付きのPATはそのアプリのInterfaceだけに届き、ここでWorkspaceの権限を持つことはありません。
- platform Workerでは、shared-account (Hosted) のセッションによる `capsuleId` の一覧も、dashboardと同じshared-authの制御経路で判定します。platform extensionの認可がアプリへ移るまで (Phase 9.1-e)、IDで指定するInterface routeにはアカウントの呼び出し元でもWorkspaceが要ります。

`GET /api/v1/dashboard/bootstrap` は、`includeWorkspaces=true` を指定しない限りWorkspaceの一覧を含めません。`includeNotifications=true` の通知は、bootstrapの任意項目の期限の中で読んだ `GET /api/v1/activity` の最新ページ (最大60件) です。各項目は短くしたイベント、イベントがアプリを示すときの `capsuleId`、互換のための `workspaceHandle` (イベントの内部区画のID) を持ちます。アプリ所有の読み取りを持たないhostと、旧Workspace束縛の資格情報には、従来のWorkspaceからの通知を返します。

### Account views

| メソッド | パス                          | 説明                                                      |
| -------- | ----------------------------- | --------------------------------------------------------- |
| GET      | `/api/v1/views/workspaces.v1` | アカウントの active membership Workspace inventory を読む |

`/api/v1/views/workspaces.v1` は、初回ログインの個人 Workspace 作成・修復を持つ
`GET /api/v1/workspaces` とは別の読み取り専用 projection です。認証済みアカウントの
active membership を `created_asc` で返し、archived Workspace も含めます。`limit` は
省略時 100、最大 100、`cursor` は opaque token です。クエリキーは `limit` と
`cursor` だけを受け付けます。レスポンスの `total` は cursor 適用前の全 active
membership 行数です。Workspace-scoped credential では利用できません。

### 廃止予定の Workspace route {#legacy-workspace-routes}

Workspace はアプリごとの所有に置き換わり、段階を分けて撤去します (TASK-0118 Phase 9)。次の利用は廃止予定です。

- `/api/v1/workspaces/*`、`/api/v1/projects/*`、`/api/v1/views/workspaces.v1`
- `?workspaceId=` で選ぶ connections・sources・capsule-configs・provider-connections・dashboard と、本文の `workspaceId` で選ぶ接続の作成・接続の OAuth 開始・Source の作成
- `includeWorkspaces=false` を付けない `/api/v1/dashboard/bootstrap`
- `/api/v1/account/shared-workspaces*`、`/api/v1/billing*` (応答の印は付けません)、Workspace を選ぶ `/api/v1/interfaces*` (`?workspaceId=`、`x-takosumi-platform-workspace-id` header、本文の `workspaceId`、または Workspace に束縛された credential による暗黙の選択)、Workspace を受け取る platform extension の route、`/oauth/authorize` の `workspace_id`、`workspace_id` を付けた PAT の作成

これらの応答には `Deprecation: @1793145600` (RFC 9745) と、この節を指す `Link: <…>; rel="deprecation"` が付きます。今使える後継の route があり、それが具体的な URI のときは `rel="successor-version"` の `Link` も付きます (`/api/v1/capsules/{capsuleId}/runs` のような template の後継は下の表にだけ載せ、`Link` には入れません)。運用者が撤去日を決めると `Sunset` (RFC 8594) も付きます (`TAKOSUMI_LEGACY_WORKSPACE_SUNSET`)。応答の status と本文は変わりません。client は任意で `Takosumi-Client: <名前>/<版>` を送って名乗れます。サーバーは認証された利用を、構造化ログ `legacy_workspace_route` に記録します。ID token・userinfo・introspection に互換の `takosumi.workspace_id` を入れたとき (Workspace だけに束縛された PAT を introspection したとき、または直接提示したときを含む) は `legacy_workspace_claim_emitted` を記録します。どちらにも account・Workspace・token の ID は入りません。入る識別子は登録済みの OAuth client id だけで、これはアプリの連携またはインストールを指し、人を指しません。

| 廃止予定 | 後継 |
| --- | --- |
| `GET /api/v1/workspaces`、`GET /api/v1/workspaces/{workspaceId}/capsules`、`GET /api/v1/workspaces/{workspaceId}/installed-apps`、`GET /api/v1/views/workspaces.v1` | `GET /api/v1/apps` |
| `POST /api/v1/workspaces/{workspaceId}/install-plans` | `POST /api/v1/install-plans` |
| `GET /api/v1/workspaces/{workspaceId}/members` | `GET /api/v1/capsules/{capsuleId}/members` |
| `GET /api/v1/workspaces/{workspaceId}/runs` | `GET /api/v1/capsules/{capsuleId}/runs` |
| `GET /api/v1/workspaces/{workspaceId}/usage`、`GET /api/v1/workspaces/{workspaceId}/billing` | `GET /api/v1/usage` |
| `POST /api/v1/workspaces/{workspaceId}/source-ref-resolutions/stable-semver` | `GET /api/v1/source-ref-resolutions` |
| `POST /api/v1/workspaces/{workspaceId}/plan-update`・`drift-check`・`backups` | `POST /api/v1/capsules/{capsuleId}/plan`・`drift-check`・`backups` |
| `workspaceId` で選ぶ `/api/v1/connections` | `workspaceId` を付けない `/api/v1/connections` (個人の接続) |

ほかの route の後継は、置き換えの API ができたものから順に足します。

### Workspace

| メソッド | パス                                                 | 説明                                    |
| -------- | ---------------------------------------------------- | --------------------------------------- |
| GET      | `/api/v1/workspaces`                                 | 自分が参加している Workspace を一覧する |
| POST     | `/api/v1/workspaces`                                 | Workspace を作る                        |
| GET      | `/api/v1/workspaces/{workspaceId}`                   | Workspace を読む                        |
| PATCH    | `/api/v1/workspaces/{workspaceId}`                   | Workspace を更新する                    |
| DELETE   | `/api/v1/workspaces/{workspaceId}`                   | 空の Workspace を owner として削除する  |
| GET      | `/api/v1/workspaces/{workspaceId}/members`           | メンバーを一覧する                      |
| POST     | `/api/v1/workspaces/{workspaceId}/members`           | メンバーを追加する                      |
| PATCH    | `/api/v1/workspaces/{workspaceId}/members/{subject}` | メンバーの役割を変える                  |
| DELETE   | `/api/v1/workspaces/{workspaceId}/members/{subject}` | メンバーを外す                          |
| GET      | `/api/v1/workspaces/{workspaceId}/installed-apps`    | ストア照合用の、値を含まないインストール済みアプリの要約を読む |
| GET      | `/api/v1/workspaces/{workspaceId}/ui-surfaces`       | 認可済み Workspace UI surface Interface を一覧する |
| GET      | `/api/v1/workspaces/{workspaceId}/activity`          | 操作履歴を一覧する                      |
| GET      | `/api/v1/workspaces/{workspaceId}/interface-materialization-failures` | Interface materialization の value-free な失敗を一覧する |
| POST     | `/api/v1/workspaces/{workspaceId}/interface-materialization-failures/{intentId}/retries` | exact failure/state CAS で再試行する |
| GET      | `/api/v1/workspaces/{workspaceId}/usage`             | 利用量を一覧する                        |
| GET      | `/api/v1/workspaces/{workspaceId}/billing`           | 課金状態を読む                          |
| GET      | `/api/v1/workspaces/{workspaceId}/backups`           | 制御情報の書き出しを一覧する            |
| POST     | `/api/v1/workspaces/{workspaceId}/backups`           | 制御情報を書き出す                      |
| POST     | `/api/v1/workspaces/{workspaceId}/plan-update`       | Workspace 全体の更新 Run を作る         |
| POST     | `/api/v1/workspaces/{workspaceId}/drift-check`       | Workspace 全体の差分確認 Run を作る     |

操作履歴は `/api/v1/workspaces/{workspaceId}/activity` から読みます。

`GET /api/v1/workspaces/{workspaceId}/installed-apps` に query parameter はありません。その Workspace を
読める利用者に、destroyed を除くアプリを `{ installedApps: [...], complete: boolean }` で返します。各行は
`capsuleId`、`name`、任意の `displayName`（`{ja,en}`）と `iconUrl`、Capsule から作る簡易な `state`、
`installedFrom: {url,path,matchable?}` を持ちます。URL は認証情報・query・fragment を含まず、`path` はリポジトリから見た
実行する module のフォルダです。元の URL が query を含むなど、表示用 URL から正確に照合できない行には
`matchable: false` を付け、インストール済みの照合から除外します。アプリの ID や要約は引き続き返します。
未適用のアプリも照合から除外します。設定や取得元を読めないアプリの行は省き、他のアプリの一覧を返します。
設定の一括取得失敗や取得元のページ上限などで一覧を確認しきれないときは `complete: false` です。
この場合、返った行との一致は使えますが、一致しないアプリを未インストールとは判断できません。
ref は照合に使いませんが、query は実行元の identity の一部として保持します。ストアは正規化した Git URL と module
で照合し、「インストール済み」の件数と「開く」、副操作の「もう1つ入れる」を表示します。
もう一度インストールしたものは独立したアプリで、データや設定は共有しません。

メンバー一覧の各行は、membership の field に加えて、アカウントに表示名があれば
`displayName` を返します。`email` は呼び出し元がその Workspace の active な owner または
admin のときだけ返し、identity provider が未確認と示したアドレスは返しません。member と
viewer には他のメンバーのメールを返しません。追加・役割変更・削除の応答はどちらも含みません。

空の Workspace だけが owner によって削除できます。非破棄 Capsule、Source、
進行中 Run、利用量の証拠、保持された backup が一つでも残ると `409 workspace_not_empty` で拒否します。
保持された backup は削除後に到達できなくなるため、削除前に明示的に扱ってください。
クラウド資源の destroy は行いません。削除は空チェックと一体の原子操作で行い、
member 行は同時に削除します。削除後の読み取りは 404 です。

### Project と Capsule

| メソッド | パス                                                       | 説明                                         |
| -------- | ---------------------------------------------------------- | -------------------------------------------- |
| GET      | `/api/v1/workspaces/{workspaceId}/projects`                | Project を一覧する                           |
| POST     | `/api/v1/workspaces/{workspaceId}/projects`                | Project を作る                               |
| GET      | `/api/v1/projects/{projectId}`                             | Project を読む                               |
| GET      | `/api/v1/workspaces/{workspaceId}/capsules`                | Capsule を一覧する                           |
| GET      | `/api/v1/capsules/{capsuleId}`                             | Capsule を読む                               |
| POST     | `/api/v1/capsules/{capsuleId}/install-config-re-adoptions` | SourceSnapshot の InstallConfig を再採用する |
| PATCH    | `/api/v1/capsules/{capsuleId}`                             | Capsule を更新する                           |
| DELETE   | `/api/v1/capsules/{capsuleId}`                             | 削除を予約する（即時破棄計画は `?immediate=true`） |
| POST     | `/api/v1/capsules/{capsuleId}/uninstall`                   | 猶予付きの削除 (二段階アンインストール) を予約する |
| POST     | `/api/v1/capsules/{capsuleId}/cancel-uninstall`            | 猶予期間中の削除予約を取り消す               |
| GET      | `/api/v1/capsules/{capsuleId}/app`                         | アプリの状態・主操作・問題・画面・版・削除条件をまとめて読む |
| GET      | `/api/v1/capsules/{capsuleId}/runs`                        | この Capsule の Run を新しい順に一覧する     |
| GET      | `/api/v1/capsules/{capsuleId}/outputs`                     | 公開 Output を読む                           |
| GET      | `/api/v1/capsules/{capsuleId}/current-resource-inventory`  | 現在の版に記録された OpenTofu の resource の一覧を読む |
| GET      | `/api/v1/capsules/{capsuleId}/usage-summary`               | 利用量の集計を読む                           |
| GET      | `/api/v1/capsules/{capsuleId}/state-versions`              | StateVersion を一覧する                      |
| GET      | `/api/v1/capsules/{capsuleId}/provider-bindings`           | ProviderBinding の選択を読む                 |
| GET      | `/api/v1/workspaces/{workspaceId}/current-state-versions`  | 現在の StateVersion をまとめて読む           |
| GET      | `/api/v1/capsule-configs`                                  | Capsule 作成設定を一覧する (`capsuleId=` はそのアプリの設定) |
| GET      | `/api/v1/capsule-configs/{capsuleConfigId}`                | Capsule 作成設定を読む                       |

Capsule の削除 API は Workspace owner/admin と書き込みの scope（API キーでは `write` か `admin`、
OAuth では `capsules:write`）を要求します。
`DELETE /api/v1/capsules/{capsuleId}` は既定でデプロイ済みの Capsule の削除を予約し、`202`
`{capsule,graceDays}` を返します。猶予期間は operator 設定
`TAKOSUMI_UNINSTALL_GRACE_DAYS`（OSS 既定 7 日）で、予約中は
`POST /api/v1/capsules/{capsuleId}/cancel-uninstall` で取り消せます。破棄済み Capsule
への再試行は `200 {capsule,alreadyDeleted:true}` です。未デプロイの Capsule は従来どおり即時
abandon します。

旧来の即時 Plan 作成は `DELETE /api/v1/capsules/{capsuleId}?immediate=true` で明示します。
これは `202 {run}` を返して破棄 Plan を作るだけです。リソースを破棄するには owner による
Plan の確認・承認と、その Run の Apply が別途必要です。`immediate=false` は既定の予約と
同じ意味で、その他の値は `400` です。`POST .../uninstall` と `POST .../destroy-plan` は
引き続き利用できます。

この変更は DELETE の応答契約を破壊的に変更します。release cutover で旧 DELETE の暗黙の
即時 Plan 意味論は終了し、legacy fallback はありません。移行中は既存の POST uninstall と
destroy-plan が bridge になります。猶予なしで破棄したい client は cutover より前に
`immediate=true` を送るよう更新してください。互換運用は旧 artifact を運用する期間だけです。

`POST /api/v1/capsules/{capsuleId}/uninstall` はデプロイ済みの Capsule を `uninstalled`
にし、`uninstall.scheduledDestroyAt` まで何も壊しません。猶予日数は operator 設定
`TAKOSUMI_UNINSTALL_GRACE_DAYS` (OSS 既定 7 日) です。猶予中も provider の資源と
データは残り、課金も続きます。Takosumi の OIDC によるサインインは止まります
(client は失効させないので、取り消せば再開します)。破棄以外の計画・デプロイは拒否されます
(`capsule_uninstalled`)。猶予中は `cancel-uninstall` で元の状態に戻せます。
期日を過ぎると control plane が一度だけ Capsule 単位の書き出しを試み、結果
(`exported` / `failed` / `skipped`) を `uninstall.preDestroyExport` に記録してから、
通常の破棄計画を作ります。計画が削除だけである場合に限り system が承認してデプロイし、
そこから先は原則として取り消せません。削除だけでない、変更内容が分からない、
所有者が計画を取り消した、または破棄が provider に届く前に拒否・失敗した場合は
`uninstall.blockedReason` を残して止まり、所有者が取り消すか即時削除を選びます。
provider に届いた破棄が失敗した場合は、通常の破棄失敗と同じく `error` になります。
`destroy-plan` は猶予なしの破棄計画を作ります。

`GET /api/v1/capsules/{capsuleId}/app` は、インストール済みのアプリを1つの見え方として
返します。状態 (`state`) と主操作 (`primaryAction`) は control plane が Capsule、
この Capsule の最新の計画・デプロイ Run、版の更新処理と途中のインストール、ProviderConnection、
画面の作成記録から決めます。Workspace 全体の Run の窓には頼りません。

- `state`: `installing` / `installed` / `updating` / `needs_attention` / `stopped` /
  `uninstall_scheduled` / `uninstalling` / `uninstalled`
- `primaryAction`: `open` / `view_resources` / `review` / `retry` / `retry_screen` /
  `fix_connection` / `fix_interface_link` / `continue_install` / `cancel_uninstall` /
  `uninstall_now` / `reinstall` / `none`（`review_interface_link` は問題カード自身の操作で、`primaryAction` にはなりません）
- `problems[].code`（優先順）: `connection_unavailable` / `interface_link_unavailable` / `uninstall_failed` /
  `uninstall_blocked` / `policy_blocked` / `run_failed` / `capsule_error` /
  `install_incomplete` / `screen_unavailable` / `interface_link_degraded` /
  `interface_link_unset` / `interface_link_approval_pending` / `uninstall_scheduled`（`interface_link_degraded`・`interface_link_unset`・`uninstall_scheduled` は警告。`interface_link_approval_pending` は提供側アプリで呼び出し元が承認できる連携の依頼を知らせる `info` で、`review_interface_link` を示し、`primaryAction` を決めません）

応答には、開ける画面のすべて (`screens`)、採用中の版と同じ ref の最新 snapshot
(`version.current` / `version.latest` / `updateAvailable` / `stale` / `autoUpdate`)、
進行中の Run と確認待ちの計画 (`progress`)、最新の Run (`latestRun`)、削除の条件
(`uninstall.mode` と、予約前でも分かる `graceDays`、予約後の `scheduled.deleteAfter`)
が入ります。`links.uses` はこのアプリが使う連携、`links.usedBy` はこのアプリを使う連携です。
`uninstall.impact.usedBy` は、削除の影響を受ける利用側を示します。提供元を削除しても利用側の
アプリは残り、他の提供元へは自動で切り替えません。秘密の値、Output の値、画面の起動 URL
以外の Interface 入力は含みません。
画面が `document.clients` でスマホの専用アプリを宣言していれば、`screens[].clients` に検査を通った
ものだけが入ります（`preferred`、`ios` の `verified` / `trustedClientId` / `target` / `name` /
`appStoreId` / `bundleId` / `open` / `universalLink` / `storeUrl`、`android` の `verified` /
`trustedClientId` / `target` / `name` / `package` / `open` / `appLink` / `storeUrl`）。
`verified` は、宣言した bundle id・package と link の雛形が運用者の信頼する専用アプリ
（`TAKOSUMI_ACCOUNTS_TRUSTED_NATIVE_CLIENTS`）と一致したときだけ true で、そのときの `name` と
`appStoreId` は登録の値です。`target` は link の実際の行き先（`package` / `scheme` / `host`）です。
利用側は、未検証の専用アプリを自動では開かず、`target` を見せて確かめてから開きます。
未検証で `name` が無いときは「未確認のアプリ」のような中立の表示を使い、画面の `title` は使いません。
`preferred` は、どれかの OS の専用アプリが検証済みのときだけ `"native"` になり（宣言が `"web"` なら
`"web"`）、それ以外は `"web"` です。`"native"` が効くのも検証済みの OS だけです。
link は雛形の `{origin}` と `{url}` にその画面の URL を入れた後の値で、`storeUrl` は宣言した ID に結び付いたものだけを使い、無ければ
`appStoreId` や `package` から作ります。宣言の書き方は[ホームにアプリを出す](../getting-started/home-launcher.md#スマホの専用アプリを宣言する)
にあります。
補助的な読み取りに失敗した部分は `incomplete` に名前が入ります。
`progress.revisionPreparing` は、インストールまたは版の更新処理がまだ計画の Run を作っていない
間だけ true です（インストールの試みは一度も適用していないアプリに限り、止まった試みは除きます）。
`progress.installPlanId` はそのアプリを作ったインストールの試みで、`continue_install` は
`POST /api/v1/install-plans/{installPlanId}/reconcile` でその試みを進めます。管理の権限を記録する前に
書かれた試みは進められないため、名前は返しません。試みが作った人の入力を待っている間は
`progress.installPlanAwaitingInput` が `viewer`（呼び出した本人が始めた）か `other` になり、
その間は reconcile しても進みません。版の更新処理が計画の Run を作らないまま止まった場合は
`progress.revisionPlanId` に名前が入り、`POST /api/v1/revision-plans/{revisionPlanId}/reconcile`
で続けられます。版の更新処理は、始めたときの状態の世代と InstallConfig がいまの Capsule と同じ間だけ
数えます。その後にほかの変更が適用された処理や、設定の変更で InstallConfig が付け替わった処理
（世代は変わりません）は reconcile しても失敗するだけなので、準備中にも
`revisionPlanId` にもなりません。Workspace のメンバーなら誰でもこれらを reconcile できますが、作られる計画の Run の
作成者には、進めたメンバーではなく処理そのもの（`git-install-plan:<id>` /
`git-revision-plan:<id>`）が記録されます。
同じ Capsule の版の更新処理がまだ計画を準備している間（`progress.revisionPreparing` と同じ条件:
計画の Run がまだない、止まっていない、管理の権限を記録している、いまの世代と InstallConfig に基づく）は、別の
`POST /api/v1/capsules/{capsuleId}/revision-plans` は 409（`details.reason: "revision_in_progress"`、
`details.revisionPlanId`）で断られます。同じ Idempotency-Key の再送はそのまま返ります。
設定の変更（`configuration-plans`）と設定の再採用（`install-config-re-adoptions`）も、同じ条件の間だけ
409（`details.reason: "capsule_install_config_rebind_busy"`）になります。
削除の予約記録は、Capsule が `uninstalled` の間と、provider に届いた破棄が失敗して
`error` になり、最新の Run がまだ破棄である間だけ有効と見なします。予約が猶予中でも
破棄中でも、`blockedReason` が記録されていれば `uninstall_blocked` になります。
`cancel_uninstall` と `uninstall.mode` / `scheduled.cancellable` は、取り消しと予約の
コマンド自身の受付条件で判定します。

`GET /api/v1/capsules/{capsuleId}/runs` は `limit`（既定 50、上限 100）と
`cursor` で新しい順にページングします。`type` を繰り返すと Run の種類で絞れます。

新しい Capsule は `POST /api/v1/workspaces/{workspaceId}/install-plans` から
exact SourceSnapshot と成功済み compatibility declaration を固定して作成し、返された
Plan Run を確認してからデプロイします。Workspace Capsule collection の公開面は GET のみです。
Run は必ず計画の作成から始まります。

| メソッド | パス                                        | 説明                         |
| -------- | ------------------------------------------- | ---------------------------- |
| POST     | `/api/v1/capsules/{capsuleId}/plan`         | 計画 Run を作る              |
| POST     | `/api/v1/capsules/{capsuleId}/configuration-plans` | dirty 設定を immutable successor と review-only Plan にする |
| POST     | `/api/v1/capsules/{capsuleId}/destroy-plan` | 破棄計画 Run を作る          |
| POST     | `/api/v1/capsules/{capsuleId}/drift-check`  | 差分確認 Run を作る          |
| GET      | `/api/v1/capsules/{capsuleId}/backups`      | そのアプリのバックアップを一覧する |
| POST     | `/api/v1/capsules/{capsuleId}/backups`      | Capsule のバックアップを作る |

### Interface links

| メソッド | パス | 説明 |
| -------- | ---- | ---- |
| GET | `/api/v1/capsules/{capsuleId}/interface-links/{requirementKey}/candidates` | requirement に合う提供元と、現在の連携の generation を読む |
| PUT | `/api/v1/capsules/{capsuleId}/interface-links/{requirementKey}` | generation CAS で提供元を選び直す |
| DELETE | `/api/v1/capsules/{capsuleId}/interface-links/{requirementKey}` | 利用側または提供側の管理者として連携を解除する |
| GET | `/api/v1/capsules/{capsuleId}/interface-links/requests` | このアプリ (提供側) の承認を待つ連携を読む |
| POST | `/api/v1/capsules/{capsuleId}/interface-links/{linkId}/approve` | 提供側の所有者・メンバーとして承認待ちの連携を承認する (generation CAS) |
| POST | `/api/v1/capsules/{capsuleId}/interface-links/{linkId}/decline` | 提供側の所有者・メンバーとして承認待ちの連携を断る (generation CAS) |

候補取得の応答は `{ candidates: [{interfaceId,providerCapsuleId,providerCapsuleName,interfaceName}], generation }`
です。`generation` はその consumer と requirement key の最新記録の値で、履歴がなければ 0 です。
候補は同じ Workspace にある別の Capsule が所有する `Resolved` Interface に限られます。
Workspace / operator 所有の Interface は提供元になりません。
PUT の本文は `{ interfaceId, expectedGeneration }`、DELETE は `{ expectedGeneration }` です。
どちらも成功時は `{ link: InterfaceLink }` を返します。選び直しに Plan は不要です。
新しい提供元への Binding を用意してから、旧提供元への Binding を取り消します。

InterfaceLink は consumer Capsule と requirement key、正確な type/version、要求・承認した
permissions、選んだ提供元の Interface / Capsule、`state`、`selection`、`generation` を記録します。
`state` は `pending_approval|active|declined|revoked`、`selection` は `explicit|auto_single` です。
提供元がアンインストールされても選択や state を書き換えず、アプリの読み取り時に健康状態を計算します。
active な連携だけを実行時の認可に使い、連携の値や認証情報を OpenTofu に渡しません。
連携がなくても OIDC のサインインは続き、その連携の Binding を作りません。

GET は利用側の read アクセス、PUT は利用側の write アクセス、DELETE は利用側または提供側の
write アクセスを確かめます。

承認待ちの一覧 `GET .../interface-links/requests` は提供側アプリの `change_interface_link` を求め、
`{ requests: [{ linkId, generation, consumerApp: { capsuleId, name, displayName?, iconUrl? }, requirementKey,
providerInterfaceId, interfaceType, interfaceVersion, requestedPermissions, requestedByDisplayName?, createdAt }] }`
を返します。値を含みません (名前・権限名・時刻だけ)。`requestedByDisplayName` は依頼した人の表示名だけで、メールアドレスやアカウントIDは返しません (表示名が無いとき、またはメールアドレスやアカウントIDと同じ・メールアドレスの形のときは省きます)。`approve` の本文は `{ expectedGeneration, approvedPermissions? }`、
`decline` は `{ expectedGeneration }` で、どちらも提供側アプリの write アクセスを求め、成功時は `{ link: InterfaceLink }` を返します。
承認した link は `approval.kind: "provider_approved"`、断った link は `declined: { declinedBy, declinedAt }` を持ちます。
承認待ちでない link や generation の不一致は 409、提供側か利用側が稼働中でない (アンインストール予定・削除済みを含む) ときは 412 です。
Activity には `interface_link.approved` / `interface_link.declined` を、id・権限名・type/version だけで記録します。
権限不足は 403、不正な入力は 400、generation の競合は 409、利用不可の提供元は 412 です。
承認判断は policy port が持ち、現在の Workspace 構成では同じ Workspace の連携を即時承認します。

永続化先は D1 の `interface_links`（migration v76 `d1_interface_links`）と PostgreSQL の
`takosumi_interface_links`（migration v122 `runtime_interfaces.links.create`）です。追加のみの
schema で、資格情報を保存しません。この変更で本番 DDL の適用・本番 rollout は行っていません。
本番への適用は別途承認と検証を経る作業です。

### Source

| メソッド | パス                                                                     | 説明                                                              |
| -------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| GET      | `/api/v1/sources`                                                        | Source を一覧する (`workspaceId=`、またはアプリのSourceを返す `capsuleId=`) |
| POST     | `/api/v1/sources`                                                        | Source を作る                                                     |
| GET      | `/api/v1/sources/{sourceId}`                                             | Source を読む                                                     |
| PATCH    | `/api/v1/sources/{sourceId}`                                             | Source のメタ情報を更新する                                       |
| DELETE   | `/api/v1/sources/{sourceId}`                                             | 未参照の Source を削除する (参照・進行中 Run があると 409)        |
| POST     | `/api/v1/sources/{sourceId}/hook-secret/rotate`                          | webhook secret をローテーションする (本文なし、平文応答は 1 回のみ) |
| POST     | `/api/v1/sources/{sourceId}/sync`                                        | 同期 Run を作る                                                   |
| GET      | `/api/v1/sources/{sourceId}/snapshots`                                   | SourceSnapshot を一覧する                                         |
| GET      | `/api/v1/sources/{sourceId}/snapshots/{sourceSnapshotId}/install-modules` | 同期時に tree から検出した module と provider 要求を一覧する      |
| POST     | `/api/v1/workspaces/{workspaceId}/source-ref-resolutions/stable-semver`  | 公開されている Git tag のうち、最も新しい安定版の SemVer を解決する |
| POST     | `/api/v1/sources/{sourceId}/compatibility-check`                         | 互換性レポートを作る                                              |
| GET      | `/api/v1/compatibility-reports/{reportId}`                               | 互換性レポートを読む                                              |

webhook secret の復旧手順、旧 secret の失効タイミング、応答を失った場合の扱いは
[Source と Capsule](../concepts/sources.md) を参照してください。service 内部向けの同等経路は
`POST /internal/v1/sources/{sourceId}/hook-secret/rotate` です。

`DELETE /api/v1/sources/{sourceId}` は Workspace の owner/admin が未参照の
Source を削除します。非破棄 Capsule に追跡されていると `409
source_referenced_by_capsule`、進行中 Run があると `409
source_has_in_flight_run` で拒否します。削除後は webhook bearer が無効になり、
読み取りは 404 になります。所有アプリがある Source、退役中の Source、snapshot・同期履歴がある
Source は、専用 archive を custody 経路で削除してから snapshot 行と Source 行を原子的に削除し、
value-free の `source.retired` を Activity に 1 件記録します。失敗時は行を保持して再試行できます。
所有者も履歴もない未使用 Source だけは `source.deleted` を記録します。

### Git install plan

| メソッド | パス                                              | 説明                                           |
| -------- | ------------------------------------------------- | ---------------------------------------------- |
| POST     | `/api/v1/workspaces/{workspaceId}/install-plans`  | Git から reviewable Plan Run まで準備する      |
| GET      | `/api/v1/workspaces/{workspaceId}/install-plans`  | 自分の未完了のインストールを読む（`open=1`）   |
| GET      | `/api/v1/install-plans/{installPlanId}`           | coordinator の現在状態を読む                   |
| PATCH    | `/api/v1/install-plans/{installPlanId}`           | 入力待ちの試行に回答する（generation CAS）     |
| DELETE   | `/api/v1/install-plans/{installPlanId}`           | 試行、または Capsule 記録前の plan を捨てる    |
| POST     | `/api/v1/install-plans/{installPlanId}/reconcile` | 明示的に一段だけ進める                         |

作成には `Idempotency-Key` が必須です。同じ Workspace・actor・key と同じ正規化 request
は同じ record を返し、内容が異なれば 409 になります。request digest は variable の名前だけを
含み、値は含みません。そのため同じ key で値だけを変えた request は 409 にならず、最初の
record を 200 で返します。値を変えるときは新しい key を使ってください。public projection が
含むのは Source、SourceSnapshot、InstallConfig、Capsule、Plan Run の参照と bounded diagnostic
だけです。reviewed preflight に渡した private variable 値は atomic initial authority commit
まで非公開 coordinator state にだけ保持され、response には投影されず、commit 直後と、
失敗などの終端に移ったときに coordinator から削除されます。credential、token、Output 値は
受け付けません。
`reviewable` になった後の承認と apply は `Run` API だけが所有し、install-plan 専用 apply
route はありません。

試行が Capsule を作成して `planning` または `reviewable` になった後は、GET と open 一覧の
response に `reviewSummary` を返します。`modulePath`、`appName`、`environment`、確定済み
Provider Binding の接続 ID と表示名、Interface の選択、設定名と設定済みかどうかを、保存済み
InstallConfig と BindingSet から読み取り専用で再構成します。設定の `value` は、受理済みの
repository install UX が非機密と宣言した値だけに限ります。generic OpenTofu 変数と機密設定は
`sensitive: true` と `set` のみで、値を返しません。Provider Connection の自動選択履歴は
確定済み binding から復元できないため `autoSelected: null` です。この GET は Plan/Apply を
進めません。

`mode: "attempt"` で作ると、coordinator が試行全体を持ちます。Source sync、module 走査、
互換性確認、Provider Connection の照合を自分で進め、利用者の判断が要るとき（module 候補が
複数、接続の不足、必須設定、名前の衝突）と、Capsule を作る直前に、非終端の
`awaiting_input` で止まります。response の `userAction` が次の操作を一つだけ返します
（`wait`・`choose_module`・`provide_inputs`・`review_run`・`retry`・`none`）。候補が一つだけの
接続は自動で選びます。`PATCH` と `DELETE` は試行を始めた本人だけが使え、`PATCH` は
`expectedGeneration` で CAS します。variable 値は `continue: true` で確定する request だけが
受け取り、coordinator には保存しません。確定の request が作成を始めた後は（variable が
なくても）Capsule が存在しうるので、結果を確認できなかったときは同じ値の再送だけを受け付け、
作成済みの Capsule を先に採用します。`DELETE` は、lease を持つ処理がないことを確かめてから
試行が作った未適用の Capsule を abandon し、終端の `discarded` にします。abandon が途中で
止まると試行は `failed`（`install_attempt_discard_incomplete`）になり、もう一度 `DELETE`
すると片付けが終わります。適用中・適用済みの試行と、Capsule を記録した後の試行ではない install plan は
拒否します（409 `install_plan_not_attempt`）。
試行専用の Source を退役させ、同期・polling を止めて archive と snapshot 行を削除します。
途中失敗した退役は、同じ DELETE または日次の回収で再開します。

`mode` を付けずに作った install plan（試行ではない plan）も、Capsule を作る直前に同じ
Workspace・environment で名前が使われていないかを確かめます。稼働中のアプリが名前を使って
いれば、再試行せずに `failed`（`capsule_name_conflict`）で終わります。確認の後に同じ名前の
アプリが commit された場合などに Capsule の初回作成が `failed_precondition`
（`capsule_initial_authority_conflict`）で拒否されたときも、再試行には回しません。この plan の
決定的な ID の Capsule が既にあれば（commit の応答が失われた場合）それを採用して先へ進み、
名前の衝突なら `capsule_name_conflict`、それ以外は `failed`（code と reason は
`capsule_initial_authority_conflict`）にします。試行は従来どおり入力に戻ります。
試行ではない plan も、Capsule を記録する前（`syncing_source` から `creating_capsule` まで、または
そこで `failed`）なら、始めた本人が `expectedGeneration` を付けた `DELETE` で捨てられます。
lease を持つ処理がないことを確かめ、応答が失われて残った未適用の Capsule があれば試行と同じく
abandon し、`discarded`（`install_plan_discarded`）にします。このような plan は open 一覧
（`open=1`）にも載ります。試行と違って期限がなく、drain が決着させるのは一度も claim されて
いない plan だけなので、止まった plan を Workspace 管理の blocker から外す出口はこの `DELETE` です。

`userAction.kind: "provide_inputs"` の `interfaces` は、`requirementKey`、type/version、
permissions、値を含まない候補、`choice`、`autoSelected` を返します。候補が 0 件なら「あとで」、
1 件で private ではなく別の要件の候補とも重複しない場合だけ自動選択します。private の提供元、
重複する候補、複数の候補は、提供元か「あとで」を明示して選びます。PATCH の `interfaceLinks` は
`[{requirementKey,choice:{kind:"interface",interfaceId}}]` または
`[{requirementKey,choice:{kind:"later"}}]` という完全な回答一覧です。提供元の ID は manifest ではなく
この選択に保存し、Capsule 作成の直後に固定した InterfaceLink を作ります。以後は候補を解決し直しません。

表示した自動選択を確認するときは、`continue: true` と一緒に
`observedInterfaces: [{requirementKey,candidateIds}]` を返します。明示した `interfaceLinks` が
ある requirement はそちらを優先し、それ以外で送信した候補 ID 集合が現在の候補と異なれば
409 `interface_candidate_unavailable` を返します。sheet を開いた後に候補が変わっていても、送信時点の候補集合と一致すれば
受け付けます。観測情報を省略した要件は、sheet を開いたときの候補集合を使って確認します。
response の `installPlan.implicitInterfaceKeys` は `options.interfaceLinks` に保存された暗黙選択
（候補が一つのときの自動選択や「あとで」）の requirement key を示し、再開時に明示した選択と区別します。
この観測情報は ID だけで、`options` への
保存や権限の付与は行いません。
Control D1 が Interface link store の導入前（schema v76 未満）の場合は候補を表示せず、
`linkStoreUnavailable: true` と案内を返します。「あとで」を選ぶとリンクを作らずに Capsule の
作成とインストールを進められます。導入前の候補 ID を明示しても Capsule 作成前に拒否します。

試行には Capsule ができるまで `expiresAt` があり、Capsule ができた試行は失効しません。
GET と一覧は書き込みをしません。期限切れ（`install_attempt_expired`）や、待っている間の
管理 epoch の変更（`workspace_management_changed`）は `invalidated` と `userAction: retry`
で示すだけで、片付けは本人の `DELETE` か、無効な試行に届いた本人の `PATCH`（409
`install_attempt_invalid`）で行います。`awaiting_input` は lease も実行権限も持たないため、
Workspace 管理の blocker になりません。Capsule ができる前に期限切れになり lease を持たない
試行も、進められないので blocker になりません。そこから先へ進む書き込みは、作成時の管理
admission を同じ statement で確かめます。

`configuration-plans` は、現在の private InstallConfig に closed な
`variablePatch`（`set` / `remove`）、value-free ProviderBinding 選択、Interface
blueprint と GET-issued `authorityGuard` を適用します。未指定の値を公開 projection
から再構成することはなく、現在の module、policy、source、runner、lifecycle、output
rules、required Interfaces、runtime materialization、provenance を保持した immutable
successor を作ります。InstallConfig pointer、ProviderBindingSet、未解決 Interface
intent、execution-authority epoch は同じ CAS で更新され、その後に review-only Plan
だけを作ります。

repository manifest を採用した Capsule では exact manifest の user input 宣言だけが
`variablePatch` を許可します。generic OpenTofu Capsule では、保存済み contract digest と
exact SourceSnapshot の successful compatibility declaration を再照合し、その宣言にある
名前・型・default 有無だけを authority にします。latest Snapshot や manifest の存在は
推測しません。

同じ `Idempotency-Key` と同じ request は、失われた応答を再送しても同じ
`targetInstallConfigId` と durable `planRunId` に収束し、Plan 行を追加作成しません。
insert-only successor または authority CAS の acknowledgement が canonical Plan の durable
化より前に失われた場合、それらは操作完了ではないため、retry は残りの処理と Plan を完了して
`201` / `replayed:false` を返します。canonical Plan が既に存在する場合だけ（Plan 永続化後の
acknowledgement loss を含む）、retry は完了済み操作を observe して `200` /
`replayed:true` を返します。別の request を
同じ key で送ると 409 です。reserved redaction sentinel、invalid patch/remove、stale guard、
destroyed/disabled、in-flight revision、`queued`/`running` Plan または Apply は拒否されます。
これは in-flight-work fence の status 条件であり、unsafe/ambiguous な runtime evidence は
別に fail closed です。computed/reviewable Plan は epoch advance で supersede され、
transition を block しません。Apply はこの endpoint では開始されません。

`PATCH /api/v1/capsule-configs/{id}` と
`PUT /api/v1/capsules/{id}/provider-bindings` は全 row で廃止されています。認証・Workspace
認可を先に行った後、必ず `405 Method Not Allowed` と `Allow: GET` を返し、marker のない
legacy row も例外にしません。既存 Capsule の deployment intent 更新は
`configuration-plans` または専用の re-adoption operation だけが所有します。

作成 body の provider 選択は provider source だけの map ではなく、scan で得た
module-local tuple をそのまま指定します。

```json
{
  "source": {
    "name": "sample-app",
    "url": "https://git.example.test/apps/sample-app.git",
    "ref": "main",
    "path": "infra"
  },
  "capsule": { "name": "sample-app", "environment": "production" },
  "options": {
    "modulePath": "deploy/selected",
    "providerBindings": [
      {
        "provider": "registry.terraform.io/tako0614/takoform",
        "moduleLocalName": "takoform",
        "connectionId": "conn_takoform"
      }
    ]
  },
  "preflight": {
    "sourceId": "src_exact",
    "sourceSnapshotId": "snap_exact",
    "compatibilityCheckRunId": "run_compatibility_exact",
    "compatibilityReportId": "report_exact",
    "installConfigId": "cfg_exact"
  }
}
```

`source.path` は同期する Git subtree、`options.modulePath` はその Snapshot の
tree scan で検出された archive-relative module です。`providerBindings` の
`provider` / `moduleLocalName` / optional `childAlias` は選択 module の requirement
tuple と完全一致しなければならず、`connectionId` は既存 Connection の参照だけです。
`preflight` は同じ SourceSnapshot/module に対する successful/ready compatibility declaration
を exact id で固定します。Dashboard と smoke はこの create-only coordinator を使い、先に
Capsule を作って public binding PUT で補完することはありません。

### Git revision plan

| メソッド | パス                                                | 説明                                                 |
| -------- | --------------------------------------------------- | ---------------------------------------------------- |
| POST     | `/api/v1/capsules/{capsuleId}/revision-plans`       | 既存 Capsule の Git ref 更新 intent を作成・再生する |
| GET      | `/api/v1/revision-plans/{revisionPlanId}`           | coordinator の現在状態を副作用なしで読む             |
| POST     | `/api/v1/revision-plans/{revisionPlanId}/reconcile` | 明示的に一段だけ進める                               |

作成 body は `{ "ref": "<git-ref>" }` だけを受け付け、`Idempotency-Key` が
必須です。新規作成は 201、同じ key と同じ正規化 request の再生は 200、同じ key の
別 request は 409 です。coordinator は既存 Capsule・Source・InstallConfig・state generation を
固定し、Source の既定 ref/path を変更せず、対象 ref の deterministic SourceSyncRun /
SourceSnapshot、互換性レポート、Plan Run を順に作ります。各 mutation は同じ ID で
lost acknowledgement を回収し、未確認の mutation は 202 と `nextAction: "reconcile"` を
返します。`reviewable` では `nextAction: "review_run"` で停止します。rollback は引き続き
`POST /api/v1/state-versions/{stateVersionId}/rollback-plan` が所有します。

対象が適用中の版と同じ ref・path・commit で、その状態が成功した Apply によるもの
(Capsule が `error` ではない) なら、更新はありません。provider の失敗で state だけが進んだ
Apply や、restore・recovery で戻した状態は、同じ ref を指定すると Plan をやり直します。更新が
ないとき、coordinator は `phase: "failed"`、`diagnostic.code: "revision_already_current"`、
`nextAction: "none"` で終わります。commit を固定したアプリの commit を指定したときは、Source を sync せずに
そう答えます。branch や tag は sync して commit が変わっていないときに同じ答えです。
同じ commit でも ref が違う指定 (branch から commit への固定など) は追跡先の変更なので、
通常どおり Plan まで進みます。アプリが所有する Source の sync は revision を作った
アカウントを actor として申請し、その Plan Run の actor も同じです。そのアカウントへの
拒否 (`app_access_denied` など)、Source が有効でないこと、不正な ref のように reconcile を
繰り返しても変わらない拒否は、その理由を `diagnostic.code` にして `failed` で終わります。
所有権の移転でアプリの管理が drain している間の拒否は一時的なので、`reason:
"app_management_draining"` を付けて再試行できる失敗として返します。
再試行できる失敗は 202 と `diagnostic.code: "revision_plan_reconcile_retryable"` を返し、
どの段階か (`planCreationStage`) と所有者のエラー分類 (`controllerCode`・`reason`) を
添えます。例外の本文は返しません。

revision plan の作成や reviewable 化だけでは Capsule の追跡先は変わりません。対象 Plan を
通常の Run API で apply して新しい `currentStateVersionId` が採用された後だけ、その
StateVersion が参照する Plan Run の SourceSnapshot が Capsule の追跡正本になります。
`GET /api/v1/capsules/{capsuleId}` はこの非 secret な導出値を
`adoptedSourceRevision: { sourceSnapshotId, ref, path, resolvedCommit }` として返します。
初回 apply 前はこの field はありません。

### Capsule InstallConfig の再採用

`GET /api/v1/capsules/{capsuleId}` は、認証済み caller が読める opaque
`installConfigReAdoption.authorityGuard` を返します。これは private な
InstallConfig digest を知る必要なく、そのまま再採用 request の期待値に使えます。
書き込みは Workspace owner または operator (owner/admin membership) だけが実行でき、
次の POST は `Idempotency-Key` header を必須とします。

```http
POST /api/v1/capsules/{capsuleId}/install-config-re-adoptions
Idempotency-Key: <opaque-key>
Content-Type: application/json

{
  "baseInstallConfigId": "<base-install-config-id>",
  "sourceSnapshotId": "<source-snapshot-id>",
  "reason": "<bounded non-secret reason>",
  "reviewedUserVariables": {
    "public_url": "https://example.test",
    "feature_enabled": true
  },
  "expected": { "authorityGuard": "<guard-from-capsule-get>" }
}
```

body はこの閉じた shape だけを受け付け、`reason` は bounded かつ secret-like value を
含めません。任意の `reviewedUserVariables` を送る場合、それは pinned repository module が
`source.kind=user` と宣言した non-secret input の complete replacement です。required input
は全件必須です。optional input の省略は unset を意味するため、値を維持する
場合は再送します。unknown、secret、Capsule/Workspace 由来、module default、host delivery、
generic host policy mapping と衝突する値は拒否されます。recursive な secret-like key/value、
32 level、4,096 node、key ごと 256 UTF-8 byte、string ごと 32,768 UTF-8 byte の上限を超える
JSON は digest と source scan より前に拒否されます。field を省略した既存 client は current
InstallConfig mapping を使う従来の再採用を続けます。exact set は request digest と同一 key
replay に含まれ、partial patch として扱われません。成功は 200 で、response は次の
value-free projection です。

```json
{
  "capsule": { "id": "<capsule-id>" },
  "installConfigReAdoption": {
    "replayed": false,
    "previousInstallConfigId": "<previous-install-config-id>",
    "previousInstallConfigDigest": "sha256:<digest>",
    "targetInstallConfigId": "<derived-target-install-config-id>",
    "targetInstallConfigDigest": "sha256:<digest>",
    "sourceSnapshotId": "<source-snapshot-id>"
  }
}
```

実際の `capsule` は通常の public Capsule projection であり、上の短縮例は shape の説明
です。再送は同じ key/request の canonical target を返し、別 request、stale guard、
current/target record の digest・JSON drift、unsafe/ambiguous な lifecycle evidence、
`queued`/`running` Plan または Apply では 409 になります。computed/reviewable Plan は
epoch transition で supersede されます。
認証されていない caller は 401、Workspace にアクセスできない caller は 403、body や
header の validation failure は 400 です。再採用は既存 row の patch ではなく immutable な
derived InstallConfig の作成と Capsule の authority-fenced rebind です。Plan、approval、
Apply は通常の Run API が引き続き所有し、この endpoint は infrastructure を実行しません。

memory / PostgreSQL / D1 の各 store は、current と target の exact InstallConfig
record digest/JSON、および Capsule status、`currentStateGeneration`、
`currentStateVersionId`、`executionAuthorityEpoch` を一つの CAS fence で検証します。
成功時だけ epoch が増え、value-free activity と idempotency receipt が残ります。
legacy Plan に epoch がない場合は epoch 1 のときだけ許容され、authority replacement
後は fail closed です。

通常は `runtimeSafety` が `safe` または decisive Run がない場合だけ rebind できます。
ただし provider Apply が成功して current `StateVersion` / `Output` を commit した後に
terminal `post_apply` lifecycle action だけが失敗した Capsule には、狭い recovery 例外が
あります。GET の `authorityGuard` は decisive failed ApplyRun、StateVersion、Output の
各 id と full-row digest、generation、domain-separated evidence digest から成る value-free
proof を内部で束ねます。同じ proof は immutable derived target の private receipt に seal
されますが、public Capsule / InstallConfig / response には出ません。

この例外でも各 store は同じ pointer/epoch CAS の中で、latest decisive candidate がその
exact failed create/update Apply であること、exact Run / StateVersion / Output row、whole
current/target InstallConfig JSON、whole Capsule JSON、`queued`/`running` Plan または Apply が
ないことを再検証します。computed/reviewable Plan は epoch advance で supersede されます。
receipt/row drift、provider 成否の不確実性、`providerApplySucceeded=false` の persisted partial
state、destroy/restore、新しい safety candidate はすべて 409 です。成功が変更するのは
`installConfigId`、`updatedAt`、epoch + 1
だけで、`status=error`、state/output pointer、generation、`runtimeSafety=unknown` は維持され、
Plan や provider を dispatch しません。old Plan は新しい epoch で拒否され、target
InstallConfig を読む fresh Plan とその successful Apply だけが Capsule を `active` / `safe`
へ戻します。

この epoch は Capsule OIDC activation authority にも含まれるため、再採用前の old/orphan
Apply が新しい InstallConfig を認可することはありません。

### Run と StateVersion

| メソッド | パス                                                    | 説明                            |
| -------- | ------------------------------------------------------- | ------------------------------- |
| GET      | `/api/v1/workspaces/{workspaceId}/runs`                 | Run を一覧する                  |
| GET      | `/api/v1/runs/{runId}`                                  | Run を読む                      |
| POST     | `/api/v1/runs/{runId}/approve`                          | Run を承認する                  |
| POST     | `/api/v1/runs/{runId}/apply`                            | 確認済みの Run をデプロイする   |
| POST     | `/api/v1/runs/{runId}/cancel`                           | Run を取り消す                  |
| GET      | `/api/v1/runs/{runId}/logs`                             | Run のログを読む                |
| GET      | `/api/v1/runs/{runId}/events`                           | Run のイベントを読む            |
| GET      | `/api/v1/runs/{runId}/cost`                             | Run の費用見込みを読む          |
| GET      | `/api/v1/run-groups/{runGroupId}`                       | まとめて実行した Run を読む     |
| POST     | `/api/v1/run-groups/{runGroupId}/approve`               | まとめて実行した Run を承認する |
| GET      | `/api/v1/state-versions/{stateVersionId}`               | StateVersion を読む             |
| POST     | `/api/v1/state-versions/{stateVersionId}/rollback-plan` | 以前の状態に戻す計画を作る      |

ポリシーで止まった計画と承認が必要な計画の Run には `policyReasons` が付きます。各要素は
`{ code, layer, provider?, resourceType? }` で、`code` と `layer` は決まった値だけを取ります
（例: `provider_not_allowed` / `provider`、`approval_required_change` / `action`）。
英文の理由そのものは返しません。分類できない理由は `unclassified` として残ります。

版の変更（自動更新を含む）・以前の版への巻き戻し・設定の変更・Workspace の一括更新から
作られた計画の Run には `origin` が付きます（`{ kind: "revision", ref }` /
`{ kind: "rollback", stateVersionId }` / `{ kind: "configuration" }` / `{ kind: "update" }`）。
失敗した変更をやり直すクライアントは、Source の既定 ref ではなく同じ変更をもう一度計画します。

### 認証情報と Output の共有

| メソッド | パス                                            | 説明                                               |
| -------- | ----------------------------------------------- | -------------------------------------------------- |
| GET      | `/api/v1/connections`                           | Connection を一覧する                              |
| POST     | `/api/v1/connections`                           | 書き込み専用の Connection を作る                   |
| POST     | `/api/v1/connections/{connectionId}/test`       | Connection を検証する                              |
| POST     | `/api/v1/connections/{connectionId}/revoke`     | Connection を失効させる                            |
| POST     | `/api/v1/connections/oauth/{helperId}/start`    | OAuth 補助を開始する                               |
| GET      | `/api/v1/connections/oauth/{helperId}/callback` | OAuth 補助を完了する                               |
| GET      | `/api/v1/provider-connections`                  | 本人とreleaseが持つbindableな ProviderConnection を一覧する。`capsuleId=&projection=release-owned` は1アプリ分。`workspaceId=` は旧互換の一覧で、そのWorkspaceを記録した本人の接続とoperatorのbindable接続だけ (Workspaceのメンバーでも他人の接続は見えない) |
| GET      | `/api/v1/credential-recipes`                    | Credential Recipe を一覧する                       |

Connection の作成は `POST /api/v1/connections` です。`/api/v1/provider-connections`
は読み取り専用で、失効は `POST /api/v1/connections/{connectionId}/revoke` です。

### dashboard 用の投影

| メソッド | パス                          | 説明                                     |
| -------- | ----------------------------- | ---------------------------------------- |
| GET      | `/api/v1/dashboard/bootstrap` | 画面の初期表示に必要な情報をまとめて読む |
| GET      | `/api/v1/dashboard/overview`  | Workspace の概況を読む                   |

Operator が用意した組み込みの設定補助 (credential recipe) は、次の session API から
確認できます。

```http
GET /api/v1/credential-recipes
```

Run は Capsule への操作を 1 種類の記録エントリにまとめたものです。`type` は
`source_sync` / `compatibility_check` / `plan` / `apply` / `destroy_plan` /
`destroy_apply` / `drift_check` / `backup` / `restore` のいずれかになります。

Git checkout からビルドする Capsule は、install plan の exact preflight と
`initialConfiguration.sourceBuild` で review 済み build contract を固定できます。
これはユーザーが明示的に承認する Capsule 設定です。

```json
{
  "sourceBuild": {
    "commands": [
      { "argv": ["bun", "install", "--frozen-lockfile"] },
      { "argv": ["bun", "run", "build"], "workingDirectory": "web" }
    ],
    "outputs": ["web/dist/index.js"]
  }
}
```

command は shell 文字列ではなく argv 配列です。working directory と output は
Git checkout 内の相対 path に限り、provider credential は build phase に渡しません。
指定しない場合は通常どおり、OpenTofu module が成果物を解決します。参照元は
release artifact の URL / digest、provider、data source などです。

公開 hostname、DNS、application endpoint は Git checkout 内の通常の OpenTofu
module と provider が所有します。Takosumi は Capsule 用 hostname を合成または予約せず、
`public_endpoint` は apply 済み Output を UI に投影するための metadata として扱います。

Run には次を保存します。

- source snapshot
- OpenTofu version
- provider lock digest
- ProviderBinding
- 注入した env の metadata (値そのものは保存しません)
- plan / apply の結果
- state version
- outputs
- logs
- actor
- audit evidence

`Source.defaultRef` は branch / tag / commit を受け取ります。`Source.autoSync`
を有効にすると、scheduler または source webhook は Source の既定 ref/path に加え、
その Source を使う各 Capsule が apply 済み StateVersion で採用した ref/path を同期します。
解決された commit は `SourceSnapshot` として保存されます。同じ ref/path lane を採用している
active Capsule の現在 snapshot と新しい commit が異なると、Capsule は `stale` になります。
別 lane の更新で stale にしたり、Source の既定 ref を書き換えたりしません。
通常の update plan も採用済み lane の最新 snapshot を使います。そこからは既存の
Workspace update / RunGroup が reviewable plan を作り、
apply は通常の Run approval に従います。app artifact をどこから取るかは、あくまで
OpenTofu module の中で決まります。

明示的な更新確認では、先に Source を同期し、その要求が生成した変更不可の
`SourceSnapshot` を compatibility check と plan に固定します。既存の古い snapshot を
「最新」として流用してはいけません。session API では次の intent を使えます。

```http
POST /api/v1/sources/{sourceId}/sync
Content-Type: application/json

{ "intent": "manual_plan" }
```

`observe` (省略時) は webhook / scheduler の観測用で、Capsule が opt-in
していれば auto-update を評価できます。`manual_plan` はユーザーが確認する plan
のための同期で、その sync 自体から別の auto-update plan/apply を開始しません。
クライアントは、返された SourceSyncRun が `succeeded` になるまで待ちます。その Run の
`sourceSnapshotId` が一覧に現れてから、compatibility check と plan を続けます。

## OIDC と workload identity

明示 opt-in の first-party profile は [共通 account と Workspace](./shared-account.md)
を参照してください。共有 identity は現在の Workspace membership と billing owner
の認可を置き換えません。

Takosumi Accounts は登録済み OIDC client のための標準 issuer surface を公開します。

```http
GET  /.well-known/openid-configuration
GET  /oauth/jwks
GET  /oauth/authorize
POST /oauth/token
```

独立した ServiceAccount / workload federation API は現在の public surface にはありません。
AWS / GCP / Kubernetes ごとの固定 route や credential kind も Core には追加しません。
将来の workload identity は、汎用 OIDC principal、Resource Credential / Policy、または
Credential Recipe の明示的な pre-run action として設計します。公開するのは、実装と
discovery が揃ってからです。
Operator / hosted service はその汎用 seam に Enterprise SSO、SCIM、商用 audit export を追加できます。

Takosumi は Git metadata、provider output、product identity、hostname convention、
または任意の provider 呼び出しから Accounts OIDC client を推測して登録しません。
provider runtime-binding は read-only derivation で registration authority を持ちません。
Takosumi-owned generic Accounts capability implementation が final-Apply activation を所有します。
review 済み repository manifest は、同じ module に exactly one の `http.endpoint` がある
場合だけ generic `identity.oidc` capability を要求できます。read-only Plan は endpoint の
exact Plan-known canonical HTTPS origin を要求し、`accountsUrl`、`issuerUrl`、`clientId`、
`redirectUri` の4つの非 secret delivery 値だけを authority digest に固定します。
Plan と `apply_check` は Accounts を変更せず、最終 Apply の再検証時だけ Capsule-bound
client を何度実行しても結果が同じ形で登録して、現在の value-free `activationDigest` を保存できます。

この digest は contract `takosumi.accounts-oidc-activation/v1`、Workspace/Capsule、
`executionAuthorityEpoch`、full InstallConfig digest を束ねます。live grant は current
Capsule/config/repository provenance/epoch と digest の exact match を要求し、legacy null
または mismatch は stale/denied として Apply 修復まで認可しません。`updatedAt` は通常の
監査時刻であり authority ではありません。callback と scopes は manifest request と
operator policy の exact intersection であり、scopes は `openid` を含む明示 allowlist 内に
限定されます。ProviderBinding、private descriptor、owner-subject variable、provider fallback、
client secret はこの lane に存在しません。既に登録済みの Capsule client は current Capsule /
InstallConfig / Workspace membership / scope を利用時に再検証し、無効な terminal binding は
best-effort で revoke します。bulk/operator secret と generic ProviderConnection は引き続き
operator/Accounts の所有です。
Accounts が発行する Workspace-scoped token と Interface 呼び出しは、引き続き scope と
Workspace の両方を検証します。token の実体は利用側の secret store に暗号化して保存し、
OpenTofu state や Output には保存しません。

Accounts schema は additive な protected migration ですが、promotion order は実行基盤ごとに
異なります。PostgreSQL では migration 043 を適用してから migration 044 を適用し、feature
Worker を promote する前に完了させます。043 は nullable `activation_digest` と NOT VALID
shape check を追加し、044 はその check を validate します。Cloudflare D1 では、まず exact-v3
ledger/schema closure を確認してから v3/v4 feature bridge を deploy します。bridge は exact
legacy v3 または checksummed v4 だけを受け付け、request-time DDL は行いません。owner-private
backup and status evidence を保持し、bounded pre-ledger backfill を完了してから atomic v4
apply and read-only verify を実行します。observation window の後に exact-v4-only Worker を
deploy してください。v4 commit 後に v3-only Worker を live に残してはならず、bridge が
compatible rollback floor です。両 lane は forward-only です。legacy null は保存されますが、
exact current digest を Apply が保存するまで live grant を許可しません。

`GET /oauth/authorize` の任意の `workspace_id` は、複数 Workspace を持つ
Principal が発行先を明示するための選択子です。Accounts は認可コードの発行直前に
その Principal の live membership と、Capsule-owned client なら Capsule の owning
Workspace も照合します。重複値、空値、制御文字、過長値、または権限のない
Workspace は拒否され、発行された access token には検証済み Workspace と role だけが
記録されます。

静的な composition OIDC client も、`workspace_id` を指定して検証済みの
Workspace-bound token を要求できます。Capsule に紐付かないこの client の ID token と
UserInfo は `takosumi.workspace_id` と現在の `takosumi.role` を返し、
`capsule_id` は返しません。UserInfo の `workspace_memberships` は検証済みの
Workspace だけを含む `[workspace_id]` です。Capsule-owned client では、従来どおり
検証済みの `capsule_id` も `takosumi` に含まれます。membership が失効または停止した
場合、UserInfo と refresh は fail-closed で拒否されます。

## エラーの形式

失敗した response は structured error を返します。

```json
{
  "error": {
    "code": "capability_not_available",
    "message": "requested capability is not enabled for this endpoint",
    "requestId": "req_123"
  }
}
```

secret の値、一時的な credential、内部 adapter の credential は error に含めません。

例外は bearer の認証の失敗です。API キーが無い、違う、期限切れのときは `401` で、本文は
`{"error":"invalid_token"}`、`WWW-Authenticate: Bearer error="invalid_token"` header が
付きます。OIDC と OAuth の endpoint は、標準の `{ error, error_description }` を返します。

## バージョン

現在の API version は `takosumi.dev/v1alpha1` です。

| version    | 位置づけ                                               |
| ---------- | ------------------------------------------------------ |
| `v1alpha1` | 破壊的変更あり。docs と conformance を同時に更新する   |
| `v1beta1`  | 大枠は固定。upgrade / conversion guidance を必須とする |
| `v1`       | 後方互換を維持。field は削除しない                     |

OSS / Operator / hosted service の違いは API version ではなく capabilities で表します。
