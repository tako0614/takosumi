# Quota and Rate Limit

> Stability: stable Audience: operator, kernel-implementer See also:
> [Environment Variables](/reference/env-vars),
> [Kernel HTTP API](/reference/kernel-http-api),
> [Audit Events](/reference/audit-events),
> [Readiness Probes](/reference/readiness-probes),
> [Storage Schema](/reference/storage-schema)

This reference defines the v1 quota model, per-tenant metering surfaces, and
rate-limit policy for the Takosumi kernel HTTP API. The kernel exposes raw
signals; enforcement (block, throttle, alert) lives in the operator policy layer
that consumes those signals.

::: info Current HTTP status Quota and rate-limit records are current service
contracts, but the operator status route described below is design-reserved. The
current kernel HTTP router does not mount `/api/internal/v1/status`, and current
`/readyz` does not emit quota near-limit rows; see
[Readiness Probes](/reference/readiness-probes) for the current probe shape. :::

## Quota model

Two scopes apply, in this order of precedence:

1. **Space-level quota** is the v1 baseline. Every quota dimension is accounted
   per `space:<id>`, and exhaustion fails the offending request without
   affecting other Spaces.
2. **Kernel-global quota** is the operator-side cap. It guards the kernel host
   from runaway aggregate load even when no individual Space is over its
   Space-level cap. A global cap that fires emits a `severity: warning` audit
   signal but does not pre-empt running traffic.

Quota itself is **fail-closed for new work and fail-open for inflight work**:
once a Space crosses a cap, the kernel rejects new deployments, new activation
snapshots, and new SpaceExportShare issuances, but already-running operations
continue and read paths stay available.

Quota signals are exposed; enforcement is policy. The kernel publishes the raw
counters in audit events and on the status endpoint, and the operator policy
layer maps those counters to allow / deny / require- approval decisions through
the same policy pack used by Risk evaluation.

## Quota dimensions (closed v1 set)

The v1 set is closed. Adding a dimension goes through the `CONVENTIONS.md` §6
RFC.

| Dimension                         | Unit           | Per-Space? | Notes                                                                                                        |
| --------------------------------- | -------------- | ---------- | ------------------------------------------------------------------------------------------------------------ |
| `deployment-count`                | count          | yes        | Active (non-destroyed) Deployments per Space.                                                                |
| `active-object-count`             | count          | yes        | Sum of objects bound to the Space's most recent ActivationSnapshot.                                          |
| `artifact-storage-bytes`          | bytes          | yes        | Sum of `DataAsset.bytes` referenced by the Space, after dedup.                                               |
| `journal-volume-bytes-per-bucket` | bytes / bucket | yes        | OperationJournal write volume per fixed time bucket (`TAKOSUMI_QUOTA_JOURNAL_BUCKET_SECONDS`, default 3600). |
| `approval-pending-count`          | count          | yes        | Approval rows in `pending` state.                                                                            |
| `space-export-share-count`        | count          | yes        | Active (non-revoked, non-expired) SpaceExportShare rows the Space owns.                                      |

Each dimension has a corresponding raw counter on the status endpoint and a
corresponding audit signal: deployment-count and active-object-count update on
`deployment-applied` and `activation-snapshot-created`; artifact-storage-bytes
update on `POST /v1/artifacts` write and on artifact GC sweep (see
[Artifact GC](/reference/artifact-gc)); journal-volume updates per bucket
boundary; approval-pending-count updates on `approval-issued` /
`approval-consumed` / `approval-invalidated`; space-export-share-count updates
on `share-created` / `share-revoked`.

## Per-tenant metering

The kernel records the raw counters above per Space and exposes them without
making any billing claim. A billing system runs externally and consumes the
metering events.

- Counters are persisted in the partition declared in
  [Storage Schema](/reference/storage-schema). They are read-mostly and do not
  occupy the OperationJournal.
- Metering events are the same audit events listed under
  [Audit Events](/reference/audit-events). The audit log is the authoritative
  source for billing reconciliation; the live counters are an index of those
  events.
- The kernel does **not** ship a billing engine, a price book, or a per-tenant
  invoice surface. Operators wire the audit log into their billing pipeline.

## Rate-limit policy

Rate limits apply at the HTTP edge. The kernel distinguishes two route classes
and two scopes.

Route classes:

- **Public routes** are `/v1/deployments/*` and `/v1/artifacts/*`
  (operator-facing CLI surface).
- **Internal routes** are `/api/internal/v1/*` (operator dashboard, agent, and
  external-participant management).

Scopes:

- **Per-Space** counts, keyed by the Space resolved from the request's auth
  context. The Space pays for each request issued under its token.
- **Per-actor** counts, keyed by the actor identity carried in the request
  envelope (deploy bearer subject, internal HMAC actor, or `system`).

A request is rejected when either scope is over its cap. The response is HTTP
`429 Too Many Requests` with the headers:

| Header                           | Value                                                           |
| -------------------------------- | --------------------------------------------------------------- |
| `Retry-After`                    | Integer seconds until the next replenishment tick.              |
| `X-Takosumi-RateLimit-Limit`     | Configured cap for the breached scope.                          |
| `X-Takosumi-RateLimit-Remaining` | Remaining tokens at the time of evaluation (always 0 on a 429). |
| `X-Takosumi-RateLimit-Reset`     | RFC 3339 instant when the bucket fully refills.                 |
| `X-Takosumi-RateLimit-Scope`     | `space` or `actor`.                                             |

Backoff: clients implement exponential backoff with full jitter, starting at the
`Retry-After` value and doubling per consecutive 429, capped at
`TAKOSUMI_RATE_LIMIT_BACKOFF_MAX_SECONDS` (default 300). The kernel itself does
not retry on the client's behalf.

