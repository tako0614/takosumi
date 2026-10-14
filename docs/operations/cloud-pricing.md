# Billing mode boundary

Takosumi OSS supports only these billing modes:

- `disabled`: no OSS showback usage ledger;
- `showback`: record plan/usage measurements without blocking apply. An
  injected `ShowbackRater` may price them; otherwise they are zero / `unrated`.

OSS may expose generic usage and cost evidence for an operator, but it does not
own customer prices, payment collection, official metering, credit balances,
commercial plan catalogs, margin guards, or enforced quota/payment decisions.
Rating, enforcement, and quota are injected through generic host composition
ports. OSS itself contains no default price or plan-action weight.

An operator may explicitly require injected host decisions by setting
`billingEnforcementRequired: true` at the service composition root. The complete
rating, quota, and reserve/check/capture/release ports then remain required even
when a Workspace selects `disabled`. That setting suppresses OSS UsageEvents;
it does not disable the host's authority. Default self-host compositions still
use no-op enforcement and quota. Destroy and refresh-only plans retain their
reservation-free cleanup path.

For Workers, `TAKOSUMI_BILLING` is a private service binding to a host's named
`WorkerEntrypoint` implementing the seven direct methods in `BillingRpcService`.
The operator sets `TAKOSUMI_BILLING_REQUIRED` to the exact string `1` to require
that port; any other supplied value is invalid. Missing required bindings and
incomplete local compositions fail initialization. Unimplemented remote methods,
remote errors, and malformed DTOs fail closed without retries or fallback.
Each remote call has a fixed 15-second deadline. A timeout is an unknown
acknowledgement rather than cancellation or proof of no mutation; recovery
retains the original plan/apply references. The port clears its timer and never
retries a timed-out mutation automatically.
Remote exception text is not copied into Core diagnostics. The existing
`TAKOSUMI_BILLING_EXTENSION_FACTORY`
remains available for in-process composition and cannot be selected alongside
the RPC binding. Its function-bearing `create()` result is local, never an RPC
return value.

Core supplies canonical Workspace, owner subject, and Run identities through
provider-neutral DTO contexts; neither request-supplied billing subjects nor
commercial records are accepted at this seam. `capturedUsdMicros` is the OSS
plan estimate, not a measured provider bill. The host independently resolves
trusted measurements and its own commercial ledger. Returned audit fields must
be non-secret JSON; no host credential, balance, or payment-provider record
belongs in them.

The injected commercial host composes pricing, official metering, payment
collection, balance enforcement, and reconciliation from their owning services.
Those services publish their own prices and operator procedures. This OSS
document defines only the provider-neutral decision seam.

The dependency remains one-way: Cloud may implement OSS ports, while OSS never
imports Cloud pricing or payment contracts. Workspace and optional Capsule
attribution use `workspaceId` and `capsuleId`; retired Space/Installation
billing aliases are not part of the current contract.

## Optional retained-artifact facts

`TAKOSUMI_ARTIFACT_STORAGE_USAGE` is an operator-selected private direct RPC
port for exact retained-artifact facts. It carries Workspace scope, an opaque
artifact digest, exact encrypted byte count and an authenticated acknowledgement;
it carries no price, wallet, Organization, account or session. A missing port
preserves self-host behavior. Configuring this source requires its approved
caller/target graph and authenticated initial inventory; it never assumes an
empty existing bucket.

The real runner's `#r2State()` adapter observes only canonical encrypted immutable
StateVersion keys. It persists intent before a conditional create, verifies
bounded encrypted readback, and confirms the original intent before returning
or adopting an artifact. Exact GET/PUT replay cannot recreate a released object,
replace ciphertext, or turn a failed condition into a successful write. Unknown
custody ACK is bounded at 15 seconds with no automatic mutation retry. The
recovery-state adapter similarly gates its optional stage and handle verifier.

This is a declared subset. Legacy artifact-bucket state, plans, provider locks,
outputs/evidence, source archives, backups and temporary Restore stages need
their own qualified source writers and lifecycle inventory. The current runtime
does not collect final immutable StateVersions. Future deletion must preserve
the same release intent and confirmed absence. Raw facts support a host-owned
closed-period integration; this source adds no tariff, scheduler, production
binding or claim of complete Hosted storage. Provider-periodic Resource charges
must not be submitted again through this retained-artifact lane. CPU is not
derived from Run duration, and these byte receipts do not attest runner CPU or
provisioned memory.
