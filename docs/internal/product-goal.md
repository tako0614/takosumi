# Takosumi product goal

Status: active product destination and definition of done. This note is not a
contract, a conformance matrix, a release authorization, or a roadmap/backlog.
It describes the end state that the owning repositories and operators must
prove.

The current contract authority is the [Takosumi Core Spec](./core-spec.md),
the target component boundary is [Architecture](./architecture.md), and the
evidence map is [Core Conformance](./core-conformance.md). If this destination
conflicts with any of them, Core Spec and the owning contract win. This note
records the destination; it does not mint a new contract or turn an open item
into a requirement.

## Destination

Takosumi is done when its customer-owned BYOC control plane is usable as one
coherent product:

1. **Takosumi OSS Core** is a self-hostable, provider-neutral
   Git/OpenTofu/Terraform control plane. A Workspace owner can run a plain
   Stack through the canonical `Run` / `StateVersion` / `Output` / audit
   lifecycle with an explicit `ProviderConnection` → `CredentialRecipe` →
   `ProviderBinding` path. No hidden provider, Form, managed Host, Offering,
   or second resource ledger is required.
2. **External Host composition** is optional and explicit. A Takoform provider
   may call a Host with a Host-scoped credential, but Takosumi never receives
   the Host's parent provider credential, installation, backend, capacity,
   Workers for Platforms namespace/dispatcher, or native identity.
   Takoserver owns managed supply and its Offering/resource lifecycle.
   Takosumi Hosted is the optional retail, commerce, and client composition; it
   does not own managed supply.

Takosumi OSS readiness, Takoserver Host readiness, and Takosumi Hosted retail
readiness are separate release decisions. A green OSS check does not claim a
managed Host is available, and a Hosted client or catalog entry does not claim
OSS Core or Takoserver production readiness. Takosumi Cloud is a retired
historical identity and is not a current product surface.

## Fixed external integration input

The public Takoform contract is an external integration input, not a Takosumi
redesign target. The owning Takoform repositories are the authority for
provider, Form, Host API, Interface, Binding, publication, and release
identity. Takosumi pins one exact reviewed commit or immutable published
identity for an integration; it never republishes, redefines, or presents a
source candidate as a Registry release. Current versions, discovery leaves,
and maturity status must be read from the owning repositories at qualification
time rather than copied into this document.

This goal does not redesign Takoform's Form Definition, FormRef, package,
provider, Host API, maturity, or publication process. A change to those
portable semantics belongs in Takoform first and is then adopted through an
explicit Takosumi integration decision. Takosumi OSS does not implement or
own that Host. Takoserver owns the implementation, activation, capacity,
provider receipts, and commercial policy for a managed Form. Takosumi Hosted
may present that exact Host-owned service but cannot change its supply
authority.

## Major journeys and measurable completion

The product claim is earned by observable journeys, not by a feature list.
Each journey needs a positive path, a named negative control, and evidence
from the layer that owns the operation.

| Journey | Done means | Evidence owner |
| --- | --- | --- |
| Self-host install and BYOC control-plane loop | From a clean checkout and operator-owned deployment, a user can register a Git source, create a Capsule, bind a Workspace-owned provider credential, run plan/apply, read the resulting `StateVersion` and ordinary `Output`, and complete an approved destroy. Run, state, Output, and audit lineage are durable; replay, stale fences, and secret-like values fail closed. | Takosumi OSS portable gate, [`critical-journeys.md`](./critical-journeys.md), and the operator's private control-plane smoke |
| Provider-neutral path | The same Stack flow works with any runner-installable provider selected in the user's module and explicit `ProviderConnection` / `CredentialRecipe` / `ProviderBinding` records. Takoserver is not involved, and no first-party provider, implicit credential, or second resource ledger is required. | Core Spec / Core Conformance and OSS provider-neutral tests |
| Optional managed Host loop | A verified external Takoform provider can call a Takoserver Host with a Host-scoped credential. The Host proves its own Form, Offering, placement, provider receipt, capacity, readback, and destroy lifecycle without exposing parent credentials to Takosumi. | Takoserver Host and Takoform owner gates; OSS docs do not reproduce Host-private evidence |
| Hosted retail/client loop | Takosumi Hosted may present an actually available Takoserver service, quote or sell it, and preserve the opaque Host authority boundary. Hosted does not create a provider, Offering, capacity, or Resource lifecycle in Takosumi Core. | Takosumi Hosted's owner gate and private evidence |
| Release loop | Each owning repository binds the candidate commit and artifact, qualifies staging before production, reads back post-conditions, and records reversal or forward repair. OSS, Host, and Hosted releases are independent. | Owning repository/operator release procedures |

The local critical-journey lane must keep all groups covered by existing
portable tests and retain its warm local p95 target below 60 seconds. This is a
failure-locality measure, not a substitute for the complete owner gate or live
evidence. The owner runs `bun run check` for the exact candidate tree before
handoff.

## Quality envelope

The destination is inside this envelope:

- **Contract fidelity:** Core remains one plain Git/OpenTofu/Terraform Stack
  model with explicit provider selection, one canonical Run/state/Output/audit
  lineage, and fail-closed unknown or stale identities. Generic Offering and
  active Form/Resource Host composition are not Core authority.