## Configuration

Quota and rate-limit configuration is environment-driven so that operator policy
can change caps without redeploying the kernel. Variables follow the catalog in
[Environment Variables](/reference/env-vars).

Quota:

| Variable                                            | Type    | Default | Notes                                           |
| --------------------------------------------------- | ------- | ------- | ----------------------------------------------- |
| `TAKOSUMI_QUOTA_DEPLOYMENT_COUNT_PER_SPACE`         | integer | unset   | Cap for `deployment-count`. Unset means no cap. |
| `TAKOSUMI_QUOTA_ACTIVE_OBJECT_COUNT_PER_SPACE`      | integer | unset   | Cap for `active-object-count`.                  |
| `TAKOSUMI_QUOTA_ARTIFACT_STORAGE_BYTES_PER_SPACE`   | bytes   | unset   | Cap for `artifact-storage-bytes`.               |
| `TAKOSUMI_QUOTA_JOURNAL_VOLUME_BYTES_PER_BUCKET`    | bytes   | unset   | Cap for `journal-volume-bytes-per-bucket`.      |
| `TAKOSUMI_QUOTA_JOURNAL_BUCKET_SECONDS`             | integer | `3600`  | Bucket size for journal volume.                 |
| `TAKOSUMI_QUOTA_APPROVAL_PENDING_COUNT_PER_SPACE`   | integer | unset   | Cap for `approval-pending-count`.               |
| `TAKOSUMI_QUOTA_SPACE_EXPORT_SHARE_COUNT_PER_SPACE` | integer | unset   | Cap for `space-export-share-count`.             |
| `TAKOSUMI_QUOTA_GLOBAL_*`                           | mixed   | unset   | Kernel-global counterparts for each dimension.  |

Rate limit:

| Variable                                     | Type    | Default  | Notes                                                                      |
| -------------------------------------------- | ------- | -------- | -------------------------------------------------------------------------- |
| `TAKOSUMI_RATE_LIMIT_PUBLIC_PER_SPACE_RPS`   | integer | `10`     | Public-route per-Space requests per second.                                |
| `TAKOSUMI_RATE_LIMIT_PUBLIC_PER_ACTOR_RPS`   | integer | `10`     | Public-route per-actor requests per second.                                |
| `TAKOSUMI_RATE_LIMIT_INTERNAL_PER_SPACE_RPS` | integer | `30`     | Internal-route per-Space rps.                                              |
| `TAKOSUMI_RATE_LIMIT_INTERNAL_PER_ACTOR_RPS` | integer | `30`     | Internal-route per-actor rps.                                              |
| `TAKOSUMI_RATE_LIMIT_BUCKET_BURST`           | integer | `2x rps` | Token-bucket burst capacity.                                               |
| `TAKOSUMI_RATE_LIMIT_BACKOFF_MAX_SECONDS`    | integer | `300`    | Cap for `Retry-After` doubling.                                            |
| `TAKOSUMI_RATE_LIMIT_DISABLE`                | boolean | `false`  | Disables rate limiting. Local mode only; rejected at boot in `production`. |

A variable left `unset` means the cap is absent, not zero. Setting a variable to
`0` is rejected at boot.

## Quota exhaustion behavior

The kernel handles quota exhaustion **fail-closed for new work, fail- open for
inflight work**:

- New `POST /v1/deployments` requests are rejected with HTTP
  `429 Too Many Requests` when the Space is over a deployment-bound quota, with
  HTTP `409 Conflict` and `errorCode: quota_exhausted` when the breach is on a
  non-rate dimension (artifact storage, approval pending count, share count).
- New ActivationSnapshot creation halts when the Space is over
  `active-object-count`. The corresponding Deployment surfaces a plan that fails
  closed with `errorCode: quota_exhausted`. Existing ActivationSnapshots and the
  GroupHead pointer are not rolled back; already-flowing traffic continues.
- Read paths (`GET /v1/deployments`, `GET /v1/artifacts/:hash`) are outside
  quota. They are rate-limited but never quota-rejected.
- Audit events continue to write under `journal-volume` quota by design;
  rejecting audit writes would defeat the tamper-evidence contract.

A quota rejection emits a `severity: warning` audit event linked to the
offending operation. Repeated rejections within
`TAKOSUMI_QUOTA_ALERT_BURST_SECONDS` (default 60) escalate to `severity: error`
so operator alerting wires fire.

## Operator visibility

In the design-reserved operator surface, operators read quota and rate-limit
state through:

- The `/api/internal/v1/status` endpoint (see
  [Kernel HTTP API](/reference/kernel-http-api)). The response includes a
  `quota` object with one entry per dimension per Space and a `rateLimit` object
  with current bucket fill levels.
- The `/readyz` probe (see [Readiness Probes](/reference/readiness-probes)).
  When kernel-global quota is within `TAKOSUMI_QUOTA_NEAR_LIMIT_FRACTION`
  (default `0.9`) of any cap, `/readyz` reports a `near-limit` warning row. The
  probe stays `ok`; the warning surfaces operator attention without taking
  traffic away.
- Per-Space quota drill-down belongs to operator internal tooling. The current
  public `takosumi` CLI does not expose quota subcommands.

## Related design notes

- `docs/design/operator-boundaries.md` — operator policy layer that consumes
  quota signals.
- `docs/design/operation-plan-write-ahead-journal-model.md` — journal volume
  accounting and the journal-volume quota dimension.
- `docs/design/space-model.md` — Space identity that scopes per-tenant metering.
- `docs/design/exposure-activation-model.md` — fail-safe-not-fail- closed stance
  applied to ActivationSnapshot creation under quota exhaustion.
