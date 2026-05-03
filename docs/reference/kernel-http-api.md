# Kernel HTTP API

Takosumi kernel が公開する HTTP endpoint の reference です。kernel app は
[`packages/kernel/src/api/`](https://github.com/tako0614/takosumi/tree/master/packages/kernel/src/api)
の Hono router 群を組み合わせて構築されており、role
(`takosumi-{api,worker,router,runtime-agent,log-worker}`) ごとに mount される
route 集合が変化します。本ページは `takosumi-api` role でフル mount された
状態を前提に、auth wrappers / route table / 主要 endpoint の request /
response shape / error envelope / size limit を整理します。

CLI 越しの利用は [`takosumi deploy`](/reference/cli) を、kernel boot 設定は
[Operator: Bootstrap](/operator/bootstrap) を、manifest body の構造は
[Manifest (Shape Model)](/manifest) を参照してください。

## Auth model

kernel の HTTP surface は **3 つの credential** を区別します。すべて
operator が起動時に env 経由で inject し、kernel core は値を保持しません
([Operator: Bootstrap](/operator/bootstrap))。

| Credential                       | Env var                          | 適用範囲                                                       | 認証方式             |
| -------------------------------- | -------------------------------- | -------------------------------------------------------------- | -------------------- |
| Deploy bearer token              | `TAKOSUMI_DEPLOY_TOKEN`          | `POST /v1/deployments`、artifact CRUD、artifact GC             | `Authorization: Bearer <token>` |
| Artifact read-only token         | `TAKOSUMI_ARTIFACT_FETCH_TOKEN`  | `GET / HEAD /v1/artifacts/:hash` のみ (deploy token と OR 関係) | `Authorization: Bearer <token>` |
| Internal HMAC secret             | `TAKOSUMI_INTERNAL_API_SECRET`<br>(または `TAKOSUMI_INTERNAL_SERVICE_SECRET`) | `/api/internal/v1/*`、runtime-agent enroll/lease/report/drain | HMAC-SHA256 署名 + replay protection |

ポイント:

- **Deploy token が unset の間、関連 route は 404 を返します**。これは
  「artifact endpoint は opt-in」「public deploy endpoint は opt-in」の UX を
  強制するための仕様で、401 に変えると operator が「token 設定し忘れた」を
  検知できないため意図的にこうなっています。
- Artifact read-only token は
  [`TAKOSUMI_ARTIFACT_FETCH_TOKEN`](/reference/env-vars) として runtime-agent
  host に配るための **scope を絞った token** です。deploy token と一緒には
  渡さず、agent host が compromise されても apply / destroy / upload 権限を
  持たない構造にします (compromise 時は read-only blob 取得まで)。
- Internal HMAC は `signTakosumiInternalRequest` /
  `verifyTakosumiInternalRequestFromHeaders` (contract 提供) が `method` /
  `path` / `query` / `body` digest / `actor` をすべて canonical 化し、
  `x-takosumi-internal-signature` / `x-takosumi-internal-timestamp` /
  `x-takosumi-request-id` を載せて検証します。timestamp skew は 5 分、
  request id は `InMemoryReplayProtectionStore` (またはオペレータが inject
  する `SqlReplayProtectionStore`) で **replay protection** を適用します。
- `/health` `/capabilities` `/openapi.json` `/livez` `/readyz` の **discovery
  系は無認証**です。

## Route table

`takosumi-api` role でフル mount された場合の endpoint 一覧です。
`registerInternalRoutes` / `registerArtifactRoutes` / `registerDeployPublicRoutes`
は env / option による opt-in なので、role と起動引数で実際の集合は変わります
([Operator: Bootstrap](/operator/bootstrap))。

### Discovery

| Method | Path              | Auth | Purpose                                        |
| ------ | ----------------- | ---- | ---------------------------------------------- |
| GET    | `/health`         | -    | `{ ok, service: "takosumi", domains }` を返す  |
| GET    | `/capabilities`   | -    | mount 状態に応じた capability descriptor を返す |
| GET    | `/openapi.json`   | -    | Public + Internal endpoint の OpenAPI document |

### Readiness

| Method | Path                | Auth | Purpose                                                |
| ------ | ------------------- | ---- | ------------------------------------------------------ |
| GET    | `/livez`            | -    | liveness probe (`HealthProbeResult`)                   |
| GET    | `/readyz`           | -    | readiness probe (`HealthProbeResult`)                  |
| GET    | `/status/summary`   | -    | `GroupSummaryStatusProjection`、Kubernetes / LB から polling |

`HealthProbeResult.status === 503` または `ok=false` で 503、それ以外は 200。

### Public deploy CLI surface (`takosumi deploy --remote`)

| Method | Path                       | Auth                       | Purpose                                                              |
| ------ | -------------------------- | -------------------------- | -------------------------------------------------------------------- |
| POST   | `/v1/deployments`          | `TAKOSUMI_DEPLOY_TOKEN`    | `applyV2` pipeline を実行 (`mode: apply | plan | destroy`)            |
| GET    | `/v1/deployments`          | `TAKOSUMI_DEPLOY_TOKEN`    | tenant `takosumi-deploy` の applied / failed / destroyed record 一覧 |
| GET    | `/v1/deployments/:name`    | `TAKOSUMI_DEPLOY_TOKEN`    | name 指定の deployment summary (`appliedAt` / `resources[]` / `outputs`) |

`destroy` は record 不在で 409 (`failed_precondition`)。`force: true` で
resource name を handle として fallback できますが、cloud handle (ARN 等) は
一致しないため warning を残します。

### Artifact store

| Method | Path                           | Auth                                                                | Purpose                                                                  |
| ------ | ------------------------------ | ------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| POST   | `/v1/artifacts`                | `TAKOSUMI_DEPLOY_TOKEN`                                             | multipart upload (`kind` / `body` / `metadata` / `expectedDigest`)       |
| GET    | `/v1/artifacts`                | `TAKOSUMI_DEPLOY_TOKEN`                                             | `artifacts[]` + `nextCursor` (cursor / limit pagination)                  |
| GET    | `/v1/artifacts/kinds`          | `TAKOSUMI_DEPLOY_TOKEN`                                             | 登録済みの [`RegisteredArtifactKind`](/reference/artifact-kinds) 一覧    |
| POST   | `/v1/artifacts/gc`             | `TAKOSUMI_DEPLOY_TOKEN`                                             | mark+sweep GC (`?dryRun=1` で planning)                                   |
| HEAD   | `/v1/artifacts/:hash`          | `TAKOSUMI_DEPLOY_TOKEN` または `TAKOSUMI_ARTIFACT_FETCH_TOKEN`      | size / kind / uploadedAt を `x-takosumi-artifact-*` header で返す         |
| GET    | `/v1/artifacts/:hash`          | `TAKOSUMI_DEPLOY_TOKEN` または `TAKOSUMI_ARTIFACT_FETCH_TOKEN`      | artifact bytes をストリーム                                              |
| DELETE | `/v1/artifacts/:hash`          | `TAKOSUMI_DEPLOY_TOKEN`                                             | object storage から hash 指定の blob を削除 (204)                         |

`hash` は `sha256:<hex>` 形式。kernel が必ず再計算して検証するため、
client 側で改ざんされた `expectedDigest` は 400 になります。

### Internal control plane (`/api/internal/v1/*`)

| Method | Path                                                  | Auth         | Purpose                                                              |
| ------ | ----------------------------------------------------- | ------------ | -------------------------------------------------------------------- |
| GET    | `/api/internal/v1/spaces`                             | Internal HMAC | actor の space summary を返す                                       |
| POST   | `/api/internal/v1/spaces`                             | Internal HMAC | space を作成                                                         |
| GET    | `/api/internal/v1/groups?spaceId=`                    | Internal HMAC | space 配下の group 一覧                                              |
| POST   | `/api/internal/v1/groups`                             | Internal HMAC | group を作成                                                         |
| POST   | `/api/internal/v1/deployments`                        | Internal HMAC | manifest を resolve (plan; resolved deployment を返す)               |
| POST   | `/api/internal/v1/deployments/:deploymentId/apply`    | Internal HMAC | resolved deployment を apply                                          |
| POST   | `/api/internal/v1/runtime/agents/enroll`              | Internal HMAC | runtime-agent registry へ enrollment                                  |
| POST   | `/api/internal/v1/runtime/agents/:agentId/heartbeat`  | Internal HMAC | runtime-agent から heartbeat                                          |
| POST   | `/api/internal/v1/runtime/agents/:agentId/leases`     | Internal HMAC | runtime-agent が lease を取得                                         |
| POST   | `/api/internal/v1/runtime/agents/:agentId/reports`    | Internal HMAC | lease 結果 (progress / completed / failed) を kernel へ返却            |
| POST   | `/api/internal/v1/runtime/agents/:agentId/drain`      | Internal HMAC | runtime-agent に drain を要求                                         |
| POST   | `/api/internal/v1/runtime/agents/:agentId/gateway-manifest` | Internal HMAC | gateway URL を kernel-trusted Ed25519 key で署名 (issuer 必須)   |

すべて `WorkerAuthzService` / `MutationBoundaryEntitlementService` (operator
が optional inject) を経由し、`permission_denied` の場合は 403 を返します。

### Public PaaS API (`/api/public/v1/*`)

`takosumi-api` role でも `registerPublicRoutes` を opt-in した場合のみ mount
されます。Bearer token は kernel が抱える `AuthPort` 実装に応じます
(`LocalActorAdapter` がデフォルト、operator が JWT / OAuth2 等を inject)。

| Method | Path                                                          | Auth       | Purpose                                                       |
| ------ | ------------------------------------------------------------- | ---------- | ------------------------------------------------------------- |
| GET    | `/api/public/v1/capabilities`                                 | Actor auth | endpoint capability reference                                 |
| GET    | `/api/public/v1/spaces`                                       | Actor auth | actor が見える space 一覧                                     |
| POST   | `/api/public/v1/spaces`                                       | Actor auth | space 作成                                                    |
| GET    | `/api/public/v1/groups?spaceId=`                              | Actor auth | space 配下の group 一覧                                       |
| POST   | `/api/public/v1/groups`                                       | Actor auth | group 作成                                                    |
| POST   | `/api/public/v1/deployments`                                  | Actor auth | `mode: preview | resolve | apply | rollback` で deploy を駆動 |
| GET    | `/api/public/v1/deployments`                                  | Actor auth | filter (`group` / `status` / `space_id`) で deployment 一覧   |
| GET    | `/api/public/v1/deployments/:deploymentId`                    | Actor auth | deployment 詳細                                               |
| POST   | `/api/public/v1/deployments/:deploymentId/apply`              | Actor auth | resolved deployment を apply                                  |
| POST   | `/api/public/v1/deployments/:deploymentId/approve`            | Actor auth | policy decision を approve                                    |
| GET    | `/api/public/v1/deployments/:deploymentId/observations`       | Actor auth | provider observations (`status` 反映)                         |
| GET    | `/api/public/v1/groups/:groupId/head`                         | Actor auth | `GroupHead` ポインタ取得                                      |
| POST   | `/api/public/v1/groups/:groupId/rollback`                     | Actor auth | 直前 (または `target_id` 指定の) deployment へ rollback       |

## Request / Response shapes

### `POST /v1/deployments`

contract: [`packages/contract/src/manifest-resource.ts`](https://github.com/tako0614/takosumi/blob/master/packages/contract/src/manifest-resource.ts)
の `ManifestResource` と
[`packages/contract/src/template.ts`](https://github.com/tako0614/takosumi/blob/master/packages/contract/src/template.ts)
の `Template`。

```bash
curl -sS https://kernel.example.com/v1/deployments \
  -H "Authorization: Bearer $TAKOSUMI_DEPLOY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "mode": "apply",
    "manifest": {
      "metadata": { "name": "blog" },
      "resources": [
        { "shape": "object-store@v1", "name": "blog-assets", "provider": "aws-s3", "spec": { "bucket": "blog-assets" } }
      ]
    }
  }'
```

`mode` は `apply | plan | destroy` (省略時 `apply`)。`manifest` は `resources[]`
直書きと `template: { ref, inputs }` 展開のいずれか一方が必要です
([Templates](/reference/templates))。

成功 response (`status: "ok"`):

```ts
interface DeployPublicResponse {
  readonly status: "ok";
  readonly outcome: ApplyV2Outcome;
}

interface ApplyV2Outcome {
  readonly applied: readonly AppliedResource[];
  readonly issues: readonly TemplateValidationIssue[];
  readonly status: "succeeded" | "failed-validation" | "failed-apply" | "partial";
  readonly reused?: number;
}
```

`destroy` は `DeployPublicDestroyResponse` (`outcome: DestroyV2Outcome`) に
切り替わり、partial failure も `200` で返ってきます (caller は
`outcome.errors` を読む)。`destroy` は **prior record が無い場合は 409**
(`failed_precondition`) で拒否される点に注意 — 詳細は上記 route table。

### `POST /v1/artifacts`

multipart/form-data で `kind` (string) / `body` (file) / `metadata`
(JSON object string、optional) / `expectedDigest` (`sha256:<hex>`、optional)
を送ります。

```bash
curl -sS https://kernel.example.com/v1/artifacts \
  -H "Authorization: Bearer $TAKOSUMI_DEPLOY_TOKEN" \
  -F "kind=js-bundle" \
  -F "metadata={\"entrypoint\":\"index.js\"}" \
  -F "body=@./dist/worker.js"
```

response (`ArtifactStored`):

```ts
interface ArtifactStored {
  readonly hash: string;       // "sha256:<hex>" — kernel が再計算
  readonly kind: string;
  readonly size: number;
  readonly uploadedAt: string; // RFC 3339
  readonly metadata?: JsonObject;
}
```

`expectedDigest` を渡したときに kernel が再計算した hash と一致しない場合、
400 `invalid_argument` で `digest mismatch: expected ..., computed ...` が
返ります。

`GET /v1/artifacts` の paging は
`{ artifacts: ArtifactStored[]; nextCursor?: string }`、`?limit=` は
1〜1000、`?cursor=` は前回 response の `nextCursor` を渡してください。

## Error envelope

エラーはすべて
[`apiError`](https://github.com/tako0614/takosumi/blob/master/packages/kernel/src/api/errors.ts)
が組み立てる以下の形に正規化されます。

```ts
interface ApiErrorEnvelope {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly details?: unknown;
  };
}
```

`code` の代表値:

| Code                  | HTTP status | 主な発生元                                                            |
| --------------------- | ----------- | --------------------------------------------------------------------- |
| `invalid_argument`    | 400         | manifest / form 入力エラー、digest mismatch                           |
| `invalid_json`        | 400         | request body が JSON として parse できない                            |
| `unauthenticated`     | 401         | bearer 不足 / token mismatch / internal HMAC 検証失敗                  |
| `permission_denied`   | 403         | actor の space 越境、`WorkerAuthzService` / entitlements 拒否          |
| `not_found`           | 404         | endpoint disabled (token unset)、deployment / artifact 不在            |
| `failed_precondition` | 409         | `destroy` で prior record 不在、conflict                               |
| `resource_exhausted`  | 413         | artifact upload が `TAKOSUMI_ARTIFACT_MAX_BYTES` を超過                |
| `not_implemented`     | 501         | gateway-manifest issuer 未配線などの opt-in 機能                       |
| `readiness_probe_failed` | 503      | `/livez` / `/readyz` / `/status/summary` の probe failure              |
| `internal_error`      | 500         | unhandled exception (`Internal server error` を返す)                   |

`registerApiErrorHandler` が `DomainError` を catch して `code` →
HTTP status へ写像するため、ハンドラから `throw permissionDenied(...)` を
書けば envelope が自動で組み立てられます。

## Rate / size limits

- **Artifact body size**: `TAKOSUMI_ARTIFACT_MAX_BYTES` (default
  `52_428_800` = 50 MiB)。`Content-Length` (cheap pre-check) と buffered
  body length の両方が cap を超えると `413 resource_exhausted` を返します。
  Cloudflare Workers bundle と小規模 Lambda zip を意識した値で、operator は
  必要に応じて env を上げるか、外部 object storage (R2 / S3 / GCS) を
  configure し直してください。
- **Artifact list `?limit=`**: 1〜1000 の整数。default 100。
- **Artifact list `?cursor=`**: 直前 response の `nextCursor` を渡す。
- **Internal RPC clock skew**: 5 分 (`TAKOSUMI_INTERNAL_SIGNATURE_MAX_SKEW_MS`)。
  request id は `InMemoryReplayProtectionStore` で 5 分 TTL の replay
  protection を適用します。distributed kernel では SQL-backed store の
  inject を推奨。
- **Public API**: rate limit は kernel core では持たず、operator が
  reverse proxy / API gateway 側で適用する前提です
  ([Operator: Bootstrap](/operator/bootstrap))。

## 参考リンク

- [CLI Reference](/reference/cli) — `takosumi deploy --remote ... --token $T` の
  入口
- [Lifecycle Protocol](/reference/lifecycle) — apply / destroy / describe を
  内部でどう走らせるか
- [Runtime-Agent API](/reference/runtime-agent-api) — kernel が runtime-agent
  にどんな envelope を投げるか
- [Operator: Bootstrap](/operator/bootstrap) — env / secret 配置
- [Manifest (Shape Model)](/manifest) — `resources[]` / `template` の field
  定義