- **Ownership fidelity:** Workspace/customer credentials stay on the BYOC
  path; Takoform owns portable Form semantics; Takosumi OSS owns the generic
  control plane; Takoserver owns managed Host implementation, Offering,
  capacity, provider receipt, billing, support, and abuse operations; Hosted
  owns only its optional retail/client composition.
- **Security and privacy:** credential values never enter Outputs, state,
  logs, audit payloads, public discovery, or evidence summaries. Authorization,
  tenant scope, binding identity, and delivery type are checked at invocation
  time. Takosumi never receives a Host parent credential.
- **Durability and recovery:** lifecycle mutations are idempotent and fenced;
  state, Outputs, and audit survive process boundaries; backup/restore,
  rollback, or explicit forward repair are proven for the surface that owns
  them. RunOwner and RunnerObject retain separate authority and execution
  responsibilities.
- **Operability:** every production surface binds reviewed source and artifact
  provenance, post-conditions, reversal, and failure handling. Missing or
  mutable evidence fails closed; no blind retry or hand-written availability
  claim is accepted.
- **Product clarity:** published docs describe the supported BYOC surface and
  link to the owning contract/evidence. Historical plans, migration fixtures,
  retired Cloud identity, and Host-private details are not presented as current
  OSS behavior.

## Current gaps that remain gaps

The destination must not be read as a claim that the current tree already
implements every boundary:

| Gap | Required reading |
| --- | --- |
| Generic Offering routes/stores and schema wiring remain in parts of the current bootstrap/Worker | Implementation conformance gap and deletion/migration custody; Takosumi Core has no Offering authority. |
| Resource Shape, Form Registry/FormActivation, TargetPool, SpacePolicy, and Resource lifecycle are still composed by parts of bootstrap/Worker | Migration-only/delete custody; the bounded drain does not make them supported authoring. |
| Five-module extraction and narrow Runner envelope are not complete everywhere | Conformance work must preserve RunOwner/RunnerObject separation and the at-most-once mutation fence. |
| Any ordinary Worker path presented as managed customer ModuleWorker execution | Takoserver Workers for Platforms/dispatcher authority is required; Takosumi runner never owns that lane. |

## Evidence layers

Evidence is layered so a lower layer cannot impersonate a higher one:

1. **Contract and boundary evidence** — Core Spec, Architecture,
   Core Conformance, generalization checks, source/static tests, and
   docs-boundary tests prove repository-owned behavior and vocabulary. They do
   not prove a live Host.
2. **Portable product evidence** — `bun run check`,
   `bun run test:critical-journeys`, focused tests, and docs builds prove the
   exact OSS candidate tree. They do not prove operator credentials, Host
   capacity, billing, support, or production availability.
3. **Self-host live evidence** — an operator-owned deployment runs the BYOC
   control-plane loop and records private readback, recovery, and reversal
   evidence. Self-host evidence is not Takoserver or Hosted evidence.
4. **External Host/Hosted evidence** — Takoserver owns the managed smoke,
   Offering, capacity, provider receipt, support, incident, recovery, and
   production records. Takosumi Hosted owns retail/client, payment, and
   customer-communication records. OSS docs link to those records instead of
   copying service matrices or private evidence.
5. **Human acceptance** — only the named owner decisions below can close a
   final launch decision after every machine-checkable layer is green and the
   evidence references match the exact candidate.

## Human-only final blockers

Automation must block on a failed test, missing/stale evidence, contract drift,
candidate mismatch, or unsafe boundary; none may be waived by this document.
Independent engineering, security, schema, and release review may be performed
by a non-authoring agent and therefore is not a human-only blocker. After those
checks pass, the remaining blockers are decisions or authorities that require
accountable humans:

- the operator authorizes the exact production target, credential custody,
  maintenance window, and rollback/forward-repair posture;
- the legal/privacy owner accepts the public terms and data-handling posture;
- the Takoserver owner accepts provider supply, price/credit economics,
  support, incident/abuse, and customer-communication readiness for managed
  services;
- the Takosumi Hosted owner accepts its retail, payment, and customer support
  readiness; and
- the production operator makes the final go/no-go decision for the exact
  candidate and target.

The product owner then records a single `go` or `no-go` against the exact OSS,
Takoserver, or Hosted revision and evidence set. A task, branch name, green
repository gate, or this document never authorizes production mutation.

## Read this with

- [Core Spec](./core-spec.md) — current OSS contract and ownership boundary.
- [Architecture](./architecture.md) — target five-module design, gaps, and
  safe deletion order.
- [Core Conformance](./core-conformance.md) — current repository evidence map;
  gaps remain gaps rather than roadmap completion.
- [Takosumi v1 release procedure](../operations/takosumi-v1-release.md) — OSS
  provenance and release obligations.
- [Takoform Core and Host API](https://github.com/tako0614/takoform),
  [Form publisher](https://github.com/tako0614/takoform-forms), and
  [OpenTofu provider](https://github.com/tako0614/terraform-provider-takoform)
  — owning sources for external portable semantics and publication status.
- [Takoserver](https://github.com/tako0614/takoserver) — managed Host supply,
  Offering, Resource/Deployment lifecycle, and provider receipts.
- [Takosumi Hosted](https://github.com/tako0614/takosumi-hosted) — optional
  retail/commerce/client composition; it does not own managed supply. These
  surfaces are not Takosumi Core contracts.
