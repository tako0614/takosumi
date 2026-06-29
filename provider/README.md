# terraform-provider-takosumi

A thin OpenTofu/Terraform provider for the **Takosumi Resource Shape API**.

This provider lets you declare Takosumi resource shapes (e.g.
`takosumi_object_store`, `takosumi_http_service`, `takosumi_ai_endpoint`) and
operator configuration such as `takosumi_target_pool` in HCL. It is
deliberately **thin**: it carries shape-specific HCL schemas, validation, a
Takosumi API HTTP client, and preview/apply/status mapping. It does **not**
call AWS / Cloudflare / Kubernetes SDKs, does **not** select a backend, and
does **not** manage credentials. Backend selection happens server-side in the
Takosumi **Resolver**; the provider holds only a thin handle (id + outputs +
resolution status).
The provider should expose broad shape-specific resources and admin capability
configuration, not just the resources used by the official Takosumi Cloud
deployment. Endpoint capabilities, TargetPool implementation evidence, policy,
and the engine/admin configuration decide whether a given profile or backend is
supported.

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
│       ├── ai_endpoint_resource.go  # takosumi_ai_endpoint resource + model mapping
│       ├── target_pool_resource.go  # takosumi_target_pool admin capability config
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

| Attribute  | Required        | Env fallback        | Notes                                            |
| ---------- | --------------- | ------------------- | ------------------------------------------------ |
| `endpoint` | via attr or env | `TAKOSUMI_ENDPOINT` | Takosumi origin                                  |
| `space`    | no              | `TAKOSUMI_SPACE`    | Default Space for resources that don't set one   |
| `token`    | no              | `TAKOSUMI_TOKEN`    | Sent as `Authorization: Bearer <token>` when set |

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

