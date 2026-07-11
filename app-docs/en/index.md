# Takosumi Cloud

Takosumi Cloud is the official hosted Takosumi for Operator. It provides the
Git-based OpenTofu control plane, managed targets, Cloud-operated managed
service backends, billing / usage metering, and operator support as an
official operation.

These docs cover the hosted Takosumi Cloud service served from
`app.takosumi.com`. Portable Takosumi software and Takosumi for Operator docs
live separately at [takosumi.com/docs](https://takosumi.com/docs/en/).

Takosumi Cloud covers more than one service form. Add an app or service from Git,
attach the resources it needs as bindings, and keep deploys and updates
recorded through OpenTofu/Terraform. Edge JS runtime, Object Storage, KV,
Database, Queue, AI, and Container are peer managed resources. Usage spends
through the plan, limits, and payment-state spend guard.

```text
Takosumi Cloud =
  official hosted Takosumi for Operator
  + official managed target pools
  + Cloud-operated managed service backends
  + billing / usage metering / spend guard
  + support / operations

Takosumi Cloud Resources =
  official managed resource offerings
  + managed bindings
  + OpenTofu deploy path
```

## What You Can Host

- host apps, APIs, and services
- use a default `*.app.takos.jp` URL immediately
- configure secrets and environment variables
- use KV / Object Storage / Database / Queue / AI as bindings
- deploy from a Git URL through OpenTofu/Terraform
- inspect usage, payment state, API keys, and resource inventory in the Dashboard

## Runtime

Edge JS apps run as `EdgeWorker` resources. Takosumi Cloud can implement them
with Cloudflare Workers for Platforms and a Takosumi-managed dispatch layer.
This is one Cloud resource, separate from ContainerService, Object Storage, KV,
Database, Queue, and AI.
The AI Gateway, Cloudflare Workers-compatible profile, S3-compatible endpoint,
and Cloud usage endpoint are handled through the Cloud extension boundary on
the same hosted Cloud origin.

Every Cloud managed resource entrypoint uses the same managed operation
pipeline before a backend API is called. Whether the request comes from a
compatibility endpoint, the `takosumi/takosumi` provider, or the Dashboard, it
passes through authentication, source Workspace context, owner billing context, Resource /
NativeResource normalization, managed-operation dispatch planning,
selected-manager availability checks, usage / spend guard, and then manager
dispatch. The selected manager chooses Workers for Platforms, R2, D1, KV,
Queues, Containers, or another operator backend. A recognized service form whose
manager is not configured fails before usage is charged and before any backend
API call; it does not fall back to another compatibility path.
Billing is not separated per Workspace: usage preserves the source Workspace as
metadata, while credits are spent from the owning user's account balance.

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

Public HTTP resources can currently receive a managed URL under an
operator-owned base domain. The Takosumi Cloud default base domain is
`app.takos.jp`. There are two allocation modes: `scoped` and `vanity`.

```text
scoped:
  https://<workspace-handle>-<label>.app.takos.jp
  consumes no vanity slot

vanity:
  https://<label>.app.takos.jp
  consumes one finite slot owned by the Workspace's immutable owner account
```

Use this URL for previews, first deploys, and apps that do not have external DNS
yet. Neither mode requires DNS ownership verification. `scoped` consumes no
vanity slot. `vanity` is first-come-first-served and requires a DNS-valid single
label, global uniqueness, an available owner-account slot, reserved-label
checks, and abuse policy. Conflict and slot-limit errors do not disclose the
claimant Workspace or Capsule.
The reservation and vanity slot belong to the Capsule lifetime and are released
by a successful Capsule destroy, not by deleting an individual route.

User-owned custom domains are **Planned**. DNS ownership verification and the
certificate lifecycle are not implemented yet, so a request that supplies a
custom domain to a Cloud-managed route fails closed and is not activated as a
usable route.

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
| Custom Domains   | Planned            |

## Billing and Spend Guard

Takosumi Cloud runs on subscription plans and usage metering. Billable
operations are priced by the Cloud price book and stop before execution when
the plan, limits, or payment state do not allow the operation. Cleanup and
destroy operations remain available after a spend-guard block so users can
remove resources instead of leaving them stranded.

Public prices, free-tier terms, usage rates, and spend-guard behavior are
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
| Planned            | User-owned custom domains                                              |
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

- [Takosumi Cloud resources](./resources.md)
- [Takosumi Cloud endpoints](./endpoints.md)
- [Takosumi Cloud pricing](./pricing.md)
