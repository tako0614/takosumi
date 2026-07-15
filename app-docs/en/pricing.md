# Takosumi Cloud pricing

This page is the public pricing and billing contract for Takosumi Cloud.
It contains only customer-facing prices, free-tier terms, usage limits, and
spend-guard behavior. Payment-provider synchronization, versioned
`PriceCatalog` operation, margin guards, cost estimates, and reconciliation
belong in operator procedures, not in the public contract.

## Subscription Plans

Takosumi Cloud combines monthly subscriptions with usage billing. Public plan
cards do not show a "usable dollar amount" or credit grant. Like AI services,
they show the plan name, monthly price, whether usage billing applies, usage
limits, and payment status.

| Plan | Customer pays | Public billing model      |
| ---- | ------------- | ------------------------- |
| Lite | `$1` / month  | Base subscription + usage |
| Plus | `$5` / month  | Subscription with usage   |
| Pro  | `$10` / month | Subscription with usage   |

Checkout and Dashboard billing views must match this public pricing. If they
do not match, do not continue the purchase or plan change; contact support.

## Usage and Limits

Takosumi Cloud records usage internally in USD micro-units. However,
subscription plan allowance and cost-accounting values are not part of the
public plan display. The Dashboard may show usage, billable operations, payment
state, limits, and history when useful.

```text
subscription:
  public: plan name + monthly price + usage billing
  internal: allowance / usage ledger / spend guard
```

Billable create, deploy, runtime, data-plane write/query/message, and instance
operations pass through the spend guard before execution. If payment setup,
limits, internal allowance, or available capacity is insufficient, the request
fails closed before it reaches a Cloud endpoint, AI upstream, runtime dispatch,
or provider-compatible write path.

## Usage Prices

Takosumi Cloud prices provider-neutral, versioned `ServiceOffering` and SKU
records rather than provider API families. Whether an `EdgeWorker` uses Workers
for Platforms internally, or an `ObjectBucket` uses R2, is not a public pricing
noun. Before creation, Preview shows the offering version, SKU version,
PriceCatalog version, tax treatment, unit price, estimated total, and expiry.
Apply accepts only that exact reviewed quote.

No GA Stable offering is active in the operator catalog yet. The former
provider-family rate table is therefore withdrawn. Cloud Resource purchase and
Apply remain fail closed until an approved version, effective time, and price
are published both here and in Dashboard Preview. The minimum GA table will use
this form:

| Service form | Offering / SKU version | Effective at | Billable item / unit | Customer price | Availability |
| ------------ | ---------------------- | ------------ | -------------------- | -------------- | ------------ |
| EdgeWorker   | Not active             | —            | —                    | —              | Blocked      |
| ObjectBucket | Not active             | —            | —                    | —              | Blocked      |

AI Gateway is not a Resource lifecycle authority. If billing is enabled for
it, the same PriceCatalog must contain a versioned SKU and request/token prices.
An unpriced meter, an ambiguous match across SKUs, or a catalog that is not yet
effective cannot proceed to billing or backend execution.

## Spend Guard

Takosumi Cloud preauthorizes billable writes, deploys, runtime dispatch, and
data-plane operations before execution.

```text
allowed by plan / spending limit:
  record usage event
  execute the operation

not allowed:
  fail closed before downstream execution
```

When payment state or limits do not allow an operation, the request does not
proceed to the Cloud endpoint, AI upstream, runtime dispatch, or
provider-compatible write path. Successful billable operations are recorded as
owner-account usage events with source Workspace attribution and reflected in
the billing projection.

Destroy / DELETE cleanup is the exception. Cleanup should remain available
without an additional precharge so users can remove already-created resources
after a limit or payment-state block.

## Bring your own key is never billed

Takosumi Cloud bills only Takosumi-provided managed resources (the subscription
plus explicitly activated versioned prices above). An external provider you
connect with your OWN Provider Connection (your own key) is billed by that
provider directly — Takosumi never meters or spend-gates it. When your balance
is exhausted, runs that use your own-key providers and the OSS OpenTofu run
ledger are not stopped. Provider choice has no allowlist and no approval.

## Secret and Billing Safety

Usage events, billing projections, catalogs, status responses, and model
metadata must not contain secret values.

These values are not stored in the usage ledger:

- provider credentials
- API keys / bearer tokens
- database URLs / DSNs / passwords
- upstream AI keys
- payment provider secrets

If a Cloud endpoint cannot record usage, lacks a price, has invalid Workspace
context, lacks scope, or fails the payment-state / limit check, it fails
closed.
