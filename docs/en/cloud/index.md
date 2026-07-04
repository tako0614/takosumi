# Takosumi Cloud

Takosumi Cloud is the official hosted Takosumi for Operator. It provides the
Git-based OpenTofu control plane, managed targets, Cloud-operated managed
service backends, USD credits / usage metering, and operator support as an
official operation.

Takosumi Cloud covers more than one service form. Add an app or service from Git,
attach the resources it needs as bindings, and keep deploys and updates
recorded through OpenTofu/Terraform. Edge JS runtime, Object Storage, KV,
Database, Queue, AI, and Container are peer managed resources. Usage spends
from a USD credit balance.

```text
Takosumi Cloud =
  official hosted Takosumi for Operator
  + official managed target pools
  + Cloud-operated managed service backends
  + billing / credits / usage metering
  + support / operations

Takosumi Cloud Resources =
  official managed resource offerings
  + managed bindings
  + OpenTofu deploy path
```

## What You Can Host

- host apps, APIs, and services
- use a default `*.app.takos.jp` URL immediately
- attach user-owned custom domains
- configure secrets and environment variables
- use KV / Object Storage / Database / Queue / AI as bindings
- deploy from a Git URL through OpenTofu/Terraform
- inspect usage, balance, API keys, and resource inventory in the Dashboard

## Runtime

Edge JS apps run as `EdgeWorker` resources. Takosumi Cloud can implement them
with Cloudflare Workers for Platforms and a Takosumi-managed dispatch layer.
This is one Cloud resource, separate from ContainerService, Object Storage, KV,
Database, Queue, and AI.

Every Cloud managed resource entrypoint uses the same managed operation
pipeline before a backend API is called. Whether the request comes from a
compatibility endpoint, the `takosumi/takosumi` provider, or the Dashboard, it
passes through authentication, Workspace billing context, Resource /
NativeResource normalization, managed-operation dispatch planning,
selected-manager availability checks, usage / credit guard, and then manager
dispatch. The selected manager chooses Workers for Platforms, R2, D1, KV,
Queues, Containers, or another operator backend. A recognized service form whose
manager is not configured fails before usage is charged and before any backend
API call; it does not fall back to another compatibility path.

Durable workflows use Dynamic Workers with `@cloudflare/dynamic-workflows` when
available. Operator/internal jobs use normal Cloudflare Workflows.

| Service form           | Backing example                                   |
| ---------------------- | ------------------------------------------------- |
| Edge JS app            | Workers for Platforms dispatch namespace          |
| Container service      | Cloudflare Containers or another operator target  |
| Durable user workflow  | Dynamic Workers + `@cloudflare/dynamic-workflows` |
| Operator/internal jobs | Cloudflare Workflows                              |

## Managed Bindings

Takosumi Cloud resources are exposed to apps and services as bindings.

| User-facing name | Purpose                         |
| ---------------- | ------------------------------- |
| Edge Worker      | Edge JS app / API runtime       |
| Container        | OCI image based service         |
| Route            | public URL / routing rule       |
| Secrets          | write-only runtime secrets      |
| KV               | small key-value data            |
| Object Storage   | files and large objects         |
| Database         | app relational data             |
| Queue            | async jobs and event processing |
| AI Gateway       | OpenAI-compatible AI endpoint   |
| Durable Workflow | durable multi-step execution    |

## Domains

Every public HTTP resource can receive a Takosumi-managed default URL. Users
can pick a DNS-valid single-label `*.app.takos.jp` hostname on a
first-come-first-served basis. If no hostname is requested, Takosumi issues a
safe generated hostname.

```text
User-chosen:
  https://my-app.app.takos.jp
  https://blog.app.takos.jp

Auto-issued fallback:
  https://<app-slug>-<short-id>.app.takos.jp
```

Use this URL for previews, first deploys, and apps that do not have external DNS
yet. To use a user-owned domain, add a custom domain and complete DNS ownership
verification. The custom domain then points at the same route.

