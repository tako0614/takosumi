# Canonical account groups and context continuation

Status: **unadopted design proposal; unimplemented**. This follow-up requests
Accounts/Core policy review for existing multi-context accounts, later canonical
group merges and new operations after recovery. It does not widen the current
merge contract, establish a final launch exclusion or authorize deployment.
The earlier [auth design](./auth-takos-jp-design.md) remains the issuer, claims,
client and session design baseline; those topics are not redesigned here.

## Source baselines and obligations

| Baseline | Observed behavior | Status |
| --- | --- | --- |
| Main at [`dac30855`](https://github.com/tako0614/takosumi/blob/dac30855915e49e5a4fb9782c489a023e7ed1f5a/accounts/service/src/identity-merge.ts#L45-L96) | Two distinct self-canonical account roots, fresh address/provider proof, operation-bound consent and owning reconciliation. No Core context-plan interface in this baseline. | Existing source; deployment qualification is separate. |
| Candidate [`11d8acf5`](https://github.com/tako0614/takosumi/blob/11d8acf5cae3d624dda6656d84bdcdccdc0585b6/contract/identity-reconciliation.ts#L18-L76), [PR475](https://github.com/tako0614/takosumi/pull/475) | Private v1 Core context plans, separate acceptance by both proved legs, complete census and retained owner custody. Initial inventory is two disjoint personal contexts. | Pending, unmerged candidate at this design baseline; not available merely because it is documented. |
| Proposed v2 below | Explicit group-head ancestry, full context dispositions, multi-member deltas and custody continuation. | Review request only; no implementation or operator activation. |

The [shared-account implementation contract](./shared-account-oidc.md) and actual
selected source version govern an operator's composition. A successful local
check or an optional profile does not establish actual issuer/owner readiness.

Accounts owns canonical identity; existing Control owns Workspace membership,
personal bootstrap and immutable billing bindings. Original account/provider
IDs, Workspaces, members, Organizations, balances, grants, source/Run history
and pending/unknown operation keys remain protected. Sharing an account or
matching email does not union permissions or wallets.

The candidate's safe refusal of initial team/extra contexts, an ACTIVE group
in a new operation, or a distinct merge after applied recovery is consistent
with its explicitly initial v1 contract. Same-operation retry/readback and
renewal of the same immutable reviewed recovery decision remain obligations.
No unrestricted group-merge entitlement follows from the current contract;
no accepted final launch waiver for the broader cases is established either.
Existing team/additional Workspace creation is independent of merge eligibility.
Coverage of protected existing contexts must be resolved before claiming the
shared-account migration complete, rather than silently dropping those contexts.

## Decisions requested from the owners

1. **Group representation.** Adopt current-canonical-group-controller
   representation for v2: a new enabled-credential proof authenticates the
   current group controller, who accepts the complete server-derived plan.
   This would be a new policy, not delegation inferred from old dual consent.
   Requiring fresh acceptance from every historical original root is an
   alternative requiring explicit adoption, not a current obligation.
2. **Workspace continuity.** Define Control's identity-continuity policy and
   when a real current Workspace-owner decision is required. A provider proof
   alone must not become arbitrary team membership administration.
3. **Recovered rows.** Permit an explicit new plan to regrant only an unchanged,
   operation-created row using exact apply/recovery provenance and current
   Workspace authority. A suspended status alone must never permit repair.
4. **Legacy conversion and participant coverage.** Qualify complete existing
   group/lock/receipt inventories and each actual external owner before v2
   activation. Unknown lineage or missing coverage remains unavailable.

Until reviewed and adopted, these decisions confer no new authority. A retired
or unlinked B credential must not be recreated as a new person merely to make
B's protected historical reference fit a pair-only API. Conversely, an A login
must not silently acquire unapproved group representation or Workspace powers.

## Accounts group and proof model

Propose a versioned immutable group snapshot plus one current head authority.
The snapshot binds the existing canonical account ID, sorted full original-root
closure, original-group identities, head revision, each root's exact canonical
projection/generation/prior lock, and predecessor operation/Core/owner receipts.
The browser supplies none of that authority. Missing, intersecting or extra
members, inconsistent projections and unknown legacy coverage refuse admission.

| Operation | Direct current projection | Retained history |
| --- | --- | --- |
| Group `{A,B}` merges into C | A→C, B→C; C stays canonical | Original B→A event, original provider bindings and both prior group snapshots |
| C merges into group `{A,B}`, canonical A | C→A, B→A; A stays canonical | All original groups and prior receipts |

Never implement B→A→C resolver traversal or create a new account ID. The existing
canonical mapping can be a materialized current projection updated by the same
typed CAS as the authoritative group head; retain its exact prior value in
immutable transition evidence. Do not keep independently writable v1/v2 answers.
A bounded reviewed conversion must establish complete legacy coverage; absence
of one row is not permission to invent singleton genesis. Old authoritative
writers require an actual compatible cutover and readback before activation.

A new proof separates immutable provider/original root B from current canonical
A and binds both to the current group/head, member generation, operation leg,
browser, transaction, plan and expiry. Disabled credentials cannot represent a
group. Both selected controllers separately accept the same complete context
plan after new operation-bound proofs. Old provider consent is not context
acceptance or a transferable future delegation.

Email remains candidate evidence. Quotient candidates only through verified
current group membership: prove exactly the two selected groups, and include
all their originals even if some contacts changed. Unknown third groups,
normalization/reuse conflicts and incomplete inventories refuse. Preserve fresh
mailbox proof for non-authoritative addresses. Do not change the canonical
profile email to satisfy an old pair predicate. Candidate-inventory and
current-group-head conditions both participate in the atomic check.

## Complete Control plan and permission dispositions

Discover contexts owned by any original group account, all contexts referenced
by its memberships regardless of status, and retained predecessor-custody
contexts. Bind full affected rosters, orphan evidence, management state/epoch,
Workspace incarnation, personal slots, immutable billing pins and relevant
Principal/reference inventories. Do not recursively absorb unrelated Workspaces
solely because a third party appears in an affected roster. A selector assigns
a disposition to every context; it does not filter the census.

The target group's existing personal Workspace remains the canonical fallback.
W_B retains ownerUserId B, its original member/slot, Org_B and original resources
and history. A team keeps its real owner and Org; that owner is not added to the
account group. Current canonical membership governs access, not a historical
owner field or an old provider/account reference.

| Current condition | Proposed disposition |
| --- | --- |
| Legitimate current source authority and initially absent target | Explicit insertion with exactly approved roles under the applicable Control policy |
| Shared/team context | Require the adopted continuity policy or actual current authorized Workspace-owner approval bound to operation/member/epoch/target |
| Active target with identical approved roles | Explicit retain/no-op; preserve original rows and provenance |
| Different active roles or incompatible policies | Conflict for exact owner resolution; no union, maximum-role rule or hidden downgrade |
| Invited/suspended target, disappearance of an expected target row, or revoked source access | Preserve non-authorizing state; no implicit repair |
| Exact unchanged row suspended by prior reviewed recovery | New continuation only with original apply/recovery receipts, row identity/hash and current Workspace authority |

Replace the candidate's singular added-member mutation with a bounded typed
delta vector. Persist immutable BEFORE/AFTER census, every expected row and
predecessor receipt, the operation/event and current deltas in one local CAS.
Accounts remains the current group authority; Core need not introduce a second
group directory. Shared-team and no-op races still require complete census and
actual external custody checks, even when local rows appear unchanged.

## Reservation and cross-owner custody

After all asynchronous preparation, consume the genuine transient one-use
checkpoint immediately before Accounts' local reserve dispatch. Bind the full
head/member/generation/prior-lock vector, operation, group/plan/target/client
and every proof/session/context/email expiry at the same fresh trusted time.
Fake/copied/reused checkpoints, stale heads and backward clocks refuse. This is
a local precommit guarantee, not remote execution-time or cross-database 2PC.

Reservation atomically hands off only exact terminal predecessor locks, retains
their ancestry, revokes grants and advances generations across the full closure.
A foreign pending/quarantined lock is not replaceable. Roots stay fenced while
partial work is pending. Core applies its complete delta; Accounts durably
retains the original Core readback/context before external reconciliation.

The plan must cover actual Financial, Hosted-intent, RP-session and
resource/Principal participants across every affected original owner, context,
Org/reference/source pin and prior custody head. A method or boolean is not
coverage. Required authenticated receivers append a handover from their prior
accepted head and CAS their own inventory/epochs. First genesis and subsequent
handover differ: preserve original receipts and pending keys, never reset
source/history epochs or represent a foreign ACK locally. Missing transport,
issuer availability or coverage refuses before fencing. These real capabilities
are not configured or qualified by this proposal.

Activate only after full durable owner readback and current all-member/head/
candidate CAS. Both RPs then receive the same canonical sub; current Control
memberships still determine permissions. Historical evidence cannot provide
fresh activation, barrier release or unfencing authority. Private v2 projections
must distinguish fresh, historical and terminal state, binding the complete
current group/custody vector; observation time is revalidated separately from
stable immutable authority.

## Recovery and later continuation

A pre-activation abort restores predecessor groups and prior ACTIVE lock
ownership, rather than deleting every lock. Restore after `{A,B}→C` restores
`{A,B}` and `{C}`, including B→A; it does not split them into three new people.
Advance current head/epoch/generations; never rewind them. Preserve every
intervening historical edge, wallet and legitimate financial/Run operation.

Core undoes only its exact unchanged operation-owned deltas. Inserted authority
remains a non-authorizing retained row after recovery. A distinct retry needs
new proof/consent and a plan bound to that row's original apply and recovery
provenance. Independent edits, changed rights/pins or later custody refuse old
undo and require reviewed forward repair. A superseded ancestor cannot roll
back descendants.

Same immutable recovery-decision approval renewal retains original context and
receipt ancestry. An unchanged same-operation replay is different from a new
merge or a new recovery decision. Terminal release requires actual current
ACTIVE/recovered state, the exact complete owner-receipt set and receiving
owner's current custody epoch. An expiry or historical receipt never releases
barriers.

## Versioning, storage and evidence required

Use separate v2 tagged Accounts operations/proofs/groups, Core plan/receipt and
supported-inventory contracts, and private owner-operation/receiver handover
contracts. Preserve v1 codecs and immutable historical receipts. Unknown
versions refuse; adding fields to a strict v1 DTO is not negotiation. Keep
Core opaque digests distinct from Accounts evidence encodings.

The pending candidate's Accounts v5/PG045 and Core v73/PG120 JSON records can
represent bounded new snapshots and vectors. That is storage feasibility, not
a proven group CAS: current pair checks, singular member SQL and decoders need
versioned changes. PG's two subject FKs do not protect a whole JSON array;
use protected per-root reference records and complete vector checks. Accounts'
current group head plus known predecessor Core records is the smallest design
without a second head directory. If independent Core head uniqueness/indexes
become necessary, request an additive owning schema after evidence. No new
migration number is proposed; applied history is unchanged.

Preserve existing bounded refusals. The candidate limits each Core collection
to 64 and the D1 identity envelope to 2,000,000 bytes. Larger protected
inventories need a qualified bounded snapshot/cursor/epoch transition, not
truncation, unbounded writes or an implicit launch exclusion. Actual schema
qualification and protocol eligibility remain separate.

Required review/proof covers both group directions after a genuine B→A, initial
team/multiple contexts, inherited and disabled credentials, permission conflicts,
all-member/head/lock phantoms and one-winner races, actual applied recovery then
new continuation, late/superseded undo, checkpoint expiry through every backend
preparation, crash/unknown ACK/original-key replay, complete receiver custody
handover and current writer retirement. Use actual Accounts/Core composition,
native D1 and independent PG writers, retained nonempty historical data,
compatibility rehearsals and final exact-head owner gates/QA. No such v2 runtime
proof is claimed by this design.
