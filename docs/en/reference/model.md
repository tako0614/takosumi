# Model Reference

Last updated: 2026-06-29

Takosumi OSS has two public flows: run plain OpenTofu from Git, and resolve
Takosumi Resource Shapes through TargetPools, policy, and Adapters. Compatibility
APIs are capability entrypoints into those models, not the internal model itself.

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

| Concept        | Meaning                                                                  |
| -------------- | ------------------------------------------------------------------------ |
| Space          | Resource API namespace and policy scope                                  |
| Environment    | Deployment environment inside a Space                                    |
| Stack          | A group of Resource Shape objects and operations                         |
| Resource       | Desired abstract resource, such as ObjectStore, HttpService, or Queue    |
| Target         | Concrete implementation destination, such as AWS, Cloudflare, Kubernetes |
| TargetPool     | Operator-controlled set of available Targets and capabilities            |
| Credential     | Runtime authority used by a Target or Adapter                            |
| Policy         | Rules for placement, cost, region, action, network, and access           |
| Adapter        | Implementation bridge that can preview, apply, observe, and delete       |
| ResolutionLock | Recorded resolver decision for a Resource                                |
| NativeResource | Concrete provider/platform resource created by an Adapter                |
| Condition      | Status and readiness evidence                                            |

`Space` here is the Resource API namespace and policy scope.

## OpenTofu Provider Resolution

Upload/prepared-source snapshots are internal/operator compatibility only. They
are not a public Source kind and do not create new public Capsules.

`Source.autoSync` enables scheduled Git-ref polling. It prepares newer immutable
SourceSnapshots when the ref moves, but it does not automatically apply changes.
Every infrastructure update still goes through Plan / Apply as a Run.

Provider resolution has two OSS outcomes plus policy blocking:

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

## Runner Policy

Runner policy, provider allowlists, lockfile/mirror rules, resource limits, and
network egress policy are internal control-plane safeguards. They decide where a
Run may execute and which provider plugins/resources may be reached, but they
are not public product nouns like ProviderConnection or ProviderBinding.
Operators may configure a runner-local OpenTofu provider plugin cache to speed
direct provider installs. It stores provider binaries only; credentials and
generated run files remain per-run.

The user-facing flow should feel like installing an app, but the model remains
Git-native and OpenTofu-native. Takosumi can reuse SourceSnapshots, provider
mirrors, provider plugin caches, warm runner capacity, and clear progress
phases. It must not decide what a deployable app artifact is. Worker bundles,
container images, release URLs, object keys, digests, and build pipelines belong
to the app repo, CI/release pipeline, registry, provider, or ordinary
OpenTofu/Terraform module variables.

The reference runner keeps successful containers warm for
`TAKOSUMI_RUNNER_KEEPALIVE_SECONDS` seconds (default `120`; `0` disables warm
reuse) and shuts down failed runs immediately. Operators can also pass
`TAKOSUMI_OPENTOFU_PLUGIN_CACHE_DIR` and `TAKOSUMI_SOURCE_ARCHIVE_ZSTD_LEVEL`
as non-secret speed settings.

## Resource Shape Resolution

The Resource Shape flow starts from `takosumi_*` resources and resolves them to
Targets:

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

Adapters report capabilities and perform preview/apply/observe/delete work.
Initial adapter families can include OpenTofu, Cloudflare, AWS, Kubernetes, VM,
and Takosumi-native adapters.

Extensible surfaces use capability tokens. For example,
`takosumi_ai_endpoint` has stable shape-specific HCL, but its
`interfaces`/`profiles`/`provider_preferences`/`routing_policy` tokens are not
limited to the AI providers Takosumi Cloud uses today. Operators can publish
TargetPool implementation capability evidence for DeepSeek, GLM, Gemini,
Bedrock, Vertex AI, OpenAI-compatible upstreams, Cloudflare AI Gateway, Workers
AI, or their own adapter. The endpoint accepts or rejects those tokens through
resolver/policy, not through a hard-coded provider binary allow-list. Upstream
API keys remain Credential/ProviderConnection material and are never placed in
the Resource Shape spec or OpenTofu state.

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

They map requests into Takosumi resources such as ObjectStore, Artifact,
Queue, EventHandler, HttpService, or Kubernetes resources. They are not a claim
of full AWS compatibility, full Cloudflare compatibility, or a provider-specific
internal model.

Detailed Resource Shape and compatibility capability definitions live in the
[Takosumi Final Plan](https://github.com/tako0614/takosumi/blob/main/docs/final-plan.md).

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
