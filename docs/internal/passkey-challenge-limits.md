# Passkey challenge admission and retention

Accounts owns the two-request WebAuthn ceremony. Enabling passkeys requires
durable bounded challenge admission and retention ports at handler composition.
An unsupported custom store refuses boot before discovery advertises passkeys;
ordinary Accounts without passkeys does not require these ports.

## Input and key compatibility

Passkey options accept a `tsub_` subject of at most 256 UTF-8 bytes and an optional
session context of at most 512 UTF-8 bytes. This is a route resource bound; it
does not change account subject derivation or the general subject contract.
Current canonical subjects are 37 ASCII characters.

New challenges contain 32 random bytes, encoded as 43 base64url characters.
Their fixed-size storage key is `passkey:v2:` followed by a SHA-256 digest of
the JSON tuple `(intent, subject, sessionId, challenge)`. Caller-controlled
subject/session strings are not copied into new challenge keys. Both tuple
boundaries and null versus a session string remain distinct.

Complete consumes the v2 key first and then, only when absent, the bounded
legacy exact key for a still-live five-minute ceremony. Both use atomic
delete-on-read and enforce stored expiry. V2 tuple mismatches cannot consume a
v2 challenge; legacy lookup retains its original exact-key composition.
This is new-reader compatibility;
it does not make old readers understand v2 keys or apply budgets to old writers.
Mixed-version rollout needs separate operator qualification.

## Source-owned storage budget

Both register and authenticate options share a maximum of 120 admissions in a
fixed one-minute window per durable Accounts backend. Challenge lifetime remains
five minutes. Private callers may narrow the ceiling, never raise it. Refusal
returns 429 with `Retry-After: 1`; a fresh attempt may still be refused until the
window resets or concurrent maintenance contention clears. No unknown write
acknowledgement is retried automatically.

Admission owns a bounded cleanup reservation, rather than relying on several
requests observing the same prior sweep. InMemory executes synchronously.
Postgres claims at most 64 expired rows with `FOR UPDATE SKIP LOCKED` in the same
statement as the quota update and dependent insert. D1 binds cleanup, a cursor
generation/nonce reservation, quota update and challenge insertion in one batch.
A stale D1 reservation cannot authorize another save. A failed insert rolls back
the durable statement/batch, including quota and its cleanup reservation.

Quota records use a separate private key prefix in the existing challenge
table/bucket and expire at the window end. A nonexpiring monotonic window marker
prevents a delayed request from recreating an already-collected old quota.
D1 stores that boundary with its cursor generation; Postgres serializes cleanup
and admission through one reserved high-water row in the existing challenge
table. InMemory keeps the same boundary with its store state. An older captured
window is refused; a newer window does not revoke previously issued live challenges.
No schema migration is required.
Live or unknown expiry is retained by cleanup; consume rejects nonfinite expiry.
Maintenance is bounded to 64 candidates. D1 persists ordered progress in the
existing `maintenance_cursors` bucket so held and legacy unindexed rows do not
fix the cursor at the first page. The platform's existing scheduled entry also
runs a failure-isolated slice; admission works without relying on cron frequency.

The handler's per-IP options limiter is best-effort process/isolate state. The
durable budget bounds accepted writes across current producers; it does not
establish an operator's edge/IP policy or guarantee login availability under
sustained load. Operators still supply edge admission and qualify live flags,
database behavior, capacity and rollout. Local SQLite, PGlite and workerd
fixtures do not establish a live deployment or real device/identity custody.
