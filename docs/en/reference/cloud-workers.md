# Takosumi Cloud Workers

Takosumi Cloud Workers is the Takosumi Cloud-only runtime for hosting
Worker-compatible apps. It should read as application hosting with Workers,
bindings, routes, secrets, usage credits, and OpenTofu deploys.

```text
Takosumi Cloud Workers =
  Worker-compatible app hosting
  + managed bindings
  + USD credits / usage metering
  + OpenTofu deploys
```

The Cloudflare-compatible API is not the product identity. It is an import and
deploy path for existing Terraform/OpenTofu manifests that already target
Cloudflare Workers resources.

## Product Identity

Use these terms in landing pages and the main app UI:

- Worker
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
capability name. Use Worker-compatible hosting as the main headline and UI
language.

## Runtime Architecture

Worker-compatible HTTP apps are backed by Cloudflare Workers for Platforms.
User applications are deployed as Worker-like scripts and routed through a
Takosumi-managed dispatch layer.

Cloudflare's Workers for Platforms docs describe a dispatch namespace that
contains customer Workers, a dynamic dispatch Worker that calls user Workers
with `env.DISPATCHER.get(...)`, and bindings that can give user Workers access
to KV, D1, R2, and other Cloudflare resources.

Durable user workflows should not be modeled as only Workers for Platforms. When
available, Takosumi Cloud uses Cloudflare Dynamic Workers with
`@cloudflare/dynamic-workflows` so runtime-loaded Dynamic Worker code can use
durable steps. Cloudflare's Dynamic Workflows docs describe the library as the
connection between a Worker Loader and the Workflows engine, giving Dynamic
Workers `step.do()`, `step.sleep()`, and `step.waitForEvent()`.

Operator/internal jobs use normal Cloudflare Workflows. They are operator-side
orchestration, not the user app runtime.

```text
Workers-compatible HTTP apps:
  Cloudflare Workers for Platforms dispatch namespace

Durable user workflows:
  Cloudflare Dynamic Workers + @cloudflare/dynamic-workflows where available

Operator/internal jobs:
  Cloudflare Workflows
```

References:

- [How Workers for Platforms works](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/how-workers-for-platforms-works/)
- [Dynamic Workflows](https://developers.cloudflare.com/dynamic-workers/usage/dynamic-workflows/)

## Domains And Routes

Takosumi Cloud Workers issues a Takosumi-managed default URL for each Worker.
Users can reserve a DNS-valid single-label `*.app.takos.jp` hostname.

```text
https://my-app.app.takos.jp
```

A custom domain is an additional user-owned hostname attached to the same Worker
route. Dashboard and OpenTofu route lifecycle records carry:

| Field              | Meaning                                     |
| ------------------ | ------------------------------------------- |
| `default_hostname` | Takosumi managed `*.app.takos.jp` hostname  |
| `custom_domains`   | verified or pending user-owned hostnames    |
| `pattern`          | route pattern used by compatibility imports |
| `script`           | Worker script that serves the route         |

`default_hostname` is first-come-first-served. Already reserved hostnames return 409. Deleting the route releases its `*.app.takos.jp` hostname. If no hostname
is requested, Takosumi issues one as `<app-slug>-<short-id>.app.takos.jp`.

DNS ownership verification and certificate provisioning are Cloud runtime
responsibilities. The OpenTofu import endpoint stores `default_hostname` and
`custom_domains` on route records; unsupported or unverified runtime dispatch
fails closed in Cloud.

## Compatibility Matrix

The Takosumi Cloud Workers import capability is `compat.cloudflare.workers.v1`.
Takosumi Cloud publishes only the subset needed for Workers-compatible hosting.
Cloudflare product areas outside that scope are listed in the compatibility matrix.

| Status      | Scope                                                                  |
| ----------- | ---------------------------------------------------------------------- |
| Stable      | Worker script deploy                                                   |
| Stable      | Worker routes                                                          |
| Stable      | Worker secrets                                                         |
| Stable      | Worker vars                                                            |
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

## OpenTofu Import Path

The Cloudflare-compatible API is the import path for pointing
Cloudflare Workers-oriented manifests at Takosumi Cloud Workers.

```hcl
provider "cloudflare" {
  api_token  = var.takosumi_cloud_api_key
  account_id = var.takosumi_virtual_account_id
  base_url   = "https://app.takosumi.com/compat/cloudflare/client/v4"
}
```

Use this wording in docs:

```text
Deploy Worker-compatible apps to Takosumi Cloud.
Use Cloudflare-compatible Terraform/OpenTofu resources when convenient.
```

Switching between real Cloudflare and Takosumi Cloud Workers belongs in
Provider Binding / Provider Connection. Do not put raw secrets in the manifest.

AI Gateway is not part of Workers compatibility. It is a separate
OpenAI-compatible endpoint profile. See
[AI Gateway in Cloud endpoints](./cloud-endpoints.md#ai-gateway).
