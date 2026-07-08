# Takosumi software

Takosumi is a Git-based OpenTofu control plane. It can run ordinary
OpenTofu/Terraform modules as-is, and it can resolve `takosumi_*` Resource
Shapes to Targets and Adapters when that typed service form is useful.

This page is for Takosumi software and Takosumi for Operator docs. The official
hosted Takosumi Cloud service that we operate is documented separately at
[app.takosumi.com/docs](https://app.takosumi.com/docs/en/).

## Which Docs To Read

| Need                                                                  | Read                                                                                                                                                                                        |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Takosumi model, API, Runs, StateVersions, and Outputs                 | these software docs                                                                                                                                                                         |
| self-host or operator OpenTofu Stack flow                             | [Quickstart](./getting-started/quickstart.md) and [Model reference](./reference/model.md)                                                                                                   |
| Resource Shape API, Compatibility API framework, and Adapter system   | [Takosumi API](./reference/api.md) and [Model reference](./reference/model.md)                                                                                                              |
| `app.takosumi.com` managed resources, pricing, API keys, and usage    | [Takosumi Cloud docs](https://app.takosumi.com/docs/en/)                                                                                                                                    |
| Cloud endpoint families, compatibility matrices, and billing contract | [Cloud resources](https://app.takosumi.com/docs/en/resources), [Cloud endpoints](https://app.takosumi.com/docs/en/endpoints), and [Cloud pricing](https://app.takosumi.com/docs/en/pricing) |

## Product Split

```text
Takosumi OSS:
  Git-based OpenTofu control plane
  + plain OpenTofu stack execution
  + Resource Shape API
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
OSS owns the portable framework and APIs.
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
resolve Resource Shapes through TargetPool / Policy / Adapter
```

The core value is:

```text
Same manifest, different connection.
Same shape, different target.
```

The same `.tf` can move between dev/prod, accounts, and provider aliases by
changing ProviderBindings. The same Resource Shape can resolve to any
operator-enabled Target through TargetPool, Policy, and Adapter evidence.

## What Takosumi Does Not Rebuild

Takosumi does not recreate an existing industry-standard API, protocol, or
OpenTofu provider when that surface is already enough.

```text
Standard API / protocol / OpenTofu provider exists:
  use that surface through the Stack flow or a scoped compatibility profile.

No standard surface exists, and the service form is repeated:
  define a typed Takosumi Resource Shape.

One-off gap:
  use generic-env ProviderConnection and an ordinary OpenTofu module.
```

The `takosumi/takosumi` provider is not required to use Takosumi. If an existing
provider is enough, run it through the Stack flow. Use the Takosumi provider
only for Takosumi-owned typed Resource Shapes or operator/admin objects.

## Compatibility API

Compatibility APIs are Takosumi OSS framework and capability surfaces. They are
scoped and versioned, such as `compat.s3.v1`, `compat.oci.v1`,
`compat.cloudevents.v1`, and `compat.cloudflare.workers.v1`.

They are not full AWS API compatibility or full Cloudflare API compatibility.
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

Technical details are available in the [Model reference](./reference/model.md).
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
- [Takosumi Cloud docs](https://app.takosumi.com/docs/en/)
