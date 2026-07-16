# Takosumi Cloud

Takosumi Cloud is the official Takosumi hosting we operate. Publish apps and
APIs from Git at a `*.app.takos.jp` URL, straight from the browser. Attach
managed resources — storage, databases, queues, AI — as you need them. Pricing
is a plan plus what you use ([pricing](./pricing.md)).

These docs cover the hosted Takosumi Cloud service served from
`app.takosumi.com`. Portable Takosumi software and Takosumi for Operator docs
live separately at [takosumi.com/docs](https://takosumi.com/docs/en/).

## What You Can Host

- host apps, APIs, and services
- use a default `*.app.takos.jp` URL immediately
- configure secrets and environment variables
- use KV / Object Storage / Database / Queue / AI as bindings
- deploy from a Git URL through OpenTofu/Terraform
- inspect usage, payment state, API keys, and resource inventory in the Dashboard

## What It Is Made Of

Takosumi Cloud is Takosumi the software (a Git-based deploy control plane that
records plan → review → apply) with official managed targets, billing, and
support on top.

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

Add an app or service from Git, attach the resources it needs as bindings, and
deploys and updates are recorded. Edge JS runtime, Object Storage, KV,
Database, Queue, AI, and Container are peer managed resources. Usage spends
through the plan, limits, and payment-state spend guard.

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

User-owned custom domains are part of the GA contract. An owner-account and
Workspace-scoped `VerifiedDomain` manages ownership challenge, certificate,
attach/detach, renewal, expiry, and delete. A route is active only while both
ownership and certificate state are current. The lifecycle remains Pre-GA with
the rest of Takosumi Cloud until reviewed live launch evidence exists; unverified,
expired, or degraded domains fail closed.

## GA Contract And Launch Gate

Takosumi Cloud does not promote this release one service at a time. The
Cloudflare Developer Platform-like set below is one Stable contract, and
Takosumi Cloud stays Pre-GA until every item passes the same readiness matrix.
An API or runtime becoming usable early does not make that item independently
Stable or GA.

| Status      | Scope                                                                                      |
| ----------- | ------------------------------------------------------------------------------------------ |
| GA contract | Edge Worker modules, assets, vars, write-only secrets, bindings, versions, and deployments |
| GA contract | managed URLs, routes, cron, logs, and verified custom domains                              |
| GA contract | Object Storage, KV, Database, Queue, and Vector Index                                      |
| GA contract | Durable Workflow, Container, Stateful Actor Namespace, and Schedule                        |
| GA contract | OpenAI-compatible AI Gateway endpoint                                                      |
| Pre-GA      | public GA stays closed until every item passes the same Stable evidence matrix             |

Stable evidence includes lifecycle, price coverage, immutable metering, spend
enforcement, invoice reconciliation, recovery, tenant isolation, Dashboard,
and reviewed live launch evidence. A self-test, descriptor, unconfigured manager, or
one green client does not establish GA.

## Billing and Spend Guard

Takosumi Cloud runs on subscription plans and usage metering. Billable
operations are priced by the active Cloud PriceCatalog and stop before execution when
the plan, limits, or payment state do not allow the operation. Cleanup and
destroy operations remain available after a spend-guard block so users can
remove resources instead of leaving them stranded.

Public prices, free-tier terms, usage rates, and spend-guard behavior are
documented in [Takosumi Cloud pricing](./pricing.md). PriceCatalog publication,
payment-provider synchronization, margin guards, and reconciliation are
operational details, not public contracts.

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

The compatibility contract is pinned to selected Cloudflare provider `5.19.1`
schemas. It is an entry point into Takosumi Cloud Resources, not a clone of the
whole Cloudflare account or API.

| Status      | Scope                                                                                                         |
| ----------- | ------------------------------------------------------------------------------------------------------------- |
| GA contract | EdgeWorker modules, assets, vars, write-only secrets, bindings, versions, deployments, routes, cron, and logs |
| GA contract | managed URL and verified-custom-domain `http.route` Interfaces                                                |
| GA contract | ObjectBucket plus the documented R2/S3 control and data subset                                                |
| GA contract | provider `5.19.1` selected subset for KVStore, SQLDatabase, Queue, and DurableWorkflow                        |
| GA contract | typed Resource API for VectorIndex, ContainerService, StatefulActorNamespace, and Schedule                    |
| GA contract | AI Gateway OpenAI-compatible endpoint                                                                         |
| Pre-GA      | public GA stays closed until every item passes the same Stable evidence matrix                                |
| Unsupported | Pages, Hyperdrive, Analytics Engine, Browser Rendering, Images, Stream, and Pipelines                         |
| Unsupported | DNS, WAF, Zero Trust, Registrar, account IAM, Load Balancer, and Email Routing                                |

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
