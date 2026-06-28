# Takosumi Core Spec

Last updated: 2026-06-28

This document is the current OSS core specification and describes the live model.
Product direction is fixed by [Takosumi Final Plan](./final-plan.md).

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

| Layer                  | License / operation     | Scope                                   |
| ---------------------- | ----------------------- | --------------------------------------- |
| Takosumi Core          | OSS                     | Shared execution engine                 |
| Takosumi               | OSS self-host           | Personal / small-team self-host product |
| Takosumi for Operators | OSS self-host           | Multi-tenant operator edition           |
| Takosumi Cloud         | Closed official service | Hosted Operators + Cloud-only features  |

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

| Concept            | Meaning                                                                    |
| ------------------ | -------------------------------------------------------------------------- |
| Workspace          | User/team isolation boundary for projects, secrets, state, runs, and audit |
| Project            | One service, product, or infrastructure group                              |
| Capsule            | One OpenTofu/Terraform module execution unit                               |
| Source             | Git URL/ref/commit/path for a plain OpenTofu/Terraform module              |
| ProviderConnection | Stored provider credential configuration                                   |
| CredentialRecipe   | How to materialize a provider credential as env/file/pre-run output        |
| ProviderBinding    | Mapping from provider name/alias to ProviderConnection                     |
| Secret             | Encrypted material referenced by ProviderConnection or Capsule inputs      |
| Run                | One init/validate/plan/apply/destroy/refresh/output action                 |
| StateVersion       | Stored state generation for a Capsule                                      |
| Output             | Captured OpenTofu output value                                             |
| Runner             | Local/docker/remote/operator/cloud execution worker                        |
| AuditEvent         | Actor/action/target/result evidence                                        |

Upload/prepared-source snapshots are internal/operator compatibility only; they are not a public Source kind and do not create new public Capsules.

This is the live public model. The retired `Space` / `Installation` /
`StateSnapshot` / `OutputSnapshot` / `ProviderEnv` / `Deployment` /
Provider Catalog names from the previous architecture have been renamed to this
model across contract, core, runner, dashboard, and storage (with non-destructive
rename-aside migrations on both storage engines). Docs and UI use Workspace,
Project, Capsule, ProviderConnection, ProviderBinding, CredentialRecipe, Run,
StateVersion, Output, and AuditEvent. A few internal helpers (such as the
`SourceSnapshot` archive type and `InstallConfig` service-side config record)
keep descriptive names that are not public product nouns.

## Git Source And Run Input Model

Takosumi's standard path is deliberately simple: run the OpenTofu/Terraform
module that lives in Git.

```text
Git URL + ref/tag/commit + module path
  -> checkout
  -> tofu init
  -> tofu plan
  -> tofu apply
```

The runner may persist an immutable `SourceSnapshot` archive for reproducible
plan/apply, but that snapshot is a copy of the Git module bytes selected by the
source ref. Legacy upload/prepared-source archive paths can still exist for
operator tooling and stored compatibility rows; they are not the product model
for installing apps.
For webhook or scheduled source polling, the runner still resolves the ref with
Git. If the resolved commit matches an existing SourceSnapshot for the same
Source/ref/path, Takosumi reuses the existing archive object rather than
cloning, archiving, and storing duplicate bytes.
`Source.autoSync` is the public opt-in for scheduled Git-ref polling. It only
prepares a newer immutable SourceSnapshot; it does not apply changes by itself.
Updates still go through the normal Plan / Apply approval boundary.

Takosumi does not fetch, build, or interpret deployable application artifacts.
If an OpenTofu module needs an image reference, version, release tag, object key,
or any other app-specific value, it declares a normal Terraform variable and the
install/deploy request passes that value through `variableMapping` / `vars`.
Takosumi does not reserve those variable names or assign semantics to them.

Legacy `build` / `prebuiltArtifact` fields remain compatibility-only for stored
pre-v1 / first-party row readability and are not the final public Capsule
contract. New generated-root dispatch does not run them or pass them to the
runner.

