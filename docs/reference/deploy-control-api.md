# Control Plane API

Takosumi の control plane は OpenTofu Capsule DAG を Space 直下で管理する HTTP API です。正本は
[`docs/core-spec.md`](../core-spec.md) で、公開 surface と外部 install link は同 spec、error code は
service contract が所有します。本ドキュメントが spec と矛盾した場合は spec が勝ちます。

公開語彙は **Space / Source / Connection / Provider Template / Provider Env Set / OpenTofu Capsule /
Capsule Normalizer / Compatibility Report / Capsule Gate / Installation (+InstallConfig) / DeploymentProfile /
ProviderBinding / Dependency / SourceSnapshot / DependencySnapshot / StateSnapshot / Run / RunGroup / Deployment /
OutputSnapshot / Backup / Billing / Activity** です。
runner substrate / image / limits は operator-internal execution boundary として Connection + ProviderBinding + policy 層の下に従属します。

## Surface と認証モデル

公開される control-plane edge surface は **`/api/v1/*`**、`/install`、inbound webhook seam の `/hooks/*` です。
`/api/v1/*` は単一の versioned edge surface で、dashboard session・operator bearer・accounts/CLI が同じ route family を
叩きます。in-process の deploy-control 実装は **`/internal/v1/*`** seam contract に閉じており edge-public ではありません
(host 内で dial され、`/api/v1` edge router がそこへ委譲します)。

| Surface         | 用途                          | 認証                                                                       |
| --------------- | ----------------------------- | -------------------------------------------------------------------------- |
| `/api/v1/*`     | 公開 control plane (versioned) | host が scoped principal を解決。reference fallback は operator bearer token |
| `/install`      | public install deep link      | bearer 不要。dashboard の session gate へ渡す                              |
| `/hooks/*`      | inbound forge webhook         | hook secret。operator bearer ではない                                      |
| `/internal/v1/*` | in-process deploy-control seam | 内部 (operator bearer)。edge から到達不可                                  |

> **account-plane product surface との区別**: account plane は別の resource として **`/v1/app-installations`**
> (takos product の AppInstallation app-distribution API) を持ちます。これは `/api/v1` の deploy-control Installation とは
> 別 resource であり、意図的に別 prefix で共存します。Connection は両 prefix で同一 resource なので **`/api/v1/connections`**
> (session 認証の control surface) に一本化されており、`/v1/connections` edge は存在しません。本ドキュメントが扱うのは
> `/api/v1` deploy-control surface です。

### `/api/v1` scoped principal

`/api/v1` の各 route は、host worker が解決した scoped principal で保護されます。dashboard session、accounts plane、
CLI bearer などの入口差分は host 側の resolver に閉じ、API handler は `actor` / `spaceIds` / `operations` を持つ
principal だけを見る。reference fallback では token は `TAKOSUMI_DEPLOY_CONTROL_TOKEN` から供給され、token も bearer
resolver も未設定の host は `/api/v1` route を `404 not_found` で隠します (未設定 surface を public host で漏らさない)。

operator / account-plane は bearer resolver を差し替えて、`actor` / `spaceIds` / `operations` を
持つ scoped principal を返せます。scope は **default deny** で、resolver が省略した scope は許可になりません:

- read は対象 record の `spaceId` で許可されます。
- mutation は `operations` (`create` / `update` / `destroy` …) で許可されます。
- Space 作成・operator-scope Connection・operator connection defaults は instance-wide なので、無制限 bearer
  (`spaceIds: "*"`) だけが触れます。
- `GET /api/v1/connections` を `spaceId` なしで呼ぶと operator-scope Connection 一覧になり、これも無制限 bearer 専用です。

scope 外の request は `403 permission_denied` になり、API 起点の audit event に `actor` が記録されます。default の
fallback bearer は `spaceIds`/`operations` が `"*"` の principal です。

### `/hooks` webhook seam

`/hooks/*` は Source の webhook secret で認証する inbound seam です。operator bearer route ではなく、source sync を
queue へ渡すための public ingress として扱います。hook secret は作成時に一度だけ返し、通常の Source read response には
含めません。

### 内部 `/internal/v1` seam

