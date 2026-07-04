# Takosumi Cloud pricing

This page is the public pricing and credit contract for Takosumi Cloud.
It contains only customer-facing prices, free-tier terms, and credit-exhaustion
behavior. Payment-provider synchronization, runtime price books, margin guards,
cost estimates, and reconciliation belong in operator procedures, not in the
public contract.

## Plans and Credit Packs

Takosumi Cloud uses USD-denominated credits. Credits are a balance consumed by
the Takosumi Cloud usage ledger; they are not cash USD and cannot be redeemed
or exchanged as cash.

| Plan / pack          | Customer pays   | Credit grant |
| -------------------- | --------------- | ------------ |
| Starter              | JPY 980 / month | `$3.00`      |
| `$5.00` balance pack | JPY 1200        | `$5.00`      |

Checkout and Dashboard billing views must match this public pricing. If they
do not match, do not continue the purchase or additional charge; contact
support.

## Free Tier

Each Workspace may receive a monthly included credit grant. The initial value is
`$0.25 / month` per Workspace.

```text
monthly included credit:
  $0.25 per Workspace per month
```

The free tier does not roll over. Usage beyond the free tier spends purchased
credits at the same usage prices. When credit is insufficient, billable create,
deploy, runtime, data-plane write/query/message, and instance operations stop
before execution.

## Usage Prices

Usage is recorded in `usdMicros`. The Dashboard may round values for USD
display.

| Family               | Unit        | Customer price            |
| -------------------- | ----------- | ------------------------- |
| AI request           | request     | `$0.001` / request        |
| AI input tokens      | token       | `$0.30` / 1M tokens       |
| AI output tokens     | token       | `$1.00` / 1M tokens       |
| Workers Script       | operation   | `$0.001` / operation      |
| KV / D1 / R2 ops     | operation   | `$0.0005` / operation     |
| KV / D1 / R2 storage | GB-hour     | `$0.10` / 1M GB-hours     |
| Workflows            | operation   | `$0.001` / operation      |
| Containers           | vCPU-second | `$1.00` / 1M vCPU-seconds |
| Queues               | operation   | `$0.0005` / operation     |
| Durable Objects      | operation   | `$0.0005` / operation     |

Preview and Planned resources are billed only for Workspaces where that service
is actually enabled. This table is the pricing contract; it does not mean every
service is enabled for every user. Check the rollout matrix in
[Takosumi Cloud](./index.md) and the Dashboard endpoint status for availability.

## Credit Exhaustion

Takosumi Cloud precharges billable writes, deploys, runtime dispatch, and
data-plane operations before execution.

```text
enough available credit:
  record usage event
  execute the operation

not enough available credit:
  fail closed before downstream execution
```

When credit is insufficient, the request does not proceed to the Cloud
endpoint, AI upstream, runtime dispatch, or provider-compatible write path.
Successful billable operations are recorded as Workspace usage events and
reflected in the billing projection.

Destroy / DELETE cleanup is the exception. Cleanup should remain available
without an additional precharge so users can remove already-created resources
after credit depletion.

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
context, lacks scope, or has insufficient credit, it fails closed.
