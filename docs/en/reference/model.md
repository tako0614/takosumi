# Model

Takosumi's data model is the **OpenTofu Capsule DAG directly under a Space**. The canonical source is
[`core-spec.md`](../../core-spec.md). The contract source of truth is
`packages/schema/src/*.ts`; where this page conflicts, the schema and spec win.

```text
Space
  └─ Installation (= Capsule + generated root + tfstate + outputs)
       Source / SourceSnapshot
       CapsuleCompatibilityReport
       InstallConfig / DeploymentProfile (CapabilityBindings)
       Dependency ──▶ (producer→consumer DAG edge)
       Run (+ RunGroup)
       StateSnapshot / OutputSnapshot
       Deployment
       Activity
```

## Space / Source / Connection

- **Space** is an owner namespace (`@handle`) holding members, sources,
  connections, installations, the dependency graph, policy, activity, and optional billing. A personal Space is
  auto-created on first login.
- **Source** is a Space-scoped Git repository registration (`url` / `defaultRef` /
  `defaultPath` / optional `authConnectionId`). Core is GitHub-agnostic: repository identity is only a `GitAddress`
  (`{ url, ref, path, credentialId? }`), and user repos carry no Takosumi manifest.
- **SourceSnapshot** pins a ref to a `resolvedCommit` as an immutable
  archive. A `source_sync` run performs the `git ls-remote` → archive → digest → R2_SOURCE write inside the Runner
  Container; the worker only records the result.
- **Connection** is an external connection (Git HTTPS token / Git SSH key /
  Cloudflare API token / AWS assume-role / static / manual) at `operator` (instance-wide default) or `space` scope.
  Credential values are stored encrypted as SecretBlobs and never appear in the public ledger.
- **CapabilityBinding** is how an Installation binds each
  capability (`source` / `compute` / `dns` / `storage` / `database` / `secrets`) to a mode: `default` (resolve to the
  operator default), `connection` (an explicit Connection), `manual` (inline values), or `disabled`. The per-Installation
  binding map lives on the `DeploymentProfile`.

## Installation / InstallConfig

An **OpenTofu Capsule** is a Git-hosted OpenTofu module-compatible configuration. Takosumi normalizes a SourceSnapshot,
gates it, and calls it as a child module from a generated root. Compatibility is `ready` / `auto_capsulized` /
`needs_patch` / `unsupported`.

An **Installation** is the OpenTofu execution unit directly under a Space
(`@space/name`; one Installation = Capsule + generated root + tfstate + outputs). An Installation carries an
environment, and `UNIQUE(space_id, name, environment)` protects its execution namespace within the Space. It carries current
pointers: `currentDeploymentId` / `currentStateGeneration` (the generation-guard cursor) / `currentOutputSnapshotId`.
Status is `pending` / `active` / `stale` / `error` / `disabled` / `destroyed`.

An **InstallConfig** is the service-side DB config for Capsule execution: trust level (`official` / `trusted` / `space` /
`raw`), `modulePath`, `normalization`, variable mapping, output allowlist, and policy. Public behavior is always
Capsule + generated root.

## Dependency / DependencySnapshot

A **Dependency** is a DAG edge from a producer Installation's outputs to
a consumer's inputs; the canonical store is the D1 ledger. Modes:

- `variable_injection` (standard): read the producer OutputSnapshot and generate the consumer's `.auto.tfvars.json`.
- `remote_state` (same-Space only): materialize the producer state read-only for `terraform_remote_state`.
- `published_output` (cross-Space): inject as variables via an OutputShare.

A **DependencySnapshot** pins the dependency inputs at plan time. Each
entry records the producer's `stateGeneration` / `outputSnapshotId` / `outputDigest` / `valuesDigest` and the pinned
`values`. Mode is `strict` (production default — apply fails if the producer state generation moved since plan) or
`pinned` (preview / dev default). Apply verifies this snapshot (invariant 9).

## Run + RunGroup