deploy-control の in-process 実装は `/internal/v1/*` seam に閉じており、account session や in-process fetch seam が
public operations に委譲します。これは hosted/self-host distribution の実装詳細 (operator bearer のみ、edge から到達
不可) であり、外部統合・Capsule author・public API reader が依存する contract は `/api/v1/*`、`/install`、`/hooks/*`
だけです。

## `/api/v1` surface

公開 surface は `/api/v1` に versioned でまとまります。`/api/v1` route は host が解決した scoped principal で保護され、
reference fallback のみ operator bearer token を使います。operator-only admin route は operator-scoped principal だけが
使えます。各 route の in-process 実装は対応する `/internal/v1` seam route に委譲します。

### Spaces

| Method | Path                    | 用途                                                         |
| ------ | ----------------------- | ------------------------------------------------------------ |
| POST   | `/api/v1/spaces`           | Space 作成 (`@handle` owner namespace)。無制限 bearer 専用。 |
| GET    | `/api/v1/spaces`           | principal が見える Space 一覧                                |
| GET    | `/api/v1/spaces/{spaceId}` | Space 取得                                                   |
| PATCH  | `/api/v1/spaces/{spaceId}` | Space 更新 (MVP: `displayName` のみ)                         |

### Sources

| Method | Path                                | 用途                                                                                               |
| ------ | ----------------------------------- | -------------------------------------------------------------------------------------------------- |
| POST   | `/api/v1/sources`                      | git Source 登録 (URL policy 検証、ls-remote は queued `source_sync`)。hook secret を一度だけ返す。 |
| GET    | `/api/v1/sources?spaceId={spaceId}`    | Space 内の Source 一覧 (hook secret は含まない)                                                    |
| GET    | `/api/v1/sources/{sourceId}`           | Source 取得                                                                                        |
| POST   | `/api/v1/sources/{sourceId}/sync`      | default ref を archive snapshot に解決する `source_sync` Run を作成                                |
| GET    | `/api/v1/sources/{sourceId}/snapshots` | Source の immutable archive snapshot 一覧 (commit / digest / R2_SOURCE key)                        |

`POST /hooks/sources/{sourceId}` は forge webhook の inbound seam で、bearer ではなく hook secret 認証です。

### Connections

connection 作成は kind / provider / authMethod を固定した薄い subroute です。credential `values` は write-only で、
log にも response にも出ません。body には non-secret `expiresAt` を渡せます。期限切れ Connection は `expired` になり、
provider/source credential mint と test は fail-closed します。

| Method | Path                                         | 用途                                                                                              |
| ------ | -------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| POST   | `/api/v1/connections/source/https-token`        | git source HTTPS-token Connection (optional username)                                             |
| POST   | `/api/v1/connections/source/ssh-key`            | git source SSH-key Connection (`scopeHints.knownHostsEntry` 必須)                                 |
| POST   | `/api/v1/connections/cloudflare/oauth/start`    | Cloudflare OAuth helper 開始。成功すると authorization URL / state を返す                         |
| GET    | `/api/v1/connections/cloudflare/oauth/callback` | Cloudflare OAuth helper 完了。write-only `provider_env_set` Connection を作成                     |
| POST   | `/api/v1/connections/cloudflare/token`          | Cloudflare API-token Connection (optional account/zone scope)                                     |
| POST   | `/api/v1/connections/aws/assume-role`           | AWS assume-role-capable Connection (`scopeHints.awsRoleArn` 必須、AWS env `values` は write-only) |
| POST   | `/api/v1/connections/gcp/oauth/start`           | Google Cloud OAuth helper 開始。成功すると authorization URL / state を返す                       |
| GET    | `/api/v1/connections/gcp/oauth/callback`        | Google Cloud OAuth helper 完了。write-only `provider_env_set` Connection を作成                   |
| POST   | `/api/v1/connections/gcp/impersonation`         | Google service-account impersonation 用の write-only Connection を作成                            |
| GET    | `/api/v1/connections`                           | principal が見える Connection 一覧。secret 値は含まない。                                         |
| POST   | `/api/v1/connections/{connectionId}/test`       | 保存済み credential を provider で検証                                                            |
| POST   | `/api/v1/connections/{connectionId}/revoke`     | Connection を revoke し sealed secret blob を削除                                                 |
| PUT    | `/api/v1/operator-connection-defaults`          | operator-scoped bearer 専用。provider の instance-wide default Connection を設定                  |
| GET    | `/api/v1/operator-connection-defaults`          | operator-scoped bearer 専用。instance-wide default Connection 一覧                                |

