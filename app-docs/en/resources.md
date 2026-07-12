# Takosumi Cloud Resources

Takosumi Cloud is the official hosted Takosumi for Operator, providing apps,
services, and data resources on official managed targets. `EdgeWorker` is one of
several service forms (runtime shapes for managed resources).

```text
Takosumi Cloud Resources =
  EdgeWorker
  + ContainerService
  + ObjectBucket
  + KVStore
  + SQLDatabase
  + Queue
  + AI Gateway
  + managed routes / URLs / secrets
  + USD credits / usage metering
  + OpenTofu deploys
```

The Cloudflare-compatible API is not the product itself. It is an import path
for existing Terraform/OpenTofu manifests that already target Cloudflare Workers
resources and should be imported into Takosumi Cloud `EdgeWorker` plus managed
bindings.

## Product Vocabulary

Use these terms in landing pages and the main app screen:

- App / Service
- Edge Worker
- Container
- Bindings
- Routes
- Default URL
- Custom Domain (Planned)
- Secrets
- KV
- Object Storage
- Database
- Queue
- AI Gateway
- Durable Workflow

Keep `compat.cloudflare.workers.v1` as the architecture and compatibility
docs capability name. Use Takosumi Cloud resources and services as the main
heading and screen language.

## Runtime Architecture

`EdgeWorker` is the service form for edge JavaScript / TypeScript apps. Takosumi
Cloud can implement it with Cloudflare Workers for Platforms and a
Takosumi-managed dispatch layer.

That is a Cloud implementation detail. The Cloud resource model is not limited
to `EdgeWorker`. OCI-image services are `ContainerService`, object storage is
`ObjectBucket`, app databases are `SQLDatabase`, and persistent workflows are a
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

Every Cloud managed resource passes through the shared Cloud extension layer
before a backend API is called. Whether the entrypoint is a
Cloudflare-compatible OpenTofu provider, the `takosumi/takosumi` provider, a
Compatibility API, or a Dashboard action, the request passes through auth,
source Workspace context, owner billing context, Resource / NativeResource
normalization, a common managed operation descriptor, selected-manager
availability checks, usage / credit guard, and then the selected manager
chooses the backend. The API entrypoint only determines the user-facing
protocol; backend selection is the responsibility of the manager descriptor /
dispatch plan. When the entrypoint is a `takosumi_*` Resource Shape, TargetPool
/ Policy / ResolutionLock are also part of the path before manager dispatch.

```text
OpenTofu provider via compat / takosumi provider via Resource Shape API / Compatibility API / Dashboard action
  -> auth + source Workspace + owner billing account
  -> Resource / NativeResource normalization
  -> TargetPool / Policy / ResolutionLock (Resource Shape entrypoints)
  -> CloudManagedOperation
  -> CloudManagedDispatchPlan
  -> selected manager configured check
  -> usage / credit guard
  -> capability / manager dispatch
  -> selected manager
  -> backend API
```

If a service form is known but its selected manager is not configured, the
request fails closed before usage precharge and before any backend API call.
That is, if a backend such as ContainerService is not yet part of the official
Cloud, credits are not deducted and no implicit fallback to another
compatibility path occurs.

The Cloudflare-compatible path is an import path into this pipeline. The current
official manager for EdgeWorker uses a Workers for Platforms dispatch namespace,
but the API contract is fixed to service forms: `EdgeWorker`, `ObjectBucket`,
`KVStore`, `SQLDatabase`, `Queue`, and peers. WfP and Cloudflare-specific names
are not the public resource identity.

The shared manager descriptor keeps three names separate: the stable Takosumi
Cloud service family such as `takosumi.edge_worker`, the public usage-meter
family used by billing and compatibility such as `cloudflare.workers_script`,
and the replaceable backend manager such as a Workers for Platforms dispatch
namespace. Changing the manager must not change the user-facing Resource Shape
API or compatibility entrypoint. WfP is an implementation token, not a
user-facing resource name or billing unit.

For the same reason, Cloud's normalized resource kind is service-form-oriented,
such as `object_bucket`, `sql_database`, and `durable_workflow`. Tokens such as
`r2` and `d1` stay compatibility URL tokens or current backend prefixes; they
are not the shared operation kind.

References:

