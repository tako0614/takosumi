# Takosumi Final Plan

Last updated: 2026-06-29

This document is the authoritative Takosumi product direction.

## 0. Final Definition

Takosumi is not primarily a cloud service. Takosumi is an open,
Git-based OpenTofu control plane.

```text
Takosumi =
  OSS Git-based OpenTofu control plane
  + Resource Shape API
  + Resolver / Planner / Runner / Reconciler
  + Target / Credential / OIDC / Secret / Policy
  + Compatibility API framework
  + Adapter system
```

Takosumi receives Git-managed OpenTofu configurations and Takosumi abstract
resource definitions, then uses policy, credential, target capability, and
current state to plan, apply, reconcile, detect drift, and manage state.

```text
Takosumi for Operator =
  Takosumi
  + multi-tenant customer management
  + billing / metering / quota / plan
  + operator console
  + managed target catalog
  + commercial operation features
```

```text
Takosumi Cloud =
  officially hosted Takosumi for Operator
  + official managed targets
  + Takosumi-owned native resources
  + official billing
  + official SLA / support
```

Cloud is an operation form, not the core product. The core product is:

```text
Git + OpenTofu + Resource Shape + Resolver + Compat API + Adapter
```

Takosumi can run plain OpenTofu stacks as-is, and it can also resolve
`takosumi_*` resource shapes to Cloudflare, AWS, Kubernetes, VMs, or Takosumi
native targets. AI providers are handled through the same mechanism: a
`takosumi_ai_endpoint` shape declares the desired API surface, while the engine
and operator decide whether it is backed by Cloudflare AI Gateway, Workers AI,
an OpenAI-compatible upstream, Gemini/GLM/DeepSeek, Bedrock, Vertex AI, or a
Takosumi native gateway.

## 1. Product Split

### 1.1 Takosumi Core / OSS

The standard OSS product includes cloud-like control-plane primitives, but not
commercial billing or official hosted capacity.

Included in OSS:

```text
Git integration
OpenTofu runner
OpenTofu state management
run history
plan / apply / destroy
policy check
approval workflow
drift detection
Resource Shape API
Resolver
Planner
Adapter framework
TargetPool
Credential management
OIDC issuer
Workload identity
Secret management
Basic RBAC
Audit log
Compatibility API framework
takosumi_provider-compatible API
```

Not included in OSS:

```text
commercial billing
invoice
subscription plan
payment integration
operator customer management
reseller features
official managed capacity
official SLA
official support operation
```

Takosumi OSS still needs basic identity concepts:

```text
User
Principal
Role
RoleBinding
ServiceAccount
AgentIdentity
WorkloadIdentity
OIDCProvider
Federation
AuditEvent
```

These are separate from commercial `Customer`, `Subscription`, `Invoice`, and
`Payment` entities.

### 1.2 takosumi-engine

`takosumi-engine` is the core execution engine. It is OSS and shared by
self-hosted Takosumi, Takosumi for Operator, and Takosumi Cloud.

Inputs:

```text
Git revision
OpenTofu stack
Takosumi resource spec
TargetPool
Credential
Policy
Current state
```

Processing:

```text
fetch
validate
normalize
graph build
resolve
plan
apply
reconcile
observe
drift detection
state update
```

Outputs:

```text
plan result
operation graph
native resource graph
run log
status
outputs
audit events
usage events
```

Cloud can inject private adapters, private target allocators, native resource
backends, and billing meters into the same engine. API shape stays capability
based; Cloud-only branches must not be hard-coded into the provider or public
resource model.

### 1.3 takosumi-provider

`takosumi/takosumi` is an OpenTofu provider that can connect to any Takosumi
endpoint, not only Takosumi Cloud.

```hcl
provider "takosumi" {
  endpoint = "https://takosumi.example.com"
  space    = "prod"
}
```

For Takosumi Cloud:

```hcl
provider "takosumi" {
  endpoint = "https://app.takosumi.com"
  space    = "prod"
}
```

The provider is thin:

```text
HCL schema
validation
Takosumi API client
preview request
apply request
status polling
outputs/state mapping
```

It does not call AWS, Cloudflare, Kubernetes, or other southbound APIs directly.
It asks Takosumi for discovery and capabilities:

```http
GET /.well-known/takosumi
GET /v1/capabilities
```

The provider must branch on capabilities, not edition names.

