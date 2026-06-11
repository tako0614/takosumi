# Operator Execution Boundaries

> Operator execution boundaries are operator-internal execution-boundary settings, not public vocabulary. The 2026-06-08
> [core spec](../../core-spec.md) closes the public surface
> to Space / Source / Connection / Provider Template / Provider Env Set / OpenTofu Capsule /
> Installation / InstallConfig / DeploymentProfile / ProviderBinding / Dependency / SourceSnapshot / DependencySnapshot / StateSnapshot / Run / RunGroup / Deployment / OutputSnapshot /
> Backup / Billing / Activity.

An operator execution boundary is operator-internal configuration for the OpenTofu execution boundary. It owns the
substrate, runner image, resource limits, and a provider allowlist seed.

What it **still** owns:

- **substrate**: where OpenTofu runs (e.g. Cloudflare Containers).
- **runner image**: container image / queue / Durable Object binding.
- **resource limits**: run time / source archive size / decompressed size / memory.
- **provider allowlist seed**: the OpenTofu provider source addresses the operator permits for this boundary (final enforcement is the policy layer evaluating the Capsule Gate result and plan JSON).

What **moved out**:

- **credentials** live on Connections / vault. ProviderBindings only resolve a
  provider source and optional alias to `default`, `connection`, `manual`, or `disabled`; credentials are
  not embedded in the operator-internal resolved execution view. Mint policy is decided inside the vault per run phase (source -> git credential only, compatibility/normalize/gate -> no provider credentials, plan/apply/destroy -> provider credentials only) and never trusts caller claims.
- **allowlists / action policy** live in the takosumi-policy layers. Capsule compatibility, provider allowlist, module source policy, data-source allowlist, resource-type allowlist, action policy, and billing mode evaluate the Capsule Gate result and plan JSON for every Run.

In the reference Cloudflare topology, OpenTofu `plan/apply` runs in the Cloudflare Container runner. Workers for Platforms is used only for tenant / user Worker dispatch and HTTP ingress. It is separate from the runner that holds provider credentials.

The shape below is an operator-internal **resolved execution view**. `stateBackend` is a reference to operator-managed
state/lock storage. Provider credentials are resolved per run phase from Connections / vault policy plus the
ProviderBinding provider resolution; the operator-internal resolved execution view does not own credential values or credential authority.

```json
{
  "id": "cloudflare-container",
  "substrate": "cloudflare-containers",
  "stateBackend": {
    "kind": "operator-managed",
    "ref": "state://takosumi/cloudflare",
    "lock": { "kind": "native", "ref": "lock://takosumi/cloudflare" }
  },
  "allowedProviders": ["registry.opentofu.org/cloudflare/cloudflare"],
  "sourcePolicy": {
    "allowLocalSource": false
  },
  "resourceLimits": {
    "maxRunSeconds": 900,
    "maxSourceArchiveBytes": 104857600,
    "maxSourceDecompressedBytes": 1048576000,
    "memoryMb": 1024
  },
  "cloudflareContainer": {
    "image": "registry.example.com/takosumi/opentofu-runner:1.10",
    "queueName": "takosumi-opentofu-runs"
  },
  "cloudflareWorkersForPlatforms": {
    "dispatchNamespace": "takosumi-tenants",
    "dispatchWorkerBinding": "TAKOSUMI_TENANT_DISPATCH",
    "outboundWorker": {
      "serviceBinding": "TAKOSUMI_OUTBOUND_WORKER",
      "enforceNetworkPolicy": true
    },
    "userWorkerBindings": {
      "mode": "tenant-scoped-only",
      "allowedBindingKinds": [
        "kv_namespace",
        "durable_object_namespace",
        "queue",
        "r2_bucket",
        "d1_database"
      ]
    }
  },
  "secretExposurePolicy": {
    "providerCredentials": "runner-only",
    "tenantWorkerOperatorSecrets": "forbidden",
    "redactLogs": true,
    "blockSensitiveOutputs": true
  }
}
```

The runner image, substrate, network policy, resource limits, and provider allowlist seed belong here. Provider
credentials live on Connections / vault, ProviderBindings select which provider binding is used, and Takosumi
records references and evidence, not secret values.

The final provider set is confirmed from Capsule Gate output and the runner-observed OpenTofu plan / provider lock. If
the observed provider set is outside the execution boundary allowlist, the Run is blocked by policy and cannot be
applied. The runner returns a provider lockfile digest, and Installation-context plans that use providers require that
digest by default. For mirror-required policy runs, the runner writes a strict `TF_CLI_CONFIG_FILE`, fixes filesystem
mirror include / direct exclude rules, and returns installed provider path / digest attestation as plan evidence. Runs
that need provider credentials but cannot resolve them from Connection / ProviderBinding are blocked before provider
credential mint.

## Source Policy

`git` and `prepared` sources are the normal production sources. `local` sources are for dev / operator-local execution
profiles and are accepted only when the operator explicitly sets `sourcePolicy.allowLocalSource: true`. Profiles that
accept tenant input should not allow local paths.

