# Usage and billing

Takosumi records what was used and how much. **The software itself never bills anyone.**

## Reading usage

```bash
curl -s "$TAKOSUMI_DEPLOY_CONTROL_URL/api/v1/workspaces/ws_example/usage" \
  -H "authorization: Bearer $TAKOSUMI_DEPLOY_CONTROL_TOKEN"

curl -s "$TAKOSUMI_DEPLOY_CONTROL_URL/api/v1/capsules/cap_example/usage-summary" \
  -H "authorization: Bearer $TAKOSUMI_DEPLOY_CONTROL_TOKEN"

curl -s "$TAKOSUMI_DEPLOY_CONTROL_URL/api/v1/runs/run_example/cost" \
  -H "authorization: Bearer $TAKOSUMI_DEPLOY_CONTROL_TOKEN"
```

Workspace usage comes back as a list of line items, each saying what was measured, how
much, when, and which Resource it belongs to. The per-Capsule summary answers which
application used how much. A Run's cost estimate can be read **before you apply it**.

## Billing modes

```bash
curl -s "$TAKOSUMI_DEPLOY_CONTROL_URL/api/v1/workspaces/ws_example/billing" \
  -H "authorization: Bearer $TAKOSUMI_DEPLOY_CONTROL_TOKEN"
```

Takosumi has two modes and no others.

| Mode | Meaning |
| --- | --- |
| `disabled` | Records nothing and bills nothing |
| `showback` | Records usage but does not bill |

**Running with real invoicing is not a feature of the software.** Halting execution when a
balance runs out, holding a price list, or reconciling against a payment method does not
live at this layer. Takosumi Hosted retail/commerce and Takoserver managed supply publish
their own prices, limits, and payment contracts. Retired Takosumi Cloud pages are not
current pricing authority ([Product boundaries](./boundaries.md)).

When you self-host, usage records exist for your own visibility.

## Related

- [Run model](./run-model.md)
- [Product boundaries](./boundaries.md)
