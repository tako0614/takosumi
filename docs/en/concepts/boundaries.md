# Takosumi and Takosumi Cloud

These docs use two names so the software and the official service are not
confused.

| Name               | Meaning                                            |
| ------------------ | -------------------------------------------------- |
| **Takosumi**       | the AGPL-3.0 software published in this repository |
| **Takosumi Cloud** | the official hosted service at `app.takosumi.com`  |

## What the software provides

Takosumi OSS includes:

- plan, apply, state, outputs, and audit records for Git modules
- secure storage and runner delivery for provider connections
- a dashboard, API, CLI, and sign-in
- a shared lifecycle for typed Resources
- records for endpoints and permissions between deployments

The module, provider, or an operator-installed Resource implementation decides
which cloud is used. Takosumi OSS does not require one cloud account or
provider.

## What the operator decides

Two installations of the same software can differ in:

- available Resource types
- the clouds and implementations that create those Resources
- storage capacity, usage limits, and backup retention
- whether usage is only recorded or also billed
- updates, incident response, support, and SLA

Check an endpoint instead of guessing from an edition name.

```bash
curl https://takosumi.example.com/.well-known/takosumi
```

An authenticated client can also read `/v1/capabilities`.

## What Takosumi Cloud adds

Takosumi Cloud is an official operation of the OSS software. It adds managed
Resource implementations, official capacity, pricing and payment, support,
SLA, and abuse controls.

Those are not general OSS contracts. Use the
[Takosumi Cloud documentation](https://app.takosumi.com/docs/en/) for prices
and limits.

Cloud code consumes OSS contracts. The OSS software does not depend on private
Cloud code or Stripe.

## Where Takoform fits

Takoform is an independent specification and toolset for describing Resource
shapes separately from a provider or cloud. Takosumi can accept Takoform, but
Takoform is not the only possible Resource entrance.

Cloudflare, AWS, and other Terraform or OpenTofu providers remain ordinary
providers from the runner's perspective. Takosumi Cloud and a cloud account
connected by a user both pass through the shared Run and Resource lifecycle.

Takos is a separate product. Its self-hosted product worker does not embed
Accounts, deploy-control, the Dashboard, or the runner; it connects to a
Takosumi endpoint as an external client.

## When you self-host

When you operate Takosumi yourself, you become the operator described above.
You manage software updates, secrets, databases, runners, backups, and any
Resource implementations you enable.

Read [Self-hosting](./self-host.md) for topology choices and the
[operator runbooks](https://github.com/tako0614/takosumi/blob/main/docs/operations/README.md)
for procedures.
