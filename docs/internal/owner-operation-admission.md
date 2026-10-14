# Private owner-operation admission

Accounts exposes a source-only, route-less `AccountsOwnerAdmission` named Worker
entrypoint for the `hosted-intents` participant. It reads persisted identity
operations; it does not accept a browser identity, issue recovery approvals or
perform reconciliation. The external owner receipt contract remains unchanged.
The entrypoint and the staging HTTP/retry composition use one pinned owner
bundle, Accounts store and Control identity authority.

This implementation does not configure a real owner, review issuer or private
deployment graph. Missing Financial, Hosted intent, RP-session or Principal
custody remains unavailable before Accounts reserves a merge. Portable fixtures
and a successful build do not establish owner readiness.

Even when all four owner ports are supplied, ordinary pre-fence readiness also
requires current authenticated review-issuer availability through the same
immutable bundle. A separately qualified trusted composition must capture the
issuer/key and fixed service target. A fresh server-nonce status signature binds
the exact operation, kind, plan, client, target and staging environment under a
distinct short-lived signature domain. An arbitrary boolean method or metadata
descriptor cannot replace that verifier. The default staging composition supplies
neither this issuer nor its transport. Availability attests only the issuer's
current status; it does not approve a human decision or mint a per-operation
recovery approval.

## Request and authority

The only request is `readOwnerOperation({ operationId, kind, planDigest,
purpose })`. Extra keys refuse admission. `kind` is `merge`, `unlink`,
`abort-before-active` or `restore-after-active`; `purpose` is `readiness`,
`reconcile`, `readback` or `release`. Accounts derives roots, generations,
consent, fences, original context pins and receipt ancestry from its own store.
The caller cannot supply any of them.

The service binding is a private deployment capability. Its trusted callee
composition captures the logical service client and target; the service client
is separate from the Hosted OAuth RP client. A request property, Worker props,
Basic credential or browser grant cannot select that authority. The named
entrypoint has no HTTP forwarding route. A holder of a service-binding
capability can call it, so qualification must inspect the actual deployment
graph and refuse unexpected callable edges rather than trust a caller-name
string.

The stable target commitment binds the fixed owner/client, issuer and owner
Worker identities, Accounts/Control and owner custody resources, binding name
and named entrypoint. Mutable source/version and preview/alias closure belong
to separate observed graph qualification. A source descriptor or environment
variable alone proves neither. Unknown physical custody resources remain
unqualified; changing a custody target cannot silently reuse an operation's
original target commitment.

The provider reader's result is limited to topology and metadata. Source commit
and artifact binding text does not prove reviewed source became the uploaded
bytes. The owning issuer and owner releases must separately establish that
custody link to their exact immutable versions. Until that evidence and the
actual authenticated owner/review capabilities exist, this reader cannot
establish source-qualified readiness.

## Lifecycle projections

| Purpose | Returned admission | Required authority |
| --- | --- | --- |
| `readiness` / `reconcile` | `fresh` | Current persisted operation, exact dual proofs/context acceptance or unlink ticket, current generation/fence/lock and approval where applicable; checked again after awaits. |
| `readback` | `historical` | Exact immutable original context and durable receipt ancestry. Expired original browser proofs cannot become fresh permission. |
| `release` | `terminal-release` | Actual Accounts ACTIVE/completed/recovered state and the exact Core plus all four external owner receipts. |

An undefined result means unavailable. A historical projection cannot activate
an account or release a barrier. Terminal release supplies evidence for the
receiver to verify its original receipt, inventory and local custody epoch in
its own atomic database boundary; it does not perform that CAS on the owner's
behalf. Timeouts do not release custody. A foreign operation lock, changed
canonical mapping or mismatched original receipt refuses admission.

## Retained evidence

After actual Core apply/readback and before the first durable external owner
call, Accounts creates an immutable context record containing the actual Core
receipt, derived owner context, target and captured operation revision. A pure
readiness check may run earlier, before reservation. Failure or conflicting
evidence stops durable external work. Exact retries reuse the original record;
they do not reconstruct it from the latest Core recovery receipt.

Each validated durable owner readback is then retained create-if-absent against
that context and owner kind. An unknown acknowledgement is recovered through
the original context and exact owner readback. Original Workspace/Org/wallet
and pending-command references remain unchanged. Legacy operations without
this evidence remain unsupported; there is no automatic ancestry repair.

The existing Accounts D1 v5 document table and PostgreSQL 045 identity-record
table hold these records. No migration or historical checksum changes are
needed. The context key is the immutable operation/kind/plan tuple; target
changes cannot create a second version of that logical record.

## Reviewed recovery evidence

The bounded recovery reader retains a signed immutable approval, a current
approval pointer and an immutable reviewed-reference index in one backend
atomic operation. Renewal preserves the original decision and ancestry while
allowing a later event reference and expiry. Historical lookup uses an exact
approval digest or reviewed reference; it never falls back to the newest
approval. Concurrent replacement, reused references and changed operation
state must refuse without partially advancing those records.

A future separately authenticated operator issuer may supply an ES256 review
that binds the persisted operation/revision, pair, plan, generations, recovery
mode, fixed target and owner's pre-review evidence digest. The pre-review
digest excludes the root approval; the owner envelope may bind both without a
hash cycle. Signature verification grants an internal capability, not a public
writer. The real issuer and key remain unconfigured. CI results, files,
reviewer strings, booleans and unrelated privacy-operation secrets cannot mint
an approval.

New Accounts evidence/approval/target digests encode the SHA-256 bytes as
canonical unpadded base64url (`sha256:` plus 43 characters), including canonical
unused bits. Existing Core plan/inventory/proof digests retain their exact
opaque representation, currently hexadecimal. Converting an owner's SHA-256
hex digest to the new encoding preserves the same bytes; it does not rehash the
pre-review subject or change existing Core identifiers.

See [Control identity reconciliation](./control-identity-reconciliation.md) for
context consent, protected personal contexts and external owner boundaries.
