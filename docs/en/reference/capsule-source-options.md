# Capsule Source Options

`CapsuleSourceOptions` is an optional public JSON document that presents multiple ordinary Git Capsule sources behind one install link. It is not a Takosumi source manifest, composition DSL, or dependency graph. Selecting an option always hands off to the ordinary `/new` flow, which remains authoritative for source authentication, compatibility checking, Provider Bindings, Plan, and Apply.

## Install link

```text
https://<operator>/install?kind=capsule-source-options&git=<document-git-url>&path=<document-path>[&ref=<explicit-git-ref>]
```

- `git` is a public HTTPS Git URL without embedded credentials.
- `path` is a safe relative JSON path in that repository.
- An explicit `ref` is source-synced as an exact ordinary Git ref.
- When `ref` is omitted, the runner resolves the highest stable SemVer tag with `git ls-remote --tags`. Only `vX.Y.Z` and `X.Y.Z` are accepted. There is no fallback to prereleases, build metadata, HEAD, a default branch, or a forge API. Both spellings for the same version are ambiguous and fail closed.

The resolver returns only the tag and immutable commit. The chooser source-syncs the commit, so a later tag movement cannot change the document being reviewed.

## Closed document

```json
{
  "apiVersion": "install.takosumi.com/v1alpha1",
  "kind": "CapsuleSourceOptions",
  "metadata": {
    "name": "example-starters",
    "title": "Choose a service"
  },
  "options": [
    {
      "id": "basic",
      "title": "Basic",
      "source": {
        "url": "https://github.com/example/basic.git",
        "path": "deploy/opentofu"
      }
    },
    {
      "id": "advanced",
      "title": "Advanced",
      "source": {
        "url": "https://github.com/example/advanced.git",
        "ref": "v2.1.0",
        "path": "."
      }
    }
  ]
}
```

`options` contains 1 to 32 entries and each `id` is unique. The root, metadata, option, and source objects are closed. Credentials, provider configuration, region, pricing, capacity, Interfaces, dependencies, policy, and automatic-install declarations are forbidden. An option without `ref` is also pinned through the stable SemVer resolver before the `/new` handoff.

## Immutable evidence and API

The chooser reads a regular UTF-8 JSON file of at most 128 KiB from the exact `SourceSnapshot` through the runner boundary and presents:

- the document Git URL and requested ref or resolved tag;
- the immutable commit and file path;
- a `sha256:` digest of the exact file bytes and its byte size.

The account-session API exposes:

```text
POST /api/v1/workspaces/:workspaceId/source-ref-resolutions/stable-semver
GET  /api/v1/sources/:sourceId/snapshots/:sourceSnapshotId/file?path=...
```

Both require authentication and Workspace authorization. The operator-bearer internal seam exposes the same suffixes under `/internal/v1`. The file reader verifies Source/SourceSnapshot ownership and rejects traversal, symlinks, non-regular files, oversized files, and invalid UTF-8.
