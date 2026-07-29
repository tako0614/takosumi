# Repository manifest

`.well-known/takosumi.json` is an optional document owned by a Git repository.
It proposes Takosumi metadata pinned to the same commit, but it is never
execution authority. Takosumi validates the document, compiles the current
`install` declaration into a DB-owned `InstallConfig`, and then uses the
ordinary compatibility, Plan, and Apply flow.

## Current wire

```json
{
  "apiVersion": "takosumi.com/v1alpha1",
  "kind": "Repository",
  "install": {
    "modules": {
      ".": {
        "inputs": []
      }
    }
  }
}
```

The root is closed. The current version accepts only `apiVersion`, `kind`, and
`install`; `install` accepts only `modules`. It rejects `$schema` and the
retired install-only `schemaVersion: takosumi.install-ux/v1`. A future metadata
section requires a new `apiVersion`; unknown fields continue to fail closed.
Do not publish empty placeholder sections.

Each module may propose only its own input names, display copy, supported
semantic projections, and optional feature grouping. It cannot declare a Git
source/ref, provider credentials, target, billing, lifecycle commands,
Interface grants, or arbitrary environment injection.

## Ownership

- The app repository owns `.well-known/takosumi.json` and its application
  vocabulary.
- Takosumi owns the schema/parser, policy, same-`SourceSnapshot` validation,
  and `InstallConfig` compilation.
- Source sync stores and exposes the exact whole-file digest and validation
  status as `SourceSnapshot.repositoryManifest`; it does not expose the raw
  document.
- The DB-owned `InstallConfig` is the reviewed Plan/Run input. Takosumi does
  not re-read the repository manifest at execution time.
- A TCS Store listing owns discovery and browse presentation only; it cannot
  supply this manifest's install declarations.

The root `install-options.json` is a separate optional contract. It uses
`apiVersion: install.takosumi.com/v1alpha1` and
`kind: CapsuleSourceOptions` to choose one ordinary Capsule source. It must not
duplicate inputs or an `InstallConfig`.
