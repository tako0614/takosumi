# Control Plane API

Takosumi の control plane は OpenTofu Capsule DAG を Space 直下で管理する HTTP API です。正本は
[`docs/core-spec.md`](../core-spec.md) で、公開 surface と外部 install link は同 spec、error code は
contract (`takosumi-contract/deploy-control-api`) が所有します。本ドキュメントが spec と矛盾した場合は spec が勝ちます。

公開語彙は **Space / Source / Connection / OpenTofu Capsule / Installation (+InstallConfig) / Dependency / Run /
RunGroup / Deployment / OutputSnapshot / Billing / Activity** です。runner substrate / image / limits は内部
execution profile として Connection + CapabilityBinding + policy 層の下に従属します。

## Surface と認証モデル

公開される control-plane surface は `/api/*` と `/install` です。dashboard が使う account session route と
accounts/CLI 向けの in-process seam は operator distribution の内部経路であり、本 API surface ではありません。

| Surface    | 用途                     | 認証                                                    |
| ---------- | ------------------------ | ------------------------------------------------------- |
| `/api/*`   | 公開 control plane       | operator bearer token (`Authorization: Bearer <token>`) |
| `/install` | public install deep link | bearer 不要。dashboard の session gate へ渡す           |

### `/api` operator bearer

`/api` の各 route は bearer token で保護されます。reference fallback では token は `TAKOSUMI_DEPLOY_CONTROL_TOKEN` から
供給され、token も bearer resolver も未設定の host は `/api` route を `404 not_found` で隠します (未設定 surface を
public host で漏らさない)。

operator / account-plane は bearer resolver を差し替えて、`actor` / `spaceIds` / `operations` を
持つ scoped principal を返せます。scope は **default deny** で、resolver が省略した scope は許可になりません:

- read は対象 record の `spaceId` で許可されます。
- mutation は `operations` (`create` / `update` / `destroy` …) で許可されます。
- Space 作成・operator-scope Connection・operator connection defaults は instance-wide なので、無制限 bearer
  (`spaceIds: "*"`) だけが触れます。
- `GET /api/connections` を `spaceId` なしで呼ぶと operator-scope Connection 一覧になり、これも無制限 bearer 専用です。

scope 外の request は `403 permission_denied` になり、API 起点の audit event に `actor` が記録されます。default の
fallback bearer は `spaceIds`/`operations` が `"*"` の principal です。

### 内部 session / CLI 経路

dashboard や operator CLI が `/api/*` を直接使わない distribution では、account session や in-process fetch seam が
public operations に委譲します。これらは hosted/self-host distribution の実装詳細であり、外部統合・Capsule author・public
API reader が依存する contract は `/api/*` と `/install` だけです。

## `/api` surface

version prefix は付けず `/api` にまとめます。全 route は operator bearer 認証です。

### Spaces

| Method | Path                    | 用途                                                         |
| ------ | ----------------------- | ------------------------------------------------------------ |
| POST   | `/api/spaces`           | Space 作成 (`@handle` owner namespace)。無制限 bearer 専用。 |
| GET    | `/api/spaces`           | principal が見える Space 一覧                                |
| GET    | `/api/spaces/{spaceId}` | Space 取得                                                   |
| PATCH  | `/api/spaces/{spaceId}` | Space 更新 (MVP: `displayName` のみ)                         |

### Sources

| Method | Path                                | 用途                                                                                               |
| ------ | ----------------------------------- | -------------------------------------------------------------------------------------------------- |
| POST   | `/api/sources`                      | git Source 登録 (URL policy 検証、ls-remote は queued `source_sync`)。hook secret を一度だけ返す。 |
| GET    | `/api/sources`                      | principal が見える Source 一覧 (hook secret は含まない)                                            |
| GET    | `/api/sources/{sourceId}`           | Source 取得                                                                                        |
| POST   | `/api/sources/{sourceId}/sync`      | default ref を archive snapshot に解決する `source_sync` Run を作成                                |

`POST /hooks/sources/{sourceId}` は forge webhook の inbound seam で、bearer ではなく hook secret 認証です。

### Connections

connection 作成は kind / provider / authMethod を固定した薄い subroute です。credential `values` は write-only で、
log にも response にも出ません。

