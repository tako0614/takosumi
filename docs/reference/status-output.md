# Status Output

> このページでわかること: resource status の出力形式と conditions の読み方。

本ページは、`GET /v1/deployments` と `GET /v1/deployments/:name` が返す current
public な status response を定義する。`takosumi status` CLI はこの response
を小さなテーブルとして描画する。

Status queries are read-only. They do not write WAL entries, mutate deployment
records, call runtime-agent lifecycle endpoints, or change artifact GC roots.

## List Shape

`GET /v1/deployments` returns:

```ts
interface DeploymentListResponse {
  readonly deployments: readonly DeploymentSummary[];
}
```

リストは deploy bearer に対して選ばれた public deploy Space / tenant で scope
される。その scope は `TAKOSUMI_DEPLOY_SPACE_ID`、または env が未設定の場合
`takosumi-deploy` となる。current public route は `--space`、`--group`、
`--kind`、`--since`、`--cursor`、`--limit` の CLI filter を公開しない。
より広範な operator status、activation history、drift、quota 使用、approval
queue は、public route が実装・テストされるまで内部 control plane surface に
属する。

## Single Shape

`GET /v1/deployments/:name` returns one `DeploymentSummary`:

```ts
type JsonObject = Record<string, unknown>;

interface DeploymentSummary {
  readonly id: string;
  readonly name: string;
  readonly status: "applied" | "failed" | "destroyed";
  readonly tenantId: string;
  readonly appliedAt: string; // RFC3339 UTC, creation timestamp for the record
  readonly updatedAt: string; // RFC3339 UTC
  readonly provenance?: JsonObject;
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

`id` is the public deploy record id. The natural key remains `(tenantId, name)`,
so existing status URLs continue to use `name`; `takosumi audit show <id>` uses
the list endpoint to resolve the id back to `name` before fetching audit detail.

`provenance`, when present, is the latest opaque JSON object recorded in public
deploy WAL entries. Upstream clients such as `takosumi-git` use it to expose the
workflow run id, git commit SHA, artifact URI, and step log digest chain that
produced the deployed manifest. The status route returns it for audit consumers;
the `takosumi status` table renders only the deployment id and does not render
the raw provenance JSON.

## CLI Rendering

`takosumi status` is remote-only. Without a name, it calls
`GET /v1/deployments`; with a name, it calls `GET /v1/deployments/:name`.

テーブルの列は次の通り。

```text
deployment | id | resource | shape | provider | status | journal
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
      "id": "deployment:123",
      "status": "applied",
      "tenantId": "takosumi-deploy",
      "appliedAt": "2026-05-01T00:00:00.000Z",
      "updatedAt": "2026-05-01T00:00:00.000Z",
      "provenance": {
        "kind": "takosumi-git.deployment-provenance@v1",
        "workflowRunId": "takosumi-git:run:01J00000000000000000000000",
        "git": {
          "commitSha": "0123456789abcdef0123456789abcdef01234567"
        },
        "resourceArtifacts": [
          {
            "resourceName": "assets",
            "artifactName": "image",
            "artifactUri": "ghcr.io/example/demo@sha256:0123456789abcdef",
            "stepLogs": [
              {
                "stepName": "build",
                "exitCode": 0,
                "stdoutDigest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                "stdoutBytes": 128
              }
            ]
          }
        ]
      },
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

## 関連ページ

- [CLI](/reference/cli)
- [Kernel HTTP API](/reference/kernel-http-api)
- [Manifest Validation](/reference/manifest-validation)
- [Artifact GC](/reference/artifact-gc)
