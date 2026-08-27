# Repository manifest

`.well-known/takosumi.json` is the optional repository manifest for
install-input assistance. It also declares requests for generic
Takosumi-provided APIs/capabilities and their exact delivery targets. It is
owned by a Git repository and pinned to the same commit as the executable
source, but it is never source, provider, resource,
deployment, or lifecycle authority. A plain Git/OpenTofu app remains
installable without this file. Source sync validates the repository-root file
as UTF-8 JSON of at most 128 KiB and records its status and digest in the
immutable `SourceSnapshot.repositoryManifest`. Public APIs never return the raw
document.

The app-owned Git/OpenTofu configuration remains the infrastructure and
lifecycle authority. Takosumi owns the implementation of each accepted generic
API/capability; the manifest only requests it and maps its delivered values to
the app-owned module.

Takosumi checks the exact SourceSnapshot declaration against an exact
compatibility report and compiles it within operator policy into a DB-owned
`InstallConfig`. Plan and Run consume that persisted InstallConfig; they do not
re-read the manifest.

## Versions and closed objects

Every version has exactly three root fields:

```json
{
  "apiVersion": "takosumi.com/v2.3",
  "kind": "Repository",
  "install": {}
}
```

| `apiVersion`        | `install` fields            | module fields                               |
| ------------------- | --------------------------- | ------------------------------------------- |
| `takosumi.com/v1`   | `modules`                   | `inputs`, `requires`, `features`            |
| `takosumi.com/v2`   | `modules`                   | v1 + `interfaces`                           |
| `takosumi.com/v2.1` | `modules`, `defaultModule`? | identical to v2                             |
| `takosumi.com/v2.2` | `modules`, `defaultModule`? | v2.1 + `requires[].kind: interface.consume` |
| `takosumi.com/v2.3` | `modules`, `defaultModule`? | v2.2 + optional `sourceBuild`               |

Every object is closed. Fields not listed in this document, `$schema`, and the
retired `schemaVersion: takosumi.install-ux/v1` are rejected. Adding
`defaultModule` to a v1 or v2 document does not make it v2.1.

The published JSON Schemas are
[`repository-manifest-v2.1.schema.json`](/schemas/repository-manifest-v2.1.schema.json)
and
[`repository-manifest-v2.2.schema.json`](/schemas/repository-manifest-v2.2.schema.json)
and
[`repository-manifest-v2.3.schema.json`](/schemas/repository-manifest-v2.3.schema.json).
It is a structural schema, not a claim of JSON Schema/parser equivalence. The
canonical parser additionally fails closed on constraints that require
cross-field or value-aware inspection: uniqueness across related declarations,
equality between `defaultModule` and a dynamic object key, recursive JSON depth
(maximum 32), and the secret/authority vocabulary checks described below.

## Module paths and default selection

`install.modules` contains 1–32 entries. A key is `.` or a canonical
repository-relative path of at most 1,024 characters. Absolute paths, `./`
prefixes, drive prefixes, a trailing slash, backslashes, NUL, empty segments,
and `.` or `..` segments are invalid.

For a Store URL-only `compileInstallUx`, the client initially sends no
`modulePath`. After source sync, the authenticated
`GET /api/v1/sources/{sourceId}/snapshots/{sourceSnapshotId}/install-modules`
projection exposes only the manifest's module directory keys. A multi-module
response is shown as a chooser (with `defaultModule` preselected, but never
implicitly confirmed); one module may be selected automatically. Compatibility
is called only after that selection boundary. The server then selects from the
exact SourceSnapshot manifest, runs compatibility for that exact path, and
persists the same path in the derived InstallConfig:

Direct Git and repository-owned source options use the same `compileInstallUx`
flow and may send their selected `modulePath`. The server validates that path
as an exact `install.modules` key in the immutable SourceSnapshot manifest;
Store metadata and DB-owned deployment-profile rows never select executable
module, provider, or policy behavior. Historical profile rows are not a
source-URL catalog; repository installs use the generic host policy (or an
operator-explicit generic configuration) together with the manifest selection.

