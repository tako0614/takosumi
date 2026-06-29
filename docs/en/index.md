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
  + Takosumi-owned native resources
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

Compatibility APIs are capability surfaces. Examples include `compat.s3.v1`,
`compat.oci.v1`, and `compat.cloudevents.v1`. They are scoped and versioned
subsets, not a claim of full AWS or full Cloudflare compatibility.

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
