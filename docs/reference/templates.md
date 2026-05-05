# Templates

> Stability: stable Audience: integrator See also:
> [Manifest Expand Semantics](/reference/manifest-expand-semantics),
> [Shape Catalog](/reference/shapes), [Provider Plugins](/reference/providers)

A **template** is the v1 manifest authoring shorthand that expands into a
concrete `resources[]` array at OperationPlan construction time. The manifest
names a template (`template: <id>@<version>`) and supplies `inputs`. The kernel
calls `expand(inputs)` on the registered template, splices the produced
[Shape](/reference/shapes) resources into the manifest, and from that point
onward the deployment runs through the standard DAG / capability selection /
[provider plugin](/reference/providers) lifecycle.

Source: `packages/contract/src/template.ts` (the contract and registry),
`packages/plugins/src/templates/<template>.ts` (the bundled two).

## Public API surface

`registerTemplate` is the v1 entry point for any third party that wants to
publish a template into the in-process registry.

```ts
function registerTemplate(
  template: Template,
  options?: RegisterTemplateOptions,
): Template | undefined;
```

The `Template` shape:

```ts
interface Template<Inputs = JsonObject> {
  readonly id: string; // e.g. "web-app-on-cloudflare"
  readonly version: string; // semver
  readonly description?: string;
  validateInputs(value: unknown, issues: TemplateValidationIssue[]): void;
  expand(inputs: Inputs): readonly ManifestResource[];
}
```

Required fields: `id`, `version`, `validateInputs`, `expand`. `description` is
optional. `registerTemplate` returns the prior registration when the same
`(id, version)` is replaced; passing `{ allowOverride: true }` suppresses the
collision warning. A template **must not** include providers or credentials in
its definition — `expand` returns `ManifestResource[]` where each resource
carries a `provider:` id, and the kernel runs the normal selection rules over
the result.

A template ships only Shape compositions. Adding a new template never requires a
Shape RFC — the catalog of `ManifestResource` produced by `expand` is
constrained to the existing shapes.

## Expand result immutability

Template expansion is **resolved once**, at OperationPlan construction:

- The expanded `ManifestResource[]` is captured into the OperationPlan and
  becomes immutable for the lifetime of that plan.
- A subsequent **template revision** (registering a different `Template` value
  at the same `id@version`, or publishing a new `id@version`) does **not**
  re-expand any existing Deployment. The Deployment continues to track the
  resources written into its plan.
- A new expansion only occurs when the operator submits a new manifest apply —
  the kernel re-resolves the template at that point and produces a fresh
  OperationPlan from the latest registered template.

This rule keeps drift detection, namespace export, and risk / approval
invalidation deterministic against the captured plan rather than against a
moving template definition.

## Bundled templates

Takosumi bundles two templates.

| template id             | version | summary                                                                                   |
| ----------------------- | ------- | ----------------------------------------------------------------------------------------- |
| `selfhosted-single-vm`  | `v1`    | Single-host selfhost: web service + Postgres + filesystem object store + optional CoreDNS |
| `web-app-on-cloudflare` | `v1`    | Cloudflare-edge web app: CF container + R2 + DNS + pluggable Postgres                     |

## `selfhosted-single-vm@v1`

Brings up the full Takosumi stack on a single VM or developer host. Every
resource is pinned to a selfhost provider.

### Inputs

```ts
interface SelfhostedSingleVmInputs {
  readonly serviceName: string; // logical name of the web service
  readonly image: string; // OCI image reference
  readonly port: number; // internal listen port
  readonly databaseVersion?: string; // default "16"
  readonly assetsBucketName?: string; // default "<serviceName>-assets"
  readonly domain?: string; // optional custom-domain FQDN
}
```

### Expansion

