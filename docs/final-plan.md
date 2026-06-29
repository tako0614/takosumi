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
  add a first-class Takosumi Resource Shape or adapter plugin.
```

Examples:

```text
Ordinary S3/R2/GCS bucket:
  use existing OpenTofu providers such as hashicorp/aws,
  cloudflare/cloudflare, or a MinIO/S3-compatible provider.

Object storage that must be projected as a managed binding into an EdgeWorker,
locked by Takosumi resolution, metered by an operator, or exposed through a
provider-neutral service contract:
  use takosumi_object_bucket.

Ordinary VM, Kubernetes, or container infrastructure:
  use existing OpenTofu providers when that is sufficient.

Provider-neutral Worker-compatible application hosting:
  use takosumi_edge_worker.

OpenAI-compatible AI endpoint with operator-side routing, model policy, credit
enforcement, or fallback:
  use takosumi_ai_endpoint.
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

The v1alpha1 implemented public shapes are:

```text
ObjectBucket
EdgeWorker
AIEndpoint
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
Worker-compatible application hosting with managed bindings, credits,
and OpenTofu deploys.
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

Takosumi Cloud Workers may be backed by Cloudflare Workers for Platforms and a
Takosumi-managed dispatch layer. That detail should be documented in runtime
docs, but the product headline should remain Worker-compatible hosting.

### 4.2 ObjectBucket

`ObjectBucket` is the provider-neutral service form for object storage when
Takosumi needs to manage lifecycle, binding projection, resolution lock, usage
events, or operator-side policy.

```hcl
resource "takosumi_object_bucket" "assets" {
  name = "assets"

  interfaces = [
    "s3_api",
    "signed_url",
  ]

  lifecycle_policy = {
    delete = "retain"
  }
}
```

This does not mean Takosumi should recreate S3 for ordinary usage. If a normal
S3-compatible provider is enough, use the existing provider in the plain
OpenTofu Stack flow.

Possible implementations:

```text
aws_s3
cloudflare_r2
minio
takosumi_object_storage
operator-provided ObjectBucket adapter plugin
```

### 4.3 AIEndpoint

`AIEndpoint` is the provider-neutral service form for AI endpoints.

```hcl
resource "takosumi_ai_endpoint" "main" {
  name = "ai"

  interfaces = [
    "openai_chat_completions",
    "openai_embeddings",
  ]

  profiles = [
    "openai_compatible",
  ]

  provider_preferences = [
    "provider.deepseek",
    "provider.gemini",
    "provider.bedrock",
  ]

  routing_policy = {
    strategy       = "lowest_latency"
    allow_fallback = true
  }

  model_policy = {
    default_model  = "fast/chat"
    allowed_models = ["fast/chat", "embed/text"]
  }
}
```

`AIEndpoint` is broad by design. The provider validates the shape and basic
token syntax. The endpoint capabilities, TargetPool, policy, credentials, and
engine/admin configuration decide whether it can be backed by:

```text
Cloudflare AI Gateway
Workers AI
OpenAI-compatible upstream
DeepSeek
GLM
Gemini / Vertex AI
AWS Bedrock
Takosumi native AI gateway
operator-provided adapter plugin
```

Upstream API keys are Credential/ProviderConnection material. They must not be
stored in the Resource Shape spec or OpenTofu state.

## 5. Future Shape Families

Future shapes should be introduced one service form at a time. This list is a
candidate vocabulary, not a commitment that Takosumi will recreate every
service. Add a shape only when existing OpenTofu providers or standard APIs are
not enough and Takosumi needs provider-neutral binding, policy, metering,
import, or resolution semantics.

```text
Route
Connection
Secret
KVStore
Queue
SQLDatabase
RelationalDatabase
DurableWorkflow
ContainerService
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
ai_provider
opentofu
operator-defined target type
```

TargetPool implementation entries can point to adapter plugins.

```hcl
resource "takosumi_target_pool" "default" {
  name = "default"

  target = [{
    name     = "gemini-main"
    type     = "ai_provider"
    ref      = "https://generativelanguage.googleapis.com/v1beta/openai"
    priority = 80

    implementation = [{
      shape          = "AIEndpoint"
      implementation = "gemini_openai_compatible"
      plugin         = "takosumi-plugin-openai-compatible"

      options_json = jsonencode({
        base_url = "https://generativelanguage.googleapis.com/v1beta/openai"
      })

      interfaces = {
        openai_chat_completions = "native"
        openai_embeddings       = "native"
        provider.gemini.v1      = "shim"
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
      shape: "AIEndpoint",
      implementation: "example_openai_compatible",
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
  only needed when the operator intentionally exposes ObjectBucket data-plane
  or control-plane compatibility. It is not mandatory for normal S3 use.

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
create implicit Resource Shape mappings. A shape such as ObjectBucket still
requires explicit TargetPool implementation evidence when it would otherwise be
served by ordinary S3/R2/GCS providers.

Example:

```json
{
  "apiVersion": "takosumi.dev/v1alpha1",
  "resources": {
    "Stack": true,
    "ObjectBucket": true,
    "EdgeWorker": true,
    "AIEndpoint": true
  },
  "adapters": {
    "aws": true,
    "cloudflare": true,
    "kubernetes": true,
    "vm": false,
    "takosumi_native": true,
    "ai_provider": true
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

`compat.s3.v1` can be false while `ObjectBucket` is true. ObjectBucket does not
require Takosumi to operate an S3 gateway.

## 11. Takosumi Cloud Public Offering

Takosumi Cloud should be documented like a simple cloud service.

Public service names:

```text
Cloud Workers
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
  ObjectBucket
  AIEndpoint OpenAI-compatible surface

Preview:
  KV
  Queue
  DurableWorkflow

Planned:
  ContainerService
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
first-class shapes where generic providers are not enough
capability-driven provider behavior
TargetPool adapter plugin system
scoped compatibility import paths
clear OSS / Operator / Cloud boundaries
```

## 14. Immediate Build Order

1. Keep plain OpenTofu Stack execution reliable.
2. Keep arbitrary provider support through generic-env ProviderConnections.
3. Finish Resource API, planner, resolver, state, and ResolutionLock for
   ObjectBucket, EdgeWorker, and AIEndpoint.
4. Finish `takosumi/takosumi` provider schemas for those shapes.
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
