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
  + VectorIndex
  + DurableWorkflow
  + StatefulActorNamespace
  + Schedule
  + AI Gateway
  + managed routes / URLs / secrets
  + USD-denominated billing / usage metering
  + OpenTofu deploys
```

The Cloudflare-compatible API is not the product itself. It is an import path
for the supported `EdgeWorker` and `ObjectBucket` operations in existing
Terraform/OpenTofu manifests, and remains only a limited protocol adapter.

## Product Vocabulary

Use these terms in landing pages and the main app screen:

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
- Vector Index
- Stateful Actor Namespace
- Schedule

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

When creating Object Storage, choose either the `standard` or
`infrequent_access` storage class. Omission defaults to `standard`. The choice is
the default for newly written objects and does not implicitly move existing
objects. `infrequent_access` passes preview only when a supporting official
target is available, and the pre-apply quote shows the price difference and any
retrieval charging terms.

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

Every Cloud managed-resource control operation converges on the canonical
`/v1/resources` Deploy API before any backend API is called. The
`takosumi/takosumi` provider, Dashboard, and direct API call that lifecycle
directly. A Cloudflare-compatible control request first translates into the
corresponding `EdgeWorker` or `ObjectBucket` request, then calls the same
preview, reviewed apply, and delete operations. The compatibility handler owns
neither a backend manager nor a parallel lifecycle store.

```text
compat control request -> typed Resource request
takosumi provider / direct API / Dashboard -> typed Resource request
  -> /v1/resources preview + reviewed apply/delete
  -> auth + Space/Workspace ownership
  -> TargetPool + Policy + ResolutionLock
  -> versioned offering/price quote + reserve
  -> Cloud adapter + selected-manager configured check
  -> backend API
  -> canonical Resource / NativeResource / Output / audit + capture/release

compat data request
  -> Ready canonical Resource + authorized Interface / NativeResource
  -> usage guard + selected manager
  -> backend data plane
