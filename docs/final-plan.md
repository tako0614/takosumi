# Takosumi Final Plan

Last updated: 2026-06-19

This document is the product direction to use when redesigning Takosumi.
It supersedes older plans that treated compatibility gateways, managed cloud
resources, or Takosumi-provided provider endpoints as part of the OSS control
plane.

## 0. Definition

Takosumi OSS is a control plane that runs the existing OpenTofu/Terraform
provider ecosystem as-is.

Takosumi Cloud is the official hosted, closed service based on Takosumi for
Operators, with cloud-only compatibility gateways and managed resources.

```text
OSS:
  Run existing providers as-is.

Cloud:
  Add compatibility APIs, managed resources, and official hosting.
```

The most important boundary is:

```text
OSS runs existing providers.
Only Cloud has compatibility gateways and managed resources.
```

## 1. Product Shape

Takosumi is split into four layers.

```text
Takosumi Core
Takosumi
Takosumi for Operators
Takosumi Cloud
```

### 1.1 Takosumi Core

Takosumi Core is the shared OSS engine.

It owns:

```text
OpenTofu/Terraform execution
Provider Connection
Credential Recipe
credential/env/file injection
Provider Binding
state management
secret management
run history
audit log
runner protocol
Workspace / Project / Capsule model
outputs management
outputs-to-inputs wiring
```

Core is not the primary end-user product by itself. It is the foundation used by
the OSS self-host edition, the OSS operator edition, and Takosumi Cloud.

### 1.2 Takosumi

Takosumi is the OSS self-host product for individuals and small teams.

Purpose:

```text
Connect your own cloud accounts.
Run your own OpenTofu/Terraform manifests.
Keep state, secrets, outputs, logs, and run history in Takosumi.
```

It includes:

```text
Git URL source registration
OpenTofu init / validate / plan / apply / destroy
Provider Connection management
Credential Recipe based env/file injection
state management
secret management
run history
outputs
local runner
docker runner
remote runner
minimal Web UI
minimal CLI
```

It does not include compatibility gateways or managed cloud resources.

### 1.3 Takosumi for Operators

Takosumi for Operators is the OSS edition for organizations, vendors, schools,
communities, or internal platform teams that want to operate Takosumi for their
own users.

It includes:

```text
multi-tenant operation
workspace/team management
operator admin console
runner pool
provider connection management
basic quota
audit log
operator settings
per-user and per-workspace state/secret/run isolation
```

It does not include:

```text
Cloudflare Compatibility Gateway
AWS/GCP compatibility APIs
S3 gateway
Takosumi Managed Edge
Takosumi Managed Storage
Takosumi Managed Container
official billing
official resource backend
Takosumi Cloud closed features
```

### 1.4 Takosumi Cloud

Takosumi Cloud is the official service operated by us.

```text
Takosumi Cloud =
  official hosted Takosumi for Operators
  + closed cloud-only features
```

Takosumi Cloud is not the open-source operator edition. It is the official
deployment of the operator edition plus private cloud modules.

It includes:

```text
official hosting
official runner pool
official billing
official quota
official usage metering
official support/admin
Cloudflare Compatibility Gateway
Takosumi Edge Worker
Takosumi Object Storage
Takosumi App Database
Takosumi KV / Queue
Takosumi Cloud Container
official managed resource backend
```

## 2. Relationship

```text
Takosumi Core  OSS
  |
  +-- Takosumi  OSS
  |     self-host for individuals and small teams
  |
  +-- Takosumi for Operators  OSS
        self-host for organizations and operators

Takosumi for Operators
  |
  +-- official hosting + closed cloud features
        Takosumi Cloud  CLOSED
```

Short form:

```text
Everything except the official cloud service is OSS.
Only Takosumi Cloud is closed.
```

## 3. Design Principles

### 3.1 Use the Existing Provider Ecosystem

Takosumi OSS does not reimplement providers.

Examples of providers that should run as-is:

```text
AWS:          hashicorp/aws
GCP:          hashicorp/google
Cloudflare:   cloudflare/cloudflare
Hetzner:      hetznercloud/hcloud
DigitalOcean: digitalocean/digitalocean
Vultr:        vultr/vultr
OpenStack:    terraform-provider-openstack/openstack
S3-compatible: hashicorp/aws with endpoint override
```