Operator default connections は instance-wide な管理機能です。route は `/api/v1` inventory に載りますが、operator-scoped
principal だけが使える operator-only admin surface です。Space / Installation の正本 API からは ProviderBinding の
`mode: "default"` として見えます。

### Providers

Providers API は provider template の read surface です。ユーザーが provider credential を追加する操作は
`Connection` の provider env set として行います。

| Method | Path                          | 用途                   |
| ------ | ----------------------------- | ---------------------- |
| GET    | `/api/v1/providers`              | Provider Template 一覧 |
| GET    | `/api/v1/providers/{providerId}` | Provider Template 取得 |

Hosted Takosumi の Takosumi提供 provider は Cloudflare only から始めます。AWS / GCP / GitHub / Kubernetes /
任意 provider は Space-owned `provider_env_set` Connection で使います。OAuth / AssumeRole / impersonation は
env set を作る・更新する helper です。

OAuth helper は operator env で有効化します。共通で `TAKOSUMI_CONNECTION_OAUTH_STATE_SECRET` が必要です。
Cloudflare は `TAKOSUMI_CLOUDFLARE_OAUTH_CLIENT_ID` / `TAKOSUMI_CLOUDFLARE_OAUTH_CLIENT_SECRET` /
`TAKOSUMI_CLOUDFLARE_OAUTH_REDIRECT_URI` / `TAKOSUMI_CLOUDFLARE_OAUTH_AUTHORIZATION_URL` /
`TAKOSUMI_CLOUDFLARE_OAUTH_TOKEN_URL` を設定します。GCP は `TAKOSUMI_GCP_OAUTH_CLIENT_ID` /
`TAKOSUMI_GCP_OAUTH_CLIENT_SECRET` / `TAKOSUMI_GCP_OAUTH_REDIRECT_URI` を設定し、必要なら
`TAKOSUMI_GCP_OAUTH_AUTHORIZATION_URL` / `TAKOSUMI_GCP_OAUTH_TOKEN_URL` / `TAKOSUMI_GCP_OAUTH_SCOPES` を上書きします。

### Installations + InstallConfigs

| Method | Path                                     | 用途                                                                                                       |
| ------ | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| GET    | `/api/v1/install-configs`                   | official / Space-scoped InstallConfig 一覧                                                                 |
| GET    | `/api/v1/install-configs/{installConfigId}` | InstallConfig 取得                                                                                         |
| POST   | `/api/v1/spaces/{spaceId}/installations`    | Space 直下に Installation 作成 (Source + InstallConfig から。environment は実行 namespace の一部)          |
| GET    | `/api/v1/spaces/{spaceId}/installations`    | Space の Installation 一覧                                                                                 |
| GET    | `/api/v1/installations/{installationId}`    | Installation 取得                                                                                          |
| PATCH  | `/api/v1/installations/{installationId}`    | Installation の安全な status patch (`active` / `stale` / `error` のみ。destroy state は destroy flow 専用) |
| DELETE | `/api/v1/installations/{installationId}`    | 直接削除せず destroy-plan Run を作成し、approval + destroy_apply flow に乗せる                             |

### Deploy / Upload

`takosumi deploy` の既定 path です。git Source を登録せず、ローカル作業ディレクトリを直接デプロイします
(`wrangler deploy` analogue)。CLI がローカル Capsule を `tar` (zstd) で固めて upload route に送り、worker が
R2_SOURCE に保存して **upload origin の SourceSnapshot** を記録し、deploy route がその snapshot を pin して
Installation を解決/作成し plan Run を起こします。重い処理 (Capsule Gate / plan / apply) は runner container 内で
実行し、credential は vault が phase ごとに mint します。request は credential material を一切運びません。

| Method | Path                            | 用途                                                                                                              |
| ------ | ------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| POST   | `/api/v1/spaces/{spaceId}/uploads` | ローカル Capsule の `tar`(zstd) archive を binary body で ingest。R2_SOURCE に保存し upload origin SourceSnapshot を記録 |
| POST   | `/api/v1/deploy`                   | upload snapshot を pin して `@space/name` Installation を解決/作成し plan Run を起こす                            |

