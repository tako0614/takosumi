# Update Summary

Takosumi v1 is:

```text
invariant-first
space-isolated
snapshot-backed
graph-shaped
write-ahead-operation-journaled
```

Manifest plus Space context become immutable snapshots. Snapshots feed an
OperationPlan that executes through a write-ahead journal. Reality is tracked
through Space-scoped observation, drift, debt, and activation records. The
public manifest vocabulary is closed and unchanged.

## v1 finalization additions

### Architecture

- **Link mutation × state transition matrix.**
  [Link and Projection Model](./link-projection-model.md) closes the v1 mutation
  set
  (`rematerialize / reproject / regrant / rewire / revoke / retain-generated / no-op / repair`)
  and locks the full transition matrix. Collision rules use a deterministic
  precedence list and surface the `collision-detected` Risk.
- **Object revoke flow.** [Object Model](./object-model.md) defines the
  `live → revoking → revoked → debt` flow and a Revoke participation matrix.
  `external` and `operator` lifecycle classes never enter revoke as the target;
  only their generated children do.
- **Target enums.** [Target Model](./target-model.md) defines a fail-closed
  selection algorithm, a closed mutation-constraint enum
  (`immutable / replace-only / in-place / append-only / ordered-replace / reroute-only`),
  and the canonical access-mode enum
  (`read / read-write / admin / invoke-only / observe-only`).
- **DataAsset connector + transform enforcement.**
  [DataAsset Model](./data-asset-model.md) defines the `connector:<id>`
  contract, accepted-kinds vector, and operator-only installation. Transform
  approval is enforced in the `pre-commit` WAL stage and surfaces the
  `transform-unapproved` Risk.
- **WAL stage enumeration + idempotency.**
  [Operation Plan and Write-ahead Journal Model](./operation-plan-write-ahead-journal-model.md)
  closes the stage enum
  (`prepare → pre-commit → commit → post-commit → observe → finalize`, terminal
  `abort` / `skip`), defines the
  `(spaceId, operationPlanDigest, journalEntryId)` idempotency key tuple, and
  the pre/post-commit hook contract.
- **Exposure post-activate health state.**
  [Exposure and Activation Model](./exposure-activation-model.md) defines the
  `unknown / observing / healthy / degraded / unhealthy` state machine and the
  `sourceObservationDigest` field on ActivationSnapshot. `unhealthy` annotates
  but never rewrites desired state.
- **RevokeDebt schema and propagation.**
  [Observation, Drift, and RevokeDebt Model](./observation-drift-revokedebt-model.md)
  closes the RevokeDebt schema, the `reason` and `status` enums, the multi-Space
  ownership rule (importing Space owns; exporting Space gets a read-only
  mirror), and the fail-safe-not-fail-closed propagation into
  ActivationSnapshot.
- **SpaceExportShare lifecycle.** [Space Model](./space-model.md) defines the
  `draft / active / refresh-required / stale / revoked` lifecycle, TTL refresh,
  and the `stale-export` Risk.
- **Risk and Approval enums closed.**
  [Policy, Risk, Approval, and Error Model](./policy-risk-approval-error-model.md)
  closes the v1 Risk enum (19 entries, including `collision-detected` and
  `transform-unapproved`) and lists the six Approval invalidation triggers.
- **Dry materialization + approval carry.**
  [Execution Lifecycle](./execution-lifecycle.md) records that approvals bind to
  `predictedActualEffectsDigest`, and apply re-validates that digest at
  `pre-commit`.

### Reference

- **kernel-http-api.md** locks the public + internal HTTP surface, the Ed25519
  gateway-manifest signing contract, the closed error envelope
  `{ code, message, requestId, details? }` (with `requestId` always present),
  and the `DomainErrorCode` 9-value HTTP status map.
- **runtime-agent-api.md** locks
  `/v1/lifecycle/{apply, describe, destroy, verify}`, the `LifecycleStatus`
  5-state machine, and the `LifecycleErrorBody` closed enum with the
  `connector-extended:` prefix reserved for connector-side codes.
- **lifecycle.md** locks the production cross-process lock requirement
  (SQL-backed store mandatory; in-memory store dev-only), the phase-to-WAL-stage
  mapping, and the recovery mode set
  (`normal / continue / compensate / inspect`).
- **providers.md** locks the open-string + reserved-prefix capability vocabulary
  (`takos.* / system.* / operator.*`) and the v1 provider table.
- **shapes.md** locks the v1 shape catalog, outputFields reserved names, and the
  capability extension guide.
- **templates.md** locks `registerTemplate`, the expand result immutability
  contract, and the v1 bundled template expansions.
- **artifact-kinds.md** locks the bundled DataAsset kind registry,
  `registerArtifactKind` collision policy, and global / per-kind upload size
  enforcement.
- **env-vars.md** locks the v1 env-var catalog by target (kernel / CLI /
  runtime-agent) and the migration policy for stale selector keys.
- **cli.md** locks command surfaces, the closed config-file YAML schema, exit
  codes, and the deprecation policy.