Takosumi manages the control plane around those providers:

```text
credential
env/file injection
state
run
logs
outputs
audit
approval
secret redaction
```

### 3.2 OSS Has No Compatibility Gateway

These are not OSS Takosumi features:

```text
Cloudflare compatibility API
AWS/GCP compatibility APIs
S3 gateway
Resource Driver system
Compat Pack system
Managed Edge
Managed Container
Managed Storage
official cloud backend
official billing/quota/usage
```

OSS Takosumi stays focused on:

```text
OpenTofu/Terraform execution control plane
```

### 3.3 Cloud Owns Compat and Managed Resources

Only Takosumi Cloud has:

```text
Cloudflare Compatibility Gateway
Takosumi Managed Edge Worker
Takosumi Managed Object Storage
Takosumi Managed App DB
Takosumi Managed Container
Cloud-only Provider Connection
official resource backend
billing/quota/usage
```

Cloudflare compatibility starts as a Takosumi Cloud-only capability.

### 3.4 Same Manifest, Different Connection

The central product value is:

```text
Same manifest, different connection.
```

In OSS:

```text
The same .tf can be deployed to dev/prod, another cloud account,
or another provider alias by changing Provider Binding.
```

In Cloud:

```text
The same Cloudflare Workers manifest can target either real Cloudflare
or Takosumi Cloud Edge by changing Provider Binding.
```

## 4. Core Concepts

The final public vocabulary is:

```text
Workspace
Project
Capsule
Source
ProviderConnection
CredentialRecipe
ProviderBinding
Secret
Run
Plan
Apply
Destroy
StateVersion
Output
Runner
AuditEvent
Operator
```

Existing code and older docs may still use terms such as Space, Installation,
Provider Catalog, Gateway, or takos_provided for the previous architecture.
Those names are migration debt unless they are deliberately mapped to the final
model.

### 4.1 Workspace

Workspace is the user/team boundary.

```text
Workspace:
  users
  teams
  projects
  provider connections
  secrets
  state isolation
  audit scope
```

### 4.2 Project

Project is one product, service, application, or infrastructure group.

Example:

```text
Workspace: personal
  Project: home
    Capsule: core
    Capsule: files
    Capsule: talk
```

### 4.3 Capsule

Capsule is one OpenTofu/Terraform module execution unit.

```yaml
capsule:
  id: cap_xxx
  project_id: prj_xxx
  source:
    git: https://github.com/example/infra.git
    ref: main
    path: infra
  tool:
    name: opentofu
    version: 1.10.0
  provider_bindings:
    cloudflare.default:
      connection: cloudflare-main
  state:
    backend: takosumi
```

Takosumi may generate a root module around the user module, but it should not
require a Takosumi-specific manifest inside the user repo.

### 4.4 Run

Run is a single execution.

Supported run types:

```text
init
validate
plan
apply
destroy
refresh
output
```

Each Run records:

```text
source snapshot
tool version
provider lock
provider bindings
injected env metadata
plan result
apply result
logs
outputs
state version
actor
timestamp
```

Raw secrets, temporary credentials, and generated short-lived tokens are not
stored as run records.

## 5. Provider Connection

Provider Connection is the main OSS feature.

```text
Provider Connection =
  a stored provider credential configuration that Takosumi resolves into
  temporary env vars or files only while a Run is executing.
```

Examples:

```yaml
connections:
  cloudflare-main:
    provider: cloudflare
    auth_type: api_token
    secrets:
      api_token: sec_cloudflare_api_token
    values:
      account_id: "xxxxxxxx"

  aws-prod:
    provider: aws
    auth_type: assume_role
    values:
      role_arn: arn:aws:iam::123456789012:role/takosumi
      region: ap-northeast-1

  gcp-main:
    provider: google
    auth_type: service_account_json
    secrets:
      service_account_json: sec_gcp_sa_json
    values:
      project_id: my-project

  generic-api:
    provider: generic-env
    auth_type: env
    secrets:
      CUSTOM_API_TOKEN: sec_custom_api_token
    values:
      CUSTOM_ENDPOINT: https://api.example.com
```

