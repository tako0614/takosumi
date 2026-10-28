# Legacy required Interface link backfill

Older `capsule_required_interface` Bindings can have no `linkId`. They do not
create a selection by themselves. After the v76 `interface_links` schema is
available, an operator can inspect and explicitly backfill the selection for
Capsule-owned providers. Workspace-owned Interfaces are outside this workflow.

The script reads each named Workspace's Capsule-owned Interfaces and Bindings
through the Control API. It groups unrevoked, linkId-less Principal Bindings by
consumer Capsule and requirement key. Only Ready Bindings are eligible. It refuses multiple providers for one
requirement, an existing link lineage, or a provider that is no longer a current
candidate. It never reads or prints credentials. The API checks the current
InstallConfig and write authority again on each PUT. The operator must compare
the dry-run rows with the current InstallConfig, especially delivery and
permissions, before applying; a stale historical Binding does not itself
approve a changed requirement.

```sh
export TAKOSUMI_CONTROL_API_URL='https://control.example.test'
export TAKOSUMI_CONTROL_TOKEN='<operator control token>'
bun scripts/backfill-interface-links.ts --workspace=ws_example --dry-run
```

Use the Workspace IDs from the operator's own inventory. The script does not
discover other Workspaces or silently page through unknown scopes. Review the
reported consumer, requirement, provider Interface, and Binding IDs. To write
the reviewed plan, run the same command with `--apply` in place of `--dry-run`.
The script plans again before writing; each PUT uses `expectedGeneration: 0`.
If a write fails, it stops and reports how many links were already created.
Re-run dry-run to inspect the remaining rows; already-created lineages require
manual review rather than automatic overwrite.

The API response must confirm an active link pinned to the chosen provider.
On the next sign-in, a matching legacy Binding receives the link ID through a
generation-guarded update. If its delivery or permissions changed, the runtime
revokes it and creates a current Binding. Until that reconciliation, the
authorization store accepts a linkId-less Binding only when it exactly matches
an active link. Verify the selected links and a real consumer sign-in before
considering the backfill complete. Recovery is a normal link DELETE using its
current generation, followed by inspection of the corresponding Binding; the
script never deletes historical records.
