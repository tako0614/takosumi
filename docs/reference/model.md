# Model Reference

Last updated: 2026-06-29

Takosumi OSS has two public flows: run plain OpenTofu from Git, and resolve
Takosumi Resource Shapes through TargetPools, policy, and Adapters. Compatibility
APIs are additional capability-scoped surfaces alongside those flows. They are
peer entrypoints, not provider-internal routes inside `takosumi/takosumi` or
subordinate Resource Shape APIs.

## OpenTofu Stack Concepts

| Concept            | Meaning                                                                    |
| ------------------ | -------------------------------------------------------------------------- |
| Workspace          | User/team isolation boundary for projects, state, secrets, runs, and audit |
| Project            | One product, service, or infrastructure group                              |
| Capsule            | One OpenTofu/Terraform module execution unit                               |
| Source             | Git URL/ref/commit/path for a plain OpenTofu/Terraform module              |
| ProviderConnection | Stored provider credential configuration                                   |
| CredentialRecipe   | Provider-specific env/file/pre-run materialization recipe                  |
| ProviderBinding    | Provider name/alias to ProviderConnection mapping                          |
| Secret             | Encrypted credential or input material                                     |
| Run                | One init/validate/plan/apply/destroy/refresh/output action                 |
| StateVersion       | Stored state generation for a Capsule                                      |
| Output             | Captured OpenTofu output value                                             |
| Runner             | Local/docker/remote/operator/cloud execution worker                        |
| AuditEvent         | Actor/action/target/result evidence                                        |

## Resource Shape Concepts

| Concept        | Meaning                                                                   |
| -------------- | ------------------------------------------------------------------------- |
| Space          | Resource API namespace and policy scope                                   |
| Environment    | Deployment environment inside a Space                                     |
| Stack          | A group of Resource Shape objects and operations                          |
| Resource       | Desired service-form resource, such as EdgeWorker, ObjectBucket, or Queue |
| Target         | Concrete implementation destination, such as AWS, Cloudflare, Kubernetes  |
| TargetPool     | Operator-controlled set of available Targets and capabilities             |
| Credential     | Runtime authority used by a Target or Adapter                             |
| Policy         | Rules for placement, cost, region, action, network, and access            |
| Adapter        | Implementation bridge that can preview, apply, observe, and delete        |
| ResolutionLock | Recorded resolver decision for a Resource                                 |
| NativeResource | Concrete provider/platform resource created by an Adapter                 |
| Condition      | Status and readiness evidence                                             |

`Space` here is the Resource API namespace and policy scope.

## OpenTofu Provider Resolution

Upload/prepared-source snapshots are internal/operator compatibility only; they
are not a public Source kind and do not create new public Capsules.

`Source.autoSync` enables scheduled Git-ref polling. It prepares newer immutable
SourceSnapshots when the ref moves. If the resolved commit differs from the
SourceSnapshot currently applied by an active Capsule, Takosumi marks that
Capsule `stale` so the normal Workspace update / RunGroup path can create a
reviewable update plan. It still does not silently apply changes: every
infrastructure update goes through Plan / Apply as a Run unless an explicit
operator policy adds a separate auto-apply gate.

手動更新は `manual_plan` intent の SourceSyncRun を使い、その Run が生成した
exact SourceSnapshot を plan に固定します。この intent の sync は Capsule を
`stale` にできますが、同時に別の auto-update plan/apply を開始しません。

Provider resolution has two OSS outcomes:

```text
resolved_provider_connection
blocked_missing_connection
blocked_policy
```

Resolution evidence never includes secret values. Public API, UI, and docs use
ProviderConnection and ProviderBinding.

## Same Manifest, Different Connection

The core deployment model is:

```text
same .tf
different ProviderBinding
different ProviderConnection
```

Example:

```yaml
provider_bindings:
  cloudflare.default:
    connection: cloudflare-prod
  aws.tokyo:
    connection: aws-prod-tokyo
```

Takosumi injects the runtime env/files required by the selected
ProviderConnection. The manifest should not contain secrets.

Built-in Credential Recipes are guided setup shortcuts, not the provider
boundary. Any provider can use a generic-env ProviderConnection when the user
declares the provider source from `required_providers` and the explicit
environment variables documented by that provider. Those declared env names
must be upper-snake environment identifiers such as `SNOWFLAKE_PASSWORD`; they
become the run-local CredentialRecipe, subject to runner policy, provider plugin
policy, and egress policy. Runner/runtime-reserved env names are rejected.

