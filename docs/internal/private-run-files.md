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
`executionAuthorityEpoch`, current running Run lease, expected pointer version
and commit receipt, and to advance the pointer while recording that receipt in
the same durable transaction. The `committed` result is the ACK. An immutable
blob without that repository transaction is not an ACK and may be orphaned; this
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

Each sealed grant remains finite and lives at most 20 minutes. Core mints its
initial grant for the declared per-command Runner budget (900 seconds by
default) plus a 60-second dispatch margin; a slot-bearing profile above 1140
seconds still fails before Run claim. `maxRunSeconds` is a per-command limit,
not a whole-Run deadline: a Plan or Apply can outlive one grant across source
build, init, and provider execution. While the exact Run lease is held, Core
rechecks authority and rotates the opaque grant through the Runner's private
descriptor file before expiry. The Runner pins the slot/endpoint manifest and
accepts ordered, bounded, value-free-ACK updates; the Provider rereads the
descriptor before each private-file operation. A failed or indeterminate
refresh aborts the current dispatch attempt without resending an OpenTofu
mutation. A still-running process cannot use an expired grant. Rotation does
not extend the lease or bypass the repository's epoch/lease fence; the final
DB check, not the grant expiry alone, fences a
revoked or replaced lease. An already-running Plan/Apply-family Run may read,
resolve its exact receipt, or commit under its current lease while the Workspace
is draining only when its persisted original active management authority names
the same Workspace and its positive safe epoch precedes the current draining
epoch. This follows the existing Run settlement cutoff; it does not admit a new
Run or lease. Frozen, released, missing/malformed authority, changed Capsule
epoch, terminal Run, and replaced lease are rejected at the repository. An
expired grant still cannot use this settlement path. A Run that has lost its
lease cannot rotate a grant or recover by replaying an old one.

## Retention boundary

Private-file pointers, immutable receipts, and encrypted blobs are deliberately
retained across Run completion, Capsule `destroyed`, Workspace archive, and
management drain. Capsule delete is a terminal lifecycle transition, not a
physical purge, and Workspace archive is metadata only. Neither schema has a
private-file foreign-key cascade or a final-blob deletion path. This preserves
unresolved intent and exact ACK evidence but means terminal and orphaned bytes
may remain indefinitely. Operators enabling this opt-in mount must accept that
storage/custody burden explicitly; there is no claimed TTL, erasure, or garbage
collection. A finite retention period and safe reclamation of unreferenced
blobs require a separate owner policy and implementation, never a Run-end or
destroy-time best-effort delete.

## Adapter and capability boundary

The ports define obligations, not a storage implementation. In particular,
they do not claim that a local mounted volume survives an OS/container restart,
that a cloud object store and repository transaction are already composed, or
that an encryption key lifecycle has been chosen.

The local source has a PostgreSQL repository and encrypted immutable filesystem
blob implementation, but the explicit host root, endpoint, Provider remote
backend selection, and actual Runner/Provider integration must all be composed
and qualified before calling it available. Cloud Worker source composition can
opt in explicitly with the existing D1 and `R2_ARTIFACTS` bindings, an endpoint,
an isolated R2 prefix, the exact 16 MiB cap, and configured partitioned
encryption; the default Worker remains unmounted. The Cloud Container adapter
probes the Runner image's private-file refresh capability before a slot-bearing
Run is claimed. Plan keeps its Plan Run ID; slot-bearing Apply/Destroy use the
execution Run ID for the live Runner session while restoring the immutable
Plan artifact and verifying the reviewed lockfile against the Plan Run ID. The
Durable Object pins
the active owner, slot/endpoint manifest and ordered sequence, stages the
latest grant during artifact restore, and forwards live GET/PUT to the Runner
without persisting bearer material. A lost refresh acknowledgement is a
refusal, not permission to resend an OpenTofu mutation. Existing no-slot
dispatch identity remains unchanged.

The source bridge and local tests do not qualify bucket retention/lifecycle,
Cloud restart/kill durability, or a hosted Cloud Runner-to-Provider operation.
The in-process DO-to-real-Runner HTTP test proves descriptor rotation reaches
the OpenTofu command boundary; the opt-in workerd D1/R2 restart test proves
the storage route in a local native runtime. Neither is a Cloud deployment or
end-to-end hosted Provider proof. Local and Cloud success must be reported
independently; one does not imply the other.

In-memory service and HTTP tests prove only their state-machine and envelope
behavior. Adapter tests cover selected transaction, encryption and restart
properties but do not prove complete host wiring, physical power-loss survival,
or Cloud Runner delivery. A mounted integration must test those properties
separately before this is described as an available runtime capability.

One native Worker test exercises the composed HTTP route in Miniflare/workerd
with real isolated D1 and R2 bindings and test-owned persistence roots under
`tmpdir()`. The package test suite discovers it but skips it by default. Opt in
on Linux with procfs using the cached Miniflare/workerd runtime:

```sh
mkdir -p /dev/shm/t
TMPDIR=/dev/shm/t TAKOSUMI_TEST_NATIVE_PRIVATE_RUN_FILE_WORKER_RESTART=1 \
  bun test tests/worker/src/private_run_file_worker_native_restart_test.ts
```

The test creates and removes its own persistence root under `tmpdir()` (so
`TMPDIR` selects `/dev/shm/t` above). It runs the composed HTTP route with real
isolated D1 and R2 bindings, commits through the encrypted adapter and atomic D1
pointer/receipt path, drops the HTTP commit response before the client observes
it, resolves that exact receipt, then kills and restarts the workerd child
against the same roots before reading and resolving again. It checks foreign
scope, expiry and frozen-authority refusal. The opt-in test fails if Linux
procfs or its configured temporary directory is unavailable; default portable
tests do not require either. This verifies cross-process visibility within the
local tmpfs persistence implementation, not physical-disk durability. It
qualifies only the cached local Miniflare/workerd runtime; it is not Cloud R2,
Hosted Worker, Cloud Runner, power-loss, or production durability evidence.