A prepared source is an archive fetched by the runner. The reference runner uses `resourceLimits.maxSourceArchiveBytes` to cap wire size and `resourceLimits.maxSourceDecompressedBytes` to cap declared decompressed tar size, and rejects unsafe paths, duplicate normalized paths, links, and tar entries other than files or directories before extraction.

## Common Provider Allowlist Seeds

Default operator boundaries seed an OpenTofu provider source address allowlist. This is not the Provider Template or a
public API; it is an internal OpenTofu execution-boundary seed selected by the operator.

`cloudflare-default` is the enabled seed for the reference Cloudflare topology. AWS / GCP / GitHub / Kubernetes are
user env set provider templates that become enabled only after the operator validates Connections, state backend,
network enforcement, and live proof. Azure / DigitalOcean / Docker are not initial templates; they are examples for
provider env sets plus explicit policy evidence or later Takosumi-provided promotion.

| Seed                           | State    | Providers                                                                            | Network policy                                                                       |
| ------------------------------ | -------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| `cloudflare-default`           | enabled  | `registry.opentofu.org/cloudflare/cloudflare`                                        | `api.cloudflare.com`                                                                 |
| `aws-verified-template`        | template | `registry.opentofu.org/hashicorp/aws`                                                | `sts.amazonaws.com`, `iam.amazonaws.com`, `route53.amazonaws.com`, `*.amazonaws.com` |
| `gcp-verified-template`        | template | `registry.opentofu.org/hashicorp/google`                                             | `oauth2.googleapis.com`, `cloudresourcemanager.googleapis.com`, `*.googleapis.com`   |
| `kubernetes-verified-template` | template | `registry.opentofu.org/hashicorp/kubernetes`, `registry.opentofu.org/hashicorp/helm` | operator-managed cluster API                                                         |
| `github-verified-template`     | template | `registry.opentofu.org/integrations/github`                                          | `api.github.com`                                                                     |

Future/custom examples such as Azure / DigitalOcean / Docker must enter through provider env set plus explicit policy
evidence, or through a later Takosumi-provided managed promotion.

`allowedHostPatterns` records provider API suffixes for region / service-specific endpoints as an internal field.
Enforcement belongs to the runner substrate.

## Workers for Platforms

Workers for Platforms is not the OpenTofu runner. It is the tenant / user Worker dispatch runtime and HTTP ingress.

`cloudflareWorkersForPlatforms` records the dispatch namespace, dispatch Worker binding, outbound Worker, and the binding kinds allowed for user Workers. Operator provider credentials, Deploy Control tokens, and state backend credentials must not be bound into user Workers.

The outbound Worker is where tenant Worker egress passes through operator policy. When an execution boundary has a
`networkPolicy`, the outbound Worker must enforce the same allowlist.

`providers/cloudflare/hosting/wfp_dispatch_worker.ts` is the ingress dispatch scaffold and does not implement egress allowlist enforcement. Treat `outboundWorker.enforceNetworkPolicy: true` as satisfied only when the operator can show live evidence that the dispatch namespace has an outbound Worker configured and that the outbound Worker enforces the allowlist.

## Cloudflare Containers

The reference runner's `compatibility_check` action materializes the SourceSnapshot into a run directory, runs
credential-free `tofu init`, and collects source files for Capsule Normalizer / Gate. The plan/apply actions materialize
the pinned SourceSnapshot or normalized artifact plus the generated root and write only dependency/input values to
`takosumi.auto.tfvars.json`. Provider credentials are never written to `.auto.tfvars.json`; they are passed to the
generated-root provider configuration through approved root-only channels. The plan action returns the digest of the
binary `tfplan` file as both `planDigest` and `planArtifact.digest`. In the Cloudflare
reference operator boundary, the Durable Object promotes that `tfplan` into encrypted R2_ARTIFACTS storage and the plan
Run records an artifact ref. The apply Run restores the artifact from R2 into the runner, recalculates the digest, and
only then materializes source, runs `tofu init`, and runs `tofu apply <tfplan>` when the reviewed artifact still
matches. `terraform.tfstate` is restored and persisted as per-Installation encrypted StateSnapshot generations in
R2_STATE.

## Secret Exposure Policy

`providerCredentials: "runner-only"` means provider credentials are resolved only inside the Container runner. The
reference runner does not pass the whole host environment into OpenTofu subprocesses. Provider credentials are injected
only through Connections / ProviderBindings / vault policy and provider-specific env allowlists. Operator-local secret
references are resolved by the operator secret delivery layer before the runner starts.

`tenantWorkerOperatorSecrets: "forbidden"` means tenant / user Workers do not receive operator secrets. Tenant-visible
values must be tenant-scoped bindings, short-lived tokens, or values the operator materializes according to Connection
policy.

When `redactLogs` is true for the execution boundary, runner diagnostics and failure audit messages are redacted before
persistence. When `blockSensitiveOutputs` is true, sensitive OpenTofu outputs are not projected into OutputSnapshot
`publicOutputs` / `spaceOutputs`.
