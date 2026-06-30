# Operator Execution Boundaries

Operator execution boundaries are internal settings for where and how OpenTofu
runs. They are not public product vocabulary.

## Owns

- runner substrate
- runner image
- queue / worker binding
- resource limits
- provider allowlist seed
- network egress policy
- state/lock backend references
- secret exposure policy

## Does Not Own

- raw provider secret values
- ProviderConnection public identity
- provider-compatible import endpoint backends
- managed resource backends
- Takosumi Cloud official resource pools

Provider credentials live in ProviderConnections / vault. The boundary only
receives temporary run-scoped material after policy allows a Run to execute.

## Resolved Execution View

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
  "resourceLimits": {
    "maxRunSeconds": 900,
    "maxSourceArchiveBytes": 104857600,
    "maxSourceDecompressedBytes": 1048576000,
    "memoryMb": 1024
  },
  "secretExposurePolicy": {
    "providerCredentials": "runner-only",
    "redactLogs": true,
    "blockSensitiveOutputs": true
  }
}
```

## Secret Exposure

`providerCredentials: "runner-only"` means provider credentials are resolved only
inside the runner dispatch path. They are injected through approved env/file
channels and never through `.tfvars`, run logs, public API projections, or
tenant workloads.

## Managed-Capacity Boundary

Operator execution settings may select where a Run executes or which adapters a
resolver can use, but they do not define the public compatibility API framework.
Workers for Platforms dispatch, Takosumi-owned native resource internals,
official managed target pools, and official resource backends are
Operator/Cloud managed-capacity concerns. The OSS repo must not expose those as
the default operator execution path.
