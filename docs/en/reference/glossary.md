# Glossary {#glossary}

---

## Public Concepts

### Manifest

The `.takosumi.yml` declarative file at the source root (code: `AppSpec`).

### Component

An execution unit inside a manifest. Public fields are `kind`, `spec`, `publish`, and `listen` (4 fields).

### Kind

The component type discriminator. The operator resolves a short alias or URI to a kind definition and an implementation binding via `kindAliases`.

### Installation

A manifest record in a Space. Holds a current Deployment pointer.

### Deployment

One apply result. Used for history, audit, and rollback. Rollback moves the current pointer back to a previous Deployment and does not create a new Deployment.

### Space

The isolation unit that contains Installations. Not written in the manifest.

### Source

The source tree containing the manifest. Source kinds passed to the Installer API: `git`, `prepared`, or `local`.

### apply

The operation that updates an Installation after dry-run. Applies manifest source to an Installation and records a Deployment.

### expected guard

The hash check from dry-run that verifies the reviewed source has not changed at apply time. Returned by dry-run as the reviewed-source guard. Passing it to apply rejects a different source with 409. Deploy expected guards also include `currentDeploymentId` so apply can reject base-pointer drift.

### publish / listen

Component connection language. A producer offers output with `publish`; a consumer receives output with `listen`.

### dry-run

Validation without apply. It returns planned changes and expected guards (hash checks). Two endpoints.

### Build service handoff

The convention where build service or CI prepares a source archive outside the manifest and submits it as `source.kind: "prepared"`.

### Current Pointer

The succeeded Deployment currently selected by an Installation. The Installer API field is `currentDeploymentId`; rollback moves this pointer back to an earlier succeeded Deployment.

### Prepared Source

A pre-built archive produced by CI or a build service. The Installer API records the archive byte digest as prepared source identity.

### manifestDigest

The digest of the selected `.takosumi.yml` bytes.

### fail-closed

A policy that explicitly rejects unknown input or unresolved dependencies before any side effects occur.

### Operator

The party that runs Takosumi and chooses backend bindings, credentials, storage, and account management integration.

---

## Catalog & Implementation Binding

### Output type

The type of output offered by `publish.<name>.as` (code: `MaterialContract`). Examples: `http-endpoint`, `service-binding`, `object-store`.

### Injection mode

How values are delivered (`env`, `secret-env`, etc.) from `listen` to a consuming runtime. Selected by `listen.<name>.as`. Examples: `env`, `secret-env`, `config-mount`, `upstream`. `listen.<name>.mount` is used by path-based projections like `config-mount`.

### Implementation binding

The operator-side implementation that connects a kind URI and kind definition to a concrete backend runtime or resource creation/update. The mechanism for loading implementation bindings is chosen by the operator's configuration.

### Kind definition

Metadata describing a component kind's input schema, published outputs, projection capabilities, and output metadata (formerly: kind descriptor). The Takosumi Kind Catalog publishes kind definitions as JSON-LD. Runtime behavior lives in the implementation binding.

### Kind Catalog

Takosumi's reusable kind definition collection. Published at `https://takosumi.com/kinds/v1/*` as JSON-LD kind definitions. Operators opt in per Space; alternative catalogs use the same core contract.

### Platform service

Space-scoped output offered by the operator outside the manifest (formerly: external publication). Consumed through the same `listen.from` grammar.

### PlatformServiceDeclaration

The Space-scoped entry record for a platform service (code: `ExternalPublicationDeclaration`). Describes what the operator provides to a Space.

### Deployment record

The selected kind definition, implementation binding, output data, and operator records linked to a Deployment (formerly: retained evidence). Public Deployment wire exposes only source identity, manifest digest, status, and non-secret outputs. Deployment records serve as the basis for subsequent rollback, audit, and current projection.

### Account management (account layer)

The operator-side layer that handles account, billing, OIDC issuer, and customer onboarding (formerly: account-plane).

### Operator configuration (operator profile)

The bundle of kind, backend binding, and policy choices made by an operator (formerly: operator distribution). Takosumi Cloud serves as a reference operator configuration.

---

## Internal / Reference Implementation

### TrafficSnapshot

A routing assignment snapshot at activation time (code: `ActivationSnapshot`). Freezes the routing state of Installations in a Space at a single point in time.

### ObservationState

Accumulated state of runtime observations (code: `ObservationSet`). Aggregates observations reported by providers for kernel reconciliation.

### ResolvedPlan

A snapshot of the manifest resolution result (code: `ResolutionSnapshot`). Holds the result of resolving a manifest against kinds, bindings, and publications during dry-run or apply.

### TargetState

A snapshot of the desired runtime state (code: `DesiredSnapshot`). Describes the runtime state that an apply targets.

### CleanupBacklog

A management record for cleanup tasks that could not be revoked (code: `RevokeDebt`). Recorded when provider side-effect revocation fails, requiring operator action.

### RoutingPointer

A Space-local pointer to the current TrafficSnapshot (code: `GroupHead`). Points to the currently active TrafficSnapshot within a Space.

### asset

An operator extension blob storage target (code: `DataAsset`). Managed through a separate workflow from the worker kind.

### expectedEffectsDigest

The predicted effects digest from dry materialization (formerly: `predictedActualEffectsDigest`). The digest of materialization predictions returned by dry-run.

### escalation timeout

The deadline for a CleanupBacklog entry to transition to operator-action-required (formerly: aging window). After this deadline, the cleanup task transitions to a state requiring operator escalation.

### snapshot creation

The snapshot creation step during journal compaction (formerly: Snapshotization). An internal compaction process that aggregates journal entries into a snapshot.

### before resource creation/update

The fail-closed verification timing before resource creation/update begins. Rejects kind alias resolution misses and validation errors at this point, aborting the operation before any resources are created or modified.
