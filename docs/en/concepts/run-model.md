# Run model

Every execution in Takosumi leaves exactly one Run behind. Planning, applying,
destroying, and checking for drift are all recorded as Runs.

## A plan and its apply are the same Run

`plan`, `apply`, `destroy`, `refresh`, and `output` are operations on a single Run. A
separate "plan record" and "apply record" are never created.

That has one effect worth stating plainly. **The plan you reviewed and the change that is
applied cannot diverge**, because the apply acts on the same Run.

## Everything starts with a plan

```bash
curl -X POST "$TAKOSUMI_DEPLOY_CONTROL_URL/api/v1/capsules/cap_example/plan" \
  -H "authorization: Bearer $TAKOSUMI_DEPLOY_CONTROL_TOKEN"
```

A Run is always born as a plan for something. Destruction works the same way:
`DELETE /api/v1/capsules/{capsuleId}` creates a destroy plan.

You read the contents from the Run.

```bash
takosumi status run_example
takosumi logs run_example
```

Events and the cost estimate come from their own endpoints.

```bash
curl -s "$TAKOSUMI_DEPLOY_CONTROL_URL/api/v1/runs/run_example/events" \
  -H "authorization: Bearer $TAKOSUMI_DEPLOY_CONTROL_TOKEN"

curl -s "$TAKOSUMI_DEPLOY_CONTROL_URL/api/v1/runs/run_example/cost" \
  -H "authorization: Bearer $TAKOSUMI_DEPLOY_CONTROL_TOKEN"
```

When you are satisfied, apply. If the configuration requires approval, `/approve` comes
before the apply.

```bash
curl -X POST "$TAKOSUMI_DEPLOY_CONTROL_URL/api/v1/runs/run_example/apply" \
  -H "authorization: Bearer $TAKOSUMI_DEPLOY_CONTROL_TOKEN"
```

To stop partway, use `/cancel`. The cancellation is recorded too.

## Where execution happens

Runs execute inside the runner sandbox. Credentials reach that sandbox and nowhere else,
and they are gone when the execution ends. Takosumi itself does not run OpenTofu
directly; it hands the work to the runner and takes back the result.

## What is stored

| Stored                                              | Description                        |
| --------------------------------------------------- | ---------------------------------- |
| source snapshot                                     | Which commit was executed          |
| OpenTofu version                                    | The version used for the execution |
| provider lock digest                                | What the provider lock pinned      |
| ProviderBinding                                     | Which credentials were used        |
| The **names** of the injected environment variables | Values are not stored              |
| plan / apply result                                 | What changed                       |
| state version                                       | The state after execution          |
| outputs                                             | The published values               |
| logs                                                | Execution logs                     |
| actor                                               | Who ran it                         |
| audit evidence                                      | The record kept for audit          |

The rule is to **keep names rather than values**. You can find out later which
environment variables were injected, but not what was in them.

## What can continue automatically

Detecting a Git change or drift does not make Takosumi start an apply.

- A new commit in Git only makes the Capsule `stale`
- A drift check that finds a difference only reports it
- Periodic observation is read-only and never re-picks a target

There is one explicit exception. When a user starts an install from the
dashboard or enables an automatic update, the Run records
`autoApplyRequested`: continue from plan to apply if the plan finishes cleanly.
A plan with deletions, an approval policy, a billing check, or another policy
gate still stops for review.

In short, **detection never starts an apply; an action already started by a
user or policy may continue from a safe plan to apply.**

Checking for differences alone works per Capsule or across a whole Workspace.

```bash
curl -X POST "$TAKOSUMI_DEPLOY_CONTROL_URL/api/v1/capsules/cap_example/drift-check" \
  -H "authorization: Bearer $TAKOSUMI_DEPLOY_CONTROL_TOKEN"

curl -X POST "$TAKOSUMI_DEPLOY_CONTROL_URL/api/v1/workspaces/ws_example/drift-check" \
  -H "authorization: Bearer $TAKOSUMI_DEPLOY_CONTROL_TOKEN"
```

## Running several at once

Updating a whole Workspace produces several Runs collected into a RunGroup.

```bash
curl -X POST "$TAKOSUMI_DEPLOY_CONTROL_URL/api/v1/workspaces/ws_example/plan-update" \
  -H "authorization: Bearer $TAKOSUMI_DEPLOY_CONTROL_TOKEN"
```

Approval can be given for the group at once through
`/api/v1/run-groups/{runGroupId}/approve`. The record of each individual Run is kept.

## When a Run fails

A failed Run is recorded as failed, and the state stays at the previous StateVersion.

## History

```bash
curl -s "$TAKOSUMI_DEPLOY_CONTROL_URL/api/v1/workspaces/ws_example/runs" \
  -H "authorization: Bearer $TAKOSUMI_DEPLOY_CONTROL_TOKEN"

curl -s "$TAKOSUMI_DEPLOY_CONTROL_URL/api/v1/workspaces/ws_example/activity" \
  -H "authorization: Bearer $TAKOSUMI_DEPLOY_CONTROL_TOKEN"
```

The activity record belongs to the Workspace.

## Related

- [State and outputs](./state-and-outputs.md)
- [Credentials](./credentials.md)
- [Sources and Capsules](./sources.md)
