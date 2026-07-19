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
The AI Gateway, S3-compatible endpoint, and Cloud usage endpoint are handled through the Cloud extension boundary on the same hosted Cloud origin.

Every Cloud managed resource entrypoint uses the same managed operation
pipeline before a backend API is called. Whether the request comes from a
compatibility endpoint, the direct API, or the Dashboard, it
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
the rest of Takosumi Cloud until that lifecycle has been verified in production;
unverified, expired, or degraded domains fail closed.

## GA Contract And Launch Gate

Takosumi Cloud does not promote this release one service at a time. Its seven
Stable service forms (eight offerings) are one Stable contract, and Takosumi
Cloud stays Pre-GA until every item passes the same readiness matrix.

| Status      | Scope                                                                                      |
| ----------- | ------------------------------------------------------------------------------------------ |
| GA contract | Edge Worker modules, assets, vars, write-only secrets, bindings, versions, and deployments |
| GA contract | Object Storage Standard and Infrequent Access offerings                                    |
| GA contract | KV, Database, and Queue                                                                    |
| GA contract | OpenAI-compatible AI Gateway endpoint                                                      |
| GA contract | verified custom domains                                                                    |
| Preview     | Vector Index, Durable Workflow, Container, Stateful Actor Namespace, and Schedule          |
| Pre-GA      | public GA stays closed until every item passes the same Stable evidence matrix             |

Stable evidence includes lifecycle, price coverage, immutable metering, spend
enforcement, invoice reconciliation, recovery, tenant isolation, Dashboard,
and production behavior and operations validation. A self-test, descriptor,
unconfigured manager, or one green client does not establish GA.

## Billing and Spend Guard

Takosumi Cloud runs on subscription plans and usage metering. Billable
operations are priced by the active Cloud PriceCatalog and stop before execution when
the plan, limits, or payment state do not allow the operation. Cleanup and
destroy operations remain available after a spend-guard block so users can
remove resources instead of leaving them stranded.

Public prices, free-tier terms, usage rates, and spend-guard behavior are
documented in [Takosumi Cloud pricing](./pricing.md). Payment-provider
synchronization, margin guards, and reconciliation implementation details are
service operations rather than public contracts.

The Dashboard shows:

- available balance
- this month's usage
- Cloud resource usage
- recent usage events
- API keys
- current Cloud resources

## Standard protocol endpoints

Object Storage exposes the scoped `compat.s3.v1` data-plane profile. The
canonical Resource API remains the bucket lifecycle authority; the S3 endpoint
resolves a Ready `ObjectBucket` and authorized Interface.

### AI Gateway OpenAI-compatible profile

| Status             | Scope                             |
| ------------------ | --------------------------------- |
| Production Preview | `/gateway/ai/v1/models`           |
| Production Preview | `/gateway/ai/v1/chat/completions` |
| Production Preview | `/gateway/ai/v1/embeddings`       |

Details:

- [Takosumi Cloud resources](./resources.md)
- [Takosumi Cloud endpoints](./endpoints.md)
- [Takosumi Cloud pricing](./pricing.md)