## 6. Credential Recipe

Credential Recipe is the OSS replacement for the old compat-pack idea.

```text
Credential Recipe =
  a definition of which env vars, files, and optional pre-run actions
  are needed to run an existing provider.
```

Cloudflare:

```yaml
id: cloudflare
terraform_source: cloudflare/cloudflare

auth_modes:
  api_token:
    env:
      CLOUDFLARE_API_TOKEN:
        from_secret: api_token
      CLOUDFLARE_ACCOUNT_ID:
        from_value: account_id
```

AWS:

```yaml
id: aws
terraform_source: hashicorp/aws

auth_modes:
  static_keys:
    env:
      AWS_ACCESS_KEY_ID:
        from_secret: access_key_id
      AWS_SECRET_ACCESS_KEY:
        from_secret: secret_access_key
      AWS_REGION:
        from_value: region

  assume_role:
    pre_run:
      type: aws_sts_assume_role
      role_arn:
        from_value: role_arn
    env:
      AWS_ACCESS_KEY_ID:
        from_generated: access_key_id
      AWS_SECRET_ACCESS_KEY:
        from_generated: secret_access_key
      AWS_SESSION_TOKEN:
        from_generated: session_token
      AWS_REGION:
        from_value: region
```

GCP:

```yaml
id: google
terraform_source:
  - hashicorp/google
  - hashicorp/google-beta

auth_modes:
  service_account_json:
    files:
      /run/takosumi/google-credentials.json:
        from_secret: service_account_json
    env:
      GOOGLE_APPLICATION_CREDENTIALS:
        value: /run/takosumi/google-credentials.json
      GOOGLE_PROJECT:
        from_value: project_id
```

Generic env:

```yaml
id: generic-env

auth_modes:
  env:
    env:
      "*":
        from_user_defined: true
```

Generic env is required so unsupported providers remain usable without waiting
for Takosumi to add first-class recipe UI.

## 7. Provider Binding

Provider Binding is intentionally simple.

```text
Provider Binding =
  a mapping from an OpenTofu provider address or alias to a Provider Connection.
```

Examples:

```yaml
provider_bindings:
  cloudflare.default:
    connection: cloudflare-main

  aws.default:
    connection: aws-prod

  google.default:
    connection: gcp-main
```

Alias support:

```yaml
provider_bindings:
  aws.tokyo:
    connection: aws-tokyo

  aws.virginia:
    connection: aws-virginia

  cloudflare.main:
    connection: cloudflare-main

  cloudflare.customer:
    connection: cloudflare-customer
```

This is how the same manifest targets different environments.

## 8. Env and File Injection

Run-time injection flow:

```text
Provider Connection
  -> Credential Recipe
  -> temporary env/file material
  -> Runner sandbox
  -> OpenTofu provider
```

Examples:

```env
CLOUDFLARE_API_TOKEN=...
CLOUDFLARE_ACCOUNT_ID=...
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
AWS_SESSION_TOKEN=...
GOOGLE_APPLICATION_CREDENTIALS=/run/takosumi/google-credentials.json
HCLOUD_TOKEN=...
```

Rules:

```text
secrets are never written into manifests
secrets are injected only into the temporary runner environment
logs redact secrets
temporary credential files are deleted after each run
generated short-lived credentials are not persisted
```

## 9. State

Takosumi OSS provides state management.

Required capabilities:

```text
state storage
state lock
state versioning
state rollback
state diff
state backup
```

Initial backends:

```text
Postgres
local filesystem
S3-compatible backup
```

The MVP may capture local state after a run and persist it in Takosumi. The
final shape should provide a Takosumi state backend.

```yaml
state:
  backend: takosumi
  locking: true
  versioning: true
  backup:
    type: s3-compatible
    connection: r2-backup
```

Takosumi Cloud provides the official state backend for the hosted service.

## 10. Outputs

Takosumi stores OpenTofu outputs and can wire them into another Capsule's
inputs.

Example:

