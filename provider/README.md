# terraform-provider-takosumi

A thin OpenTofu/Terraform provider for the **Takosumi Resource Shape API**.

It exposes typed `takosumi_*` resources only for service forms Takosumi must
resolve, lock, project, meter, or materialize through TargetPool capability
evidence. It does not call AWS, Cloudflare, Kubernetes, or VM APIs directly. The
Takosumi endpoint owns resolver decisions, credentials, state, drift, and
adapter execution.

Current v1alpha1 resources:

| Resource                     | Shape              | Purpose                                             |
| ---------------------------- | ------------------ | --------------------------------------------------- |
| `takosumi_edge_worker`       | `EdgeWorker`       | Worker-compatible JavaScript/TypeScript app runtime |
| `takosumi_object_bucket`     | `ObjectBucket`     | Object storage when Takosumi owns projection/policy |
| `takosumi_kv_store`          | `KVStore`          | Key-value runtime binding/state                     |
| `takosumi_queue`             | `Queue`            | Async delivery and event fan-out                    |
| `takosumi_push_notification` | `PushNotification` | Web Push, APNs, or FCM notification channel         |
| `takosumi_sql_database`      | `SQLDatabase`      | D1-like sqlite, or operator-supported SQL targets   |
| `takosumi_container_service` | `ContainerService` | OCI container service, separate from EdgeWorker     |
| `takosumi_target_pool`       | `TargetPool`       | Operator/admin target capability evidence           |

AI Gateway is intentionally not a provider resource. Use ProviderConnection,
Secret, output projection, or generic env to pass values such as
`OPENAI_BASE_URL`, `OPENAI_API_KEY`, and model names into an app.

Ordinary S3/R2/GCS/MinIO buckets, Kubernetes resources, VMs, and provider-owned
cloud services should use existing OpenTofu providers through the plain Stack
flow when that is enough.

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
      implementation       = "custom_container_runtime"
      native_resource_type = "custom.container_service"
      plugin               = "takosumi-container-plugin"
      options_json         = jsonencode({ runtimeClass = "edge" })

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
  artifact_path      = "/work/dist/worker.js"
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

resource "takosumi_push_notification" "push" {
  name        = "push"
  protocols   = ["web_push", "fcm"]
  ttl_seconds = 3600
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

| Resource                     | Required fields              | Optional fields                                                               |
| ---------------------------- | ---------------------------- | ----------------------------------------------------------------------------- |
| `takosumi_edge_worker`       | `name`, `artifact_path`      | `target_pool`, `compatibility_date`, `compatibility_flags`, `profiles`        |
| `takosumi_object_bucket`     | `name`                       | `target_pool`, `interfaces`                                                   |
| `takosumi_kv_store`          | `name`                       | `target_pool`, `consistency`                                                  |
| `takosumi_queue`             | `name`                       | `target_pool`, `max_retries`, `max_batch_size`                                |
| `takosumi_push_notification` | `name`                       | `target_pool`, `protocols`, `ttl_seconds`                                     |
| `takosumi_sql_database`      | `name`                       | `target_pool`, `engine`, `migrations_path`                                    |
| `takosumi_container_service` | `name`, `image`              | `target_pool`, `ports`, `public_http`, `environment`                          |
| `takosumi_target_pool`       | `name`, one or more `target` | `credential_ref`, operator-defined `implementation`, `plugin`, `options_json` |

Secrets must not be placed in Resource Shape specs. Use ProviderConnection,
CredentialRecipe, Secret, or generic env materialization.
