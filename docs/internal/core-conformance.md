# Takosumi Core Conformance

Last updated: 2026-09-01

This matrix records evidence against the current [Core Spec](./core-spec.md)
and target [Architecture](./architecture.md). It is not a product roadmap and
does not treat the superseded Final Plan or an existing route as authority.
Where the implementation still contains a retired projection, the row is an
explicit conformance gap and migration custody.

| Area | Current contract / target | Evidence posture |
| --- | --- | --- |
| Customer BYOC | Workspace/customer owns the vendor account and credential; `ProviderConnection` → `CredentialRecipe` → `ProviderBinding` → run-scoped materialization is the complete standard-provider path. Takoserver is not involved. | Core/API and credential-broker tests cover scope, redaction, and provider-neutral configuration; end-to-end evidence remains required for each operator-owned provider. |
| StackCatalog | Workspace, Project, Capsule, Git Source, immutable SourceSnapshot, exact module selection, and 0/1/N discovery are one catalog authority. | Source and portable tests cover source selection and discovery; extraction behind a narrow StackCatalog interface is not complete everywhere. |
| RunAuthority | Plan/apply/destroy/refresh review, lease, audit intent, terminal commit, and indeterminate reconciliation are one authority. | Durable Run tests cover crash/restart around the dispatch transition, re-minted token/JTI equivalence, expired/changed adoption replays, orphan R2 targets, authority/input mismatch, concurrent claims, finite secret-free evidence, one provider POST, and safe Plan/pre-dispatch retry. The target module split remains partial. |
| Mutation redelivery safety | Apply/Destroy provider dispatch is at most once; only a stable semantic match in provably pre-dispatch `preparing` may resume with a freshly verified equivalent credential. Completed-state adoption requires an exact match against a pre-existing post-dispatch record; an R2 target cannot mint authority. | Durable Object and deploy-control tests prove the typed `runner_mutation_indeterminate` outcome is not retry-classified. RunOwner and RunnerObject must remain separate. |
| CredentialBroker | ProviderConnection, CredentialRecipe, and ProviderBinding policy are validated before materialization; opaque credentials are scoped to one Run and never persisted in clear text. | Focused credential and redaction tests cover source/provider boundaries; provider-specific recipes remain operator-owned inputs. |
| ArtifactLedger | Source, plan, state, Output, audit, and result artifacts are immutable and digest-bound; current-state pointer changes are authorized by RunAuthority. | Artifact encryption, size limits, state locking, and output/audit tests cover the ledger; decomposition from broad stores remains a target gap. |
| Executor / Runner | One immutable approved Run envelope yields one terminal result with immutable artifacts or a typed indeterminate outcome. The result returns to RunAuthority, which alone authorizes ArtifactLedger commit/adoption/current-pointer mutation. An executor-local delivery receipt is subordinate evidence only. | Runner tests cover phase policy, credential materialization, redaction, and bounded artifacts. Scheduling, approval, retry, ledger commit/current pointer, Offering, billing, Host, and Resource lifecycle remain outside the runner contract. |
| Interfaces | Provider-neutral Interface/InterfaceBinding authorization is explicit for Workspace/Capsule runtime use; ordinary OpenTofu Outputs remain ordinary values. | Secret-free projection, binding authorization, and output resolution are covered by Core/API tests; Interface rows attached to legacy Resources remain migration data. |
| Generic Offering | Takosumi Core has no Offering catalog or `OfferingSelection` authority. Existing Offering routes/stores/schema wiring are implementation conformance gaps and deletion/migration custody. | Current bootstrap/Worker composition still exposes some old projection; no new consumer may depend on it. Managed-service Offering belongs to Takoserver; Hosted may present it but cannot own it. |
| Takoform and managed Host | Takoform owns portable Form/provider semantics. A Takoserver Host owns managed Offering, Form/Resource/Deployment, installation/backend, capacity, placement, receipt, and support/commercial policy. Takosumi may carry only a Host-scoped credential through an ordinary provider call. | Historical FormRef/package evidence is retained for migration. Takosumi has no parent Host credential, provider installation, backend, capacity, WfP namespace/dispatcher, or native identity. Pairwise Host mutation/readback remains external-owner evidence. |
| Resource/Form lifecycle | Resource Shape, Form Registry, FormActivation, TargetPool, SpacePolicy, same-origin compatibility/transition injection, and Resource lifecycle are migration-only/delete custody. | Current bootstrap/Worker still contains some paths and injection points; default edge is `404`, and the authenticated bounded read/observe/delete drain is the only allowed Core legacy window. Provider mutation, if unavoidable, belongs to a one-time operator migration tool outside Core. This is not current authoring conformance. |
| Legacy edge | With `TAKOSUMI_LEGACY_RESOURCE_DRAIN_ENABLED=1` plus authenticated control-plane configuration, only bounded list/read/events/observe/delete and TargetPool/SpacePolicy `GET`/`HEAD`/`DELETE` are available; unknown/disabled paths are `404`, retired operations `410`. | Route tests assert no discovery and no writes. Drain data needs inventory-zero, backup/restore, and deletion evidence before storage removal. |
| Deploy boundary | Ordinary Worker deploy is for the Takosumi platform Worker. Managed customer `ModuleWorker`, Workers for Platforms namespace, and dispatcher belong to Takoserver Host. | Takosumi deploy checks cover its own artifact and post-conditions; Host and Hosted have independent owner gates. A task or green check is not deploy authorization. |

## Historical compatibility posture

Old Resource IDs, state rows, Run rows, exact FormRef/package evidence, and old
Offering rows may be read or transitioned for migration. A passing compatibility
test does not promote the old API, Form Registry, FormActivation, TargetPool,
SpacePolicy, or Generic Offering into current OSS ownership. New work uses the
Git/OpenTofu Stack flow, the five Core modules, and explicit Interfaces where
runtime authorization is required.
