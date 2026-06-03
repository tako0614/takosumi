# Deploy Control API

Deploy Control API is a bearer-token protected HTTP API. The reference fallback uses `TAKOSUMI_DEPLOY_CONTROL_TOKEN`;
when the token is unset, the routes are not exposed. Operators and account-planes can replace the bearer resolver with
a scoped principal carrying `actor`, `spaceIds`, `operations`, and `runnerProfileIds`. Scopes are default-deny:
omitted scopes grant no access. Mutations are authorized by `operations` and `runnerProfileIds`; reads are authorized by
the target record's `spaceId`. Takosumi rejects out-of-scope requests with `403 permission_denied`, records the actor on
API-originated audit events, and returns only the RunnerProfiles the principal can use from `GET /v1/runner-profiles`.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/v1/runner-profiles` | list RunnerProfiles |
| POST | `/v1/plan-runs` | create a PlanRun |
| GET | `/v1/plan-runs/{planRunId}` | fetch a PlanRun |
| POST | `/v1/apply-runs` | create an ApplyRun |
| GET | `/v1/apply-runs/{applyRunId}` | fetch an ApplyRun |
| GET | `/v1/installations/{installationId}` | fetch an Installation |
| GET | `/v1/installations/{installationId}/deployments` | list Deployments |
| GET | `/v1/installations/{installationId}/deployment-outputs` | list current outputs |

## Create PlanRun

```http
POST /v1/plan-runs
Authorization: Bearer <token>
Content-Type: application/json
```

`create` does not carry `installationId`. `update` and `destroy` require `installationId`. The Installation `spaceId`,
RunnerProfile, and source identity must match the request. For git sources the identity is `url` + `modulePath`; `ref`
and `commit` are version fields and may change during an update. Git source URLs must use `https://`, must not embed
credentials, and literal private / loopback / metadata IP hosts are rejected. `update` / `destroy` PlanRuns record the
`installationCurrentDeploymentId` observed at plan time and re-check the same pointer before apply. `local` sources are
accepted only when the selected RunnerProfile sets `sourcePolicy.allowLocalSource: true`. Prepared source URLs must also
use `https://`; prepared source `digest` values must use `sha256:<64 lowercase hex>`. The reference runner applies the
RunnerProfile `resourceLimits` wire / decompressed size caps and unsafe tar entry rejection to prepared sources.

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

`requiredProviders` declares the reviewed OpenTofu provider source addresses used by the module. When the RunnerProfile has a provider allowlist, this field is required before `tofu init`. The runner still reports the provider set observed from the plan / lockfile, and the controller re-checks policy against that observed set.

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

Build the ApplyRun request's expected guard from the PlanRun response. Destroy is not a separate public run type. Create a
PlanRun with `operation: "destroy"`, then submit the reviewed guard to the same `/v1/apply-runs` endpoint.

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

A mismatch returns `409 failed_precondition`. ApplyRun only passes the immutable plan artifact whose digest matches
`planArtifactDigest` to the runner. Accounts / dashboard facades do not fill in missing expected guard fields from the
PlanRun; callers carry the complete expected guard from the PlanRun response or facade review response to apply.
`installationId` and `currentDeploymentId` are present only for PlanRuns that update or destroy an existing
Installation.

Destroy PlanRun request:

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

When the matching ApplyRun succeeds, `applyRun.operation` is `"destroy"` and the Installation has
`currentDeploymentId: null` with `status: "destroyed"`.

## RunnerProfile Boundary

`GET /v1/runner-profiles` returns the execution boundaries enabled by the operator. In a Cloudflare profile, `substrate: "cloudflare-containers"` is the OpenTofu runner, while `cloudflareWorkersForPlatforms` is the tenant / user Worker dispatch runtime.

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

## Output Projection

`GET /v1/installations/{installationId}/deployment-outputs` returns only public outputs from the current Deployment.

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

## Error Envelope

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

Supported codes: `invalid_argument`, `unauthenticated`, `permission_denied`, `not_found`, `failed_precondition`, `resource_exhausted`, `not_implemented`, `internal_error`.
