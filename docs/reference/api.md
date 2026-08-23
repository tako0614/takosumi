# Takosumi API

Takosumi API は、Git を正とする OpenTofu / Terraform control plane、provider 接続、Run、
Interface / InterfaceBinding を公開します。Workspace / Capsule / Run などの用語は
[用語集](./glossary.md) を参照してください。

外部インフラには既存 provider と標準 API を使います。Takoform は通常の OpenTofu
provider です。その他の API / instance lifecycle は、それを提供する external Host が
所有します。

## 基本方針

| 状況 | 扱い方 |
| --- | --- |
| 外部 resource に標準 API / OpenTofu provider がある | plain Stack flow でその surface を使う |
| Form を提供する Host がある | その Host が定義・instance・lifecycle の authority を持つ |
| 一回限りの不足 | generic-env ProviderConnection と通常の OpenTofu module で扱う |

Takosumi は自前の Terraform / OpenTofu provider を配布しません。Takoform は通常の
provider として使います。外部 provider は plain Stack flow でそのまま実行され、
Interface / InterfaceBinding は provider-neutral な接続認可を表します。
Cloudflare 固有の import/deploy compatibility profile は廃止済みです。

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
    "compat_framework": true,
    "compatibility_profiles": [],
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

field 名は snake_case です。`product` は常に `takosumi` で、client は最初にこれを
確認します。`endpoints.api` は origin そのものではなく `<origin>/api/v1` です。

`features.compatibility_profiles` は文字列の配列です。その endpoint の operator が
実際に有効化した互換プロファイルの token だけが並びます。既定値はなく、何も
設定していない endpoint では空配列です。mobile client 用の OIDC client id を
設定した endpoint は `oidcClientId` も返します。追加の endpoint family を公開する
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

| メソッド | パス                                  | 認証                               | 説明                                |
| -------- | ------------------------------------- | ---------------------------------- | ----------------------------------- |
| GET      | `/api/v1/account/tokens`                  | account session                    | 対話的一覧                          |
| GET      | `/api/v1/account/tokens/scopes`           | account session                    | 現在の self-service scope catalog   |
| POST     | `/api/v1/account/tokens`                  | account session                    | PAT を作成する                      |
| POST     | `/api/v1/account/tokens/{tokenId}/revoke` | account session                    | PAT を失効する                      |
| GET      | `/api/v1/account/tokens/inventory.v1`     | account session                    | 完全な versioned metadata inventory |
| GET      | `/api/v1/account/tokens/current`          | `Authorization: Bearer <PAT>` のみ | 提示した PAT 自身の現在の authority |

scope catalog は core の `read` / `write` と、同じ owning route が
`selfServicePatScopes` で明示した allowlist 済み extension scope だけを
self-service として返します。Takosumi hosted AI の `ai.models.read` / `ai.chat` /
`ai.embeddings` と `resources:read` は Workspace binding 必須です。`admin` や
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

Stack API は plain OpenTofu / Terraform module を Git から実行します。
この flow では既存 provider をそのまま使います。

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

正本は `accounts/service/src/control-route-inventory.ts` で、公開されているのは
次の 87 件です。

**Account views**

| メソッド | パス                             | 説明                                                        |
| -------- | -------------------------------- | ----------------------------------------------------------- |
| GET      | `/api/v1/views/workspaces.v1`    | アカウントの active membership Workspace inventory を読む |

`/api/v1/views/workspaces.v1` は、初回ログインの個人 Workspace 作成・修復を持つ
`GET /api/v1/workspaces` とは別の読み取り専用 projection です。認証済みアカウントの
active membership を `created_asc` で返し、archived Workspace も含めます。`limit` は
省略時 100、最大 100、`cursor` は opaque token です。クエリキーは `limit` と
`cursor` だけを受け付けます。レスポンスの `total` は cursor 適用前の全 active
membership 行数です。Workspace-scoped credential では利用できません。

**Workspace**

