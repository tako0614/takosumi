# Product boundaries

The name Takosumi is used at three layers.

| Layer | What it is |
| --- | --- |
| Takosumi software | The software published under AGPL-3.0. Anyone can run it in their own environment |
| Takosumi for Operator | The framework for running it on behalf of other people |
| Takosumi Cloud | The officially operated hosted service |

## What the software carries

Takosumi software contains the Git-backed OpenTofu control plane, the Capsule and Run
lifecycle, and the state and audit ledgers. Alongside those come Resources (the Service
Form host) which can be turned on when needed, the compatibility API framework and its
Adapters, Interfaces and InterfaceBindings, and the CLI, dashboard, and accounts plane.

This documentation covers that layer, and describes only behaviour that holds on any
endpoint.

## What the operator decides

Two endpoints can run the same software and still differ on all of the following, because
whoever operates the endpoint decides them.

- Which Resource types are available
- The targets (TargetPool) and the implementations that run there
- Whether usage is recorded, and whether it goes as far as invoicing
- The frequency and concurrency of periodic observation
- Deployment to production, and the procedures around secrets

So "can Takosumi do X" is answered per endpoint. There is one way to find out, which is to
ask that endpoint itself.

```bash
curl -s https://takosumi.example.com/.well-known/takosumi
```

The `features` it returns say what is enabled. Read that capability rather than an edition
name.

## What only Takosumi Cloud has

The official hosted service adds managed targets and the implementations on them, billing
that produces invoices, support and an SLA, published prices and a free tier, and defined
behaviour when a balance runs out.

None of that is a feature of the software, so this documentation leaves it aside. Pricing
and the use of managed resources are covered in the Cloud documentation.

## How self-hosting relates

The right to run the software yourself and the right to use the official service are
separate things. On an endpoint you self-host, you make the operator decisions listed
above yourself. To the people who use that endpoint, you are the operator.

## Related

- [Overview](./index.md)
- [Glossary](../reference/glossary.md)
