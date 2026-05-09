# Closed Enums

> Stability: stable Audience: kernel-implementer See also:
> [Access Modes](/reference/access-modes),
> [Lifecycle Phases](/reference/lifecycle-phases),
> [Shape Catalog](/reference/shapes), [Provider Plugins](/reference/providers),
> [Auth Providers](/reference/auth-providers),
> [RBAC Policy](/reference/rbac-policy),
> [API Key Management](/reference/api-key-management),
> [Tenant Provisioning](/reference/tenant-provisioning),
> [Tenant Export & Deletion](/reference/tenant-export-deletion),
> [Trial Spaces](/reference/trial-spaces),
> [Quota Tiers](/reference/quota-tiers),
> [Space Export Share](/reference/space-export-share),
> [Incident Model](/reference/incident-model),
> [Notification Emission](/reference/notification-emission),
> [SLA Breach Detection](/reference/sla-breach-detection),
> [Support Impersonation](/reference/support-impersonation),
> [Cost Attribution](/reference/cost-attribution),
> [Backup / Restore](/reference/backup-restore),
> [Migration & Upgrade](/reference/migration-upgrade),
> [External Participants](/reference/external-participants),
> [Catalog Release Trust](/reference/catalog-release-trust),
> [Kernel HTTP API](/reference/kernel-http-api),
> [Audit Events](/reference/audit-events),
> [Environment Variables](/reference/env-vars),
> [Resource IDs](/reference/resource-ids)

This page is the index of every Takosumi v1 closed enum and state machine. Each
entry lists the values, gives a one-line semantic, and links to the dedicated
reference for details. Every enum below is **closed**: extension requires a
`CONVENTIONS.md` §6 RFC. No provider, template, or third-party package may
extend any of these unilaterally.

## What "v1 stable wire shape" covers

`Stability: stable` doc が freeze する v1 wire shape の対象は以下:

- **closed enum 値** (本 doc に列挙されたすべての enum)
- **state machine の状態名と遷移**
- **record schema の field 名と型**
- **HTTP endpoint path と request / response の field 名**
  ([Kernel HTTP API](/reference/kernel-http-api))
- **CLI subcommand 名と flag 名** ([CLI](/reference/cli))
- **audit event 名と payload field 名**
  ([Audit Events](/reference/audit-events))
- **environment variable 名** ([Environment Variables](/reference/env-vars))
- **resource ID prefix と format** ([Resource IDs](/reference/resource-ids))

