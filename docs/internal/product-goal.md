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
2. **Takosumi Cloud** is the official hosted service composed one-way around
   that OSS contract. It adds hosted capacity, offerings, billing, support,
   SLA, and abuse/incident operations in its own repository and operator
   evidence. Those additions never become an OSS default or a second ledger.

OSS GA and hosted Cloud GA are separate release decisions. A green OSS check
does not claim hosted availability; a Cloud catalog entry or source fixture
does not claim production GA. The hosted decision is all-or-nothing for the
Cloud contract owned by the Cloud repository.

## Fixed external integration input

The current public Takoform contract is an external integration input, not a
Takosumi redesign target. Integration work pins one exact reviewed Takoform
commit and consumes the provider, Host API, Form, Interface, and Binding
identities documented by the
[Takoform project](https://github.com/tako0614/terraform-provider-takoform/blob/main/README.md)
and its [portable specification](https://github.com/tako0614/terraform-provider-takoform/blob/main/spec/README.md).
An exact source candidate may be used for local and isolated staging
conformance while that external project completes publication. Production,
release, and GA evidence must consume an immutable published identity; a
source commit is never presented as a Registry release. At this writing the
published compatibility distribution is **Provider 2.0.0** at
`registry.terraform.io/tako0614/takoform`, paired with the retained Host API
`forms.takoform.com/v1alpha2`. The independent current design target is
**Provider 2.1.1**, paired with the Beta Host API
`forms.takoform.com/v1beta1` and Edge Form Family
`edge.forms.takoform.com/v1beta1`; its release descriptor remains
`candidate-only` until signed publication and Registry readback. Its exact discovery leaf is
`/.well-known/takoform/v1beta1`. Takosumi OSS does not implement or own that
Host; it only provides the generic exact platform-extension seam for a
verified external owner to compose. Retired alpha identities remain immutable
migration or compatibility material and are not current Takosumi routes.

This goal does not redesign Takoform's Form Definition, FormRef, package,
provider, Host API, maturity, or publication process. A change to those
portable semantics belongs in Takoform first and is then adopted through an
explicit Takosumi integration decision. Takosumi Cloud may host an exact
external Form, but it owns the implementation, activation, capacity, and
commercial policy around it.

## Major journeys and measurable completion

The product claim is earned by observable journeys, not by a feature list.
Each journey needs a positive path, a named negative control, and evidence
from the layer that owns the operation.

| Journey | Done means | Evidence owner |
| --- | --- | --- |
| Self-host install and control-plane loop | From a clean checkout and operator-owned deployment, a user can register a Git source, create a Capsule, run plan/apply, read the resulting `StateVersion` and ordinary `Output`, and complete an approved destroy. The final Run, state, Output, and audit lineage are durable; replay, stale fences, and secret-like values fail closed. | Takosumi OSS portable gate, [`critical-journeys.md`](./critical-journeys.md), and the operator's live control-plane smoke. |
| Self-host provider path | The same Stack flow works with a runner-installable provider selected in the user's module and explicit `ProviderConnection` / `CredentialRecipe` / `ProviderBinding` records. No first-party provider, implicit credential, or second resource ledger is required. | Core Spec / Core Conformance and the OSS provider-neutral tests. |
| Hosted user loop | An authenticated user can discover an actually available Cloud offering, create and operate the corresponding hosted service through the same source → plan → apply → readback → destroy shape, and observe tenant isolation, usage/billing, recovery, and redacted audit evidence. | Takosumi Cloud's exact hosted smoke and private readiness evidence; this document does not reproduce it. |
| Hosted release loop | The candidate OSS commit and Cloud revision are provenance-bound, staging is qualified before production, post-conditions are read back, and reversal or forward-repair behavior is recorded. Hosted GA is reported only by the Cloud owner gate and launch-readiness authority. | [Cloud GA smoke](https://github.com/tako0614/takosumi-cloud/blob/main/docs/operations/ga-smoke.md), [hosted readiness profile](https://github.com/tako0614/takosumi-cloud/blob/main/docs/operations/hosted-readiness-profile.md), and [real-cloud staging procedure](https://github.com/tako0614/takosumi-cloud/blob/main/docs/operations/real-cloud-staging.md). |

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
  owns the generic control plane; Takosumi Cloud owns official hosted
  implementation, capacity, billing, SLA, support, and abuse operations.
  Cloud composes OSS one-way and never makes hosted facts implicit in OSS.
- **Security and privacy:** credential values never enter Outputs, state,
  logs, audit payloads, public discovery, or evidence summaries. Authorization,
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
  Cloud-private details are not presented as current OSS behavior.

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
   and reversal evidence. Self-host evidence is not official Cloud evidence.
4. **Hosted Cloud evidence** — the Cloud repository owns the hosted smoke,
   catalog, capacity, billing, support, incident, recovery, and production
   readiness records. Start from its [operator runbook index](https://github.com/tako0614/takosumi-cloud/blob/main/docs/operations/README.md)
   and [hosted readiness profile](https://github.com/tako0614/takosumi-cloud/blob/main/docs/operations/hosted-readiness-profile.md).
   OSS docs link to those records instead of copying their service matrix or
   private evidence.
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
- the Cloud owner accepts price/credit economics, support/SLA,
  incident/abuse, and customer-communication readiness for the official
  service; and
- the production operator makes the final go/no-go decision for the exact
  candidate and target.

The product owner then records a single `go` or `no-go` against the exact OSS
commit, Cloud revision, and evidence set. A task, branch name, green repository
gate, or this document never authorizes production mutation.

## Read this with

- [Core Spec](./core-spec.md) — current OSS contract and ownership boundary.
- [Core Conformance](./core-conformance.md) — current repository evidence map;
  gaps remain gaps rather than roadmap completion.
- [Takosumi v1 release procedure](../operations/takosumi-v1-release.md) — OSS
  provenance and release obligations.
- [Takoform published contract](https://github.com/tako0614/terraform-provider-takoform/blob/main/README.md)
  — external portable semantics and publication status.
- [Takosumi Cloud operator runbooks](https://github.com/tako0614/takosumi-cloud/blob/main/docs/operations/README.md)
  — hosted evidence and release authority.
