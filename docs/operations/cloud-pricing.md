# Billing and pricing ownership boundary

Takosumi OSS supports only these billing modes:

- `disabled`: no billing gate;
- `showback`: record plan/usage measurements without blocking apply. An
  injected `ShowbackRater` may price them; otherwise they are zero / `unrated`.

OSS may expose generic usage and cost evidence for an operator, but it does not
own customer prices, payment collection, official metering, credit balances,
commercial plan catalogs, margin guards, or enforced quota/payment decisions.
Rating, enforcement, and quota are injected through generic host composition
ports. OSS itself contains no default price or plan-action weight.

Takosumi Hosted may own retail PriceCatalog, payment-provider integration,
prepaid balance, and customer-facing reconciliation. Takoserver owns the price,
meter, quota, settlement, and support terms attached to its Host-owned managed
supply. Those products publish and operate their own contracts; OSS does not
import either contract or copy prices into this runbook. Takosumi Cloud and
`app-docs/pricing.md` are retained history, not current pricing authority.

The dependencies remain one-way through public seams. Workspace and optional
Capsule attribution use `workspaceId` and `capsuleId`; retired
Space/Installation billing aliases are not part of the current contract.
