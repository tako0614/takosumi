# Model

Takosumi's data model is the **OpenTofu Capsule DAG directly under a Space**. The canonical source is
[`core-spec.md`](../../core-spec.md). `packages/schema/src/*.ts` represents the currently implemented public contract
subset; differences from the canonical spec are tracked as implementation gaps in
[`core-conformance.md`](../../core-conformance.md).

```text
Takosumi Instance
  ├─ Provider Templates
  └─ Space
       ├─ Source / SourceSnapshot
       ├─ Connection
       ├─ Provider Env Set
       └─ Installation (= Capsule + generated root + tfstate + outputs)
            CapsuleCompatibilityReport
            InstallConfig / DeploymentProfile / ProviderBinding resolution
            Dependency ──▶ (producer→consumer DAG edge)
            Run (+ RunGroup)
            StateSnapshot / OutputSnapshot
            Deployment
            Activity
```

## Space / Source / Provider / Connection

- **Space** is an owner namespace (`@handle`) holding members, sources,
  connections, installations, the dependency graph, policy, activity, and optional billing. A personal Space is
  auto-created on first login.
- **Source** is a Space-scoped Git repository registration (`url` / `defaultRef` /
  `defaultPath` / optional `authConnectionId`). Core is GitHub-agnostic: repository identity is only a `GitAddress`
  (`{ url, ref, path, credentialId? }`), and user repos carry no Takosumi-specific manifest.
- **SourceSnapshot** pins a ref to a `resolvedCommit` as an immutable
  archive. A `source_sync` run performs the `git ls-remote` → archive → digest → R2_SOURCE write inside the Runner
  Container; the worker only records the result.
- **Provider Template** is a read-only template mapping an OpenTofu provider source to credential sources, recommended env
  names, helper flows, and policy. The only user-facing credential sources are `takosumi_managed` and `user_env_set`.
  Hosted Takosumi starts with Cloudflare as the only Takosumi-provided managed default.
- **Provider Env Set** is a Space-owned Connection kind. AWS / GCP / Cloudflare / GitHub / Kubernetes / arbitrary
  providers provide write-only env values, and the Vault mints them per run / phase / provider. OAuth, AssumeRole,
  and impersonation are helper flows for creating, updating, or minting env sets, not a third provider kind.
- **Connection** is a Git credential or provider credential. Provider credentials come from Takosumi-provided defaults
  or Space-owned `user_env_set`; OAuth / AssumeRole / impersonation / token vending are helper flows that create,
  update, or mint those Connections, not credential sources. Scope is `operator` (instance-wide default) or `space`.
  Credential values are stored encrypted as SecretBlobs and never appear in the public ledger. Status is
  `pending` / `verified` / `revoked` / `expired` / `error`. A Connection with `expiresAt` fails closed on mint/test after
  expiry, and an in-window mint records TTL evidence in the audit ledger.
- **ProviderBinding** is how an Installation binds each
  OpenTofu provider source and optional alias to a mode: `default` (resolve to the
  operator default), `connection` (an explicit Connection), `manual` (inline values), or `disabled`. The per-Installation
  binding list is resolved as Installation-scoped internal config. ProviderBinding is fail-closed: `manual`, `disabled`, and
  default-missing provider bindings do not fall back to Space-wide provider connections; they stop plan/apply/destroy.
- **DeploymentProfile** is the Installation/environment-scoped set of ProviderBindings used to resolve provider bindings to
  Space-owned Connections or operator default connections.

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
`PolicyConfig.providerCredentials` evaluates credential mint audit evidence before runner dispatch. Operator managed
defaults require temporary / TTL evidence where the provider supports it. Space-owned Connections may use static tokens
when the provider or driver requires that shape, but only behind ProviderBinding, Connection policy, Custom Provider
template policy, egress policy, and runner-class controls. Enabling `requireRootOnly` rejects mints without
root-only evidence. The runner does not place shared provider env payloads or ambient provider env into the tofu
environment; it admits only generated-root `TF_VAR_<provider>_<alias>_<arg>` values.
Unknown providers are not runnable until a Space-owned provider env set plus provider allowlist / lockfile / mirror
policy, egress policy, and runner policy are satisfied.

## Dependency / DependencySnapshot

A **Dependency** is a DAG edge from a producer Installation's outputs to
a consumer's inputs; the canonical store is the D1 ledger. Modes:

- `variable_injection` (standard): read the producer OutputSnapshot and generate the consumer's `.auto.tfvars.json`.
- `remote_state` (same-Space only): materialize the plan-pinned producer StateSnapshot read-only for `terraform_remote_state`.
- `published_output` (cross-Space): inject as variables via an OutputShare.

A **DependencySnapshot** pins the dependency inputs at plan time. Each
entry records the producer's `stateGeneration` / `outputSnapshotId` / `outputDigest` / `valuesDigest` and the pinned
`values`. For a `remote_state` edge it also pins the producer `stateSnapshotId`, state object key, and state digest.
Mode is `strict` (production default — apply fails if the producer state generation moved since plan) or `pinned`
(preview / dev default). Apply verifies this snapshot and restores the plan-pinned state bytes, not the producer's
latest state.

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
  compatibility report / dependency snapshot / state generation first. Destroy is 2-phase (`destroy_plan` → approval →
  `destroy_apply`).

A **RunGroup** orders multiple Runs across the DAG (e.g. a Space update after stale propagation / Space drift check).
`type`: `space_update` / `space_drift_check` / `installation_install` / `installation_update` /
`installation_destroy` / `migration`. `graphJson` records the planned order.

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
neither projection without explicit policy, and cross-Space sharing always goes through an
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

## Billing

Billing is a Space-scoped ledger. `BillingSettings.mode` is `disabled` / `showback` / `enforce`, and `BillingPlan` has
typed `BillingPlanLimits` (`maxEstimatedCreditsPerRun` / `quota`). Plan completion evaluates the active
`SpaceSubscription`'s plan limits: `enforce` blocks before creating a reservation when a limit is exceeded, while
`showback` records the exceeded limit as audit evidence and continues. Apply verifies the `CreditReservation` before
credential mint, captures a `UsageEvent` on success, and releases the reservation on failure. Managed resource meters
record period-scoped `managed_compute` / storage / artifact / backup / egress `UsageEvent`s idempotently.

## Activity

**Activity** (`audit_events`) is the Space-scoped public audit trail. It records
actions such as `installation.created` / `run.plan_created` / `run.applied` / `dependency.created` /
`installation.stale` / `run_group.created`. It records what happened, never credential values or resolved output
values, and is a distinct public projection from the redacted internal run-level trace.

See [`core-spec.md`](../../core-spec.md) for full detail. Run execution flow lives under
[Operator execution boundaries](./operator-execution-boundaries.md).
