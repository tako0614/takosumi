# Shared account and Workspace

This surface is available only when an operator explicitly enables the
shared-account profile for registered first-party clients. Public-service
availability depends on deployment. Existing self-host login remains available.

Both clients receive the same canonical account ID as OIDC `sub`; email is not
an account ID. The existing Takosumi Control authority owns Workspaces and
current membership. Identity claims do not grant Workspace access.

## Workspace directory

A registered RP presents its current shared-account access token as Bearer.
PATs, refresh tokens, Interface/resource tokens and caller-selected account IDs
are rejected. Genuine Accounts sessions remain supported; mutations require
the issuer Origin when using those sessions.

The base path is `/api/v1/account/shared-workspaces`.

| Method / path | Input | Result |
| --- | --- | --- |
| GET base | `selectedWorkspaceId?`, `after?`, `limit?` (1–100) | account ID, active Workspace, choices and optional page cursor |
| POST `/bootstrap` | `{}` | one canonical personal Workspace |
| POST base | `{handle,displayName,type:"organization"}` | additional Workspace |
| POST `/{workspaceId}/select` | `{}` | currently authorized choice |
| GET `/{workspaceId}/billing-organization` | none | `{workspaceId,workspaceRef,organizationId}` |

Menu reads do not change accounts or memberships. Choices contain `id`,
`handle`, `displayName`, `type`, current `roles` and `owner`. An owner field
cannot bypass inactive membership. Missing capability/binding returns 503;
denied membership returns 403. Initial owner membership is installed atomically
only for a new Workspace. Repeating creation never repairs suspended, demoted
or missing memberships. Shared Workspace/member mutations also recheck current
roles and authority when committing. Billing uses the single ledger of the
Organization bound to that Workspace.

## Combining provider logins

A matching verified address identifies candidates; it never merges accounts
alone. Each provider requires a new operation-bound login flow and explicit
consent. Non-authoritative Google third-party email also requires fresh mailbox
proof. Old sessions, refresh tokens and public profile email cannot prove a leg.

The two accounts must resolve as distinct canonical roots. Additional matching
candidates, naming an already merged account as a new root, or inconsistent
proof/owner authority and history stop the operation. An account ID in a request
is not ownership proof. Creating/selecting an additional or team Workspace is
separate from eligibility to reconcile its existing context. Do not delete old
memberships/history or substitute a new account, Org or operation key to bypass
a refusal.

In the issuer browser session, create an operation with
`POST /api/v1/account/identity-merges` and `{sourceSubject,targetSubject}`.
The current actor must be one of the two confirmed accounts. The response sets the
`__Host-takosumi-merge-browser` cookie (300 seconds), and every later step needs it. The
deadline (`expiresAt`) is five minutes after creation; finish the steps through `consent`
within it.

1. For each leg (`source` and `target`), POST `/{operationId}/upstream-proof/begin` with
   `{role:"source"|"target",providerId,consent:true}`.
2. Navigate the browser to the 200 response's
   `{authorization_url,operation_id,role}` URL. The callback returns an opaque
   `proof_receipt` and `operation_id`.
3. For each leg, POST `/{operationId}/prove` with `{receiptId}`. When both are done, the
   operation is `proved`.
4. POST `/{operationId}/context-plan` with `{}`. The response's `plan` holds the plan for the
   merged Workspaces, current memberships, and retained billing context, and
   `operation.contextPlan.planDigest` holds its digest.
5. Each leg separately accepts the same plan: POST `/{operationId}/context-accept` with
   `{planDigest,consent:true}`. Provider consent or acceptance by one leg alone cannot replace
   this.
6. From the target account's session, POST `/{operationId}/consent` with `{consent:true}`. The
   source session gets `merge_conflict`. Merged login activates once every owner confirms
   custody. If the response's `status` is still `proved`, reconciliation is pending: retry with
   POST `/{operationId}/activate` before the deadline. After the deadline, a manual `activate` is
   refused with `context_plan_conflict`, and the automatic retry only marks the operation
   `reviewed_recovery_required`; the merge does not complete.

`GET /{operationId}` shows each leg's proof and acceptance state and the expiry.

The current version handles exactly two contexts: one Workspace from the target and one from
the source (`two-disjoint-personal-contexts/v1`). A plan that does not fit this shape stops with
`context_plan_conflict`. Team contexts and rows kept by a recovery cannot be left out to make it
fit.

After the deadline, planning stops with `context_plan_unavailable` and `consent` with
`merge_conflict`.

Completing a merge requires an identity-merge reconciler and a retry capability, both passed
into Accounts from outside. In this repository only the auth-staging Worker passes them. Without
them, the proofs still work, but `context-plan` stops with `context_plan_unavailable` and
`consent` with `merge_reconciliation_unavailable` or `merge_retry_unavailable`. The dashboard
has no merge screen; a first-party page served from the issuer origin calls this API. This
repository contains only a staging context-confirmation screen.

These suffixes use `/api/v1/account/identity-merges`. Mutations require the exact
issuer Origin and host-only issuer/merge browser cookies; responses use no-store.
Ordinary session rotation preserves completed proofs. Logout and security-state
changes invalidate them. This flow proves present control of provider sessions
and conscious consent, not recent provider password or MFA entry.

After success, either provider signs into the same canonical account and old
sessions/grants are revoked. Original Workspace/Organization bindings, money,
history and pending billing-operation keys remain protected. Wallets and roles
are not automatically combined. Conflicting proof or incomplete owner
acknowledgements stop activation. Credential unlink disables that credential;
it does not split an account or wallet. Reversal of an incorrect merge requires
owner-reviewed recovery.

Select credentials from your own provider identities returned by the cookie-authenticated,
read-only `GET /api/v1/account/identity-credentials`. More than 100 returns 503
`credential_inventory_unavailable`. POST `{removedIdentity,retainedIdentity,consent:true}` to
`/api/v1/account/identity-credentials/unlink-intents`, then `{consent:true}` to
the intent's `/upstream-proof/begin`. Complete a new login with the retained
provider and POST `{receiptId,consent:true}` to the intent's `/complete` using
the callback's opaque `proof_receipt`. This flow currently supports a retained
social credential; retained passkey proof is not implemented. Completing an unlink also needs
a reconciler, and without one it stops with `unlink_reconciliation_unavailable`. The old
`/unlink` returns 409 `unlink_intent_required`; use `unlink-intents`.