`POST /api/v1/spaces/{spaceId}/uploads` は JSON ではなく **archive バイト列**を request body に取ります (JSON-schema
OpenAPI inventory には載らない binary ingest)。Capsule path は optional query `?path=` で渡します (default `.`)。
archive は最大 64 MiB、空 body は `400 invalid_argument`、超過は `413` です。`writeSourceArchive` (R2_SOURCE) 未配線の
host は `501 not_implemented` を返します。

```txt
POST /api/v1/spaces/{spaceId}/uploads?path=deploy
Content-Type: application/octet-stream
<tar.zst archive bytes>

-> 201 { "snapshot": SourceSnapshot }   # origin: "upload", sourceId は不在
```

`POST /api/v1/deploy` は upload snapshot を pin して Installation を解決/作成し、plan Run を起こします。`vars` は
InstallConfig の variable mapping になります (string 値のみ; secret material は載りません — provider は Connection で
bind します)。`snapshotId` が upload origin でない、または別 Space の場合は `invalid_argument`。既存 Installation が
git Source に bind 済みの場合は `failed_precondition` で、その Source 経由のデプロイへ誘導します。

```json
POST /api/v1/deploy
{
  "spaceId": "space_...",
  "name": "my-app",
  "environment": "production",
  "snapshotId": "snap_...",
  "vars": { "region": "apac" },
  "planOnly": false,
  "autoApprove": false
}
```

```json
{
  "installation": { "id": "inst_...", "name": "my-app", "...": "..." },
  "installConfigId": "icfg_...",
  "run": { "id": "run_...", "type": "plan", "...": "..." },
  "created": true
}
```

`environment` は省略時 `"production"`。`created` は `deploy` が Installation を新規作成したときに `true`。新規作成時は
既定 InstallConfig (trust `space`、backend rewrite / provider lift / alias injection 許可、output allowlist 空) を
合成します。upload origin なので **Source 行は不要で `Installation.sourceId` は不在**であり、Capsule Gate / plan /
apply / DAG の downstream は origin 非依存に同じ pipeline を通ります。CLI は返った `run` を poll し、成功すると
OutputSnapshot を読みます。

### Capsule compatibility

この route family は public Capsule compatibility API route です。Compatibility Report は Takosumi の canonical core
concept であり、API 上では SourceSnapshot に対する Normalizer / Gate の結果を保存する report resource として扱います。
処理順序は `Capsule Normalizer が Compatibility Report draft を作る -> Capsule Gate が credential mint 前に評価する ->
Gate findings を含む Compatibility Report として finalize する` です。

| Method | Path                                          | 用途                                                                         |
| ------ | --------------------------------------------- | ---------------------------------------------------------------------------- |
| POST   | `/api/v1/sources/{sourceId}/compatibility-check` | SourceSnapshot を固定し、Normalizer / Gate を provider credential なしで実行 |
| GET    | `/api/v1/compatibility-reports/{reportId}`       | CapsuleCompatibilityReport を取得                                            |

### Dependencies

