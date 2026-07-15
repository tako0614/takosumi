# Billing mode boundary

Takosumi OSS supports only these billing modes:

- `disabled`: no billing gate;
- `showback`: record plan/usage measurements without blocking apply. An
  injected `ShowbackRater` may price them; otherwise they are zero / `unrated`.

OSS may expose generic usage and cost evidence for an operator, but it does not
own customer prices, payment collection, official metering, credit balances,
commercial plan catalogs, margin guards, or enforced quota/payment decisions.
Rating, enforcement, and quota are injected through generic host composition
ports. OSS itself contains no default price or plan-action weight.

Takosumi Cloud owns its versioned PriceCatalog, payment-provider integration,
official managed-resource meters, enforced balance gate, and reconciliation in
the closed delta. The operator procedure is maintained in
`takosumi-cloud/docs/operations/cloud-pricing.md`; public prices and free-tier
behavior are maintained in `app-docs/pricing.md`.

The dependency remains one-way: Cloud may implement OSS ports, while OSS never
imports Cloud pricing or payment contracts. Workspace and optional Capsule
attribution use `workspaceId` and `capsuleId`; retired Space/Installation
billing aliases are not part of the current contract.
