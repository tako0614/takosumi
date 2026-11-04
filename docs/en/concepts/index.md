# How Takosumi works

Takosumi runs OpenTofu or Terraform with your existing providers, without
changing your module or provider code, and adds review, authorization, and
records around that execution. It is not a replacement for cloud APIs.

## Six terms to start with

| Name          | In plain language                                                                  | In the dashboard                                  |
| ------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------- |
| **Capsule**   | an app running one module, managed by its owner and any members                   | **Apps**                                          |
| **Source**    | a registered Git repository and module location                                   | Source                                            |
| **Run**       | one plan, apply, destroy, or other execution                                      | an entry in **Deploy history** (Review, Deploy, …) |
| **Interface** | a declaration of the connection a deployment provides                            | exposed connections (advanced); one with a screen is an app on Home |
| **Workspace** | an internal namespace and a retained compatibility context for old APIs and stored data | no selection needed for normal app management |
| **Project**   | a grouping inside an existing Workspace                                           | not shown                                         |

The management unit is an app (a Capsule). Its owner and members can view it,
change settings, update, and roll back. Only the owner can uninstall, transfer
ownership, or manage members; members may leave. People who only use the app
follow its own URL and access rules and do not need a management role.

For an app with ownership records, its role grants management access without
Workspace membership. Owning the Workspace alone does not grant access to
another person's app. Token scopes and app restrictions still apply. On old
schemas or during ownership backfill, some entrypoints retain the legacy
Workspace decision. Shared-account compositions that require current
membership also require both the app role and the Workspace decision.
See [App management permissions](../reference/api.md#app-management-permissions).

Workspace IDs and handles remain in compatibility APIs and existing stored
data. Normal app installation and management do not require creating or
selecting a Workspace first. Concrete execution environments such as
`production` and `preview` belong to Capsules.

State, outputs, logs, and audit records are results of Runs. Provider API keys
and similar credentials are stored separately as **Connections** (**Connected
accounts** in the dashboard) and assigned only to the Runs that need them.

The [glossary](../reference/glossary.md) contains exact API names. You do not
need to learn all of them before starting.

## Deploying a Git module

```text
1. Register a Git URL and ref (and, if needed, a directory in the repository) as a Source.
2. Resolve the ref to one commit, and read the OpenTofu files Git tracks there without
   changing anything (scan).
3. Pick a module the scan found, and create a Capsule from it.
4. Assign connected accounts (Connections) and input variables.
5. Run a plan to review the changes.
6. Review the changes and deploy (apply).
7. Save state, outputs, logs, and audit records.
```

By default, a new commit in Git is not deployed automatically. Takosumi shows
that a newer revision exists; the next plan and apply remain explicit actions.
Only when you turn on auto-update (`autoUpdate`) for a Capsule does Takosumi apply a
plan automatically, and then only a plan with no deletion or replacement, no approval
or policy gate, and a known list of resource changes (see
[Sources and Capsules](./sources.md)).

Read [Sources and Capsules](./sources.md) and the
[Run model](./run-model.md) for details.

See [Scheduled deletion](./scheduled-uninstall.md) for deleting a service after a grace
period, cancelling, and repairing a request that stopped.

## Using providers

Services are managed by the OpenTofu/Terraform providers declared by the Git
module. Cloudflare, AWS, Kubernetes, and Takoform are all ordinary providers.
Takosumi delivers provider connections to the runner only for the Run and leaves
provider state and provider-side objects to that provider's contract.

The earlier Resource Shape / Form Host path is retired, and the old `/v1` HTTP routes
always return `404`. Only the internal schema and records for existing data, and
migration-only processing, remain (see the [Resource migration note](./resources.md)).

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
specific to the official hosted service stay in the Takosumi hosted service docs.

See [Product boundaries](./boundaries.md) for the exact split.
