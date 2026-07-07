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

## Docs Boundary

These docs are public product docs. They contain product definitions, API
contracts, Resource Shapes, Compatibility APIs, and the public Takosumi Cloud
contract that users and operators can rely on.

Development notes, conformance notes, deploy procedures, secret rotation, raw
readiness records, concrete pricing sync procedures, and implementation-only
wiring are not public product contracts.

When an internal note becomes a stable public contract, rewrite only the
contract into the published docs instead of linking public readers to the
internal note. The full classification is fixed in the
[Published docs contract](./reference/docs-contract.md).

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
  + DB-backed operator configuration
  + CLI / API / runbook operations
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
Use the [App Handoff Protocol](./reference/app-handoff.md) when an external web,
desktop, mobile, or CLI client needs to create a hosted service and receive the
resulting host URL.

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
an industry-standard API, protocol, or OpenTofu provider already fits, use that
surface through the Stack flow or a scoped compatibility profile. Before adding
a new `takosumi_*` resource, check whether an existing provider, standard
surface, or generic-env ProviderConnection is enough. Takosumi shapes are added
only for repeated service forms with no adequate standard surface and a clear
schema, planner, adapter, state/import/drift behavior, and capability evidence.
S3-compatible APIs, OCI registries, Kubernetes CRDs, CloudEvents, and
OpenAI-compatible endpoints remain external standard surfaces.
Using Takosumi does not require the `takosumi/takosumi` provider. If an
existing vendor-neutral provider is enough, run it through the Stack flow. Use
the Takosumi provider only for Takosumi-owned typed Resource Shapes or
operator/admin objects.

The public API boundary is documented in [Takosumi API](./reference/api.md).

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
typed Resource API for provider / CLI / dashboard / CRD
scoped compatibility API surfaces
```

Compatibility APIs are capability surfaces. Examples include `compat.oci.v1`,
`compat.cloudevents.v1`, and `compat.cloudflare.workers.v1`. These are not a
roadmap to rebuild standard APIs. `compat.s3.v1` is only needed when an
operator intentionally exposes object-storage data/control compatibility;
ordinary S3/R2/GCS use should go through existing providers or standard
endpoints. They are scoped and versioned subsets, not a claim of full AWS or
full Cloudflare Workers provider compatibility.

The public API boundary is documented in [Takosumi API](./reference/api.md).
Resource Shape vocabulary is documented in the [Model reference](./reference/model.md).

## Operator and Cloud Operation

Commercial operation and official managed capacity belong to Operator / Cloud.

```text
customer management
billing / metering / quota / plan
DB-backed operator configuration
CLI / API / runbook operations
managed target catalog
official managed target pools
official native runtime / object store / queue / DB / edge gateway
official SLA / support / abuse controls
```

Takosumi Cloud is the official hosted operation. It can offer EdgeWorker,
Container, Object Storage, KV, Database, Queue, and AI Gateway as official
managed resources, with official billing / usage metering / spend guard
operation. Its Cloudflare Workers-compatible profile is an import and deploy
path for existing Workers-oriented apps, not full Cloudflare API compatibility.

Cloudflare-compatible imports, existing OpenTofu providers, Dashboard actions,
and `takosumi/takosumi` Resource Shapes normalize into the Cloud managed
operation boundary before backend API calls. WfP and similar substrates are
Target / Adapter / manager implementation details.

## Next Documents

- [Quickstart](./getting-started/quickstart.md)
- [Takosumi Cloud](./cloud/index.md)
- [Model reference](./reference/model.md)
- [Takosumi API](./reference/api.md)
- [App Handoff Protocol](./reference/app-handoff.md)
- [CLI reference](./reference/cli.md)
