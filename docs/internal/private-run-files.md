# Private Run files (internal source contract)

This document describes a product-neutral Core seam for private opaque bytes
whose lifetime is longer than one Run attempt. It is an internal source
contract only: no public API, grant format, storage adapter, Runner mount, or
Provider backend is wired by this slice. The current Runner does not provide
this capability, and a passing in-memory test is not evidence of durable
storage, process-restart recovery, or Run-to-Run delivery.

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
receipt with `resolve`. If the exact receipt is not visible, or the lookup
itself is unavailable, the result remains unresolved; it is not permission to
send an external mutation or mint a replacement commit ID.

## Adapter and capability boundary

The ports define obligations, not a storage implementation. In particular,
they do not claim that a local mounted volume survives an OS/container restart,
that a cloud object store and repository transaction are already composed, or
that an encryption key lifecycle has been chosen.

The next local capability requires a real durable repository and encrypted
blob implementation, then evidence across separate processes and an actual
restart. The Cloud capability requires the same service semantics implemented
with its owning repository and encrypted object storage, plus a restart/kill
qualification for the actual Runner deployment. Neither backend is mounted by
this change. Cloud and local success must be reported independently; one does
not imply the other.

The tests use isolated in-memory ports to check the service's state-machine
boundary only. They do not prove atomic database transactions, encryption,
durability, OS/container restart, grant delivery, or Runner integration. A
future adapter integration must separately test those properties before this
contract can be described as an available runtime capability.
