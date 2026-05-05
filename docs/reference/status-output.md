# Status Output

> Stability: stable Audience: operator See also: [CLI](/reference/cli),
> [Kernel HTTP API](/reference/kernel-http-api),
> [Manifest Validation](/reference/manifest-validation),
> [Artifact GC](/reference/artifact-gc)

This page defines the current public status response returned by
`GET /v1/deployments` and `GET /v1/deployments/:name`. The `takosumi status` CLI
renders this response as a small table.

Status queries are read-only. They do not write WAL entries, mutate deployment
records, call runtime-agent lifecycle endpoints, or change artifact GC roots.

## List Shape

`GET /v1/deployments` returns:

```ts
interface DeploymentListResponse {
  readonly deployments: readonly DeploymentSummary[];
}
```

The list is scoped by the public deploy Space / tenant selected for the deploy
bearer. That scope is `TAKOSUMI_DEPLOY_SPACE_ID`, or `takosumi-deploy` when the
env var is unset. The current public route does not expose `--space`, `--group`,
`--kind`, `--since`, `--cursor`, or `--limit` CLI filters. Broader operator
status, activation history, drift, quota usage, and approval queues belong to
the internal control-plane surface until a public route is implemented and
tested.

## Single Shape

`GET /v1/deployments/:name` returns one `DeploymentSummary`:

```ts
interface DeploymentSummary {
  readonly name: string;
  readonly status: "applied" | "failed" | "destroyed";
  readonly tenantId: string;
  readonly appliedAt: string; // RFC3339 UTC, creation timestamp for the record
  readonly updatedAt: string; // RFC3339 UTC
  readonly journal?: DeploymentJournalSummary;
  readonly resources: readonly DeploymentResourceSummary[];
}

interface DeploymentJournalSummary {
  readonly operationPlanDigest: `sha256:${string}`;
  readonly phase:
    | "apply"
    | "activate"
    | "destroy"
    | "rollback"
    | "recovery"
    | "observe";
  readonly latestStage:
    | "prepare"
    | "pre-commit"
    | "commit"
    | "post-commit"
    | "observe"
    | "finalize"
    | "abort"
    | "skip";
  readonly status: "recorded" | "succeeded" | "failed" | "skipped";
  readonly entryCount: number;
  readonly failedEntryCount: number;
  readonly terminal: boolean;
  readonly updatedAt: string; // RFC3339 UTC
}

interface DeploymentResourceSummary {
  readonly name: string;
  readonly shape: string; // e.g. "object-store@v1"
  readonly provider: string; // e.g. "@takos/aws-s3" or persisted provider id
  readonly status: "applied";
  readonly outputs: Record<string, unknown>;
  readonly handle: string;
}
```

Destroyed records keep the deployment-level summary but return an empty
`resources` array.

## CLI Rendering

`takosumi status` is remote-only. Without a name, it calls
`GET /v1/deployments`; with a name, it calls `GET /v1/deployments/:name`.

The table columns are:

```text
deployment | resource | shape | provider | status | journal
```

When a deployment has no resources, the CLI still emits one row carrying the
deployment-level status so destroyed or failed records remain visible. The
`journal` column renders the latest public WAL summary as
`<phase>:<latestStage>/<status>`, for example `apply:finalize/succeeded` or
`destroy:abort/failed`. Older kernels that do not return `journal` render this
column empty.

## Error Behaviour

| Condition                      | HTTP / CLI behaviour                                           |
| ------------------------------ | -------------------------------------------------------------- |
| Deploy token unset             | route returns `404 not_found`                                  |
| Missing / wrong bearer         | route returns `401 unauthenticated`                            |
| Deployment name does not exist | `GET /v1/deployments/:name` returns `404 not_found`            |
| CLI has no remote URL          | `takosumi status` exits with a local-mode precondition message |

## Example

```json
{
  "deployments": [
    {
      "name": "my-app",
      "status": "applied",
      "tenantId": "takosumi-deploy",
      "appliedAt": "2026-05-01T00:00:00.000Z",
      "updatedAt": "2026-05-01T00:00:00.000Z",
      "journal": {
        "operationPlanDigest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "phase": "apply",
        "latestStage": "finalize",
        "status": "succeeded",
        "entryCount": 6,
        "failedEntryCount": 0,
        "terminal": true,
        "updatedAt": "2026-05-01T00:00:03.000Z"
      },
      "resources": [
        {
          "name": "assets",
          "shape": "object-store@v1",
          "provider": "@takos/aws-s3",
          "status": "applied",
          "outputs": {
            "bucket": "my-app-assets"
          },
          "handle": "arn:aws:s3:::my-app-assets"
        }
      ]
    }
  ]
}
```