```text
Good:
  resource_shapes = true
  compat.s3.v1 = true
  oidc = true

Bad:
  if edition == "cloud" then ...
```

The provider is not limited to resources used by the official Cloud deployment.
It should grow as a broad, shape-specific provider for the public Takosumi
Resource Shape API. Whether a shape is accepted is decided by endpoint
capabilities, target capabilities, policy, and the engine/admin configuration.
For extensible surfaces such as AI, the provider validates the resource shape
and basic token syntax, then lets the endpoint decide support. It must not
hard-code every vendor/profile the official Cloud deployment happens to use.

```text
Good:
  takosumi_ai_endpoint exists in the provider
  endpoint capabilities decide if AIEndpoint is usable
  resolver/admin decide if openai-compatible, Workers AI, Gemini, DeepSeek, GLM,
  Bedrock, Vertex AI, or Takosumi native can back it

Bad:
  only add resources used by Takosumi Cloud itself
  hide every non-official provider behind generic takosumi_resource
  branch on edition == cloud
```

### 1.4 takosumi-agent

`takosumi-agent` runs in a user's network, Kubernetes cluster, VM fleet, or
private environment.

Use cases:

```text
run OpenTofu inside a private network
avoid sending user credentials to hosted Takosumi
apply from inside a Kubernetes cluster
bootstrap or observe VMs
stream logs, metrics, and heartbeat
reach private resources
```

Credential modes:

```text
static_secret
  Takosumi stores credential material as a secret.

oidc_federation
  Takosumi issues an OIDC token and a cloud provider federates it.

agent_local
  The credential stays in the user's agent environment.

managed
  The operator or Takosumi Cloud owns the target credential.
```

### 1.5 Takosumi for Operator

Takosumi for Operator is for organizations, hosting providers, MSPs, internal
platform teams, schools, and vendors that offer Takosumi to other users.

Added on top of OSS:

```text
Tenant
Customer
BillingAccount
Subscription
Plan
Quota
Meter
UsageRecord
Invoice
Payment integration
Operator console
Product catalog
Managed target catalog
Customer onboarding
Abuse control
Commercial audit
Support tools
```

Example:

```text
Acme Cloud =
  Takosumi for Operator
  + Acme-owned Kubernetes clusters
  + Acme-owned VM fleet
  + Acme AWS account pool
  + Acme Cloudflare account
  + Acme storage / DB / queue systems
  + Acme billing
```

### 1.6 Takosumi Cloud

Takosumi Cloud is the official hosted Takosumi for Operator.

It includes:

```text
official hosted control plane
official account system
official billing
official target pools
official Cloudflare / AWS / Kubernetes / VM integrations
Takosumi Native Runtime
Takosumi Native Object Store
Takosumi Native Queue
Takosumi Native DB
Takosumi Edge Gateway
official support / SLA
```

Takosumi Cloud supports both:

```text
BYOC mode:
  user-owned AWS / Cloudflare / GCP / Kubernetes credentials

Managed target mode:
  operator-owned official targets managed by Takosumi Cloud
```

## 2. Two Core Flows

### Flow A: Run Plain OpenTofu From Git

Users can write ordinary OpenTofu.

```hcl
resource "aws_s3_bucket" "assets" {
  bucket = "my-assets"
}
```

Flow:

```text
Git commit
  -> Takosumi detects revision
  -> clone
  -> tofu init
  -> tofu plan
  -> policy check
  -> approval
  -> tofu apply
  -> state saved
  -> outputs saved
  -> drift detection
```

In this flow Takosumi is close to an OpenTofu/Terraform Cloud style control
plane. It does not abstract the cloud provider; users use existing providers
directly.

### Flow B: Resolve Takosumi Resource Shapes

Users can also write `takosumi_*` resources.

```hcl
resource "takosumi_object_store" "assets" {
  name = "assets"

  interfaces = [
    "s3_api",
    "signed_url"
  ]
}

resource "takosumi_http_service" "api" {
  name = "api"

  runtime = {
    interface = "web_fetch"
    language  = "typescript"
    profiles  = ["workers_bindings"]
  }

  exposure = {
    public_http = true
  }

  connections = {
    ASSETS = {
      resource    = takosumi_object_store.assets.id
      permissions = ["read", "write"]
      projection  = "runtime_binding"
    }
  }
}
```

Takosumi resolves those desired shapes:

