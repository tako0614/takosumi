# terraform-provider-takosumi

A thin OpenTofu/Terraform provider for the **Takosumi Resource Shape API**.

Every resource in this provider is Takosumi-owned. It exposes typed
`takosumi_*` resources only for Resource Shapes and operator/admin objects that
Takosumi must resolve, lock, project, meter, or materialize through TargetPool
capability evidence. It does not wrap AWS, Cloudflare, Kubernetes, S3, OpenAI,
VM, or other provider resources, and it does not call those APIs directly. A
resource that is neither a Takosumi-owned service form nor an operator/admin
object should not exist in this provider.

The standard rule is simple: if an industry-standard surface fits, use that
surface. If the service form is real but no adequate standard surface exists,
define a typed Takosumi shape. S3-compatible object storage, OCI registries,
Kubernetes CRDs, CloudEvents, OpenAI-compatible APIs, and scoped Cloudflare
Workers-compatible import/deploy paths are standard-conscious compatibility
surfaces; they are not reasons to add duplicate `takosumi_*` resources. The
Takosumi endpoint owns resolver decisions, credentials, state, drift, and
adapter execution.

Using Takosumi does not require this provider, and this provider is not the
preferred route when a universal surface already exists. Plain OpenTofu stacks
can use existing providers, standard endpoints, compatibility APIs, or
generic-env ProviderConnections. Use `takosumi/takosumi` only when the desired
service form lacks an adequate vendor-neutral provider/protocol and Takosumi
must expose it as a typed Resource Shape or operator/admin object.

That rule is reversible. If a `takosumi_*` resource was created because no
adequate universal surface existed, and a credible vendor-neutral provider or
standard protocol later becomes available, prefer the universal surface for new
work. Keep the Takosumi resource only where it still adds import continuity,
managed-target placement, policy, metering, or migration value.

Current v1alpha1 Resource Shape resources:

| Resource                     | Shape              | Purpose                                             |
| ---------------------------- | ------------------ | --------------------------------------------------- |
| `takosumi_edge_worker`       | `EdgeWorker`       | Worker-compatible JavaScript/TypeScript app runtime |
| `takosumi_object_bucket`     | `ObjectBucket`     | Object storage when Takosumi owns projection/policy |
| `takosumi_kv_store`          | `KVStore`          | Key-value runtime binding/state                     |
| `takosumi_queue`             | `Queue`            | Async delivery and event fan-out                    |
| `takosumi_sql_database`      | `SQLDatabase`      | D1-like sqlite, or operator-supported SQL targets   |
| `takosumi_container_service` | `ContainerService` | OCI container service, separate from EdgeWorker     |

Current operator/admin resources:

| Resource               | Object       | Purpose                                   |
| ---------------------- | ------------ | ----------------------------------------- |
| `takosumi_target_pool` | `TargetPool` | Operator/admin target capability evidence |

AI Gateway is intentionally not a provider resource. Use ProviderConnection,
Secret, output projection, or generic env to pass values such as
`OPENAI_BASE_URL`, `OPENAI_API_KEY`, and model names into an app.

Push notification delivery is intentionally not a provider resource. APNs, FCM,
Web Push, and device-token registration stay in the product shell, product host
API, a normal OpenTofu module/provider, or generic env.

Ordinary S3/R2/GCS/MinIO buckets, Kubernetes resources, VMs, and provider-owned
cloud services should use existing OpenTofu providers through the plain Stack
flow when that is enough.

Takos itself is not a reason to add a product-specific provider resource. The
Takos distribution should be expressed as a composition of generic service
forms such as `takosumi_edge_worker`, `takosumi_sql_database`,
`takosumi_kv_store`, `takosumi_object_bucket`, `takosumi_queue`, and
`takosumi_container_service`. Consumer shapes use the typed `connections`
attribute to declare non-secret resource references, requested permissions, and
projection kind; the selected adapter owns concrete grant/binding
materialization. Before adapter execution, the Takosumi endpoint resolves every
reference to a Ready Resource in the same Space and supplies only its public
outputs, selected Target, and NativeResource identifiers. Missing, cross-Space,
or not-Ready references fail before backend calls, and referenced Resources
cannot be deleted before their consumers. The provider proof
`bun run opentofu:takos-shape-provider-proof`
exercises that composition and intentionally avoids a `takosumi_takos`
catch-all resource.

