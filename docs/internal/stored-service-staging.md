# Complete stored-service staging composition

`deploy/platform/storage-staging-entry-worker.ts` is a separate staging entry.
The ordinary platform entry and default self-host composition do not select it.
Its explicit selector is `TAKOSUMI_OSS_STORAGE_PROFILE=stored-service-staging-v1`
with `TAKOSUMI_ENVIRONMENT=staging`, predeployed Control schema, actual native
`TAKOSUMI_VERSION_METADATA`, and all four distinct operator-qualified R2 stores.
Selecting these bytes does not publish or qualify a physical source.

The owning operator must publish the actual source identities, complete writer
registration, exact runtime Version and binding evidence through the Hosted
staging graph. Configuration names or source commit vars cannot replace that
evidence. Every actual write still calls the qualified Hosted source and custody
ports before R2. No tariff, debit, production route or migration is activated by
this composition.

## Private graph

The entry exposes `PrivateStoredInventoryWorker` and
`PrivateStorageWorkspaceWorker`. Both return HTTP 404; their functions are
reachable only through the selected private bindings. Workspace get/page reads
delegate to the existing Workspaces service over the canonical Control store.
`readStorageRuntimeVersion()` hashes the raw UTF-8 native version-metadata ID.
Missing native metadata returns null; no caller source commit is substituted.

`TAKOSUMI_STORED_SERVICE_USAGE` owns the five writer custody functions.
`TAKOSUMI_STORED_INVENTORY_FENCES` supplies the read-only inventory fence.
`TAKOSUMI_STORED_ORIGINAL_OWNERS` reaches the separate Hosted directory role's
`readOriginalStoredObjectOwner({ bucketRole, objectRef })`. This last function
can return only the original owner retained by an existing custody pin. It
cannot accept a Workspace assertion, prepare a write, confirm an ACK, cancel an
intent, declare absence or advance coverage.

## Original ownership

The local resolver reads bounded exact StateVersion, artifact/Run,
SourceSnapshot/SourceSyncRun, Backup and private-file receipt allocations. Raw
keys stay in OSS. Key and metadata IDs can select a record but cannot establish
its Workspace by themselves. Private-file receipt lookup verifies the exact
original scope/blob identity and all four native metadata fields.

New writes can precede final StateVersion, Backup or private-file pointer
records. Core's already-validated backup allocator captures its exact opaque
references in the paired local store. Runner writes carry the original claimed
Run lease and canonical Capsule allocation. Private-file writes carry the
already-captured authority described in [private Run files](./private-run-files.md).
The custody prepare pins the original owner before the native effect.

If final Core publication or its response fails, a fresh local resolver can
recover that original owner through the qualified private original-owner role.
The object reference is computed from the exact qualified source namespace,
role and local raw key. The returned source, epoch and qualification must match.
This is a forward hash lookup of an existing allocation; it never reverses a
hash or assigns ownership from a key prefix. The pending intent remains
pending. An owner response grants no version, quantity or coverage fact.

Retained allocations preserve their original Workspace after current Workspace
or membership deletion. Historical reads and already-accepted Restore cleanup
do not require new Workspace admission. Unknown pre-profile objects, missing
allocation evidence, conflicting owners and resolver capacity exhaustion block
inventory or mutation; they are never interpreted as zero. Unscoped legacy
mutations lack the required original allocation and are refused before provider
dispatch under this profile.

## Authority and effect boundary

Core passes its existing claimed `runId` and `leaseToken` through an in-process
execution control. The Cloudflare adapter freezes these before its first await
and sends them only in the private DO header. The header is stripped before the
Container boundary; it is not part of a job, public Run, R2 metadata or log.
A stale same-Run dispatch cannot obtain its successor's lease by rereading D1.

The Runner verifies the original claim before a fresh dispatch, before Hosted
custody prepare, and again before native R2. Private-file writes use the same
existing repository's `readPointer` authority query before prepare and before
R2, with the original scope, Run lease and Capsule epoch. An absent pointer is
an authority decision only; it is not a zero-usage or coverage assertion.
Historical read fallback cannot authorize a new prepare.

The final D1 authority read and R2 effect are separate operations. There is no
atomic D1/R2 lease transaction: a lease or epoch can change after the final read
and before R2 accepts the operation. Complete-source qualification therefore
also requires the owning controller's existing cancellation/drain discipline,
drained old writers, and exact runtime/binding registration. These checks do
not turn a local predicate into a provider-wide fencing primitive.

If authority changes after prepare, the native effect is refused and the
original intent remains pending for explicit drained-owner reconciliation. Lost
prepare or effect acknowledgements likewise remain blocking; ordinary retry
must not reacquire a newer claim, repeat the native effect, invent absence or
seal a period. Native ACK clocks describe logical custody observations, not
Cloudflare physical billing time. All quantities remain unpriced until the
operator chooses and separately activates a prospective tariff.
