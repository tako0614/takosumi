# Repository manifest

`.well-known/takosumi.json` is an optional document owned by a Git repository.
It proposes Takosumi metadata pinned to the same commit, but it is never
execution authority. Takosumi validates the document, compiles the current
`install` declaration into a DB-owned `InstallConfig`, and then uses the
ordinary compatibility, Plan, and Apply flow.

## Current wire

```json
{
  "apiVersion": "takosumi.com/v1",
  "kind": "Repository",
  "install": {
    "modules": {
      ".": {
        "inputs": [],
        "requires": []
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

A module proposes three things. `inputs` are the input names and display copy
the module owns, `requires` is what the application needs the host to provide
before it can run, and `features` groups optional inputs. It cannot declare a
Git source/ref, provider credentials, target, billing, lifecycle commands,
Interface grants, or arbitrary environment injection.

## requires is a request, never a value

The manifest is a public repository file, so a resolved secret or credential
must never appear in it. A requirement states only what is needed and the name
it wants to receive it under; producing and delivering the value is the host's
job. Takosumi validates each requirement against operator policy and compiles
it into its own DB-owned `InstallConfig` before any Plan can use it.

```json
{
  "kind": "secret.generated",
  "bytes": 32,
  "encoding": "base64url",
  "deliver": { "bindings": { "value": "ENCRYPTION_KEY" } }
}
```

The kinds are `identity.oidc`, `secret.generated`, and `http.endpoint`.

`deliver` names exactly one target surface. `variables` suits a module system
whose surface is input variables; `bindings` suits a portable runtime that has
no variable to receive the value. The requirement is identical either way —
only delivery differs.

`secret.generated` has no `variables` form, because the host never writes a
secret into portable module state. `http.endpoint` has no `bindings` form,
because an allocated hostname is the runtime location itself rather than a
value the host injects.

The line is whether host authority is needed. An ordinary non-secret string
belongs in the module's own configuration.

## Input roles

A `role` tells the installer what a field is. It never changes where the value
comes from (`source`). `service_name` marks the service-name field and
`initial_secret` marks the initial password field; each appears at most once
per module.

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
