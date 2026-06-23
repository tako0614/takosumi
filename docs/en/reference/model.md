# Model Reference

Last updated: 2026-06-19

Takosumi OSS models OpenTofu/Terraform execution around the existing provider
ecosystem. It does not model compatibility gateways or managed cloud resources.

## Public Concepts

| Concept            | Meaning                                                                    |
| ------------------ | -------------------------------------------------------------------------- |
| Workspace          | User/team isolation boundary for projects, state, secrets, runs, and audit |
| Project            | One product, service, or infrastructure group                              |
| Capsule            | One OpenTofu/Terraform module execution unit                               |
| Source             | Git URL/ref/commit/path, tarball, template, or local upload                |
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

Provider resolution has two OSS outcomes plus policy blocking:

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
boundary. A provider that is not in the catalog can still run when the user
creates a ProviderConnection with the provider source from `required_providers`
and the explicit environment variables documented by that provider. Those
declared env names become the run-local CredentialRecipe, subject to runner
policy, provider plugin policy, and egress policy.

## Runner Policy

Runner policy, provider allowlists, lockfile/mirror rules, resource limits, and
network egress policy are internal control-plane safeguards. They decide where a
Run may execute and which provider plugins/resources may be reached, but they
are not public product nouns like ProviderConnection or ProviderBinding.

## Cloud-Only Concepts

The following are not OSS model concepts:

```text
provider-compatible Gateway evidence
compatibility endpoint resolution
managed edge/storage/container resources
```

Those belong to closed Takosumi Cloud if and when the official hosted service
adds them.