The same rule applies to yurucommu-style Worker apps. The provider proof
`bun run opentofu:yurucommu-shape-provider-proof` expresses yurucommu as one
`takosumi_edge_worker`, `takosumi_sql_database`, `takosumi_object_bucket`,
`takosumi_kv_store`, and delivery/DLQ `takosumi_queue` resources. It
intentionally avoids a `takosumi_yurucommu` catch-all resource.

## Provider / API Boundary

`provider-neutral` in Takosumi docs means vendor-independent as a Takosumi
service contract. It does not mean this provider is a generic provider catalog.

The provider does:

```text
typed HCL schemas for Takosumi-owned shapes
local validation
Takosumi discovery and capability checks
Resource API apply/delete/status calls
status polling
minimal OpenTofu state mapping
```

Resource API apply/delete calls may wait for server-side OpenTofu plan/apply or
destroy work to finish. The provider HTTP client therefore uses a multi-minute
timeout; backend execution still belongs to the Takosumi endpoint, not to the
provider binary.

Provider `Read` calls
`POST /v1/resources/{kind}/{name}/observe?space=...`, not a ledger-only GET.
This starts a read-only drift check against the Resource's pinned
ResolutionLock and refreshes status conditions in OpenTofu state. It never
turns the drift plan into an apply, changes the selected Target, or stores
provider credentials in state. Explicit recovery tooling can separately call
`POST /v1/resources/{kind}/{name}/refresh?space=...`; it applies a reviewed
OpenTofu refresh-only plan (or plugin refresh), publishes new state/outputs, and
never changes native provider resources. Backend adoption is the separate
`POST /v1/resources/{kind}/{name}/import` operation and requires the complete
Resource spec plus a provider-native `nativeId`. The API plans a read-only
config-driven import before publishing Resource-owned state and outputs. The Go
client exposes this as `ImportResource`. Terraform/OpenTofu `ImportState`
continues to adopt an already-existing Takosumi ledger Resource; when starting
from an unmanaged backend object, call the adoption API first because the
provider import callback does not receive enough generic shape configuration to
construct that Resource safely.

The provider does not start a separate remote Resource API preview from
OpenTofu `ModifyPlan`. Typed provider schemas produce the normal OpenTofu plan,
and the Resource API apply path performs the authoritative server-side
resolution, plan, and policy guard exactly once. `POST /v1/resources/preview`
remains available to explicit API/console callers that request a backend-aware
preview.

The provider does not:

```text
call vendor APIs directly
choose a backend in the provider binary
mint credentials
store secrets in state
expose takosumi_resource { type, spec }
branch on OSS / Operator / Cloud edition names
```

The Resource API is Takosumi-native and follows standard control-plane API
conventions: `apiVersion`, `kind`, `metadata`, `spec`, `status`,
`conditions`, stable resource ids, idempotent create/update, preview before
apply, explicit delete, observe/refresh for drift, import for adoption,
capability discovery, cursor pagination, and structured error codes.

Compatibility APIs are separate first-class surfaces. They preserve standard
protocol/API facades when Takosumi provides the backend or import path. When
Takosumi exposes S3-compatible storage, OCI registry, CloudEvents, Kubernetes
CRDs, OpenAI-compatible AI Gateway, or a Cloudflare Workers-compatible subset,
those facades enter Takosumi-managed capabilities. They are not this provider's
internal model, and the provider is not the canonical route for them. Internal
normalization into Resource API state, usage, or audit records is bookkeeping,
not a public hierarchy or a promise of full vendor API compatibility.

