# Takosumi Core Conformance

Last updated: 2026-06-28

This document tracks conformance to [Core Spec](./core-spec.md) and
[Final Plan](./final-plan.md). It is not the product direction source of truth.

## Status Terms

- **conformant**: implemented and covered by the current source/tests.
- **partial**: implemented partly or still using legacy internal names.
- **gap**: required by the Final Plan but not implemented yet.
- **cloud-only**: intentionally outside OSS Takosumi.

## Boundary

| Area                                                                                                                                                                              | Status     | Notes                                                                                                                                                                                                                                                                                          |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Existing provider execution                                                                                                                                                       | conformant | Runner, generated root, ProviderConnection, and vault paths run existing providers as-is; the `Space` / `Installation` / `ProviderEnv` names were renamed to the final model.                                                                                                                  |
| ProviderConnection                                                                                                                                                                | conformant | OSS contract exposes ProviderConnections backed by user/operator-managed credential material; the provider-credential cluster collapsed to ProviderConnection / CredentialRecipe / ProviderBinding and Provider Catalog was removed. Cloud-managed connections belong only to closed Takosumi Cloud. |
| CredentialRecipe                                                                                                                                                                  | conformant | `recipes/providers/*.yaml` defines the built-in recipe catalog, including Cloudflare, AWS, GCP, S3-compatible, generic env, and common provider recipes; tests keep it in sync with runner/vault env-rule projections.                                                                          |
| ProviderBinding                                                                                                                                                                   | conformant | Provider / alias-to-ProviderConnection binding is the live model.                                                                                                                                                                                                                              |
| StateVersion                                                                                                                                                                      | conformant | State storage exists and the public model is StateVersion (renamed from StateSnapshot, with rename-aside migrations on both engines).                                                                                                                                                          |
| Outputs                                                                                                                                                                           | conformant | Output capture and projection paths exist.                                                                                                                                                                                                                                                     |
| Outputs-to-inputs                                                                                                                                                                 | conformant | Output-to-input wiring is pinned at plan time and marks downstream Capsule inputs stale.                                                                                                                                                                                                        |
| Run ledger                                                                                                                                                                        | conformant | Runs, logs, plan/apply records, approval, and audit evidence exist.                                                                                                                                                                                                                            |
| Runner protocol                                                                                                                                                                   | conformant | Worker/container runner paths exist; the RunEngine and runner entrypoint were split into focused modules.                                                                                                                                                                                       |
| first-party OpenTofu Capsule module catalog (`aws-s3-storage`, `cloudflare-hello-worker`, `cloudflare-r2-storage`, `cloudflare-static-site`, `cloudflare-worker-service`, `core`) | conformant | The tracked module catalog matches `opentofu-modules/module-files.ts`; these are normal OpenTofu modules using existing providers, not managed-resource drivers.                                                                                                                                |
| Output projection (Service Graph replacement)                                                                                                                                     | conformant | The OSS Service Graph ledger was removed; runtime services are projected store-free from Capsule Outputs (`core/domains/output-projection/service-projection.ts`) and validated fail-closed at apply.                                                                                            |
| Web UI                                                                                                                                                                            | conformant | Dashboard uses the final-model vocabulary; covered by `check:dashboard` and the new-flow tests.                                                                                                                                                                                                |
| CLI                                                                                                                                                                               | conformant | The single operator/platform CLI is rehomed to top-level `cli/`; it is an operator/developer helper, not the primary user flow.                                                                                                                                                                |
| Takosumi for Operators                                                                                                                                                            | conformant | The multi-tenant operator build of OSS uses the final-plan vocabulary; quota/showback is a Workspace-scoped ledger with `disabled` / `showback` modes and no enforced billing gate.                                                                                                            |
| Takosumi Cloud                                                                                                                                                                    | cloud-only | Closed official hosted implementation in the `takosumi-cloud` package.                                                                                                                                                                                                                          |
| Compatibility Gateway                                                                                                                                                             | cloud-only | Removed from the OSS public contract/routes/registry; lives in `takosumi-cloud`, reached only via the `cloud_extensions` route proxy.                                                                                                                                                          |
| AI Gateway                                                                                                                                                                        | cloud-only | Moved into `takosumi-cloud` (`gateway/ai-gateway/`); OpenAI-compatible runtime API, not an OSS feature.                                                                                                                                                                                        |
| Enforced billing                                                                                                                                                                  | cloud-only | OSS ships no-op `BillingEnforcement` / `QuotaPolicy` ports; enforced Stripe billing lives only in `takosumi-cloud`.                                                                                                                                                                            |
| Managed resources                                                                                                                                                                 | cloud-only | Live in the closed `takosumi-cloud` package.                                                                                                                                                                                                                                                    |

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
contract, ProviderConnection resolution, RunEnvResolver, output projection, and
the dashboard install flow whenever those surfaces change.

## Remaining Cleanup

- Storage migrations keep retired columns/tables (renamed aside, e.g.
  `service_graph_*` -> `*_retired`) for non-destructive rollback; they are not
  public model and can be dropped in a later destructive migration.
- A few internal helper names (`SourceSnapshot`, `InstallConfig`) are
  descriptive implementation names, not public product nouns.
