# Kernel HTTP API

> Stability: stable
> Audience: operator, integrator, kernel-implementer
> See also: [Runtime-Agent API](/reference/runtime-agent-api), [Closed Enums](/reference/closed-enums), [Approval Invalidation](/reference/approval-invalidation), [Lifecycle Protocol](/reference/lifecycle), [WAL Stages](/reference/wal-stages)

Takosumi kernel HTTP surface の v1 reference です。本ページは kernel が公開する
3 つの surface — public deploy CLI surface, internal control plane, runtime-agent
control RPC — について authentication / endpoints / request schema / response
schema / status codes / error envelope を一貫した形で定義します。

実装は [`packages/kernel/src/api/`](https://github.com/tako0614/takosumi/tree/master/packages/kernel/src/api)
の Hono router 群 (`public_routes.ts` / `internal_routes.ts` /
`runtime_agent_routes.ts` / `artifact_routes.ts` / `readiness_routes.ts`) に
分割されており、`takosumi-{api,worker,router,runtime-agent,log-worker}` role
ごとに mount される route 集合が決まります。本ページは `takosumi-api` role で
全 surface を mount した状態を前提とします。

## Overview

| Surface             | Path prefix                       | 想定 caller                                  |
| ------------------- | --------------------------------- | -------------------------------------------- |
| Public deploy CLI   | `/v1/deployments`, `/v1/artifacts`| Operator が握る `takosumi deploy --remote`   |
| Internal control    | `/api/internal/v1/*`              | Operator が運営する CLI / dashboard / agent  |
| Runtime-Agent RPC   | `/api/internal/v1/runtime/agents/*` | Operator-installed runtime-agent process |
| Discovery / probe   | `/health`, `/livez`, `/readyz`, `/openapi.json`, `/capabilities` | Operator orchestrator |

すべての endpoint は kernel の base URL (例: `https://kernel.example.com`) に
対する相対 path です。kernel は credential を **保持せず**、operator が起動時
に env 経由で inject します。

## Authentication

kernel は v1 で 3 種類の credential を区別し、credential ごとに作用範囲を
完全に分離します。

| Credential                | Env var                                                               | 適用範囲                                                  | 認証方式                                |
| ------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------- | --------------------------------------- |
| Public deploy bearer      | `TAKOSUMI_DEPLOY_TOKEN`                                               | `/v1/deployments/*`、`/v1/artifacts/*` の write 系        | `Authorization: Bearer <token>`         |
| Artifact read-only bearer | `TAKOSUMI_ARTIFACT_FETCH_TOKEN`                                       | `GET /v1/artifacts/:hash`、`HEAD /v1/artifacts/:hash`     | `Authorization: Bearer <token>`         |
| Internal HMAC secret      | `TAKOSUMI_INTERNAL_API_SECRET`                                        | `/api/internal/v1/*` 全体 (runtime-agent endpoint も含む) | HMAC-SHA256 + replay protection         |

規則:

- `TAKOSUMI_DEPLOY_TOKEN` が unset の間、public deploy / artifact write route
  は **404** を返します。これは「token を設定し忘れた operator が 401 で原因
  を隠蔽されない」ことを担保するため、敢えて 404 にしています。
- Artifact read-only bearer は runtime-agent host 側に配布する scope-narrow
  token です。`TAKOSUMI_DEPLOY_TOKEN` と分離して配ることで、agent host が
  compromise されても apply / destroy / upload 権限は残らない設計です。
- Internal HMAC は `method` / `path` / `query` / `body digest` / `actor` を
  canonical 化して署名し、`x-takosumi-internal-signature` /
  `x-takosumi-internal-timestamp` / `x-takosumi-request-id` で検証します。
  timestamp skew は 5 分、request id は replay protection store で TTL 5 分
  の冪等保護下にあります。Rationale: NTP 同期下では実用上 60 秒以内に収まる
  が、5 分は network jitter / pod restart / clock step skew を許容しつつ
  replay attack window を狭く保つ閾値。短いと正常 traffic の rejection を
  招き、長いと captured request の replay 余地が広がる。
- `/health` / `/livez` / `/readyz` / `/capabilities` / `/openapi.json` の
  discovery 系は無認証です。

## Public deploy routes

CLI (`takosumi deploy --remote`) が叩く v1 surface です。すべて
`Authorization: Bearer $TAKOSUMI_DEPLOY_TOKEN` を要求します。

| Method | Path                          | Purpose                                                                |
| ------ | ----------------------------- | ---------------------------------------------------------------------- |
| POST   | `/v1/deployments`             | manifest を resolve し、`apply / plan / destroy` のいずれかを駆動      |
| GET    | `/v1/deployments`             | 直近の applied / failed / destroyed record を列挙                      |
| GET    | `/v1/deployments/:name`       | 指定 deployment の summary を取得                                       |
| POST   | `/v1/artifacts`               | multipart upload で artifact bytes を kernel object storage に登録      |
| GET    | `/v1/artifacts`               | 登録済み artifact を cursor pagination で列挙                          |
| GET    | `/v1/artifacts/kinds`         | 登録された artifact kind 一覧                                          |
| HEAD   | `/v1/artifacts/:hash`         | artifact の size / kind / uploadedAt を header で取得                   |
| GET    | `/v1/artifacts/:hash`         | artifact bytes をストリーム取得                                        |
| DELETE | `/v1/artifacts/:hash`         | artifact を object storage から削除                                    |
| POST   | `/v1/artifacts/gc`            | mark+sweep GC を駆動 (`?dryRun=1` で plan のみ)                         |

`hash` は `sha256:<hex>` 形式。kernel は upload 時と fetch 時の両方で再計算
し改ざんを検出します。

### `POST /v1/deployments`

Request body:

```ts
interface DeployPublicRequest {
  readonly mode?: "apply" | "plan" | "destroy"; // default: "apply"
  readonly manifest: ManifestBody;
  readonly force?: boolean; // destroy 時のみ意味を持つ
}
```

`manifest` は v1 公開 manifest 語彙 (`schemaVersion` / `profile` /
`components[]` / `target` / `with` / `source` / `artifact` / `uses` / `use` /
`access` / `expose` / `from` / `host` / `path` / `protocol` / `port` /
`methods`) を満たす shape を期待します。

Response (mode=`apply` / `plan`):

```ts
interface DeployPublicResponse {
  readonly status: "ok";
  readonly outcome: ApplyOutcome;
}

interface ApplyOutcome {
  readonly applied: readonly AppliedResource[];
  readonly issues: readonly ManifestIssue[];
  readonly status: "succeeded" | "failed-validation" | "failed-apply" | "partial";
  readonly reused?: number;
}
```

Response (mode=`destroy`):

```ts
interface DestroyOutcome {
  readonly destroyed: readonly DestroyedResource[];
  readonly errors: readonly { readonly resource: string; readonly message: string }[];
  readonly status: "succeeded" | "partial" | "failed";
}
```

Status codes:

| Status | Code (envelope)         | 主な発生要因                                          |
| ------ | ----------------------- | ----------------------------------------------------- |
| 200    | (success)               | apply / plan / destroy 完了 (partial 含む)            |
| 400    | `invalid_argument`      | manifest schema / digest mismatch                     |
| 401    | `unauthenticated`       | bearer 不足                                           |
| 403    | `permission_denied`     | space / entitlement 越境                              |
| 404    | `not_found`             | deploy token 未設定、deployment 不在                  |
| 409    | `failed_precondition`   | destroy 対象の prior record が無い、conflict          |
| 503    | `readiness_probe_failed`| dependent ports が ready でない                       |

### `GET /v1/deployments`

`takosumi status` (引数なし) の backing endpoint。actor が見える Space
配下の deployment を一覧で返します。`Authorization: Bearer
$TAKOSUMI_DEPLOY_TOKEN` を要求し、token 未設定なら 404
`not_found` を返します。

Query string:

| Name      | Type   | Notes                                                          |
| --------- | ------ | -------------------------------------------------------------- |
| `cursor`  | string | opaque pagination cursor (status output と共通)                 |
| `limit`   | number | 1..200, default 50                                              |
| `kind`    | enum   | `deployments` / `activations` / `approvals` / `debts` のいずれか |
| `since`   | string | RFC3339 UTC                                                     |
| `space`   | string | operator 権限で `*` を指定すると全 Space を跨ぐ                  |

Response body は [Status Output](/reference/status-output) の
`StatusOutput` document をそのまま返します。`deployments[]` 配下の
record shape も同 reference の `DeploymentStatus` に固定されます。

### `GET /v1/deployments/:name`

`takosumi status <name>` の backing endpoint。`name` は manifest の
`metadata.name` に対応し、auth context で resolve された Space に
紐づく単一 deployment を返します。

Response body は同じく [Status Output](/reference/status-output) の
`StatusOutput` shape ですが、`deployments[]` は対象 1 件のみ、
`activations[]` / `pendingApprovals[]` は当該 deployment に紐づく
subset に絞られます。`name` が当該 Space に存在しない場合は 404
`not_found`、token 未設定の場合も同じく 404 `not_found` を返します。

### `POST /v1/artifacts`

`multipart/form-data` で `kind` / `body` / `metadata` (optional JSON string) /
`expectedDigest` (optional `sha256:<hex>`) を送信します。

```bash
curl -sS https://kernel.example.com/v1/artifacts \
  -H "Authorization: Bearer $TAKOSUMI_DEPLOY_TOKEN" \
  -F "kind=js-bundle" \
  -F "metadata={\"entrypoint\":\"index.js\"}" \
  -F "body=@./dist/worker.js"
```

```ts
interface ArtifactStored {
  readonly hash: string;       // sha256:<hex>
  readonly kind: string;
  readonly size: number;
  readonly uploadedAt: string; // RFC 3339
  readonly metadata?: JsonObject;
}
```

`expectedDigest` を付けた upload で computed hash と一致しない場合は 400
`invalid_argument`、本体サイズが `TAKOSUMI_ARTIFACT_MAX_BYTES` を超えると
413 `resource_exhausted` を返します。

### `POST /v1/artifacts/gc`

mark+sweep GC。`?dryRun=1` で `{ planned: ArtifactStored[] }` を返し、無印で
`{ deleted: ArtifactStored[] }` を返します。

## Internal control plane routes

`/api/internal/v1/*` は operator-only の control plane surface です。CLI (
`takosumi space` 等) と operator が運用する dashboard が caller。Public 経由
での expose は **しません**。

| Method | Path                                                | Purpose                                            |
| ------ | --------------------------------------------------- | -------------------------------------------------- |
| GET    | `/api/internal/v1/spaces`                           | actor の Space 一覧                                |
| POST   | `/api/internal/v1/spaces`                           | Space 作成                                         |
| GET    | `/api/internal/v1/spaces/:spaceId`                  | Space metadata 取得                                |
| GET    | `/api/internal/v1/spaces/:spaceId/snapshots/desired`| 指定 Space の DesiredSnapshot                      |
| GET    | `/api/internal/v1/spaces/:spaceId/snapshots/resolution` | ResolutionSnapshot                            |
| POST   | `/api/internal/v1/operation-plans`                  | DesiredSnapshot から OperationPlan を resolve      |
| POST   | `/api/internal/v1/operation-plans/:planId/apply`    | OperationPlan を apply (WAL を駆動)                 |
| GET    | `/api/internal/v1/operation-plans/:planId/journal`  | WriteAheadOperationJournal entry 列挙              |
| GET    | `/api/internal/v1/approvals`                        | 未消化 approval 列挙                               |
| POST   | `/api/internal/v1/approvals/:approvalId/decide`     | approve / reject                                   |
| GET    | `/api/internal/v1/revoke-debts`                     | RevokeDebt 列挙 (status filter 可)                  |

すべて internal HMAC 署名が要件で、`permission_denied` の場合は 403、
署名検証失敗時は 401 `unauthenticated` を返します。Approval 決定や Space
コンテキスト変更が起きた瞬間、対象 OperationPlan の approval は
[Approval Invalidation Triggers](/reference/approval-invalidation) のうち
該当するものに従って失効します。

### Tenant management

Space provisioning / mutation / deletion / data export 系。すべて
`TAKOSUMI_INTERNAL_API_SECRET` による internal HMAC 必須で、operator が
運営する CLI または control dashboard 経由でのみ叩けます。

| Method | Path                                                  | Purpose                                                              |
| ------ | ----------------------------------------------------- | -------------------------------------------------------------------- |
| POST   | `/api/internal/v1/spaces`                             | 新規 Space を provision (`Idempotency-Key` header 必須)              |
| PATCH  | `/api/internal/v1/spaces/:id`                         | quota tier / cost attribution metadata を更新                        |
| DELETE | `/api/internal/v1/spaces/:id`                         | soft-delete (`confirmCode` + `retentionRegime` 必須)                  |
| POST   | `/api/internal/v1/spaces/:id/exports`                 | データ export request を起票                                          |
| GET    | `/api/internal/v1/spaces/:id/exports/:exportId`       | export job の進捗 status を polling                                   |
| POST   | `/api/internal/v1/spaces/:id/trial/extend`            | trial 期限を延長                                                      |

`POST /api/internal/v1/spaces` request body (抜粋):

```yaml
displayName: string
ownerActorId: string
quotaTierId: string?         # default tier when omitted
zone: string?                # TAKOSUMI_ZONE_DEFAULT fallback
costAttribution:
  billingAccountId: string?
  labels: { [key: string]: string }
trial: boolean?              # default: true when tier is trial-eligible
```

Response: `{ space: SpaceMetadata, idempotent: boolean }`. Same
`Idempotency-Key` で同一 body は 200 + `idempotent: true`、異 body は
409 `failed_precondition`。

`PATCH /api/internal/v1/spaces/:id` request body:

```yaml
quotaTierId: string?
costAttribution: { billingAccountId: string?, labels: object? }?
displayName: string?
```

Response: `{ space: SpaceMetadata }`.

`DELETE /api/internal/v1/spaces/:id` request body:

```yaml
confirmCode: string          # short-lived, server-issued, TTL = TAKOSUMI_SPACE_DELETE_CONFIRM_TTL_SECONDS
retentionRegime: enum        # default | pci-dss | hipaa | sox | regulated
reason: string?
```

Response: `{ space: SpaceMetadata, scheduledPurgeAt: string }`. Soft
delete は `TAKOSUMI_SPACE_SOFT_DELETE_RETENTION_DAYS` の retention
window 経過後に物理削除へ進みます。

`POST /api/internal/v1/spaces/:id/exports` request body:

```yaml
scope: enum                  # full | audit-only | manifest-only
format: enum                 # ndjson | tar.zst
notify: boolean?
```

Response:
`{ exportId: string, status: "queued" | "running" | "ready" | "failed", downloadUrl: string?, downloadUrlExpiresAt: string? }`.
`downloadUrl` の TTL は `TAKOSUMI_EXPORT_DOWNLOAD_URL_TTL_SECONDS`。
同 Space で同時起票できる export 数は
`TAKOSUMI_EXPORT_MAX_CONCURRENT_PER_SPACE` で制限されます。

`GET /api/internal/v1/spaces/:id/exports/:exportId` response: 同 shape。

`POST /api/internal/v1/spaces/:id/trial/extend` request body:

```yaml
extendBySeconds: integer
reason: string
```

Response: `{ space: SpaceMetadata, trialExpiresAt: string }`. trial
状態でない Space に対して呼ぶと 409 `failed_precondition`。

Error codes (横断):

| Code                   | 主な発生要因                                                              |
| ---------------------- | ------------------------------------------------------------------------- |
| `invalid_argument`     | body schema 不整合、`Idempotency-Key` 欠落、`confirmCode` 形式不正        |
| `failed_precondition`  | idempotency key 衝突、trial 非該当、export 同時実行上限超過、quota tier 不在 |
| `not_found`            | `:id` / `:exportId` が当該 actor の scope に無い                          |
| `permission_denied`    | actor が tenant admin policy を満たしていない                             |
| `resource_exhausted`   | quota tier の Space 上限超過                                              |

関連 reference: [Tenant Provisioning](/reference/tenant-provisioning),
[Tenant Export & Deletion](/reference/tenant-export-deletion),
[Trial Spaces](/reference/trial-spaces),
[Space Export Share](/reference/space-export-share).

### Identity and Access

API key の operator-issue / actor self-service と auth provider の operator
管理。Self-service route は `/v1/api-keys/...` で actor token (= API key
itself, `act:` scope) を要求し、operator route は `/api/internal/v1/...`
で internal HMAC を要求します。

| Method | Path                                       | Auth scope                  | Purpose                                                   |
| ------ | ------------------------------------------ | --------------------------- | --------------------------------------------------------- |
| POST   | `/api/internal/v1/api-keys`                | internal HMAC (operator)    | actor / Space を指定して API key を operator-issue        |
| POST   | `/v1/api-keys`                             | actor self-service (RBAC)   | actor が自身の scope 内で新規 API key を発行              |
| POST   | `/v1/api-keys/:id/rotate`                  | actor self-service (RBAC)   | 自分が発行した key を rotate (旧 secret は overlap 期間中 のみ valid) |
| DELETE | `/v1/api-keys/:id`                         | actor self-service (RBAC)   | 自分の key を即時 revoke                                  |
| POST   | `/api/internal/v1/auth-providers`          | internal HMAC (operator)    | auth provider 設定を register / update                    |

API key 自体は argon2id でハッシュされ、parameter は
`TAKOSUMI_API_KEY_ARGON2_MEMORY_KIB` /
`TAKOSUMI_API_KEY_ARGON2_ITERATIONS` で operator-tunable。Self-service
caller の RBAC は scope (`actor:read`, `apikey:write` 等) が満たない場合に
403 `permission_denied`。

`POST /v1/api-keys` request body:

```yaml
displayName: string
scopes: string[]
expiresAt: string?           # RFC3339, optional
```

Response: `{ apiKey: { id, displayName, scopes, expiresAt? }, secret: string }`.
`secret` は **発行直後の 1 回限り**で返します。

`POST /v1/api-keys/:id/rotate` response:
`{ apiKey: ApiKeyMetadata, secret: string, previousSecretValidUntil: string }`.

`POST /api/internal/v1/auth-providers` request body:

```yaml
providerId: string           # see auth-providers reference for closed enum
config: object               # provider-specific
```

Error codes: `invalid_argument` / `permission_denied` /
`failed_precondition` (provider config conflict) / `not_found` (rotate /
delete on missing key).

関連 reference: [API Key Management](/reference/api-key-management),
[Auth Providers](/reference/auth-providers),
[RBAC Policy](/reference/rbac-policy).

### PaaS operations

Quota tier catalog / SLA threshold / incident lifecycle の operator surface。
すべて internal HMAC 必須。ただし `GET /api/internal/v1/spaces/:id/incidents`
は customer admin が actor token で叩ける customer-affecting subset です。

| Method | Path                                                        | Auth                          | Purpose                                                              |
| ------ | ----------------------------------------------------------- | ----------------------------- | -------------------------------------------------------------------- |
| POST   | `/api/internal/v1/quota-tiers`                              | internal HMAC                 | quota tier を新規登録                                                |
| PATCH  | `/api/internal/v1/quota-tiers/:tierId`                      | internal HMAC                 | tier の limit / pricing を更新                                       |
| DELETE | `/api/internal/v1/quota-tiers/:tierId`                      | internal HMAC                 | 未割当 tier を削除                                                    |
| GET    | `/api/internal/v1/sla`                                      | internal HMAC                 | SLA 設定と最近の breach summary                                       |
| POST   | `/api/internal/v1/sla/thresholds`                           | internal HMAC                 | SLA threshold を追加                                                  |
| PATCH  | `/api/internal/v1/sla/thresholds/:id`                       | internal HMAC                 | threshold を更新                                                      |
| DELETE | `/api/internal/v1/sla/thresholds/:id`                       | internal HMAC                 | threshold を削除                                                      |
| POST   | `/api/internal/v1/incidents`                                | internal HMAC                 | incident を declare                                                   |
| PATCH  | `/api/internal/v1/incidents/:id`                            | internal HMAC                 | incident state / impact / commentary を更新                          |
| POST   | `/api/internal/v1/incidents/:id/postmortem`                 | internal HMAC                 | postmortem document を publish                                        |
| GET    | `/api/internal/v1/spaces/:id/incidents`                     | actor token (customer admin)  | 当該 Space に紐づく incident の subset を read。`state >= acknowledged` のみ可視 |

`POST /api/internal/v1/quota-tiers` request body:

```yaml
tierId: string               # closed-id form, see quota-tiers reference
displayName: string
limits: { [resource: string]: integer }
pricing: object?
trialEligible: boolean?
```

`POST /api/internal/v1/sla/thresholds` request body:

```yaml
metric: string               # e.g. apply_latency_p95
window: string               # ISO duration, anchored to TAKOSUMI_SLA_WINDOW_SECONDS multiples
threshold: number
severity: enum               # info | warning | breach
```

`POST /api/internal/v1/incidents` request body:

```yaml
title: string
severity: enum               # sev1 | sev2 | sev3
impactedSpaces: string[]
detectedAt: string           # RFC3339
```

Response: `{ incident: IncidentRecord }`.

`GET /api/internal/v1/spaces/:id/incidents` response (customer-visible
subset, omits operator-internal commentary):

```yaml
incidents:
  - id: string
    title: string
    state: enum              # acknowledged | mitigating | monitoring | resolved
    severity: enum
    customerSummary: string
    startedAt: string
    resolvedAt: string?
```

state が `detected` (operator triage 中) の incident は customer view から
排除されます。

Error codes: `invalid_argument` / `failed_precondition` (tier 割当中の
削除など) / `permission_denied` / `not_found`.

関連 reference: [Quota Tiers](/reference/quota-tiers),
[SLA Breach Detection](/reference/sla-breach-detection),
[Incident Model](/reference/incident-model),
[Cost Attribution](/reference/cost-attribution),
[Zone Selection](/reference/zone-selection).

### Support impersonation

operator が customer admin の同意を得て一時的に customer scope で操作
するための flow。`POST /api/internal/v1/support/impersonations` のみ
internal HMAC、accept / terminate は customer 側 actor token で叩きます。

| Method | Path                                       | Auth                          | Purpose                                                |
| ------ | ------------------------------------------ | ----------------------------- | ------------------------------------------------------ |
| POST   | `/api/internal/v1/support/impersonations`  | internal HMAC                 | operator が impersonation request を起票               |
| POST   | `/v1/impersonations/:id/accept`            | actor token (customer admin)  | customer admin が承認、session token を発行            |
| DELETE | `/v1/impersonations/:id`                   | actor token (admin or operator) | session を terminate (どちらの side からも可能)       |

`POST /api/internal/v1/support/impersonations` request body:

```yaml
spaceId: string
operatorActorId: string
scopes: string[]
maxTtlSeconds: integer       # bounded by TAKOSUMI_SUPPORT_SESSION_MAX_TTL_SECONDS
reason: string
```

Response: `{ impersonationId: string, customerAcceptUrl: string, expiresAt: string }`.

`POST /v1/impersonations/:id/accept` response:
`{ sessionToken: string, expiresAt: string }`. session TTL の default は
`TAKOSUMI_SUPPORT_SESSION_TTL_SECONDS`、customer admin の選択によって
`maxTtlSeconds` 以内まで短く調整可能。

Error codes: `invalid_argument` / `permission_denied` (admin scope
不足) / `failed_precondition` (期限切れ request の accept) /
`not_found`.

関連 reference: [Support Impersonation](/reference/support-impersonation),
[RBAC Policy](/reference/rbac-policy).

### Operator notifications (pull)

operator pull-only の notification surface。kernel から push せず、
operator が cursor で pull する shape を v1 で固定します。

| Method | Path                                                    | Auth          | Purpose                                                           |
| ------ | ------------------------------------------------------- | ------------- | ----------------------------------------------------------------- |
| GET    | `/api/internal/v1/notifications?since=<cursor>`         | internal HMAC | operator pull。未 ack signal を cursor pagination で取得          |
| POST   | `/api/internal/v1/notifications/:id/ack`                | internal HMAC | signal を ack し、後続 pull から外す                              |

Query string `since` は前回 response の `cursor` をそのまま渡します。
ack 済み signal は cursor 進行に応じて消えますが、retention window 内
であれば audit chain から restore 可能。`limit` は 1..200 (default 50)。

Response shape:

```yaml
notifications:
  - id: string
    kind: enum               # see notification-emission reference for closed list
    severity: enum
    spaceId: string?
    emittedAt: string
    payload: object
cursor: string?              # null when reached head
```

Error codes: `invalid_argument` (cursor 形式不正) /
`failed_precondition` (重複 ack) / `not_found`.

関連 reference: [Notification Emission](/reference/notification-emission).

## Runtime-Agent control RPC

runtime-agent process の lifecycle / lease / drain を kernel が制御するための
internal RPC です。すべて `/api/internal/v1/runtime/agents/...` 配下にあり、
internal HMAC が必須です。詳細仕様 (request / response schema、Lifecycle
state machine) は [Runtime-Agent API](/reference/runtime-agent-api) を参照
してください。

| Method | Path                                                          | Purpose                                                         |
| ------ | ------------------------------------------------------------- | --------------------------------------------------------------- |
| POST   | `/api/internal/v1/runtime/agents/enroll`                      | runtime-agent registry へ enrollment                            |
| POST   | `/api/internal/v1/runtime/agents/:agentId/heartbeat`          | runtime-agent からの heartbeat 報告                              |
| POST   | `/api/internal/v1/runtime/agents/:agentId/leases`             | lease (実行責務) を取得                                         |
| POST   | `/api/internal/v1/runtime/agents/:agentId/reports`            | lease 結果 (progress / completed / failed) を kernel へ返却     |
| POST   | `/api/internal/v1/runtime/agents/:agentId/drain`              | drain を要求                                                    |
| POST   | `/api/internal/v1/runtime/agents/:agentId/gateway-manifest`   | gateway URL を Ed25519 で署名してから返す                        |

### Gateway manifest signing

`POST /api/internal/v1/runtime/agents/:agentId/gateway-manifest` は kernel が
保有する Ed25519 private key で gateway URL bundle を署名し、署名を以下の
形で返します。

- Header `X-Takosumi-Signature: ed25519=<base64-signature>; key=<keyId>`
- Header `X-Takosumi-Signature-Issuer: <kernel-issuer-id>`
- 署名対象 byte 範囲: response body の **JSON canonical 形式** (`JSON.stringify`
  with sorted keys) のまま。HTTP header と status は含まず、**body bytes
  の SHA-256 を Ed25519 で署名** します。
- Key rotation: kernel は新旧 2 keyId を `keys[]` で同時 publish し、移行期間
  中は両方を accept します。古い keyId は publish 終了後 7 日以内に retire
  します。Issuer 切替時は `X-Takosumi-Signature-Issuer` を変える前に
  runtime-agent の trust store を更新する運用です。
- `X-Takosumi-Signature-Issuer` 未配線の kernel では 501 `not_implemented`
  を返します。

## Error envelope

v1 error envelope は closed shape です。

```ts
interface ApiErrorEnvelope {
  readonly error: {
    readonly code: DomainErrorCode;
    readonly message: string;
    readonly requestId: string;
    readonly details?: JsonValue;
  };
}
```

`requestId` は **常に存在** します。caller が `X-Request-Id` を送らなかった
場合は kernel が ULID で生成し、log と response の両方に同じ値を載せます。

`DomainErrorCode` は v1 で 9 個の closed enum です。

| `code`                    | HTTP | 主な発生要因                                                              |
| ------------------------- | ---- | ------------------------------------------------------------------------- |
| `invalid_argument`        | 400  | manifest schema / form input / digest mismatch                            |
| `unauthenticated`         | 401  | bearer 不足、internal HMAC 検証失敗                                        |
| `permission_denied`       | 403  | space 越境、entitlement 拒否、policy gate 拒否                            |
| `not_found`               | 404  | endpoint disabled (token unset)、deployment / artifact / Space 不在        |
| `failed_precondition`     | 409  | destroy で prior record 不在、collision-detected、approval 失効           |
| `resource_exhausted`      | 413  | artifact upload が `TAKOSUMI_ARTIFACT_MAX_BYTES` 超過、quota 超過          |
| `not_implemented`         | 501  | issuer 未配線、operator が opt-in していない機能                          |
| `readiness_probe_failed`  | 503  | `/livez` / `/readyz` / dependent port が ready でない                      |
| `internal_error`          | 500  | unhandled exception                                                       |

`details` には sensitive key (`authorization` / `cookie` / `token` / `secret`
/ `password` / `credential` / `api_key` / `private_key`) を含む field が
あれば自動で `[redacted]` に置換されます。

## Cross-references

- [Approval Invalidation Triggers](/reference/approval-invalidation)
- [WAL Stages](/reference/wal-stages)
- [Runtime-Agent API](/reference/runtime-agent-api)
- [Lifecycle Protocol](/reference/lifecycle)

## See also

- [Tenant Provisioning](/reference/tenant-provisioning)
- [Tenant Export & Deletion](/reference/tenant-export-deletion)
- [Trial Spaces](/reference/trial-spaces)
- [Space Export Share](/reference/space-export-share)
- [Quota Tiers](/reference/quota-tiers)
- [Cost Attribution](/reference/cost-attribution)
- [Zone Selection](/reference/zone-selection)
- [API Key Management](/reference/api-key-management)
- [Auth Providers](/reference/auth-providers)
- [RBAC Policy](/reference/rbac-policy)
- [SLA Breach Detection](/reference/sla-breach-detection)
- [Incident Model](/reference/incident-model)
- [Support Impersonation](/reference/support-impersonation)
- [Notification Emission](/reference/notification-emission)