## Performance Model

Takosumi should feel closer to an app install flow than a visible CI console,
without leaving the OpenTofu-native model:

```text
Git ref resolution -> SourceSnapshot reuse -> provider init -> plan -> apply
```

The allowed performance mechanisms are:

- Reuse immutable SourceSnapshot archive bytes when the same Source/ref/path
  resolves to the same commit.
- Bake a filesystem provider mirror into the runner image for first-party and
  operator-approved providers, and record provider installation evidence.
- Use an operator-configured OpenTofu provider plugin cache inside the runner
  container for direct provider installs. The cache stores provider binaries
  only; provider credentials and generated files remain per-run and are deleted
  after the run. `tofu init` is serialized per shared cache path to avoid cache
  corruption while keeping plan/apply execution parallel.
- Keep app/container/bundle build optimization in the app repository, release
  pipeline, registry, or OpenTofu module. A module may accept a URL, digest,
  image tag, or object key as a normal variable, and may verify it with ordinary
  provider/data-source logic, but Takosumi does not decide what that artifact
  means.

UI progress should show user-level phases such as preparing, checking access,
planning, installing, finishing, and ready. OpenTofu logs, plan JSON, provider
bindings, state, and audit evidence remain available in details/advanced views.

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

  snowflake-main:
    provider: registry.opentofu.org/snowflake-labs/snowflake
    auth_type: env
    secrets:
      SNOWFLAKE_PASSWORD: sec_snowflake_password
    values:
      SNOWFLAKE_ACCOUNT: example
      SNOWFLAKE_USER: takosumi_runner