```text
home-core
  outputs:
    home_domain
    member_issuer

files
  inputs:
    home_domain: output(home-core.home_domain)

talk
  inputs:
    home_domain: output(home-core.home_domain)
    member_issuer: output(home-core.member_issuer)
    attachments_bucket: output(files.attachments_bucket)
```

Declarative form:

```yaml
inputs:
  home_domain:
    from_output:
      capsule: home-core
      name: home_domain
```

Outputs-to-inputs is an OSS feature, not a Cloud-only feature.

## 11. Runner

Runner responsibilities:

```text
source checkout
OpenTofu/Terraform version selection
tofu init
tofu validate
tofu plan
tofu apply
tofu destroy
log streaming
artifact upload
state capture/sync
output extraction
temporary env/file injection
secret cleanup
```

Runner types:

```text
local runner
docker runner
remote runner
operator runner pool
cloud hosted runner
```

OSS includes local/docker/remote runner support. Takosumi for Operators adds
runner pools. Takosumi Cloud operates the official hosted runner pool.

## 12. Cloudflare Compatibility Gateway

Cloudflare Compatibility Gateway is Takosumi Cloud-only and closed.

Purpose:

```text
Run existing Cloudflare Workers manifests against Takosumi Cloud Edge
while keeping the cloudflare/cloudflare provider.
```

Shape:

```text
cloudflare/cloudflare provider
  -> base_url = https://api.takosumi.com/compat/cloudflare/client/v4
  -> Takosumi Cloudflare Compatibility Gateway
  -> Takosumi Managed Edge internal API
  -> Cloudflare Workers for Platforms / R2 / D1 / KV
```

Initial scope:

```text
cloudflare_workers_script
cloudflare_workers_route
cloudflare_workers_kv_namespace
cloudflare_r2_bucket
cloudflare_d1_database
worker vars
worker secrets
worker bindings
```

Out of scope for the first Cloudflare compatibility release:

```text
all DNS
WAF
Rulesets
Zero Trust
Account IAM
Billing
Registrar
Load Balancer
Email Routing
Turnstile
```

Cloud-specific connection example:

```yaml
connections:
  takosumi-cloud-edge:
    provider: cloudflare
    type: cloud_managed
    mode: cloudflare_workers_compat
    endpoint: https://api.takosumi.com/compat/cloudflare/client/v4
    virtual_account_id: ts_acc_xxxxx

provider_bindings:
  cloudflare.default:
    connection: takosumi-cloud-edge
```

This connection type is not part of OSS Takosumi.

## 13. Takosumi Managed Resources

Only Takosumi Cloud provides managed resources:

```text
Takosumi Edge Worker
Takosumi Object Storage
Takosumi App Database
Takosumi KV
Takosumi Queue
Takosumi Cloud Container
Takosumi Edge Route
Takosumi Secrets
Takosumi State
```

Cloudflare compatibility is only an entry path:

```text
Cloudflare provider manifest
  -> Takosumi Cloud Gateway
  -> Takosumi Edge Worker
```

Native Cloud resources may also be exposed through the `takosumi/takosumi`
provider, but only in the Cloud product.

## 14. Takosumi Provider

The `takosumi/takosumi` provider should exist, but it is not the main path for
normal cloud resources.

It manages Takosumi itself:

```text
takosumi_workspace
takosumi_project
takosumi_secret
takosumi_connection
takosumi_capsule
takosumi_output_reference
takosumi_cloud_managed_connection
takosumi_cloud_route
```

Future Cloud-only resources may also be exposed through it:

```text
takosumi_cloud_edge_worker
takosumi_cloud_object_bucket
takosumi_cloud_container_service
takosumi_gateway_route
```

It must not become a universal cloud abstraction provider.

## 15. Repository Boundary

### 15.1 OSS repository

Target shape:

