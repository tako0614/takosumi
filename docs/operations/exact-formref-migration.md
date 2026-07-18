# Exact FormRef migration and replay

This runbook covers the operator-only migration from pre-FormRef Resource rows
to one exact installed `FormRef` + `packageDigest` pair. It does not change the
Resource id, import id, native object, or lifecycle authority.

## Preconditions

- the reviewed control schema is applied (D1 v46 or Postgres v94 or later);
- the exact signed package and definition are retained in the Form Registry;
- exactly one reviewed active `FormActivation` is selected for the target kind
  and scope;
- the host has an explicit Workspace-to-Resource-Space authorization mapping;
- an immutable control backup was captured before the first non-dry-run page.

Never derive a FormRef from `latest`, kind alone, or a caller-selected Space.
The internal route derives the Space from the host mapping and the actor from
the deploy-control bearer.

## Bounded dry run

Use the operator deploy-control URL and keep the bearer outside repository
files and shell history. The body contains no credentials or Resource values.

```http
POST /internal/v1/workspaces/{workspaceId}/migrations/resource-form-pins/backfill
Authorization: Bearer <operator token>
Content-Type: application/json

{
  "kind": "ObjectBucket",
  "activationIds": ["activation_exact_object_bucket"],
  "dryRun": true,
  "limit": 100
}
```

Require `refused = 0` and review every `would_pin` row. The response contains
only Resource id, kind, outcome/reason, activation id, and the exact installed
identity key. It contains no spec, Output, target, NativeResource value, or
credential. If `nextCursor` is present, echo it in the next request and keep
the same reviewed activation set.

## Apply

Repeat the same bounded request with `dryRun` omitted or `false`. Stop on the
first refused row or unexpected count. Every successful row atomically pins
both Resource and ResolutionLock and emits an idempotent redacted activity
event. Retry of the same page is safe and reports `already_pinned`; a
substituted identity or concurrent Resource/lock change fails closed.

After the last page:

1. read the Resource and ResolutionLock and compare their exact identity;
2. run observe/refresh without backend recreation;
3. verify the canonical direct-operation Run/result and NativeResource
   evidence carry the same pair;
4. retain the package and definition even if the activation is later disabled
   or the package is deprecated/revoked.

## Isolated backup replay drill

Do not down-migrate or clear exact pins. Restore the control backup into an
isolated target, then obtain the redacted `resourceFormPins` sidecar from the
operator backup tooling. Replay one bounded page:

```http
POST /internal/v1/workspaces/{workspaceId}/migrations/resource-form-pins/restore
Authorization: Bearer <operator token>
Content-Type: application/json

{
  "entries": [
    {
      "resourceId": "tkrn:...",
      "resourceScopeId": "...",
      "kind": "ObjectBucket",
      "identity": {
        "formRef": {
          "apiVersion": "forms.takoform.com/v1alpha1",
          "kind": "ObjectBucket",
          "definitionVersion": "...",
          "schemaDigest": "sha256:..."
        },
        "packageDigest": "sha256:..."
      }
    }
  ],
  "limit": 100
}
```

Replay verifies retained package/definition bytes and atomically writes only
the exact pair onto an existing coherent Resource/ResolutionLock. It never
invokes resolution or a backend adapter. A scope mismatch, missing lock,
unverifiable retained package, or concurrent change is refused.

Record source commit, schema manifest digest, backup id/time, activation id,
page cursors/counts, response digests, post-replay read/observe result, and the
isolated-target teardown in operator-private evidence. Live staging replay is
the release gate; repository tests alone are not live rollback evidence.
