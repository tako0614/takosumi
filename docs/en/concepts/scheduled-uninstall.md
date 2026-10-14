# Scheduled Capsule uninstall

A new request requires its pinned PAT to expire at least six hours after
`scheduledDestroyAt`. A PAT expiring exactly at `scheduledDestroyAt + 6h` is
accepted; one expiring one millisecond earlier is refused with
`409 failed_precondition` and
`details.reason: capsule_uninstall_pat_deadline_unverified`. If Accounts cannot
confirm this margin, Capsule state, the reservation, and Activity stay unchanged.
The six-hour reserve allows for finalizer and provider-dispatch delay. It does
not guarantee execution if dispatch takes longer or the PAT is revoked; the
finalizer rechecks the same PAT at each boundary. Use a browser session, a
non-expiring PAT, or one valid through at least six hours after the deadline.
The same six-hour margin applies with zero grace.
Replaying an existing reservation returns the original request without
replacing its deadline or requester. Admission does not guarantee later
execution: the same PAT must remain valid through actual provider dispatch.

`POST /api/v1/capsules/{capsuleId}/uninstall` marks an applied Capsule as
`uninstalled` and schedules its later destruction. Provider resources and data
remain during the grace period, and charges continue. The OSS default grace
period is seven days. The current Workspace owner or admin can cancel with
`POST /api/v1/capsules/{capsuleId}/cancel-uninstall` while `uninstall.phase` is
`scheduled`, provided teardown is not in flight or complete. When the phase is
`destroying`, cancellation is allowed only if the request is blocked
(`uninstall.blockedReason` is set) and runtime safety is absent or `safe`. An
approved Plan alone, or the fact that provider dispatch has not happened yet,
does not make it cancellable. If an external lifecycle or provider operation
has begun, inspect its outcome and use authorized forward repair.

The request privately records the Accounts subject and a reference to the
credential used to schedule it. Before export or creation of a destroy Plan,
and again at approval, apply, and provider dispatch boundaries, the finalizer
rechecks current Workspace management authority and Accounts authorization. A
browser session represents the account's intent, so session expiry or rotation
alone does not stop the request. The account and its Workspace authority are
still checked at the deadline. For a PAT request, the **same PAT** pinned when
the request was scheduled must remain active, have `write` scope, and satisfy
any Workspace restriction at every recheck. Finalization or provider dispatch
can happen after the scheduled deadline, so the PAT must remain valid through
the actual provider dispatch; the deadline alone is not a guarantee. Another
active PAT for the same subject does not replace it.

OAuth access tokens have a default lifetime of five minutes, compared with the
seven-day default uninstall grace period. The scheduled request revalidates the
same token grant, so OAuth cannot currently schedule an uninstall. This also
applies when the configured grace period is zero. An OAuth scheduling attempt
returns `409 failed_precondition` with
`details.reason: capsule_uninstall_oauth_unsupported`. Refreshing the token
does not replace the grant pinned to a request. Existing OAuth requests are not
automatically moved to a new token; the finalizer stops when their pinned grant
expires.

If authorization or Workspace authority cannot be confirmed at the deadline,
the Capsule stays `uninstalled`, and the request stops with
`uninstall.blockedReason` and `uninstall.authorizationRejectedAt`. A legacy
request without a requester uses
`uninstall.blockedReason: uninstall_requester_missing`; a pinned grant that is
expired, revoked, or otherwise no longer valid uses
`uninstall.blockedReason: uninstall_requester_denied`. Authorization refusal
normally happens before export, destroy Plan creation, or provider work. The
`capsule.uninstall_blocked` activity record also carries the refusal reason and
time. Restoring authorization later does not resume the request.

To recover an authorization-blocked request, the current Workspace owner or
admin first confirms that one of the cancellation cases above applies, calls
`cancel-uninstall`, then schedules a new request with a browser session or a
PAT that will remain valid through provider dispatch. The new request has a new
ID and a full grace period. It does not adopt the old request's requester. If those
cancellation conditions do not hold or an external operation has begun, inspect
its outcome and use authorized forward repair.

See the [API reference](../reference/api.md) for the API operations.
