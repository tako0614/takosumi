# Scheduled deletion (uninstall)

**Schedule deletion** in the dashboard does not remove a service (Capsule) right away; it
deletes it after a grace period. Once scheduled, the service shows **Scheduled for
deletion** (`uninstalled`). Provider resources and data remain during the grace period,
and charges continue. The OSS default grace period is seven days. At the deadline, a
server that supports it exports the data first, then creates a destroy Plan and deletes
the service.

In the API, `POST /api/v1/capsules/{capsuleId}/uninstall` creates this request for an
applied Capsule. Sending the same request again returns the original one without
changing its deadline or requester.

## Cancelling

Until the deadline, **Cancel deletion** in the dashboard cancels the request. In the API,
the current Workspace owner or admin calls
`POST /api/v1/capsules/{capsuleId}/cancel-uninstall`. Cancellation is possible only when:

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
deadline. So OAuth cannot schedule a deletion; it returns `409 failed_precondition`
(`details.reason: capsule_uninstall_oauth_unsupported`). This also applies with zero
grace. Refreshing the token does not replace the grant recorded for a request. Existing
OAuth requests are not moved to a new token, and the deletion stops when their recorded
grant expires.

## When the deadline check fails

If authorization or Workspace authority cannot be confirmed at the deadline, the service
stays **Scheduled for deletion** (`uninstalled`), and the request stops with
`uninstall.blockedReason` and `uninstall.authorizationRejectedAt`.

| `uninstall.blockedReason` | Reason |
| --- | --- |
| `uninstall_requester_missing` | A legacy request with no recorded requester |
| `uninstall_requester_denied` | The credential used to schedule is expired, revoked, or otherwise no longer valid |

The refusal is normally recorded before export, destroy Plan creation, or provider work.
The `capsule.uninstall_blocked` audit record also carries the reason and time. Restoring
authorization later does not resume the request.

## Repairing a blocked request

1. Confirm that one of the cases under "Cancelling" applies.
2. The current Workspace owner or admin calls `cancel-uninstall`.
3. Schedule again with `POST /api/v1/capsules/{capsuleId}/uninstall`, using a browser
   session or a PAT that will remain valid through provider dispatch.

The new request has a new ID and a full grace period. It does not adopt the old request's
requester. If the cancellation conditions do not hold, or an external operation has
begun, inspect its outcome and use authorized forward repair.

See the [API reference](../reference/api.md) for the API operations.
