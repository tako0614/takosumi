# Retained Workspace billing bindings

The Workspace Control ledger owns one immutable enrollment intent and one
immutable billing binding for each Workspace UID. An explicitly configured
billing owner owns the Organization, wallet, financial authorization and
resources. Control retains opaque references and admission provenance. It
neither creates a financial ledger nor grants payment or resource authority.

The generic model is
[`workspace-billing-bindings.ts`](../../contract/workspace-billing-bindings.ts).
The actual `WorkspacesService.billingBindings` facade uses the same Control
store and current membership authority as other Workspace operations; it is
not another Directory or identity database. A composition must separately
provide an authenticated, idempotent billing-owner enrollment transport.

## Operations and retained state

| Operation | Behavior |
| --- | --- |
| `get(workspaceId)` | Reads the current incarnation's intent and binding. Archived Workspaces retain the same binding. Reused UIDs with a different birth/immutable identity are rejected. Raw source rows remain available to owner recovery after deletion. |
| `prepare({workspaceId,billingAuthority,actorAccountId,expectedWorkspaceManagementAuthority?})` | Captures the original Workspace, active owner/admin membership and management epoch. Atomically reserves a stable intent ID and opaque Workspace reference before sending anything to the billing owner. |
| `claim({workspaceId,intentId,actorAccountId,organizationRef,ownerAcknowledgementRef})` | Uses the persisted original snapshots and exact original actor. Atomically rechecks those snapshots and current active membership/management before inserting the immutable owner acknowledgement. |

The public intent contains `intentId`, `workspaceId`, `billingAuthority`,
`workspaceRef`, `workspaceCreatedAt`, `actorAccountId`, `managementEpoch` and
`createdAt`. The binding adds `organizationRef`, `ownerAcknowledgementRef` and
`boundAt`. Private stored intents also retain the original full Workspace,
membership and management tuple. Those private snapshots are never forwarded
to the billing owner or exposed as browser authorization claims.

Concurrent prepares for the same authority and Workspace incarnation return
the first durable intent and its reference. The original actor and admission
tuple do not change. Another actor cannot silently take over a pending
enrollment. A replay of the same intent with different payload is refused.
Concurrent identical acknowledgements return the first durable binding,
including its timestamp. A different Organization, reference, authority or
acknowledgement conflicts; there is no relink, update or delete operation.

An external timeout or unknown acknowledgement leaves a queryable pending
intent. Retry sends the same stored intent ID and Workspace reference. It
does not manufacture another Organization or reference. Losing membership,
changing the Workspace snapshot or advancing management epoch before claim
leaves the intent pending and confers no new authority. The same-identity
account merge does not reset a binding, union role claims or change money and
resource references. A reviewed reconciliation is a separate owner operation.

`prepare` requires the actual active owner/admin member row. The namespace's
`ownerUserId` field cannot substitute for that row. A current viewer can read
an existing binding through an authorized composition, but cannot enroll a
missing one. Reading a mapping does not itself authorize wallet reads,
subscriptions, top-ups or payments; the billing owner checks those rights.

## Storage and protected compatibility

Memory checks and inserts share one synchronous boundary. PostgreSQL locks
the same Workspace/member rows used by management and membership mutations
inside its transaction. D1 uses a guarded insert and readback in the same
batch, checking the exact original Workspace JSON, active management epoch,
membership identity, roles and physical/JSON columns. No authority snapshot
is refreshed after waiting for an external acknowledgement.

Control D1 v72 and PostgreSQL catalog v119 add
`workspace_billing_intents` and `workspace_billing_bindings` (the PostgreSQL
names have the existing `takosumi_` prefix). They have unique Workspace,
intent, authority/reference and authority/Organization keys. They have no
Workspace or Account foreign key, cascade, mutable Workspace JSON marker or
wallet balance. Archive, membership removal and Workspace deletion retain
the original rows. Existing migration/checksum history is unchanged. The
addition is forward-only for protected data; no live migration is performed
by authoring this implementation.

The runtime bridge supports only exact checksum-verified Control D1 v71 and
v72 catalog prefixes for existing ordinary Control operations. It executes
no DDL in `predeployed` mode. Billing binding reads/writes require the full
v72 proof independently, and the exported staging qualification verifier
still requires the exact current catalog. This permits a profile-disabled
bridge to run on v71 before a separately authorized additive migration to
v72. It does not make an old exact-v71 artifact compatible with v72.

## Existing financial references

Absence of a Control binding does not prove that a protected Organization or
wallet is absent at the billing owner. The enrollment transport must attest
that creation is safe and idempotent for the exact stored intent/reference,
or return the owner's matching existing reference. A mismatched historical
reference is a conflict. Reviewed adoption of an existing protected binding
requires its owner's separate authority; a Workspace owner marker, email
match, new login or migration number is not such proof. Source primitives do
not perform that adoption or import financial rows.
