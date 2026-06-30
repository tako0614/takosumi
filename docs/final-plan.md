# Takosumi Final Plan

Last updated: 2026-06-29

This document is the authoritative Takosumi product direction.

## 0. Definition

Takosumi is an open, Git-based OpenTofu control plane.

```text
Takosumi =
  Git-based OpenTofu control plane
  + plain OpenTofu stack execution
  + Resource Shape API
  + Resolver / Planner / Reconciler
  + Target / Credential / OIDC / Secret / Policy
  + Compatibility API framework
  + Adapter system
```

Takosumi is not a cloud clone. It runs plain OpenTofu stacks as-is with
existing OpenTofu/Terraform providers, and it can also resolve Takosumi
Resource Shapes to operator-enabled targets.

The product split is:

```text
Takosumi:
  OSS core control plane.

Takosumi for Operator:
  Takosumi + customer/tenant/billing/quota/operator operation.

Takosumi Cloud:
  the official hosted Takosumi for Operator, with official managed targets,
  Cloud-operated managed service backends, credits, support, and SLA.
```

Takosumi Cloud is an official deployment of Takosumi for Operator. It is not a
separate product core.

## 1. The Key Rule

Use existing generic providers and standards when they are enough.

```text
If an adequate generic OpenTofu provider or standard API exists:
  use it through the plain OpenTofu Stack flow.

If no adequate generic provider-neutral surface exists:
  do not immediately create a Takosumi provider resource. First prove that the
  need is not served by a normal OpenTofu provider, standard endpoint, or
  generic-env ProviderConnection.
```

This is not "Takosumi should create every missing provider." It is:

```text
generic exists:
  do not recreate it in takosumi_provider.

generic does not exist, but the need is one-off:
  use generic-env ProviderConnection and a normal OpenTofu provider/module.

generic does not exist, and the need is a durable service form:
  add a typed Takosumi shape with schema, validation, planner, adapter,
  import/drift/state story, and capability evidence.
```

Before adding any `takosumi_*` resource, the design must pass a prior-art gate:

```text
1. Is there an existing OpenTofu/Terraform provider that users can run through
   the Stack flow?
2. Is there a standard protocol/endpoint that should remain the product
   surface instead of a Takosumi resource?
3. Can the gap be handled by generic-env ProviderConnection plus an ordinary
   module?
4. Does Takosumi need to own resolution lock, binding projection, policy,
   metering, import compatibility, or managed-target placement?
```

If answers 1-3 are yes and answer 4 is no, do not add a Takosumi resource.

Examples:

```text
Ordinary S3/R2/GCS bucket:
  use existing OpenTofu providers such as hashicorp/aws,
  cloudflare/cloudflare, or a MinIO/S3-compatible provider.

Object storage that must be projected as a managed binding into an EdgeWorker,
locked by Takosumi resolution, metered by an operator, or exposed through a
provider-neutral service contract:
  keep the standard S3-compatible API as the data-plane surface. Enable
  compat.s3.v1 only when Takosumi owns the import/data path, binding
  projection, policy, metering, or managed-target control.

Ordinary VM, Kubernetes, or container infrastructure:
  use existing OpenTofu providers when that is sufficient.

Provider-neutral edge JavaScript app hosting:
  use takosumi_edge_worker. This is one service shape, not the whole Cloud
  product identity.

AI Gateway or OpenAI-compatible upstream access:
  do not create a Takosumi Resource Shape by default.
  pass the endpoint URL, model name, and API key through ProviderConnection,
  Secret, output projection, or generic env.
```

Do not add a Takosumi-owned resource just because another cloud already has a
provider. Add one only when Takosumi needs to own a portable service form,
resolution lock, binding projection, policy surface, or compatibility import
path.

## 2. Two Flows

### 2.1 Plain OpenTofu Stack Flow

Users can bring a normal Git repository containing OpenTofu/Terraform.

```text
Git URL + ref/tag/commit + module path
  -> checkout
  -> tofu init
  -> tofu plan
  -> policy check
  -> approval
  -> tofu apply
  -> state / outputs / logs / audit
```

Takosumi does not abstract the cloud provider in this flow. Users use existing
providers directly.

```hcl
resource "aws_s3_bucket" "assets" {
  bucket = "my-assets"
}
```

Takosumi manages the outside of the run:

```text
ProviderConnection
CredentialRecipe
ProviderBinding
run-scoped env/file injection
state
outputs
logs
audit
approval
policy
```