```text
takosumi/
  apps/
    web/
    api/
    runner/

  packages/
    core/
    opentofu-runner/
    provider-connections/
    credential-recipes/
    env-injection/
    provider-binding/
    state/
    secrets/
    audit/
    workspace/
    project/
    capsule/
    outputs/
    runner-protocol/
    policy/
    cli/
    sdk/

  recipes/
    providers/
      aws.yaml
      google.yaml
      cloudflare.yaml
      hcloud.yaml
      digitalocean.yaml
      vultr.yaml
      scaleway.yaml
      openstack.yaml
      s3-compatible.yaml
      generic-env.yaml

  providers/
    takosumi/

  editions/
    takosumi/
    operator/

  examples/
    cloudflare-worker-real/
    aws-static-site/
    hcloud-server/
    s3-compatible-state/
```

This is the target architecture, not a requirement to rename all existing
directories in one change.

OSS repo must not contain:

```text
cloudflare-compat-gateway
cloudflare-wfp-backend
r2-pool
cloudrun-backend
lambda-backend
managed-edge
managed-storage
managed-container
official-billing
official-quota
official-abuse
official resource pools
```

### 15.2 Closed Cloud repository

Target shape:

```text
takosumi-cloud/
  hosting/
    deployment/
    official-config/
    cloud-admin/

  gateway/
    cloudflare-compat/
    s3-gateway/

  managed/
    edge-worker/
    object-storage/
    app-database/
    kv/
    queue/
    container/

  backends/
    cloudflare-wfp/
    r2-pool/
    d1/
    cloudrun/
    lambda/
    official-routing/

  commercial/
    billing/
    quota/
    usage-metering/
    abuse/
    support/
    admin/

  integrations/
    payments/
    email/
    metrics/
```

Takosumi Cloud imports or vendors the OSS engine and adds closed official
hosting and Cloud-only features.

## 16. Edition Configuration

Takosumi:

```yaml
edition: takosumi

features:
  opentofu_runs: true
  provider_connections: true
  credential_recipes: true
  env_injection: true
  state: true
  secrets: true
  audit: true
  outputs: true
  local_runner: true
  remote_runner: true
  multi_tenant: false

cloud_features:
  cloudflare_compat: false
  managed_edge: false
  managed_storage: false
  managed_container: false
  billing: false
```

Takosumi for Operators:

```yaml
edition: operator

features:
  opentofu_runs: true
  provider_connections: true
  credential_recipes: true
  env_injection: true
  state: true
  secrets: true
  audit: true
  outputs: true
  runner_pool: true
  multi_tenant: true
  admin_console: true
  basic_quota: true

cloud_features:
  cloudflare_compat: false
  managed_edge: false
  managed_storage: false
  managed_container: false
  official_billing: false
```

Takosumi Cloud:

```yaml
edition: cloud
base: operator

operator:
  id: takosumi-cloud
  official: true

features:
  opentofu_runs: true
  provider_connections: true
  credential_recipes: true
  env_injection: true
  state: true
  secrets: true
  audit: true
  outputs: true
  hosted_runner_pool: true
  multi_tenant: true
  admin_console: true

cloud_features:
  cloudflare_compat: true
  managed_edge: true
  managed_storage: true
  managed_app_database: true
  managed_kv: true
  managed_queue: true
  managed_container: true
  billing: true
  quota: true
  usage_metering: true
  support_admin: true
```

## 17. MVP Roadmap

### MVP 1: OSS Core

Build first:

```text
Git URL registration
Project/Capsule creation
OpenTofu init/plan/apply/destroy
Provider Connection
Credential Recipe
Env/file injection
Secret storage
State storage
Run history
Log streaming
Output capture
local runner
minimal Web UI
minimal CLI
```

First recipes:

```text
Cloudflare API Token
AWS static keys
AWS AssumeRole
GCP service account JSON
Hetzner
S3-compatible
Generic env
```

First demo:

```text
Register a Git URL containing a Cloudflare Worker manifest.
Create a Cloudflare API token connection.
Run plan/apply.
Takosumi injects CLOUDFLARE_API_TOKEN at run time.
OpenTofu deploys through the normal cloudflare/cloudflare provider.
Takosumi stores logs, state, outputs, and run history.
```

### MVP 2: UI/UX

```text
Connection creation UI
Project/Capsule creation UI
Plan result view
Apply approval
Run history
State versions
Outputs list
Secrets management
Logs
Settings
```

### MVP 3: Operator Mode