| Method | Path                                     | 用途                                                                                                         |
| ------ | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| POST   | `/api/connections/source/https-token`    | git source HTTPS-token Connection (optional username)                                                        |
| POST   | `/api/connections/source/ssh-key`        | git source SSH-key Connection (`scopeHints.knownHostsEntry` 必須)                                            |
| POST   | `/api/connections/cloudflare/token`      | Cloudflare API-token Connection (optional account/zone scope)                                                |
| POST   | `/api/connections/aws/assume-role`       | AWS assume-role-capable Connection (`scopeHints.awsRoleArn` 必須、AWS env `values` は write-only)            |
| GET    | `/api/connections`                       | principal が見える Connection 一覧。secret 値は含まない。                                                  |
| POST   | `/api/connections/{connectionId}/test`   | 保存済み credential を provider で検証                                                                       |
| POST   | `/api/connections/{connectionId}/revoke` | Connection を revoke し sealed secret blob を削除                                                            |

Operator default connections は instance-wide な管理機能です。実装が route を持つ場合も、公開 Capsule install
surface ではなく operator-only implementation extension として扱い、Space / Installation の正本 API からは
CapabilityBinding の `mode: "default"` として見えます。

### Installations + InstallConfigs

| Method | Path                                  | 用途                                                                                                       |
| ------ | ------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| POST   | `/api/spaces/{spaceId}/installations` | Space 直下に Installation 作成 (Source + InstallConfig から。environment は実行 namespace の一部)          |
| GET    | `/api/spaces/{spaceId}/installations` | Space の Installation 一覧                                                                                 |
| GET    | `/api/installations/{installationId}` | Installation 取得                                                                                          |
| PATCH  | `/api/installations/{installationId}` | Installation の安全な status patch (`active` / `stale` / `error` のみ。destroy state は destroy flow 専用) |
| DELETE | `/api/installations/{installationId}` | 直接削除せず destroy-plan Run を作成し、approval + destroy_apply flow に乗せる                             |

### Capsule compatibility

この route family は Capsule compatibility の公開 surface です。Compatibility Report は SourceSnapshot に対する
Normalizer / Gate の結果を保存します。

| Method | Path                                          | 用途                                                                         |
| ------ | --------------------------------------------- | ---------------------------------------------------------------------------- |
| POST   | `/api/sources/{sourceId}/compatibility-check` | SourceSnapshot を固定し、Normalizer / Gate を provider credential なしで実行 |
| GET    | `/api/compatibility-reports/{reportId}`       | CapsuleCompatibilityReport を取得                                            |

### Dependencies

| Method | Path                                               | 用途                                                                                                     |
| ------ | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| POST   | `/api/installations/{installationId}/dependencies` | consumer をこの Installation とする Dependency edge 作成 (same-Space / `variable_injection`、cycle 拒否) |
| GET    | `/api/installations/{installationId}/dependencies` | Dependency 一覧 (asProducer / asConsumer view)                                                           |
| DELETE | `/api/dependencies/{dependencyId}`                 | Dependency edge 削除 (consumer の Space permission gate)                                                 |

### Runs

| Method | Path                                               | 用途                                                                                             |
| ------ | -------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| POST   | `/api/installations/{installationId}/plan`         | Installation-driven plan Run (最新 SourceSnapshot を解決し installation state scope で dispatch) |
| POST   | `/api/installations/{installationId}/destroy-plan` | destroy-plan Run (常に `waiting_approval` で着地)                                                |
| GET    | `/api/runs/{runId}`                                | unified Run projection (source_sync / plan / apply ledger 横断)                                  |
| GET    | `/api/runs/{runId}/logs`                           | structured diagnostics + run-level audit trail (redacted)                                        |
| GET    | `/api/runs/{runId}/events`                         | run-level audit-event trail                                                                      |
| POST   | `/api/runs/{runId}/approve`                        | waiting-approval な Run (destroy / destructive change) を承認し apply gate を解除                |
| POST   | `/api/runs/{runId}/cancel`                         | queued / waiting-approval な Run を cancel                                                       |

Run type は `source_sync` / `compatibility_check` / `plan` / `apply` / `destroy_plan` / `destroy_apply` /
`drift_check` / `backup` / `restore`。

### Run groups

| Method | Path                                   | 用途                                                                                  |
| ------ | -------------------------------------- | ------------------------------------------------------------------------------------- |
| POST   | `/api/spaces/{spaceId}/plan-update`    | `space_update` RunGroup を作成 (stale Installation + downstream を topo 順に re-plan) |
| GET    | `/api/run-groups/{runGroupId}`         | RunGroup + member Run + 計算済み status を取得                                        |
| POST   | `/api/run-groups/{runGroupId}/approve` | waiting-approval な member Run を一括承認                                             |

### Deployments