Generic env remains a required escape hatch. Any OpenTofu provider can be used
when the user declares the provider source, allowed provider policy, egress
policy, and explicit env/file materialization.

### 2.2 Resource Shape Flow

Users can also declare provider-neutral Takosumi shapes when they want
Takosumi-managed service semantics.

```text
Resource Shape
  -> TargetPool / Policy / Credential
  -> Adapter capability evidence
  -> Resolver
  -> ResolutionLock
  -> NativeResource
```

The shape names the service form. The operator decides which targets and
adapters can satisfy it.

The v1alpha1 default public shapes are:

```text
EdgeWorker
ObjectBucket
KVStore
Queue
PushNotification
SQLDatabase
ContainerService
```

Future shapes are added only when they have a real schema, planner, adapter
path, and user value. Do not expose `takosumi_resource { type, spec }` as the
normal interface.

## 3. Product Split

### 3.1 Takosumi OSS

Takosumi OSS includes:

```text
Git integration
OpenTofu runner
state / output / run / audit management
ProviderConnection
CredentialRecipe
ProviderBinding
generic env provider support
Resource Shape API
Resolver / Planner / Reconciler
Target / TargetPool
Credential / OIDC / Workload Identity
Secret / Policy / RBAC basics
Adapter framework
Compatibility API framework
usage event emission
takosumi provider API compatibility
```

Takosumi OSS does not include:

```text
commercial billing enforcement
payment provider integration
subscription / invoice
official managed capacity
official Takosumi native runtime internals
official support / SLA / abuse operation
```

### 3.2 Takosumi for Operator

Takosumi for Operator is the edition for people who operate Takosumi for their
own users, customers, organization, school, hosting service, or internal
platform.

It adds:

```text
customer / tenant management
multi-tenant workspace management
billing account / subscription / plan
quota / metering / invoice / payment integration
operator console
managed target catalog
support and abuse tooling
commercial audit export
```

It still uses the same Takosumi engine, Resource API, provider, adapters, and
capability discovery.

### 3.3 Takosumi Cloud

Takosumi Cloud is the official hosted Takosumi for Operator.

It adds official operation:

```text
official account system
official runner and target pools
official billing and USD credits
official usage metering
official support / SLA / abuse controls
Takosumi Native Runtime
Takosumi Native Object Storage
Takosumi Native KV / Queue / DB
Takosumi Edge Gateway
Takosumi AI Gateway
```

Takosumi Cloud product identity:

```text
Managed application and data resources on official targets, with credits,
usage metering, and OpenTofu deploys.
```

Cloudflare-compatible APIs are import/deploy paths, not the product identity.

## 4. Resource Shapes

### 4.1 EdgeWorker

`EdgeWorker` is the provider-neutral service form for Worker-compatible
JavaScript/TypeScript edge applications.

It is not a generic container service and it is not a generic HTTP service. A
container is a different service form. A VM is a different service form.

```hcl
resource "takosumi_edge_worker" "api" {
  name               = "api"
  artifact_path      = "/work/dist/worker.js"
  compatibility_date = "2026-06-29"

  profiles = [
    "workers_bindings",
    "node_compat",
  ]
}
```

Important rules:

```text
Takosumi does not build the JavaScript bundle by default.
The Git/OpenTofu module decides where the artifact comes from.
Routes are separate resources.
Bindings/connections are separate contracts.
Secrets are Credential/Secret material, not spec fields.
```

Possible implementations:

```text
cloudflare_workers
takosumi_edge_runtime
operator-provided EdgeWorker adapter plugin
```

Takosumi Cloud may implement `EdgeWorker` with Cloudflare Workers for Platforms
and a Takosumi-managed dispatch layer. That is an implementation detail for one
shape. Object storage, KV, database, queue, container, workflow, and AI surfaces
are peer resources in Takosumi Cloud.

### 4.2 ObjectBucket And S3-Compatible Object Storage

`ObjectBucket` is the provider-neutral service form for object storage when
Takosumi owns binding projection, policy, metering, managed-target placement,
or compatibility import/data paths.

It does not replace ordinary object-storage providers.

Why it exists:

```text
Takosumi or an operator may provide object storage.
Apps, SDKs, and existing OpenTofu providers need a standard way to consume it.
The correct standard surface is S3-compatible API.
```

Ordinary object storage remains outside Takosumi Resource Shapes:

```text
AWS S3:
  use hashicorp/aws in the plain OpenTofu Stack flow.

Cloudflare R2:
  use cloudflare/cloudflare in the plain OpenTofu Stack flow.

GCS / MinIO / other S3-compatible storage:
  use the existing provider or standard S3-compatible endpoint.
```

Takosumi enables `compat.s3.v1` only when the operator intentionally exposes an
object-storage import/data path, binding projection, policy, metering, or
managed target control. This lets Takosumi-provided storage be received and used
through the same S3-compatible provider/SDK surface. `takosumi_object_bucket`
exists for the control-plane shape; S3-compatible APIs remain the data-plane
surface.

### 4.3 KVStore / Queue / PushNotification / SQLDatabase / ContainerService

These are minimum service forms needed by Takos and yurucommu-style apps.

```hcl
resource "takosumi_kv_store" "cache" {
  name = "cache"
}

resource "takosumi_queue" "delivery" {
  name        = "delivery"
  max_retries = 5
}

resource "takosumi_push_notification" "push" {
  name        = "push"
  protocols   = ["web_push", "fcm"]
  ttl_seconds = 3600
}

resource "takosumi_sql_database" "main" {
  name            = "main"
  engine          = "sqlite"
  migrations_path = "migrations"
}

resource "takosumi_container_service" "agent" {
  name        = "agent"
  image       = "ghcr.io/example/agent:1.0.0"
  public_http = true
}
```

Rules:

```text
KVStore:
  provider-neutral key-value state/binding surface.

Queue:
  async delivery and event fan-out.

PushNotification:
  provider-neutral notification delivery channel for Web Push, APNs, and FCM.
  VAPID / APNs / FCM credentials are Target / Credential / ProviderConnection
  material, not shape spec fields.

SQLDatabase:
  D1-like sqlite first, postgres/mysql only when an operator target supports it.

ContainerService:
  OCI container service. It is separate from EdgeWorker.
```

Do not collapse these into a generic `service` or into EdgeWorker. The service
form is the user-facing contract; the backend is selected by TargetPool,
Policy, capability evidence, and ResolutionLock.

### 4.4 AI Gateway Is Not A Resource Shape

AI Gateway remains a Takosumi Cloud / operator service endpoint, not a default
`takosumi_*` resource.

Apps should receive AI configuration like any other external service:

```text
TAKOSUMI_AI_BASE_URL
TAKOSUMI_AI_API_KEY
TAKOSUMI_AI_DEFAULT_MODEL
OPENAI_BASE_URL
OPENAI_API_KEY
```

The values come from ProviderConnection, Secret, output projection, or generic
env. They must not be stored in Resource Shape specs or OpenTofu state.

## 5. Future Shape Families

Future shapes should be introduced one service form at a time. This list is a
candidate vocabulary, not a commitment that Takosumi will recreate every
service. Add a shape only when existing OpenTofu providers or standard APIs are
not enough and Takosumi needs provider-neutral binding, policy, metering,
import, or resolution semantics.

If a mature provider-neutral provider already exists outside Takosumi, prefer
that provider. Takosumi should define a new provider resource only when the
ecosystem does not already provide a clean generic surface for the service form
or when Takosumi must own resolution locks, bindings, policy, metering, or
compatibility import.

```text
Route
Connection
Secret
RelationalDatabase
DurableWorkflow
Job
Machine
MachinePool
KubernetesCluster
Artifact
ContainerImage
```

Do not add a public shape until it has:

```text
clear user-facing service form
shape-specific HCL schema
validation
planner
adapter path
import/drift/state story
capability story
tests
```

Do not merge unlike service forms. Edge Worker, container service, machine,
workflow, and job are different shapes even if some backend can implement more
than one.

## 6. Target, Adapter, And Plugin Model

Backend selection belongs to TargetPool, Policy, capability evidence, and the
Resolver. It should not normally be embedded in the user resource.

Target types are extensible tokens:

```text
aws
cloudflare
gcp
azure
kubernetes
vm
proxmox
libvirt
ssh
takosumi_native
opentofu
operator-defined target type
```

TargetPool implementation entries can point to adapter plugins.