- [How Workers for Platforms works](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/how-workers-for-platforms-works/)
- [Dynamic Workflows](https://developers.cloudflare.com/dynamic-workers/usage/dynamic-workflows/)

## Delete And Cleanup

Deleting a Takosumi Cloud managed resource always produces the same result
regardless of how many times it is run. A resource whose backend is already
absent is treated as deleted, so the same destroy can be retried safely.
Cleanup and destroy remain available after credits are exhausted.

For resources such as Object Storage whose cleanup time depends on data volume,
the delete is accepted before a background cleanup removes data in bounded
batches. An accepted resource is removed from active inventory and its data
plane immediately, while its name remains unavailable until cleanup completes.
Deletion is irreversible and stored data cannot be recovered.

BYOC resources created through a user-owned ProviderConnection follow the
underlying provider's deletion and retention policies. If the provider rejects
deletion because of a retention lock or dependent resource, Takosumi records the
Run as failed instead of claiming success and allows a retry after the cause is
fixed.

## Domains And Routes

Public HTTP resources can receive a Takosumi-managed URL. The Takosumi Cloud
default base domain is `app.takos.jp`. The current allocation modes are
`scoped` and `vanity`.

```text
scoped: https://<workspace-handle>-<label>.app.takos.jp
vanity: https://<label>.app.takos.jp
```

`scoped` requires no DNS ownership verification and consumes no vanity slot.
`vanity` reserves `<label>.<managed-base-domain>` on a first-come-first-served
basis and consumes one finite slot owned by the Workspace's unchangeable owner
account. Both modes are subject to global uniqueness through hostname
reservation, reserved labels, and abuse policy.

Cloudflare compatibility route and script-subdomain writes that create a
hostname also require source Workspace and source Capsule context and pass
through the same OSS hostname reservation authority. Cloud-side KV and Durable
Object records hold routing and activation state only; they do not determine
hostname ownership.

The current Dashboard and OpenTofu route lifecycle carries:

| Field              | Status  | Meaning                                       |
| ------------------ | ------- | --------------------------------------------- |
| `default_hostname` | Current | scoped or owner-slot managed hostname         |
| `pattern`          | Current | route pattern used by compatibility imports   |
| `target`           | Current | EdgeWorker / ContainerService target          |
| `custom_domains`   | Planned | user-owned verified-domain lifecycle (unused) |

`scoped` reserves `<workspace-handle>-<label>.<managed-base-domain>`;
`vanity` reserves `<label>.<managed-base-domain>`. Conflict and slot-limit
errors do not reveal the claimant Workspace or Capsule name.
Managed hostname reservations and vanity slots belong to the Capsule lifetime,
not to an individual route record. A successful Capsule destroy releases the
reservation. A Cloud-side route DELETE only removes routing or activation state
and does not release OSS hostname ownership.

User-owned custom domains have a separate verified lifecycle, but DNS ownership
verification and the certificate lifecycle are not implemented. A non-empty
`custom_domains` request or a route pattern outside the managed base domain
currently fails closed and is not stored as an active custom domain.

In app install and Store flows, this value is passed to ordinary OpenTofu
variables through the `installExperience` `public_endpoint` projection. For
example, `subdomain` is the label for a managed URL, `url` is a managed URL or
an ordinary OpenTofu variable, and `routePattern` is the route pattern used by
compatibility imports. A user-owned URL can still be passed to a BYOC provider,
but Takosumi Cloud does not automatically activate it as a managed custom
domain. Takosumi does not infer meaning from
variable names such as `worker_name` or `app_url` by themselves. Only the
store-declared projection and input `format` drive Dashboard input UX and
hostname reservation.

## Compatibility Matrix

The Cloudflare import capability is `compat.cloudflare.workers.v1`. It exposes
only the subset needed to import Workers-oriented resources into Takosumi Cloud
resources. Unsupported Cloudflare products stay explicit.

| Status             | Scope                                                                  |
| ------------------ | ---------------------------------------------------------------------- |
| Production Preview | Worker script deploy to `EdgeWorker`                                   |
| Production Preview | Worker routes to Takosumi routes / default hostnames                   |
| Production Preview | Worker secrets / vars                                                  |
| Production Preview | KV namespace                                                           |
| Production Preview | R2 bucket / Object Storage                                             |
| Production Preview | D1 database / App Database                                             |
| Preview            | Queue                                                                  |
| Preview            | Durable Workflow                                                       |
| Preview            | Dynamic Worker workflow support                                        |
| Planned            | Containers                                                             |
| Planned            | Durable Objects style stateful apps                                    |
| Planned            | User-owned custom domains                                              |
| Unsupported        | DNS, WAF, Zero Trust, Registrar, Cloudflare account IAM, Load Balancer |
| Unsupported        | Email Routing                                                          |

AI Gateway is not part of Workers compatibility. It is a separate
OpenAI-compatible endpoint profile. See
[AI Gateway in Cloud endpoints](./endpoints.md#ai-gateway).

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
installation first. It still requires an authenticated token and a billable
source Workspace. Billable writes spend the owning user's account credits and
are not forwarded to the compatibility endpoint when the owner account has
insufficient balance.
