# Deploy Control API

Deploy Control API は bearer token で保護された HTTP API です。reference fallback では token は `TAKOSUMI_DEPLOY_CONTROL_TOKEN` から供給されます。token 未設定の service は deploy control route を公開しません。operator / account-plane は bearer resolver を差し替えて、`actor`、`spaceIds`、`operations`、`runnerProfileIds` を持つ scoped principal を返せます。scope は default deny です。resolver が省略した scope は許可になりません。mutation は `operations` と `runnerProfileIds`、read は対象 record の `spaceId` で許可されます。Takosumi は scope 外の request を `403 permission_denied` にし、API 起点の audit event に actor を記録します。`GET /v1/runner-profiles` は principal が使える RunnerProfile だけを返します。

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/v1/runner-profiles` | operator が用意した RunnerProfile 一覧 |
| POST | `/v1/plan-runs` | PlanRun 作成 |
| GET | `/v1/plan-runs/{planRunId}` | PlanRun 取得 |
| POST | `/v1/apply-runs` | ApplyRun 作成 |
| GET | `/v1/apply-runs/{applyRunId}` | ApplyRun 取得 |
| GET | `/v1/installations/{installationId}` | Installation 取得 |
| GET | `/v1/installations/{installationId}/deployments` | Deployment ledger |
| GET | `/v1/installations/{installationId}/deployment-outputs` | current output projection |

## Create PlanRun

```http
POST /v1/plan-runs
Authorization: Bearer <token>
Content-Type: application/json
```

`create` は `installationId` を持ちません。`update` と `destroy` は `installationId` が必須です。Installation の `spaceId`、RunnerProfile、source identity が request と一致しない PlanRun は拒否されます。git source identity は `url` + `modulePath` で、`ref` / `commit` はversionとして更新できます。git source URL は `https://` のみ、credential 埋め込みは禁止、literal private / loopback / metadata IP host は拒否されます。`update` / `destroy` PlanRun は plan 時点の `installationCurrentDeploymentId` を記録し、apply 直前に同じ pointer であることを再検証します。`local` source は selected RunnerProfile が `sourcePolicy.allowLocalSource: true` を持つ場合だけ使えます。prepared source の URL も `https://` のみで、`digest` は `sha256:<64 lowercase hex>` 形式です。reference runner は RunnerProfile `resourceLimits` の wire / decompressed size cap と unsafe tar entry rejection を prepared source に適用します。

```json
{
  "spaceId": "space_personal",
  "source": {
    "kind": "git",
    "url": "https://github.com/example/module.git",
    "ref": "main",
    "modulePath": "."
  },
  "runnerProfileId": "cloudflare-container",
  "variables": {
    "name": "hello"
  },
  "requiredProviders": ["registry.opentofu.org/cloudflare/cloudflare"]
}
```

`requiredProviders` は reviewed OpenTofu module が使う provider source address の申告です。RunnerProfile が provider allowlist を持つ場合、この field は `tofu init` 前の必須契約になります。runner は plan / lockfile から観測した provider set を返し、controller は観測値でも policy を再評価します。

Response:

```json
{
  "planRun": {
    "id": "plan_01ABCDEF",
    "status": "succeeded",
    "runnerProfileId": "cloudflare-container",
    "sourceDigest": "sha256:...",
    "variablesDigest": "sha256:...",
    "policyDecisionDigest": "sha256:...",
    "planDigest": "sha256:...",
    "planArtifact": {
      "kind": "object-storage",
      "ref": "r2://takos-artifacts/opentofu-plan-runs/plan_01ABCDEF/tfplan",
      "digest": "sha256:..."
    },
    "policy": {
      "status": "passed",
      "reasons": [],
      "checkedAt": 1760000000000
    }
  }
}
```

## Create ApplyRun

ApplyRun request は PlanRun response から expected guard を作ります。destroy は独立した public run type ではなく、
`operation: "destroy"` の PlanRun を作ってから同じ `/v1/apply-runs` に渡します。

```json
{
  "planRunId": "plan_01ABCDEF",
  "approval": {
    "approvedBy": "user_123",
    "reason": "reviewed plan"
  },
  "expected": {
    "planRunId": "plan_01ABCDEF",
    "installationId": "ins_01ABCDEF",
    "currentDeploymentId": "dep_01ABCDEF",
    "runnerProfileId": "cloudflare-container",
    "sourceDigest": "sha256:...",
    "variablesDigest": "sha256:...",
    "policyDecisionDigest": "sha256:...",
    "planDigest": "sha256:...",
    "planArtifactDigest": "sha256:...",
    "sourceCommit": "0123456789abcdef0123456789abcdef01234567",
    "providerLockDigest": "sha256:..."
  }
}
```

`expected` が PlanRun と一致しない場合は `409 failed_precondition` です。ApplyRun は `planArtifactDigest` が一致した immutable plan artifact だけを runner に渡します。Accounts / dashboard facade も PlanRun から expected guard を補完しません。PlanRun response または facade のreview responseに含まれる expected guard 全体を apply request に持ち越します。`installationId` と `currentDeploymentId` は existing Installation を更新またはdestroyするPlanRunだけに入ります。

Destroy:

```json
{
  "spaceId": "space_personal",
  "installationId": "ins_01ABCDEF",
  "source": {
    "kind": "git",
    "url": "https://github.com/example/module.git",
    "ref": "main",
    "modulePath": "."
  },
  "operation": "destroy",
  "runnerProfileId": "cloudflare-container",
  "requiredProviders": ["registry.opentofu.org/cloudflare/cloudflare"]
}
```

この PlanRun が成功したら通常の ApplyRun request と同じ expected guard で `/v1/apply-runs` を呼びます。返却される
`applyRun.operation` は `"destroy"` になり、成功時は Installation の `currentDeploymentId` が `null`、
`status` が `"destroyed"` になります。

## RunnerProfile boundary

`GET /v1/runner-profiles` は operator が有効化した execution boundary を返します。Cloudflare profile では `substrate: "cloudflare-containers"` が OpenTofu runner で、`cloudflareWorkersForPlatforms` は tenant / user Worker の dispatch runtime です。

```json
{
  "runnerProfiles": [
    {
      "id": "cloudflare-default",
      "substrate": "cloudflare-containers",
      "cloudflareWorkersForPlatforms": {
        "dispatchNamespace": "takosumi-tenants",
        "outboundWorker": {
          "enforceNetworkPolicy": true
        }
      },
      "secretExposurePolicy": {
        "providerCredentials": "runner-only",
        "tenantWorkerOperatorSecrets": "forbidden",
        "redactLogs": true,
        "blockSensitiveOutputs": true
      }
    },
    {
      "id": "aws-default",
      "substrate": "cloudflare-containers",
      "allowedProviders": ["registry.opentofu.org/hashicorp/aws"],
      "labels": {
        "takosumi.com/profile-state": "template"
      },
      "networkPolicy": {
        "mode": "egress-allowlist",
        "allowedHosts": ["sts.amazonaws.com", "iam.amazonaws.com"],
        "allowedHostPatterns": ["*.amazonaws.com", "*.api.aws"]
      }
    }
  ]
}
```

## Output projection

`GET /v1/installations/{installationId}/deployment-outputs` は current Deployment の public output だけを返します。

```json
{
  "outputs": [
    {
      "name": "launch_url",
      "kind": "launch_url",
      "value": "https://example.com",
      "sensitive": false
    }
  ]
}
```

## Error envelope

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

Supported codes: `invalid_argument`, `unauthenticated`, `permission_denied`, `not_found`, `failed_precondition`, `resource_exhausted`, `not_implemented`, `internal_error`。