```

If a service form is known but its selected manager is not configured, the
request fails closed before usage precharge and before any backend API call.
That is, if a backend such as ContainerService is not yet part of the official
Cloud, credits are not deducted and no implicit fallback to another
compatibility path occurs. The Worker route contract is
not a backend Resource operation: it updates the Ready `EdgeWorker`'s
`http.route` Interface and exact Principal Binding through the shared Interface
authority. It owns no compatibility KV or backend route call. Custom hostnames
use an owner-account and Workspace-scoped `VerifiedDomain`; the route becomes
active only while both ownership and certificate status are current.

The Cloudflare-compatible path is a limited import path into this pipeline. The
GA subset pins selected Workers, R2, KV, D1, Queue, Workflow, and AI Gateway
resources and data sources from Cloudflare Terraform Provider `5.19.1`.
Vector, Container, Stateful Actor, and Schedule use typed `takosumi_*`
Resources and official APIs because that provider has no matching independent
resources. The current
official EdgeWorker manager uses a Workers for Platforms dispatch namespace,
but the public Resource identity remains `EdgeWorker`. A future manager change
updates TargetPool, adapter, and manager-descriptor evidence rather than the
compatibility handler.

The shared manager descriptor keeps the provider-neutral customer contract and
the replaceable backend manager separate. `EdgeWorker` uses
`takosumi.edge_worker` as both its service and billing family, with meter ids
under `takosumi:edge_worker:*`. A Cloudflare-compatible import records
`takosumi.entrypoint=compat.cloudflare.workers.v1` as metadata; it does not
change the billing identity. The Workers for Platforms dispatch namespace is
an implementation token, not a user-facing resource name or billing unit.
The historical `cloudflare.workers_script` family is read only when reconciling
immutable old usage and invoices and is never written for new usage.

For the same reason, Cloud's normalized resource kind is service-form-oriented,
such as `object_bucket`, `sql_database`, and `durable_workflow`. Tokens such as
`r2` and `d1` stay compatibility URL tokens or current backend prefixes; they
are not the shared operation kind.

References:

- [How Workers for Platforms works](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/how-workers-for-platforms-works/)
- [Dynamic Workflows](https://developers.cloudflare.com/dynamic-workers/usage/dynamic-workflows/)
- [R2 storage classes](https://developers.cloudflare.com/r2/buckets/storage-classes/)

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

Public HTTP surfaces use two URL forms with separate ownership and lifecycles.

A Capsule install's `public_endpoint` projection is a managed URL owned by the
OSS hostname reservation authority. The Takosumi Cloud default base domain is
`app.takos.jp`. The current allocation modes are `scoped` and `vanity`.

```text
scoped: https://<workspace-handle>-<label>.app.takos.jp
vanity: https://<label>.app.takos.jp
```

`scoped` requires no DNS ownership verification and consumes no vanity slot.
`vanity` reserves `<label>.<managed-base-domain>` on a first-come-first-served
basis and consumes one finite slot owned by the Workspace's unchangeable owner
account. Both modes are subject to global uniqueness through hostname
reservation, reserved labels, and abuse policy.

`scoped` reserves `<workspace-handle>-<label>.<managed-base-domain>`;
`vanity` reserves `<label>.<managed-base-domain>`. Conflict and slot-limit
errors do not reveal the claimant Workspace or Capsule name.
Managed hostname reservations and vanity slots belong to the Capsule lifetime,
and a successful Capsule destroy releases the reservation.

A Cloud-managed `EdgeWorker` separately receives an opaque, non-derivable
canonical system URL. Compatibility responses discover it as `system_url` from
the Resource's `url` Output. Clients must not construct or infer a value such as
`ew-<hash>.<system-base-domain>`. This URL is not a vanity hostname claimed by a
compatibility route and route DELETE does not release it.

The GA-candidate Cloudflare-compatible route contract accepts only the
discovered `system_url` host followed by an explicit path. Each profile-owned
`EdgeWorker` can have one active route. The path accepts no wildcard or one
terminal `*`. Host-only, multiple, overlapping, infix-wildcard,
wildcard-hostname, and custom-hostname patterns fail before Interface mutation.

Current route evidence is:

| Evidence         | Status   | Meaning                                                           |
| ---------------- | -------- | ----------------------------------------------------------------- |
| `system_url`     | Current  | opaque EdgeWorker URL discovered from the Resource `url` Output   |
| route pattern    | Current  | canonical host + explicit path + optional terminal `*`            |
| `http.route`     | Current  | canonical Interface carrying the route id and strong ETag         |
| InterfaceBinding | Current  | Binding that grants `edge.request` to the exact Principal         |
| `custom_domains` | GA scope | active VerifiedDomain, certificate, and exact Resource attachment |

Route CRUD calls the Interface and InterfaceBinding authority. There is no
compatibility KV, backend route API, or separate hostname-ownership ledger.
Updates use a strong-ETag CAS. DELETE revokes the Binding and retires the
Interface, but releases neither the system URL nor Capsule managed-hostname
ownership.

User-owned custom domains have a separate verified lifecycle. Ownership
challenge, certificate issue/renewal, attach/detach, and expiry are recorded
separately. Pending, failed, or expired state is never stored or displayed as
an active custom domain.

In app install and Store flows, this value is passed to ordinary OpenTofu
variables through the `installExperience` `public_endpoint` projection. For
example, `subdomain` is the label for a managed URL, `url` is a managed URL or
an ordinary OpenTofu variable, and `routePattern` is the route pattern used by
compatibility imports. A user-owned URL can still be passed to a BYOC provider,
but Takosumi Cloud requires a VerifiedDomain rather than activating it
implicitly. Takosumi does not infer meaning from
variable names such as `worker_name` or `app_url` by themselves. Only the
store-declared projection and input `format` drive Dashboard input UX and
hostname reservation.

## Compatibility Matrix

The Cloudflare import capability is `compat.cloudflare.workers.v1`. It exposes
only the subset needed to import Workers-oriented resources into Takosumi Cloud
resources. Unsupported Cloudflare products stay explicit.

| Status      | Scope                                                                                                         |
| ----------- | ------------------------------------------------------------------------------------------------------------- |
| GA contract | EdgeWorker modules, assets, vars, write-only secrets, bindings, versions, deployments, routes, and cron (Workers Logs / Logpush are not Stable) |
| GA contract | managed URL and verified-custom-domain `http.route` Interfaces                                                |
| GA contract | ObjectBucket plus the documented R2/S3 control and data subset                                                |
| GA contract | provider `5.19.1` selected subset for KVStore, SQLDatabase, Queue, and DurableWorkflow                        |
| GA contract | typed Resource API for VectorIndex, ContainerService, StatefulActorNamespace, and Schedule                    |
| GA contract | AI Gateway OpenAI-compatible endpoint                                                                         |
| Pre-GA      | public GA stays closed until every item passes the same Stable evidence matrix                                |
| Unsupported | Pages, Hyperdrive, Analytics Engine, Browser Rendering, Images, Stream, and Pipelines                         |
| Unsupported | DNS, WAF, Zero Trust, Registrar, account IAM, Load Balancer, and Email Routing                                |

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

On Takosumi Cloud, this import path can be used without first creating a Capsule
through the Dashboard app flow. It still requires an authenticated token and a
billable source Workspace. Billable writes spend the owning user's account
credits and are not forwarded to the compatibility endpoint when the owner
account has insufficient balance.
