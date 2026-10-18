# Scheduled deletion (uninstall)

**Schedule deletion** in the dashboard does not remove a service (Capsule) right away; it
deletes it after a grace period. Once scheduled, the service shows **Scheduled for
deletion** (`uninstalled`). Provider resources and data remain during the grace period,
and charges continue. The OSS default grace period is seven days. At the deadline, the
service attempts a data export, then creates a destroy Plan and deletes the service. A
failed or unsupported export does not stop the deletion; the outcome (`exported` /
`failed` / `skipped`) is recorded on the request.

In the API, `POST /api/v1/capsules/{capsuleId}/uninstall` creates this request for an
applied Capsule. Sending the same request again returns the original one without
changing its deadline or requester.

## Cancelling

**Cancel deletion** in the dashboard, or
`POST /api/v1/capsules/{capsuleId}/cancel-uninstall` from the current Workspace owner or
admin, cancels the request. Cancellation is possible only in these cases; the second is a
request that stopped after the deadline:

- `uninstall.phase` is `scheduled`, and teardown is neither in flight nor complete; or
- `phase` is `destroying`, but the request is blocked (`uninstall.blockedReason` is set)
  and runtime safety is absent or `safe`.

An approved Plan alone, or the fact that provider dispatch has not happened yet, does not
make it cancellable. If an external lifecycle or provider operation has begun, do not
cancel; inspect its outcome and use authorized forward repair.

## Which credential to schedule with

The request privately records the Accounts subject and a reference to the credential used
to schedule it. Before exporting data and creating the destroy Plan, and again before
approval, apply, and provider dispatch, the deletion rechecks current Workspace management
authority and Accounts authorization. Because this can run after the deadline, choose the
credential as follows.

| Credential | Can schedule | Checks after the deadline |
| --- | --- | --- |
| Browser session | Yes | It represents the account's intent, so session expiry or rotation alone does not stop the request. The account and its Workspace authority are still checked at the deadline |
| PAT | Only one valid until at least six hours after the deadline (`scheduledDestroyAt`), or one that does not expire | The **same PAT** used to schedule must be active, have `write` scope, and satisfy any Workspace restriction at every recheck |
| OAuth | No | — |

About PATs:

- A PAT expiring exactly at `scheduledDestroyAt + 6h` is accepted. One expiring even one
  millisecond earlier is refused with `409 failed_precondition`
  (`details.reason: capsule_uninstall_pat_deadline_unverified`). If Accounts cannot
  confirm this margin, Capsule state, the request, and Activity stay unchanged.
- The six hours are a margin, at scheduling time, for delays in the deletion and in
  provider dispatch. The same margin applies with zero grace. Execution is not guaranteed
  if dispatch takes longer or the PAT is revoked: the PAT must remain valid through actual
  provider dispatch, not just the deadline.
- Another active PAT for the same account does not replace the one used to schedule.

About OAuth: access tokens have a default lifetime of five minutes, far shorter than the
seven-day default grace period, and the request rechecks the same token grant after the
deadline. So OAuth cannot currently schedule a deletion; it returns `409 failed_precondition`
(`details.reason: capsule_uninstall_oauth_unsupported`). This also applies with zero
grace. Refreshing the token does not replace the grant recorded for a request. Existing
OAuth requests are not automatically moved to a new token, and the deletion stops when
their recorded grant expires.

## When the deadline check fails

If authorization or Workspace authority cannot be confirmed at the deadline, the service
stays **Scheduled for deletion** (`uninstalled`), and the request stops with
`uninstall.blockedReason` and `uninstall.authorizationRejectedAt`.

| `uninstall.blockedReason` | Reason |
| --- | --- |
| `uninstall_requester_missing` | A legacy request with no recorded requester |
| `uninstall_requester_denied` | The credential used to schedule is expired, revoked, or otherwise no longer valid, or the account's Workspace authority no longer allows it |
| `uninstall_authorization_unavailable` | Authorization could not be checked: the check is not available, or it failed |

The refusal is normally recorded before export, destroy Plan creation, or provider work.
The `capsule.uninstall_blocked` audit record also carries the reason and time. Restoring
authorization later does not resume the request.

## When the deletion stops partway

Even after the authority check passes, a request stops in **Scheduled for deletion** when the
deletion cannot continue safely, and records one of these reasons in `uninstall.blockedReason`.
A failed data export alone does not stop it: the result (`failed`) is recorded and the deletion
goes on. An export refused because it overlapped a Workspace management operation is also
recorded as `failed`, and the deletion goes on.

| `uninstall.blockedReason` | Reason |
| --- | --- |
| `pre_destroy_export_incomplete` | A data export started but has recorded no result after 15 minutes |
| `destroy_plan_cancelled` | Someone cancelled the deletion Plan |
| `destroy_plan_failed` | The deletion Plan did not complete within 3 attempts in total |
| `destroy_plan_missing` | The recorded deletion Plan cannot be found (when the attempts run out, or when moving on to the deletion apply). A Plan creation refused for a temporary reason also counts as an attempt |
| `destroy_plan_refused` | Creating the deletion Plan was refused for a reason that will not clear by waiting |
| `destroy_plan_unverifiable` | The deletion Plan no longer matches the service it was made for (its state or execution authority changed, it did not pass policy, it has no list of changes, and so on) |
| `destroy_plan_not_delete_only` | The deletion Plan contains changes other than deletes (including imports) |
| `destroy_apply_refused` | The deletion apply or its approval was refused for a reason that will not clear by waiting. If the refusal is about authority, one of the three reasons above is recorded instead |
| `destroy_apply_failed` | The deletion apply ended failed, cancelled, or expired |
| `finalize_failed` | The deletion process has reached 6 unexpected failures in total |

If the deletion apply fails and the service's status becomes **Error**, the request's processing
ends there and the request can no longer be cancelled. As the dashboard says, delete the service
again from Settings.

## Repairing a blocked request

1. Confirm that one of the cases under "Cancelling" applies.
2. The current Workspace owner or admin calls `cancel-uninstall`.
3. Schedule again with `POST /api/v1/capsules/{capsuleId}/uninstall`, using a browser
   session or a PAT that will remain valid through provider dispatch.

The new request has a new ID and a full grace period. It does not adopt the old request's
requester. If the cancellation conditions do not hold, or an external operation has
begun, inspect its outcome and use authorized forward repair.

See the [API reference](../reference/api.md) for the API operations.
