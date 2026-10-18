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

## Passing values to another Capsule

Inside one Workspace, express this as a dependency. When Takosumi creates the review (plan) for
the receiving Capsule, it reads the Outputs of the sending Capsule and passes them in as
OpenTofu variables of the receiving one.

The dashboard's **Dependencies** page shows the connections. Creating and deleting them is done
through the API. In the examples, `$TAKOSUMI_DEPLOY_CONTROL_TOKEN` holds
[a token you created](../reference/cli.md#creating-a-token) with `read` and `write`. Only an
owner or admin of the Workspace can create or delete a dependency.

### Creating one

1. Deploy the sending Capsule and check, in [its Outputs](#outputs-are-only-what-you-published),
   that it has the Output you want to pass. A `sensitive` Output cannot be passed.
2. In the receiving module, declare a `variable` for the value. Without the declaration, the
   value is passed but not used. Give a `default` to any variable you receive with
   `required: false` (below). If no value is passed and there is no default, the review fails.

   ```hcl
   variable "base_domain" {
     type = string
   }
   ```

3. Create the dependency on the receiving Capsule. The Capsule in the path is the receiving
   one, and `producerCapsuleId` is the sending one.

   ```bash
   curl -X POST "$TAKOSUMI_DEPLOY_CONTROL_URL/api/v1/capsules/cap_app/dependencies" \
     -H "authorization: Bearer $TAKOSUMI_DEPLOY_CONTROL_TOKEN" \
     -H 'content-type: application/json' \
     -d '{
       "producerCapsuleId": "cap_dns",
       "outputs": {
         "base_domain": { "from": "base_domain", "to": "base_domain", "required": true }
       }
     }'
   ```

   `from` is the name of the sending Capsule's Output, and `to` is the name of the receiving
   variable. `required` cannot be left out: write `true` or `false`. A `false` value is not
   passed when the sending side does not have it. On success the response is `201` with the new
   `dependency.id`.
4. On the receiving Capsule, press **Review changes** under **Update service** on the
   **Updates** tab, check the review, and deploy. Creating the dependency alone does not change
   the receiving Capsule's status.

A missing `required`, empty `outputs`, or a dependency on itself is rejected with `400`. A cycle
or a sending Capsule in another Workspace is rejected with `409`. Creating a dependency does not
check that the sending Output exists, and creating the same connection twice is not rejected
either, so list the dependencies first.

If the sending side has not published a `required: true` value (it was never deployed, the
Output does not exist, or it is `sensitive`), no review is created for the receiving Capsule and
the screen says "Values from a connected service aren't available right now. Try again in a
moment." (`dependency_outputs_unavailable`). Waiting does not help: fix and deploy the sending
Capsule first.

### When the sending side changes

When you deploy the sending Capsule and any of its Outputs changes, every Capsule downstream of
it shows **Update available**. This includes Outputs you do not pass, and Capsules that depend on
it through a chain. Only **Deployed** Capsules change.

Takosumi does not create the review on its own, even with automatic updates (`autoUpdate`) on.
On the receiving Capsule, do one of these:

- Press **Update**. It creates a review with the new values and, if the change is safe and needs
  no approval, deploys it right away
  ([Update to a new version](../getting-started/after-adding.md#update-to-a-new-version)).
- To look first, press **Review changes** under **Update service** on the **Updates** tab.

For a Capsule whose `environment` is `production` (services added from the dashboard are), if you
deploy the sending Capsule after the receiving review was created, deploying the receiving
Capsule stops with "A connected service was updated first. Review the changes again."
(`dependency_snapshot_stale`). This happens even when the sending Outputs did not change, and the
receiving Capsule's status does not change first. Create the receiving review again.

### Listing and deleting

```bash
curl -s "$TAKOSUMI_DEPLOY_CONTROL_URL/api/v1/capsules/cap_app/dependencies" \
  -H "authorization: Bearer $TAKOSUMI_DEPLOY_CONTROL_TOKEN"

curl -X DELETE "$TAKOSUMI_DEPLOY_CONTROL_URL/api/v1/dependencies/dep_example" \
  -H "authorization: Bearer $TAKOSUMI_DEPLOY_CONTROL_TOKEN"
```

Deleting does not change the receiving Capsule's status. From its next review on, the value is
no longer passed. The connections across a whole Workspace can be read from
`/api/v1/workspaces/{workspaceId}/graph`.

### Across Workspaces

Across Workspaces, use an OutputShare. **The sending side creates it, and it takes effect
only once the receiving side approves.** Revoking it stops later references, and the
records of Runs that already happened stay.

```bash
curl -X POST "$TAKOSUMI_DEPLOY_CONTROL_URL/api/v1/output-shares/share_example/approve" \
  -H "authorization: Bearer $TAKOSUMI_DEPLOY_CONTROL_TOKEN"
```

Either route carries published Outputs only. **To get a secret to another Capsule, assign
the same Connection to both Capsules instead.**

## When reality has moved

The stored state and the real thing can disagree, for instance after someone changed
something directly in a cloud console.

A drift check reads that difference and reports it, read-only. **It repairs nothing on its
own.** It reports with the current version and endpoint held fixed, and a person decides
whether to act.

## How this differs from an export

Takosumi can export its control information: how a Capsule is configured, the settings of
a Source, and the history of Runs and StateVersions. **The application's own data, and the
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