Using your own key is not gated by Takosumi. There is no provider allowlist and
no operator approval: if you supply the credential, any OpenTofu/Terraform
provider runs. A self-hosted Takosumi enables the wildcard runner surface by
default, and the control plane auto-selects a runner profile that admits the
Capsule's providers, so an arbitrary provider runs without naming a profile.
A ProviderConnection you supply with your own key is never metered or billed by
Takosumi software. Self-host and OSS operator endpoints may record showback
usage, but they do not enforce Takosumi Cloud payment. Takosumi Cloud bills
only Takosumi-provided managed resources; its customer-facing contract lives in
[Takosumi Cloud pricing](https://app.takosumi.com/docs/pricing).

## Runner Policy

Runner policy, provider allowlists, lockfile/mirror rules, resource limits, and
network egress policy are internal control-plane safeguards. They decide where a
Run may execute and which provider plugins/resources may be reached, but they
are not public product nouns like ProviderConnection or ProviderBinding.
Operators may configure a runner-local OpenTofu provider plugin cache to speed
direct provider installs. It stores provider binaries only; credentials and
generated run files remain per-run. On Cloudflare Containers, the current
runner Durable Object id is run-scoped, so this cache is only reused while that
single runner instance is alive; SourceSnapshot reuse and provider mirrors are
the portable speed mechanisms.

The user-facing flow should feel like installing an app, but the model remains
Git-native and OpenTofu-native. Creating a new service uses the same guided
install flow as adding an app: choose a template or install link, configure the
smallest visible inputs, review the plan, then deploy. Takosumi should not add a
separate low-level "create service" CRUD surface for ordinary users; the full
service list can expose details after creation, while the add path stays
install-like.

The Store is only discovery and presentation. A Store node announces a Git
repository/path, icon, description, and visible setup fields. It is not a
release authority: branch, tag, commit, SourceSnapshot, and update policy stay
in the Source / Run flow. Switching Store nodes changes the read source for
listings and presentation metadata, not the Capsule execution model.

Repositories may provide `.well-known/tcs.json` for Store indexers. This file is
optional presentation metadata, not a Takosumi manifest. Direct Git install
works without it. The file may describe `modulePath`, icon, visible inputs,
`installExperience`, and output display hints, but it must not own `git`,
`source`, `ref`, `commit`, `resolvedCommit`, or `installConfigId`.

Git source sync records a bounded observation of this repository-root document
on the immutable `SourceSnapshot`, separately from the selected OpenTofu module
archive. This keeps a nested `modulePath` from hiding or drifting the setup and
OIDC contract. A snapshot created without that observation is not reused by a
new sync; Store-backed planning fails closed instead of continuing with stale
presentation metadata.

`installExperience` の `oidc_client` projection は、public OIDC client metadata
(issuer、client id、redirect URI) に加えて必要な OAuth scope を宣言できます。
`openid` は必須で、scope は重複のない non-empty token に限ります。client secret、access
token、refresh token は repository metadata、OpenTofu variables、state、Output に投影しません。

Takosumi can reuse SourceSnapshots, provider mirrors, provider plugin caches,
runner capacity controls, package caches, and clear progress phases. The default
fast path is a Git CI/release artifact consumed and SHA-256-verified by the
repository's OpenTofu module. A Capsule can instead opt into `sourceBuild` with
explicit argv commands and expected relative outputs. That phase receives no
provider credentials and cannot select or create infrastructure; the Git module
still owns the OpenTofu plan.

`sourceBuild` is service-side Capsule configuration, not Store metadata and not
an executable field in `.well-known/tcs.json`. Takosumi does not infer commands
from `package.json`, and it does not silently fall back from a missing release
artifact to a build. Expensive OCI/container image builds should remain in the
app repository's CI and registry.

Release/update automation is Git-native: a Source tracks a branch, tag, or
commit ref; source sync resolves that ref to an immutable commit and archive; a
Capsule that is active on an older commit becomes `stale`; Workspace update
plans the change. If the module consumes a prebuilt container/image/bundle, it
does so through ordinary OpenTofu variables, providers, or data sources. An
explicit source build runs against that same pinned snapshot before each
plan/apply/destroy materialization.

The reference runner keeps successful plan containers warm for
`TAKOSUMI_RUNNER_KEEPALIVE_SECONDS` seconds (default `0`; official Cloud uses
`120` so apply / destroy apply can return to the plan runner object while it is
warm) and shuts down non-plan runs after success plus all failed runs
immediately. Operators can also pass `TAKOSUMI_OPENTOFU_PLUGIN_CACHE_DIR`,
`TAKOSUMI_SOURCE_BUILD_CACHE_DIR`, `TAKOSUMI_SOURCE_ARCHIVE_ZSTD_LEVEL`, and runner capacity retry knobs as
non-secret speed settings. This is not a cross-run source-sync cache.

## Resource Shape Resolution

The Resource Shape flow starts from typed Resource objects and resolves them to
Targets. Those objects can be submitted through the Resource API,
`takosumi_*` provider resources, CLI, dashboard, or Kubernetes CRDs:

```text
Resource Shape
  -> TargetPool / Policy / Credential
  -> Adapter capability
  -> ResolutionLock
  -> NativeResource
```

Users normally describe the shape they want, not the backend. Operators decide
which Targets are available, which Adapters are enabled, and which policies
control placement. Resolver decisions are recorded as ResolutionLocks and do
not move without an explicit migration.

Resource Shapes are not a replacement for every existing provider or standard
surface. If an industry-standard protocol/API or adequate OpenTofu provider
already expresses the service cleanly, use that surface through the OpenTofu
Stack flow or a scoped compatibility profile. Compatibility profiles are peer
entrypoints for standard tools/protocols, not fallback routes into
`takosumi/takosumi`. S3-compatible object storage, OCI registry, Kubernetes
CRDs, CloudEvents, OpenAI-compatible APIs, and scoped Cloudflare
Workers-compatible import/deploy paths are examples of surfaces that should
remain standard-facing.

Add a Takosumi shape when the service form is durable, no adequate standard
surface exists, and Takosumi needs to own binding projection, resolution lock,
policy, metering, import path, or managed target placement.

The inverse is also scoped: when a standard surface does not exist, Takosumi
does not automatically create a catch-all provider. One-off gaps should stay in
generic-env ProviderConnections and normal OpenTofu modules. A new
`takosumi_*` resource is justified only for a repeated Takosumi-owned service
form that needs a typed schema, planner, adapter, import/drift/state behavior,
and capability evidence. A provider resource that does not map to either a
Takosumi-owned service form or an operator/admin object has no reason to exist.

This is not Takosumi-provider lock-in. If Takosumi defines a shape because no
adequate universal provider or standard protocol exists, and that surface later
appears, new designs should prefer the universal surface. The Takosumi shape can
remain for import continuity, migration, managed-target placement, policy, or
metering, but it is not mandatory.

Takos is a representative consumer of this rule. Takos should be described as
the composition of generic Resource Shapes it actually needs, not as a
product-specific catch-all shape:

```text
Takos distribution:
  EdgeWorker        -> takos-worker
  SQLDatabase       -> workspace/control database
  KVStore           -> session/cache/state binding
  ObjectBucket      -> files and workspace objects
  Queue             -> agent jobs and product events
  ContainerService  -> takos-git and takos-agent containers
```

Do not add `takosumi_takos` or an equivalent one-resource wrapper. If Takos
later needs a service form that these generic shapes cannot express, add the
missing service form only after the same prior-art gate passes.

Adapters report capabilities and perform preview/apply/observe/delete work.
Initial adapter families can include OpenTofu, Cloudflare, AWS, Kubernetes, VM,
and Takosumi-native adapters.

Extensible surfaces use capability tokens. For example, a
`ContainerService` target can publish an operator-defined implementation plugin
with custom interface evidence. The endpoint accepts or rejects those tokens
through resolver/policy, not through a hard-coded provider binary allow-list.
That extension is for backends of an existing typed shape. Adding a new
HCL-facing `takosumi_*` shape still requires a schema/API/provider release so
OpenTofu can keep typed validation, plan diffs, import, and state upgrade
behavior.

Provider capability documents may include operator-defined adapter tokens as
additional boolean keys under `adapters`. Known adapter keys remain
`opentofu`, `aws`, `cloudflare`, `kubernetes`, `vm`, and `takosumi_native`;
extra keys are endpoint-specific and must be backed by TargetPool evidence and a
plugin-aware adapter.

Secrets remain Credential/ProviderConnection material and are never placed in
the Resource Shape spec or OpenTofu state. AI Gateway configuration follows the
same secret/env projection rule; it is not a default Resource Shape.

## Compatibility Capabilities

Compatibility APIs are scoped, versioned entrypoints. They are enabled and
advertised as capabilities, for example:

```text
compat.s3.v1
compat.oci.v1
compat.cloudevents.v1
compat.kubernetes.crd.v1
compat.cloudflare.workers.v1
```

They preserve narrow standard facades when Takosumi provides the backend,
import path, or managed-target control. They are not a claim of full AWS
compatibility, full Cloudflare API compatibility, an internal provider-specific
model, or a reason to recreate standards that already work through existing
providers.

Takosumi exposes multiple first-class surfaces with no hierarchy between
provider, standard protocol, and compatibility profile.
`takosumi_*` Resource Shapes, S3-compatible APIs, CloudEvents-compatible APIs,
Kubernetes CRDs, OpenAI-compatible APIs, and scoped Cloudflare-compatible APIs
can all be valid Takosumi-managed features. A compatibility profile remains a
feature in its own right when it is the best fit for existing tools. The
`takosumi` provider exists for durable service forms that lack an adequate
vendor-independent provider or protocol. Unsupported operations should fail
closed instead of pretending full vendor compatibility; operators can then add
another compatibility profile, a standard-provider path, or a typed Takosumi
shape when the service form warrants it.

The public API boundary is documented in [Takosumi API](./api.md). Internal
planning and conformance notes live outside the published docs surface.

## Operator / Cloud Concepts

The following are operation or hosted-service concepts, not portable OSS model
requirements:

```text
commercial customer management
subscription / invoice / payment integration
official managed target pools
official native runtime / object store / queue / DB / edge gateway internals
official billing / SLA / support / abuse controls
```

Takosumi for Operator can operate its own managed target catalog and commercial
service. Takosumi Cloud is the official hosted operation with official managed
capacity.
