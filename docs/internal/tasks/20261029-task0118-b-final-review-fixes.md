# TASK-0118 writer B final review fixes

Scope: Takosumi #663, on the existing stacked branch. No other repository,
deployment, live database, or ownership migration is in scope. Do not merge.

- Pass the canonical app ownership port into every RunEngine binding resolver;
  prove on D1 that another account's connection is rejected before mint.
- Refuse service startup over a durable control store without a real ownership
  store. In-memory ownership must have an actual in-memory control store.
  The service composition supplies this shared authority to vault, Sources,
  Connections, OIDC, RunGroups, Run execution, and scheduled finalization.
- Strip stale ownership fields at public Capsule read boundaries while retaining
  opaque stored snapshots for compare-and-swap operations.
- Validate new legacy-route app bindings against the Workspace owner who will
  own the app. Account-scoped installs resolve the requester's personal Workspace.
- Reconcile pre-existing revision Plan Runs carrying the exact old actor format,
  retaining all pinned identity checks and current actor rules for new Runs.
- Read only bound connection IDs for app connection labels.

Validation: focused behavioral tests and affected static portable phases locally;
the complete quality gate runs in CI. Record final head, test results, and CI in
the operator-local B-fix3 report. No merge or deploy is authorized.
