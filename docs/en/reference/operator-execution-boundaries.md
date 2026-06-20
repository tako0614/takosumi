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
- compatibility gateway endpoints
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

## Cloud-Only Boundary

Workers for Platforms dispatch, Cloudflare Compatibility Gateway, Takosumi
Managed Edge, and managed resource backends are Takosumi Cloud-only. The OSS repo
must not expose those as the default operator execution path.
