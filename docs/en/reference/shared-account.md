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
denied membership returns 403. Billing uses the single ledger of the
Organization bound to that Workspace.

## Combining provider logins

A matching verified address identifies candidates; it never merges accounts
alone. Each provider requires a new operation-bound login flow and explicit
consent. Non-authoritative Google third-party email also requires fresh mailbox
proof. Old sessions, refresh tokens and public profile email cannot prove a leg.

In the issuer browser session, create an operation with
`POST /api/v1/account/identity-merges` and `{sourceSubject,targetSubject}`.
The current actor must be one of the two confirmed accounts. Complete both
legs within five minutes:

1. POST `/{operationId}/upstream-proof/begin` with
   `{role:"source"|"target",providerId,consent:true}`.
2. Navigate the browser to the 200 response's
   `{authorization_url,operation_id,role}` URL. Callback returns opaque
   `proof_receipt` and `operation_id`.
3. POST `/{operationId}/prove` with `{receiptId}` for each leg.
4. POST `/{operationId}/consent` with `{consent:true}` and await owner
   reconciliation. Merged login activates only after every owner confirms custody.

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

Select credentials from cookie-authenticated read-only
`GET /api/v1/account/identity-credentials`, bounded to 100 of your own provider
identities. POST `{removedIdentity,retainedIdentity,consent:true}` to
`/api/v1/account/identity-credentials/unlink-intents`, then `{consent:true}` to
the intent's `/upstream-proof/begin`. Complete a new login with the retained
provider and POST `{receiptId,consent:true}` to the intent's `/complete` using
the callback's opaque `proof_receipt`. This flow currently supports a retained
social credential; retained passkey proof is not implemented. The old `/unlink`
route is unavailable.