The install-modules response is a bounded projection with `status`, the exact
`sourceSnapshotId`, optional `manifestDigest`/`defaultModule`, and
`modules: [{ path, default? }]`. It never returns manifest inputs, provider
requirements, policy, or individual `.tf` files. `absent` and `invalid`
responses contain no candidates; an explicit path against either response is a
typed fail-closed 4xx. This endpoint is account-session authenticated and
checks both Source Workspace access and the exact SourceSnapshot-to-Source
relationship.

1. If `modules` has one entry, select its only key.
2. Multiple entries require `install.defaultModule` in `takosumi.com/v2.1`,
   `takosumi.com/v2.2`, or `takosumi.com/v2.3`.
3. `defaultModule` must be canonical and byte-for-byte equal to an own
   `modules` key.

Takosumi never guesses `.`, the first JSON object key, a path from
`.well-known/tcs.json`, `Source.defaultPath`, or a base
`InstallConfig.modulePath`. A missing or invalid default returns a typed
diagnostic before compatibility runs. A plain Git compile request that omits
the path may continue through the existing generic `Source.defaultPath`
fallback. An explicit path on `compileInstallUx` is fail-closed unless it is
proven as an own key of a present, valid immutable manifest; an absent or
invalid manifest cannot grant that authority and returns a typed 4xx. Ordinary
manual (non-compile) Git compatibility requests may continue to supply an
explicit `modulePath`.

### Valid multi-module v2.1 example

```json
{
  "apiVersion": "takosumi.com/v2.1",
  "kind": "Repository",
  "install": {
    "defaultModule": "deploy/takoform",
    "modules": {
      ".": { "inputs": [] },
      "deploy/takoform": { "inputs": [] }
    }
  }
}
```

## `inputs`

Each module has a required `inputs` array with at most 128 entries. Every entry
is closed:

| field         | required | meaning                                         |
| ------------- | -------- | ----------------------------------------------- |
| `name`        | yes      | exact OpenTofu variable name                    |
| `source`      | yes      | an object containing only `kind`                |
| `label`       | yes      | non-empty `{ "ja", "en" }` text                 |
| `role`        | no       | `service_name` / `initial_secret`               |
| `type`        | no       | `string` / `number` / `boolean` / `json`        |
| `format`      | no       | bounded presentation token                      |
| `required`    | no       | boolean                                         |
| `helper`      | no       | `{ "ja", "en" }` text                           |
| `placeholder` | no       | non-empty bounded text                          |
| `advanced`    | no       | boolean                                         |
| `secret`      | no       | route user input through secret materialization |

`source.kind` is one of `user`, `capsule_name`,
`workspace_scoped_capsule_name`, or `module_default`. Only `user` may set
`secret: true`; `module_default` cannot set `required: true`. A plain `env` map
cannot be exposed as a secret or `initial_secret`. Input names and roles are
unique within a module and identifier strings are canonical: leading or
trailing whitespace is rejected rather than silently trimmed. Adoption requires
the compatibility report to prove the exact variable, type, and default
presence. Public label/helper/placeholder text is scanned for known
credential-like material; ordinary prose such as “Use a token value” remains
valid.

## `requires`

`requires` is optional and has at most 16 entries. It proposes a host need and
delivery names, never a value or credential.

- `secret.generated`: `kind`, optional `bytes` (16–64), optional `encoding`
  (`hex` / `base64url`), and `deliver`; at most eight per module.
- `http.endpoint`: `kind` and `deliver`.
- `identity.oidc`: `kind`, a root-relative `callbackPath`, 1–16 `scopes`, and
  `deliver`.
- `interface.consume` (v2.2): `kind`, a module-unique `key`, exact
  `interface.type` / `interface.version`, 1–16 `permissions`, and a `delivery`
  object containing only `{ "type": token }`.

`deliver` contains exactly one of `variables` or `bindings`. Slot names are
closed per requirement kind, and values are exact OpenTofu variable or runtime
binding names. Requirements cannot claim the same delivery name. Endpoint is a
singleton per module. The compiler rejects host-reserved bindings,
absent/non-string variables, and requirement kinds outside operator policy.

`identity.oidc` is a Takosumi Accounts capability that any reviewed
Git/OpenTofu app may request without naming a product or provider. The selected
module must contain exactly one `identity.oidc` and exactly one
`http.endpoint`. OIDC delivery is variables-only and has exactly four slots:
`accountsUrl`, `issuerUrl`, `clientId`, and `redirectUri`. The endpoint delivers
`url` to a distinct string variable. OIDC scopes must be unique, include
`openid`, and remain within the explicit
`InstallConfig.policy.repositoryInstallUx.allowedOidcScopes`; no allowlist
grants no capability.

