# Scheduled uninstall authority transition

This describes the TASK-0118 transition from Workspace-authorized background
uninstall to app-authorized reservations. Source and synthetic fixture checks do
not qualify a deployed target or authorize a rollout.

## Persisted decision

The Accounts route records `managementAuthority` under the private
`uninstall.requester`, using the app authorization decision it just made:

- `app`: recheck the same requester as the current app owner, its captured
  `appOwnershipEpoch`, and active app management.
- `app-and-workspace`: also require current active Workspace owner/admin
  membership. Namespace ownership alone is insufficient.
- `workspace`, or an absent field on an old reservation: retain the existing
  Workspace namespace-owner / active owner-admin decision.

The account and exact credential grant remain live checks in every mode.
App-mode records with no ownership port, missing ownership, changed owner/epoch,
or an ownership read error never fall back to Workspace authorization. Unknown
mode values and malformed epochs fail closed. Requester provenance is immutable
and absent from public Capsule reads. Replaying an uninstall preserves the
original decision; cancel/reschedule is the explicit way to create a new intent.
New app-mode reservations recheck that management decision under the lifecycle
lease immediately before persistence, after any PAT deadline validation.
The lifecycle CAS independently requires the same current app owner/epoch and
active app management. Shared-account admission also requires current active
owner/admin membership in that write. Memory performs this check and mutation
synchronously; Postgres and D1 include it in the lifecycle UPDATE predicate.
The guard applies when entering `uninstalled`, so later refusal records and
cancellation can still be persisted after authority is lost.

These are additive fields in the existing Capsule JSON. They require no DDL,
backfill, new storage root, new credential scope, or modification of applied
D1/Postgres migrations. New readers preserve old reservations unchanged. Both
the finalizer and RunEngine use the same check; Workspace management fences,
execution leases, provider-dispatch checks and existing CAS remain in place.

## Reader and writer cutover

This candidate writes new modes immediately when its Accounts route accepts a
new app-authorized reservation. Deploying this one binary gradually is not a
reader-only expansion. An ownership/member mutation freeze does not stop all
uninstall writers or background execution.

Before enabling its writer on a protected target, use either a separately
prepared reader-only release, or stop uninstall acceptance at every serving
entry and drain all old finalizer and RunEngine execution contexts before
switching the complete target to compatible readers and writers. Include
in-process/operator scheduling callers and queued background delivery. The
owning composition must supply and verify that stop/drain mechanism for its
exact environment; this document does not claim one has been executed.

Verify ordinary app-owner completion without Workspace membership, shared-account
membership loss, exact-grant revocation, and old reservation behavior on the
selected target. A passing source/CI fixture is not this runtime readback.

## Runtime rollback and forward repair

Old runtimes ignore these fields and may use the old Workspace decision instead
of the captured app authority. Do not return a target with unfinished new-mode
reservations to an old reader. Keep a compatible reader and repair forward.
An old UI can be rolled back separately only while its backend remains compatible.

To return Core to an older reader, stop new-mode writers and inventory every
retained Capsule partition, including archived/disabled Workspaces. Include
future reservations, blocked or authorization-rejected reservations, `destroying`
requests, and queued/running teardown Plans, Apply Runs and leases; the due queue
alone cannot prove absence. Resolve each live intent through authorized safe
cancellation or completion. Once provider dispatch or an external lifecycle
action has begun, use completion/forward repair rather than claiming safe cancel.
Verify that no unfinished new-mode intent or related execution remains before
switching readers. Do not delete provenance, relabel an app intent as Workspace
authority, shorten grace periods, or rewrite state/storage references to make
the inventory appear empty.

No protected-target rollout, reader drain, rollback, provider operation, or
credential use has been performed by the source/local work recorded here.
