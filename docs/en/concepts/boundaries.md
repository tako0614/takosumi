# Takosumi and the Takosumi hosted service

These docs use two names so the software and the official service are not
confused.

| Name               | Meaning                                            |
| ------------------ | -------------------------------------------------- |
| **Takosumi**       | the AGPL-3.0 software published in this repository |
| **Takosumi hosted service** | the official hosted service at `app.takosumi.com`  |

## What the software provides

Takosumi OSS includes:

- plan, apply, state, outputs, and audit records for Git modules
- secure storage and runner delivery for provider connections
- a dashboard, API, CLI, and sign-in
- records for endpoints and permissions between deployments through
  Interface / InterfaceBinding
- ProviderConnection / ProviderBinding for arbitrary OpenTofu and Terraform
  providers

The module, provider, or operator configuration decides which cloud is used.
Takosumi OSS does not require one cloud account or provider. Takoform runs from
the OpenTofu runner as an ordinary provider. Takosumi does not mirror
provider-side objects into a second resource ledger or create a second
lifecycle for them.

Older descriptions that made Takosumi OSS a Resource Shape or Form Host are
retired. Form definitions, providers, packages, and hosted Form instances are
owned by Takoform or an external Host such as the Takosumi hosted service. Retained Resource
APIs, schemas, and persistence exist only as temporary migration internals;
they are not a supported OSS authoring surface.

## What the operator decides

Two installations of the same software can differ in:

- provider configuration and execution environment
- the external Host or the Takosumi hosted service that supplies hosted Form instances
- storage capacity, usage limits, and backup retention
- whether usage is only recorded or also billed
- updates, incident response, support, and SLA

Check an endpoint instead of guessing from an edition name.

```bash
curl https://takosumi.example.com/.well-known/takosumi
```

An authenticated client can also read `/api/v1/capabilities`.

## What the Takosumi hosted service adds

The Takosumi hosted service is an official operation of the OSS software. It
adds hosted Form instances and their implementations, official capacity,
pricing and payment, support, SLA, and abuse controls.

Those are not general OSS contracts. Use the
[Takosumi hosted service documentation](https://app.takosumi.com/docs/en/) for prices
and limits.

Hosted-service code consumes OSS contracts. The OSS software does not depend on
private hosted-service code or Stripe.

## Where Takoform and external Hosts fit

Takoform is an independent specification, provider, and package project. From
Takosumi's perspective it is an ordinary OpenTofu provider. A Form Host or
hosted instance is owned by Takoform's host implementation, the Takosumi hosted service, or
another external operator—not by the OSS control plane.

Cloudflare, AWS, and other Terraform or OpenTofu providers remain ordinary
providers from the runner's perspective. The authority after provider
execution is not identical, however.

- A module that uses Cloudflare, AWS, or another provider directly shares the
  Run, state, output, and audit records. Provider-side objects do not
  necessarily enter Takosumi's Resource ledger.
- A hosted Form instance is resolved and operated by its external Host. It is
  not an implicit Takosumi Resource or TargetPool selection.
- The runner does not silently select a hosted-service-specific provider.

Takos is a separate product. Its self-hosted product worker does not embed
Accounts, deploy-control, the Dashboard, or the runner; it connects to a
Takosumi endpoint as an external client.

## When you self-host

When you operate Takosumi yourself, you become the operator described above.
You manage software updates, secrets, databases, runners, backups, and
provider configuration. If you use a hosted Form instance, the external Host
has its own contract and operational boundary.

Read [Self-hosting](./self-host.md) for topology choices and published setup
procedures. Repository-local operator runbooks are not customer-facing product
documentation.
