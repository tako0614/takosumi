# terraform-provider-takosumi

A thin OpenTofu/Terraform provider for the **Takosumi Resource Shape API**.

This provider lets you declare Takosumi resource shapes (e.g.
`takosumi_object_store`, `takosumi_http_service`) in HCL. It is deliberately
**thin**: it carries shape-specific HCL schemas, validation, a Takosumi API HTTP
client, and preview/apply/status mapping. It does **not** call AWS / Cloudflare /
Kubernetes SDKs, does **not** select a backend, and does **not** manage
credentials. Backend selection happens server-side in the Takosumi **Resolver**;
the provider holds only a thin handle (id + outputs + resolution status).

It is **capability-driven, not edition-driven**: on configure it discovers the
server's advertised capabilities and never branches on an "edition" string.

- Module path: `github.com/takosjp/terraform-provider-takosumi`
- Provider type name: `takosumi`
- Registry address: `registry.terraform.io/takosjp/takosumi`
- Resource API version: `takosumi.dev/v1alpha1`

## Layout

```text
provider/
├── main.go                          # providerserver.Serve entrypoint
├── go.mod
├── internal/
│   ├── client/                      # thin Takosumi Resource Shape API HTTP client
│   │   ├── client.go                # discovery, CRUD, preview, typed structs, error mapping
│   │   └── client_test.go
│   └── provider/
│       ├── provider.go              # provider schema + Configure (discovery + capability gate)
│       ├── object_store_resource.go # takosumi_object_store resource + model mapping
│       ├── http_service_resource.go # takosumi_http_service resource + model mapping
│       ├── validators.go            # in-tree string/set allow-list validators
│       ├── provider_test.go
│       └── object_store_resource_test.go
└── examples/
    └── resources/takosumi_object_store/resource.tf
```

## Build

```bash
cd provider
go build ./...

# build a named plugin binary
go build -o terraform-provider-takosumi .
```

## Test

```bash
cd provider
go test ./...

# verbose
go test ./... -v
```

The tests are hermetic: the HTTP client and discovery/gating are exercised
against an in-process `httptest.Server`. **No live Takosumi endpoint is
required.**

## Local install (developer override)

Build the binary and point your CLI at it with a dev override. With OpenTofu:

```bash
cd provider
go build -o terraform-provider-takosumi .
```

Add a `~/.tofurc` (or `~/.terraformrc` for Terraform):

```hcl
provider_installation {
  dev_overrides {
    "takosjp/takosumi" = "/absolute/path/to/provider"
  }
  direct {}
}
```

Then `tofu plan` / `terraform plan` in a config that uses the provider will load
the local binary (skip `init` while a dev override is active).

## Worker assets mirror

Takosumi-hosted deployments serve the provider from the platform Worker's static
assets, not from a separate provider service. Generate the mirror assets before
building/deploying the dashboard:

```bash
TAKOSUMI_PROVIDER_VERSION=0.1.0 bun run provider:assets
cd dashboard && bun run build
```

The generated OpenTofu network mirror base URL is:

```text
https://app.takosumi.com/opentofu/providers/
```

Example OpenTofu CLI config:

```hcl
provider_installation {
  network_mirror {
    url = "https://app.takosumi.com/opentofu/providers/"
    include = ["registry.opentofu.org/takosjp/takosumi"]
  }

  direct {
    exclude = ["registry.opentofu.org/takosjp/takosumi"]
  }
}
```

## Configuration

```hcl
provider "takosumi" {
  endpoint = "https://takosumi.example.com" # optional when TAKOSUMI_ENDPOINT is set
  space    = "prod"                         # optional default Space (or TAKOSUMI_SPACE)
  # token  = "..."                          # optional, sensitive (or TAKOSUMI_TOKEN)
}
```

| Attribute  | Required | Env fallback        | Notes                                            |
| ---------- | -------- | ------------------- | ------------------------------------------------ |
| `endpoint` | via attr or env | `TAKOSUMI_ENDPOINT` | Takosumi origin                          |
| `space`    | no       | `TAKOSUMI_SPACE`    | Default Space for resources that don't set one   |
| `token`    | no       | `TAKOSUMI_TOKEN`    | Sent as `Authorization: Bearer <token>` when set |

On `Configure` the provider performs `GET {endpoint}/.well-known/takosumi` and
requires `takosumi.dev/v1alpha1` in `api_versions`. If
`features.resource_shapes` is not `true`, configuration fails with a clear
diagnostic. It then performs `GET {endpoint}/v1/capabilities`, validates the
capabilities `apiVersion`, and each resource checks its shape capability before
CRUD. Resource API paths are root-level under the endpoint origin
(`{endpoint}/v1/resources/...`).

## Example