| resource name       | shape                  | provider                         | spec / link / exposure / data assets                                                                                                                                                                                                               |
| ------------------- | ---------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `db`                | `database-postgres@v1` | `@takos/selfhost-postgres`       | spec: `{ version: databaseVersion ?? "16", size: "small" }`. No data assets.                                                                                                                                                                       |
| `assets`            | `object-store@v1`      | `@takos/selfhost-filesystem`     | spec: `{ name: assetsBucketName ?? "<serviceName>-assets" }`. No data assets.                                                                                                                                                                      |
| `<serviceName>`     | `web-service@v1`       | `@takos/selfhost-docker-compose` | spec: `{ image, port, scale: { min: 1, max: 1 } }`. links: `bindings.DATABASE_URL = ${ref:db.connectionString}`, `bindings.ASSETS_BUCKET = ${ref:assets.bucket}`. data asset: the `image` is consumed as an `oci-image` DataAsset by the provider. |
| `domain` _(opt-in)_ | `custom-domain@v1`     | `@takos/selfhost-coredns`        | spec: `{ name: <domain>, target: ${ref:<serviceName>.url} }`. exposure: routes the FQDN to the web service's `url` output. Only emitted when `domain` is supplied.                                                                                 |

### Manifest example

```yaml
apiVersion: "1.0"
kind: Manifest
metadata:
  name: my-selfhost-app
template:
  template: selfhosted-single-vm@v1
  inputs:
    serviceName: api
    image: ghcr.io/example/api@sha256:0123...
    port: 8080
    domain: api.lan
```

## `web-app-on-cloudflare@v1`

Cloudflare-edge front end with a pluggable Postgres backend. The default
Postgres provider is `@takos/aws-rds`; an operator may pick GCP Cloud SQL or
selfhost Postgres via `databaseProvider`.

### Inputs

```ts
interface WebAppOnCloudflareInputs {
  readonly serviceName: string;
  readonly image: string;
  readonly port: number;
  readonly domain: string; // required FQDN
  readonly assetsBucketName?: string; // default "<serviceName>-assets"
  readonly databaseProvider?:
    | "@takos/aws-rds"
    | "@takos/gcp-cloud-sql"
    | "@takos/selfhost-postgres"; // default "@takos/aws-rds"
  readonly databaseVersion?: string;
}
```

### Expansion

| resource name   | shape                  | provider                               | spec / link / exposure / data assets                                                                                                                                                                                                                                                                 |
| --------------- | ---------------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `db`            | `database-postgres@v1` | `databaseProvider ?? "@takos/aws-rds"` | spec: `{ version: databaseVersion ?? "16", size: "small" }`. No data assets.                                                                                                                                                                                                                         |
| `assets`        | `object-store@v1`      | `@takos/cloudflare-r2`                 | spec: `{ name: assetsBucketName ?? "<serviceName>-assets", public: false }`. No data assets.                                                                                                                                                                                                         |
| `<serviceName>` | `web-service@v1`       | `@takos/cloudflare-container`          | spec: `{ image, port, scale: { min: 0, max: 10 } }`. links: `bindings.DATABASE_URL = ${ref:db.connectionString}`, `bindings.ASSETS_BUCKET = ${ref:assets.bucket}`, `bindings.ASSETS_ENDPOINT = ${ref:assets.endpoint}`. data asset: `image` is consumed as an `oci-image` DataAsset by the provider. |
| `domain`        | `custom-domain@v1`     | `@takos/cloudflare-dns`                | spec: `{ name: <domain>, target: ${ref:<serviceName>.url} }`. exposure: routes the FQDN to the web service's `url`.                                                                                                                                                                                  |

### Manifest example

```yaml
apiVersion: "1.0"
kind: Manifest
metadata:
  name: my-edge-app
template:
  template: web-app-on-cloudflare@v1
  inputs:
    serviceName: app
    image: ghcr.io/example/app@sha256:0123...
    port: 8080
    domain: app.example.com
    databaseProvider: "@takos/aws-rds"
```

## Cross-references

- [Manifest](/manifest) — `template:` field の使い方、expanded resources と
  operator-authored `resources[]` の関係。
- [Shape catalog](/reference/shapes) — Spec / outputFields / capability
  vocabulary used inside `expand`.
- [Provider plugins](/reference/providers) — selection rules applied to the
  `ManifestResource[]` produced by `expand`.

## Related design notes

本文を読むのに design/ への参照は不要だが、設計の rationale は以下に残る:

- `docs/design/manifest-model.md` — template expansion semantics の rationale
