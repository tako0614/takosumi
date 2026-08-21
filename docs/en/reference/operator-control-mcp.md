# Control Takosumi from MCP

The Operator control MCP adapter lets Takos and other MCP clients work with
Takosumi Git install plans, Capsules, and Runs. It can prepare a reviewable Plan
Run from a new Git Source, list Capsules, inspect a Run, approve it, and apply
its saved plan.

This adapter is optional. It does not add Takos-specific built-in tools.
Instead, it publishes an ordinary `mcp.server` Interface at
`/mcp/operator-control/v1`. Clients discover the tools exposed by that endpoint
through MCP `tools/list`.

## Prerequisites

- Takosumi Accounts and the dashboard are running.
- The Takosumi origin is reachable over HTTPS.
- The operator can enable the MCP adapter.
- The user is a member of the target Workspace.

## Connect

### 1. Enable the adapter

Set the following values on the stock platform worker:

```text
TAKOSUMI_OPERATOR_CONTROL_MCP_ENABLED=1
TAKOSUMI_ACCOUNTS_ISSUER=https://<takosumi-origin>
```

Without the feature flag, the MCP route returns `404`. Set the Accounts issuer
to the same Takosumi origin, including its scheme and path.

If the host replaces `TAKOSUMI_INSTALL_CONFIG_COMPOSITION` with its own runtime
object, add `OPERATOR_CONTROL_MCP_INSTALL_CONFIG` to that array as well.

### 2. Deploy the Git module

In Add service on the dashboard, enter:

```text
Git URL:     https://github.com/tako0614/takosumi.git
modulePath:  opentofu-modules/operator-control-mcp
variables:
  takosumi_origin = https://<takosumi-origin>
```

Review the plan and apply it. The module's `endpoint` Output creates an
`mcp.server` Interface. Takosumi proposes an OAuth Binding with the
`mcp.invoke` permission for the user who installed it.

The module uses only the public Takosumi API. It does not require the Takoform
provider.

### 3. Connect an MCP client

Open the Interface connection details in the dashboard and give them to the MCP
client. The transport is Streamable HTTP.

```text
https://<takosumi-origin>/mcp/operator-control/v1
```

Authenticate with the OAuth token obtained through the Interface Binding. Do
not give the client an operator token or a module provider credential.

## Tools

| Tool                                | Purpose                                             |
| ----------------------------------- | --------------------------------------------------- |
| `takosumi_install_plan_create`      | Create or replay a durable plan from a Git Source   |
| `takosumi_install_plan_get`         | Read an install plan without advancing it           |
| `takosumi_install_plan_reconcile`   | Explicitly advance one install-plan phase           |
| `takosumi_capsules_list`            | List Capsules                                       |
| `takosumi_capsule_plan`             | Start a plan for an existing Capsule                |
| `takosumi_run_get`                  | Read Run status and the plan summary                |
| `takosumi_run_approve`              | Approve a reviewed Run                              |
| `takosumi_run_apply`                | Apply an approved saved plan                        |

Install-plan creation requires an `idempotencyKey` that the client preserves
across retries. Reconcile only while `nextAction` is `reconcile`; when it
becomes `review_run`, review the returned Run. The install plan never approves
or applies that Run. `list` and `get` are read-only. `approve` and `apply`
change state, so an MCP client should ask the user before calling them.

The adapter returns the current tool list and input schemas through
`tools/list`. Do not keep a fixed Takosumi tool catalog in the client.

## Authentication and safety

For every MCP request, Takosumi validates the OAuth token, Interface, Binding,
Workspace, and `mcp.invoke` permission. A referenced install plan, Capsule, or
Run must belong to the same Workspace.

Install-plan tools forward only the bounded public `/api/v1` request. They do
not accept variable values, credentials, provider tokens, or an arbitrary
control-plane path. A private Git Source may reference a pre-existing
`authConnectionId`; credential material never enters the tool arguments.

The adapter passes only the verified Workspace and user authority to the
existing Takosumi API handlers. It does not store the raw bearer token in Runs,
state, Outputs, audit events, or logs. Normal Workspace roles, policy checks,
plan approval, and saved-plan digest checks still apply.

`takosumi_run_apply` cannot override an apply guard from MCP arguments. The
server revalidates the saved plan, state, and provider connection before
running it.

## Troubleshooting

| Symptom                            | Check                                                                                |
| ---------------------------------- | ------------------------------------------------------------------------------------ |
| The route returns `404`            | Confirm that `TAKOSUMI_OPERATOR_CONTROL_MCP_ENABLED=1` reached the running worker.   |
| The OAuth Binding is not Ready     | Confirm that the Accounts issuer, public origin, and module `takosumi_origin` match. |
| The request returns `401` or `403` | Check the token audience, `mcp.invoke` permission, and Workspace membership.         |
| A Capsule or Run is missing        | Confirm that the Binding and the target belong to the same Workspace.                |
| The tool list is stale             | Fetch `tools/list` from the endpoint instead of using a client-side fixed list.      |

Never write bearer tokens or provider credentials to operational logs.
