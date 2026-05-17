# Status Output

> このページでわかること: resource status の出力形式と conditions の読み方。

本ページは、 `GET /v1/deployments` と `GET /v1/deployments/:name` が返す current
public な status response を定義する。 `takosumi status` CLI はこの response
を小さなテーブルとして描画する。

Status query は read-only。 WAL entry を書かず、 deployment record を mutate
せず、 runtime-agent lifecycle endpoint を呼ばず、 artifact GC root を変えない。

## List Shape

`GET /v1/deployments` returns:

```ts
interface DeploymentListResponse {
  readonly deployments: readonly DeploymentSummary[];
}
```

リストは deploy bearer に対して選ばれた public deploy Space / tenant で scope
される。 その scope は `TAKOSUMI_DEPLOY_SPACE_ID`、 または env が未設定の場合
`takosumi-deploy` となる。 current public route は `--space`、 `--group`、
`--kind`、 `--since`、 `--cursor`、 `--limit` の CLI filter を公開しない。
より広範な operator status、 activation history、 drift、 quota 使用、 approval
queue は、 public route が実装・テストされるまで内部 control plane surface に
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

Destroyed record は deployment-level summary を保ったまま、 空の `resources`
配列を返す。

`id` は public deploy record id。 natural key は `(tenantId, name)` のまま
なので、 既存の status URL は引き続き `name` を使う。 `takosumi audit show <id>`
は list endpoint で id を `name` に解決してから audit detail を fetch する。

`provenance` は、 存在する場合、 public deploy WAL entry に記録された最新の
opaque JSON object。 `takosumi-git` のような upstream client は、 deploy された
manifest を生んだ workflow run id、 git commit SHA、 artifact URI、 step log
digest chain をこの field で見せる。 status route は audit consumer 向けに
返すが、 `takosumi status` テーブルは deployment id のみを表示し、 生の
provenance JSON は表示しない。

## CLI Rendering

`takosumi status` is remote-only. name 引数なしでは `GET /v1/deployments` を、
name 引数ありでは `GET /v1/deployments/:name` を呼ぶ。

テーブルの列は次の通り。

```text
deployment | id | resource | shape | provider | status | journal
```

deployment に resource が無い場合でも、 CLI は deployment-level status を運ぶ 1
行を出力する。 destroyed / failed record も可視のままになる。 `journal` 列は
最新の public WAL summary を `<phase>:<latestStage>/<status>` 形式で描画する。
例: `apply:finalize/succeeded` / `destroy:abort/failed`。 `journal` を返さない
古い kernel ではこの列が空になる。

## Error Behaviour

- Deploy token unset: route returns `404 not_found`
- Missing / wrong bearer: route returns `401 unauthenticated`
- Deployment name does not exist: `GET /v1/deployments/:name` returns
  `404 not_found`
- CLI has no remote URL: `takosumi status` exits with a local-mode precondition
  message

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
