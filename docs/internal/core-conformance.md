# Takosumi Core Conformance

Last updated: 2026-08-13

This matrix records evidence against the current [Core Spec](./core-spec.md).
It is not a product roadmap and does not treat the superseded Final Plan as
authority. Historical Resource/Form rows are migration evidence only.

| Area | Current boundary | Evidence posture |
| --- | --- | --- |
| Supported deployment flow | One Git/OpenTofu/Terraform Stack flow through the canonical Run/state/audit lifecycle | Source and portable checks cover the Stack, runner, state, Output, and audit paths; live operator evidence remains host-specific |
| Mutation redelivery safety | Apply/Destroy provider dispatch is durably fenced at most once; only a stable semantic match in the provably pre-dispatch phase may resume with a freshly verified credential, and completed-state adoption additionally requires that exact match against a pre-existing post-dispatch record | Durable Object tests cover crash/restart before and after the durable dispatch transition, re-minted token/JTI equivalence, expired/changed adoption replays, orphan R2 targets, authority/input mismatch, concurrent claims, finite secret-free error logs/evidence, one provider POST, and safe Plan/pre-dispatch retry; deploy-control tests prove the typed outcome is not retry-classified |
| Provider neutrality | Any runner-installable OpenTofu/Terraform provider may be configured through ProviderConnection, CredentialRecipe, and ProviderBinding | No first-party provider source, release, custody, or public mirror lane exists; arbitrary-provider checks are required |
| Takoform ownership | Takoform owns portable Form definitions, packages, provider releases, and conformance; it is an ordinary provider from OSS's perspective | OSS retains only migration-readable historical FormRef/package evidence; publication and install proof belong to the owning project or external Host |
| Interfaces | Generic provider-neutral Interface and InterfaceBinding authorization remain supported for Workspace/Capsule runtime use | Secret-free projection, binding authorization, and ordinary OpenTofu Output semantics are covered by Core/API tests |
| Generic Offerings | Immutable generic catalog, availability, and exact OfferingSelection remain supported; no commercial fields or implicit provider choice | D1/Postgres catalog and operator routes are checked independently of any Form registry or hosted Form |
| Form Host ownership | OSS does not host Form Registry, FormActivation, hosted Form instances, TargetPool, or SpacePolicy as a supported authoring surface | Takosumi Cloud or another external Host owns hosted lifecycle and managed capacity; retained code/docs are migration-only |
| Legacy edge | Default `404`; with authenticated control-plane configuration plus `TAKOSUMI_LEGACY_RESOURCE_DRAIN_ENABLED=1`, only bounded list/read/events/observe/delete and TargetPool/SpacePolicy `GET`/`HEAD`/`DELETE` are available | Route tests assert no discovery and no writes; disallowed operations return `404`/`410` |
| Release/deploy authority | The owning repository/operator deploys its own surface; this matrix does not authorize production mutation | Evidence must bind the reviewed commit, artifact, post-conditions, reversal, and failure handling |

## Historical compatibility posture

Old Resource IDs, state rows, Run rows, and exact FormRef/package evidence may
be read or transitioned for migration. A passing compatibility test does not
promote the old API, Form Registry, FormActivation, TargetPool, or SpacePolicy
into current OSS ownership. New work uses the Git/OpenTofu flow, generic
Interfaces, and generic Offerings.