## Build And Test

```bash
cd provider
go build ./...
go test ./...
```

## Local Install

```bash
cd provider
go build -o terraform-provider-takosumi .
```

Add a dev override:

```hcl
provider_installation {
  dev_overrides {
    "takosjp/takosumi" = "/absolute/path/to/provider"
  }
  direct {}
}
```

## Worker Assets Mirror

Takosumi-hosted deployments serve the provider from the platform Worker's
static assets. Generate the mirror assets before building/deploying the
dashboard:

```bash
TAKOSUMI_PROVIDER_VERSION=0.1.0 bun run provider:assets
cd dashboard && bun run build
```

Network mirror base URL:

```text
https://app.takosumi.com/opentofu/providers/
```

## Configuration

```hcl
provider "takosumi" {
  endpoint = "https://takosumi.example.com" # or TAKOSUMI_ENDPOINT
  space    = "prod"                         # or TAKOSUMI_SPACE
  # token  = "..."                          # or TAKOSUMI_TOKEN
}
```

On configure the provider reads:

```text
GET {endpoint}/.well-known/takosumi
GET {endpoint}/v1/capabilities
```

It branches on capabilities, not edition names.

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

resource "takosumi_target_pool" "default" {
  name = "default"

  target = [{
    name           = "cloudflare-main"
    type           = "cloudflare"
    ref            = "cf-account-id"
    credential_ref = "conn_cloudflare_main"
    priority       = 80
  }, {
    name           = "containers-main"
    type           = "kubernetes"
    ref            = "cluster-prod"
    credential_ref = "conn_k8s_prod"
    priority       = 70

    implementation = [{
      shape                = "ContainerService"
      implementation       = "kubernetes_deployment"
      native_resource_type = "kubernetes.deployment"

      interfaces = {
        oci_container = "native"
        public_http   = "shim"
        "custom.mesh" = "native"
      }
    }]
  }]
}

resource "takosumi_edge_worker" "api" {
  name               = "api"
  artifact_url       = "https://example.com/releases/api-worker.js"
  artifact_sha256    = "sha256:1111111111111111111111111111111111111111111111111111111111111111"
  target_pool        = "default"
  compatibility_date = "2026-06-29"
  profiles           = ["workers_bindings"]
}

resource "takosumi_object_bucket" "assets" {
  name        = "assets"
  target_pool = "default"
  interfaces  = ["s3_api", "signed_url"]
}

resource "takosumi_kv_store" "cache" {
  name        = "cache"
  consistency = "eventual"
}

resource "takosumi_queue" "delivery" {
  name           = "delivery"
  max_retries    = 5
  max_batch_size = 25
}

resource "takosumi_sql_database" "main" {
  name            = "main"
  engine          = "sqlite"
  migrations_path = "migrations"
}

