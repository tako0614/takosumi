# Model

Takosumi's data model is the **OpenTofu Installation DAG directly under a Space**. The canonical source is
[`core-spec.md`](../../core-spec.md) (§4-§21 are the entities, §27 the logical schema). The contract source of truth is
`packages/schema/src/*.ts`; where this page conflicts, the schema and spec win.

```text
Space
  └─ Installation (= 1 OpenTofu root/state)
       Source / SourceSnapshot
       InstallConfig / DeploymentProfile (CapabilityBindings)
       Dependency ──▶ (producer→consumer DAG edge)
       Run (+ RunGroup)
       StateSnapshot / OutputSnapshot
       Deployment
       Activity
```

## Space / Source / Connection

- **Space** ([§4](../../core-spec.md#4-space)) is an owner namespace (`@handle`) holding members, sources,
  connections, installations, the dependency graph, policy, activity, and optional billing. A personal Space is
  auto-created on first login.
- **Source** ([§6](../../core-spec.md#6-source)) is a Space-scoped Git repository registration (`url` / `defaultRef` /
  `defaultPath` / optional `authConnectionId`). Core is GitHub-agnostic: repository identity is only a `GitAddress`
  (`{ url, ref, path, credentialId? }`), and user repos carry no Takosumi manifest.
- **SourceSnapshot** ([§7](../../core-spec.md#7-sourcesnapshot)) pins a ref to a `resolvedCommit` as an immutable
  archive. A `source_sync` run performs the `git ls-remote` → archive → digest → R2_SOURCE write inside the Runner
  Container; the worker only records the result.
- **Connection** ([§8](../../core-spec.md#8-connection)) is an external connection (Git HTTPS token / Git SSH key /
  Cloudflare API token / AWS assume-role / static / manual) at `operator` (instance-wide default) or `space` scope.
  Credential values are stored encrypted as SecretBlobs and never appear in the public ledger.
- **CapabilityBinding** ([§9](../../core-spec.md#9-operator-default-connections)) is how an Installation binds each
  capability (`source` / `compute` / `dns` / `storage` / `database` / `secrets`) to a mode: `default` (resolve to the
  operator default), `connection` (an explicit Connection), `manual` (inline values), or `disabled`. The per-Installation
  binding map lives on the `DeploymentProfile`.

## Installation / InstallConfig

An **Installation** ([§5](../../core-spec.md#5-installation)) is the OpenTofu execution unit directly under a Space
(`@space/name`; one Installation = one OpenTofu root/state). The `App` / `Environment` / `InstallProfile` lanes are
retired; `environment` is a column on the Installation (`UNIQUE(space_id, name, environment)`). It carries current
pointers: `currentDeploymentId` / `currentStateGeneration` (the generation-guard cursor) / `currentOutputSnapshotId`.
Status is `installing` / `active` / `stale` / `error` / `destroying` / `destroyed`.

An **InstallConfig** ([§11](../../core-spec.md#11-installconfig)) is the service-side DB config for how a Source is
treated: install type ([§10](../../core-spec.md#10-install-type): `core` / `opentofu_module` / `opentofu_root` /
`app_source`), trust level (`official` / `trusted` / `space` / `raw`), build, variable mapping, output allowlist, and
policy.

## Dependency / DependencySnapshot

A **Dependency** ([§14](../../core-spec.md#14-dependency-graph)) is a DAG edge from a producer Installation's outputs to
a consumer's inputs; the canonical store is the D1 ledger. Modes ([§15](../../core-spec.md#15-dependency-modes)):

- `variable_injection` (standard): read the producer OutputSnapshot and generate the consumer's `.auto.tfvars.json`.
- `remote_state` (same-Space only): materialize the producer state read-only for `terraform_remote_state`.
- `published_output` (cross-Space): inject as variables via an OutputShare. `remote_state` / `published_output` are
  post-MVP.

A **DependencySnapshot** ([§17](../../core-spec.md#17-dependencysnapshot)) pins the dependency inputs at plan time. Each
entry records the producer's `stateGeneration` / `outputSnapshotId` / `outputDigest` / `valuesDigest` and the pinned
`values`. Mode is `strict` (production default — apply fails if the producer state generation moved since plan) or
`pinned` (preview / dev default). Apply verifies this snapshot (invariant 9).

## Run + RunGroup

A single **runs ledger** replaces the retired PlanRun/ApplyRun split, with the kind in `type`
([§19](../../core-spec.md#19-run)). `type`: `source_sync` / `plan` / `apply` / `destroy_plan` / `destroy_apply` /
`drift_check` / `backup` / `restore`. `status`: `queued` / `running` / `waiting_approval` / `succeeded` / `failed` /
`cancelled` / `expired`.

A Run pins / records `sourceSnapshotId` / `dependencySnapshotId` / `baseStateGeneration` / `planDigest` /
`planArtifactKey` / `policyStatus` (`pass` / `warn` / `deny`). `installationId` is NOT NULL in the spec but optional in
the contract because a `source_sync` run is Source-scoped until sources bind to Installations (see core-conformance.md).

What the §19 Run projection means per `type`:

- **plan-kind** (`plan` / `destroy_plan`): pin SourceSnapshot + DependencySnapshot and persist a plan artifact; an
  approval gate leaves the Run `waiting_approval`. Success changes no infrastructure.
- **apply-kind** (`apply` / `destroy_apply`): always execute a saved plan, verifying plan digest / source snapshot /
  dependency snapshot / state generation first (invariants 6-10). Destroy is 2-phase (`destroy_plan` → approval →
  `destroy_apply`, invariant 16).

A **RunGroup** ([§19](../../core-spec.md#19-run)) orders multiple Runs across the DAG (e.g. a Space update after stale
propagation). `type`: `space_update` / `installation_install` / `installation_update` / `installation_destroy` /
`migration`. `graphJson` records the planned order.

## Generation guard

Each Installation's tfstate generation is a **StateSnapshot** ([§20](../../core-spec.md#20-statesnapshot)). The
encrypted object lives in R2_STATE at `.../envs/{environment}/states/{generation:8 digits}.tfstate.enc` with an atomic
`current.json`. `UNIQUE(installation_id, environment, generation)` is the guard:

```text
plan:  baseStateGeneration = currentStateGeneration
apply: reject unless currentStateGeneration == plan.baseStateGeneration
```

A successful apply increments the generation by one and writes a new StateSnapshot.

## OutputSnapshot projection

After apply, `tofu output -json` is captured into an **OutputSnapshot** ([§16](../../core-spec.md#16-outputsnapshot))
projected into three lanes:

- `rawOutputArtifactKey` — raw outputs stay an **encrypted artifact** (R2_ARTIFACTS); the ledger keeps only the key.
- `spaceOutputs` — the projection consumed by same-Space dependencies.
- `publicOutputs` — the projection for UI / install summary / external display.

Projection runs sensitive-flag check → InstallConfig `outputAllowlist` → type validation. Sensitive values enter
neither projection without explicit policy (invariants 11-12), and cross-Space sharing always goes through an
**OutputShare** ([§18](../../core-spec.md#18-outputshare)) (invariant 13). `outputDigest` is a digest over the
projected outputs and drives stale propagation ([§24](../../core-spec.md#24-stale-propagation)).

## Deployment

A **Deployment** ([§21](../../core-spec.md#21-deployment)) is the immutable record of a successful apply, referencing
`applyRunId` / `sourceSnapshotId` / `dependencySnapshotId` / `stateGeneration` / `outputSnapshotId` and the published
`outputsPublic`. A failed apply never becomes a Deployment. Status transitions:

```text
active ─▶ superseded     (a later apply takes the current pointer)
active ─▶ rolled_back    (after a rollback apply)
active ─▶ destroyed       (after destroy_apply)
```

The current Deployment pointer is stored on the Installation.

## Activity

**Activity** ([§27](../../core-spec.md#27-d1-schema) `audit_events`) is the Space-scoped public audit trail. It records
actions such as `installation.created` / `run.plan_created` / `run.applied` / `dependency.created` /
`installation.stale` / `run_group.created`. It records what happened, never credential values or resolved output
values, and is a distinct type from the internal run-level trace (`DeployControlAuditEvent`).

See [`core-spec.md`](../../core-spec.md) for full detail. Run execution flow lives under
[Runner profiles](./runner-profiles.md) (the internal execution profile, §22 Runner architecture).
