# Internal Execution Profiles

> A runner profile is **not public vocabulary**. The 2026-06-07 [core spec](../../core-spec.md) closes the public surface
> to Space / Source / Connection / OpenTofu Capsule / Installation / Dependency / Run / RunGroup / Deployment /
> OutputSnapshot / Billing / Activity, and
> this page keeps the old `runner profile` filename as a compatibility reference. The current concept is an
> **internal execution profile** subordinate to Connections, CapabilityBindings, and the policy layers.

An internal execution profile is operator-internal configuration for the OpenTofu execution boundary. It owns the
substrate, runner image, resource limits, and a provider allowlist seed.

What it **still** owns:

- **substrate**: where OpenTofu runs (e.g. Cloudflare Containers).
- **runner image**: container image / queue / Durable Object binding.
- **resource limits**: run time / source archive size / decompressed size / memory.
- **provider allowlist seed**: the OpenTofu provider source addresses the operator permits for this boundary (final enforcement is the policy layer evaluating the Capsule Gate result and plan JSON).

What **moved out**:

- **credentials** live on Connections and CapabilityBindings, not embedded in the internal execution profile. Mint policy is decided inside the vault per run phase (source -> git credential only, compatibility/normalize/gate -> no provider credentials, plan/apply/destroy -> provider credentials only) and never trusts caller claims.
- **allowlists / action policy** live in the takosumi-policy layers. Capsule compatibility, provider allowlist, module source policy, data-source allowlist, resource-type allowlist, action policy, and billing mode evaluate the Capsule Gate result and plan JSON for every Run.

In the reference Cloudflare topology, OpenTofu `plan/apply` runs in the Cloudflare Container runner. Workers for Platforms is used only for tenant / user Worker dispatch and HTTP ingress. It is separate from the runner that holds provider credentials.

The shape below is an operator-internal **resolved execution view**. `stateBackend` is a reference to operator-managed
state/lock storage. Provider credentials are resolved per run phase through Connections, CapabilityBindings, and vault
policy; the internal execution profile does not own credential values or credential authority.

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
credentials live on Connections, are resolved through CapabilityBindings, and Takosumi records references and evidence,
not secret values.

The final provider set is confirmed from Capsule Gate output and the runner-observed OpenTofu plan / provider lock. If
the observed provider set is outside the execution boundary allowlist, the Run is blocked by policy and cannot be applied. Runs
that need provider credentials but cannot resolve them from Connection / CapabilityBinding are blocked before provider
credential mint.

## Source Policy

`git` and `prepared` sources are the normal production sources. `local` sources are for dev / operator-local execution
profiles and are accepted only when the operator explicitly sets `sourcePolicy.allowLocalSource: true`. Profiles that
accept tenant input should not allow local paths.

A prepared source is an archive fetched by the runner. The reference runner uses `resourceLimits.maxSourceArchiveBytes` to cap wire size and `resourceLimits.maxSourceDecompressedBytes` to cap declared decompressed tar size, and rejects unsafe paths, duplicate normalized paths, links, and tar entries other than files or directories before extraction.

## Common Provider Allowlist Seeds

Default execution profiles seed an OpenTofu provider source address allowlist. This is not a provider adapter registry or
public API; it is an example OpenTofu execution boundary selected by the operator.

`cloudflare-default` is the enabled seed for the reference Cloudflare topology. AWS / GCP / Azure / Kubernetes / GitHub /
DigitalOcean / Docker are template examples until the operator validates credentials (Connections), state backend,
network enforcement, and live proof. Templates are operator-internal metadata and are not exposed to Capsule authors or
public API consumers until they resolve through CapabilityBinding / policy.

| Seed                   | State    | Providers                                                                            | Network policy                                                                       |
| ---------------------- | -------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| `cloudflare-default`   | enabled  | `registry.opentofu.org/cloudflare/cloudflare`                                        | `api.cloudflare.com`                                                                 |
| `aws-default`          | template | `registry.opentofu.org/hashicorp/aws`                                                | `sts.amazonaws.com`, `iam.amazonaws.com`, `route53.amazonaws.com`, `*.amazonaws.com` |
| `gcp-default`          | template | `registry.opentofu.org/hashicorp/google`                                             | `oauth2.googleapis.com`, `cloudresourcemanager.googleapis.com`, `*.googleapis.com`   |
| `azure-default`        | template | `registry.opentofu.org/hashicorp/azurerm`                                            | `login.microsoftonline.com`, `management.azure.com`, `*.azure.com`                   |
| `kubernetes-default`   | template | `registry.opentofu.org/hashicorp/kubernetes`, `registry.opentofu.org/hashicorp/helm` | operator-managed cluster API                                                         |
| `github-default`       | template | `registry.opentofu.org/integrations/github`                                          | `api.github.com`                                                                     |
| `digitalocean-default` | template | `registry.opentofu.org/digitalocean/digitalocean`                                    | `api.digitalocean.com`                                                               |
| `docker-local`         | template | `registry.opentofu.org/kreuzwerker/docker`                                           | local Docker daemon / operator-managed                                               |

`allowedHostPatterns` records provider API suffixes for region / service-specific endpoints as an internal field.
Enforcement belongs to the runner substrate.

## Workers for Platforms

Workers for Platforms is not the OpenTofu runner. It is the tenant / user Worker dispatch runtime and HTTP ingress.

`cloudflareWorkersForPlatforms` records the dispatch namespace, dispatch Worker binding, outbound Worker, and the binding kinds allowed for user Workers. Operator provider credentials, Deploy Control tokens, and state backend credentials must not be bound into user Workers.

The outbound Worker is where tenant Worker egress passes through operator policy. When an execution boundary has a
`networkPolicy`, the outbound Worker must enforce the same allowlist.

`worker/src/wfp_dispatch_worker.ts` is the ingress dispatch scaffold and does not implement egress allowlist enforcement. Treat `outboundWorker.enforceNetworkPolicy: true` as satisfied only when the operator can show live evidence that the dispatch namespace has an outbound Worker configured and that the outbound Worker enforces the allowlist.

## Cloudflare Containers

The reference runner materializes the SourceSnapshot into a run directory, runs Capsule Normalizer / Gate, and writes the generated root plus `takosumi.auto.tfvars.json`. It returns the digest of the binary `tfplan` file as both `planDigest` and `planArtifact.digest`. In the Cloudflare reference execution profile, the Durable Object promotes that `tfplan` into encrypted R2_ARTIFACTS storage and the plan Run records an artifact ref. The apply Run restores the artifact from R2 into the runner, recalculates the digest, and only then materializes source, runs `tofu init`, and runs `tofu apply <tfplan>` when the reviewed artifact still matches. `terraform.tfstate` is restored and persisted as per-Installation encrypted StateSnapshot generations in R2_STATE.

## Secret Exposure Policy

`providerCredentials: "runner-only"` means provider credentials are resolved only inside the Container runner. The
reference runner does not pass the whole host environment into OpenTofu subprocesses. Provider credentials are injected
only through Connections / CapabilityBindings / vault policy and provider-specific env allowlists. Operator-local secret
references are resolved by the operator secret delivery layer before the runner starts.

`tenantWorkerOperatorSecrets: "forbidden"` means tenant / user Workers do not receive operator secrets. Tenant-visible
values must be tenant-scoped bindings, short-lived tokens, or values the operator materializes according to Connection
policy.

When `redactLogs` is true for the execution boundary, runner diagnostics and failure audit messages are redacted before
persistence. When `blockSensitiveOutputs` is true, sensitive OpenTofu outputs are not projected into OutputSnapshot
`publicOutputs` / `spaceOutputs`.