At Plan, the endpoint `url` variable must resolve to a canonical exact HTTPS
origin with no path, query, fragment, or credentials. Takosumi derives the
redirect URI from that origin and the reviewed `callbackPath`, then pins the
exact four variables and authority digest in the private Plan sidecar. Plan and
`apply_check` do not mutate Accounts. Only final Apply may idempotently register
the Capsule-bound public client, and retirement after terminal destroy is also
idempotent. An unavailable Accounts capability or drift in origin, variable,
callback, scope, or digest fails before runner execution. There is no fallback
or inference from ProviderBinding, provider output, product identity, or
hostname convention, and the request adds no provider, resource, deployment,
or lifecycle authority.

`interface.consume` never declares a provider, product name, Interface ID,
endpoint, or credential. After Plan, the host reads the DB-owned InstallConfig
and resolves the exact type/version only when there is exactly one
Workspace-owned `Resolved` Interface. It then creates an ordinary
least-privilege `InterfaceBinding` for the authenticated Principal. Zero or
multiple matches, revoked/conflicting bindings, or
permissions/delivery outside operator policy fail closed. Runtime credentials
are short-lived and are never written to the manifest or an OpenTofu variable.

## `features`

`features` is optional and has at most 32 entries. An entry contains only `id`,
`optional`, a bilingual `label`, and non-empty `inputs`. The inputs reference
user inputs declared by the same module and cannot be claimed by another
feature. A feature is UI grouping, not provider, resource, or lifecycle
authority.

## `sourceBuild` (v2.3)

v2.3 modules may carry an optional credential-free `sourceBuild` proposal for
preparing the Git SourceSnapshot checkout. This is not repository execution
authority: after the exact compatibility review, Takosumi compiles the
user-reviewed value into DB-owned `InstallConfig.sourceBuild`. An existing
service/operator `baseConfig.sourceBuild` always wins over the repository
proposal.

```json
{
  "sourceBuild": {
    "commands": [
      { "argv": ["bun", "install", "--frozen-lockfile"] },
      { "argv": ["bun", "run", "build"], "workingDirectory": "web" }
    ],
    "outputs": ["web/dist/index.js"]
  }
}
```

There are 1–8 commands. Each `argv` is a non-empty argv array (not a shell
string) of at most 32 arguments, each at most 4096 characters. `workingDirectory`
and `outputs` are safe paths relative to the SourceSnapshot root; there are
1–16 outputs and `.` is not a produced path. Paths must already be canonical;
leading/trailing whitespace, `\\`, `//`, and `.` or `..` segments are rejected
rather than normalized. Objects are closed: `env`,
credentials, provider selection, and lifecycle fields are not allowed, and
argv cannot contain secret-like material.

Before Plan starts, the dashboard discloses the exact argv, working directory
(Source root when omitted), and outputs. Plan/Run consumes only the persisted
InstallConfig and never re-reads repository metadata at runtime.

## `interfaces` (v2 / v2.1 / v2.2 / v2.3)

v2, v2.1, v2.2, and v2.3 may add at most 32 generic Capsule Interface proposals per
module. An `interfaces` field is invalid in v1. v2.1 and v2.2 retain the exact
v2 Interface schema and compiler semantics. This section declares Interfaces a
Capsule provides; `interface.consume` declares an Interface it consumes.

Each declaration contains only `key`, `name`, `spec`, and optional
`bindingRequests`. `spec` is a closed object containing `type`, `version`, a
public JSON `document`, optional `inputs`, and `access`.

- `spec.inputs` has at most 64 entries. An input is either public JSON
  `literal` or an `output` with an exact module `outputName` and `outputType`.
- The compatibility report must prove that every Output exists and is both
  `sensitive: false` and `ephemeral: false`. There is no name-based fallback.
- `access.visibility` is fixed to `workspace`. `resourceUriInput` must name an
  input in the same spec. A repository cannot supply host-owned `policyRef`.
- `bindingRequests` has at most one entry. Its subject is only
  `installing_principal`, permissions contain 1–16 tokens, and delivery is only
  `{ "type": token }`. Missing operator permission/delivery allowlists reject
  the request.