```hcl
terraform {
  required_providers {
    takosumi = {
      source = "takosjp/takosumi"
    }
  }
}

provider "takosumi" {
  endpoint = "https://takosumi.example.com"
  space    = "prod"
}

resource "takosumi_object_store" "assets" {
  name = "assets"

  interfaces = [
    "s3_api",
    "signed_url",
  ]

  lifecycle_policy = {
    delete = "retain"
  }
}

output "assets_selected_implementation" {
  value = takosumi_object_store.assets.selected_implementation
}

output "assets_outputs" {
  value = takosumi_object_store.assets.outputs
}

resource "takosumi_http_service" "api" {
  name              = "api"
  runtime_interface = "web_fetch"
  artifact_path     = "/work/dist/worker.js"
  public_http       = true
}
```

See [`examples/resources/takosumi_object_store/resource.tf`](examples/resources/takosumi_object_store/resource.tf).

### `takosumi_object_store`

| Attribute                 | Type          | Mode      | Notes                                                              |
| ------------------------- | ------------- | --------- | ----------------------------------------------------------------- |
| `name`                    | string        | required  | Resource key; changing it replaces the resource                   |
| `interfaces`              | set(string)   | required  | One or more of `s3_api`, `signed_url`, `object_events`            |
| `lifecycle_policy`        | object        | optional  | `{ delete = "delete"\|"retain"\|"snapshot_then_delete"\|"block" }` |
| `space`                   | string        | optional  | Overrides the provider default; changing it replaces the resource |
| `id`                      | string        | computed  | `tkrn:{space}:ObjectStore:{name}` unless the server returns one   |
| `selected_implementation` | string        | computed  | Backend chosen by the Resolver (e.g. `cloudflare_r2`, `aws_s3`)    |
| `target`                  | string        | computed  | Target the resource landed on                                     |
| `locked`                  | bool          | computed  | Whether the resolution is locked                                  |
| `portability`             | string        | computed  | Resolver portability assessment                                   |
| `outputs`                 | map(string)   | computed  | Resolved outputs                                                  |

Import accepts `name` or `space/name`:

```bash
tofu import takosumi_object_store.assets prod/assets
```

### `takosumi_http_service`

| Attribute                 | Type        | Mode     | Notes                                                            |
| ------------------------- | ----------- | -------- | ---------------------------------------------------------------- |
| `name`                    | string      | required | Resource key; changing it replaces the resource                 |
| `runtime_interface`       | string      | required | One of `web_fetch`, `node_http`, `container_http`               |
| `artifact_path`           | string      | optional | Runner-local path to a prebuilt artifact; Takosumi does not build it |
| `public_http`             | bool        | optional | Requests a public HTTP route                                    |
| `space`                   | string      | optional | Overrides the provider default; changing it replaces the resource |
| `id`                      | string      | computed | `tkrn:{space}:HttpService:{name}` unless the server returns one |
| `selected_implementation` | string      | computed | Backend chosen by the Resolver, e.g. `cloudflare_workers`       |
| `target`                  | string      | computed | Target the resource landed on                                   |
| `locked`                  | bool        | computed | Whether the resolution is locked                                |
| `portability`             | string      | computed | Resolver portability assessment                                 |
| `outputs`                 | map(string) | computed | Resolved outputs                                                |

## Wire contract

The provider speaks the Takosumi Resource object envelope over JSON.

Discovery (`GET {endpoint}/.well-known/takosumi`):

```json
{
  "api_versions": ["takosumi.dev/v1alpha1"],
  "features": { "resource_shapes": true },
  "endpoints": { "api": "...", "capabilities": "...", "oidc_issuer": "..." }
}
```

Capabilities (`GET {endpoint}/v1/capabilities`) must include the resource shape
used by each HCL resource, for example:

```json
{
  "apiVersion": "takosumi.dev/v1alpha1",
  "resources": {
    "ObjectStore": true,
    "HttpService": true
  }
}
```

Resource CRUD (root-level under the endpoint origin):

- Create/Update: `PUT  {endpoint}/v1/resources/{Kind}/{name}`
- Read:          `GET  {endpoint}/v1/resources/{Kind}/{name}` (404 ⇒ removed from state)
- Delete:        `DELETE {endpoint}/v1/resources/{Kind}/{name}` (200/204 ⇒ done; 404 ⇒ already gone)
- Preview:       `POST {endpoint}/v1/resources/preview` (best-effort, plan-time)

Request body (PUT/preview):

```json
{
  "apiVersion": "takosumi.dev/v1alpha1",
  "kind": "ObjectStore",
  "metadata": { "name": "assets", "space": "prod", "managedBy": "opentofu" },
  "spec": {
    "name": "assets",
    "interfaces": ["s3_api", "signed_url"],
    "lifecyclePolicy": { "delete": "retain" }
  }
}
```

Response adds `status` (`phase`, `observedGeneration`, `resolution`, `outputs`,
`conditions`). The provider maps `status.resolution.*` to the computed
resolution attributes and `status.outputs` to `outputs`.

Error envelope (non-2xx) is nested — the `error` field is an object — and is
surfaced as a Terraform diagnostic:

```json
{ "error": { "code": "<code>", "message": "<msg>", "requestId": "<id>", "details": <any> } }
```

## Status

The provider is shape-specific and matches the Resource Shape wire contract.
Run `go test ./...` in an environment with Go installed. This workspace did not
have `go` available during the latest update, so Go tests were not executed here.