| Method | Path                                              | 用途                                                                                                 |
| ------ | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| GET    | `/api/installations/{installationId}/deployments` | Installation の Deployment 一覧                                                                      |
| GET    | `/api/deployments/{deploymentId}`                 | Deployment ledger record 取得                                                                        |
| POST   | `/api/deployments/{deploymentId}/rollback-plan`   | その Deployment の source snapshot に pin した rollback plan Run (通常の approval/apply flow に乗る) |

### Output shares

| Method | Path                                   | 用途                                                                                    |
| ------ | -------------------------------------- | --------------------------------------------------------------------------------------- |
| POST   | `/api/output-shares`                   | cross-Space OutputShare を `pending` で作成 (granting `fromSpaceId` の permission gate) |
| GET    | `/api/output-shares?spaceId=`          | その Space が granted / received した OutputShare 一覧                                  |
| POST   | `/api/output-shares/{shareId}/revoke`  | OutputShare revoke (granting `fromSpaceId` の permission gate)                          |

Sensitive output entry (`outputs[].sensitive: true`) は `sensitivePolicy.allow === true` と non-empty `reason` を要求し、
host-injected resolver が encrypted raw output artifact の sensitive flag を再確認した場合だけ作成できる。OutputShare
response / Activity は output name・alias・sensitive flag のみを返し、値は返さない。

Hosted/operator distribution が `POST /api/output-shares/{shareId}/approve` を実装する場合は、receiving Space 側の
acceptance flow 用 extension です。正本 route 一覧では、OutputShare の公開操作は create / list / revoke に閉じます。

### Billing

Billing は Space 単位の公開 surface です。実装適合状況は [`core-conformance.md`](../core-conformance.md) に集約します。

| Method | Path                                            | 用途                                                  |
| ------ | ----------------------------------------------- | ----------------------------------------------------- |
| GET    | `/api/spaces/{spaceId}/billing`                 | Space billing mode / plan / credit balance projection |
| POST   | `/api/spaces/{spaceId}/credits/top-up`          | hosted/operator billing adapter 経由の credit top-up  |
| GET    | `/api/spaces/{spaceId}/usage`                   | Space usage events                                    |
| POST   | `/api/spaces/{spaceId}/subscription/change` | hosted/operator billing adapter 経由の plan 変更  |

### Implementation extensions

次の route は実装が持てますが、貼られた正本 API 一覧には含めません。外部 integration は依存しないでください。

| Method | Path                                    | 扱い                                                  |
| ------ | --------------------------------------- | ----------------------------------------------------- |
| PATCH  | `/api/sources/{sourceId}`               | Source metadata 更新の operator/dashboard extension   |
| GET    | `/api/sources/{sourceId}/snapshots`     | SourceSnapshot debug/list extension                   |
| GET    | `/api/install-configs?spaceId=`         | catalog/admin extension。install flow の内部入力      |
| GET    | `/api/spaces/{spaceId}/activity?limit=` | Activity projection extension。値と secret は返さない |
| GET/PUT | `/api/operator-connection-defaults`      | operator-only defaults management extension           |

## 501 surfaces

MVP の実装済み公開 route に恒久的な `501 not_implemented` は残していません。host が optional service を配線しない場合だけ、認証後に
`501 not_implemented` を返します。

- OutputShare routes: `outputSharesService` が未配線の場合のみ 501
- Backup routes: `backupsService` / R2_BACKUPS artifact store が未配線の場合のみ 501。control backup は
  `control.json.gz.enc`、service-data MVP は `BackupConfig.mode = artifact_export` の projected output pointer を
  `service-data-artifacts.json.gz.enc` manifest として保存します。`provider_snapshot` / `custom_command` は manifest 上で
  `unsupported` として記録されます。

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

## External install link

外部サイトは Git URL を渡して install flow に deep-link します。link は platform worker (accounts handler) が parse +
URL policy 検証し、dashboard の Install OpenTofu Capsule flow へ 302 します (bearer 不要、session gate は dashboard 側)。

```txt
GET /install?source=git::https://git.example.com/takos/talk.git//deploy?ref=main
GET /install?git=https://git.example.com/takos/talk.git&ref=main&path=deploy
```

`source=` は Terraform/OpenTofu module address 形 (`git::https://...//path?ref=`)、簡易形は `git` / `ref` / `path` の
個別 query です。public `/install` deep link は `https://` Git URL のみを受け付け、credential 埋め込み禁止、
literal private / loopback / metadata IP host は拒否されます。Source 登録 API は Git Source として `https://` /
`ssh://` / scp-like `git@host:path/repo.git` を扱えますが、external install link では browser-safe な HTTPS に限定します。