### Surface architecture layer

- **API Surface Architecture.**
  [API Surface Architecture](./api-surface-architecture.md) closes the kernel
  HTTP boundary: the four-surface split (public deploy / internal control /
  runtime-agent RPC / artifact upload), the four-credential blast-radius model,
  the closed error envelope philosophy with mandatory `requestId`, the `/v1/`
  versioning policy, the cursor-only pagination rule, the OpenAPI export scope,
  and the Ed25519 gateway-manifest signing architecture.
- **CLI Surface Architecture.**
  [CLI Surface Architecture](./cli-companion-architecture-note.md) (formerly the
  CLI Companion Design Note) is now the v1 surface authority for the CLI: the
  local vs remote authority split, command verb rationale, config cascade,
  output formats (no streaming), the sysexits-aligned exit code regime,
  deprecation policy, security boundary, and the CLI ↔ kernel responsibility
  split.
- **Implementation and Runtime-Agent Boundary.**
  [Implementation and Runtime-Agent Boundary](./implementation-operation-envelope.md)
  (formerly Implementation Operation Envelope) closes the kernel ↔ runtime-agent
  contract: packaging freedom, operation envelope and result, effect rule, dry
  materialization with predicted-digest binding, the four recovery modes, the
  idempotency contract, the connector-vs-implementation split, verify semantics,
  the Ed25519 signature chain direction, and partial-failure / RevokeDebt
  failure modes.
- **PaaS Provider Architecture.**
  [PaaS Provider Architecture](./paas-provider-architecture.md) closes the
  multi-tenant operating concerns: deployment topology (single-operator +
  multi-Space tenant model), tenant isolation invariants, billing-readiness
  signals, the three-tier supply chain trust (CatalogRelease / Connector /
  Implementation), the operator UX surface map, SLA observable surfaces, and the
  disaster-recovery boundary.
- **Approval flow architecture.**
  [Policy, Risk, Approval, and Error Model](./policy-risk-approval-error-model.md)
  now records the approver UX states, plan-level approval batching, invalidation
  propagation rules (digest-trigger short-circuit), and cross-Space approval
  ownership rules.
- **Observability architecture.**
  [Observation, Drift, and RevokeDebt Model](./observation-drift-revokedebt-model.md)
  now records the four-layer audit retention architecture (ObservationSet /
  ObservationHistory / OperationJournal / AuditLog), drift propagation along
  DriftIndex → ActivationSnapshot → status → approval invalidation, RevokeDebt
  aging rules, and the ObservationHistory opt-in policy.

## Round 4 finalization additions (Workflow extension)

- **Workflow primitive reservation withdrawn.**
  [Workflow Placement Rationale](./workflow-extension-design.md) (formerly
  "Workflow Extension Design") records the policy reversal: the kernel **does
  not** reserve trigger / `execute-step` / declarable-hook / trigger-resource
  binding primitives. Workflow / cron / hook 等の機能は kernel に built-in
  せず、`POST /v1/deployments` 境界の上位 sibling product `takosumi-git` が
  webhook receiver / scheduler / artifact build / manifest generation として
  実装する。Earlier drafts that reserved 4 kernel primitives are explicitly
  withdrawn.
- **Triggers / Execute-Step / Declarable Hooks docs deprecated.**
  [Triggers](/reference/triggers),
  [Execute-Step Operation](/reference/execute-step-operation), and
  [Declarable Hooks](/reference/declarable-hooks) carry deprecation banners
  pointing back to Workflow Placement Rationale. The kernel ships none of these
  primitives; the docs are retained as historical design context and scheduled
  for removal in a follow-up cleanup.
- **Operation kind enum unchanged at 11 values.** `transform-data-asset` remains
  the sole DataAsset-bundle dispatch operation. The previously proposed 12th
  value (`execute-step`) is not added.
- **CLI project layout.** `.takosumi/manifest.yml` を CLI default load path
  に追加 ([CLI Reference](/reference/cli) Project Layout section)。 `.takosumi/`
  ディレクトリ配下の workflow definition 等は `takosumi-git` が parse /
  実行する; kernel 側は manifest 以外を参照しない。
- **Plugin shape examples.** workflow / cron-job / pre-apply-hook 等の shape は
  kernel curated 5 種に含めず、3rd party plugin が CONVENTIONS.md §6 RFC で提供
  ([Extending](/extending), [Shape Catalog](/reference/shapes))。kernel-known な
  workflow shape (`resource-workflow-v1` 等) は提供しない方針に整理。

## Closure statement

Public manifest vocabulary unchanged. No new shapes in kernel curated catalog.
Reference docs locked at v1. Workflow / cron / hook 関連の機能は kernel から
**完全に分離** され、`takosumi-git` (上位 sibling product) が
`POST /v1/deployments` の client として実装する。Contract / kernel / CLI
realignment to bring the type and runtime layers into agreement with the
v1-locked docs is tracked in a separate follow-up plan that consumes the docs in
this directory as the single source of truth.
