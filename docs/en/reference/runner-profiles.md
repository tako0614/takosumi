# Runner Profiles

RunnerProfile is the operator execution boundary.

In the reference Cloudflare topology, OpenTofu `plan/apply` runs in the Cloudflare Container runner. Workers for Platforms is used only for tenant / user Worker dispatch and HTTP ingress. It is separate from the runner that holds provider credentials.

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
  "credentialRefs": [
    {
      "provider": "registry.opentofu.org/cloudflare/cloudflare",
      "ref": "secret://cloudflare/api-token",
      "required": true
    }
  ],
  "requireCredentialRefs": true,
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

Provider credentials, remote state, lock backend, runner image, network policy, and resource limits belong here. Takosumi records references and evidence, not secret values.

PlanRun request `requiredProviders` is the pre-run provider source address contract. Operator-facing CLI / CI must list the reviewed OpenTofu providers used by the module. When a RunnerProfile has `allowedProviders`, empty `requiredProviders` is blocked before `tofu init`.

The final PlanRun `requiredProviders` value is confirmed or overwritten from the runner-observed OpenTofu plan / provider lock. If the observed provider set is outside the profile allowlist, the PlanRun is blocked and cannot be applied.

## Source Policy

`git` and `prepared` sources are the normal production sources. `local` sources are for dev / operator-local profiles and are accepted only when the RunnerProfile explicitly sets `sourcePolicy.allowLocalSource: true`. Profiles that accept tenant input through the public Deploy Control API should not allow local paths.

A prepared source is an archive fetched by the runner. The reference runner uses `resourceLimits.maxSourceArchiveBytes` to cap wire size and `resourceLimits.maxSourceDecompressedBytes` to cap declared decompressed tar size, and rejects unsafe paths, duplicate normalized paths, links, and tar entries other than files or directories before extraction.

## Common Provider Profiles

Default RunnerProfiles allow OpenTofu provider source addresses. This is not a provider adapter registry; it is the OpenTofu execution boundary selected by the operator.

`cloudflare-default` is the enabled profile for the reference Cloudflare topology. AWS / GCP / Azure / Kubernetes / GitHub / DigitalOcean / Docker are templates until the operator validates credentials, state backend, network enforcement, and live proof. Template profiles are returned with `labels["takosumi.com/profile-state"] === "template"` and are blocked by policy until the operator sets `labels["takosumi.com/profile-enabled"] === "true"`.

| Profile | State | Providers | Credential ref | Network policy |
| --- | --- | --- | --- | --- |
| `cloudflare-default` | enabled | `registry.opentofu.org/cloudflare/cloudflare` | `secret://takosumi/cloudflare-default` | `api.cloudflare.com` |
| `aws-default` | template | `registry.opentofu.org/hashicorp/aws` | `secret://takosumi/aws-default` | `sts.amazonaws.com`, `iam.amazonaws.com`, `route53.amazonaws.com`, `*.amazonaws.com` |
| `gcp-default` | template | `registry.opentofu.org/hashicorp/google` | `secret://takosumi/gcp-default` | `oauth2.googleapis.com`, `cloudresourcemanager.googleapis.com`, `*.googleapis.com` |
| `azure-default` | template | `registry.opentofu.org/hashicorp/azurerm` | `secret://takosumi/azure-default` | `login.microsoftonline.com`, `management.azure.com`, `*.azure.com` |
| `kubernetes-default` | template | `registry.opentofu.org/hashicorp/kubernetes`, `registry.opentofu.org/hashicorp/helm` | `secret://takosumi/kubernetes-default` | operator-managed cluster API |
| `github-default` | template | `registry.opentofu.org/integrations/github` | `secret://takosumi/github-default` | `api.github.com` |
| `digitalocean-default` | template | `registry.opentofu.org/digitalocean/digitalocean` | `secret://takosumi/digitalocean-default` | `api.digitalocean.com` |
| `docker-local` | template | `registry.opentofu.org/kreuzwerker/docker` | none by default | local Docker daemon / operator-managed |

`allowedHostPatterns` records provider API suffixes for region / service-specific endpoints. Enforcement belongs to the runner substrate.

## Workers for Platforms

Workers for Platforms is not the OpenTofu runner. It is the tenant / user Worker dispatch runtime and HTTP ingress.

`cloudflareWorkersForPlatforms` records the dispatch namespace, dispatch Worker binding, outbound Worker, and the binding kinds allowed for user Workers. Operator provider credentials, Deploy Control tokens, and state backend credentials must not be bound into user Workers.

The outbound Worker is where tenant Worker egress passes through operator policy. When a profile has a `networkPolicy`, the outbound Worker must enforce the same allowlist.

`worker/src/wfp_dispatch_worker.ts` is the ingress dispatch scaffold and does not implement egress allowlist enforcement. Treat `outboundWorker.enforceNetworkPolicy: true` as satisfied only when the operator can show live evidence that the dispatch namespace has an outbound Worker configured and that the outbound Worker enforces the allowlist.

## Cloudflare Containers

The reference runner materializes the PlanRun `source` into a run directory and writes `variables` as `takosumi.auto.tfvars.json` in the module directory. It returns the digest of the binary `tfplan` file as both `planDigest` and `planArtifact.digest`. In the Cloudflare reference profile, the Durable Object promotes that `tfplan` into the `R2_ARTIFACTS` R2 bucket under `opentofu-plan-runs/` and the PlanRun records an `object-storage` artifact ref. ApplyRun restores the artifact from R2 into the runner, recalculates the digest, and only then materializes source, runs `tofu init`, and runs `tofu apply <tfplan>` when the reviewed artifact still matches. `terraform.tfstate` is restored and persisted through an operator-managed R2 sidecar under `opentofu-state/backends/<stateBackendRefDigest>/`; create applies without an Installation id use a source-identity key until later runs can use the Installation key.

## Secret Exposure Policy

`providerCredentials: "runner-only"` means provider credentials are resolved only inside the Container runner. The reference runner does not pass the whole host environment into OpenTofu subprocesses. Provider credentials are injected only from RunnerProfile `credentialRefs` and provider-specific env allowlists. `env://VAR_NAME` is an operator-local convention for injecting a named runner host env var. `secret://...` references are resolved by the operator secret delivery layer before the runner starts.

`tenantWorkerOperatorSecrets: "forbidden"` means tenant / user Workers do not receive operator secrets. Tenant-visible values must be tenant-scoped bindings, short-lived tokens, or values materialized by the operator from `secret://` references.

When `redactLogs` is true, runner diagnostics and failure audit messages are redacted before persistence. When `blockSensitiveOutputs` is true, sensitive OpenTofu outputs are not stored as DeploymentOutput records.