The generic default InstallConfig permits only `ui.open` with `none` and
`mcp.invoke` with `oauth2`, both scoped to the installing Principal. These are
one-shot binding proposals compiled through the reviewed install plan; they do
not grant Workspace-wide or operator authority. Any other permission or
delivery type requires an explicit operator-owned InstallConfig policy.

Accepted proposals merge by stable key into existing
`InstallConfig.interfaceBlueprints` and `outputAllowlist`; conflicts fail
instead of overwriting. Existing host lifecycle resolves the exact installing
Principal and materializes Interfaces/Bindings. A repository cannot mint a
grant.

## Authority and secret boundaries

The manifest contains public proposals only. It cannot contain:

- a Git URL, ref/tag/commit, SourceSnapshot, Store listing, or
  provider/target/runner selection;
- credential/secret/token/password/key values, credential references,
  Principal IDs, or host-authority account/workspace/capsule/resource/
  connection IDs;
- arbitrary environment injection, a plain `env` map, provider bindings, or
  Interface grants;
- lifecycle commands, migrations, output allowlists, billing, policy, or a
  Plan/Run bypass.

`secret: true` and `secret.generated` request host materialization; they are not
values. Public presentation fields (`label`, `helper`, `placeholder`, and
feature labels) are scanned for known credential-like
patterns, including `sk-…`, bearer/assignment forms, and URI credentials.
Structured Interface documents and literals are scanned recursively for both
secret-like values and authority-key names. This deliberately rejects concrete
material, not ordinary words such as “token” in user-facing prose, and
diagnostics never echo a value. JSON values in those documents/literals are
bounded to recursive depth 32 by the parser; the structural schema documents
that parser-owned constraint rather than pretending to encode it.

The base InstallConfig and operator policy are always ceilings. A repository
proposal cannot widen an allowlist or authority. A proposal that conflicts
with a service/operator declaration is rejected rather than overwriting it.
Manifest digest, snapshot, selected module, and compatibility report
mismatches fail closed.

## Invalid examples

A v2 document cannot use the v2.1 field:

```json
{
  "apiVersion": "takosumi.com/v2",
  "kind": "Repository",
  "install": {
    "defaultModule": "deploy/app",
    "modules": { "deploy/app": { "inputs": [] } }
  }
}
```

An alias or missing key is invalid:

```json
{
  "apiVersion": "takosumi.com/v2.1",
  "kind": "Repository",
  "install": {
    "defaultModule": "./deploy/app",
    "modules": { "deploy/app": { "inputs": [] } }
  }
}
```

Public documents cannot embed secret or authority material:

```json
{
  "key": "launcher",
  "name": "example.launcher",
  "spec": {
    "type": "example",
    "version": "1",
    "document": { "credentialId": "credential_123" },
    "access": { "visibility": "workspace" }
  }
}
```

## Migration and versioning

An API identifier names a closed schema. Existing versions do not gain fields
or new meanings later. v2.1 adds only optional `install.defaultModule`; v2.2
adds only provider-neutral `interface.consume`; v2.3 adds only bounded,
credential-free `sourceBuild`. These are additive schema
revisions that preserve existing module, provided-Interface, and authority
semantics. Unknown versions or fields fail closed. Incompatible vocabulary or
authority changes require a separate schema identifier.

A future metadata section requires a new `apiVersion`; unknown fields continue to fail closed.

- A single-module v1/v2 repository needs no migration; its only key is selected.
- A multi-module repository upgrades to v2.1 and adds an exact `defaultModule`.
- v2 `interfaces` keep the same shape and meaning after changing to v2.1.
- Only a repository that consumes a host Interface upgrades to v2.2 and adds
  `interface.consume`.
- A repository that proposes SourceSnapshot preparation upgrades to v2.3 and
  adds `sourceBuild` per module.
- Do not backport the new field while retaining a v1/v2 identifier.

The Store does not proxy this manifest. See [Store API](./store-api.md) for the
TCS 2.0 URL-only handoff and integration boundary. Root `install-options.json`
is a separate chooser with `apiVersion: install.takosumi.com/v1alpha1` and
`kind: CapsuleSourceOptions` for ordinary Capsule source candidates. It cannot
duplicate inputs or InstallConfig declarations.
