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

Every Cloud managed resource passes through the shared Cloud extension layer
before a backend API is called. Whether the entrypoint is a
Cloudflare-compatible OpenTofu provider, the `takosumi/takosumi` provider, a
Compatibility API, or a Dashboard action, the request passes through auth,
source Workspace context, owner billing context, Resource / NativeResource normalization, a common
managed operation descriptor, selected-manager availability checks, usage /
credit guard, and then the selected manager chooses the backend. When the
entrypoint is a `takosumi_*` Resource Shape, TargetPool / Policy /
ResolutionLock are also part of the path before manager dispatch.

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
request fails before usage precharge and before any backend API call. It does
not fall back to another compatibility path.

The Cloudflare-compatible path is an import path into this pipeline. The current
official manager for EdgeWorker uses a Workers for Platforms dispatch namespace,
but the API contract is the service form: `EdgeWorker`, `ObjectBucket`,
`KVStore`, `SQLDatabase`, `Queue`, and peers. WfP and Cloudflare primitives are
not the public resource identity.
The shared manager descriptor keeps three names separate: the stable Takosumi
Cloud service family such as `takosumi.edge_worker`, the public usage family
used by billing and compatibility meters such as `cloudflare.workers_script`,
and the replaceable backend manager such as a Workers for Platforms dispatch
namespace. Changing the manager must not change the user-facing Resource Shape
API or compatibility entrypoint.
For the same reason, Cloud's normalized resource kind is service-form-oriented,
such as `object_bucket`, `sql_database`, and `durable_workflow`. Tokens such as
`r2` and `d1` stay compatibility URL tokens or current backend prefixes; they
are not the shared operation kind.

References:

- [How Workers for Platforms works](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/how-workers-for-platforms-works/)
- [Dynamic Workflows](https://developers.cloudflare.com/dynamic-workers/usage/dynamic-workflows/)

## Delete And Cleanup

Deletes of Takosumi Cloud managed resources are idempotent. A resource whose
backend is already absent is treated as deleted, so the same destroy can be
retried safely. Cleanup and destroy remain available after credits are
exhausted.

For resources such as Object Storage whose cleanup time depends on data volume,
the delete is accepted before a background cleanup removes data in bounded
batches. An accepted resource is removed from active inventory and its data
plane immediately, while its name remains unavailable until cleanup completes.
Deletion is irreversible and stored data cannot be recovered.

BYOC resources created through a user-owned ProviderConnection follow the
underlying provider's delete and retention policies. If that provider rejects a
delete because of a retention lock or dependent resource, Takosumi records the
Run as failed instead of claiming success and allows a retry after the cause is
fixed.

## Domains And Routes

Public HTTP resources can receive a Takosumi-managed default URL. Users can
reserve a DNS-valid single-label hostname under an operator-managed public base
domain on a first-come-first-served basis. The Takosumi Cloud default base
domain is `app.takos.jp`.

```text
https://my-app.app.takos.jp
```

This managed default hostname is a constrained namespace that does not require
DNS ownership verification. Abuse policy, reserved names, and rate controls are
operator policy, but normal app installs should be able to use it broadly.
It is separate from custom-domain quota. Users choose only the single label in
`<label>.<managed-base-domain>`, while the operator owns the base domain. For
ordinary installs, Takosumi treats these names as broadly available except for
global uniqueness, reserved labels, and abuse rate limits.

Custom domains are additional user-owned hostnames attached to the same route.
They are separate from managed default hostnames and require DNS ownership
verification, certificate provisioning, and plan/quota/abuse policy before
runtime activation. Arbitrary apex or subdomain names are not accepted as a
free namespace; they are verified domains attached to the owning account and
constrained by plan and abuse policy. Dashboard and OpenTofu route lifecycle
records carry:

| Field              | Meaning                                     |
| ------------------ | ------------------------------------------- |
| `default_hostname` | operator-managed one-label default hostname |
| `custom_domains`   | verified or pending user-owned hostnames    |
| `pattern`          | route pattern used by compatibility imports |
| `target`           | EdgeWorker / ContainerService target        |

`default_hostname` is first-come-first-served. If no hostname is requested,
Takosumi issues one as `<app-slug>-<short-id>.<managed-base-domain>`. Conflict
errors do not reveal the claimant Workspace or Capsule name.

In app install / Store flows, this value is passed to ordinary OpenTofu
variables through the `installExperience` `public_endpoint` projection. For
example, `subdomain` is the single label for the managed default hostname,
`url` is a custom domain or managed URL, and `routePattern` is the route
pattern used by compatibility imports. Takosumi does not infer meaning from
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
installation first. It still requires an authenticated token and a billing
source Workspace. Billable writes spend the owning user's account credits and
are not forwarded to the compatibility endpoint when the owner account has
insufficient balance.