resource "takosumi_target_pool" "ai" {
  name = "default"

  target = [{
    name     = "deepseek-main"
    type     = "ai_provider"
    ref      = "https://api.deepseek.example/v1"
    priority = 90

    implementation = [{
      shape                = "AIEndpoint"
      implementation       = "deepseek_openai_gateway"
      native_resource_type = "ai.deepseek_endpoint"
      interfaces = {
        openai_chat_completions      = "native"
        openai_embeddings            = "shim"
        vendor.deepseek.responses.v1 = "native"
      }
    }]
  }]
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

resource "takosumi_ai_endpoint" "ai" {
  name = "ai"

  interfaces = [
    "openai_chat_completions",
    "openai_embeddings",
  ]

  profiles = [
    "openai_compatible",
  ]

  model_policy = {
    default_model  = "fast/chat"
    allowed_models = ["fast/chat", "embed/text"]
  }
}
```

See [`examples/resources/takosumi_object_store/resource.tf`](examples/resources/takosumi_object_store/resource.tf).

### `takosumi_object_store`

| Attribute                 | Type        | Mode     | Notes                                                              |
| ------------------------- | ----------- | -------- | ------------------------------------------------------------------ |
| `name`                    | string      | required | Resource key; changing it replaces the resource                    |
| `interfaces`              | set(string) | required | One or more of `s3_api`, `signed_url`, `object_events`             |
| `lifecycle_policy`        | object      | optional | `{ delete = "delete"\|"retain"\|"snapshot_then_delete"\|"block" }` |
| `space`                   | string      | optional | Overrides the provider default; changing it replaces the resource  |
| `id`                      | string      | computed | `tkrn:{space}:ObjectStore:{name}` unless the server returns one    |
| `selected_implementation` | string      | computed | Backend chosen by the Resolver (e.g. `cloudflare_r2`, `aws_s3`)    |
| `target`                  | string      | computed | Target the resource landed on                                      |
| `locked`                  | bool        | computed | Whether the resolution is locked                                   |
| `portability`             | string      | computed | Resolver portability assessment                                    |
| `outputs`                 | map(string) | computed | Resolved outputs                                                   |

Import accepts `name` or `space/name`:

```bash
tofu import takosumi_object_store.assets prod/assets
```

### `takosumi_http_service`

| Attribute                 | Type        | Mode     | Notes                                                                |
| ------------------------- | ----------- | -------- | -------------------------------------------------------------------- |
| `name`                    | string      | required | Resource key; changing it replaces the resource                      |
| `runtime_interface`       | string      | required | One of `web_fetch`, `node_http`, `container_http`                    |
| `artifact_path`           | string      | optional | Runner-local path to a prebuilt artifact; Takosumi does not build it |
| `public_http`             | bool        | optional | Requests a public HTTP route                                         |
| `space`                   | string      | optional | Overrides the provider default; changing it replaces the resource    |
| `id`                      | string      | computed | `tkrn:{space}:HttpService:{name}` unless the server returns one      |
| `selected_implementation` | string      | computed | Backend chosen by the Resolver, e.g. `cloudflare_workers`            |
| `target`                  | string      | computed | Target the resource landed on                                        |
| `locked`                  | bool        | computed | Whether the resolution is locked                                     |
| `portability`             | string      | computed | Resolver portability assessment                                      |
| `outputs`                 | map(string) | computed | Resolved outputs                                                     |

### `takosumi_ai_endpoint`

| Attribute                 | Type        | Mode     | Notes                                                                                                                                                 |
| ------------------------- | ----------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`                    | string      | required | Resource key; changing it replaces the resource                                                                                                       |
| `interfaces`              | set(string) | required | Non-empty AI interface tokens; known tokens include `openai_chat_completions`, `openai_responses`, `openai_embeddings`                                |
| `profiles`                | set(string) | optional | Non-empty compatibility profile tokens such as `openai_compatible`, `workers_ai`, `anthropic_messages`, `gemini_compat`, or operator-defined profiles |
| `provider_preferences`    | set(string) | optional | Provider/capability preference tokens such as `provider.deepseek`, `provider.gemini`, `provider.bedrock`, `provider.vertex`                           |
| `routing_policy`          | object      | optional | Routing preferences; endpoint policy decides final support                                                                                            |
| `model_policy`            | object      | optional | Public model alias policy; no upstream API keys                                                                                                       |
| `space`                   | string      | optional | Overrides the provider default; changing it replaces the resource                                                                                     |
| `id`                      | string      | computed | `tkrn:{space}:AIEndpoint:{name}` unless the server returns one                                                                                        |
| `selected_implementation` | string      | computed | Backend chosen by the Resolver, e.g. `cloudflare_ai_gateway`                                                                                          |
| `target`                  | string      | computed | Target the resource landed on                                                                                                                         |
| `locked`                  | bool        | computed | Whether the resolution is locked                                                                                                                      |
| `portability`             | string      | computed | Resolver portability assessment                                                                                                                       |
| `outputs`                 | map(string) | computed | Resolved outputs                                                                                                                                      |

`takosumi_ai_endpoint` is broad by design. It does not mean "Takosumi Cloud AI
only"; the endpoint capabilities, TargetPool, policy, and engine/admin
configuration decide whether the resource can be backed by Cloudflare AI
Gateway, Workers AI, an OpenAI-compatible upstream, Gemini, DeepSeek, GLM,
Bedrock, Vertex AI, Takosumi native, or another adapter.
Unknown AI interface/profile tokens are passed to the endpoint after basic
non-empty token validation. If the endpoint cannot resolve them, the server
returns the Resource Shape API error; the provider binary should not need a
release for every new AI vendor.

### `takosumi_target_pool`

`takosumi_target_pool` is an admin/operator resource for declaring which
Targets and implementation capabilities the Resolver may use. It is not a
vendor-specific AI resource. For AI, use target `type = "ai_provider"` and
operator-defined `implementation` entries.

| Attribute                                    | Type         | Mode     | Notes                                                                                                                                     |
| -------------------------------------------- | ------------ | -------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `name`                                       | string       | required | TargetPool name; changing it replaces the resource                                                                                        |
| `space`                                      | string       | optional | Overrides the provider default; changing it replaces the resource                                                                         |
| `target`                                     | list(object) | required | Ranked target entries                                                                                                                     |
| `target.name`                                | string       | required | Target name                                                                                                                               |
| `target.type`                                | string       | required | One of `aws`, `cloudflare`, `gcp`, `azure`, `kubernetes`, `vm`, `proxmox`, `libvirt`, `ssh`, `takosumi_native`, `ai_provider`, `opentofu` |
| `target.ref`                                 | string       | optional | Type-specific reference such as an account id, cluster id, endpoint URL, or provider base URL                                             |
| `target.region`                              | string       | optional | Optional region token                                                                                                                     |
| `target.priority`                            | number       | required | Higher priority wins after policy and capability filtering                                                                                |
| `target.implementation`                      | list(object) | optional | Operator-defined implementation capability evidence                                                                                       |
| `target.implementation.shape`                | string       | required | Shape the implementation can materialize, for example `AIEndpoint`                                                                        |
| `target.implementation.implementation`       | string       | required | Implementation token such as `deepseek_openai_gateway`; not a provider-binary enum                                                        |
| `target.implementation.native_resource_type` | string       | optional | Native resource type used in resolution evidence                                                                                          |
| `target.implementation.interfaces`           | map(string)  | required | Interface/profile token to capability level (`native`, `shim`, `emulated`, `unsupported`)                                                 |
| `id`                                         | string       | computed | `tkrn:{space}:TargetPool:{name}` unless the server returns one                                                                            |

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
    "HttpService": true,
    "AIEndpoint": true
  }
}
```

Resource CRUD (root-level under the endpoint origin):

- Create/Update: `PUT  {endpoint}/v1/resources/{Kind}/{name}`
- Read: `GET  {endpoint}/v1/resources/{Kind}/{name}` (404 ⇒ removed from state)
- Delete: `DELETE {endpoint}/v1/resources/{Kind}/{name}` (200/204 ⇒ done; 404 ⇒ already gone)
- Preview: `POST {endpoint}/v1/resources/preview` (best-effort, plan-time)

TargetPool CRUD:

- Create/Update: `PUT    {endpoint}/v1/target-pools/{name}`
- Read: `GET    {endpoint}/v1/target-pools/{name}?space={space}`
- Delete: `DELETE {endpoint}/v1/target-pools/{name}?space={space}`

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
Run `go test ./...` in an environment with Go installed.