resource "takosumi_container_service" "agent" {
  name        = "agent"
  image       = "ghcr.io/example/agent:1.0.0"
  ports       = [8080]
  public_http = true

  environment = {
    NODE_ENV = "production"
  }
}
```

## Resource Notes

Common computed fields:

| Attribute                 | Type        | Notes                                   |
| ------------------------- | ----------- | --------------------------------------- |
| `id`                      | string      | `tkrn:{space}:{Kind}:{name}`            |
| `selected_implementation` | string      | Resolver-selected backend               |
| `target`                  | string      | Target the resource landed on           |
| `locked`                  | bool        | Whether the resolution is locked        |
| `portability`             | string      | Resolver portability assessment         |
| `outputs`                 | map(string) | Resolved outputs from the selected plan |

Shape-specific fields:

| Resource                     | Required fields                                  | Optional fields                                                                           |
| ---------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `takosumi_edge_worker`       | `name`, one of `artifact_path` or `artifact_url` | `artifact_sha256`, `target_pool`, `compatibility_date`, `compatibility_flags`, `profiles` |
| `takosumi_object_bucket`     | `name`                                           | `target_pool`, `interfaces`                                                               |
| `takosumi_kv_store`          | `name`                                           | `target_pool`, `consistency`                                                              |
| `takosumi_queue`             | `name`                                           | `target_pool`, `max_retries`, `max_batch_size`                                            |
| `takosumi_sql_database`      | `name`                                           | `target_pool`, `engine`, `migrations_path`                                                |
| `takosumi_container_service` | `name`, `image`                                  | `target_pool`, `ports`, `public_http`, `environment`                                      |

`artifact_path` is a runner-local path for Takosumi-run OpenTofu stacks.
`artifact_url` is for CI/release artifacts consumed by the generated OpenTofu
module through `hashicorp/http`; it requires `artifact_sha256` so the runner
fails closed if the bytes change.

`profiles`, `compatibility_flags`, and shape `interfaces` such as
`takosumi_object_bucket.interfaces` are endpoint-defined tokens. The provider
only rejects blank/whitespace values; the configured Takosumi endpoint's
capabilities, TargetPool policy, adapter evidence, and Resolver decide whether
the token is supported.

Operator/admin fields:

| Resource               | Required fields              | Optional fields                                                                                                 |
| ---------------------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `takosumi_target_pool` | `name`, one or more `target` | complete module (`provider_source`, `module_template`, input/output JSON) or `plugin` implementation descriptor |

`TargetPool` is the execution authority for each Resource Shape implementation.
`type`, `shape`, and `implementation` are opaque tokens: neither Takosumi Core
nor this provider derives a provider, module, input, native resource name, or
capability matrix from them. A descriptor selects exactly one path:

- `plugin` plus optional non-secret `options_json`; or
- `provider_source` + `module_template`, with explicit provider config,
  module-input mappings, and public module outputs.

For example, an operator can explicitly wire an EdgeWorker implementation to
an operator-owned module-registry entry and a compatibility endpoint. The
opaque `module_template` token below is meaningful only to that injected
registry; Takosumi ships no module under this name:

```hcl
implementation {
  shape          = "EdgeWorker"
  implementation = "operator.edge-worker.v1"
  provider_source = "cloudflare/cloudflare"
  module_template = "cloudflare-worker-service"

  interfaces = {
    worker_fetch     = "native"
    workers_bindings = "native"
  }

  provider_config_json = jsonencode({
    base_url = "https://operator.example.test/compat/client/v4"
  })

  module_input_mappings_json = jsonencode({
    workerName = { source = "spec", path = "/name", required = true }
    accountId  = { source = "target", path = "/ref", required = true }
    artifactPath = { source = "spec", path = "/source/artifactPath" }
  })

  module_outputs_json = jsonencode([
    { name = "worker_name", type = "string" },
    { name = "url", type = "url" }
  ])
}
```

An operator-defined shape/backend can instead use the plugin seam without a
provider module:

```hcl
implementation {
  shape          = "WorkflowEngine"
  implementation = "operator.workflow.v2"
  plugin         = "workflow-adapter"
  interfaces     = {}
  options_json = jsonencode({
    runtime_class = "durable"
  })
}
```

Provider credentials never belong in descriptor JSON. The selected
ProviderConnection and CredentialRecipe remain the only env/file/pre-run
credential authority. URL-valued provider configuration is subject to the
operator allowlist.

Extension happens at the implementation layer, not by inventing live provider
schemas. A new HCL resource such as `takosumi_workflow` requires a provider/API
release. A new backend for an existing shape, such as another
`ContainerService` runtime, is declared by the operator through TargetPool
implementation capability evidence and an adapter plugin. Provider capability
documents may advertise those operator-defined adapter tokens as additional
boolean keys under `adapters`.

Secrets must not be placed in Resource Shape specs. Use ProviderConnection,
CredentialRecipe, Secret, or generic env materialization.
