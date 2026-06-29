# Takosumi Core Conformance

Last updated: 2026-06-29

This document tracks conformance to [Core Spec](./core-spec.md) and
[Final Plan](./final-plan.md). It is not the product direction source of truth.

## Status Terms

- **conformant**: implemented and covered by current source/tests.
- **partial**: implemented partly or exposed through older internal names.
- **gap**: required by the Final Plan but not implemented yet.
- **operator/cloud**: belongs to Takosumi for Operator / Takosumi Cloud
  commercial or official-hosting operation.

## Conformance Matrix

| Area | Status | Notes |
| --- | --- | --- |
| Existing provider execution | conformant | Runner, generated root, ProviderConnection, vault paths, state/output capture, approval, and audit run existing providers as-is. |
| Git-native SourceSnapshot reuse | conformant | `source_sync` resolves refs with Git, records immutable SourceSnapshots, and reuses existing archives when the same Source/ref/path resolves to the same commit. |
| ProviderConnection | conformant | Secret-backed and generic-env ProviderConnections exist. |
| CredentialRecipe | conformant | `recipes/providers/*.yaml` includes Cloudflare, AWS, GCP, S3-compatible, generic env, and common provider recipes; tests keep catalog/projection in sync. |
| ProviderBinding | conformant | Provider / alias-to-ProviderConnection binding is live. |
| StateVersion | conformant | State storage exists and the public model is StateVersion. |
| Outputs | conformant | Output capture and projection paths exist. |
| Outputs-to-inputs | conformant | Output-to-input wiring is pinned at plan time and marks downstream Capsules stale. |
| Run ledger | conformant | Runs, logs, plan/apply records, approval, and audit evidence exist. |
| Runner protocol | conformant | Worker/container runner paths exist; OpenTofu runner is the execution sandbox. |
| Provider mirror and plugin cache | conformant | Runner image supports offline mirror and operator-configured plugin cache; credentials and generated files remain per-run. |
| first-party OpenTofu Capsule module catalog | conformant | Active bundled-HCL catalog in `firstPartyModuleFilesByTemplateId` matches `aws-s3-storage`, `cloudflare-hello-worker`, `cloudflare-r2-storage`, `cloudflare-static-site`, and `core`; each is a plain child module called from the generated root. |
| first-party HttpService module metadata for `cloudflare-worker-service` | partial | Used by the Resource Shape planner for Worker-compatible HttpService materialization; production hosts must inject a real ResourceShape adapter. |
| App-install speed boundary | conformant | Takosumi-side speed work is SourceSnapshot reuse, provider mirror/cache, runner queueing/warmth, timings, and progress phases. |
| Web UI for OpenTofu flow | partial | Dashboard is usable for current OpenTofu/ProviderConnection flow. Resource Shape UI is not complete. |
| CLI for OpenTofu flow | partial | Operator/platform CLI exists. Resource Shape API CLI is not complete. |
| `/.well-known/takosumi` | conformant | Public discovery document is served without inventory auth and points providers/CLIs at `/v1/capabilities`. |
| `/v1/capabilities` product capabilities | conformant | Public product capability document is served without inventory auth. Existing `/capabilities` remains the separate operator route inventory. |
| Resource Shape API | gap | Required by Final Plan. Needs Resource object schema, preview/apply/status, events, refresh/import. |
| Resource Shape contract types | gap | Required in `takosumi-contract` for `takosumi.dev/v1alpha1`. |
| Resolver / Planner / Reconciler | gap | Required to resolve Shape / Interface / Profile against TargetPool, Policy, and adapters. |
| Target / TargetPool | gap | Required for backend selection. |
| Credential modes | partial | Static/generic provider credential flow exists. OIDC federation and agent-local need final Resource Shape credential model. |
| OIDC issuer / workload identity | partial | Accounts OIDC exists. Standard Takosumi workload identity API is not complete. |
| Adapter framework | partial | Internal `ProviderAdapter` exists, but public adapter contract and target capability model are not complete. |
| Compatibility API framework | gap | Required in OSS as a versioned profile framework. Specific profiles still need implementation and capabilities. |
| S3 compatibility profile | gap | First priority compatibility profile for ObjectStore. |
| OCI compatibility profile | gap | Needed for Artifact / ContainerImage. |
| CloudEvents compatibility profile | gap | Needed for Queue / EventHandler / Stream. |
| Cloudflare Workers subset profile | gap | Limited profile only; must not claim complete Cloudflare API compatibility. |
| Usage event emission | partial | Usage/billing ledgers exist for current platform work. Shape-level usage event taxonomy is not complete. |
| Takosumi for Operator commercial features | operator/cloud | Customer/tenant/subscription/payment/rating/invoice/support operations are outside core. |
| Takosumi Cloud official managed targets | operator/cloud | Closed official hosted operation. |
| Enforced billing and payments | operator/cloud | Stripe enforcement and payment gates stay outside OSS Core. |
| Official Takosumi native resource internals | operator/cloud | Official runtime/object-store/queue/DB/edge internals are hosted-operation implementations, not OSS Core requirements. |

## Pre-Staging Redesign Cutline

Do not promote a new hosted staging cell until these Final Plan contract gates
pass. This cutline exists so real-cloud deploy work does not freeze a mixed
pre-v1/public-v1 surface.

| Gate | Required state |
| --- | --- |
| Public Stack API vocabulary | Session control routes expose `workspaces`, `capsules`, `state-versions`, and `capsule-configs`; retired `/api/v1/spaces`, `/api/v1/installations`, `/api/v1/deployments`, and `/api/v1/install-configs` are rejected. |
| Capability-driven discovery | `/.well-known/takosumi` and `/v1/capabilities` are sufficient for clients; provider/client behavior must not branch on `edition`. |
| Provider mirror assets | `bun run provider:assets` succeeds before dashboard/platform build so `/opentofu/providers/registry.opentofu.org/takosjp/takosumi/` is present in Worker assets. |
| Cloud extension inventory | Detailed Cloud extension catalog routes are operator-gated; public discovery exposes only non-secret capabilities. |
| OSS/Cloud boundary | Official managed targets, native runtime internals, Stripe enforcement, SLA/support, and abuse controls remain Operator/Cloud operation layers, not OSS Core contracts. |

## Current Verification

Minimum local checks for OSS conformance work:

```bash
cd takosumi
bunx tsc --noEmit --pretty false
bun run check:worker-types
bun run check:cloudflare-worker-build
bun run docs:build
```

Targeted tests should cover:

```text
ProviderConnection resolution
CredentialRecipe env/file projection
RunEnvResolver
StateVersion / Output capture
SourceSnapshot reuse
discovery and capability documents
Resource Shape contract types
adapter capability matching
compatibility profile enable/disable behavior
```

## Remaining Cleanup

- Storage migrations keep retired columns/tables for non-destructive rollback;
  they are not public model and can be dropped in a later destructive migration.
- A few internal helper names (`SourceSnapshot`, `InstallConfig`) are
  descriptive implementation names, not product nouns.
- The old `/capabilities` route inventory must not be confused with
  `/v1/capabilities` product capabilities.