これらは v1 中の breaking 変更に `CONVENTIONS.md` §6 RFC を必須とする。
operator-tunable な default 値 (TTL / grace / threshold / quota cap 等) は wire
shape ではないため、stable の対象外で、default 値変更は CHANGELOG
への記載のみで足りる ([Stability](/reference/#stability) 参照)。

## Access modes

```text
read | read-write | admin | invoke-only | observe-only
```

Five-value vocabulary that governs how a Link consumer interacts with an
export's resource. `read-write` and `admin` are never implicit on
`safeDefaultAccess`. Detailed semantics, `safeDefaultAccess` contract, and
approval invalidation interaction live in
[Access Modes](/reference/access-modes).

## Lifecycle phases

```text
apply | activate | destroy | rollback | recovery | observe
```

Six-phase enum applied per OperationPlan. `apply` produces the `OperationPlan`
and `ResolutionSnapshot`; `activate` flips traffic; `destroy` removes managed
and generated objects; `rollback` re-applies the prior `ResolutionSnapshot`;
`recovery` resumes from the WAL after a kernel restart or lock loss; `observe`
runs long-lived against runtime-agent describe. Phase-by-phase inputs, WAL stage
coverage, failure semantics, and the steady-state transition diagram live in
[Lifecycle Phases](/reference/lifecycle-phases).

## LifecycleStatus

```text
running | stopped | missing | error | unknown
```

Five-value state runtime-agent reports per managed object. It is the observed
state of the object on its backing connector, never a control-plane phase.
Trigger-by-trigger transitions for `apply` / `describe` / `destroy` / `verify`
are defined in
[Lifecycle Phases — LifecycleStatus enum](/reference/lifecycle-phases#lifecyclestatus-enum).

## operationKind

```text
apply-object | delete-object | verify-object
materialize-link | rematerialize-link | revoke-link
prepare-exposure | activate-exposure
transform-data-asset | observe | compensate
```

Eleven-value reserved enum for internal rich `OperationRecord.operationKind`.
Current public apply code stores operation kinds as strings and exposes only
`planned[].op = "create" | "update" | "delete"` in `takosumi plan`.

| Value                  | Meaning                                                                                     |
| ---------------------- | ------------------------------------------------------------------------------------------- |
| `apply-object`         | Create or update a managed object on its connector.                                         |
| `delete-object`        | Remove a managed object during `destroy` or `rollback`.                                     |
| `verify-object`        | Re-read a managed object to confirm it matches the resolved spec; emits no mutation.        |
| `materialize-link`     | Render a generated object from a link source for the first time.                            |
| `rematerialize-link`   | Re-render a generated object after the source export digest changed.                        |
| `revoke-link`          | Tear down a generated object when the link is removed; may emit `RevokeDebt`.               |
| `prepare-exposure`     | Stage a new Exposure (build routing surface) before traffic flips.                          |
| `activate-exposure`    | Flip traffic to a prepared Exposure during the `activate` phase.                            |
| `transform-data-asset` | Run a DataAsset transformer to produce a derived artifact.                                  |
| `observe`              | Long-lived runtime-agent describe used by the `observe` phase.                              |
| `compensate`           | Recovery operation that undoes a partially-committed effect during `rollback` / `recovery`. |

Per-kind input / output / WAL stage coverage lives in the internal OperationPlan
architecture. Current public plan shape is in
[Plan Output Schema](/reference/plan-output); provider dispatch contract is in
[Provider Implementation Contract](/reference/provider-implementation-contract).

## WAL stages

```text
prepare | pre-commit | commit | post-commit | observe | finalize
        | abort | skip                                  (terminal)
```

Eight-value enum for the write-ahead operation journal. `prepare` / `pre-commit`
/ `commit` / `post-commit` / `observe` / `finalize` are the forward stages;
`abort` and `skip` are the terminal stages. The idempotency tuple is
`(spaceId, operationPlanDigest, journalEntryId)`; the same tuple replayed from
any forward stage produces the same result. Detailed stage semantics and replay
rules will live in [WAL Stages](/reference/wal-stages).

## Approval lifecycle states

```text
pending | approved | denied | expired | invalidated | consumed
```

Six-value closed server-side state machine for approval records. `pending` is
the initial state on issue; `approved`, `denied`, `expired`, `invalidated`,
`consumed` are the five terminal states. `approved` is the only non-terminal
post-issue state, transitioning to `consumed` when the apply pipeline
successfully consumes the approval, or to `invalidated` when one of the six
triggers below fires. `consumed` records are retained for audit but cannot be
re-used; presenting a `consumed` approval to apply yields `failed_precondition`.
The transient client-only `reviewing` UX hint is not a server-side state and is
not persisted. Transition contract and binding fields live in
[Approval Invalidation Triggers](/reference/approval-invalidation#approver-ux-states).

## Approval invalidation triggers

```text
1. digest change
2. effect-detail change
3. implementation change
4. external freshness change
5. catalog release change
6. Space-context change
```

Six independent triggers; any one firing invalidates the approval.
`digest change` and `effect-detail change` short-circuit-invalidate without
re-evaluating other bindings, since a digest move forces a full re-resolve.
Trigger contract and propagation rules live in
[Approval Invalidation Triggers](/reference/approval-invalidation).

## Risk taxonomy

```text
collision-detected | transform-unapproved | stale-export
revoke-debt-created | secret-projection | grant-escalation
network-egress-expansion | cross-space-import
external-implementation | catalog-release-bump
policy-pack-bump | space-context-change
artifact-policy-override | post-commit-failed
recovery-compensate-required | drift-detected
data-asset-kind-mismatch | approval-binding-stale
implementation-change
```

Nineteen-value closed Risk enum with stable IDs. The kernel issues one approval
per `OperationPlan` and lists the firing Risks via `riskItemIds[]`. Per-Risk
semantics and the operator-fix flow live in
[Risk Taxonomy](/reference/risk-taxonomy).

## RevokeDebt reason

```text
external-revoke | link-revoke | activation-rollback
approval-invalidated | cross-space-share-expired
```

Five-value closed reason enum on `RevokeDebt`. `external-revoke` is emitted when
the connector reports an object disappeared without a managed `destroy`;
`link-revoke` covers explicit projection removal; `activation-rollback` covers
`compensate` recovery. See [RevokeDebt Model](/reference/revoke-debt).

## RevokeDebt status

```text
open | operator-action-required | cleared
```

Three-value lifecycle status of a `RevokeDebt` entry. `open` is the default
state at emission; `operator-action-required` is set when automatic clearing
failed and the aging window crossed the operator threshold; `cleared` is
terminal. Aging window and clear conditions live in
[RevokeDebt Model](/reference/revoke-debt).

## Object lifecycle classes

```text
managed | generated | external | operator | imported
```

Five-value closed classification of every object the kernel tracks.

| Class       | Meaning                                                                                            |
| ----------- | -------------------------------------------------------------------------------------------------- |
| `managed`   | Created and owned by the current Space's apply pipeline; destroyed by its `destroy` phase.         |
| `generated` | Materialized from a managed object via projection / link rendering; destroyed when its source is.  |
| `external`  | Pre-existing on the connector; the kernel may read or grant against it but never deletes it.       |
| `operator`  | Operator-installed (e.g. `connector:<id>`); not part of any tenant Space's lifecycle.              |
| `imported`  | Reachable through a SpaceExportShare from another Space; lifecycle bound to the share's freshness. |

Only `managed` and `generated` are removed by `destroy`.

## Mutation constraints

```text
immutable | replace-only | in-place | append-only
ordered-replace | reroute-only
```

Six-value closed enum that an `outputField` carries to declare how a provider
may mutate it across applies.

| Constraint        | Allowed apply behavior                                                               |
| ----------------- | ------------------------------------------------------------------------------------ |
| `immutable`       | Value is fixed at first apply; later changes fail planning.                          |
| `replace-only`    | Provider must drop and re-create the resource to change the value.                   |
| `in-place`        | Provider may mutate the field on the live resource without re-creation.              |
| `append-only`     | Provider may extend the value but not remove or reorder existing entries.            |
| `ordered-replace` | Provider may replace entries but must preserve declared ordering.                    |
| `reroute-only`    | Provider may not touch the resource itself; only the routing surface in front of it. |

## Link mutations

```text
rematerialize | reproject | regrant | rewire | revoke
retain-generated | no-op | repair
```

Eight-value closed enum on the per-link diff the apply pipeline emits into the
OperationPlan.

| Mutation           | Trigger                                                                                  |
| ------------------ | ---------------------------------------------------------------------------------------- |
| `rematerialize`    | Source export digest changed; generated object re-derived from the new export.           |
| `reproject`        | Projection rule changed without source change; only generated identity is re-rendered.   |
| `regrant`          | Grant detail (e.g. access mode) changed; underlying object kept.                         |
| `rewire`           | Routing target changed; managed object kept, exposure rebuilt.                           |
| `revoke`           | Link removed; generated object torn down; may emit `RevokeDebt` of reason `link-revoke`. |
| `retain-generated` | Link removed but operator policy retains the generated object (e.g. for audit).          |
| `no-op`            | Link present in both snapshots with identical materialization.                           |
| `repair`           | Drift detected; generated state reconciled to match the resolved link.                   |

## Link materialization states

```text
pending | materializing | materialized | stale | rematerializing
revoking | revoked | failed | debt
```

Nine-value closed state on each link projection inside a `ResolutionSnapshot`.
`materialized` is steady-state success; `stale` flags an export-freshness issue
without yet re-running; `debt` indicates a `RevokeDebt` is open against the
link.

## Bundled DataAsset kinds

```text
oci-image | js-bundle | lambda-zip | static-bundle | wasm
```

Initial registered vocabulary for `Artifact.kind`. The protocol field is open
for operator-installed connectors, but the bundled kernel registers these five
kinds for discovery. Required metadata, size caps, and connector enforcement per
kind live in [Artifact Kinds](/reference/artifact-kinds).

## Health states

```text
unknown | observing | healthy | degraded | unhealthy
```

Five-value Exposure health enum reported by the observe loop. Newly activated
Exposures start at `unknown`, transition through `observing`, then settle on
`healthy` / `degraded` / `unhealthy`. The transitions are described in
[Lifecycle Phases — `observe`](/reference/lifecycle-phases#observe).

## DomainErrorCode

```text
invalid_argument | permission_denied | not_found
failed_precondition | resource_exhausted | not_implemented
unauthenticated | readiness_probe_failed | internal_error
```

Nine-value closed code enum on every kernel domain error response.

| Code                     | Meaning                                                                      |
| ------------------------ | ---------------------------------------------------------------------------- |
| `invalid_argument`       | Manifest schema, form input, or digest mismatch.                             |
| `permission_denied`      | Space crossing, entitlement denial, or policy gate denial.                   |
| `not_found`              | Endpoint disabled (token unset), or deployment / artifact / Space absent.    |
| `failed_precondition`    | Destroy without prior record, collision-detected, or approval invalidated.   |
| `resource_exhausted`     | Quota saturation or artifact upload exceeding `TAKOSUMI_ARTIFACT_MAX_BYTES`. |
| `not_implemented`        | Issuer not wired, or operator-gated feature not enabled.                     |
| `unauthenticated`        | Missing bearer or internal HMAC verification failure.                        |
| `readiness_probe_failed` | `/livez` / `/readyz` or a dependent port is not ready.                       |
| `internal_error`         | Unhandled exception inside the kernel.                                       |

Transport mapping (HTTP status, gRPC code) is fixed per code and defined in
[Kernel HTTP API](/reference/kernel-http-api). Manifest-time validation that
surfaces `invalid_argument` is described in
[Manifest Validation](/reference/manifest-validation).

## LifecycleErrorBody codes

```text
unauthorized | bad_request | connector_not_found
artifact_kind_mismatch | connector_failed
```

Five-value closed code enum returned by runtime-agent `/v1/lifecycle/*`
responses. The `connector-extended:*` prefix is reserved for connector-defined
extension codes that runtime-agent forwards verbatim. See
[Runtime-Agent API — Error model](/reference/runtime-agent-api#error-model).

## SpaceExportShare lifecycle

```text
draft | active | refresh-required | stale | revoked
```

Five-value closed share lifecycle. `draft` is pre-publish; `active` is
consumable; `refresh-required` flags freshness loss that operators may resolve
without revoking; `stale` is the threshold-crossed terminal-but-recoverable
state; `revoked` is terminal. See
[Space Export Share](/reference/space-export-share).

## Actor types

```text
human | service-account | runtime-agent | support-staff
```

Four-value closed enum on every Actor record. `human` is an operator-onboarded
user; `service-account` is a non-interactive caller bound to an API key;
`runtime-agent` is an enrolled runtime-agent process; `support-staff` is an
operator-side support principal subject to impersonation grants. Per-type
binding fields and authentication contract live in
[Actor / Organization Model](/reference/actor-organization-model).

## Roles

```text
org-owner | org-admin | org-billing | space-admin
space-deployer | space-viewer | support-staff
```

Seven-value closed RBAC role enum. `org-*` roles bind at Organization scope;
`space-*` roles bind at Space scope; `support-staff` is operator-scope and gated
by an active impersonation grant. Per-role capability matrix and scope rules
live in [RBAC Policy](/reference/rbac-policy).

## API key types

```text
deploy-token | read-token | admin-token | support-token
```

Four-value closed enum on every API key record. `deploy-token` authorizes apply
/ activate / destroy; `read-token` is read-only; `admin-token` covers
Organization / Space management; `support-token` is operator-scope and only
valid while a matching impersonation grant is `approved`. Prefix grammar,
rotation, and revocation rules live in
[API Key Management](/reference/api-key-management).

## Auth provider types

```text
bearer-token | oidc | mtls | runtime-agent-enrollment
```

Four-value closed enum on every auth provider plug-in. `bearer-token` is the
default API key path; `oidc` accepts external OIDC issuers mapped to Actors;
`mtls` binds a client certificate chain; and `runtime-agent-enrollment` is the
bootstrap path for runtime-agent processes. Verification protocol and claim
mapping live in [Auth Providers](/reference/auth-providers).

## Trial Space lifecycle

```text
active-trial | expiring-soon | frozen | cleaned-up | converted
```

Five-value closed lifecycle enum on Trial Space records. `active-trial` is the
issued steady state; `expiring-soon` flags the window before auto-expire;
`frozen` halts apply / activate while preserving data; `cleaned-up` is terminal
after hard delete; `converted` is terminal after upgrade to a regular Space.
Transition contract and quota envelope live in
[Trial Spaces](/reference/trial-spaces).

## Incident state

```text
detecting | acknowledged | mitigating | monitoring | resolved | postmortem
```

Six-value closed Incident state machine. `detecting` is the initial state on
emit; `acknowledged` records operator acceptance; `mitigating` covers active
remediation; `monitoring` is post-fix observation; `resolved` is the terminal
operational state; `postmortem` is the terminal record-keeping state. Per- state
transitions live in [Incident Model](/reference/incident-model).

## Incident severity

```text
low | medium | high | critical
```

Four-value closed severity enum on each Incident. Severity controls notification
emission and SLA-breach linkage. Per- severity policy lives in
[Incident Model](/reference/incident-model).

## Support impersonation grant lifecycle

```text
requested | approved | rejected | revoked | expired
```

Five-value closed grant lifecycle enum. `requested` is the initial state on
issue; `approved` is the only operational state in which a `support-token` may
be used; `rejected`, `revoked`, and `expired` are terminal. Per-state binding
and audit contract live in
[Support Impersonation](/reference/support-impersonation).

## SLA state

```text
ok | warning | breached | recovering | ok-recovered
```

Five-value closed SLA evaluation state. `ok` is the steady state; `warning`
flags an approaching threshold; `breached` is recorded when the SLO threshold is
crossed; `recovering` indicates re-entry below the threshold but inside the
cooldown window; `ok-recovered` is the terminal record after cooldown success.
Detection and cooldown rules live in
[SLA Breach Detection](/reference/sla-breach-detection).

## Connector identity

Connector identity uses the closed prefix `connector:<id>`. Every connector is
operator-installed and falls under the `operator` object lifecycle class above.
The identity scheme is closed; no other prefix denotes a connector in v1.

## Workflow Primitive Enums

The kernel does not reserve trigger, declarable-hook, or `execute-step` enum
families. Workflow / cron / hook execution is modeled outside the kernel, for
example by `takosumi-git`; see
[Workflow Placement Rationale](/reference/architecture/workflow-extension-design).

## Related architecture notes

関連 architecture notes:

- `docs/reference/architecture/target-model.md` — access mode / mutation
  constraint / object lifecycle class の closed-enum architecture
- `docs/reference/architecture/execution-lifecycle.md` — phase enum の choice
  space と observe / recovery を別 phase に切り出した理由
- `docs/reference/architecture/operation-plan-write-ahead-journal-model.md` —
  WAL stage と idempotency tuple の rationale
- `docs/reference/architecture/policy-risk-approval-error-model.md` — Risk 19
  entries / approval invalidation triggers / DomainErrorCode の closure 理由
- `docs/reference/architecture/link-projection-model.md` — link mutation / link
  materialization state の生成 algorithm
- `docs/reference/architecture/data-asset-model.md` — DataAsset kind 5 値と
  connector identity scheme
- `docs/reference/architecture/namespace-export-model.md` — share lifecycle 5 値
