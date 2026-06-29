# Takosumi Cloud

Takosumi Cloud is the official hosted Takosumi for Operator. It provides the
Git-based OpenTofu control plane, managed targets, Cloud-operated managed
service backends, USD credits / usage metering, and operator support as an
official operation.

The first major offering is Takosumi Cloud Workers. Add an app from Git, run it
on a Worker-compatible runtime, use KV / Object Storage / Database / Queue / AI
as bindings, and keep deploys and updates recorded through OpenTofu/Terraform.
Usage spends from a USD credit balance.

```text
Takosumi Cloud =
  official hosted Takosumi for Operator
  + official managed target pools
  + Cloud-operated managed service backends
  + billing / credits / usage metering
  + support / operations

Takosumi Cloud Workers =
  Worker-compatible app hosting offering
  + managed bindings
  + OpenTofu deploy path
```

## What You Can Host

- host Worker-compatible apps
- use a default `*.app.takos.jp` URL immediately
- attach user-owned custom domains
- configure secrets and environment variables
- use KV / Object Storage / Database / Queue / AI as bindings
- deploy from a Git URL through OpenTofu/Terraform
- inspect usage, balance, API keys, and resource inventory in the Dashboard

## Runtime

HTTP apps run as Takosumi Cloud Workers: a Worker-compatible runtime backed by
Cloudflare Workers for Platforms. User apps are deployed as Worker-like scripts
and routed through a Takosumi-managed dispatch layer.

Durable workflows use Dynamic Workers with `@cloudflare/dynamic-workflows` when
available. Operator/internal jobs use normal Cloudflare Workflows.

| App type                    | Runtime backing                                   |
| --------------------------- | ------------------------------------------------- |
| HTTP Worker-compatible apps | Workers for Platforms dispatch namespace          |
| Durable user workflows      | Dynamic Workers + `@cloudflare/dynamic-workflows` |
| Operator/internal jobs      | Cloudflare Workflows                              |

## Managed Bindings

Takosumi Cloud resources are exposed to Workers as bindings.

| User-facing name | Purpose                         |
| ---------------- | ------------------------------- |
| Worker           | HTTP app / API / app runtime    |
| Route            | public URL / routing rule       |
| Secrets          | write-only runtime secrets      |
| KV               | small key-value data            |
| Object Storage   | files and large objects         |
| Database         | app relational data             |
| Queue            | async jobs and event processing |
| AI Gateway       | OpenAI-compatible AI endpoint   |
| Durable Workflow | durable multi-step execution    |

## Domains

Every Worker has a Takosumi-managed default URL. Users can pick a DNS-valid
single-label `*.app.takos.jp` hostname on a first-come-first-served basis. If no
hostname is requested, Takosumi issues a safe generated hostname.

```text
User-chosen:
  https://my-app.app.takos.jp
  https://blog.app.takos.jp

Auto-issued fallback:
  https://<app-slug>-<short-id>.app.takos.jp
```

Use this URL for previews, first deploys, and apps that do not have external DNS
yet. To use a user-owned domain, add a custom domain and complete DNS ownership
verification. The custom domain then points at the same Worker route.

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

| Stage   | Meaning                                                    |
| ------- | ---------------------------------------------------------- |
| Stable  | billing, deletion, usage ledger, docs, and smoke are ready |
| Preview | usable, but limits and expected changes are documented     |
| Planned | public product direction, not yet available                |

Initial rollout:

| Service          | Stage   |
| ---------------- | ------- |
| Workers          | Stable  |
| Routes           | Stable  |
| Secrets / Vars   | Stable  |
| KV               | Stable  |
| Object Storage   | Stable  |
| Database         | Stable  |
| AI Gateway       | Stable  |
| Queue            | Preview |
| Durable Workflow | Preview |
| Containers       | Planned |
| Stateful apps    | Planned |

## Credits

Takosumi Cloud runs on USD credits. Billable operations are priced by the Cloud
price book and stop before execution when the Workspace balance is insufficient.
Cleanup and destroy operations remain available after credit depletion so users
can remove resources instead of leaving them stranded.

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

| Status      | Scope                                                                  |
| ----------- | ---------------------------------------------------------------------- |
| Stable      | Worker script deploy, routes, secrets, vars                            |
| Stable      | KV namespace, R2 bucket / Object Storage, D1 database / App Database   |
| Preview     | Queue, Durable Workflow, Dynamic Worker workflow support               |
| Planned     | Containers, Durable Objects style stateful apps                        |
| Unsupported | DNS, WAF, Zero Trust, Registrar, Cloudflare account IAM, Load Balancer |
| Unsupported | Email Routing                                                          |

### AI Gateway OpenAI-compatible profile

| Status | Scope                             |
| ------ | --------------------------------- |
| Stable | `/gateway/ai/v1/models`           |
| Stable | `/gateway/ai/v1/chat/completions` |
| Stable | `/gateway/ai/v1/embeddings`       |

The Cloudflare-compatible API is an import and deploy path. Use it when you
want an existing Cloudflare Workers manifest to target Takosumi Cloud.

```hcl
provider "cloudflare" {
  api_token  = var.takosumi_cloud_api_key
  account_id = var.takosumi_virtual_account_id
  base_url   = "https://app.takosumi.com/compat/cloudflare/client/v4"
}
```

Details:

- [Takosumi Cloud Workers](../reference/cloud-workers.md)
- [Takosumi Cloud endpoints](../reference/cloud-endpoints.md)