| メソッド | パス                                                 | 説明                                    |
| -------- | ---------------------------------------------------- | --------------------------------------- |
| GET      | `/api/v1/workspaces`                                 | 自分が参加している Workspace を一覧する |
| POST     | `/api/v1/workspaces`                                 | Workspace を作る                        |
| GET      | `/api/v1/workspaces/{workspaceId}`                   | Workspace を読む                        |
| PATCH    | `/api/v1/workspaces/{workspaceId}`                   | Workspace を更新する                    |
| GET      | `/api/v1/workspaces/{workspaceId}/members`           | メンバーを一覧する                      |
| POST     | `/api/v1/workspaces/{workspaceId}/members`           | メンバーを追加する                      |
| PATCH    | `/api/v1/workspaces/{workspaceId}/members/{subject}` | メンバーの役割を変える                  |
| DELETE   | `/api/v1/workspaces/{workspaceId}/members/{subject}` | メンバーを外す                          |
| GET      | `/api/v1/workspaces/{workspaceId}/graph`             | Capsule の依存グラフを読む              |
| GET      | `/api/v1/workspaces/{workspaceId}/activity`          | 操作履歴を一覧する                      |
| GET      | `/api/v1/workspaces/{workspaceId}/usage`             | 利用量を一覧する                        |
| GET      | `/api/v1/workspaces/{workspaceId}/billing`           | 課金状態を読む                          |
| GET      | `/api/v1/workspaces/{workspaceId}/backups`           | 制御情報の書き出しを一覧する            |
| POST     | `/api/v1/workspaces/{workspaceId}/backups`           | 制御情報を書き出す                      |
| POST     | `/api/v1/workspaces/{workspaceId}/plan-update`       | Workspace 全体の更新 Run を作る         |
| POST     | `/api/v1/workspaces/{workspaceId}/drift-check`       | Workspace 全体の差分確認 Run を作る     |

操作履歴は `/api/v1/workspaces/{workspaceId}/activity` から読みます。

**Project と Capsule**

| メソッド | パス                                                      | 説明                               |
| -------- | --------------------------------------------------------- | ---------------------------------- |
| GET      | `/api/v1/workspaces/{workspaceId}/projects`               | Project を一覧する                 |
| POST     | `/api/v1/workspaces/{workspaceId}/projects`               | Project を作る                     |
| GET      | `/api/v1/projects/{projectId}`                            | Project を読む                     |
| GET      | `/api/v1/workspaces/{workspaceId}/capsules`               | Capsule を一覧する                 |
| POST     | `/api/v1/workspaces/{workspaceId}/capsules`               | Capsule を作る                     |
| GET      | `/api/v1/capsules/{capsuleId}`                            | Capsule を読む                     |
| PATCH    | `/api/v1/capsules/{capsuleId}`                            | Capsule を更新する                 |
| DELETE   | `/api/v1/capsules/{capsuleId}`                            | 破棄計画を作る                     |
| GET      | `/api/v1/capsules/{capsuleId}/outputs`                    | 公開 Output を読む                 |
| GET      | `/api/v1/capsules/{capsuleId}/usage-summary`              | 利用量の集計を読む                 |
| GET      | `/api/v1/capsules/{capsuleId}/state-versions`             | StateVersion を一覧する            |
| GET      | `/api/v1/capsules/{capsuleId}/dependencies`               | 依存を一覧する                     |
| POST     | `/api/v1/capsules/{capsuleId}/dependencies`               | 依存を作る                         |
| DELETE   | `/api/v1/dependencies/{dependencyId}`                     | 依存を削除する                     |
| GET      | `/api/v1/capsules/{capsuleId}/provider-bindings`          | ProviderBinding の選択を読む       |
| PUT      | `/api/v1/capsules/{capsuleId}/provider-bindings`          | ProviderBinding の選択を置き換える |
| GET      | `/api/v1/workspaces/{workspaceId}/current-state-versions` | 現在の StateVersion をまとめて読む |
| GET      | `/api/v1/capsule-configs`                                 | Capsule 作成設定を一覧する         |
| GET      | `/api/v1/capsule-configs/{capsuleConfigId}`               | Capsule 作成設定を読む             |
| PATCH    | `/api/v1/capsule-configs/{capsuleConfigId}`               | Capsule 作成設定を更新する         |

