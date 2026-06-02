# Takosumi v1 {#takosumi-v1}

Takosumi is a manifestless Source install/deploy contract. Its public concepts are **Source / Installation /
Deployment / PlatformService**.

| Concept | Meaning |
| --- | --- |
| Source | `git`, `prepared`, or `local` source input and resolved identity. |
| Installation | Space-scoped installed source record with a current Deployment pointer. |
| Deployment | One apply result with source summary, plan snapshot, binding snapshot, outputs, and status. |
| PlatformService | Operator-inventory service capability. |

## Takosumi Defines

- Source input kinds and source identity guards.
- Installation / Deployment lifecycle.
- The five Installer API endpoints.
- `InstallPlan` as a dry-run response snapshot.
- `planSnapshotDigest` as reviewed source / binding resolution guard.
- Binding snapshot recording.
- Pointer-only rollback semantics.

Takosumi does not own OpenTofu, provider credentials, account plane, billing, OIDC issuer policy, dashboard,
or deploy facade. Those belong to the operator distribution's account-facing and operator-facing surface.

## Source

| Kind | Meaning |
| --- | --- |
| `git` | Remote git source. Guard uses resolved commit + `planSnapshotDigest`. |
| `prepared` | Build service / CI source archive. Guard uses archive digest + `planSnapshotDigest`. |
| `local` | Path visible to the Takosumi service for dev / operator-local profiles. |

There is no Takosumi-specific source DSL. Operator-owned OpenTofu modules may
publish app metadata or inventory material through `tofu output -json`, but
Takosumi itself does not parse HCL, plan, or apply.

## Installer API

```text
POST /v1/installations/dry-run
POST /v1/installations
POST /v1/installations/{id}/deployments/dry-run
POST /v1/installations/{id}/deployments
POST /v1/installations/{id}/rollback
```

## Rollback

Rollback moves `currentDeploymentId` to a retained successful Deployment. It does not create a new Deployment and does
not generically roll back workload data or provider resources.

## Related

- [Specification Boundaries](./spec-boundaries.md)
- [Installer API](./installer-api.md)
- [Platform Services](./platform-services.md)
