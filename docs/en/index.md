# Takosumi

Takosumi is a Git-based OpenTofu control plane. It can run ordinary
OpenTofu/Terraform modules as-is, and it can resolve `takosumi_*` Resource
Shapes to Targets and Adapters. Takosumi Cloud is the official hosted operation
of Takosumi.

## What You Do First

```text
1. Choose a service or paste a Git URL
2. Connect the required cloud account
3. Review the resources that will be created or updated
4. Approve the deploy
5. Inspect the URL, history, state, outputs, and activity
```

Start with the [Quickstart](./getting-started/quickstart.md).

## Cloud and OSS

```text
Takosumi OSS:
  Git-based OpenTofu control plane
  + Resource Shape API
  + Resolver / Planner / Reconciler
  + Target / Credential / OIDC / Policy
  + Compatibility API framework
  + Adapter system.

Takosumi for Operator:
  Takosumi
  + customer management
  + billing / metering / quota
  + operator console
  + managed target catalog
  + commercial operation.

Takosumi Cloud:
  official hosted Takosumi for Operator
  + official managed targets
  + Cloud-operated managed service backends
  + official billing / SLA / support.
```

The most important boundary:

```text
OSS owns the portable framework and APIs.
Operator / Cloud own commercial operation and managed capacity.
```

## Product Words

The normal UI does not lead with internal control-plane nouns.

| UI word       | Meaning                                              |
| ------------- | ---------------------------------------------------- |
| Service       | The app, worker, API, site, or storage you host      |
| Connection    | The Cloudflare / AWS / GCP account Takosumi can use  |
| Changes       | The plan / resource summary you review before deploy |
| History       | Who changed what and when                            |
| Restore point | A state version you can recover from                 |

Technical details are still available in the [Model reference](./reference/model.md).

## What Takosumi Manages

```text
add a service or Git repo
check required connections
inject env/files only for the Run
run OpenTofu/Terraform against existing providers
resolve Resource Shapes to Targets and Adapters
review and approve apply
store state, outputs, run history, and audit
```

The core value is:

```text
Same manifest, different connection.
Same shape, different target.
```

This does not mean Takosumi should recreate every provider or standard API. If
an adequate generic OpenTofu provider or standard endpoint already exists, use
it through the Stack flow. Before adding a new `takosumi_*` resource, check
whether an existing provider, a standard endpoint, or a generic-env
ProviderConnection is enough. Takosumi shapes are for provider-neutral service
forms where Takosumi must own bindings, policy, metering, import paths, or
managed target placement.
The reverse is scoped too: if a generic provider does not exist, Takosumi still
does not add a catch-all provider by default. One-off gaps stay in generic-env
ProviderConnections and ordinary OpenTofu modules. New `takosumi_*` resources
are added only for repeated service forms with a typed schema, planner, adapter,
state/import/drift behavior, and capability evidence.

## What OSS Includes

```text
Git integration
OpenTofu runner
state / run history / audit
Resource Shape API
Resolver / Planner / Reconciler
TargetPool
Credential / OIDC / Secret / Policy
Compatibility API framework
Adapter framework
takosumi_provider-compatible API
```

Compatibility APIs are capability surfaces. Examples include `compat.oci.v1`,
`compat.cloudevents.v1`, and `compat.cloudflare.workers.v1`. These are not a
roadmap to rebuild standard APIs. `compat.s3.v1` is only needed when an
operator intentionally exposes object-storage data/control compatibility;
ordinary S3/R2/GCS use should go through existing providers or standard
endpoints. They are scoped and versioned subsets, not a claim of full AWS or
full Cloudflare compatibility.

Detailed Resource Shape and compatibility capability model lives in the
[Takosumi Final Plan](https://github.com/tako0614/takosumi/blob/main/docs/final-plan.md).

## Operator and Cloud Operation

Commercial operation and official managed capacity belong to Operator / Cloud.

```text
customer management
billing / metering / quota / plan
operator console
managed target catalog
official managed target pools
official native runtime / object store / queue / DB / edge gateway
official SLA / support / abuse controls
```

Takosumi Cloud is the official hosted operation. It can offer
Worker-compatible hosting, managed bindings, AI Gateway, and credits as official
managed services. Its Cloudflare Workers-compatible profile is an import and
deploy path for existing Workers apps, not full Cloudflare API compatibility.

## Next Documents

- [Quickstart](./getting-started/quickstart.md)
- [Takosumi Cloud](./cloud/index.md)
- [Model reference](./reference/model.md)
- [CLI reference](./reference/cli.md)
