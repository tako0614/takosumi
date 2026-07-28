# Overview

Takosumi adds one layer of record between the repositories you keep in Git and the
services that actually run. This page walks through that layer from the top.

## What happens

When you register a repository as a Source, Takosumi resolves the ref you asked it to
follow and pins the commit behind it as a SourceSnapshot. Everything downstream works
from that pinned commit rather than from the ref, so the answer to "what did we run back
then" stays fixed.

From there you create a plan. Takosumi runs OpenTofu inside the runner and records what
would change as a Run. At this point nothing has changed yet.

Once a person has read the plan and accepts it, you apply **that same Run**. There is no
path that re-plans before applying, so what you reviewed is what runs.

When the apply finishes, the state at that moment is saved as a StateVersion, and the
values you chose to publish become Outputs. Who ran what, and when, stays in the Run and
in the activity record.

```text
register a Source
  → resolve the ref and pin a SourceSnapshot
  → create a plan Run
  → a person reads it
  → apply the same Run
  → a StateVersion and Outputs remain
```

Nothing is applied without a plan in front of it. A new commit landing in Git, or a
difference found against the running thing, moves nothing until a person has looked.

## The things involved

| Term | Meaning |
| --- | --- |
| Workspace | The unit that groups people and resources. Members and permissions are decided here |
| Project | A division used to organize the inside of a Workspace |
| Source | A registered Git repository |
| SourceSnapshot | The specific commit a Source resolved to |
| Capsule | One deployed unit |
| Run | The record of a single execution |
| StateVersion | The state at the end of an execution |
| Output | A non-secret value a Capsule publishes |
| Connection | Credentials stored write-only |
| Interface | A declaration of what a deployment offers at runtime |
| InterfaceBinding | The authorization that says who may use it |

Fuller definitions are collected in the [glossary](../reference/glossary.md).

## Two ways to create a service

What is described above is the **Stack flow**, where a module you wrote yourself runs
from Git. The module can contain anything, and no Takosumi-specific manifest is needed.

The other way is a **Resource**, a typed service you get by declaring it. Takosumi
resolves where and on what implementation to create it, so no module is involved, though
the set of types you can create is fixed in advance.

The two entrances share everything after them: the same Run ledger, the same state
management, the same audit record.

## Providers still do the provisioning

Cloudflare, AWS, and Kubernetes are driven by their own providers, exactly as before.
Takosumi does not rebuild the cloud APIs, and it does not reach inside your module.

## Read on

- [Sources and Capsules](./sources.md) — how Git is handled, and what "deployed" means
- [Run model](./run-model.md) — what a Run executes, and how
- [State and outputs](./state-and-outputs.md) — what is stored, what is published, how to
  go back
- [Credentials](./credentials.md) — how far values travel, and what lands in the record
- [Resources](./resources.md) — typed services and how they are resolved
- [Interfaces](./interfaces.md) — declaring what you offer, and authorizing its use
- [Usage and billing](./usage-and-billing.md)
- [Product boundaries](./boundaries.md) — what the software does and what the operator
  decides
