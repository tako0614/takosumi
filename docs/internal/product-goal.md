# Takosumi product goal

Status: active product destination and definition of done. This note is not a
contract, a conformance matrix, a release authorization, or a roadmap/backlog.
It describes the end state that the owning repositories and operators must
prove.

The current contract authority is the [Takosumi Core Spec](./core-spec.md).
The evidence map is [Core Conformance](./core-conformance.md), and the
specialization boundary is [Generalization and Product-Boundary Audit](./generalization-audit.md).
If this destination conflicts with any of them, Core Spec and the owning
contract win. This note records the destination; it does not mint a new
contract or turn an open item into a requirement.

## Destination

Takosumi is done when the two separately owned surfaces are usable as one
coherent product:

1. **Takosumi OSS** is a self-hostable, provider-neutral Git/OpenTofu control
   plane. An operator can run the supported Stack flow through the canonical
   `Run` / `StateVersion` / `Output` / audit lifecycle, with explicit provider
   connections and no hidden provider, Form, or Cloud authority.
2. **Takosumi Hosted** is the official hosted service and retail product. It
   owns its customer account plane, Marketplace offers, prepaid wallet,
   Stripe, reseller integration, support, and abuse/incident operations.
   Its optional OSS composition uses the public contract and existing
   `PlatformExtensionRoute` seam. It consumes deployed wire contracts without
   importing Takosumi or Takoserver source and does not create a second
   Run/state/Output ledger.

Takoserver owns its managed supply: provider credentials, resource execution,
capacity, and reseller contracts. Hosted consumes the public reseller API;
its retail price and settlement do not become OSS defaults or Host authority.
Other managed providers retain their own supply authority.

Both Takosumi and Takoserver are self-hostable software. Product policy is to
offer hosting services for both, so the completion premise covers self-host
operations and offered hosting for each product. The two paths need their own
installation, lifecycle, recovery, and operator evidence; hosting additionally
needs the owning service's customer/tenant isolation and operating controls.
Takos/Yurucommu's single-owner personal deployment model is not a blanket model
for the Takosumi/Takoserver hosting operations layer. This is product policy,
not a claim that either hosting service is already live or GA. Takoserver's
software and hosting readiness belong to its owner; the generic Takosumi OSS
Stack flow remains usable without Takoserver.

OSS GA and Hosted GA are separate release decisions. A green OSS check does
not claim hosted availability; a Marketplace listing or source fixture does
not claim production GA. Each owning product must prove its own contract and
operator post-conditions, including the exact external services it uses.

## Optional external integration input

