# Kernel HTTP API

> Stability: stable Audience: operator, integrator, kernel-implementer See also:
> [Runtime-Agent API](/reference/runtime-agent-api),
> [Closed Enums](/reference/closed-enums),
> [Approval Invalidation](/reference/approval-invalidation),
> [Lifecycle Protocol](/reference/lifecycle),
> [WAL Stages](/reference/wal-stages)

Takosumi kernel HTTP surface の v1 reference です。本ページは kernel が公開する
3 つの surface — public deploy CLI surface, internal control plane,
runtime-agent control RPC — について authentication / endpoints / request schema
/ response schema / status codes / error envelope を一貫した形で定義します。

実装は
[`packages/kernel/src/api/`](https://github.com/tako0614/takosumi/tree/master/packages/kernel/src/api)
の Hono router 群 (`public_routes.ts` / `internal_routes.ts` /
`deploy_public_routes.ts` / `runtime_agent_routes.ts` / `artifact_routes.ts` /
`readiness_routes.ts`) に分割されており、
`takosumi-{api,worker,router,runtime-agent,log-worker}` role ごとに mount される
route 集合が決まります。本ページは `takosumi-api` role で 全 surface を mount
した状態を前提とします。

## Overview

| Surface           | Path prefix                                                      | 想定 caller                                 |
| ----------------- | ---------------------------------------------------------------- | ------------------------------------------- |
| Public deploy CLI | `/v1/deployments`, `/v1/artifacts`                               | Operator が握る `takosumi deploy --remote`  |
| Internal control  | `/api/internal/v1/*`                                             | Operator が運営する CLI / dashboard / agent |
| Runtime-Agent RPC | `/api/internal/v1/runtime/agents/*`                              | Operator-installed runtime-agent process    |
| Discovery / probe | `/health`, `/livez`, `/readyz`, `/openapi.json`, `/capabilities` | Operator orchestrator                       |

すべての endpoint は kernel の base URL (例: `https://kernel.example.com`) に
対する相対 path です。kernel は credential を **保持せず**、operator が起動時 に
env 経由で inject します。

## Authentication

kernel は v1 で 3 種類の credential を区別し、credential ごとに作用範囲を
完全に分離します。

| Credential                | Env var                         | 適用範囲                                                  | 認証方式                        |
| ------------------------- | ------------------------------- | --------------------------------------------------------- | ------------------------------- |
| Public deploy bearer      | `TAKOSUMI_DEPLOY_TOKEN`         | `/v1/deployments/*`、`/v1/artifacts/*` の write 系        | `Authorization: Bearer <token>` |
| Artifact read-only bearer | `TAKOSUMI_ARTIFACT_FETCH_TOKEN` | `GET /v1/artifacts/:hash`、`HEAD /v1/artifacts/:hash`     | `Authorization: Bearer <token>` |
| Internal HMAC secret      | `TAKOSUMI_INTERNAL_API_SECRET`  | `/api/internal/v1/*` 全体 (runtime-agent endpoint も含む) | HMAC-SHA256 + replay protection |

規則:

- `TAKOSUMI_DEPLOY_TOKEN` が unset の間、public deploy / artifact write route は
  **404** を返します。これは「token を設定し忘れた operator が 401 で原因
  を隠蔽されない」ことを担保するため、敢えて 404 にしています。
- Public deploy bearer の Space scope は `TAKOSUMI_DEPLOY_SPACE_ID` で設定
  します。未設定時は `takosumi-deploy` です。
- Artifact read-only bearer は runtime-agent host 側に配布する scope-narrow
  token です。`TAKOSUMI_DEPLOY_TOKEN` と分離して配ることで、agent host が
  compromise されても apply / destroy / upload 権限は残らない設計です。
- Internal HMAC は `method` / `path` / `query` / `body digest` / `actor` を
  canonical 化して署名し、`x-takosumi-internal-signature` /
  `x-takosumi-internal-timestamp` / `x-takosumi-request-id` で検証します。
  timestamp skew は 5 分、request id は replay protection store で TTL 5 分
  の冪等保護下にあります。Rationale: NTP 同期下では実用上 60 秒以内に収まる
  が、5 分は network jitter / pod restart / clock step skew を許容しつつ replay
  attack window を狭く保つ閾値。短いと正常 traffic の rejection を 招き、長いと
  captured request の replay 余地が広がる。
- `/health` / `/livez` / `/readyz` / `/capabilities` / `/openapi.json` の
  discovery 系は無認証です。

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

`manifest` は Takosumi v1 shape manifest です。Top-level は `apiVersion: "1.0"`
/ `kind: "Manifest"` / `metadata` / `template` / `resources` の closed envelope
で、`template` は `{ template:
"<id>@<version>", inputs?: {} }`、`resources[]`
は `ManifestResource` (`shape` / `name` / `provider` / `spec` / optional
`requires` / `metadata`) です。`template` と `resources[]` は併用でき、template
expansion の後に explicit resources が append されます。詳細は
[Manifest](/manifest) と [Manifest Validation](/reference/manifest-validation)。

`provenance` is an optional JSON object supplied by an upstream deploy client.
The kernel treats it as opaque audit evidence. For example, `takosumi-git push`
sends `kind: "takosumi-git.deployment-provenance@v1"` with workflow run id, git
commit metadata, artifact URI, and step log digests. The kernel validates only
that the value is a JSON object and that `kind`, when present, is a string; it
does not execute workflows, read workflow files, parse build logs, or interpret
git semantics.

Current public deploy scope is single-token. `TAKOSUMI_DEPLOY_TOKEN` maps to one
operator-configured public deploy Space / tenant scope. The scope defaults to
`takosumi-deploy` and can be set with `TAKOSUMI_DEPLOY_SPACE_ID`. Per-actor
multi-Space auth, entitlement checks, and policy-gated Space routing belong to
the internal control-plane surface; they are not inferred from the public
manifest body.

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

`operationPlanPreview` is returned only for `mode="plan"`. It is deterministic
and matches the public DesiredSnapshot / OperationPlan digest model, but the
request remains side-effect free and writes no WAL entry.

For `mode="plan"` and `mode="apply"`, any manifest resource that declares
`spec.artifact.size` is checked before WAL writes or provider calls. The value
must be a non-negative integer byte count and must not exceed the registered
artifact-kind `maxSize`; unknown kinds fall back to
`TAKOSUMI_ARTIFACT_MAX_BYTES` semantics (50 MiB by default). Oversized artifacts
return 413 `resource_exhausted`.

For `mode="apply"` and `mode="destroy"`, the route derives the same public
OperationPlan shape internally and writes `takosumi_operation_journal_entries`
around provider side effects: `prepare` / `pre-commit` / `commit` before the
provider call, then `post-commit` / `observe` / `finalize` on success or `abort`
on failure. These entries are durable replay evidence for the public surface,
and provider calls receive the WAL idempotency tuple as a fencing token. When
`provenance` is present, the route also attaches
`metadata.takosumiDeployProvenance = { kind:
"takosumi.deploy-provenance-digest@v1", digest }`
to each resolved resource before deriving the OperationPlan digest, and stores
the full provenance object in every public WAL effect detail. This keeps replay
identity tied to the artifact provenance without making the kernel understand
the upstream workflow.

If the latest public WAL for the addressed deployment is not terminal
(`finalize` / `abort` / `skip`), a new `apply` / `destroy` fails closed with 409
`failed_precondition` before any provider call. Sending
`recoveryMode: "inspect"` returns the persisted public WAL state without writing
new journal entries or calling providers. Sending `recoveryMode: "continue"`
with the same `mode` and a manifest that derives the same OperationPlan digest
replays that exact operation; phase or digest mismatches fail closed with 409.
Sending `recoveryMode: "compensate"` for a matching WAL that reached `commit` or
later appends terminal `abort` and opens `activation-rollback` RevokeDebt
records without calling providers.

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

`DeploymentJournalEntrySummary` includes WAL coordinates, operation / resource
fields, the `effectDigest`, status, timestamp, and optional `provenance`. The
optional `provenance` value is the same opaque JSON object recorded in the WAL
effect detail.

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

`DeployPublicRevokeDebtRecordSummary` includes the debt id, generated object,
reason / status, owner / originating Space, resource-scoped WAL fields, retry
metadata (`retryAttempts`, `lastRetryAt`, `nextRetryAt`), and timestamps
(`createdAt`, `statusUpdatedAt`, `agedAt`, `clearedAt`).

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

`takosumi status` (引数なし) の backing endpoint。public deploy scope
(`TAKOSUMI_DEPLOY_SPACE_ID`、未設定なら `takosumi-deploy`) 配下の deployment
を一覧で返します。`Authorization: Bearer $TAKOSUMI_DEPLOY_TOKEN` を要求し、
token 未設定なら 404 `not_found` を返します。

Current implementation does not accept public query parameters on this route.
Pagination, `kind`, `since`, and cross-Space `space=*` filters are reserved for
the internal status/control-plane surface until matching route support exists.

Response body:

```ts
interface DeploymentListResponse {
  readonly deployments: readonly DeploymentSummary[];
}
```

`DeploymentSummary` の shape は [Status Output](/reference/status-output) に固定
されます。current kernel は public WAL stage records から latest `journal`
summary と latest `provenance` も付与します。status query は read-only
で、journal を追加で 書くことはありません。

### `GET /v1/deployments/:name`

`takosumi status <name>` の backing endpoint。`name` は manifest の
`metadata.name` に対応し、public deploy scope に紐づく単一 deployment を返し
ます。

Response body は [Status Output](/reference/status-output) の
`DeploymentSummary` です。`name` が当該 public deploy scope に存在しない場合は
404 `not_found`、token 未設定の場合も同じく 404 `not_found` を返します。

### `GET /v1/deployments/:name/audit`

`takosumi audit show <deployment-id-or-name>` の backing endpoint。`name` は
manifest の `metadata.name` に対応します。CLI が deployment id を受け取った場合
は、先に `GET /v1/deployments` の `DeploymentSummary.id` から `name` に解決して
この endpoint を呼びます。

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

`/api/internal/v1/*` は operator-only の control plane surface です。operator
が運用する dashboard / automation が caller。Public 経由での expose は
**しません**。Current public `takosumi` CLI はこの internal Space API を直接叩く
`space` command を公開していません。

Current implementation mounts only the following signed internal routes:

| Method | Path                                               | Purpose                                     |
| ------ | -------------------------------------------------- | ------------------------------------------- |
| GET    | `/api/internal/v1/spaces`                          | actor が見える Space summary 一覧           |
| POST   | `/api/internal/v1/spaces`                          | Space 作成                                  |
| GET    | `/api/internal/v1/groups?spaceId=<id>`             | Space 内 Group summary 一覧                 |
| POST   | `/api/internal/v1/groups`                          | Group 作成                                  |
| POST   | `/api/internal/v1/deployments`                     | internal manifest resolve / deployment 作成 |
| POST   | `/api/internal/v1/deployments/:deploymentId/apply` | resolved deployment を apply                |

すべて internal HMAC 署名が要件で、署名検証失敗時は 401
`unauthenticated`、ServiceGrant / entitlement boundary で拒否された場合は 403
`permission_denied` を返します。`TAKOSUMI_INTERNAL_API_SECRET` は reference
名です が、current implementation の route helper は
`TAKOSUMI_INTERNAL_SERVICE_SECRET` も読めます。operator docs では
`TAKOSUMI_INTERNAL_API_SECRET` を使ってください。

### Implemented Internal Shapes

`POST /api/internal/v1/spaces` request body:

```yaml
spaceId: string?
name: string?
slug: string?
metadata: object?
```

Response: `{ space: { id, name, actorAccountId } }`.

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

The route calls the internal deployment resolver with `mode: "resolve"` and
returns:

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

The route hides cross-Space deployment ids as 404 and returns the same mutation
response shape as resolve.

### Spec-Reserved Internal Surfaces

The following HTTP route families are documented in their domain references as
spec / service contracts, but they are **not current kernel HTTP routes** in
this repository:

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
POST /api/internal/v1/api-keys
POST /v1/api-keys
POST /v1/api-keys/:id/rotate
DELETE /v1/api-keys/:id
POST /api/internal/v1/auth-providers
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

Adding any of these routes requires matching route code, authorization tests,
OpenAPI/capabilities updates when applicable, and updates to this reference.

## Workflow / trigger / hook boundary

The current kernel exposes no workflow, trigger, schedule, or declarable hook
HTTP route. Workflow-shaped automation belongs above the kernel in
`takosumi-git`: it owns `.takosumi/manifest.yml`, `.takosumi/workflows/*.yml`,
`resources[i].workflowRef`, build execution, webhook/cron integration, and
artifact URI discovery. After that resolution step, `takosumi-git` strips its
private `workflowRef` extension and submits a plain Takosumi v1 manifest to
`POST /v1/deployments`.

The kernel therefore has no public or internal trigger-registration API in v1,
and this reference intentionally does not reserve trigger endpoint schemas.
Adding kernel-hosted workflow routes would require a new RFC that changes the
ownership boundary recorded in
[Workflow Placement Rationale](/reference/architecture/workflow-extension-design),
plus route code, authorization tests, storage migrations, OpenAPI/capabilities
updates, and an update to the
[Public Spec Source Map](/reference/public-spec-source-map).

Catalog release executable hooks are a separate operator plugin mechanism; they
are documented in [Plugin Marketplace](/reference/plugin-marketplace) and are
not workflow trigger routes.

## Runtime-Agent control RPC

runtime-agent process の lifecycle / lease / drain を kernel が制御するための
internal RPC です。すべて `/api/internal/v1/runtime/agents/...` 配下にあり、
internal HMAC が必須です。詳細仕様 (request / response schema、Lifecycle state
machine) は [Runtime-Agent API](/reference/runtime-agent-api) を参照
してください。

| Method | Path                                                        | Purpose                                                     |
| ------ | ----------------------------------------------------------- | ----------------------------------------------------------- |
| POST   | `/api/internal/v1/runtime/agents/enroll`                    | runtime-agent registry へ enrollment                        |
| POST   | `/api/internal/v1/runtime/agents/:agentId/heartbeat`        | runtime-agent からの heartbeat 報告                         |
| POST   | `/api/internal/v1/runtime/agents/:agentId/leases`           | lease (実行責務) を取得                                     |
| POST   | `/api/internal/v1/runtime/agents/:agentId/reports`          | lease 結果 (progress / completed / failed) を kernel へ返却 |
| POST   | `/api/internal/v1/runtime/agents/:agentId/drain`            | drain を要求                                                |
| POST   | `/api/internal/v1/runtime/agents/:agentId/gateway-manifest` | gateway URL を Ed25519 で署名してから返す                   |

### Gateway manifest signing

`POST /api/internal/v1/runtime/agents/:agentId/gateway-manifest` は kernel が
保有する Ed25519 private key で gateway URL bundle を署名し、署名を以下の
形で返します。

- Header `X-Takosumi-Signature: ed25519=<base64-signature>; key=<keyId>`
- Header `X-Takosumi-Signature-Issuer: <kernel-issuer-id>`
- 署名対象 byte 範囲: response body の **JSON canonical 形式** (`JSON.stringify`
  with sorted keys) のまま。HTTP header と status は含まず、**body bytes の
  SHA-256 を Ed25519 で署名** します。
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

`details` には sensitive key (`authorization` / `cookie` / `token` / `secret` /
`password` / `credential` / `api_key` / `private_key`) を含む field が
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
- [Resource IDs](/reference/resource-ids)