```text
multi-tenant
organization/workspace
users/teams/roles
runner pool
admin console
basic quota
workspace isolation
audit
```

This completes the OSS operator story.

### MVP 4: Takosumi Cloud Base

```text
official hosted deployment
account signup/login
hosted runner pool
official state backend
official secret backend
billing foundation
usage metering foundation
support/admin
cloud config
```

Cloudflare compatibility is not required for the first hosted launch.

### MVP 5: Cloudflare Compatibility Gateway

Cloud-only:

```text
/compat/cloudflare/client/v4
Cloudflare provider base_url support
virtual account ID
virtual zone/resource IDs
cloudflare_workers_script
cloudflare_workers_route
cloudflare_workers_kv_namespace
cloudflare_r2_bucket
cloudflare_d1_database
worker vars/secrets/bindings
Workers for Platforms backend
compatibility report
```

### MVP 6: Cloud Managed Resources

Cloud-only:

```text
Takosumi Edge Worker
Takosumi Object Storage
Takosumi App Database
Takosumi KV
Takosumi Queue
Takosumi Cloud Container
Cloud UI
usage/quota/billing integration
```

## 18. Development Phases

### Phase 0: Freeze Spec

```text
freeze terminology
freeze editions
freeze OSS/Cloud boundary
freeze data model
freeze Provider Connection spec
freeze Credential Recipe spec
```

Required docs:

```text
docs/final-plan.md
docs/architecture.md
docs/editions.md
docs/provider-connections.md
docs/runs.md
docs/state.md
```

### Phase 1: Core Model

```text
Workspace
Project
Capsule
Run
Plan
Apply
Destroy
ProviderConnection
ProviderBinding
Secret
StateVersion
Output
AuditEvent
```

### Phase 2: Runner

```text
source checkout
OpenTofu install/version selection
tofu init
tofu validate
tofu plan
tofu apply
tofu destroy
log streaming
artifact upload
state capture
output capture
env/file injection
secret cleanup
```

### Phase 3: Provider Connection / Credential Recipe

```text
Cloudflare recipe
AWS recipe
GCP recipe
Hetzner recipe
S3-compatible recipe
Generic env recipe
connection API
connection UI
secret encryption
run-time env injection
```

### Phase 4: State / Secret / Audit

```text
state backend
state lock
state versioning
state diff
state rollback
state backup
secret encryption
secret redaction
audit event
```

### Phase 5: Web UI / CLI

Web UI:

```text
Projects
Capsules
Connections
Runs
Plan result
Apply approval
State versions
Outputs
Secrets
Logs
Settings
```

CLI:

```bash
takosumi login
takosumi project create
takosumi connection create
takosumi capsule create
takosumi plan
takosumi apply
takosumi destroy
takosumi runs logs
```

### Phase 6: Operator Edition

```text
Organizations
Workspaces
Teams
Roles
Runner pool
Admin console
Basic quota
Workspace isolation
```

### Phase 7: Takosumi Cloud Hosting

```text
official deployment
hosted runners
official state backend
official secret backend
account system
billing foundation
usage metering foundation
admin/support
```

### Phase 8: Cloudflare Compatibility Gateway

```text
Cloudflare provider base_url support
virtual account/zone/resource IDs
Workers script endpoint
Routes endpoint
KV endpoint
R2 endpoint
D1 endpoint
read/update/delete/refresh support
compatibility report
```

### Phase 9: Managed Cloud Resources

```text
Takosumi Edge Worker
Takosumi Object Storage
Takosumi App DB
Takosumi KV
Takosumi Queue
Takosumi Cloud Container
```

## 19. Minimum Database

OSS:

```sql
users
organizations
workspaces
projects
capsules
sources
provider_connections
provider_bindings
secrets
runs
run_logs
state_versions
outputs
runners
audit_events
```

Cloud-only:

```sql
cloud_managed_connections
cloud_compat_resources
cloud_usage_records
billing_accounts
quotas
managed_edge_workers
managed_object_buckets
managed_containers
```

## 20. Minimum API

OSS:

```text
POST   /projects
GET    /projects/:id

POST   /capsules
GET    /capsules/:id
PATCH  /capsules/:id

POST   /connections
GET    /connections
GET    /connections/:id
DELETE /connections/:id

POST   /runs
GET    /runs/:id
GET    /runs/:id/logs
POST   /runs/:id/approve
POST   /runs/:id/cancel

GET    /state/:capsule_id/versions
GET    /outputs/:capsule_id

POST   /secrets
GET    /audit
```

Cloud-only:

```text
/compat/cloudflare/client/v4/...
/cloud/managed/edge-workers
/cloud/managed/storage
/cloud/usage
/cloud/billing
```

Cloud-only APIs must not be exposed as OSS product APIs.

## 21. Security Requirements

Common:

```text
secrets are encrypted at rest
secrets are injected only into temporary runner environments
secret values are redacted from logs
each run uses a temporary workspace
temporary credential files are deleted after run completion
provider plugin cache is isolated
state is isolated by workspace/project/capsule
apply approval is supported
destroy protection is supported
audit log is required
raw temporary credentials are not persisted
```

Operator and Cloud:

```text
tenant isolation
runner pool isolation
workspace quota
network egress policy
admin audit
usage metering
abuse controls
```

## 22. External Explanation

Takosumi:

```text
Takosumi is an open-source OpenTofu/Terraform control plane.
It runs your existing providers and modules as-is, with automatic credential
injection, state management, secrets, outputs, and run history.
```

Japanese:

```text
Takosumi は、既存の OpenTofu/Terraform provider と module をそのまま実行する
OSS control plane です。credential/env 自動注入、state 管理、secret 管理、
outputs、run 履歴を提供します。
```

Takosumi for Operators:

```text
Takosumi for Operators is the open-source operator edition for organizations
that want to host Takosumi for their own users.
```

Japanese:

```text
Takosumi for Operators は、組織や事業者が自分のユーザー向けに Takosumi を
運営するための OSS Operator Edition です。
```

Takosumi Cloud:

```text
Takosumi Cloud is the official hosted Takosumi for Operators, operated by us,
with additional cloud-only compatibility gateways and managed resources.
```

Japanese:

```text
Takosumi Cloud は、私たちが運営する公式ホスティング版 Takosumi for Operators
です。Cloud 専用の Compatibility Gateway と Managed Resources を追加で提供します。
```

## 23. Completion Criteria

Takosumi OSS is complete enough for v1 when:

```text
existing OpenTofu/Terraform modules can be run from Git URL
Provider Connections can inject credentials without repo-side secrets
OpenTofu init/plan/apply/destroy work through local/docker/remote runners
state, outputs, logs, and run history are durable
secrets are encrypted and redacted
basic Web UI and CLI cover the core workflow
the OSS repo contains no compatibility gateway or managed resource backend
```

Takosumi for Operators is complete enough when:

```text
multi-tenant workspace/team isolation exists
runner pools are manageable
operator admin and audit surfaces exist
basic quota exists
workspace state/secrets/runs are isolated
```

Takosumi Cloud is complete enough for hosted launch when:

```text
official hosting runs the operator edition
hosted runners are available
account/signup/login works
official state and secret backends exist
billing/usage foundations exist
support/admin operations exist
```

Cloudflare Compatibility Gateway is complete enough only when each supported
resource has:

```text
request validation
provider response-shape compatibility
virtual resource mapping
list/read filtering
create/update/delete/refresh behavior
quota
billing/usage accounting
audit
destroy/deprovision proof
```

## 24. Final Fixed Policy

```text
1. Use the Terraform/OpenTofu ecosystem as-is.
2. OSS is only the control plane that runs existing providers.
3. Provider Connection and credential/env injection are the central OSS value.
4. Same manifest, different connection is the product promise.
5. Compatibility gateways and managed resources are Takosumi Cloud-only.
6. Takosumi Cloud is the closed official hosted Takosumi for Operators.
7. Everything outside Takosumi Cloud is OSS.
```

One-sentence summary:

```text
Takosumi OSS runs existing Terraform/OpenTofu providers as-is.
Takosumi Cloud is the official hosted service that adds closed compatibility
gateways and managed cloud resources.
```