```hcl
resource "takosumi_target_pool" "default" {
  name = "default"

  target = [{
    name     = "containers-main"
    type     = "kubernetes"
    ref      = "cluster-prod"
    priority = 80

    implementation = [{
      shape          = "ContainerService"
      implementation = "custom_container_runtime"
      plugin         = "takosumi-plugin-container-runtime"

      options_json = jsonencode({
        runtime_class = "edge"
      })

      interfaces = {
        oci_container = "native"
        public_http   = "shim"
        "custom.mesh" = "native"
      }
    }]
  }]
}
```

Plugin options are non-secret configuration. Secrets and tokens stay in
Credential or ProviderConnection.

The adapter plugin shape is intentionally Vite-like:

```ts
export default {
  name: "takosumi-plugin-example",
  implementations: [
    {
      shape: "ContainerService",
      implementation: "example_container_runtime",
    },
  ],
  async preview(ctx) {},
  async apply(ctx) {},
  async observe(ctx) {},
  async delete(ctx) {},
};
```

Takosumi core defines the contract. Operators decide which plugins are
installed and trusted.

## 7. ProviderConnection And CredentialRecipe

ProviderConnection remains the standard credential boundary.

```text
ProviderConnection:
  stored or referenced credential configuration.

CredentialRecipe:
  env/file/pre-run materialization rule for one provider mode.

ProviderBinding:
  mapping from OpenTofu provider address/alias to ProviderConnection.
```

OAuth, AssumeRole, impersonation, AI upstream token vending, and Cloudflare
login helpers are setup or pre-run flows. They are not public ownership kinds.

Generic env is required:

```text
generic_env_provider
  arbitrary OpenTofu provider source
  explicit env/file names
  runner policy
  provider plugin policy
  egress policy
```

This is how Takosumi stays open to providers it does not know yet.

## 8. Compatibility API Framework

Compatibility APIs are framework capabilities in standard Takosumi.
Compatibility APIs are scoped, versioned entrypoints into Takosumi. They are
not a promise of complete cloud API compatibility. Whether a specific
compatibility profile is enabled is reported through capabilities.
In short: specific compatibility profile is enabled is reported through capabilities.

Examples:

```text
compat.oci.v1
compat.cloudevents.v1
compat.kubernetes.crd.v1
compat.cloudflare.workers.v1
compat.s3.v1
compat.redis.v1
compat.postgres.v1
```

These names are possible capability tokens, not a roadmap to rebuild standard
APIs. Redis, Postgres, SQS, S3, and OCI should stay on existing providers or
standard endpoints unless an operator-owned import path, binding projection,
policy, or metering gap is proven.

The key rule still applies:

```text
If the existing standard/provider is enough, use it.
If Takosumi needs an import path, binding projection, policy, metering, or
managed target control, expose a scoped compatibility profile.
```

Examples:

```text
Cloudflare Workers subset:
  control compatibility for EdgeWorker import/deploy.

S3 API:
  only needed when the operator intentionally exposes object-storage data-plane
  or control-plane compatibility. It is not mandatory for normal S3/R2/GCS use.

OCI registry:
  useful for Artifact / ContainerImage flows when Takosumi owns artifact
  lifecycle.

CloudEvents:
  useful for Queue / EventHandler / DurableWorkflow trigger import.
```

Unsupported claims:

```text
complete AWS API compatibility
complete Cloudflare API compatibility
all Terraform provider compatibility
```

## 9. Resolution Lock And State

Resolver decisions must be locked.

```json
{
  "resourceId": "tkrn:prod:EdgeWorker:api",
  "selectedImplementation": "cloudflare_workers",
  "target": "cloudflare-main",
  "locked": true,
  "reason": [
    "worker_fetch native",
    "workers_bindings native",
    "space policy matched"
  ]
}
```

Takosumi must not silently migrate a resource to another backend. Migration is
an explicit operation.

State is split into:

```text
OpenTofu state
Takosumi resource state
Native resource state
```

The OpenTofu provider state keeps Takosumi ids and outputs. Native provider
identifiers, resolution details, and secret material belong in Takosumi state,
not in user HCL.

## 10. Discovery And Capabilities

Every Takosumi endpoint exposes:

```http
GET /.well-known/takosumi
GET /v1/capabilities
```

Providers and tools branch on capabilities, not edition names.
Adapter/target capabilities report what the operator has enabled; they do not
create implicit Resource Shape mappings. Object storage remains a standard
endpoint/provider concern unless `compat.s3.v1` is explicitly enabled by an
operator for an import/data path, binding projection, policy, metering, or
managed target control.

Example:

```json
{
  "apiVersion": "takosumi.dev/v1alpha1",
  "resources": {
    "Stack": true,
    "EdgeWorker": true,
    "ObjectBucket": true,
    "KVStore": true,
    "Queue": true,
    "PushNotification": true,
    "SQLDatabase": true,
    "ContainerService": true
  },
  "adapters": {
    "aws": true,
    "cloudflare": true,
    "kubernetes": true,
    "vm": false,
    "takosumi_native": true
  },
  "compat": {
    "s3": false,
    "oci": true,
    "cloudevents": true,
    "cloudflare_subset": true
  },
  "identity": {
    "oidc_issuer": true,
    "workload_identity": true
  },
  "commercial": {
    "billing": false,
    "operator_tenants": false
  }
}
```

`compat.s3.v1` should stay false unless an operator intentionally exposes an
S3-compatible import/data path. Object storage can remain entirely on existing
providers and standard endpoints.

## 11. Takosumi Cloud Public Offering

Takosumi Cloud should be documented like a simple cloud service.

Public service names:

```text
Apps / Services
Edge Worker
Container
Bindings
Routes
Secrets
KV
Object Storage
Database
Queue
AI Gateway
Durable Workflow
Credits
Custom Domains
*.app.takos.jp names
```

Implementation can use Cloudflare primitives such as Workers for Platforms,
Dynamic Workers, R2, D1, KV, Queues, Workflows, Containers, and AI Gateway.
Those are implementation details behind official managed targets.

Docs must publish a compatibility matrix:

```text
Stable:
  EdgeWorker deploy
  routes
  secrets / vars
  ObjectBucket with S3-compatible data-plane surface
  AI Gateway as an OpenAI-compatible env/endpoint surface

Preview:
  KV
  Queue
  PushNotification
  SQLDatabase
  ContainerService
  DurableWorkflow

Planned:
  Database extensions
  custom domains beyond basic routing

Unsupported:
  DNS full management
  WAF
  Zero Trust
  Registrar
  Cloudflare account IAM
  Load Balancer
  Email Routing
```

Takosumi Cloud should support:

```text
custom user domains
first-come names under *.app.takos.jp
```

Route ownership, certificate issuance, abuse policy, and name reservation live
in the Operator/Cloud layer.

## 12. Billing Boundary

Takosumi OSS can emit usage events.

```text
resource id
meter id
quantity
unit
timestamp
operation
target
```

Takosumi for Operator and Takosumi Cloud turn those events into:

```text
rating
USD credits
quota
auto recharge
payment enforcement
invoice
support and abuse workflows
```

If credits are exhausted in Takosumi Cloud, Cloud-managed resources should stop
or degrade according to product policy. That enforcement is not OSS core.

## 13. Non-Goals

Do not build:

```text
complete AWS API compatibility
complete Cloudflare API compatibility
a Takosumi clone of every existing OpenTofu provider
generic takosumi_resource { type, spec } as the primary interface
backend selection as normal user HCL
Cloud-only branches in the takosumi provider
secret material inside Resource Shape specs
commercial billing enforcement inside OSS core
```

Do build:

```text
plain OpenTofu Stack execution
generic-env ProviderConnection escape hatch
first-class typed shapes only after the prior-art gate proves generic
providers/standards are not enough
capability-driven provider behavior
TargetPool adapter plugin system
scoped compatibility import paths
clear OSS / Operator / Cloud boundaries
```

## 14. Immediate Build Order

1. Keep plain OpenTofu Stack execution reliable.
2. Keep arbitrary provider support through generic-env ProviderConnections.
3. Finish Resource API, planner, resolver, state, and ResolutionLock for
   EdgeWorker, ObjectBucket, KVStore, Queue, PushNotification, SQLDatabase,
   and ContainerService.
4. Finish `takosumi/takosumi` provider schemas for those default shapes.
5. Finish extensible TargetPool implementation plugin fields.
6. Add compatibility profiles only where they are actually needed.
7. Add new shapes one service form at a time, not as a catch-all resource.
8. Build Takosumi for Operator on the same engine.
9. Host Takosumi Cloud as the official Takosumi for Operator deployment.

## 15. Final Sentence

Takosumi is an open Git + OpenTofu control plane with first-class resource
shapes only where provider-neutral service semantics are needed. Existing
generic providers and standards remain the default path; Takosumi adds
resolution, policy, credentials, state, compatibility import paths, and
operator-managed targets around them.
