# Takosumi Cloud Resources

Takosumi Cloud is the official hosted Takosumi for Operator for managed app,
service, and data resources on official targets. `EdgeWorker` is one of several
service forms.

```text
Takosumi Cloud Resources =
  EdgeWorker
  + ContainerService
  + ObjectBucket
  + KVStore
  + SQLDatabase
  + Queue
  + AI Gateway
  + routes / domains / secrets
  + USD credits / usage metering
  + OpenTofu deploys
```

The Cloudflare-compatible API is not the product identity. It is an import and
deploy path for existing Terraform/OpenTofu manifests that already target
Cloudflare Workers resources and should be imported into Takosumi Cloud
`EdgeWorker` plus managed bindings.

## Product Vocabulary

Use these terms in landing pages and the main app UI:

- App / Service
- Edge Worker
- Container
- Bindings
- Routes
- Default URL
- Custom Domain
- Secrets
- KV
- Object Storage
- Database
- Queue
- AI Gateway
- Durable Workflow

Keep `compat.cloudflare.workers.v1` as the architecture and compatibility
capability name. Use Takosumi Cloud resources / services as the main headline
and UI language.

## Runtime Architecture

`EdgeWorker` is the service form for edge JavaScript / TypeScript apps.
Takosumi Cloud can implement it with Cloudflare Workers for Platforms and a
Takosumi-managed dispatch layer.

That is a Cloud implementation detail. The Cloud resource model is not limited
to `EdgeWorker`. OCI-image services are `ContainerService`, object storage is
`ObjectBucket`, app databases are `SQLDatabase`, and durable workflows are a
separate shape.

```text
Edge JS app:
  EdgeWorker -> Cloudflare Workers for Platforms dispatch namespace

Container service:
  ContainerService -> Cloudflare Containers or another operator target

Durable user workflow:
  DurableWorkflow -> Dynamic Workers + @cloudflare/dynamic-workflows where available

Operator/internal jobs:
  Cloudflare Workflows
```

References:

- [How Workers for Platforms works](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/how-workers-for-platforms-works/)
- [Dynamic Workflows](https://developers.cloudflare.com/dynamic-workers/usage/dynamic-workflows/)

## Domains And Routes

Public HTTP resources can receive a Takosumi-managed default URL. Users can
reserve a DNS-valid single-label `*.app.takos.jp` hostname on a
first-come-first-served basis.

```text
https://my-app.app.takos.jp
```

Custom domains are additional user-owned hostnames attached to the same route.
Dashboard and OpenTofu route lifecycle records carry:

| Field              | Meaning                                     |
| ------------------ | ------------------------------------------- |
| `default_hostname` | Takosumi managed `*.app.takos.jp` hostname  |
| `custom_domains`   | verified or pending user-owned hostnames    |
| `pattern`          | route pattern used by compatibility imports |
| `target`           | EdgeWorker / ContainerService target        |

`default_hostname` is first-come-first-served. If no hostname is requested,
Takosumi issues one as `<app-slug>-<short-id>.app.takos.jp`.

## Compatibility Matrix

The Cloudflare import capability is `compat.cloudflare.workers.v1`. It exposes
only the subset needed to import Workers-oriented resources into Takosumi Cloud
resources. Unsupported Cloudflare products stay explicit.

| Status      | Scope                                                                  |
| ----------- | ---------------------------------------------------------------------- |
| Stable      | Worker script deploy to `EdgeWorker`                                   |
| Stable      | Worker routes to Takosumi routes / default hostnames                   |
| Stable      | Worker secrets / vars                                                  |
| Stable      | KV namespace                                                           |
| Stable      | R2 bucket / Object Storage                                             |
| Stable      | D1 database / App Database                                             |
| Preview     | Queue                                                                  |
| Preview     | Durable Workflow                                                       |
| Preview     | Dynamic Worker workflow support                                        |
| Planned     | Containers                                                             |
| Planned     | Durable Objects style stateful apps                                    |
| Unsupported | DNS, WAF, Zero Trust, Registrar, Cloudflare account IAM, Load Balancer |
| Unsupported | Email Routing                                                          |

AI Gateway is not part of Workers compatibility. It is a separate
OpenAI-compatible endpoint profile. See
[AI Gateway in Cloud endpoints](./cloud-endpoints.md#ai-gateway).

## OpenTofu Import Path

The Cloudflare-compatible API is the import path for Cloudflare
Workers-oriented manifests.

```hcl
provider "cloudflare" {
  api_token  = var.takosumi_cloud_api_key
  account_id = var.takosumi_virtual_account_id
  base_url   = "https://app.takosumi.com/compat/cloudflare/client/v4"
}
```

Use this wording in docs:

```text
Deploy apps and managed resources to Takosumi Cloud.
Use Cloudflare-compatible Terraform/OpenTofu resources when importing Workers-oriented apps.
```

Switching between real Cloudflare and Takosumi Cloud belongs in Provider
Binding / Provider Connection. Do not put raw secrets in the manifest.

On Takosumi Cloud, this import path can be used without creating an app
installation first. It still requires an authenticated token and a billing
Workspace. Billable writes spend Workspace credits and are not forwarded to the
compatibility handler when the Workspace has insufficient balance.
