# Templates

> Stability: retired / historical Audience: integrator See also:
> [Manifest Expand Semantics](/reference/manifest-expand-semantics),
> [Shape Catalog](/reference/shapes), [Provider Plugins](/reference/providers)

`template` is a retired kernel manifest authoring shorthand. Current kernel
`POST /v1/deployments` receives a compiled Shape manifest with concrete
`resources[]`; template expansion, if an operator wants it, must run before the
kernel request in an installer/compiler layer. A manifest submitted to the
kernel with top-level `template` is not current v1 public contract.

Historical source: `packages/contract/src/template.ts` (the contract and
registry), `packages/plugins/src/templates/<template>.ts` (legacy bundled
examples). These are compatibility internals, not a public kernel deploy API.

## Historical API surface

`registerTemplate` was the in-process entry point for registering a template. Do
not use it as a kernel public contract.

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

A template must compile to ordinary Shape resources before deploy. Adding a new
authoring macro is an installer/compiler concern; it does not change the kernel
manifest envelope.

## Expand result immutability

Historical template expansion was **resolved once**, before OperationPlan
construction:

- The expanded `ManifestResource[]` is captured into the OperationPlan and
  becomes immutable for the lifetime of that plan.
- A subsequent **template revision** must not re-expand any existing Deployment.
  The Deployment continues to track the concrete resources written into its
  plan.
- A new expansion only occurs when an installer/compiler submits a new compiled
  manifest apply.

This rule keeps drift detection and risk / approval invalidation deterministic
against the captured plan rather than against a moving template definition.

## Bundled templates

Legacy examples included two templates. They are not current kernel public
surface.

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

### Historical authoring example

```yaml
# Historical authoring input. Do not submit this directly to POST /v1/deployments.
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

### Historical authoring example

```yaml
# Historical authoring input. Do not submit this directly to POST /v1/deployments.
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

- [Manifest](/manifest) — current kernel input is the expanded `resources[]`
  form.
- [Shape catalog](/reference/shapes) — Spec / outputFields / capability
  vocabulary used inside `expand`.
- [Provider plugins](/reference/providers) — selection rules applied to the
  `ManifestResource[]` produced by `expand`.

## Related architecture notes

関連 architecture notes:

- `docs/reference/architecture/manifest-model.md` — template expansion semantics
  の rationale
