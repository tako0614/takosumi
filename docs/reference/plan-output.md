# Plan Output

> Stability: stable Audience: integrator, kernel-implementer See also:
> [Kernel HTTP API](/reference/kernel-http-api), [CLI](/reference/cli),
> [Manifest Validation](/reference/manifest-validation),
> [DataAsset Kinds](/reference/artifact-kinds)

This page defines the **current public** plan response returned by
`takosumi plan` and `POST /v1/deployments` with `mode: "plan"`.

The current public plan path uses the same Shape + Provider validation and
reference DAG resolution as apply, but runs it in dry-run mode. It returns a
deterministic `operationPlanPreview` with the public DesiredSnapshot digest,
OperationPlan digest, and WAL idempotency tuple preview. It does **not** write
the WAL or expose the full internal Risk / Approval document yet.

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

The manifest envelope and template/resource validation rules are the same as
`mode: "apply"`.

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

`planned[]` is ordered by the reference DAG, so a producer resource appears
before a consumer that references its outputs. `op` is currently always
`"create"`; update / replace / no-op diffing is not exposed by the public plan
surface yet. `operationPlanPreview.operations[]` uses the same DAG order and
adds deterministic per-operation digests and WAL tuple keys.

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

Malformed request bodies and envelope-level errors may instead use the common
API error envelope documented in [Kernel HTTP API](/reference/kernel-http-api).

## Side-Effect Boundary

Plan is side-effect free in the current public route:

- no provider `apply` / `destroy` call
- no runtime-agent lifecycle RPC
- no deployment record upsert
- no artifact GC root mutation
- no WAL / OperationJournal write

It does perform the same structural checks that apply needs before side effects:

- manifest v1 closed envelope validation
- template expansion
- Shape / Provider lookup
- Shape `validateSpec`
- provider capability subset check from `resources[].requires`
- reference grammar, output field, and cycle validation

## CLI Rendering

Remote `takosumi plan` prints the kernel response body as formatted JSON. Local
`takosumi plan` runs the same dry-run apply pipeline in process and prints the
same `{ status, outcome }` envelope. There is no current global `--json`,
`--space`, or `--fixed-clock` flag for plan.

## Internal-Only OperationPlan Fields

The public `operationPlanPreview` is a deterministic preview, not execution
authority. The following fields still belong to the internal OperationPlan / WAL
design model and are **not** current public plan output:

```text
predictedActualEffectsDigest
catalogReleaseId
risks[]
approvalBindings[]
actualEffects[]
journalCursor
```

When these fields become public, this reference must be updated together with
route tests, OpenAPI, CLI rendering tests, and migration notes.

## Related design notes

- `docs/design/operation-plan-write-ahead-journal-model.md`
- `docs/design/policy-risk-approval-error-model.md`
- `docs/design/snapshot-model.md`
- `docs/design/execution-lifecycle.md`
- `docs/design/manifest-model.md`
