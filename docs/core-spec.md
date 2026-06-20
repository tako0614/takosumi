# Takosumi Core Spec

Last updated: 2026-06-19

This document is the current OSS core specification. Product direction is fixed
by [Takosumi Final Plan](./final-plan.md).

## Definition

Takosumi OSS is an OpenTofu/Terraform control plane that runs the existing
provider ecosystem as-is.

Takosumi Cloud is the closed official hosted service based on Takosumi for
Operators, with cloud-only compatibility gateways and managed resources.

The invariant is:

```text
OSS runs existing providers.
Only Cloud has compatibility gateways and managed resources.
```

## Product Layers

| Layer | License / operation | Scope |
| --- | --- | --- |
| Takosumi Core | OSS | Shared execution engine |
| Takosumi | OSS self-host | Personal / small-team self-host product |
| Takosumi for Operators | OSS self-host | Multi-tenant operator edition |
| Takosumi Cloud | Closed official service | Hosted Operators + Cloud-only features |

## OSS Core Responsibilities

Takosumi Core owns:

```text
Workspace / Project / Capsule model
Source snapshotting
OpenTofu/Terraform init / validate / plan / apply / destroy
Provider Connection
Credential Recipe
Provider Binding
run-scoped env/file injection
StateVersion storage and locking
Secret storage
Run ledger
Run logs
Output capture
Output-to-input wiring
AuditEvent ledger
Runner protocol
policy and approval hooks
```

Takosumi Core does not own:

```text
Cloudflare Compatibility Gateway
AWS/GCP compatibility API
S3 gateway
managed edge/storage/container resource backend
official billing implementation
official resource pools
closed Takosumi Cloud operator modules
```

## Public Model

| Concept | Meaning |
| --- | --- |
| Workspace | User/team isolation boundary for projects, secrets, state, runs, and audit |
| Project | One service, product, or infrastructure group |
| Capsule | One OpenTofu/Terraform module execution unit |
| Source | Git URL/ref/commit/path, tarball, template, or local upload |
| ProviderConnection | Stored provider credential configuration |
| CredentialRecipe | How to materialize a provider credential as env/file/pre-run output |
| ProviderBinding | Mapping from provider name/alias to ProviderConnection |
| Secret | Encrypted material referenced by ProviderConnection or Capsule inputs |
| Run | One init/validate/plan/apply/destroy/refresh/output action |
| StateVersion | Stored state generation for a Capsule |
| Output | Captured OpenTofu output value |
| Runner | Local/docker/remote/operator/cloud execution worker |
| AuditEvent | Actor/action/target/result evidence |

Existing internal names such as `Space`, `Installation`, and `ProviderEnv` are
legacy implementation names while the codebase is being migrated. New public
docs and UI should use Workspace, Project, Capsule, ProviderConnection,
ProviderBinding, CredentialRecipe, Run, StateVersion, Output, and AuditEvent.

## Provider Connections

A ProviderConnection stores credential material or a reference to credential
material for a real OpenTofu/Terraform provider.

Examples:

```yaml
connections:
  cloudflare-main:
    provider: cloudflare
    auth_type: api_token
    secrets:
      api_token: sec_cloudflare_token
    values:
      account_id: xxxxx

  aws-prod:
    provider: aws
    auth_type: assume_role
    values:
      role_arn: arn:aws:iam::123456789012:role/takosumi
      region: ap-northeast-1

  generic-env:
    provider: generic-env
    auth_type: env
    secrets:
      CUSTOM_API_TOKEN: sec_custom_token
    values:
      CUSTOM_ENDPOINT: https://api.example.com
```

Secrets are never written to Capsule source, generated `.tfvars`, state
metadata, logs, or audit messages. They are decrypted only for the run sandbox.

## Credential Recipes

A CredentialRecipe defines how a provider credential becomes temporary runtime
material.

Cloudflare example:

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

AWS example:

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

GCP example:

```yaml
id: google
terraform_source:
  - hashicorp/google
  - hashicorp/google-beta
auth_modes:
  service_account_json:
    files:
      /run/takosumi/google.json:
        from_secret: service_account_json
    env:
      GOOGLE_APPLICATION_CREDENTIALS:
        value: /run/takosumi/google.json
      GOOGLE_PROJECT:
        from_value: project_id
```

Generic env is required so unsupported providers can still run:

```yaml
id: generic-env
env:
  CUSTOM_API_TOKEN:
    from_secret: token
  CUSTOM_ENDPOINT:
    from_value: endpoint
```

## Provider Binding

ProviderBinding maps a provider address/name and optional alias to a
ProviderConnection.

```yaml
provider_bindings:
  cloudflare.default:
    connection: cloudflare-main
  aws.tokyo:
    connection: aws-tokyo
  aws.virginia:
    connection: aws-virginia
```

This is the "Same manifest, different connection" model.

## Run Environment

At run time:

```text
ProviderConnection
  -> CredentialRecipe
  -> temporary env/file material
  -> runner sandbox
  -> OpenTofu/Terraform provider
```

The runner must:

```text
checkout source
materialize generated root if needed
install provider plugins
run tofu init/validate/plan/apply/destroy
stream redacted logs
capture state
capture outputs
upload artifacts
delete temporary credential files
```

## State

Takosumi OSS provides state storage, state lock, state versioning, rollback,
diff, and backup hooks.

Initial supported backends:

```text
Postgres
local filesystem
S3-compatible backup
```

Cloud may provide an official managed state backend, but that backend is not an
OSS compatibility gateway.

## Outputs

OpenTofu outputs are saved as Capsule outputs and can be wired into another
Capsule's inputs.

```yaml
inputs:
  home_domain:
    from_output:
      capsule: home-core
      name: home_domain
```

Sensitive outputs remain encrypted and are not projected into public views.

## Security

OSS and Cloud share these invariants:

```text
secrets are encrypted at rest
provider credentials are injected only into the run sandbox
logs are redacted before persistence
runs use a temporary workspace
temporary credential files are removed after the run
provider plugin cache is isolated by policy
state is isolated per Workspace/Capsule
apply approval is supported
destroy protection is supported
audit log is required
```

Operator / Cloud deployments additionally require tenant isolation, runner pool
isolation, quota, network egress policy, admin audit, and usage metering.

## Cloud-Only Boundary

Compatibility Gateway and managed resources are not part of OSS Takosumi.

The following belong only to closed Takosumi Cloud:

```text
Cloudflare Compatibility Gateway
Takosumi Managed Edge Worker
Takosumi Object Storage
Takosumi App Database
Takosumi KV
Takosumi Queue
Takosumi Cloud Container
official billing/quota/usage/support
official resource pools
```

OSS code must not expose provider-compatible Gateway endpoints, default Gateway
runner profiles, run-key minting, or managed resource backends.

## MVP Order

1. Build OSS Core model: Workspace, Project, Capsule, Source, Run,
   ProviderConnection, ProviderBinding, Secret, StateVersion, Output, Audit.
2. Build runner: checkout, OpenTofu install/version selection, init, validate,
   plan, apply, destroy, log streaming, state capture, output capture, cleanup.
3. Build Credential Recipes for Cloudflare, AWS, GCP, S3-compatible, and
   generic env.
4. Build state, output-to-input wiring, audit, and secret redaction.
5. Build Web UI and CLI for projects, capsules, connections, runs, plans,
   applies, state, outputs, and logs.
6. Add Takosumi for Operators multi-tenancy, teams, runner pools, admin, and
   quota.
7. Build Takosumi Cloud as closed official hosting.
8. Add Cloudflare Compatibility Gateway and managed resources only in the closed
   Cloud implementation.
