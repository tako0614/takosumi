# Private Run files (internal source contract)

This document describes a product-neutral Core seam for private opaque bytes
whose lifetime is longer than one Run attempt. It is an internal source
contract, not a public API. The source includes an opt-in local Postgres plus
encrypted-blob mount, sealed Runner grant, and internal HTTP route. No host
has enabled or qualified the complete Runner-to-Provider path by this source
change; Cloud storage and Runner qualification remain separate.

## Scope and ownership

A slot is identified by `(Workspace, Capsule, environment, opaque slot)`. Run
ID and lease identify the current attempt and authorize a mutation; they are
not part of the stable storage key. A slot is either absent or present, so a
present zero-byte value is distinct from absence. Core treats bytes and slot
names as opaque; it does not decode provider or Host formats. These bytes are
not StateVersion, Outputs, public Run fields, audit values, or ordinary logs.

The provider-neutral service accepts an explicitly configured positive
`maxBytes`. It rejects non-safe or negative versions and oversize writes before
storage. It has no implicit size default, Run-completion purge, garbage
collection, reinitialization, or automatic retry policy. Rejected outcomes and
diagnostics carry no private bytes or decoded content.

## Write and ACK boundary

For a new commit, the service copies and hashes the bounded bytes, checks the
current scoped grant, writes an immutable encrypted blob, and separately asks
the blob port to authenticate/decrypt and read it back under the same scope.
The service verifies the returned byte length and digest. Only then does it
ask the repository to atomically validate the exact scope, current Capsule
`executionAuthorityEpoch`, active Run lease, expected pointer version and
commit receipt, and to advance the pointer while recording that receipt in the
same durable transaction. The `committed` result is the ACK. An immutable blob
without that repository transaction is not an ACK and may be orphaned; this
contract provides no automatic cleanup.

The authorization port validates a scoped grant but cannot substitute for
the final epoch/lease check. A grant or previously observed authority is not
proof that a later repository commit is current. A production adapter must
perform those checks in the same atomic operation that publishes the pointer
and receipt.

`commitId` is immutable within its exact slot scope. Repeating the same ID,
expected version and bytes returns the original receipt—even if a later commit
has since advanced the slot—and must not create another blob. Reusing the ID
with different content or a different expected version conflicts. A competing
write to an occupied expected version also conflicts. A repository result of
`unknown` is not retried by the service: the caller can explicitly query the
receipt with `resolve`. Both the commit preflight receipt lookup and explicit
resolution are read-only repository operations fenced against the current
Capsule epoch and Run lease. The final commit rechecks that same authority
atomically before returning a replay or advancing the pointer. If an exact
receipt is absent, malformed, or cannot be read, the result is not permission
to send an external mutation or mint a replacement commit ID. A stale epoch or
lease cannot turn a previous receipt into a new Run's acknowledgement.

## Local HTTP and grant boundary

The local mount is opt-in through the Node/Postgres composition with an explicit
durable blob root, exact endpoint URL, and 16 MiB plaintext cap. The endpoint
is `/internal/private-run-files/v1` on HTTPS or loopback HTTP; it is absent
from public discovery and has no browser CORS surface. It accepts only a
short-lived sealed bearer grant carrying exact Workspace, Capsule,
environment, slot, Run ID, captured execution-authority epoch, lease, and
operation set. Only Core opens the grant; the Runner and Provider receive an
opaque token, not the raw lease. Read, commit, and resolve require their own
operation permission and the repository's current authority fence. Scope and
authority never come from request bodies. HTTP errors and receipts omit blob
IDs, leases, grants, and private bytes (except the explicitly authorized read
response). The route bounds the JSON envelope before decode and the decoded
bytes at 16 MiB.

The grant lifetime is at most 20 minutes. That covers the current 900-second
fallback Runner deadline plus its 60-second dispatch margin; a declared slot
on a longer profile must fail before Run claim until a renewal protocol exists.
No shorter grant may be silently substituted and allowed to expire during an
external mutation. The final DB check, not the grant expiry alone, fences a
revoked or replaced lease. The current repository requires an active Workspace;
draining settlement policy is not yet implemented for this private-file seam.

## Adapter and capability boundary

The ports define obligations, not a storage implementation. In particular,
they do not claim that a local mounted volume survives an OS/container restart,
that a cloud object store and repository transaction are already composed, or
that an encryption key lifecycle has been chosen.

The local source has a PostgreSQL repository and encrypted immutable filesystem
blob implementation, but the explicit host root, endpoint, Provider remote
backend selection, and actual Runner/Provider integration must all be composed
and qualified before calling it available. The Cloud capability requires the
same semantics with its owning repository and encrypted object storage, plus
restart/kill qualification for the actual Runner deployment. Local and Cloud
success must be reported independently; one does not imply the other.

In-memory service and HTTP tests prove only their state-machine and envelope
behavior. Adapter tests cover selected transaction, encryption and restart
properties but do not prove complete host wiring, physical power-loss survival,
or Cloud Runner delivery. A mounted integration must test those properties
separately before this is described as an available runtime capability.
