# State and outputs

Every time an apply succeeds, Takosumi stores the state at that moment. That is a
StateVersion, and the values lifted out of it for publication are Outputs.

## StateVersions accumulate

A StateVersion is never overwritten. **Going back does not rewind the history.** The
result of going back is pushed on as a new StateVersion. That means you can go back and
then return to where you were before, and that move is recorded as well.

What is stored is the state Takosumi manages. The contents of the real things your module
created — database rows, stored files — are not part of it.

Going back runs through an ordinary plan and apply. **Choosing a StateVersion changes
nothing by itself.**

Put a [token you created](../reference/cli.md#creating-a-token) with `read` and `write` in
`$TAKOSUMI_DEPLOY_CONTROL_TOKEN` for these examples.

```bash
curl -s "$TAKOSUMI_DEPLOY_CONTROL_URL/api/v1/capsules/cap_example/state-versions" \
  -H "authorization: Bearer $TAKOSUMI_DEPLOY_CONTROL_TOKEN"

curl -X POST "$TAKOSUMI_DEPLOY_CONTROL_URL/api/v1/state-versions/sv_example/rollback-plan" \
  -H "authorization: Bearer $TAKOSUMI_DEPLOY_CONTROL_TOKEN"
```

You read the Run it created and apply it; only then does anything move. The current point
of every Capsule in a Workspace can be read at once from
`/api/v1/workspaces/{workspaceId}/current-state-versions`.

Two things are worth checking before you go back. First, whether the plan contains
resources of a kind that lose data when they are recreated. Second, whether the commit the
target points at still exists in the repository — if it does not, the plan fails.
Credentials are not part of a StateVersion, so a rollback uses the Connections you have
now.

## Outputs are only what you published

An Output is a value a Capsule shows to the outside. What gets published is **only the
non-secret values you explicitly mapped**.

An output marked `sensitive = true` in OpenTofu is correct as far as OpenTofu is
concerned, but it **does not become a published Output**. That closes it off as a way to
carry secrets.

An Output is not a per-Run record; it is the value published right now. Read it
from `/api/v1/capsules/{capsuleId}/outputs`:

```bash
curl -s "$TAKOSUMI_DEPLOY_CONTROL_URL/api/v1/capsules/cap_db/outputs" \
  -H "authorization: Bearer $TAKOSUMI_DEPLOY_CONTROL_TOKEN"
```

## Secrets and state

Secret values do not belong in these public surfaces.

```text
spec
status
Output
Interface
logs
audit records
```

Provider-managed OpenTofu state can contain secrets such as connection
strings. Takosumi encrypts the complete state and decrypts it only for an
authorized Run. Do not treat state like a published Output or a general export.

## Apps manage their own inputs

Each installed app is an independent OpenTofu root with its own state and plan. Takosumi does
not wire one app's Outputs into another app's variables, and `remote_state` is not an input
wiring mechanism. If an app needs a value, its own Git configuration and reviewed settings
must provide it.

A repository may publish optional install assistance in
`.well-known/takosumi.json`. That file can describe install inputs and Interface requests; it
does not create cross-app OpenTofu inputs or grant execution authority. Interfaces are explicit
contracts with their own owner and lifecycle. An Interface may document or expose an app-owned
capability, but it does not connect two apps' OpenTofu state.

Legacy Dependency edges are retired. A new plan fails with `dependency_retired` while the
Capsule still has legacy edges. Migrate the app to its own explicit inputs, then have an
operator remove the retired records through separately reviewed data maintenance before
planning again. A saved plan that pins a legacy dependency snapshot is also refused and must
be replaced with a fresh plan.

**To share a secret between apps, assign the same Connection to both apps.** Never publish a
secret as an Output.

## When reality has moved

The stored state and the real thing can disagree, for instance after someone changed
something directly in a cloud console.

A drift check reads that difference and reports it, read-only. **It repairs nothing on its
own.** It reports with the current version and endpoint held fixed, and a person decides
whether to act.

## How this differs from an export

Takosumi can export its control information: how a Capsule is configured, the settings of
a Source, and the history of Runs and StateVersions. **The service's own data, and the
secrets stored in a Connection, are not included.**

```bash
curl -X POST "$TAKOSUMI_DEPLOY_CONTROL_URL/api/v1/workspaces/ws_example/backups" \
  -H "authorization: Bearer $TAKOSUMI_DEPLOY_CONTROL_TOKEN"
```

To undo the last apply, go back from a StateVersion rather than exporting. Exports are for
moving a whole Workspace to another environment, or for keeping control information
outside Takosumi. Since secrets are not included, recreating the Connections after a
restore is always part of the work.

## Related

- [Run model](./run-model.md)
- [Credentials](./credentials.md)
