# Installer API {#installer-api}

The public Installer API is a manifestless Source / Installation / Deployment lifecycle.

```text
POST /v1/installations/dry-run
POST /v1/installations
POST /v1/installations/{id}/deployments/dry-run
POST /v1/installations/{id}/deployments
POST /v1/installations/{id}/rollback
```

Dry-run returns an `InstallPlan` snapshot. Apply persists `Installation` and `Deployment` records. List/get/history
routes are operator-owned read models.

## Source

```json
{ "kind": "git", "url": "https://github.com/example/notes", "ref": "v1.2.3" }
```

```json
{ "kind": "prepared", "url": "https://source.example/notes.tar.gz", "digest": "sha256:..." }
```

```json
{ "kind": "local", "url": "/workspace/notes" }
```

## Dry-run

```json
{
  "spaceId": "space_personal",
  "source": {
    "kind": "git",
    "url": "https://github.com/example/notes",
    "ref": "v1.2.3"
  },
  "bindings": [
    { "name": "db", "serviceKind": "postgres", "labels": { "tier": "primary" }, "required": true }
  ]
}
```

Response:

```json
{
  "planSnapshotDigest": "sha256:...",
  "installPlan": {
    "repo": { "id": "notes", "name": "notes" },
    "requestedBindings": [],
    "resolvedBindings": [],
    "publications": [],
    "changes": [],
    "warnings": []
  },
  "expected": {
    "commit": "abc123",
    "planSnapshotDigest": "sha256:..."
  }
}
```

## Apply

Pass `expected.planSnapshotDigest` when applying a reviewed dry-run. Mismatches return 409 `failed_precondition`.

## Rollback

Rollback moves the Installation current pointer to a retained Deployment. It does not create a new Deployment.

## Errors

| HTTP | code | Example |
| --- | --- | --- |
| 400 | `invalid_argument` | Invalid source or binding shape |
| 401 | `unauthenticated` | Missing or invalid token |
| 403 | `permission_denied` | Insufficient Space scope |
| 404 | `not_found` | Installation or rollback target missing |
| 409 | `failed_precondition` | Source pin, current pointer, or `planSnapshotDigest` mismatch |
| 413 | `resource_exhausted` | Source or request too large |