```text
Default URL:
  my-app.app.takos.jp

Custom domains:
  app.example.com
  www.example.com
```

The `*.app.takos.jp` namespace is first-come-first-served. A duplicate hostname
reservation fails, and platform-reserved names are unavailable. The default URL
remains available when a custom domain is pending, expired, or disabled. This
keeps inspection and removal possible even during DNS mistakes or domain
transfers.

## Service Rollout

Takosumi Cloud services are not all GA at once. We publish services gradually
and promote them to Stable only when Dashboard, docs, billing, destroy proof,
usage ledger, and runtime guard evidence are in place.

| Stage              | Meaning                                                                          |
| ------------------ | -------------------------------------------------------------------------------- |
| Stable             | publicly GA, with billing, deletion, usage ledger, docs, and smoke ready         |
| Production Preview | available on the production runtime before GA readiness / live billing promotion |
| Preview            | usable, but limits and expected changes are documented                           |
| Planned            | public product direction, not yet available                                      |

Initial rollout:

| Service          | Stage              |
| ---------------- | ------------------ |
| Edge Worker      | Production Preview |
| Routes           | Production Preview |
| Secrets / Vars   | Production Preview |
| KV               | Production Preview |
| Object Storage   | Production Preview |
| Database         | Production Preview |
| AI Gateway       | Production Preview |
| Queue            | Preview            |
| Durable Workflow | Preview            |
| Containers       | Planned            |
| Stateful apps    | Planned            |

## Credits

Takosumi Cloud runs on USD credits. Billable operations are priced by the Cloud
price book and stop before execution when the Workspace balance is insufficient.
Cleanup and destroy operations remain available after credit depletion so users
can remove resources instead of leaving them stranded.

Public prices, free-tier terms, usage rates, and credit-exhaustion behavior are
documented in [Takosumi Cloud pricing](./pricing.md). Runtime price books,
payment-provider synchronization, margin guards, and reconciliation are
operator operation details, not public contracts.

The Dashboard shows:

- available balance
- this month's usage
- Cloud resource usage
- recent usage events
- API keys
- current Cloud resources

## Compatibility Profiles

Takosumi Cloud separates compatibility by profile. The Cloudflare-compatible API
is the `compat.cloudflare.workers.v1` import/deploy path, not full Cloudflare API
compatibility. AI Gateway is a separate OpenAI-compatible profile.

### `compat.cloudflare.workers.v1`

| Status             | Scope                                                                  |
| ------------------ | ---------------------------------------------------------------------- |
| Production Preview | Worker script deploy, routes, secrets, vars                            |
| Production Preview | KV namespace, R2 bucket / Object Storage, D1 database / App Database   |
| Preview            | Queue, Durable Workflow, Dynamic Worker workflow support               |
| Planned            | Containers, Durable Objects style stateful apps                        |
| Unsupported        | DNS, WAF, Zero Trust, Registrar, Cloudflare account IAM, Load Balancer |
| Unsupported        | Email Routing                                                          |

### AI Gateway OpenAI-compatible profile

| Status             | Scope                             |
| ------------------ | --------------------------------- |
| Production Preview | `/gateway/ai/v1/models`           |
| Production Preview | `/gateway/ai/v1/chat/completions` |
| Production Preview | `/gateway/ai/v1/embeddings`       |

The Cloudflare-compatible API is an import and deploy path. Use it when you
want an existing Cloudflare Workers manifest to target Takosumi Cloud
`EdgeWorker` and managed bindings.

```hcl
provider "cloudflare" {
  api_token  = var.takosumi_cloud_api_key
  account_id = var.takosumi_virtual_account_id
  base_url   = "https://app.takosumi.com/compat/cloudflare/client/v4"
}
```

Details:

- [Takosumi Cloud resources](../reference/cloud-resources.md)
- [Takosumi Cloud endpoints](../reference/cloud-endpoints.md)
- [Takosumi Cloud pricing](./pricing.md)