| Method | Path                                               | 用途                                                                                                                                                                                                                       |
| ------ | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/api/v1/installations/{installationId}/dependencies` | consumer をこの Installation とする Dependency edge 作成。mode は `variable_injection` / `remote_state` / `published_output`。`remote_state` は same-Space trusted dependency、cross-Space は OutputShare 経由。cycle 拒否 |
| GET    | `/api/v1/installations/{installationId}/dependencies` | Dependency 一覧 (asProducer / asConsumer view)                                                                                                                                                                             |
| DELETE | `/api/v1/dependencies/{dependencyId}`                 | Dependency edge 削除 (consumer の Space permission gate)                                                                                                                                                                   |

### Runs

| Method | Path                                               | 用途                                                                                             |
| ------ | -------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| POST   | `/api/v1/installations/{installationId}/plan`         | Installation-driven plan Run (最新 SourceSnapshot を解決し installation state scope で dispatch) |
| POST   | `/api/v1/installations/{installationId}/drift-check`  | read-only drift-check Run (apply できず `waiting_approval` にもならない)                         |
| POST   | `/api/v1/installations/{installationId}/destroy-plan` | destroy-plan Run (常に `waiting_approval` で着地)                                                |
| GET    | `/api/v1/runs/{runId}`                                | unified Run ledger projection                                                                    |
| GET    | `/api/v1/runs/{runId}/logs`                           | structured diagnostics + run-level audit trail (redacted)                                        |
| GET    | `/api/v1/runs/{runId}/events`                         | run-level audit-event trail                                                                      |
| POST   | `/api/v1/runs/{runId}/approve`                        | waiting-approval な Run (destroy / destructive change) を承認し apply gate を解除                |
| POST   | `/api/v1/runs/{runId}/cancel`                         | queued / waiting-approval な Run を cancel                                                       |

Run type は `source_sync` / `compatibility_check` / `plan` / `apply` / `destroy_plan` / `destroy_apply` /
`drift_check` / `backup` / `restore`。

### Run groups

| Method | Path                                   | 用途                                                                                       |
| ------ | -------------------------------------- | ------------------------------------------------------------------------------------------ |
| POST   | `/api/v1/spaces/{spaceId}/plan-update`    | `space_update` RunGroup を作成 (stale Installation + downstream を topo 順に re-plan)      |
| POST   | `/api/v1/spaces/{spaceId}/drift-check`    | `space_drift_check` RunGroup を作成 (active Installation ごとに read-only drift_check Run) |
| GET    | `/api/v1/run-groups/{runGroupId}`         | RunGroup + member Run + 計算済み status を取得                                             |
| POST   | `/api/v1/run-groups/{runGroupId}/approve` | waiting-approval な member Run を一括承認                                                  |

### Deployments

| Method | Path                                              | 用途                                                                                                 |
| ------ | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| GET    | `/api/v1/installations/{installationId}/deployments` | Installation の Deployment 一覧                                                                      |
| GET    | `/api/v1/deployments/{deploymentId}`                 | Deployment ledger record 取得                                                                        |
| POST   | `/api/v1/deployments/{deploymentId}/rollback-plan`   | その Deployment の source snapshot に pin した rollback plan Run (通常の approval/apply flow に乗る) |

### Output shares

| Method | Path                                   | 用途                                                                                    |
| ------ | -------------------------------------- | --------------------------------------------------------------------------------------- |
| POST   | `/api/v1/output-shares`                   | cross-Space OutputShare を `pending` で作成 (granting `fromSpaceId` の permission gate) |
| GET    | `/api/v1/output-shares?spaceId=`          | その Space が granted / received した OutputShare 一覧                                  |
| POST   | `/api/v1/output-shares/{shareId}/approve` | receiving Space 側の acceptance flow                                                    |
| POST   | `/api/v1/output-shares/{shareId}/revoke`  | OutputShare revoke (granting `fromSpaceId` の permission gate)                          |

Sensitive output entry (`outputs[].sensitive: true`) は `sensitivePolicy.allow === true` と non-empty `reason` を要求し、
host-injected resolver が encrypted raw output artifact の sensitive flag を再確認した場合だけ作成できる。OutputShare
response / Activity は output name・alias・sensitive flag のみを返し、値は返さない。

### Activity

Activity は Space-scoped audit projection です。raw audit payload や secret literal は返さず、dashboard が表示できる
public-safe event stream だけを newest-first で返します。

| Method | Path                             | 用途                                        |
| ------ | -------------------------------- | ------------------------------------------- |
| GET    | `/api/v1/spaces/{spaceId}/activity` | Space の Activity event 一覧 (`limit` 対応) |

### Billing

Billing は Space 単位の公開 surface です。実装適合状況は [`core-conformance.md`](../core-conformance.md) に集約します。
`GET /api/v1/spaces/{spaceId}/billing` の plan projection は typed `BillingPlanLimits` を含み、plan completion は active subscription の
`maxEstimatedCreditsPerRun` / `quota` を評価します。`enforce` では超過 run を reservation 前に block し、`showback` では audit
に記録して続行します。

| Method | Path                                        | 用途                                                  |
| ------ | ------------------------------------------- | ----------------------------------------------------- |
| GET    | `/api/v1/spaces/{spaceId}/billing`             | Space billing mode / plan / credit balance projection |
| GET    | `/api/v1/spaces/{spaceId}/credit-reservations` | Space credit reservations                             |
| POST   | `/api/v1/spaces/{spaceId}/credits/top-up`      | hosted/operator billing adapter 経由の credit top-up  |
| GET    | `/api/v1/spaces/{spaceId}/usage`               | Space usage events                                    |
| POST   | `/api/v1/spaces/{spaceId}/subscription/change` | hosted/operator billing adapter 経由の plan 変更      |

### Backups

Backup は Space ledger の control backup と、Installation が opt-in した service-data backup bundle を扱う公開 surface です。

| Method | Path                                          | 用途                                                          |
| ------ | --------------------------------------------- | ------------------------------------------------------------- |
| POST   | `/api/v1/installations/{installationId}/backups` | Installation を解決し、その owning Space の backup を作成する |
| POST   | `/api/v1/spaces/{spaceId}/backups`               | Space の backup を作成する                                    |
| GET    | `/api/v1/spaces/{spaceId}/backups`               | Space の backup ledger pointer を newest-first で列挙する     |

### Implementation extensions

次の route は implementation extension です。外部 integration は依存しないでください。

| Method | Path                      | 扱い                                                |
| ------ | ------------------------- | --------------------------------------------------- |
| PATCH  | `/api/v1/sources/{sourceId}` | Source metadata 更新の operator/dashboard extension |

## 501 surfaces

MVP の公開 route は optional service / helper driver が未配線の場合、認証後に `501 not_implemented` を返すことがあります。

- OutputShare routes: `outputSharesService` が未配線の場合のみ 501
- Activity route: `activityService` が未配線の場合のみ 501
- Backup routes: `backupsService` / R2_BACKUPS artifact store が未配線の場合のみ 501。正本 layout は
  `control.json.zst.enc` / `state.tar.zst.enc` / `artifacts.manifest.json` / `service-data.tar.zst.enc` です。
- Cloudflare OAuth / GCP OAuth helper routes: helper driver 未配線の場合のみ 501。helper は
  `provider_env_set` Connection を作る補助であり、第3の credential source ではありません。
  `service-data.tar.zst.enc` は isolated Runner Container の `backup` action、provider snapshot adapter、または
  `BackupConfig.outputPath` の projected export artifact から作ります。`custom_command` は restored SourceSnapshot 内で
  credential-free に実行されます。`provider_snapshot` は Runner Container の provider-scoped adapter command
  (`TAKOSUMI_PROVIDER_SNAPSHOT_COMMAND_<SAFE_PROVIDER>`) を generic command より優先します。control backup path 自体は
  provider data 取得や任意 command 実行をしません。

AWS assume-role route は Connection 登録 surface です。STS による短期 credential vending の実装適合状況は
[`core-conformance.md`](../core-conformance.md) に集約します。

## Error envelope

全 error は同じ封筒で返ります。`requestId` は `x-request-id` / `x-correlation-id` (UUID / ULID 形) を引き継ぎ、なければ
新規発行します。

```json
{
  "error": {
    "code": "failed_precondition",
    "message": "expected.planDigest does not match plan run",
    "requestId": "req_...",
    "details": {}
  }
}
```

| Code                  | HTTP | 意味                                               |
| --------------------- | ---- | -------------------------------------------------- |
| `invalid_argument`    | 400  | body / param / query 形が不正 (unknown_field 含む) |
| `unauthenticated`     | 401  | bearer 欠落 / 不一致                               |
| `permission_denied`   | 403  | scope 外 (default deny)                            |
| `not_found`           | 404  | record 不在、または surface 無効                   |
| `failed_precondition` | 409  | guard / generation mismatch                        |
| `resource_exhausted`  | 413  | body が 1 MiB limit 超過                           |
| `not_implemented`     | 501  | 上記 501 surface                                   |
| `internal_error`      | 500  | 未分類 server error                                |

## External install link (client-handled)

外部サイトは Git URL を渡して install flow に deep-link できます。server 側の特別処理はなく
（`/install` はただの SPA パス）、dashboard client が query を parse して `/new` の Git フォームを
pre-fill します。link は **pre-fill のみ** — 出所がサマリで明示され、互換性チェック（中身を確認）と
明示的な追加操作を必ず挟みます。

```txt
GET /install?source=git::https://git.example.com/takos/talk.git//deploy?ref=main
GET /install?git=https://git.example.com/takos/talk.git&ref=main&path=deploy
```

client parser は `https://` のみを受け付け、credential 埋め込みを拒否します。実効的な Source URL
policy（private/loopback/metadata host 拒否など）は Source 登録 / compatibility check の server 境界で
強制されます。
