# Takosumi Core Conformance

Last updated: 2026-08-25

This matrix records evidence against the current [Core Spec](./core-spec.md).
It is not a product roadmap and does not treat the superseded Final Plan as
authority. Historical Resource/Form rows are migration evidence only.

| Area | Current boundary | Evidence posture |
| --- | --- | --- |
| Supported deployment flow | One Git/OpenTofu/Terraform Stack flow through the canonical Run/state/audit lifecycle | Source and portable checks cover the Stack, runner, state, Output, and audit paths; live operator evidence remains host-specific |
| PlanRun source boundary | Public/current PlanRun creation is Git-only; source-less `operator_module` is an internal marked destroy/recovery drain for pre-v1 persisted state | API and runner rejection tests cover create/update and unmarked destroy; the two historical destroy regressions cover the marked state-only drain |
| Public endpoint and Capsule identity | Hostname/DNS/endpoint behavior is ordinary Git-owned OpenTofu/provider work; OSS neither reserves managed hostnames nor infers OIDC clients from source/output/provider calls. An explicit DB-owned InstallConfig may use the private Accounts OIDC module-variable port: Plan/destroy admission are read-only, final digest-pinned Apply may register the exact client, and only an already-committed terminal destroy may request its best-effort deletion | Capsule Run and platform materializer tests cover zero Plan/destroy-admission writes, exact reviewed-variable/current-authority revalidation, collision and metadata-drift rejection before write, repeated-Apply safety, exact/idempotent terminal cleanup, failed-destroy retention, and the four-value non-secret boundary; generic Accounts OIDC live-grant and Interface authorization regressions remain required |
| Mutation redelivery safety | Apply/Destroy provider dispatch is durably fenced at most once; only a stable semantic match in the provably pre-dispatch phase may resume with a freshly verified credential, and completed-state adoption additionally requires that exact match against a pre-existing post-dispatch record | Durable Object tests cover crash/restart before and after the durable dispatch transition, re-minted token/JTI equivalence, expired/changed adoption replays, orphan R2 targets, authority/input mismatch, concurrent claims, finite secret-free error logs/evidence, one provider POST, and safe Plan/pre-dispatch retry; deploy-control tests prove the typed outcome is not retry-classified |
| Provider neutrality | Any runner-installable OpenTofu/Terraform provider may be configured through ProviderConnection, CredentialRecipe, and ProviderBinding | No first-party provider source, release, custody, or public mirror lane exists; arbitrary-provider checks are required |
| Takoform ownership | Takoform owns portable Form definitions, packages, provider releases, and conformance; it is an ordinary provider from OSS's perspective | OSS retains only migration-readable historical FormRef/package evidence; publication and install proof belong to the owning project or external Host |
| Interfaces | Generic provider-neutral Interface and InterfaceBinding authorization remain supported for Workspace/Capsule runtime use | Secret-free projection, binding authorization, and ordinary OpenTofu Output semantics are covered by Core/API tests |
| Form Host ownership | OSS does not host Form Registry, FormActivation, hosted Form instances, TargetPool, or SpacePolicy as a supported authoring surface | Takosumi hosted service or another external Host owns hosted lifecycle and managed capacity; retained code/docs are migration-only |
| Legacy edge | Retired Resource/Form `/v1` families are unconditional `404` with no drain flag, CLI caller, or public descriptor | Route tests prove no mount with a bearer and no capability/OpenAPI advertisement; typed domain operations remain migration-only |
| Release/deploy authority | The owning repository/operator deploys its own surface; this matrix does not authorize production mutation | Evidence must bind the reviewed commit, artifact, post-conditions, reversal, and failure handling |

## Historical compatibility posture

Old Resource IDs, state rows, Run rows, and exact FormRef/package evidence may
be read or transitioned for migration. A passing compatibility test does not
promote the old API, Form Registry, FormActivation, TargetPool, or SpacePolicy
into current OSS ownership. New work uses the Git/OpenTofu flow, generic
Interfaces.

Physical retirement remains inventory-gated. Operators must separately prove
zero relevant historical public-host reservation rows, zero registered Capsule
OIDC clients/declarations that still need live-grant validation, and zero pre-v1
source-less PlanRun/state rows before their stores, decoders, or destroy drain
can be removed. Current lifecycle code performs no bulk cleanup for those rows.