The current public Takoform contract is an external integration input, not a
Takosumi redesign target. Takoform is optional: the supported OSS Stack flow
does not require a Form, Host, or first-party provider. A module selects its
ordinary providers and their exact versions through native OpenTofu semantics.
When a module uses Takoform, integration work pins the reviewed provider and
the exact Host API, Form, Interface, and Binding identities it actually uses.
The portable contract belongs to the
[Takoform project](https://github.com/tako0614/takoform/blob/main/README.md)
and its [specification](https://github.com/tako0614/takoform/blob/main/spec/README.md).
The independently released OpenTofu client belongs to the
[Provider repository](https://github.com/tako0614/terraform-provider-takoform/blob/main/README.md).
An exact source candidate may be used for local and isolated staging
conformance while that external project completes publication. Production,
release, and GA evidence for a selected external artifact must consume an
immutable published identity; a source commit is never presented as a Registry
release. Publication and compatibility evidence belongs to those owners,
not a copied version roster in this destination note. Takosumi OSS does not
implement or own the Host. Retired identities remain immutable migration or
compatibility material and are not current Takosumi routes.

This goal does not redesign Takoform's Form Definition, FormRef, package,
provider, Host API, maturity, or publication process. A change to those
portable semantics belongs in Takoform first and is then adopted through an
explicit Takosumi integration decision. A Host such as Takoserver owns the
implementation, activation, capacity, and wholesale policy around an external
Form. Hosted owns the retail Marketplace and supplier integration, not that
Host's execution or provider credentials.

## Major journeys and measurable completion

The product claim is earned by observable journeys, not by a feature list.
Each journey needs a positive path, a named negative control, and evidence
from the layer that owns the operation.

| Journey | Done means | Evidence owner |
| --- | --- | --- |
| Self-host install and control-plane loop | From a clean checkout and operator-owned deployment, a user can register a Git source, create a Capsule, run plan/apply, read the resulting `StateVersion` and ordinary `Output`, and complete an approved destroy. The final Run, state, Output, and audit lineage are durable; replay, stale fences, and secret-like values fail closed. | Takosumi OSS portable gate, [`critical-journeys.md`](./critical-journeys.md), and the operator's live control-plane smoke. |
| Self-host provider path | The same Stack flow works with a runner-installable provider selected in the user's module and explicit `ProviderConnection` / `CredentialRecipe` / `ProviderBinding` records. No first-party provider, implicit credential, or second resource ledger is required. | Core Spec / Core Conformance and the OSS provider-neutral tests. |
| Hosted user loop | An authenticated user can discover an actually available Marketplace offer, reserve and operate the corresponding service through the owning provider contract, and observe tenant isolation, retail settlement, recovery, and redacted audit evidence. An OSS Stack integration keeps the canonical source → plan → apply → readback → destroy lineage. | [Hosted's contract](https://github.com/tako0614/takosumi-hosted/blob/main/README.md) and its private operator evidence; the managed Host owns supply/runtime readback. |
| Hosted release loop | The exact Hosted revision and any composed OSS release are provenance-bound, staging is qualified before production, post-conditions are read back, and reversal or forward-repair behavior is recorded. Hosted GA is decided by its owner using its own contract and operator evidence. | [Hosted composition](https://github.com/tako0614/takosumi-hosted/blob/main/docs/oss-composition.md) and the Hosted owner's release procedure and private evidence; this document does not claim those operations have passed. |

The local critical-journey lane must keep all groups covered by existing
portable tests and retain its warm local p95 target below 60 seconds. This is a
failure-locality measure, not a substitute for the complete owner gate or live
evidence. The owner runs `bun run check` for the exact candidate tree before
handoff.

## Quality envelope

The destination is inside this envelope:

- **Contract fidelity:** Core remains one plain Git/OpenTofu/Terraform Stack
  model with explicit provider selection, one canonical Run/state/Output/audit
  lineage, and fail-closed unknown or stale identities.
- **Ownership fidelity:** Takoform owns portable Form semantics; Takosumi OSS
  owns the generic control plane; Hosted owns retail identity, Marketplace,
  prepaid/Stripe, supplier integration, support, and abuse operations. The Host
  owns managed supply, execution, provider credentials, and capacity.
  Hosted composes OSS through public contracts and never makes retail or Host
  facts implicit in OSS.
- **Security and privacy:** brokered credential values never enter
  Outputs, logs, audit payloads, discovery, or evidence summaries. Provider
  state remains a sensitive artifact protected by the owning substrate's
  encryption and custody contract.
  Authorization,
  tenant scope, binding identity, and delivery type are checked at invocation
  time.
- **Durability and recovery:** lifecycle mutations are idempotent and fenced;
  state, Outputs, and audit survive process boundaries; backup/restore,
  rollback, or explicit forward repair are proven for the surface that owns
  them.
- **Operability:** every production surface binds reviewed source and artifact
  provenance, post-conditions, reversal, and failure handling. Missing or
  mutable evidence fails closed; no blind retry or hand-written availability
  claim is accepted.
- **Product clarity:** published docs describe the supported surface and link
  to the owning contract/evidence. Historical plans, migration fixtures, and
  Hosted-private details are not presented as current OSS behavior.

## Evidence layers

Evidence is layered so a lower layer cannot impersonate a higher one:

1. **Contract and boundary evidence** — Core Spec, Core Conformance,
   generalization checks, source/static tests, and docs-boundary tests prove
   repository-owned behavior and vocabulary. They do not prove a live service.
2. **Portable product evidence** — `bun run check`,
   `bun run test:critical-journeys`, focused tests, and docs builds prove the
   exact OSS candidate tree. They do not prove operator credentials, capacity,
   billing, support, or production availability.
3. **Self-host live evidence** — an operator-owned deployment runs the
   provider-neutral control-plane loop and records private readback, recovery,
   and reversal evidence. Self-host evidence is not official Hosted evidence.
4. **Hosted and Host evidence** — Hosted owns retail availability, settlement,
   support, incident, recovery, and production readiness evidence. Its
   [contract](https://github.com/tako0614/takosumi-hosted/blob/main/README.md)
   and [OSS composition](https://github.com/tako0614/takosumi-hosted/blob/main/docs/oss-composition.md)
   name that boundary. The selected managed Host owns capacity, provider
   execution, and its own recovery/readback; for Takoserver start from its
   [owning repository](https://github.com/tako0614/takoserver/blob/main/README.md).
   OSS docs link to those owners instead of copying their service matrix or
   private evidence. No published readiness record is inferred from these
   source links.
5. **Human acceptance** — only the named owner decisions below can
   close the final launch decision after every machine-checkable layer is
   green and the evidence references match the exact candidate.

## Human-only final blockers

Automation must block on a failed test, missing/stale evidence, contract
drift, candidate mismatch, or unsafe boundary; none may be waived by this
document. Independent engineering, security, schema, and release review may be
performed by a non-authoring agent and therefore is not a human-only blocker.
After those checks pass, the remaining blockers are decisions or authorities
that require accountable humans:

- the operator authorizes the exact production target, credential custody,
  maintenance window, and rollback/forward-repair posture;
- the legal/privacy owner accepts the public terms and data-handling posture;
- the Hosted owner accepts retail price/credit economics, support/SLA,
  incident/abuse, and customer-communication readiness for the official
  service; and
- the production operator makes the final go/no-go decision for the exact
  candidate and target.

Each product owner records its own `go` or `no-go` against its exact revision
and evidence set. A composed service identifies the exact OSS and external
published identities it consumes; it does not force independent products into
one release stream. A task, branch name, green repository gate, or this
document never authorizes production mutation.

## Read this with

- [Core Spec](./core-spec.md) — current OSS contract and ownership boundary.
- [Core Conformance](./core-conformance.md) — current repository evidence map;
  gaps remain gaps rather than roadmap completion.
- [Takosumi v1 release procedure](../operations/takosumi-v1-release.md) — OSS
  provenance and release obligations.
- [Takoform specification](https://github.com/tako0614/takoform/blob/main/spec/README.md)
  and [Provider](https://github.com/tako0614/terraform-provider-takoform/blob/main/README.md)
  — optional external semantics and the selected artifact's publication owner.
- [Hosted contract](https://github.com/tako0614/takosumi-hosted/blob/main/README.md)
  and [OSS composition](https://github.com/tako0614/takosumi-hosted/blob/main/docs/oss-composition.md)
  — retail evidence and release authority.