```text
ObjectStore/assets
  -> AWS S3
  -> Cloudflare R2
  -> MinIO
  -> Takosumi Object Store

HttpService/api
  -> Cloudflare Workers
  -> AWS Lambda
  -> Kubernetes Deployment
  -> Takosumi Runtime
```

Users do not choose a backend in the resource by default. TargetPool,
SpacePolicy, target capabilities, cost model, region, and resolution locks
decide where it lands.

## 3. Design Principles

### 3.1 Cloud Is Not the Product Core

Takosumi core is:

```text
Git + OpenTofu control plane
```

Cloud is:

```text
official hosting + official targets + billing
```

Public APIs must not assume Takosumi Cloud is the only deployment.

### 3.2 Standard Takosumi Includes Cloud Control Primitives

Standard Takosumi includes:

```text
Resource API
TargetPool
CredentialBroker
Resolver
Runner
OIDC
Secret
Compatibility API framework
Adapter framework
```

This is required because `takosumi_provider` must work with any Takosumi
endpoint, not only the official Cloud deployment.

### 3.3 Billing And Commercial Customer Management Are Operator/Cloud

Standard Takosumi has:

```text
Principal
Role
RoleBinding
ServiceAccount
AuditLog
usage event emission
```

Takosumi for Operator and Takosumi Cloud add:

```text
Customer
Tenant
Subscription
Plan
Invoice
Payment
rated usage charge
commercial quota
```

### 3.4 Do Not Put Backend Selection In HCL By Default

Avoid this as the normal user model:

```hcl
resource "takosumi_http_service" "api" {
  backend = "cloudflare_workers"
}
```

Prefer this:

```hcl
resource "takosumi_http_service" "api" {
  runtime = {
    interface = "web_fetch"
    language  = "typescript"
    profiles  = ["workers_bindings"]
  }

  preferences = {
    cost        = "low"
    operations  = "managed"
    portability = "high"
  }
}
```

Operators control backend availability through TargetPool, SpacePolicy, and
capabilities.

### 3.5 Resolution Is Locked

If Takosumi chooses a backend, the decision must be recorded.

```json
{
  "resourceId": "tkrn:prod:HttpService:api",
  "selectedImplementation": "cloudflare_workers",
  "target": "cloudflare-main",
  "locked": true,
  "reason": [
    "web_fetch native",
    "workers_bindings native",
    "low cost preference matched"
  ]
}
```

Takosumi must not silently move a resource from Cloudflare Workers to AWS Lambda
or Kubernetes. Migration is an explicit operation.

### 3.6 Keep Shape, Interface, Profile, And Implementation Separate

```text
Shape:
  resource form and lifecycle, e.g. ObjectStore or HttpService

Interface:
  externally visible API/protocol, e.g. s3_api, signed_url, web_fetch

Profile:
  ecosystem compatibility surface, e.g. workers_bindings, node_compat

Implementation:
  actual target backend, e.g. cloudflare_r2, aws_s3, kubernetes
```

Do not collapse these into one provider enum.

## 4. Resource Object Model

Takosumi resource objects are Kubernetes-like.

```json
{
  "apiVersion": "takosumi.dev/v1alpha1",
  "kind": "HttpService",
  "metadata": {
    "name": "api",
    "space": "prod",
    "project": "myapp",
    "environment": "prod",
    "managedBy": "opentofu",
    "labels": {
      "app": "myapp"
    }
  },
  "spec": {
    "runtime": {
      "interface": "web_fetch",
      "language": "typescript",
      "profiles": ["workers_bindings", "node_compat"]
    },
    "exposure": {
      "publicHttp": true
    }
  },
  "status": {
    "phase": "Ready",
    "observedGeneration": 4,
    "resolution": {
      "selectedImplementation": "cloudflare_workers",
      "target": "cloudflare-main",
      "locked": true,
      "portability": "mostly_portable"
    },
    "outputs": {
      "url": "https://api.example.com"
    },
    "conditions": [
      {
        "type": "Ready",
        "status": "True"
      }
    ]
  }
}
```

Sections:

```text
metadata:
  name, space, project, environment, owner, labels, managedBy

spec:
  desired state

status:
  observed state

resolution:
  implementation and target selected by the resolver

nativeResources:
  concrete resources created below the shape

conditions:
  Ready / Reconciling / Drifted / Degraded / Blocked
```

## 5. Resource Shapes

### 5.1 Core / Management

