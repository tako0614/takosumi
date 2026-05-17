# Kernel HTTP API

> このページでわかること: kernel HTTP API の v1 endpoint・auth・error envelope。

本ページは `takosumi-api` role で全 surface を mount した状態を前提に、 3 つの
surface (public deploy CLI / internal control plane / runtime-agent control RPC)
を一括で定義します。

> 実装は
> [`packages/kernel/src/api/`](https://github.com/tako0614/takosumi/tree/master/packages/kernel/src/api)
> の Hono router 群。 role ごとに mount される route 集合が変わります。

## Overview

| Surface           | Path prefix                                                      | 想定 caller                                 |
| ----------------- | ---------------------------------------------------------------- | ------------------------------------------- |
| Public deploy CLI | `/v1/deployments`, `/v1/artifacts`                               | Operator が握る `takosumi deploy --remote`  |
| Internal control  | `/api/internal/v1/*`                                             | Operator が運営する CLI / dashboard / agent |
| Runtime-Agent RPC | `/api/internal/v1/runtime/agents/*`                              | Operator-installed runtime-agent process    |
| Discovery / probe | `/health`, `/livez`, `/readyz`, `/openapi.json`, `/capabilities` | Operator orchestrator                       |

すべての endpoint は kernel の base URL に対する相対 path です。credential は
kernel が保持せず、 operator が env 経由で inject します。

## Authentication

kernel は v1 で 3 種類の credential を区別し、credential ごとに作用範囲を
完全に分離します。

| Credential                | Env var                         | 適用範囲                                                  | 認証方式                        |
| ------------------------- | ------------------------------- | --------------------------------------------------------- | ------------------------------- |
| Public deploy bearer      | `TAKOSUMI_DEPLOY_TOKEN`         | `/v1/deployments/*`、`/v1/artifacts/*` の write 系        | `Authorization: Bearer <token>` |
| Artifact read-only bearer | `TAKOSUMI_ARTIFACT_FETCH_TOKEN` | `GET /v1/artifacts/:hash`、`HEAD /v1/artifacts/:hash`     | `Authorization: Bearer <token>` |
| Internal HMAC secret      | `TAKOSUMI_INTERNAL_API_SECRET`  | `/api/internal/v1/*` 全体 (runtime-agent endpoint も含む) | HMAC-SHA256 + replay protection |

規則:

- `TAKOSUMI_DEPLOY_TOKEN` が unset の間、 public deploy / artifact write route
  は **404** を返します (401 で「token 未設定」を隠蔽しないため)。
- Public deploy bearer の Space scope は `TAKOSUMI_DEPLOY_SPACE_ID`。 未設定時
  は `takosumi-deploy`。
- Artifact read-only bearer は runtime-agent host に配る scope-narrow token。
  分離配布で agent host compromise 時も apply / destroy / upload 権限は残らな
  い。
- Internal HMAC は `method` / `path` / `query` / `body digest` / `actor` を
  canonical 化して署名し、 `x-takosumi-internal-signature` /
  `x-takosumi-internal-timestamp` / `x-takosumi-request-id` で検証します。
- timestamp skew は 5 分、 request id は replay protection store で TTL 5 分。
- `/health` / `/livez` / `/readyz` / `/capabilities` / `/openapi.json` は無認
  証。

> 5 分の skew 閾値は network jitter / pod restart / clock step skew を許容し
> つつ replay window を狭く保つ均衡点 (短すぎると正常 traffic を弾き、長す
> ぎると captured request の replay 余地が広がる)。

## Public deploy routes

CLI (`takosumi deploy --remote`) が叩く v1 surface です。すべて
`Authorization: Bearer $TAKOSUMI_DEPLOY_TOKEN` を要求します。

| Method | Path                    | Purpose                                                            |
| ------ | ----------------------- | ------------------------------------------------------------------ |
| POST   | `/v1/deployments`       | manifest を resolve し、`apply / plan / destroy` のいずれかを駆動  |
| GET    | `/v1/deployments`       | 直近の applied / failed / destroyed record を列挙                  |
| GET    | `/v1/deployments/:name` | 指定 deployment の summary を取得                                  |
| POST   | `/v1/artifacts`         | multipart upload で artifact bytes を kernel object storage に登録 |
| GET    | `/v1/artifacts`         | 登録済み artifact を cursor pagination で列挙                      |
| GET    | `/v1/artifacts/kinds`   | 登録された artifact kind 一覧                                      |
| HEAD   | `/v1/artifacts/:hash`   | artifact の size / kind / uploadedAt を header で取得              |
| GET    | `/v1/artifacts/:hash`   | artifact bytes をストリーム取得                                    |
| DELETE | `/v1/artifacts/:hash`   | artifact を object storage から削除                                |
| POST   | `/v1/artifacts/gc`      | mark+sweep GC を駆動 (`?dryRun=1` で plan のみ)                    |

`hash` は `sha256:<hex>` 形式。kernel は upload 時と fetch 時の両方で再計算
し改ざんを検出します。

### `POST /v1/deployments`

Required headers:

| Header                                          | Notes                                                                                                                                                                                                                             |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Authorization: Bearer <TAKOSUMI_DEPLOY_TOKEN>` | deploy public bearer                                                                                                                                                                                                              |
| `Content-Type: application/json`                | body is the deploy public request envelope                                                                                                                                                                                        |
| `X-Idempotency-Key`                             | CLI-supplied per operation. Same key + same body replays the first response; same key + different body returns `409 failed_precondition`. If omitted, the kernel generates a one-request key and no retry protection is obtained. |

Request body:

```ts
interface DeployPublicRequest {
  readonly mode?: "apply" | "plan" | "destroy"; // default: "apply"
  readonly manifest: ManifestBody;
  readonly provenance?: JsonObject;
  readonly force?: boolean; // destroy 時のみ意味を持つ
  readonly recoveryMode?: "inspect" | "continue" | "compensate";
}
```

`manifest` は Takosumi v1 compiled Shape manifest。 top-level は `@context` /
`apiVersion: "1.0"` / `kind: "Manifest"` / `namespace` / `metadata` /
`resources` の closed envelope。 詳細は [Manifest](/manifest) と
[Manifest Validation](/reference/manifest-validation)。 `template` は public
contract ではなく、 installer/compiler 層で `resources[]` に展開してから送り
ます。

`provenance` は upstream client が供給する optional な opaque JSON で、 kernel
は audit evidence として扱います。 値が JSON object か、 `kind` がある場合は
string か、 のみ検証し、 workflow 実行 / file 読込 / build log parse / git 解
釈は行いません。 例えば `takosumi-git push` は
`kind: "takosumi-git.deployment-provenance@v1"` で workflow run id、 git commit
metadata、 artifact URI、 step log digest を入れます。

> operator / account plane 依存は kernel deploy 前に namespace export / account
> API / OIDC discovery / BillingPort contract で解決します。 kernel が
> 受け取るのは compile 済 Shape manifest のみ。

public deploy scope は single token。 `TAKOSUMI_DEPLOY_TOKEN` が 1 つの Space /
tenant scope に対応します。 actor 単位の multi-Space auth、 entitlement check、
policy-gated Space routing は internal control plane の責務で、 public manifest
body から推論しません。

Response (mode=`apply` / `plan`):

```ts
interface DeployPublicResponse {
  readonly status: "ok";
  readonly outcome: ApplyOutcome;
}

interface ApplyOutcome {
  readonly applied: readonly AppliedResource[];
  readonly issues: readonly ManifestIssue[];
  readonly status:
    | "succeeded"
    | "failed-validation"
    | "failed-apply"
    | "partial";
  readonly planned?: readonly PlannedResource[]; // mode="plan"
  readonly operationPlanPreview?: OperationPlanPreview; // mode="plan"
  readonly reused?: number;
}

interface OperationPlanPreview {
  readonly planId: string;
  readonly spaceId: string;
  readonly deploymentName?: string;
  readonly desiredSnapshotDigest: `sha256:${string}`;
  readonly operationPlanDigest: `sha256:${string}`;
  readonly walStages: readonly string[];
  readonly operations: readonly {
    readonly operationId: string;
    readonly resourceName: string;
    readonly shape: string;
    readonly providerId: string;
    readonly op: "create";
    readonly dependsOn: readonly string[];
    readonly desiredDigest: `sha256:${string}`;
    readonly idempotencyKey: {
      readonly spaceId: string;
      readonly operationPlanDigest: `sha256:${string}`;
      readonly journalEntryId: string;
    };
  }[];
}
```

`operationPlanPreview` は `mode="plan"` のときのみ返ります。 公開
DesiredSnapshot / OperationPlan digest model と一致する deterministic な値で、
副作用も WAL 書込もありません。

Artifact size check (`plan` / `apply`): `spec.artifact.size` を宣言する resource
は WAL 書込・ provider 呼出の前に検査されます。 値は非負整数 byte。 登録済
artifact-kind の `maxSize` を超えれば reject。 未登録 kind は
`TAKOSUMI_ARTIFACT_MAX_BYTES` (既定 50 MiB) に fallback。 超過時は 413
`resource_exhausted`。

WAL 書込 (`apply` / `destroy`): 内部で同じ public OperationPlan shape を導出
し、 provider 副作用の前後で `takosumi_operation_journal_entries` を書きます。
provider 呼出前に `prepare` / `pre-commit` / `commit`、 成功時に `post-commit` /
`observe` / `finalize`、 失敗時に `abort` を追記。 これらは public surface の
durable な replay 証跡で、 provider 呼出には WAL idempotency tuple を fencing
token として渡します。

Provenance binding: `provenance` が指定された場合、 OperationPlan digest を導
出する前に各 resource に
`metadata.takosumiDeployProvenance = { kind: "takosumi.deploy-provenance-digest@v1", digest }`
を attach し、 public WAL effect detail に provenance object 全体を持たせます。

Recovery modes: 最新 public WAL が terminal (`finalize` / `abort` / `skip`) で
ない deployment への新規 `apply` / `destroy` は 409 `failed_precondition` で
fail-closed します。

- `recoveryMode: "inspect"`: journal 書込なし、 provider 呼出なし、 persist 済
  public WAL を返す。
- `recoveryMode: "continue"`: 同じ `mode` + OperationPlan digest 一致のときだ
  け同 operation を replay。 phase / digest が違えば 409。
- `recoveryMode: "compensate"`: `commit` 以降に到達した一致 WAL に terminal
  `abort` を追記し、 `activation-rollback` の RevokeDebt を開く (provider は
  呼ばない)。

```ts
interface DeployPublicRecoveryInspectResponse {
  readonly status: "ok";
  readonly outcome: {
    readonly status: "recovery-inspect";
    readonly tenantId: string;
    readonly deploymentName: string;
    readonly journal?: DeploymentJournalSummary;
    readonly entries: readonly DeploymentJournalEntrySummary[];
  };
}
```

`DeploymentJournalEntrySummary` は WAL 座標、 operation / resource field、
`effectDigest`、 status、 timestamp、 optional `provenance` を含みます。
`provenance` 値は WAL effect detail に記録された opaque JSON object と同じ
ものです。

```ts
interface DeployPublicRecoveryCompensateResponse {
  readonly status: "ok";
  readonly outcome: {
    readonly status: "recovery-compensate";
    readonly tenantId: string;
    readonly deploymentName: string;
    readonly journal?: DeploymentJournalSummary;
    readonly debts: readonly DeployPublicRevokeDebtRecordSummary[];
  };
}
```

`DeployPublicRevokeDebtRecordSummary` は debt id、 generated object、 reason /
status、 owner / originating Space、 resource scope の WAL field、 retry
metadata (`retryAttempts` / `lastRetryAt` / `nextRetryAt`)、 timestamp
(`createdAt` / `statusUpdatedAt` / `agedAt` / `clearedAt`) を含みます。

Response (mode=`destroy`):

```ts
interface DestroyOutcome {
  readonly destroyed: readonly DestroyedResource[];
  readonly errors: readonly {
    readonly resource: string;
    readonly message: string;
  }[];
  readonly status: "succeeded" | "partial" | "failed";
}
```

Status codes:

| Status | Code (envelope)       | 主な発生要因                                                                                                                      |
| ------ | --------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 200    | (success)             | apply / plan / destroy 完了 (partial 含む)                                                                                        |
| 400    | `invalid_argument`    | request body / manifest schema / validation error                                                                                 |
| 401    | `unauthenticated`     | bearer 不足                                                                                                                       |
| 404    | `not_found`           | deploy token 未設定、deployment 不在                                                                                              |
| 409    | `failed_precondition` | destroy 対象の prior record が無い、idempotency key conflict、unfinished WAL / recovery digest mismatch、compensate before commit |
| 413    | `resource_exhausted`  | `spec.artifact.size` が configured artifact quota を超過                                                                          |
| 500    | `internal_error`      | apply / destroy の未処理例外                                                                                                      |

### `GET /v1/deployments`

`takosumi status` (引数なし) の backing。 public deploy scope の deployment 一
覧を返します。 token 未設定なら 404 `not_found`。

public query parameter は受け付けません。 pagination、 `kind`、 `since`、
cross-Space `space=*` filter は internal status / control-plane surface 側に予
約。

Response body:

```ts
interface DeploymentListResponse {
  readonly deployments: readonly DeploymentSummary[];
}
```

`DeploymentSummary` の shape は [Status Output](/reference/status-output)。
latest `journal` summary と latest `provenance` も付与します。 read-only で、
journal は追加で書きません。

### `GET /v1/deployments/:name`

`takosumi status <name>` の backing。 `name` は manifest の `metadata.name`。
public deploy scope に紐づく単一 deployment を返します。

Response body は [Status Output](/reference/status-output) の
`DeploymentSummary`。 name 不在 / token 未設定はいずれも 404 `not_found`。

### `GET /v1/deployments/:name/audit`

`takosumi audit show <deployment-id-or-name>` の backing。 `name` は manifest の
`metadata.name`。 CLI が deployment id を渡された場合は、 先に
`GET /v1/deployments` で id → name を解決してから呼びます。

Response body:

```ts
interface DeployPublicAuditResponse {
  readonly status: "ok";
  readonly audit: {
    readonly deployment: DeploymentSummary;
    readonly journal?: DeploymentJournalSummary;
    readonly provenance?: JsonObject;
    readonly causeChain: readonly {
      readonly operationPlanDigest: `sha256:${string}`;
      readonly journalEntryId: string;
      readonly operationId: string;
      readonly phase: string;
      readonly stage: string;
      readonly operationKind: string;
      readonly effectDigest: `sha256:${string}`;
      readonly status: string;
      readonly createdAt: string;
      readonly resourceName?: string;
      readonly providerId?: string;
      readonly reason?: string;
      readonly outcomeStatus?: string;
      readonly revokeDebtIds?: readonly string[];
      readonly detail?: JsonObject;
      readonly provenance?: JsonObject;
    }[];
    readonly entries: readonly DeploymentJournalEntrySummary[];
    readonly revokeDebts: readonly DeployPublicRevokeDebtRecordSummary[];
  };
}
```

`causeChain` is a read-only projection over public WAL entries. It extracts
rollback / abort reasons, apply/destroy outcome status, RevokeDebt ids, and the
opaque upstream provenance so an operator can trace a rollback from deployment
id to git commit, workflow run, artifact URI, and step log digests without
moving workflow execution into the kernel.

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
  readonly hash: string; // sha256:<hex>
  readonly kind: string;
  readonly size: number;
  readonly uploadedAt: string; // RFC 3339
  readonly metadata?: JsonObject;
}
```

`expectedDigest` を付けた upload で computed hash と一致しない場合は 400
`invalid_argument`、本体サイズが `TAKOSUMI_ARTIFACT_MAX_BYTES` を超えると 413
`resource_exhausted` を返します。

### `POST /v1/artifacts/gc`

mark+sweep GC。`?dryRun=1` で `{ planned: ArtifactStored[] }` を返し、無印で
`{ deleted: ArtifactStored[] }` を返します。

## Internal control plane routes

`/api/internal/v1/*` は operator-only。 dashboard / automation が caller で、
public 経由 expose はしません。 public `takosumi` CLI に対応 `space` 系 command
はありません。

現在 mount される署名付き internal route:

| Method | Path                                               | Purpose                                     |
| ------ | -------------------------------------------------- | ------------------------------------------- |
| GET    | `/api/internal/v1/spaces`                          | actor が見える Space summary 一覧           |
| POST   | `/api/internal/v1/spaces`                          | Space 作成                                  |
| GET    | `/api/internal/v1/groups?spaceId=<id>`             | Space 内 Group summary 一覧                 |
| POST   | `/api/internal/v1/groups`                          | Group 作成                                  |
| POST   | `/api/internal/v1/deployments`                     | internal manifest resolve / deployment 作成 |
| POST   | `/api/internal/v1/deployments/:deploymentId/apply` | resolved deployment を apply                |

すべて internal HMAC 署名 (`TAKOSUMI_INTERNAL_API_SECRET`) が必須。 署名失敗 は
401 `unauthenticated`、 ServiceGrant / entitlement 拒否は 403
`permission_denied`。

### Implemented Internal Shapes

`POST /api/internal/v1/spaces` request body:

```yaml
spaceId: string?
name: string?
slug: string?
metadata: object?
```

Response: `{ space: { id, name, actorAccountId } }`

`POST /api/internal/v1/groups` request body:

```yaml
spaceId: string
groupId: string?
name: string?
envName: string?
metadata: object?
```

Response: `{ group: InternalGroupSummary }`.

`POST /api/internal/v1/deployments` request body:

```yaml
spaceId: string?
envName: string?
group: string?
manifest: object
```

この route は internal deployment resolver を `mode: "resolve"` で呼び、 次の
response を返します。

```ts
interface InternalDeploymentMutationResponse {
  readonly deployment_id: string;
  readonly status: string;
  readonly conditions: readonly unknown[];
  readonly expansion_summary?: unknown;
}
```

`POST /api/internal/v1/deployments/:deploymentId/apply` request body:

```yaml
spaceId: string?
space_id: string?
```

この route は cross-Space deployment id を 404 として隠蔽し、 resolve と同じ
mutation response shape を返します。

以下の HTTP route family は本 repository では各 domain reference に記述さ
れています。

```text
GET /api/internal/v1/spaces/:spaceId
GET /api/internal/v1/spaces/:spaceId/snapshots/desired
GET /api/internal/v1/spaces/:spaceId/snapshots/resolution
POST /api/internal/v1/operation-plans
POST /api/internal/v1/operation-plans/:planId/apply
GET /api/internal/v1/operation-plans/:planId/journal
GET /api/internal/v1/approvals
POST /api/internal/v1/approvals/:approvalId/decide
GET /api/internal/v1/revoke-debts
PATCH /api/internal/v1/spaces/:id
DELETE /api/internal/v1/spaces/:id
POST /api/internal/v1/spaces/:id/exports
GET /api/internal/v1/spaces/:id/exports/:exportId
POST /api/internal/v1/spaces/:id/trial/extend
POST /api/internal/v1/quota-tiers
PATCH /api/internal/v1/quota-tiers/:tierId
DELETE /api/internal/v1/quota-tiers/:tierId
GET /api/internal/v1/sla
POST /api/internal/v1/sla/thresholds
PATCH /api/internal/v1/sla/thresholds/:id
DELETE /api/internal/v1/sla/thresholds/:id
POST /api/internal/v1/incidents
PATCH /api/internal/v1/incidents/:id
POST /api/internal/v1/incidents/:id/postmortem
GET /api/internal/v1/spaces/:id/incidents
POST /api/internal/v1/support/impersonations
POST /v1/impersonations/:id/accept
DELETE /v1/impersonations/:id
GET /api/internal/v1/notifications
POST /api/internal/v1/notifications/:id/ack
```

route 追加には実装 / authorization test / OpenAPI / capabilities / 本 reference
更新が必要です。

## Workflow / trigger / hook の境界

kernel は workflow / trigger / schedule / declarable hook の HTTP route を持ち
ません。 workflow automation は上位 `takosumi-git` の責務で、
`.takosumi/manifest.yml` / `.takosumi/workflows/*.yml` /
`resources[i].workflowRef`、 build 実行、 webhook / cron 連携、 artifact URI
discovery を所有します。 resolve 後、 `takosumi-git` は `workflowRef` を strip
して plain な v1 manifest を `POST /v1/deployments` に送ります。

The current kernel exposes no workflow, trigger, schedule, or declarable hook
HTTP route.

WAL は CatalogRelease 署名再検証を行いますが、 実行可能な hook package は load
しません。

> kernel に workflow route を持たせるには
> [Workflow Placement Rationale](/reference/architecture/workflow-extension-design)
> の境界を書き換える RFC、 route 実装、 authorization test、 storage migration、
> OpenAPI / capabilities 更新、
> [Public Spec Source Map](/reference/public-spec-source-map) の更新が必要です。

## Runtime-Agent control RPC

runtime-agent process の lifecycle / lease / drain を kernel が制御する internal
RPC。 すべて `/api/internal/v1/runtime/agents/...` 配下で、 internal HMAC 必
須。 詳細 schema / state machine は
[Runtime-Agent API](/reference/runtime-agent-api)。

| Method | Path                                                        | Purpose                                                     |
| ------ | ----------------------------------------------------------- | ----------------------------------------------------------- |
| POST   | `/api/internal/v1/runtime/agents/enroll`                    | runtime-agent registry へ enrollment                        |
| POST   | `/api/internal/v1/runtime/agents/:agentId/heartbeat`        | runtime-agent からの heartbeat 報告                         |
| POST   | `/api/internal/v1/runtime/agents/:agentId/leases`           | lease (実行責務) を取得                                     |
| POST   | `/api/internal/v1/runtime/agents/:agentId/reports`          | lease 結果 (progress / completed / failed) を kernel へ返却 |
| POST   | `/api/internal/v1/runtime/agents/:agentId/drain`            | drain を要求                                                |
| POST   | `/api/internal/v1/runtime/agents/:agentId/gateway-manifest` | gateway URL を Ed25519 で署名してから返す                   |

### Gateway manifest signing

`POST /api/internal/v1/runtime/agents/:agentId/gateway-manifest` は kernel 保有
の Ed25519 private key で gateway URL bundle を署名して返します。

- Header `X-Takosumi-Signature: ed25519=<base64-signature>; key=<keyId>`
- Header `X-Takosumi-Signature-Issuer: <kernel-issuer-id>`
- 署名対象は response body の JSON canonical 形式 (`JSON.stringify` + sorted
  keys) の bytes SHA-256。 HTTP header / status は含まない。
- Key rotation: kernel は current key set を `keys[]` で publish。 Issuer 切替
  時は `X-Takosumi-Signature-Issuer` 変更前に runtime-agent の trust store を
  更新する運用。
- `X-Takosumi-Signature-Issuer` 未配線の kernel は 501 `not_implemented`。

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

`requestId` は常に存在。 caller が `X-Request-Id` を送らなければ kernel が ULID
を生成し、 log と response 両方に同じ値を載せます。

`DomainErrorCode` は v1 で 9 個の closed enum です。

| `code`                   | HTTP | 主な発生要因                                                        |
| ------------------------ | ---- | ------------------------------------------------------------------- |
| `invalid_argument`       | 400  | manifest schema / form input / digest mismatch                      |
| `unauthenticated`        | 401  | bearer 不足、internal HMAC 検証失敗                                 |
| `permission_denied`      | 403  | space 越境、entitlement 拒否、policy gate 拒否                      |
| `not_found`              | 404  | endpoint disabled (token unset)、deployment / artifact / Space 不在 |
| `failed_precondition`    | 409  | destroy で prior record 不在、collision-detected、approval 失効     |
| `resource_exhausted`     | 413  | artifact upload が `TAKOSUMI_ARTIFACT_MAX_BYTES` 超過、quota 超過   |
| `not_implemented`        | 501  | issuer 未配線、operator が opt-in していない機能                    |
| `readiness_probe_failed` | 503  | `/livez` / `/readyz` / dependent port が ready でない               |
| `internal_error`         | 500  | unhandled exception                                                 |

`details` に sensitive key (`authorization` / `cookie` / `token` / `secret` /
`password` / `credential` / `api_key` / `private_key`) を含む field があれば
自動で `[redacted]` に置換されます。

## Cross-references

- [Approval Invalidation Triggers](/reference/approval-invalidation)
- [WAL Stages](/reference/wal-stages)
- [Runtime-Agent API](/reference/runtime-agent-api)
- [Lifecycle Protocol](/reference/lifecycle)

## See also

- [Tenant Provisioning](/reference/tenant-provisioning)
- [Tenant Export & Deletion](/reference/tenant-export-deletion)
- [Trial Spaces](/reference/trial-spaces)
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
- [Resource IDs](/reference/resource-ids)

## 関連ページ

- [Runtime-Agent API](/reference/runtime-agent-api)
- [Closed Enums](/reference/closed-enums)
- [Approval Invalidation](/reference/approval-invalidation)
- [Lifecycle Protocol](/reference/lifecycle)
- [WAL Stages](/reference/wal-stages)
