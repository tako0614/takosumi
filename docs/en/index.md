# Takosumi software

Takosumi is software that deploys and manages OpenTofu/Terraform modules from
Git through a plan → review → apply flow. It can run ordinary
OpenTofu/Terraform modules as-is, and it can resolve Resource Shapes through
the current compatibility API when a typed service form is
useful. In the adopted target, the portable definition is a Service Form, its
exact identity is a FormRef, and Takosumi is an optional host that still works
with zero Form Packages installed (see the [glossary](./reference/glossary.md)
for one-line explanations of the terms).

This page is for Takosumi software and Takosumi for Operator docs. The official
hosted Takosumi Cloud service that we operate is documented separately at
[app.takosumi.com/docs](https://app.takosumi.com/docs/en/).

## Which Docs To Read

| Need                                                                                                          | Read                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Takosumi model, API, Runs, StateVersions, and Outputs                                                         | these software docs                                                                                                                                                                         |
| self-host or operator OpenTofu Stack flow                                                                     | [Quickstart](./getting-started/quickstart.md) and [Model reference](./reference/model.md)                                                                                                   |
| Service Form host (current Resource Shape compatibility API), Compatibility API framework, and Adapter system | [Takosumi API](./reference/api.md) and [Model reference](./reference/model.md)                                                                                                              |
| `app.takosumi.com` managed resources, pricing, API keys, and usage                                            | [Takosumi Cloud docs](https://app.takosumi.com/docs/en/)                                                                                                                                    |
| Cloud endpoint families, compatibility matrices, and billing contract                                         | [Cloud resources](https://app.takosumi.com/docs/en/resources), [Cloud endpoints](https://app.takosumi.com/docs/en/endpoints), and [Cloud pricing](https://app.takosumi.com/docs/en/pricing) |

## Product Split

```text
Takosumi OSS:
  Git-based OpenTofu control plane
  + plain OpenTofu stack execution
  + optional zero-form Service Form host
  + current Resource Shape compatibility API
  + Resolver / Planner / Reconciler
  + Target / Credential / OIDC / Secret / Policy
  + Compatibility API framework
  + Adapter system

Takosumi for Operator:
  Takosumi
  + customer / tenant operation
  + billing / metering / quota
  + DB-backed operator configuration
  + CLI / API / runbook operations
  + managed target catalog

Takosumi Cloud:
  official hosted Takosumi for Operator
  + official managed targets
  + Cloud-operated managed service backends
  + official billing / SLA / support
```

The boundary is:

```text
The portable project owns Service Forms, FormRefs, Form Packages, and typed-client conformance.
Takosumi OSS owns the generic host lifecycle and APIs.
Operator / Cloud own commercial operation and managed capacity.
```

Cloud is not the Takosumi core. It is the official hosted deployment. Software
docs describe APIs and models that work for any Takosumi endpoint, self-hosted
installation, or operator-run deployment. Cloud docs describe the managed
resources, pricing, spend guard, and endpoint families at `app.takosumi.com`.

## What Takosumi Manages

Takosumi manages the outside of OpenTofu/Terraform:

```text
register Git repos / Sources
store ProviderConnections
inject env/files only for a Run through CredentialRecipes
run OpenTofu/Terraform in a runner sandbox
record plan / apply / destroy as Run ledger entries
store StateVersions, Outputs, logs, and AuditEvents
resolve exact Service Form-backed Resources through TargetPool / Policy / Adapter
```

The core value is:

```text
Same manifest, different connection.
Same form, different target.
```

The same `.tf` can move between dev/prod, accounts, and provider aliases by
changing ProviderBindings. The same exact Service Form can resolve to any
operator-enabled Target through TargetPool, Policy, and Adapter evidence. The
current wire and existing-state aliases from the discontinued provider call
this a Resource Shape.

## What Takosumi Does Not Rebuild

Takosumi does not recreate an existing industry-standard API, protocol, or
OpenTofu provider when that surface is already enough.

```text
Standard API / protocol / OpenTofu provider exists:
  use that surface through the Stack flow or a scoped compatibility profile.

No standard surface exists, and the service form is repeated:
  admit a typed Service Form through portable governance.

One-off gap:
  use generic-env ProviderConnection and an ordinary OpenTofu module.
```

The `takosumi/takosumi` provider is discontinued and must not be used for new
configuration. Existing providers run unchanged through the Stack flow. Use
Takoform for portable Service Forms and Form-backed Resource Interface
descriptors, service-side InstallConfig blueprints for Capsule Interfaces, and
Takosumi API, CLI, or dashboard for operator administration. Old provider
source remains only for existing-state migration and rollback custody.

## Compatibility API

Compatibility APIs are Takosumi OSS framework and capability surfaces. They are
scoped and versioned, such as `compat.s3.v1`, `compat.oci.v1`,
`compat.cloudevents.v1`, and `compat.kubernetes.crd.v1`.

They are not claims of complete provider API compatibility.
When existing providers or standard endpoints are enough for S3/R2/GCS,
registries, queues, or databases, use those providers or endpoints.

## Product Words

The normal UI does not lead with internal model nouns.

| UI word       | Meaning                                              |
| ------------- | ---------------------------------------------------- |
| Service       | The app, worker, API, site, or storage you host      |
| Connection    | The Cloudflare / AWS / GCP account Takosumi can use  |
| Changes       | The plan / resource summary you review before deploy |
| History       | Who changed what and when                            |
| Restore point | A state version you can recover from                 |

One-line explanations of the other terms live in the
[glossary](./reference/glossary.md); technical details are available in the
[Model reference](./reference/model.md).
Use the [App Handoff Protocol](./reference/app-handoff.md) when an external web,
desktop, mobile, or CLI client needs to create a hosted service.

## Docs Boundary

Published docs contain only the external contract that users, self-host
operators, and Takosumi Cloud customers can rely on. Internal notes, operator
runbooks, secret rotation, raw readiness records, pricing sync procedures, and
implementation-only wiring are not public product contracts.

The full classification is fixed in the
[Published docs contract](./reference/docs-contract.md).

## Next Documents

- [Quickstart](./getting-started/quickstart.md)
- [Model reference](./reference/model.md)
- [Takosumi API](./reference/api.md)
- [Deploy-Control API](./reference/deploy-control-api.md)
- [Operator control MCP](./reference/operator-control-mcp.md)
- [Takosumi Cloud docs](https://app.takosumi.com/docs/en/)
