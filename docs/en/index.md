# Takosumi

Takosumi is an **OSS control plane that manages the OpenTofu Capsule DAG directly under a Space**. Users install OpenTofu Capsules from any Git URL into a Space (`@handle`). Takosumi normalizes each Capsule so it can be called as a child module, wraps it in a generated root, runs OpenTofu plan / apply / destroy, and manages state generations, outputs, the dependency DAG between Installations, credentials, artifacts, activity, and billing mode.

OpenTofu configuration is the resource definition. Takosumi does not require a custom manifest or a second infrastructure definition format. It records the Git URL, commit, module path, OpenTofu provider lock, Compatibility Report, `tofu plan`, `tofu output -json`, and Run ledger.

The completed canonical specification is [Core spec](../core-spec.md). Current implementation conformance and candidate extensions are tracked separately in [Core conformance](../core-conformance.md).

## What Takosumi does

1. An operator configures Provider Templates, operator default connections (Takosumi-managed hosted providers start Cloudflare-only), and the billing mode (`disabled` / `showback` / `enforce`).
2. A user or the dashboard registers a Git URL as a Source and creates a Capsule Installation directly under a Space (`@space/name`).
3. Compatibility Check pins the SourceSnapshot and runs the Capsule Normalizer and Capsule Gate, producing Ready / Auto-capsulized / Needs patch / Unsupported.
4. A Plan Run pins the DependencySnapshot and base StateSnapshot generation, creates the generated root, mints provider credentials, and runs `tofu plan -out=tfplan` plus `tofu show -json`.
5. Policy evaluates the Compatibility Report and plan JSON through provider / module source / data source / resource allowlists, action policy, dependency policy, output policy, quota, and billing reservation.
6. Plans that need approval (destroy, destructive changes) are approved before apply. Apply only ever executes the saved plan after verifying the plan digest, source snapshot, compatibility report, dependency snapshot, and state generation.
7. A successful apply advances the StateSnapshot generation, records an OutputSnapshot (spaceOutputs / publicOutputs; raw stays an encrypted artifact) and a Deployment, finalizes UsageEvent / CreditReservation records, and marks downstream Installations stale.

The runner-backed Capsule Normalizer / Capsule Gate, Compatibility Report plan/apply guards, root-only provider credential minting, Cloudflare / AWS TTL evidence, billing showback/enforce, and the basic meter reconciliation paths are implemented. Provider Templates / Provider Env Set are the canonical two-kind provider model.

## What Takosumi is not

Takosumi is not a replacement for OpenTofu. OpenTofu remains the source of truth for resource graphs, provider schemas, state operations, and plan/apply semantics.

Takosumi has Provider Templates, but it is not a replacement registry for the OpenTofu provider ecosystem. Provider credentials are either Takosumi-managed or user env sets held by Connections / vault. ProviderBindings only resolve Installation capabilities to `default`, `connection`, `manual`, or `disabled`.

## Public surface

| Concept              | Meaning                                                                                                                                       |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Space                | Owner namespace (`@handle`) close to a GitHub user/org                                                                                        |
| Source               | Registered git origin yielding immutable SourceSnapshots                                                                                      |
| Connection           | External credential (operator or space scope), selected by ProviderBinding                                                                   |
| ProviderBinding      | Per-provider binding resolving provider source / optional alias as default / connection / manual / disabled                                  |
| Provider Templates   | Provider source, credential sources, recommended env names, and helper metadata; Takosumi-managed hosted providers start Cloudflare-only             |
| Provider Env Set     | Space-owned env credential set for arbitrary OpenTofu providers; values are write-only and public APIs return envNames only                    |
| OpenTofu Capsule     | A Git-hosted OpenTofu module-compatible configuration; the Normalizer / Gate writes a supporting Compatibility Report before generated-root execution |
| Installation         | The Capsule + generated root + StateSnapshot + OutputSnapshot + Deployment unit directly under a Space, configured by an InstallConfig        |
| DeploymentProfile    | Installation/environment ProviderBinding set resolving provider source / optional provider alias to Connections                                      |
| Dependency           | Producer-outputs -> consumer-inputs DAG edge, pinned by a DependencySnapshot at plan time                                                     |
| Run                  | One execution (source_sync / compatibility_check / plan / apply / destroy_plan / destroy_apply / drift_check / backup / restore)              |
| RunGroup             | Orchestration record that orders DAG-wide Space or Installation updates into multiple Runs                                                    |
| Deployment           | Successful apply ledger record (active -> superseded / destroyed)                                                                             |
| OutputSnapshot       | The `tofu output -json` generation, projected into spaceOutputs / publicOutputs                                                               |
| Billing              | Space-scoped credit / usage ledger: `disabled` hides it, `showback` records without blocking, and `enforce` gates apply by credit reservation |
| Activity             | The Space-scoped audit trail                                                                                                                  |

Start with the [Quickstart](./getting-started/quickstart.md).