```text
Space
Project
Environment
Stack
Run
State
Artifact
Secret
Config
Policy
Target
TargetPool
Credential
Agent
AgentPool
Principal
Role
RoleBinding
ServiceAccount
```

### 5.2 Compute

```text
HttpService
ContainerService
EventHandler
Job
Machine
MachinePool
ActorClass
KubernetesCluster
```

### 5.3 Data / Storage

```text
ObjectStore
KVStore
RelationalDatabase
SQLStore
Cache
Queue
Stream
Volume
FileShare
```

### 5.4 AI

```text
AIEndpoint
AIModelProvider
EmbeddingModelProvider
ModelRoute
ModelPolicy
```

`AIEndpoint` is the first-class user-facing shape. It declares the API surface
and model policy the application needs.

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

  model_policy = {
    default_model  = "fast/chat"
    allowed_models = ["fast/chat", "reasoning/chat", "embed/text"]
  }
}
```

The HCL does not choose a vendor by default. A TargetPool and policy decide
whether this is backed by:

```text
Cloudflare AI Gateway
Workers AI
OpenAI-compatible upstream
DeepSeek
GLM
Gemini / Vertex AI
AWS Bedrock
Takosumi native AI gateway
operator-provided custom adapter
```

AI interfaces and profiles are extensible capability tokens. Takosumi publishes
well-known tokens such as `openai_chat_completions`, `openai_embeddings`, and
`openai_compatible`, but an operator can add endpoint-specific tokens when the
engine, adapter, and TargetPool capability evidence support them. This keeps
`takosumi_ai_endpoint` broad without falling back to a generic
`takosumi_resource`.

Example operator TargetPool entry:

```yaml
targets:
  - name: deepseek-main
    type: ai_provider
    ref: https://api.deepseek.example/v1
    priority: 90
    implementations:
      - shape: AIEndpoint
        implementation: deepseek_openai_gateway
        nativeResourceType: ai.deepseek_endpoint
        interfaces:
          openai_chat_completions: native
          openai_embeddings: shim
          vendor.deepseek.responses.v1: native
```

The public interface can be OpenAI-compatible even when the implementation is
not OpenAI. Model aliases, routing, quotas, and billing are operator/Cloud
policy. Secrets and upstream API keys stay in ProviderConnection/Credential
storage, not in the resource spec or OpenTofu state.

### 5.5 Network / Exposure

```text
Endpoint
Route
Domain
Certificate
LoadBalancer
PrivateNetwork
FirewallPolicy
ServiceLink
```

### 5.6 Identity / Security

```text
Secret
Config
Principal
Grant
Connection
Policy
ServiceAccount
OIDCProvider
Federation
```

### 5.7 Build / Artifact

```text
Source
Build
Artifact
ContainerImage
Release
Registry
```

## 6. Connections, Grants, Projections, Triggers, And Routes

HCL uses `connections` as the public term.

```hcl
connections = {
  DATABASE = {
    resource    = takosumi_relational_database.main.id
    permissions = ["connect"]
    projection  = "database_url"
  }
}
```

Internally this decomposes into:

```text
Connection:
  from -> to relationship

Grant:
  permission assigned to a principal

Projection:
  how the connected resource appears to the workload
```

Keep these separate:

```text
connection:
  service uses a resource

trigger:
  event starts a service

route:
  request reaches a service

grant:
  principal receives permissions

projection:
  workload sees env / binding / URL / client descriptor
```

Backend mapping examples:

```text
Cloudflare:
  Worker metadata binding + R2/KV/D1/Queue binding

AWS:
  IAM policy + env var + generated SDK client config

Kubernetes:
  ServiceAccount + Secret + ConfigMap + NetworkPolicy

Takosumi Native:
  runtime capability injection + internal grant
```

## 7. Target, Credential, And Policy

### 7.1 Target

```json
{
  "apiVersion": "takosumi.dev/v1alpha1",
  "kind": "Target",
  "metadata": {
    "name": "aws-prod",
    "space": "prod"
  },
  "spec": {
    "type": "aws",
    "credentialRef": "cred_aws_prod",
    "region": "ap-northeast-1",
    "mode": "user_managed"
  }
}
```

Target types:

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
```

### 7.2 TargetPool