Capsule を作ってから実行するには、まず計画を作り、内容を確認してから適用します。
Run は必ず計画の作成から始まります。

| メソッド | パス                                        | 説明                         |
| -------- | ------------------------------------------- | ---------------------------- |
| POST     | `/api/v1/capsules/{capsuleId}/plan`         | 計画 Run を作る              |
| POST     | `/api/v1/capsules/{capsuleId}/destroy-plan` | 破棄計画 Run を作る          |
| POST     | `/api/v1/capsules/{capsuleId}/drift-check`  | 差分確認 Run を作る          |
| POST     | `/api/v1/capsules/{capsuleId}/backups`      | Capsule のバックアップを作る |

**Source**

| メソッド | パス                                             | 説明                        |
| -------- | ------------------------------------------------ | --------------------------- |
| GET      | `/api/v1/sources`                                | Source を一覧する           |
| POST     | `/api/v1/sources`                                | Source を作る               |
| GET      | `/api/v1/sources/{sourceId}`                     | Source を読む               |
| PATCH    | `/api/v1/sources/{sourceId}`                     | Source のメタ情報を更新する |
| POST     | `/api/v1/sources/{sourceId}/sync`                | 同期 Run を作る             |
| GET      | `/api/v1/sources/{sourceId}/snapshots`           | SourceSnapshot を一覧する   |
| GET      | `/api/v1/sources/{sourceId}/snapshots/{sourceSnapshotId}/deployment-profiles` | その Snapshot で実在を確認できた DB 所有のデプロイ方法だけを一覧する |
| POST     | `/api/v1/sources/{sourceId}/compatibility-check` | 互換性レポートを作る        |
| GET      | `/api/v1/compatibility-reports/{reportId}`       | 互換性レポートを読む        |

**Git install plan**

| メソッド | パス                                                        | 説明                                       |
| -------- | ----------------------------------------------------------- | ------------------------------------------ |
| POST     | `/api/v1/workspaces/{workspaceId}/install-plans`            | Git から reviewable Plan Run まで準備する |
| GET      | `/api/v1/install-plans/{installPlanId}`                      | coordinator の現在状態を読む              |
| POST     | `/api/v1/install-plans/{installPlanId}/reconcile`            | 明示的に一段だけ進める                     |

作成には `Idempotency-Key` が必須です。同じ Workspace・actor・key と同じ正規化 request
は同じ record を返し、内容が異なれば 409 になります。coordinator が保持するのは Source、
SourceSnapshot、InstallConfig、Capsule、Plan Run の参照と bounded diagnostic だけです。
variable 値、credential、token、Output 値は受け付けません。`reviewable` になった後の
承認と apply は `Run` API だけが所有し、install-plan 専用 apply route はありません。

**Git revision plan**

| メソッド | パス                                                        | 説明                                               |
| -------- | ----------------------------------------------------------- | -------------------------------------------------- |
| POST     | `/api/v1/capsules/{capsuleId}/revision-plans`               | 既存 Capsule の Git ref 更新 intent を作成・再生する |
| GET      | `/api/v1/revision-plans/{revisionPlanId}`                   | coordinator の現在状態を副作用なしで読む          |
| POST     | `/api/v1/revision-plans/{revisionPlanId}/reconcile`         | 明示的に一段だけ進める                             |

作成 body は `{ "ref": "<git-ref>" }` だけを受け付け、`Idempotency-Key` が
必須です。新規作成は 201、同じ key と同じ正規化 request の再生は 200、同じ key の
別 request は 409 です。coordinator は既存 Capsule・Source・InstallConfig・state generation を
固定し、Source の既定 ref/path を変更せず、対象 ref の deterministic SourceSyncRun /
SourceSnapshot、互換性レポート、Plan Run を順に作ります。各 mutation は同じ ID で
lost acknowledgement を回収し、未確認の mutation は 202 と `nextAction: "reconcile"` を
返します。`reviewable` では `nextAction: "review_run"` で停止します。rollback は引き続き
`POST /api/v1/state-versions/{stateVersionId}/rollback-plan` が所有します。

