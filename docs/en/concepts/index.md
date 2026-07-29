# How Takosumi works

Takosumi is not a replacement for cloud APIs. It runs OpenTofu or Terraform
with existing providers, then adds review, authorization, and records around
that execution.

## Six terms to start with

| Name          | In plain language                                                      |
| ------------- | ---------------------------------------------------------------------- |
| **Workspace** | a boundary for a team and its permissions                              |
| **Project**   | a way to group apps and infrastructure within a Workspace              |
| **Source**    | a registered Git repository and module location                        |
| **Capsule**   | one deployable module created from a Source                            |
| **Run**       | one plan, apply, refresh, destroy, or other execution                  |
| **Resource**  | a service requested by type and settings instead of a module you write |

State, outputs, logs, and audit records are results of Runs. Provider API keys
and similar credentials are stored separately as **Connections** and assigned
only to the Runs that need them.

The [glossary](../reference/glossary.md) contains exact API names. You do not
need to learn all of them before starting.

## Deploying a Git module

```text
1. Register a Git URL, ref, and module path as a Source.
2. Resolve the ref to one commit.
3. Create a Capsule from the module.
4. Assign Connections and input variables.
5. Run a plan.
6. Review the changes and apply.
7. Save state, outputs, logs, and audit records.
```

A new commit in Git is not applied automatically. Takosumi shows that a newer
revision exists; the next plan and apply remain explicit actions.

Read [Sources and Capsules](./sources.md) and the
[Run model](./run-model.md) for details.

## Creating a Resource

A Resource requests a service such as object storage or a SQL database by type
and settings.

```text
1. Check which Resource types the endpoint supports.
2. Declare the type and settings you need.
3. Takosumi selects an available target and implementation.
4. Review the plan and apply it.
5. Save the real service state and outputs.
```

The operator decides which Resources are available. Takosumi OSS does not
require one cloud, and the Git module path still works when no Resource
implementation is installed. Takoform is one portable format for describing
these Resource requests.

Read [Resources](./resources.md) for details.

## Connecting deployments

Modules and Resources can publish non-secret values, such as an endpoint URL or
identifier, as **Outputs**. When another deployment uses a value, Takosumi keeps
both its source and the authorization.

Takosumi calls the description of a connection an **Interface**, and calls the
permission to use it an **InterfaceBinding**. Creating an Interface alone does
not grant access.

Read [State and outputs](./state-and-outputs.md) and
[Interfaces](./interfaces.md).

## Safety rules that do not change

- Secret values cannot be read back and never belong in Outputs or logs.
- A plan is created before apply, and apply uses the reviewed plan.
- A Git ref is pinned to a commit before execution.
- After a Resource target is selected, Takosumi does not silently move it to a
  different implementation.
- Read-only observation never applies a detected change automatically.

## Software and hosted operations

These docs describe behavior shared by Takosumi OSS installations. Available
Resources, storage limits, pricing, and SLAs are operator decisions. Details
specific to the official hosted service stay in the Takosumi Cloud docs.

See [Product boundaries](./boundaries.md) for the exact split.