```yaml
apiVersion: takosumi.dev/v1alpha1
kind: TargetPool
metadata:
  name: prod-default
  space: prod
spec:
  targets:
    - name: cloudflare-main
      type: cloudflare
      accountRef: cf-prod
      priority: 80
    - name: aws-main
      type: aws
      accountRef: aws-prod
      priority: 70
    - name: k8s-prod
      type: kubernetes
      clusterRef: prod-cluster
      priority: 60
    - name: takosumi-native-jp
      type: takosumi_native
      region: jp
      priority: 90
```

### 7.3 SpacePolicy

```yaml
apiVersion: takosumi.dev/v1alpha1
kind: SpacePolicy
metadata:
  name: prod
spec:
  allowedTargets:
    - takosumi_native
    - cloudflare
    - aws
    - kubernetes_prod
  deniedTargets:
    - gcp
  constraints:
    dataResidency: jp
    encryptionAtRest: required
    publicExposureRequiresTls: true
    auditLog: required
  preferences:
    cost: low
    operations: managed
    portability: high
  resolution:
    lockAfterCreate: true
    allowAutoMigration: false
  approvals:
    requireForApply: true
    requireForDestroy: true
```

Data resources must declare deletion lifecycle policy:

```hcl
lifecycle_policy = {
  delete = "retain"
}
```

Allowed values:

```text
delete
retain
snapshot_then_delete
block
```

## 8. Resolver And Planner

Resolver input:

```text
resource shape
interfaces
profiles
connections
triggers
constraints
preferences
space policy
target pool
existing resolution lock
target capabilities
cost model
compliance rules
```

Resolver output:

```text
selected implementation
selected target
native resource plan
compatibility score
portability score
cost estimate
risk notes
resolution lock
```

Capability level:

```text
native
  backend provides the interface directly

shim
  adapter/runtime shim covers it

emulated
  Takosumi implements a substitute behavior

unsupported
  not supported
```

Planner turns the selected implementation into native resources.

Cloudflare example:

```text
Desired:
  HttpService/api
  ObjectStore/assets
  Route/api
  Connection/api->assets

Native:
  Cloudflare Worker Script/api
  Cloudflare Worker Deployment/api
  Cloudflare R2 Bucket/assets
  Worker R2 Binding/api.ASSETS
  Cloudflare Route/api.example.com/*
  Cloudflare DNS Record/api.example.com
```

Kubernetes example:

```text
Native:
  Deployment/api
  Service/api
  ServiceAccount/api
  Secret/api-connections
  HTTPRoute/api
  ConfigMap/api-runtime
  NetworkPolicy/api-to-db
```

## 9. Adapter Contract

Adapters turn implementation requests into preview/apply/observe/delete work.

```ts
interface TakosumiAdapter {
  discoverCapabilities(): CapabilitySet;
  preview(input: ImplementationRequest): ImplementationPlan;
  apply(plan: ImplementationPlan): ApplyResult;
  observe(ref: NativeResourceRef): ObservedState;
  delete(ref: NativeResourceRef, policy: DeletePolicy): DeleteResult;
  import(ref: ExternalRef): ImportResult;
  estimateCost(plan: ImplementationPlan): CostEstimate;
  validate(input: ImplementationRequest): ValidationResult;
  migrate?(from: NativeResourceRef, to: Target): MigrationPlan;
}
```

Initial adapter families:

```text
opentofu-adapter
cloudflare-adapter
aws-adapter
kubernetes-adapter
vm-adapter
takosumi-native-adapter
```

The OpenTofu adapter should be broad first:

```text
Takosumi Resource Shape
  -> internal OpenTofu module
  -> existing OpenTofu provider
  -> AWS / Cloudflare / Kubernetes / etc.
```

Important resources can later get native adapters:

```text
ObjectStore
HttpService
Queue
KubernetesCluster
Machine
```

## 10. State Model

Do not mix these states:

```text
1. OpenTofu state
   state for normal OpenTofu stacks

2. Takosumi resource state
   state for ObjectStore / HttpService / Queue / etc.

3. Native resource state
   concrete AWS / Cloudflare / Kubernetes / VM / Takosumi Native resources
```

OpenTofu provider state should hold the Takosumi resource id and outputs, not
raw native provider ids or secret material.

```json
{
  "id": "tkrn:prod:HttpService:api",
  "name": "api",
  "generation": 4,
  "outputs": {
    "url": "https://api.example.com"
  }
}
```

Takosumi stores resolution locks, native resource refs, and observed status.

## 11. API

### 11.1 Discovery

```http
GET /.well-known/takosumi
```

Example:

```json
{
  "api_versions": ["takosumi.dev/v1alpha1"],
  "features": {
    "stacks": true,
    "resource_shapes": true,
    "opentofu_runner": true,
    "oidc": true,
    "workload_identity": true,
    "billing": false,
    "operator_tenants": false,
    "compat_s3": true,
    "compat_oci": true,
    "compat_cloudflare_subset": false
  },
  "endpoints": {
    "api": "https://takosumi.example.com/api",
    "oidc_issuer": "https://takosumi.example.com",
    "s3": "https://s3.takosumi.example.com",
    "oci": "https://registry.takosumi.example.com"
  }
}
```

### 11.2 Capabilities

```http
GET /v1/capabilities
```

Example:

```json
{
  "apiVersion": "takosumi.dev/v1alpha1",
  "resources": {
    "Stack": true,
    "ObjectStore": true,
    "HttpService": true,
    "AIEndpoint": true,
    "ContainerService": true,
    "Machine": false
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
    "s3": true,
    "oci": true,
    "cloudevents": true,
    "cloudflare_subset": false
  },
  "identity": {
    "oidc_issuer": true,
    "external_oidc_login": true,
    "workload_identity": true
  },
  "commercial": {
    "billing": false,
    "operator_tenants": false
  }
}
```

### 11.3 Resource API

```http
POST   /v1/resources/preview
PUT    /v1/resources/{kind}/{name}
GET    /v1/resources/{kind}/{name}
DELETE /v1/resources/{kind}/{name}
GET    /v1/resources
GET    /v1/resources/{id}/events
POST   /v1/resources/{id}/refresh
POST   /v1/resources/{id}/import
```

### 11.4 Stack API

```http
POST   /v1/stacks
GET    /v1/stacks/{id}
PUT    /v1/stacks/{id}
DELETE /v1/stacks/{id}

POST   /v1/stacks/{id}/runs
GET    /v1/runs/{id}
GET    /v1/runs/{id}/events
POST   /v1/runs/{id}/approve
POST   /v1/runs/{id}/cancel
POST   /v1/runs/{id}/apply
POST   /v1/runs/{id}/destroy
```

Run phases:

```text
queued
fetching
init
validating
planning
policy_check
waiting_approval
applying
refreshing
completed
failed
cancelled
```

### 11.5 Target / Credential API

```http
POST   /v1/targets
GET    /v1/targets
PUT    /v1/targets/{id}
DELETE /v1/targets/{id}

POST   /v1/target-pools
GET    /v1/target-pools
PUT    /v1/target-pools/{id}

POST   /v1/credentials
GET    /v1/credentials
POST   /v1/credentials/{id}/rotate
DELETE /v1/credentials/{id}
```

### 11.6 Identity / OIDC API

Standard Takosumi includes OIDC.

```http
GET  /.well-known/openid-configuration
GET  /oauth/jwks
POST /oauth/token

POST /v1/identity/tokens
POST /v1/identity/service-accounts
POST /v1/identity/federation/aws
POST /v1/identity/federation/gcp
POST /v1/identity/federation/kubernetes
```

Operator/Cloud can add:

```text
enterprise SSO
SAML
SCIM
advanced RBAC
session policy
tenant isolation
audit export
```

## 12. Compatibility API Framework

Compatibility APIs are framework capabilities in standard Takosumi. Whether a
specific compatibility profile is enabled is reported through capabilities.

Priority compatibility profiles:

```text
compat.s3.v1
  ObjectStore

compat.oci.v1
  Artifact / ContainerImage

compat.cloudevents.v1
  Queue / EventHandler / Stream

compat.kubernetes.crd.v1
  Kubernetes and GitOps entrypoint

compat.cloudflare.workers.v1
  limited Workers / R2 / KV / route import path

compat.aws.sqs.v1
  Queue

compat.redis.v1
  Cache / KV

compat.postgres.v1
  RelationalDatabase proxy/profile
```

Compatibility APIs are entrypoints, not the internal model.

```text
S3 bucket create
  -> ObjectStore resource

Cloudflare Worker upload
  -> HttpService resource

Kubernetes CRD apply
  -> Resource API

OCI image push
  -> Artifact / ContainerImage resource

CloudEvents POST
  -> Queue / EventHandler event
```

Compatibility has two distinct roles:

```text
Control compatibility:
  existing tools create or manage Takosumi resources through a familiar API.

Data compatibility:
  existing SDKs and applications read or write actual data through a familiar
  protocol.
```