revision plan の作成や reviewable 化だけでは Capsule の追跡先は変わりません。対象 Plan を
通常の Run API で apply して新しい `currentStateVersionId` が採用された後だけ、その
StateVersion が参照する Plan Run の SourceSnapshot が Capsule の追跡正本になります。
`GET /api/v1/capsules/{capsuleId}` はこの非 secret な導出値を
`adoptedSourceRevision: { sourceSnapshotId, ref, path, resolvedCommit }` として返します。
初回 apply 前はこの field はありません。

**Run と StateVersion**

| メソッド | パス                                                    | 説明                            |
| -------- | ------------------------------------------------------- | ------------------------------- |
| GET      | `/api/v1/workspaces/{workspaceId}/runs`                 | Run を一覧する                  |
| GET      | `/api/v1/runs/{runId}`                                  | Run を読む                      |
| POST     | `/api/v1/runs/{runId}/approve`                          | Run を承認する                  |
| POST     | `/api/v1/runs/{runId}/apply`                            | 確認済みの Run を適用する       |
| POST     | `/api/v1/runs/{runId}/cancel`                           | Run を取り消す                  |
| GET      | `/api/v1/runs/{runId}/logs`                             | Run のログを読む                |
| GET      | `/api/v1/runs/{runId}/events`                           | Run のイベントを読む            |
| GET      | `/api/v1/runs/{runId}/cost`                             | Run の費用見込みを読む          |
| GET      | `/api/v1/run-groups/{runGroupId}`                       | まとめて実行した Run を読む     |
| POST     | `/api/v1/run-groups/{runGroupId}/approve`               | まとめて実行した Run を承認する |
| GET      | `/api/v1/state-versions/{stateVersionId}`               | StateVersion を読む             |
| POST     | `/api/v1/state-versions/{stateVersionId}/rollback-plan` | 以前の状態に戻す計画を作る      |

**認証情報と Output の共有**

| メソッド | パス                                            | 説明                                               |
| -------- | ----------------------------------------------- | -------------------------------------------------- |
| GET      | `/api/v1/connections`                           | Connection を一覧する                              |
| POST     | `/api/v1/connections`                           | 書き込み専用の Connection を作る                   |
| POST     | `/api/v1/connections/{connectionId}/test`       | Connection を検証する                              |
| POST     | `/api/v1/connections/{connectionId}/revoke`     | Connection を失効させる                            |
| POST     | `/api/v1/connections/oauth/{helperId}/start`    | OAuth 補助を開始する                               |
| GET      | `/api/v1/connections/oauth/{helperId}/callback` | OAuth 補助を完了する                               |
| GET      | `/api/v1/provider-connections`                  | Workspace から見える ProviderConnection を一覧する |
| GET      | `/api/v1/credential-recipes`                    | Credential Recipe を一覧する                       |
| GET      | `/api/v1/output-shares`                         | OutputShare を一覧する                             |
| POST     | `/api/v1/output-shares`                         | OutputShare を作る                                 |
| POST     | `/api/v1/output-shares/{shareId}/approve`       | OutputShare を承認する                             |
| POST     | `/api/v1/output-shares/{shareId}/revoke`        | OutputShare を失効させる                           |

Connection の作成は `POST /api/v1/connections` です。`/api/v1/provider-connections`
は読み取り専用で、失効は `POST /api/v1/connections/{connectionId}/revoke` です。

**dashboard 用の投影**

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

Git checkout からビルドする Capsule は、作成時に任意の `sourceBuild` を指定できます。
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

repository の `public_endpoint` projection が Cloud hostname を使う場合、Capsule
作成時に割り当て方を選べます。省略時は `scoped` です。この値は、同じ `subdomain` /
`url` / `routePattern` 変数を確定するための control-plane policy です。

```json
{
  "managedPublicHostname": { "mode": "vanity" }
}
```

