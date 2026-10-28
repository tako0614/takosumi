# Run model

Every execution in Takosumi is recorded as a Run. Planning, applying, destroying,
and checking for drift each leave a Run record.

## A plan and its apply are separate Runs

`plan` creates a Plan Run. `apply` creates a separate Apply Run linked with
`planRunId` to the Plan Run you reviewed. On apply, Takosumi rechecks the plan
digest, source snapshot, compatibility evidence, and state generation, so the applied
change cannot diverge from the plan you reviewed. Legacy Plans that pin a DependencySnapshot
are refused and must be replaced with a fresh plan after retired Dependency edges are removed
through separately reviewed data maintenance. Migrate the app to its own explicit inputs first;
see [Apps manage their own inputs](./state-and-outputs.md#apps-manage-their-own-inputs).

**The plan you reviewed and the change that is applied cannot diverge**, because the
Apply Run is pinned to that plan.
The runner does not infer an import for resources missing from state before an
ordinary plan, destroy plan, or saved-plan apply. To adopt an existing object,
include an explicit OpenTofu `import` block in the module and review that plan.

## Everything starts with a plan

The public `/api/v1` API uses an Accounts session or PAT: reading needs `read`
and changing needs `write`. Like the other pages, these examples use
`TAKOSUMI_DEPLOY_CONTROL_URL` for the public origin and put a
[token you created](../reference/cli.md#creating-a-token) with `read` and
`write` in `TAKOSUMI_DEPLOY_CONTROL_TOKEN`.

```bash
curl -X POST "$TAKOSUMI_DEPLOY_CONTROL_URL/api/v1/capsules/cap_example/plan" \
  -H "authorization: Bearer $TAKOSUMI_DEPLOY_CONTROL_TOKEN"
```

A `plan` creates a Plan Run. By default, deleting an applied Capsule with
`DELETE /api/v1/capsules/{capsuleId}` schedules deletion after a 7-day grace
period (operator configurable). Cancel it during that period with
`POST /api/v1/capsules/{capsuleId}/cancel-uninstall`. To create a destroy Plan
without the grace period, use `DELETE /api/v1/capsules/{capsuleId}?immediate=true`
or `POST /api/v1/capsules/{capsuleId}/destroy-plan`. Both only create a Plan;
destruction still requires owner approval and Apply.

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

When you are satisfied, apply the reviewed plan Run. This creates a separate Apply Run.
If the configuration requires approval, `/approve` comes before the apply.

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

### Provider lockfile continuity

For a plan that uses providers, the runner retains the **raw bytes** of
`.terraform.lock.hcl` read immediately after `tofu init` as a private artifact
from 0 bytes through the 1 MiB limit. SHA-256 is computed over those bytes, and
the plan succeeds only when it matches `providerLockDigest`. After the runner
exits, the bytes remain as an immutable object tied to the Run in the existing
encrypted artifact store, readable only by authorized internal processing. The
lockfile body and its artifact reference do not appear in public Run, Output, or
log projections.

The lockfile record is checked. A plan does not succeed if its record is oversized,
does not match the digest, points to another Run, or says there is no lockfile even
though the plan uses providers. When the plan has a digest, apply checks that the
SHA-256 of the lockfile after `tofu init` matches it before running any provider,
and stops if it does not. A plan from an older runner that has no lockfile record
stays marked as unknown; Takosumi does not fill it in later with a newly generated
lockfile.

## What can continue automatically

By default, detecting a Git change or drift does not make Takosumi start an apply.

- A new commit in Git only makes the Capsule `stale`
- A drift check that finds a difference only reports it
- Periodic observation is off by default; when enabled it is read-only and never re-picks a
  target

The exception is a Capsule whose user turned on automatic updates (`autoUpdate`). For each new
snapshot, Takosumi creates one update plan and records `autoApplyRequested` on the Run: continue
from plan to apply if the plan finishes cleanly. A plan with deletions, an approval policy, a
billing check, or another policy gate still stops for review.

The dashboard's **Update** also continues a cleanly finished plan to apply. That is done by the
screen you pressed it on; the Run does not record `autoApplyRequested`.

In short, **unless automatic updates are on, detection never starts an apply.**

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

A failed Run does not by itself show whether provider changes were rolled back. A provider
execution failure can persist a new StateVersion, and a lifecycle failure after apply can
leave the applied state current. Check the Run result and logs, any StateVersion it records,
and the Capsule's current StateVersion and status before recovery. If the provider outcome
is unclear, inspect provider-side state; do not repeat apply until you know what was committed.

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
