# PaaS Operations Design

This document records the design rationale for the v1 operations primitives that
Takosumi exposes when it is run as a PaaS: quota tiers, cost attribution, SLA
breach detection, zone selection, the incident model, support impersonation, and
notification emission. Wire-level shapes live in the reference layer; this
document explains why each surface is kernel-side and where the line stops.

## Quota tiers: operator-defined names, kernel-enforced caps

A quota tier is a named bundle of dimension caps. The kernel does **not** ship
`free`, `pro`, or `enterprise` as defaults. The reasoning is:

- **Tier names are pricing artifacts.** Each PaaS distribution has its own price
  book and contract surface. If the kernel hard-coded tier names, every operator
  would either accept a foreign vocabulary or fork the kernel to change a
  string. Neither is acceptable.
- **The kernel still enforces the caps.** Operators register tiers through the
  internal control plane. A Space carries exactly one `quotaTierId`. When the
  kernel evaluates a quota dimension, it resolves through the Space's tier and
  applies the same fail-closed-for-new-work, fail-open-for-inflight rule that
  already governs quota enforcement.
- **Tiers are flat in v1.** No inheritance, no parent tier, no composition. Each
  Space resolves to one tier and one tier only. Composition would force the
  kernel to compute a derived cap at request time and would dilute the audit
  trail; operators that want layered tiers compose them in their pricing system
  before registering the resulting flat tier.
- **An installation with zero registered tiers fails closed at boot.** This is
  intentional: a PaaS without a tier system has no enforceable per-Space limits,
  and the kernel refuses to provision Spaces in that mode.

The result is a tier abstraction that the kernel owns mechanically and the
operator owns semantically.

## Cost attribution as opaque metadata

Each Space carries an optional `attribution` map (`costCenter`, `projectCode`,
`customerSegment`, `customLabels`). The kernel never derives a value, never
validates a vocabulary, and never normalizes case. Why:

- **Cost vocabulary is operator-private.** A `costCenter` string maps to an
  external general-ledger system the kernel will never see. If the kernel
  format-checked these values, it would either reject legitimate operator codes
  or accept invalid ones with false confidence.
- **PII risk is operator-managed.** A `customerSegment` value may be a marketing
  label, a compliance class, or a contract code. The kernel cannot know which.
  Treating every value as opaque keeps the kernel out of decisions it has no
  signal for.
- **Telemetry labels and audit envelopes carry the map verbatim.** External cost
  pipelines aggregate signals using kernel-emitted metrics labeled by
  attribution keys, plus audit events that include the same map. The kernel
  exposes the join key; the operator builds the join.

Per-key value caps (length, character class, total map size) **are** enforced.
These are correctness caps for storage and telemetry, not vocabulary caps.

## SLA breach detection: kernel-side measurement, operator-side credit

SLA breach detection is kernel-side. Service credit calculation is not. The
reasoning:

- **Double-bookkeeping breaks audit integrity.** If the kernel emitted only raw
  metrics and an external system computed breaches, two systems would track
  windows, thresholds, and breach states. They would drift. Customers and
  operators would disagree about whether a breach occurred.
- **Breach detection participates in the audit chain.** Each breach transition
  is an audit event. Tying it to the chain means every credit dispute can be
  settled by replaying the chain, not by reconciling parallel logs.
- **Credit formulas are contract-specific.** "Customer gets 10% credit on a p99
  breach over 5 minutes" is a contract clause, not a kernel invariant. The
  kernel emits the breach signal; the operator's billing pipeline computes
  credits using its own formulas.
- **Dimensions are closed.** The v1 dimension set is fixed (apply latency
  percentiles, activation latency, WAL stage duration, drift detection latency,
  RevokeDebt aging, readiness ratio, throttle ratio, error rates). Adding a
  dimension changes operator SLO commitments and goes through `CONVENTIONS.md`
  §6.

Threshold values are operator-supplied. Window length is operator-tunable within
a bounded range. Detection logic and the audit transitions are kernel-fixed.

## Zone selection: single-region in v1

A zone is an operator-defined string attached to Space, Object, DataAsset, and
Connector scopes. The kernel propagates it through manifest expansion, drift
detection, and audit. It does not own a topology graph or a latency table. The
constraint:

- **All zones in a v1 installation live in one region.** Cross-region writes,
  region failover, and geo-routing are out of scope. An operator that needs
  multiple regions runs one Takosumi installation per region and federates at
  the operator boundary, not inside the kernel.