`scoped` は `<workspace-handle>-<label>.<managed-base-domain>` で枠を消費しません。
`vanity` は `<label>.<managed-base-domain>` をそのまま使い、Workspace の変更不可な
owner account の有限枠を 1 つ消費します。どちらも hostname 単位で
first-come-first-served に予約します。

Hostname reservation と vanity slot は Capsule lifetime に属します。成功した
Capsule destroy で解放し、個別 route の削除では解放しません。ユーザー所有 custom
domain は、この mode ではなく別の verified-domain lifecycle を使います。Takosumi hosted service
では verification / certificate lifecycle が未実装のため Planned です。hosted service の
route への要求は安全側に停止します。通常の OpenTofu の URL / route 変数を
BYOC provider へ渡す経路は、これとは別にそのまま使えます。

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
active Capsule の現在 snapshot と新しい commit が異なるときだけ、Capsule は `stale`
になります。別 lane の更新で stale にしたり、Source の既定 ref を書き換えたりしません。
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

Capsule が公開する OIDC client は `installExperience.oidc_client.scopes`
で必要な scope を宣言できます。`openid` は必須です。Accounts が発行する
`capsules:read` / `capsules:write` access token は単一 Workspace に束縛されます。
canonical Capsule ledger の参照と Interface 呼び出しでは、scope と Workspace の
両方を検証します。`offline_access` を許可した client は refresh token を受け取れます。
token の実体は利用側の secret store に暗号化して保存し、OpenTofu state や Output には
保存しません。

`GET /oauth/authorize` の任意の `workspace_id` は、複数 Workspace を持つ
Principal が発行先を明示するための選択子です。Accounts は認可コードの発行直前に
その Principal の live membership と、Capsule-owned client なら Capsule の owning
Workspace も照合します。重複値、空値、制御文字、過長値、または権限のない
Workspace は拒否され、発行された access token には検証済み Workspace と role だけが
記録されます。

## Compatibility API

Compatibility API は標準 protocol / API の scoped facade です。control-plane profile は
supported control-plane API の translation client として働きます。data-plane profile は
認可済み Interface への access surface になります。

| profile                    | 範囲                                            |
| -------------------------- | ----------------------------------------------- |
| `compat.s3.v1`             | S3 互換の Object Storage の data / control path |
| `compat.oci.v1`            | Artifact / ContainerImage の lifecycle          |
| `compat.cloudevents.v1`    | Queue / EventHandler への event ingress         |
| `compat.kubernetes.crd.v1` | Kubernetes northbound API                       |

これは full vendor API 互換を意味しません。範囲は capability と compatibility
matrix で明示します。

明示的に導入した protocol adapter、dashboard、CLI は公開する protocol がそれぞれ
違っても、同じ supported control-plane lifecycle に収束します。表現できない操作は
互換のように成功させず、compatibility matrix で範囲を明示して安全側に停止します。

Cloudflare 固有の import/deploy compatibility profile は廃止済みで、v1 API と
capability surface には含まれません。利用者自身の Cloudflare account に作る Stack は
通常の ProviderConnection として扱います。

compatibility profile は Cloud hostname を作りません。runtime route は
`http.route` Interface と InterfaceBinding で公開します。hostname の所有権は OSS の
reservation authority、または operator / hosted service の VerifiedDomain lifecycle が管理します。
routing cache や backend state を hostname 所有権の正本にはしません。

Takosumi hosted service 固有の endpoint 例は
[hosted service endpoints](https://app.takosumi.com/docs/endpoints) を見てください。

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

## バージョン

現在の API version は `takosumi.dev/v1alpha1` です。

| version    | 位置づけ                                               |
| ---------- | ------------------------------------------------------ |
| `v1alpha1` | 破壊的変更あり。docs と conformance を同時に更新する   |
| `v1beta1`  | 大枠は固定。upgrade / conversion guidance を必須とする |
| `v1`       | 後方互換を維持。field は削除しない                     |

OSS / Operator / hosted service の違いは API version ではなく capabilities で表します。
