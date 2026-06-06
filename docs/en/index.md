# Takosumi

Takosumi is an **OSS control plane that manages the OpenTofu Installation DAG directly under a Space**. Users install Services from any Git URL into a Space (`@handle`); Takosumi manages plan / apply / destroy runs, state generations, outputs, the dependency DAG between Installations, credentials, and the audit trail.

OpenTofu configuration is the resource definition. Takosumi does not introduce a second infrastructure definition format. It records Git identity, source digest, variables digest, plan policy, plan digest, apply result, ledger entries, and projected OpenTofu outputs.

## What Takosumi does

1. An operator sets the operator default connections (compute / dns / storage / source).
2. A user or the dashboard registers a Git URL as a Source and creates an Installation directly under a Space (`@space/name`).
3. Takosumi creates a plan Run, pins the SourceSnapshot and DependencySnapshot, and evaluates the plan JSON through the policy layers (provider / resource allowlists, action policy).
4. Plans that need approval (destroy, destructive changes) are approved before apply. Apply only ever executes the saved plan after verifying the plan digest, source snapshot, dependency snapshot, and state generation.
5. A successful apply advances the StateSnapshot generation, records an OutputSnapshot (spaceOutputs / publicOutputs; raw stays an encrypted artifact) and a Deployment, and marks downstream Installations stale.

## Public surface

| Concept | Meaning |
| --- | --- |
| Space | Owner namespace (`@handle`) close to a GitHub user/org |
| Source | Registered git origin yielding immutable SourceSnapshots |
| Connection | External credential (operator or space scope), bound per capability via CapabilityBinding |
| Installation | The OpenTofu root/state unit directly under a Space, configured by an InstallConfig |
| Dependency | Producer-outputs -> consumer-inputs DAG edge, pinned by a DependencySnapshot at plan time |
| Run | One execution (source_sync / plan / apply / destroy_plan / destroy_apply); RunGroup orders DAG-wide updates |
| Deployment | Successful apply ledger record (active -> superseded / destroyed) |
| OutputSnapshot | The `tofu output -json` generation, projected into spaceOutputs / publicOutputs |
| Activity | The Space-scoped audit trail |

Start with the [Quickstart](./getting-started/quickstart.md).
