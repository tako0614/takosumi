# Operator Execution Boundaries

Operator execution boundaries are internal settings for where and how OpenTofu
runs. They are not public product vocabulary.

## Owns

- runner substrate
- runner image
- queue / worker binding
- resource limits
- explicit provider deny policy
- network egress policy
- state/lock backend references
- secret exposure policy

## Does Not Own

- raw provider secret values
- ProviderConnection public identity
- public compatibility API contract
- adapter capability contract
- official managed target pools
- Takosumi-owned native resource internals

Provider credentials live in ProviderConnections / vault. The boundary only
receives temporary run-scoped material after policy allows a Run to execute.

## Resolved Execution View

```json
{
  "id": "opentofu-default",
  "substrate": "cloudflare-containers",
  "stateBackend": {
    "kind": "operator-managed",
    "ref": "state://takosumi/opentofu-default",
    "lock": { "kind": "operator", "ref": "lock://takosumi/opentofu-default" }
  },
  "allowedProviders": ["*"],
  "requireCredentialRefs": false,
  "networkPolicy": { "mode": "operator-managed" },
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

`opentofu-default` is provider-neutral. Every syntactically valid provider
source uses this execution path; Takosumi does not maintain verified,
unverified, guided, or generic provider execution tiers. Credential Recipes add
setup convenience only. Provider packages use the configured cache or mirror
when present and OpenTofu's normal registry installation path otherwise.

An operator may define additional profiles for execution capabilities such as a
private network, host agent, architecture, or compliance boundary. These
profiles are selected explicitly and must not be named or selected by provider
brand. An explicit deny policy or missing runtime capability can reject a Run;
absence from a Takosumi recipe list cannot.

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
