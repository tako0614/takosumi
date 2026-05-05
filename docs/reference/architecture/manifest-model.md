# Manifest Model

The manifest is a closed authoring surface. It declares desired portable
resources and template invocations; it is not canonical state. Space, tenant,
actor, catalog release, policy, quota, credentials, approvals, journal state,
observations, and GroupHead are supplied by deploy context, not by the manifest.

Public v1 is the **Shape + Provider + Template** manifest model implemented by
`POST /v1/deployments` and `takosumi deploy`. The old
`schemaVersion/profile/components/expose` authoring shape is not a current
public manifest schema.

## Allowed Public Fields

Root fields:

```text
apiVersion
kind
metadata
template
resources
```

`apiVersion` is required and fixed to `"1.0"`. `kind` is required and fixed to
`Manifest`. Unknown top-level fields fail schema validation; they are not
warnings.

`metadata` fields:

```text
name
labels
```

`template` fields:

```text
template
inputs
```

`template.template` is a pinned `id@version` template reference. During the v1
compatibility window the resolver may accept legacy `template.ref`, and CLI
local mode may accept `template.name`; new manifests and docs must use
`template.template`.

`resources[]` entry fields:

```text
shape
name
provider
spec
requires
metadata
```

`spec` is target-shape-specific and is validated by the selected Shape's
`validateSpec`. Unknown envelope fields outside `spec` fail validation.

## Space Context

`Space` is outside the manifest. The same manifest can resolve differently in
different Spaces. Namespace paths, catalog release selection, policy, secrets,
artifacts, approvals, journals, observations, and GroupHead are Space-scoped.

```text
manifest + space:acme-prod -> production catalog / policy / quotas
manifest + space:acme-dev  -> development catalog / policy / quotas
```

A public manifest must not contain `space`, `tenant`, `org`, credential, or
namespace registry configuration fields. Those are deployment context / operator
configuration, not authoring intent.

## Resources

Each `resources[]` entry declares one portable Shape resource.

```yaml
apiVersion: "1.0"
kind: Manifest
metadata:
  name: my-app
resources:
  - shape: database-postgres@v1
    name: db
    provider: "@takos/aws-rds"
    requires: [automated-backups]
    spec:
      version: "16"
      size: small

  - shape: web-service@v1
    name: api
    provider: "@takos/aws-fargate"
    spec:
      image: ghcr.io/example/api@sha256:...
      port: 8080
      bindings:
        DATABASE_URL: ${ref:db.connectionString}
```

Rules:

- `shape` names the portable contract (`web-service@v1`, `database-postgres@v1`,
  `object-store@v1`, and so on).
- `provider` names the selected implementation for that Shape, such as
  `@takos/aws-fargate`, `@takos/cloudflare-workers`, or a self-hosted provider.
- `name` is the manifest-local resource identity and the source namespace for
  `${ref:<name>.<field>}`.
- `requires` is a capability subset requirement. Provider capabilities must be a
  superset or validation rejects the resource.

## Templates

Templates are authoring macros that expand into concrete `resources[]` before
reference resolution and planning.

```yaml
apiVersion: "1.0"
kind: Manifest
metadata:
  name: my-app
template:
  template: selfhosted-single-vm@v1
  inputs:
    serviceName: api
    image: ghcr.io/example/api@sha256:...
    port: 8080
```

`template` and `resources[]` may be used together. Expansion runs first, then
explicit `resources[]` are appended. The combined resource list is what enters
reference resolution, plan construction, idempotency assignment, and apply /
destroy. Current public deploy records idempotency in the public deploy replay
store; `mode: "plan"` also returns the deterministic WAL tuple preview that the
internal OperationPlan path will use as execution authority once the public
route adopts it end to end.

## References

`spec` values may use reference tokens:

```text
${ref:<resource>.<field>}
${secret-ref:<resource>.<field>}
```

References create dependency edges between resources. The kernel validates the
grammar, builds a DAG, rejects cycles, and applies resources in topological
order. `secret-ref` is for secret-reference outputs and must not be used for
plain outputs.

## Data Inputs

Artifacts are not top-level manifest authority. They are Shape `spec` input
values and are subject to the Shape/provider contract and artifact policy.

```yaml
resources:
  - shape: worker@v1
    name: worker
    provider: "@takos/cloudflare-workers"
    spec:
      artifact:
        kind: js-bundle
        hash: sha256:...
```

Local paths are unresolved authoring inputs. They must become content-addressed
artifact records before a remote kernel can apply them.

## Manifest to Intent Graph

```text
metadata.name:
  Deployment record name inside the deploy context's Space

template:
  Template invocation expanded into resources before planning

resources[].shape:
  Portable Shape contract intent

resources[].provider:
  Provider implementation selection intent

resources[].spec:
  Shape-specific desired input

resources[].requires:
  Capability constraint on provider selection

${ref:...} / ${secret-ref:...}:
  Link / dependency intent between resource outputs and inputs
```

The OperationPlan and write-ahead journal architecture is derived from this
intent graph. On the current public deploy route, `mode: "plan"` exposes a
deterministic OperationPlan preview (DesiredSnapshot digest, OperationPlan
digest, planned operations, and WAL idempotency tuple preview) without writing
the journal. `mode: "apply"` / `mode: "destroy"` now derive the same public
OperationPlan shape internally and write public WAL stage records to
`takosumi_operation_journal_entries`, while the persisted public deployment
record still carries the compatibility status / handle state used by
`takosumi status` and destroy handle resolution. Public recovery currently
supports side-effect-free `inspect`, guarded same-digest `continue`, and
`compensate` that opens `activation-rollback` RevokeDebt. Connector-native
compensate is exposed in the runtime-agent protocol with destroy fallback, while
CatalogRelease adoption / signature verification is implemented in the registry
domain. Public apply / destroy WAL invokes the adopted release as a fail-closed
pre/post-commit verification hook; richer catalog-declared executable hook
packages are treated as an extension point. RevokeDebt retry attempt,
policy-controlled aging, manual reopen, clearance, connector-backed cleanup, and
worker daemon scheduling are implemented as lifecycle primitives.
