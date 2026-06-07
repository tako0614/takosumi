# Takosumi

Takosumi is an **OSS control plane that manages the OpenTofu Capsule DAG directly under a Space**. Users install OpenTofu Capsules from any Git URL into a Space (`@handle`). Takosumi normalizes each Capsule so it can be called as a child module, wraps it in a generated root, runs OpenTofu plan / apply / destroy, and manages state generations, outputs, the dependency DAG between Installations, credentials, artifacts, activity, and billing mode.

OpenTofu configuration is the resource definition. Takosumi does not require a custom manifest or a second infrastructure definition format. It records the Git URL, commit, module path, OpenTofu provider lock, Compatibility Report, `tofu plan`, `tofu output -json`, and Run ledger.

The completed canonical specification is [Core spec](../core-spec.md). Current implementation conformance and open gaps are tracked separately in [Core conformance](../core-conformance.md).

## What Takosumi does

1. An operator sets the operator default connections (compute / dns / storage / source) and the billing mode (`disabled` / `showback` / `enforce`).
2. A user or the dashboard registers a Git URL as a Source and creates a Capsule Installation directly under a Space (`@space/name`).
3. Compatibility Check pins the SourceSnapshot and runs the Capsule Normalizer and Capsule Gate, producing Ready / Auto-capsulized / Needs patch / Unsupported.
4. A Plan Run pins the DependencySnapshot and base StateSnapshot generation, creates the generated root, mints provider credentials, and runs `tofu plan -out=tfplan` plus `tofu show -json`.
5. Policy evaluates the Compatibility Report and plan JSON through provider / module source / data source / resource allowlists, action policy, dependency policy, output policy, quota, and billing reservation.
6. Plans that need approval (destroy, destructive changes) are approved before apply. Apply only ever executes the saved plan after verifying the plan digest, source snapshot, compatibility report, dependency snapshot, and state generation.
7. A successful apply advances the StateSnapshot generation, records an OutputSnapshot (spaceOutputs / publicOutputs; raw stays an encrypted artifact) and a Deployment, finalizes UsageEvent / CreditReservation records, and marks downstream Installations stale.

Runner-backed Capsule Normalizer / Capsule Gate, Compatibility Report apply guards, and billing enforcement are still being implemented. The entry docs describe the completed contract; conformance tracks the current implementation gaps.

## What Takosumi is not

Takosumi is not a replacement for OpenTofu. OpenTofu remains the source of truth for resource graphs, provider schemas, state operations, and plan/apply semantics.

Takosumi is not a provider adapter registry. Connections, CapabilityBindings, policy, and operator configuration decide which providers and credentials can be used.

## Public surface

| Concept | Meaning |
| --- | --- |
| Space | Owner namespace (`@handle`) close to a GitHub user/org |
| Source | Registered git origin yielding immutable SourceSnapshots |
| Connection | External credential (operator or space scope), bound per capability via CapabilityBinding |
| OpenTofu Capsule | A Git-hosted OpenTofu module-compatible configuration normalized and called from a generated root |
| Compatibility Report | Capsule Normalizer / Capsule Gate result with Ready / Auto-capsulized / Needs patch / Unsupported and findings |
| Installation | The Capsule + generated root + StateSnapshot + OutputSnapshot + Deployment unit directly under a Space, configured by an InstallConfig |
| Dependency | Producer-outputs -> consumer-inputs DAG edge, pinned by a DependencySnapshot at plan time |
| Run | One execution (source_sync / compatibility_check / plan / apply / destroy_plan / destroy_apply); RunGroup orders DAG-wide updates |
| Billing | Space-scoped credit / usage ledger: `disabled` hides it, `showback` records without blocking, and `enforce` gates apply by credit reservation |
| Deployment | Successful apply ledger record (active -> superseded / destroyed) |
| OutputSnapshot | The `tofu output -json` generation, projected into spaceOutputs / publicOutputs |
| Activity | The Space-scoped audit trail |

Start with the [Quickstart](./getting-started/quickstart.md).
