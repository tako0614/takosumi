# Takosumi Core Conformance

Last updated: 2026-06-19

This document tracks conformance to [Core Spec](./core-spec.md) and
[Final Plan](./final-plan.md). It is not the product direction source of truth.

## Status Terms

- **conformant**: implemented and covered by the current source/tests.
- **partial**: implemented partly or still using legacy internal names.
- **gap**: required by the Final Plan but not implemented yet.
- **cloud-only**: intentionally outside OSS Takosumi.

## Boundary

| Area                                                                                                                                                                              | Status     | Notes                                                                                                                                                            |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Existing provider execution                                                                                                                                                       | partial    | Runner, generated root, ProviderConnection, and vault paths exist, but code still contains legacy `Space` / `Installation` / `ProviderEnv` names.                |
| ProviderConnection                                                                                                                                                                | partial    | OSS contract exposes ProviderConnections backed by user/operator-managed credential material; Cloud-managed connections belong only to closed Takosumi Cloud.    |
| CredentialRecipe                                                                                                                                                                  | gap        | Credential behavior exists in scattered provider rules/vault drivers; it still needs recipe files for Cloudflare, AWS, GCP, S3-compatible, and generic env.      |
| ProviderBinding                                                                                                                                                                   | partial    | Existing installation provider-env binding should be renamed/projected as ProviderBinding.                                                                       |
| StateVersion                                                                                                                                                                      | partial    | State storage exists; the public model should be renamed from StateSnapshot to StateVersion where user-facing.                                                   |
| Outputs                                                                                                                                                                           | conformant | Output capture and projection paths exist.                                                                                                                       |
| Outputs-to-inputs                                                                                                                                                                 | partial    | DependencySnapshot path exists; public docs should use Capsule input wiring.                                                                                     |
| Run ledger                                                                                                                                                                        | conformant | Runs, logs, plan/apply records, approval, and audit evidence exist.                                                                                              |
| Runner protocol                                                                                                                                                                   | partial    | Worker/container runner paths exist; local/docker/remote runner UX needs cleanup.                                                                                |
| first-party OpenTofu Capsule module catalog (`aws-s3-storage`, `cloudflare-hello-worker`, `cloudflare-r2-storage`, `cloudflare-static-site`, `cloudflare-worker-service`, `core`) | conformant | The tracked module catalog matches `opentofu-modules/module-files.ts`; these are normal OpenTofu modules using existing providers, not managed-resource drivers. |
| Web UI                                                                                                                                                                            | partial    | Dashboard exists but still contains legacy product names in places.                                                                                              |
| CLI                                                                                                                                                                               | partial    | CLI is an operator/developer helper, not the primary user flow.                                                                                                  |
| Takosumi for Operators                                                                                                                                                            | partial    | Multi-tenant/account-plane pieces exist but need final-plan vocabulary and readiness cleanup.                                                                    |
| Takosumi Cloud                                                                                                                                                                    | cloud-only | Closed official hosted implementation.                                                                                                                           |
| Compatibility Gateway                                                                                                                                                             | cloud-only | Removed from OSS public contract/routes/registry.                                                                                                                |
| Managed resources                                                                                                                                                                 | cloud-only | Must live in closed Cloud implementation.                                                                                                                        |

## Current Verification

The minimum local checks for OSS conformance work are:

```bash
cd takosumi
bunx tsc --noEmit --pretty false
bun run check:worker-types
bun run check:cloudflare-worker-build
bun run docs:build
```

Targeted tests should cover provider registry, runner profiles, deploy-control
contract, ProviderConnection resolution, RunEnvResolver, and dashboard install
flow whenever those surfaces change.

## Known Migration Debt

- Legacy internal names remain: Space, Installation, ProviderEnv, StateSnapshot.
- Some tests still describe retired Gateway behavior and should be deleted or
  moved to the closed Cloud repository.
- Storage migrations keep legacy columns for backward compatibility.
- Product docs outside the core spec may still need copy updates.
