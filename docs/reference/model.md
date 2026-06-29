# Model Reference

Last updated: 2026-06-28

Takosumi OSS models OpenTofu/Terraform execution around the existing provider
ecosystem. It does not model compatibility gateways or managed cloud resources.

## Public Concepts

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

## Provider Resolution

Upload/prepared-source snapshots are internal/operator compatibility only; they
are not a public Source kind and do not create new public Capsules.

`Source.autoSync` enables scheduled Git-ref polling. It prepares newer immutable
SourceSnapshots when the ref moves, but it does not automatically apply changes.
Every infrastructure update still goes through Plan / Apply as a Run.

Provider resolution has two OSS outcomes:

```text
resolved_provider_connection
blocked_missing_connection
blocked_policy
```

Resolution evidence never includes secret values. Internal legacy names such as
`ProviderEnv` may still appear in code during migration, but public API/UI/docs
should speak in terms of ProviderConnection and ProviderBinding.

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

## Cloud-Only Concepts

The following are not OSS model concepts:

```text
provider-compatible Gateway evidence
compatibility endpoint resolution
managed edge/storage/container resources
```

Those belong to closed Takosumi Cloud if and when the official hosted service
adds them.
