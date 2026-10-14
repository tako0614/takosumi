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
