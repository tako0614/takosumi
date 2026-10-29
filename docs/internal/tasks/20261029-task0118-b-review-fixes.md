# TASK-0118 writer B independent review fixes

Scope: this repository only, PRs #654, #656, #657 and #663. Writer A's
`feature/app-access-shadow-20261028` and `origin/main` are merged normally.
No merge to main, deployment, provider operation, or live database operation is
part of this task. The four B PRs and writer E's claims change are released
together after writer A.

## Migration authority

Writer A's D1 v77 and PostgreSQL v123 remain byte-identical. The transfer
ledger and credential mint leases move to additive D1 v78
(`d1_app_authorization`) and PostgreSQL v124. The existing Drizzle mirror
describes the resulting schema. A future operator window applies v75 through
v78 together; no migration has been executed against a deployed database.
The v77 checksum is pinned by a regression test.

## Authorization and issuance

- Installed-app OAuth grants cannot manage members, transfer ownership,
  accept/cancel transfers, or uninstall. Personal sessions and scoped PATs
  continue to intersect live app roles. Workspace-bound delegated app tokens
  retain the legacy Workspace routes during compatibility.
- Apply Runs persist their requester. Revocation checks the Plan creator,
  Apply requester, and approver; queued work is cancelled in the same mutation
  as removing membership. PostgreSQL locks relevant rows, while Source sync
  admission checks current membership under the Source lock. D1 uses atomic
  admission predicates and grouped CAS guards within one batch.
- Trusted scheduled system flows use the current app owner as the account
  actor and retain the system actor in activity audit. A caller-supplied
  synthetic system name cannot become mint authority. Revision plans retain
  the requesting account.
- Legacy refresh chooses its AAD before contacting the provider. Ownerless
  connections retain their source envelope version. Physical connection owners
  override stale JSON after backfill; JSON owners survive a null physical
  column before backfill. Rewrap reports missing owners per item and permits
  expired renewal leases through an exact CAS.
- Ownership transfer drops all existing members and records notification
  recipients in audit. Member consent is persisted in the audit ledger.

## Additive account APIs

Pending transfer lists are available per app to its owner or recipient and as
an incoming list for the caller. The connection labels projection exposes only
binding IDs, providers and display names to app managers. Personal provider
OAuth starts without a Workspace and signs its owner and scope into state.
Account callers can resolve a public source's stable SemVer tag without a
Workspace. A frozen Workspace surface permits only the canonical owner-bound personal
bootstrap shared with writer A; general creation and roster mutations stay frozen. Route inventory, composed OpenAPI and both API references describe
these endpoints.

## Validation and delivery

The operator requested no local full gate because of shared SSD capacity.
Focused regressions and the affected static phases are run locally; each
published PR head must pass CI `check and test`. Current head SHAs, test counts
and any remaining limits are recorded in `/root/dev/tmp/tk0118/B-fix-report.md`.
App detail projections remain individually computed to preserve authoritative
state; app inventory batches Capsule reads and shares owner profile lookups.

## Third review, after foundation squash

Merge `origin/main` at `8a183757f` normally into #654 and propagate to #663.
The #654 merge has an empty tree diff from its pre-merge head `7bdb7ac0a`:
A's original commits and the squash already carry the same foundation bytes.
Only this worktree and these existing four PR branches are changed. The final
heads remain unmerged; no deployment or live migration is authorized here.

The revision compatibility identity remains the deterministic
`git-revision-plan:<plan-id>:<suffix>` required by the real SourcesService;
requesting account identity belongs to the Plan Run. Trusted first-party
shared-auth ingress explicitly retains session authority. PAT app attenuation
also applies to legacy Capsule routes, while the OAuth compatibility adapter
retains its existing Workspace scope.

Capsule JSON is a non-authoritative snapshot. New ownership tuples are passed
separately during initial creation; stores persist them only in the ownership
columns or the in-memory equivalent. Public projections omit all ownership,
management, and storage-root internals, including stale fields on old JSON.
Internal owner/epoch decisions read the ownership port, and artifact paths read
`getCapsuleStorageRoot`. Ownerless pre-backfill Capsules retain the trusted
legacy scheduled/system actor paths until the ownership record exists.

Pending transfers include value-free app and sender names, have a bounded
recipient list and recipient capacity, and creation is rate limited. Creation
and cancellation are audited. Account source ref resolution requires write
scope because resolving a ref starts runner work. Connection reads first query
the physical owner column, with a separate null-owner compatibility branch.

D1 v77 remains unchanged; D1 v78 and PostgreSQL v124 now embed literal SQL
snapshots rather than importing mutable schema constants. Their emitted SQL
and checksums remain identical. Mint issuance captures the original Run lease
token and refuses a result after that claim is replaced.

Local verification remains focused tests and affected static phases under the
operator's SSD constraint; stop below 1.5 GB available and remove only outputs
created by this round. Each published PR head must pass CI `check and test`.


The JSON authority split necessarily includes a narrow follow-up in the
Phase 2-owned `core/domains/sources/mod.ts`: sync admission, reconciliation actor
and connection-owner reads must use the injected ownership port after JSON
fields disappear. Source reservation, retirement, address/dedupe semantics and
polling lifecycle are preserved. This is the only file-ownership overlap with
Phase 2 in this review round, required to keep its existing source sync working.
