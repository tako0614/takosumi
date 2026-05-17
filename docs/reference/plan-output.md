# Plan Output

> このページでわかること: deploy plan の出力形式と読み方。

本ページは、 `takosumi plan` と `POST /v1/deployments` の `mode: "plan"` が返す
**current public** な plan response を定義する。

current の public plan path は apply と同じ Shape + Provider 検証と reference
DAG 解決を使う。 ただしそれを dry-run モードで実行する。 public
DesiredSnapshot digest、 OperationPlan digest、 WAL idempotency tuple preview を
含む決定的な `operationPlanPreview` を返す。 WAL を書き込まず、 完全な内部
Risk / Approval ドキュメントもまだ公開しない。

## Request

Remote `takosumi plan <manifest>` posts the same deploy public envelope as
`deploy --dry-run`:

```json
{
  "mode": "plan",
  "manifest": {
    "apiVersion": "1.0",
    "kind": "Manifest",
    "metadata": { "name": "my-app" },
    "resources": []
  }
}
```

manifest envelope と template / resource 検証ルールは `mode: "apply"` と同じ。

## Success Shape

Successful public plan responses are JSON:

```ts
interface DeployPublicPlanResponse {
  readonly status: "ok";
  readonly outcome: PlanOutcome;
}

interface PlanOutcome {
  readonly applied: readonly [];
  readonly issues: readonly [];
  readonly status: "succeeded";
  readonly planned: readonly PlannedResource[];
  readonly operationPlanPreview: OperationPlanPreview;
}

interface PlannedResource {
  readonly name: string;
  readonly shape: string;
  readonly providerId: string;
  readonly op: "create";
}

interface OperationPlanPreview {
  readonly planId: string;
  readonly spaceId: string;
  readonly deploymentName?: string;
  readonly desiredSnapshotDigest: `sha256:${string}`;
  readonly operationPlanDigest: `sha256:${string}`;
  readonly walStages: readonly [
    "prepare",
    "pre-commit",
    "commit",
    "post-commit",
    "observe",
    "finalize",
  ];
  readonly operations: readonly OperationPlanPreviewOperation[];
}

interface OperationPlanPreviewOperation {
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
}
```

`planned[]` は reference DAG の順序を持つ。 producer resource は output を参照
する consumer の前に並ぶ。 `op` は現状常に `"create"`。 update / replace / no-op
diff は public plan surface でまだ公開していない。
`operationPlanPreview.operations[]` も同じ DAG 順で、 さらに operation 単位の
決定的 digest と WAL tuple key を持つ。

Example:

```json
{
  "status": "ok",
  "outcome": {
    "applied": [],
    "issues": [],
    "status": "succeeded",
    "planned": [
      {
        "name": "assets",
        "shape": "object-store@v1",
        "providerId": "@takos/aws-s3",
        "op": "create"
      }
    ],
    "operationPlanPreview": {
      "planId": "plan:...",
      "spaceId": "space:acme-prod",
      "deploymentName": "my-app",
      "desiredSnapshotDigest": "sha256:...",
      "operationPlanDigest": "sha256:...",
      "walStages": [
        "prepare",
        "pre-commit",
        "commit",
        "post-commit",
        "observe",
        "finalize"
      ],
      "operations": [
        {
          "operationId": "operation:...",
          "resourceName": "assets",
          "shape": "object-store@v1",
          "providerId": "@takos/aws-s3",
          "op": "create",
          "dependsOn": [],
          "desiredDigest": "sha256:...",
          "idempotencyKey": {
            "spaceId": "space:acme-prod",
            "operationPlanDigest": "sha256:...",
            "journalEntryId": "operation:..."
          }
        }
      ]
    }
  }
}
```

## Failure Shape

Validation failures return HTTP 400 from the public route:

```ts
interface DeployPublicPlanErrorResponse {
  readonly status: "error";
  readonly outcome: {
    readonly applied: readonly [];
    readonly issues: readonly ManifestIssue[];
    readonly status: "failed-validation";
  };
}

interface ManifestIssue {
  readonly path: string;
  readonly message: string;
}
```

不正な request body や envelope レベルの error は、 共通の API error envelope
([Kernel HTTP API](/reference/kernel-http-api) 参照) を返すことがある。

## Side-Effect Boundary

current public route では plan は副作用が無い。

- no provider `apply` / `destroy` call
- no runtime-agent lifecycle RPC
- no deployment record upsert
- no artifact GC root mutation
- no WAL / OperationJournal write

It does perform the same structural checks that apply needs before side effects:

- manifest v1 closed envelope validation
- Shape / Provider lookup
- Shape `validateSpec`
- provider capability subset check from `resources[].requires`
- reference grammar, output field, and cycle validation

## CLI Rendering

Remote `takosumi plan` は kernel response body を整形済 JSON で表示する。 Local
`takosumi plan` は in-process で同じ dry-run apply pipeline を走らせ、 同じ
`{ status, outcome }` envelope を表示する。 plan に対する current の global
`--json` / `--space` / `--fixed-clock` flag は無い。

## Internal-Only OperationPlan Fields

public な `operationPlanPreview` は決定的な preview であって、 実行 authority
ではない。 次のフィールドは依然として内部 OperationPlan / WAL アーキテクチャ
モデルに属し、 current public plan の出力には **含まれない**。

```text
predictedActualEffectsDigest
catalogReleaseId
risks[]
approvalBindings[]
actualEffects[]
journalCursor
```

これらを public 化する際は、 本リファレンスを route test、 OpenAPI、 CLI
rendering test、 migration note と同じ change set で更新する。

## Related architecture notes

- `docs/reference/architecture/operation-plan-write-ahead-journal-model.md`
- `docs/reference/architecture/policy-risk-approval-error-model.md`
- `docs/reference/architecture/snapshot-model.md`
- `docs/reference/architecture/execution-lifecycle.md`
- `docs/reference/architecture/manifest-model.md`

## 関連ページ

- [Kernel HTTP API](/reference/kernel-http-api)
- [CLI](/reference/cli)
- [Manifest Validation](/reference/manifest-validation)
- [DataAsset Kinds](/reference/artifact-kinds)