A single **runs ledger** records every execution, with the kind in `type`.
`type`: `source_sync` / `compatibility_check` / `plan` / `apply` / `destroy_plan` / `destroy_apply` /
`drift_check` / `backup` / `restore`. `status`: `queued` / `running` / `waiting_approval` / `succeeded` / `failed` /
`cancelled` / `expired`.

A Run pins / records `sourceSnapshotId` / `dependencySnapshotId` / `baseStateGeneration` / `planDigest` /
`planArtifactKey` / `policyStatus` (`pass` / `warn` / `deny`). Installation-bound Runs carry `installationId`; Source
sync creates a SourceSnapshot for later Installation runs.

What the Run projection means per `type`:

- **compatibility-kind** (`compatibility_check`): pin the SourceSnapshot and persist the Normalizer /
  no-credential init/scan / Gate result as a CapsuleCompatibilityReport. No provider credentials are minted.
- **plan-kind** (`plan` / `destroy_plan`): pin SourceSnapshot + DependencySnapshot and persist a plan artifact; an
  approval gate leaves the Run `waiting_approval`. Success changes no infrastructure.
- **apply-kind** (`apply` / `destroy_apply`): always execute a saved plan, verifying plan digest / source snapshot /
  dependency snapshot / state generation first (invariants 6-10). Destroy is 2-phase (`destroy_plan` → approval →
  `destroy_apply`, invariant 16).

A **RunGroup** orders multiple Runs across the DAG (e.g. a Space update after stale
propagation). `type`: `space_update` / `installation_install` / `installation_update` / `installation_destroy` /
`migration`. `graphJson` records the planned order.

## Generation guard

Each Installation's tfstate generation is a **StateSnapshot**. The
encrypted object lives in R2_STATE at `.../envs/{environment}/states/{generation:8 digits}.tfstate.enc`. The runner
writes the state object before updating `current.json`; if only the pointer write fails, the next restore reconciles
`current.json` from the latest generation object that carries digest metadata. `UNIQUE(installation_id, environment,
generation)` is the guard:

```text
plan:  baseStateGeneration = currentStateGeneration
apply: reject unless currentStateGeneration == plan.baseStateGeneration
```

A successful apply increments the generation by one and writes a new StateSnapshot.

## OutputSnapshot projection

After apply, `tofu output -json` is captured into an **OutputSnapshot**
projected into three lanes:

- `rawOutputArtifactKey` — raw outputs stay an **encrypted artifact** (R2_ARTIFACTS); the ledger keeps only the key.
- `spaceOutputs` — the projection consumed by same-Space dependencies.
- `publicOutputs` — the projection for UI / install summary / external display.

Projection runs sensitive-flag check → InstallConfig `outputAllowlist` → type validation. Sensitive values enter
neither projection without explicit policy (invariants 11-12), and cross-Space sharing always goes through an
**OutputShare**. `outputDigest` is a digest over the projected outputs and drives stale propagation.

## Deployment

A **Deployment** is the immutable record of a successful apply, referencing
`applyRunId` / `sourceSnapshotId` / `dependencySnapshotId` / `stateGeneration` / `outputSnapshotId` and the published
`outputsPublic`. A failed apply never becomes a Deployment. Status transitions:

```text
active ─▶ superseded     (a later apply takes the current pointer)
active ─▶ rolled_back    (after a rollback apply)
active ─▶ destroyed       (after destroy_apply)
```

The current Deployment pointer is stored on the Installation.

## Activity

**Activity** (`audit_events`) is the Space-scoped public audit trail. It records
actions such as `installation.created` / `run.plan_created` / `run.applied` / `dependency.created` /
`installation.stale` / `run_group.created`. It records what happened, never credential values or resolved output
values, and is a distinct public projection from the redacted internal run-level trace.

See [`core-spec.md`](../../core-spec.md) for full detail. Run execution flow lives under
[Internal execution profiles](./runner-profiles.md).
