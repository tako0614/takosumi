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
| **Interface** | a declaration of the connection a deployment provides       |

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

## Using providers

Services are managed by the OpenTofu/Terraform providers declared by the Git
module. Cloudflare, AWS, Kubernetes, and Takoform are all ordinary providers.
Takosumi delivers provider connections to the runner only for the Run and leaves
provider state and provider-side objects to that provider's contract.

The former Resource Shape / Form Host path is not a supported product surface.
Retained Resource APIs, schemas, TargetPool, and SpacePolicy are temporary
migration internals for existing data. The [Resource migration note](./resources.md)
explains that boundary.

## Connecting deployments

Modules can publish non-secret values, such as an endpoint URL or
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
- Provider state and credentials stay within the Run boundary.
- Declaring an Interface does not grant an InterfaceBinding authorization.

## Software and hosted operations

These docs describe behavior shared by Takosumi OSS installations. Hosted Form
instances, storage limits, pricing, and SLAs are operator decisions. Details
specific to the official hosted service stay in the Takosumi Cloud docs.

See [Product boundaries](./boundaries.md) for the exact split.