- **Zone strings are opaque.** Two zones with similar names are unrelated. The
  kernel does not infer adjacency from the string shape. Affinity rules ("place
  this object in the same zone as that DataAsset") are expressible because they
  compare equal strings; latency-aware placement is not, because it would need a
  topology the kernel does not own.
- **Zone-agnostic mode exists.** If `TAKOSUMI_ZONES_AVAILABLE` is unset, every
  zone field is ignored at evaluation time. Small installations do not pay the
  cost of declaring a zone vocabulary.

Cross-region semantics, when they land, will go through a `CONVENTIONS.md` §6
RFC because they change the federation invariant in
[PaaS Provider Design](./paas-provider-design.md).

## Incident model: kernel-side detection, kernel-side state, operator-side narrative

An Incident is a kernel-recorded service-impacting event. Origin is either
auto-detected (SLA breach, RevokeDebt aging into `operator-action-required`,
readiness probe failure, sustained internal-error rate) or operator-declared.
The reasoning:

- **Auto-detection lives where the signals live.** SLA breach evaluation,
  RevokeDebt aging, and readiness probes are already kernel-side. Triggering an
  incident from those signals avoids a second polling layer.
- **State machine binds to the audit chain.** Each transition is an audit event.
  Postmortem evidence is a chain replay, not a reconstructed timeline from logs.
  This is the same property that drives kernel-side SLA detection.
- **Operator-declared incidents share the record shape.** When a customer
  reports an outage that did not auto-detect, the operator declares the incident
  through the internal control plane. It traverses the same state machine and
  produces the same audit envelope. Origin is recorded so that incident review
  can slice by detection source.
- **Customer-facing presentation is operator surface.** Status pages, incident
  timelines, customer email blasts, and Slack rendering are not kernel concerns.
  The kernel emits the structured record and the audit transitions; the operator
  chooses how to surface them.

## Support impersonation: a separate auth path

Support staff that need to look at a customer Space go through a separate auth
path:

- **`support-staff` is its own Actor type.** A support-staff Actor never holds a
  Space role through Membership. It is operator-controlled and lives in the
  operator's support tenant.
- **Authority comes from a grant, not a role.** A support-staff Actor obtains
  `read-only` or `read-write` access to a specific Space through a
  `SupportImpersonationGrant`. Read-write grants require the customer admin's
  explicit approval. Both grant types are time-bounded.
- **Every session is audit-grade.** Session open, every kernel operation under
  the impersonation, and session close all attach the support actor id, the
  grant id, the ticket reference, and the customer admin who approved.
  Cross-tenant access is therefore replayable.
- **Bootstrap surface is operator-only.** Public deploy bearer tokens and
  runtime-agent enrollments cannot mint a `support-staff` Actor. The minting
  path is internal-control-plane only, gated by HMAC.

This design lets operators support customers without violating the Space
containment invariant. The kernel proves the access was scoped, time-bounded,
and approved; it does not prove the support staff did the right thing once
inside, which is an operator policy concern.

## Notification emission: pull-only, kernel never delivers

The kernel records notification signals but does not deliver them. Operators
consume the signal queue and fan out to email, Slack, SMS, in-app, or digest
channels. The reasoning:

- **The kernel never holds delivery credentials.** SMTP servers, Slack workspace
  tokens, SMS gateway keys, and webhook secrets are operator artifacts. Holding
  them in the kernel would expand the kernel's blast radius for credentials it
  has no need to verify.
- **Pull-only matches the existing webhook decision.** Takosumi does not push to
  external listeners by design (see the v1 webhook scope decision in
  [PaaS Provider Design](./paas-provider-design.md)). Notifications follow the
  same boundary: the kernel emits a signal, an operator-controlled delivery
  worker reads the queue.
- **Every customer-visible notification has an audit event.** The signal stream
  is a curated subset of audit events plus a small number of derived events
  (e.g., `approval-near-expiry`). The operator's outer stack cannot mint a
  customer-visible notification that the kernel did not first emit as a signal.
- **Idempotency is kernel-side.** Duplicate-signal suppression is part of the
  emission rule, so that a retried apply or a flapping breach does not mint a
  flood of notifications. The operator pulls a deduplicated stream.

Recipient resolution is kernel-side: the kernel resolves which Actors should
receive a signal based on role and Membership. Delivery channel selection (email
vs. Slack vs. nothing) is operator-side.

## Boundary

The kernel ships:

- the quota tier registration API and per-Space tier binding;
- the opaque attribution map and its propagation through audit and telemetry;
- the closed SLA dimension set and the breach detection state machine;
- the single-region zone attribute and its propagation through manifest
  expansion;
- the Incident record, its state machine, the auto-detection triggers, and the
  audit transitions;
- the support impersonation grant / session records and the audit-grade scoping
  rule;
- the notification signal record, the closed category enum, recipient
  resolution, and the pull queue.

The kernel does not ship:

- public status page UIs, customer dashboards, internal tooling for SRE;
- ticket systems, screen-sharing tools, support-side incident editors;
- SLA credit calculators, contract-specific credit formulas, invoice surfaces;
- email templates, Slack bots, SMS rendering, in-app banner components;
- the customer-side acknowledge / mute UI for incidents or notifications.

## Related reference docs

- [Quota Tiers](../reference/quota-tiers.md)
- [Quota and Rate Limit](../reference/quota-rate-limit.md)
- [Cost Attribution](../reference/cost-attribution.md)
- [SLA Breach Detection](../reference/sla-breach-detection.md)
- [Zone Selection](../reference/zone-selection.md)
- [Incident Model](../reference/incident-model.md)
- [Support Impersonation](../reference/support-impersonation.md)
- [Notification Emission](../reference/notification-emission.md)
- [Audit Events](../reference/audit-events.md)
- [Telemetry / Metrics](../reference/telemetry-metrics.md)

## Cross-references

- [Space Model](./space-model.md)
- [Operator Boundaries](./operator-boundaries.md)
- [PaaS Provider Design](./paas-provider-design.md)
- [Identity and Access Design](./identity-and-access-design.md)
- [Tenant Lifecycle Design](./tenant-lifecycle-design.md)
- [Operational Hardening Checklist](./operational-hardening-checklist.md)