```

Secrets are never written to Capsule source, generated `.tfvars`, state
metadata, logs, or audit messages. They are decrypted only for the run sandbox.
For a declared-env provider recipe, the declared names are injected into the
runner process under the same names, such as `SNOWFLAKE_PASSWORD`. This path is
available for any OpenTofu/Terraform provider, including providers that also
have guided CredentialRecipes.
Runner/runtime-reserved names such as `PATH`, `TAKOSUMI_*`, `OPENTOFU_*`, and
`TF_*` are rejected for declared-env recipes.

## Credential Recipes

A CredentialRecipe defines how a provider credential becomes temporary runtime
material.

Built-in recipe files are stored under `recipes/providers/*.yaml`. The
dependency-free runner projection is `contract/provider-env-rules.ts`; tests
must keep the YAML catalog, provider runtime registry, and runner/vault
projection in sync.

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

Built-in CredentialRecipes are validation and guided-setup helpers, not the
global provider boundary. Any provider can run through an explicit declared-env
recipe when the runner profile and egress policy allow it:

```yaml
id: declared-env
terraform_source: registry.opentofu.org/snowflake-labs/snowflake
env:
  SNOWFLAKE_ACCOUNT:
    from_value: account
  SNOWFLAKE_USER:
    from_value: user
  SNOWFLAKE_PASSWORD:
    from_secret: password
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
record run evidence
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

## Post-Apply Release Commands

OpenTofu apply is not the same thing as an application being ready. A Capsule may
declare generic post-apply release commands in the neutral `takosumi_release`
output; Takosumi core treats those commands as opaque argv arrays and never adds
DB-specific, Worker-specific, or provider-specific activation code.

```hcl
output "takosumi_release" {
  value = {
    post_apply = [
      {
        id       = "activate"
        executor = "runner"
        command  = ["bun", "run", "app:activate"]
      }
    ]
  }
}
```

When a host wires a ReleaseActivator, Takosumi passes the commands with the
apply/deployment/output references and non-sensitive outputs. The built-in
runner activator runs `executor = "runner"` argv commands in the restored source
snapshot and injects only non-secret metadata such as `TAKOSUMI_OUTPUTS_JSON`,
`TAKOSUMI_RELEASE_CONTEXT_JSON`, `TAKOSUMI_RELEASE_RUN_ID`,
`TAKOSUMI_APPLY_RUN_ID`, `TAKOSUMI_CAPSULE_ID`, and
`TAKOSUMI_STATE_VERSION_ID`. `TAKOSUMI_RELEASE_CONTEXT_JSON` is a generic
`takosumi.release-context@v1` object with release/apply/deployment ids and the
same non-sensitive outputs; it is not a provider-specific or DB-specific
contract. Provider credentials
are not injected into arbitrary post-apply source commands; provider-owned
artifact publishing should declare `executor = "operator"` and be handled by an
operator/Cloud activator or another explicit credential boundary. If no operator
activator is configured, such commands remain `release_activation.pending`
instead of being attempted inside the credential-free runner sandbox.

`post_apply.env` is limited to non-sensitive knobs. DB URLs, DSNs, connection
strings, API tokens, provider credentials, session tokens, and passwords must
not be declared through the OpenTofu output. App bootstrap and publication work
remain ordinary argv commands, but their authority comes from the command's own
runtime context or from an explicit operator/Cloud secret boundary, not from
secrets stored inside OpenTofu state.

Operator release activators may opt in to forwarding selected operator-owned
environment variables to `executor = "operator"` commands with an explicit
operator-side allowlist. That allowlist is not part of the Capsule output
contract and does not make Takosumi understand databases, Workers, queues, or
other app resources; the command remains an opaque argv.

When no activator is configured, the OpenTofu apply can still succeed, but
Takosumi records `release_activation.pending` instead of silently implying that
post-apply commands, app publication, or app initialization ran.

## Security

OSS and Cloud share these invariants:

```text
secrets are encrypted at rest
provider credentials are injected only into the run sandbox
logs are redacted before persistence
runs use a temporary workspace
temporary credential files are removed after the run
provider plugin cache stores provider binaries only and is isolated/serialized by policy
state is isolated per Workspace/Capsule
apply approval is supported
destroy protection is supported
audit log is required
```

Operator / Cloud deployments additionally require tenant isolation, runner pool
isolation, quota, network egress policy, admin audit, and usage metering.

## Cloud-Only Boundary

Compatibility Gateway and managed resources are not part of OSS Takosumi. They
live only in the closed `takosumi-cloud` package, which composes on top of OSS
through an additive route proxy and the billing/quota ports (one-way Cloud->OSS).

The following belong only to closed Takosumi Cloud:

```text
Cloudflare Compatibility Gateway
Takosumi AI Gateway
Takosumi Managed Edge Worker
Takosumi Object Storage
Takosumi App Database
Takosumi KV
Takosumi Queue
Takosumi Cloud Container
official (enforced) billing/quota/usage/support
official resource pools
```

OSS code must not expose provider-compatible Gateway endpoints, default Gateway
runner profiles, run-key minting, managed resource backends, or enforced billing
gates. OSS billing is `disabled` or `showback` only; it estimates and records
without ever blocking apply.

## MVP Order

1. Build OSS Core model: Workspace, Project, Capsule, Source, Run,
   ProviderConnection, ProviderBinding, Secret, StateVersion, Output, Audit.
2. Build runner: checkout, OpenTofu install/version selection, init, validate,
   plan, apply, destroy, log streaming, state capture, output capture, cleanup.
3. Build built-in Credential Recipes for Cloudflare, AWS, GCP, S3-compatible,
   plus declared-env recipes for arbitrary OpenTofu providers.
4. Build state, output-to-input wiring, audit, and secret redaction.
5. Build Web UI and CLI for projects, capsules, connections, runs, plans,
   applies, state, outputs, and logs.
6. Add Takosumi for Operators multi-tenancy, teams, runner pools, admin, and
   quota.
7. Build Takosumi Cloud as closed official hosting.
8. Add Cloudflare Compatibility Gateway and managed resources only in the closed
   Cloud implementation.