Examples:

```text
Cloudflare Workers API subset:
  control compatibility for HttpService, Route, Secret, KV, ObjectStore, and
  SQLStore style resources.

S3 bucket metadata API:
  control compatibility for ObjectStore.

S3 object put/get:
  data compatibility for the selected ObjectStore implementation.
```

Data-plane access may run in either mode:

```text
proxy mode:
  SDK -> Takosumi endpoint -> selected backend.
  Stronger for audit, migration, backend hiding, and billing enforcement.

direct credential mode:
  SDK -> temporary endpoint/credential -> selected backend.
  Stronger for latency, cost, and throughput.
```

Do not claim full AWS or full Cloudflare compatibility. Version and scope every
compat surface.

## 13. Kubernetes And VM

Kubernetes has three roles:

```text
Kubernetes as implementation target:
  Resource shapes become Deployments, Services, Jobs, Secrets, Gateway API, etc.

Kubernetes as northbound API:
  CRDs create Takosumi resources through a takosumi-k8s-controller.

Kubernetes as managed resource:
  Takosumi can create a KubernetesCluster resource itself.
```

VM also has two roles:

```text
user resource:
  Machine / MachinePool

internal substrate:
  fleet for containers, jobs, databases, runtimes, or Kubernetes nodes
```

VM modes:

```text
managed
unmanaged
workload_node
```

## 14. Takosumi Native Resources

Takosumi Cloud may use Takosumi-owned resources, but they are not magical.
Resolver sees them as one target family.

```text
Takosumi Runtime
Takosumi Object Store
Takosumi KV
Takosumi Queue
Takosumi Postgres
Takosumi Edge Gateway
Takosumi VM Fleet
Takosumi Build System
Takosumi Secret Store
Takosumi Identity
```

They sit beside AWS, Cloudflare, Kubernetes, and VM adapters:

```text
ObjectStore
  -> AWS S3
  -> Cloudflare R2
  -> MinIO
  -> Takosumi Object Store

HttpService
  -> Cloudflare Workers
  -> AWS Lambda
  -> Kubernetes Deployment
  -> Takosumi Runtime
```

## 15. Drift, Reconcile, And Field Ownership

Takosumi observes native resources and records drift.

```json
{
  "type": "Drifted",
  "status": "True",
  "reason": "NativeResourceModified",
  "message": "Cloudflare Worker route was changed outside Takosumi"
}
```

Drift policy:

```text
reconcile
report_only
adopt
block
```

Multiple entrypoints can write resources:

```text
OpenTofu
Console
CLI
Kubernetes CRD
Compat API
Git
```

Therefore resources need field ownership.

```text
managedBy = opentofu:
  console direct edits are blocked unless they create an override/import/migration request

managedBy = console:
  OpenTofu must import/adopt the resource before HCL owns its spec

managedBy = compat_api:
  the compatibility request is normalized into the canonical Resource API
```

Future model:

```json
{
  "managedBy": "opentofu",
  "fieldOwners": {
    "spec.runtime": "opentofu",
    "spec.connections": "opentofu",
    "spec.scale.max": "console"
  }
}
```

## 16. Billing And Metering

Core emits usage events. Operator/Cloud rates and bills them.

Core:

```text
usage event emission
audit event emission
resource usage records
```

Operator/Cloud:

```text
usage event
  -> meter
  -> rating
  -> invoice
  -> payment
```

Usage event families:

```text
HttpService request count
HttpService execution time
ObjectStore storage bytes
ObjectStore request count
Queue messages
DB storage
DB compute
VM hours
Build minutes
Egress
```

## 17. API Versioning

Initial API version:

```text
takosumi.dev/v1alpha1
```

Stabilization:

```text
takosumi.dev/v1beta1
takosumi.dev/v1
```

Rules:

```text
v1alpha1:
  breaking changes allowed

v1beta1:
  main schema shape fixed; upgrade path required

v1:
  backward compatibility maintained; no field removal
```

Compatibility profiles are also versioned:

```text
compat.s3.v1
compat.oci.v1
compat.cloudevents.v1
compat.cloudflare.workers.v1
compat.aws.sqs.v1
```

## 18. Repository Direction

Target structure:

```text
takosumi/
  api/
    openapi/
    proto/
    schemas/
    crds/

  core/
    resource-api/
    stack-api/
    identity/
    policy/
    state/
    secrets/

  engine/
    compiler/
    graph/
    resolver/
    planner/
    runner/
    reconciler/
    observer/

  provider/
    opentofu/

  cli/
    takosumi/

  agent/
    runner-agent/
    k8s-agent/
    vm-agent/

  adapters/
    opentofu/
    aws/
    cloudflare/
    kubernetes/
    minio/
    local/
    ssh/
    takosumi-native-sdk/

  compat/
    s3/
    oci/
    cloudevents/
    cloudflare-subset/

  operator/
    billing/
    tenants/
    quotas/
    catalog/
    console/
```

OSS scope:

```text
api
core
engine
provider
cli
agent
basic adapters
compat framework
```

Closed/commercial scope:

```text
operator billing implementation
hosted console details
official native runtime internals
official capacity allocator
premium adapters
payment integration
fraud / abuse controls
commercial support tooling
```

## 19. MVP Sequence

### Phase 0: API And Base

```text
/.well-known/takosumi
/v1/capabilities
Resource object schema
Stack schema
Target/Credential schema
OIDC issuer skeleton
Secret store
State store
Operation model
```

### Phase 1: OpenTofu Stack Controller

```text
Git integration
OpenTofu runner
state backend
plan/apply/destroy
run logs
approval
basic RBAC
static credentials
OIDC federation
minimal agent mode
```

### Phase 2: takosumi-provider + Resource API

```text
takosumi_provider
Resource API
preview/apply/status
ObjectStore
Secret
Route
Connection model
Resolution lock
```

### Phase 3: ObjectStore + S3 Compat

```text
takosumi_object_store
S3-compatible API
AWS S3 adapter
Cloudflare R2 adapter
MinIO adapter
Takosumi Object Store minimal
```

### Phase 4: HttpService / ContainerService

```text
takosumi_http_service
takosumi_container_service
takosumi_route
takosumi_connection
Cloudflare Workers adapter
Kubernetes adapter
AWS Lambda or ECS adapter
Takosumi Runtime minimal
```

### Phase 5: Queue / DB / EventHandler

```text
takosumi_queue
takosumi_relational_database
takosumi_event_handler
CloudEvents API
SQS-compatible subset
Postgres connection projection
```

### Phase 6: Kubernetes

```text
Takosumi CRDs
takosumi-k8s-controller
Gateway API integration
Kubernetes operators integration
Postgres operator support
MinIO / NATS / RabbitMQ mapping
```

### Phase 7: VM / MachinePool

```text
takosumi_machine
takosumi_machine_pool
VM agent
EC2 adapter
Hetzner adapter
Proxmox / libvirt adapter
Takosumi VM Fleet
```

### Phase 8: Operator / Cloud

```text
multi-tenant
customer management
billing
metering
quota
plans
official managed targets
Takosumi Cloud console
official native resources
```

## 20. Non-goals

```text
Do not implement full AWS API compatibility.
Do not implement full Cloudflare API compatibility.
Do not implement full OpenTofu provider-compatible API compatibility.
Do not collapse everything into one takosumi_resource.
Do not force users to choose a backend in every HCL resource.
Do not make takosumi_provider Cloud-only.
Do not make commercial billing the center of standard Takosumi.
```

Avoid generic catch-all resources:

```hcl
resource "takosumi_resource" "anything" {
  type = "..."
  spec = jsonencode(...)
}
```

That shape weakens the OpenTofu experience:

```text
plan diffs
validation
import
drift detection
state upgrade
editor completion
```

Prefer first-class shapes such as `takosumi_http_service`,
`takosumi_object_store`, `takosumi_queue`, and `takosumi_machine`.

Compatibility APIs must be scoped, versioned subsets.

```text
Good:
  compat.cloudflare.workers.v1

Bad:
  Cloudflare complete compatibility
```

## 21. Final Product Sentence

```text
Takosumi is an open Git-based OpenTofu control plane with a resource-shape
resolver, compatibility APIs, and pluggable target adapters.

Takosumi Cloud is the official hosted deployment with managed targets, native
resources, billing, and operator-grade multi-tenancy.
```

In short:

```text
Takosumi is cloud-independent infrastructure control plane centered on Git and
OpenTofu. It can run ordinary OpenTofu and it can resolve takosumi_* resource
shapes. Cloudflare, AWS, Kubernetes, VMs, and Takosumi-owned resources are all
target adapters. Takosumi Cloud is the official hosted operation, not the core.
```
