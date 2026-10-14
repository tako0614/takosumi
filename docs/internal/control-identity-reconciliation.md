# Private Control identity reconciliation

Control owns the real Workspace/member and immutable Workspace-to-Organization
records. Accounts owns canonical login identity, provider proofs, consent,
security generations and authentication fences. The private reconciliation
service joins these authorities through an operation-bound contract; it creates
no second directory, wallet or public account-administration API.

The initial supported inventory is two existing, disjoint, unshared personal
Workspaces with only their current original owner memberships and immutable
billing bindings. The full roster includes invited and suspended rows; any
third-party row is unsupported in this first phase. The
service must reject additional, orphaned, suspended, team or resource-specific
Principal references it cannot reconcile. A bounded overflow is a refusal, not
an empty inventory or permission to omit a context.

## Context consent and admission

Email equality does not authorize a context transfer. Accounts first proves
both original roots through the existing operation-bound provider receipts.
Only then may Control expose their context inventory to the proved operation.
It creates a bounded immutable plan containing the exact original Workspace,
member, private management epoch, personal bootstrap and billing-reference
snapshots. Its digest binds the pair, direction, original proofs and authority
version. The browser cannot choose new roles, canonical roots or Org references.

Each named leg explicitly accepts that same plan through its own current issuer
session. A target session cannot accept on behalf of the source. The acceptance
receipt binds the original proof, identity generation, browser, operation and
plan. The generic final merge consent cannot replace either context acceptance.
Normal session rotation between the two legs retains the original proof anchor;
revocation, expiry or a changed security generation invalidates the admission.

Before Accounts reserves the merge, the same plan must still match current
Control rows and every required external owner must be available. Reservation
revokes the original sessions/grants and fences both roots. Work after that
point uses the trusted persisted-operation reader, which checks the exact
consented operation, consumed receipts, reserved generations and operation-owned
fences. It does not forge a current browser session or promote an RP assertion.

The private facade accepts operation IDs and plan digests. Its constructor
receives the actual Accounts authority reader. Public JSON, an unsigned subject
or a client secret alone cannot construct that authority. The in-process
composition uses the same canonical Control store and pins the reader identity
with its cached service composition.

## Preserved personal contexts

For source B and target A, the canonical personal anchor remains A's existing
strict bootstrap Workspace W_A. Control retains W_B, its `ownerUserId=B`, B's
original member and personal bootstrap slot, and both W_A/Org_A and W_B/Org_B
bindings. It does not renumber IDs, move resources, combine balances or reset a
pending billing operation.

An explicitly accepted plan may add one current A membership to W_B with the
exact approved original roles. It does not union role sets, repair an old
removal or derive owner authority from the historical owner field. An existing
conflicting target membership refuses the operation. The shared directory uses
current real membership to show W_B as an additional context while W_A remains
the canonical personal fallback. Later revocation continues to take effect.

Resource-specific Principal grants require their own owner reconciliation.
Preserving a historical B reference does not authorize A to use that grant.
The initial service refuses unsupported references before reservation.

## Atomic custody and recovery

The dedicated Control operation record retains the immutable plan and its
before/after snapshots. An append-only event record identifies each transition.
Apply checks the entire current inventory, exact target absence/member, original
Workspace incarnation, management epoch and billing pins in the same database
boundary as the member write and durable receipt. Replaying the identical
operation returns its original result; reusing an ID with different immutable
context refuses. Remote calls are outside the local database transaction.

An unknown acknowledgement requires exact operation readback. It never permits
a new financial command or replacement operation key. A partial external result
keeps Accounts fenced and uses the existing bounded scheduled retry. Expired
proof requires reviewed recovery, not automatic activation or release of fences.

Pre-activation abort and post-activation restore are distinct reviewed modes.
They require the original operation, unique recovery ID and real reviewed owner
approval. A renewed fresh approval can resume the same immutable recovery
decision and original receipt after an external timeout; it cannot change the
operation, recovery ID, pair, plan or mode, or rewrite the original audit.
Control changes only its unchanged operation-created authority through
snapshot CAS, retaining a non-authorizing audit row. A concurrent member or pin
change refuses recovery; an older snapshot must not overwrite newer authority.
The owner must reconcile financial and consumer custody before Accounts removes
its own alias or fences. No money rollback is implied.

Credential unlink preserves the Workspace and billing records. Its private
receipt binds the server-minted unlink intent, removed and retained identity
digests, retained provider proof and identity generation. A row count or a
subject-only boolean cannot establish that a retained credential works.

## Compatibility and external ownership

Control D1 v73 and PostgreSQL catalog v120 add only the retained identity
reconciliation operation/event storage. Earlier migration history is immutable.
Accounts context records use its existing private document storage; this does
not alter the applied Accounts v5/045 lineage. Protected data requires a separate
backup, rehearsal and owner-authorized migration through the owning lane.

The ordinary bridge supports exact Control v71/v72/v73 and Accounts v4/v5 with
the shared profile disabled. It must serve the existing schema before the new
expansion is applied. Billing bindings require their v72 expansion; identity
reconciliation and dedicated staging qualification require v73. Request handlers
do not apply schema, and the unconfigured private feature does not query new
tables during stock startup.

A Control receipt attests only the local Control decision. Financial ledger and
Organization custody, Hosted pending/unknown-intent access under original keys,
resource-specific grants and each RP's session revocation remain separately
authenticated owner contracts. Missing transports or receipts fail closed before
reservation; local test fixtures do not qualify them. The dedicated source
composition does not configure real owner targets, credentials or live authority.
Its pinned owner bundle shares one Accounts authority across the reconciler and
route-less private operation reader. It retains original Core/context and actual
owner-readback evidence in existing Accounts document storage. The bounded
recovery reader has no configured real review issuer, so providing a custom
reconciler or source descriptor cannot enable real recovery. See
[private owner-operation admission](./owner-operation-admission.md) for fresh
versus historical projections and required actual private graph qualification.
Authenticated external owner transports and the real review issuer still need
a separately reviewed composition before activation.
Publishing source, green CI or this contract does not establish a staged merge
or authorize production publication.

The official product composition must use the opted-in shared authentication
boundary on every origin and alias before real merge readiness can be qualified.
Legacy human login, cookies and human OAuth/Principal grants must not reach
Control around its current canonical account fences. Independent operator and
current Run credentials retain their separately validated actor authority;
neither a Bearer prefix nor a resource-owner Capsule ID proves such an actor.
Ordinary self-host behavior remains separate when the shared profile is absent.
Actual release/configuration/topology readback and RP cutover qualification are
still required; a configured flag or local fixture is not that evidence.
