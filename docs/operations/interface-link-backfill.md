# Legacy required Interface link backfill

Older `capsule_required_interface` Bindings can have no `linkId`. They do not
create a selection by themselves. After the v76 `interface_links` schema is
available, an operator can inspect and explicitly backfill the selection for
Capsule-owned providers. Workspace-owned Interfaces are outside this workflow.

The script reads each named Workspace's Capsule-owned Interfaces and Bindings
through the Control API. It groups unrevoked, linkId-less Principal Bindings by
consumer Capsule and requirement key. Only Ready Bindings are eligible. It refuses multiple providers for one
requirement, an existing link lineage, or a provider that is no longer a current
candidate. It hashes each legacy Binding's permissions and delivery and
requires an exact match with the current InstallConfig requirement fingerprint
returned by the candidate endpoint. Divergent old Bindings and stale narrower
grants are refused. It never reads or prints credentials. The API checks the
same fingerprint and write authority again on each PUT, so a requirement
changed after dry-run cannot silently widen consent. The operator still reviews
the reported scopes; a historical Binding is not itself a new approval.

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
Immediately before each PUT it rereads the old Binding IDs, generations,
readiness, and grants. `--apply` is an explicit operator selection. A Binding
could still change in the interval between that reread and PUT; an atomic
cross-table Binding/Link transaction is not part of this API.
If a write fails, it stops and reports how many links were already created.
Re-run dry-run to inspect the remaining rows; already-created lineages require
manual review rather than automatic overwrite.

The API response must confirm an active link pinned to the chosen provider.
On the next sign-in, a matching legacy Binding receives the link ID through a
generation-guarded update. Until that reconciliation, the token path accepts a
linkId-less Binding only when its complete grant matches an active link. Verify
the selected links and a real consumer sign-in before
considering the backfill complete. Recovery is a normal link DELETE using its
current generation, followed by inspection of the corresponding Binding; the
script never deletes historical records.
