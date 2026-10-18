# Usage and billing

Takosumi records what was used and how much. **The software itself never bills anyone.**

## Reading usage

Put a [token you created](../reference/cli.md#creating-a-token) with `read` in
`$TAKOSUMI_DEPLOY_CONTROL_TOKEN` for these examples.

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

**Running with real invoicing is not a feature of the software.** In the default OSS composition,
nothing halts execution when a balance runs out, holds a price list, or reconciles against a
payment method. Only when the people running Takosumi add a billing limit can that limit stop
a plan. For prices and limits on the official hosted service, see its
own documentation ([Product boundaries](./boundaries.md)).

When you self-host, usage records exist for your own visibility.

## Related

- [Run model](./run-model.md)
- [Product boundaries](./boundaries.md)
