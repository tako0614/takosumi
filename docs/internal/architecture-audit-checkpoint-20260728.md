# Takosumi architecture audit checkpoint — 2026-07-28

Status: incomplete remediation handoff. This is a restart checkpoint, not a new
architecture authority. If this note conflicts with `final-plan.md`,
`core-spec.md`, `core-conformance.md`, or `AGENTS.md`, those documents win and
this note must be updated.

Scope: the Takosumi OSS repository and the adjacent operator, Cloud, Store,
mobile, and first-party application repositories under `/root/dev/takos`.

No commit, push, release, migration, or deployment was performed at this
checkpoint.

## Outcome at the checkpoint

The audit and remediation pass closed the immediately unsafe issues found in
authentication/authorization, public route fallthrough, destructive legacy
migrations, state/output restoration, worker lease loss, backup exposure,
contract duplication, Store source selection, provider boundaries, release
pinning, and commercial-ledger concurrency.

Important fail-closed behavior now includes:

- legacy Takoform identity migrations refuse ambiguous evidence instead of
  inventing a new identity;
- a lost execution lease aborts in-flight external work;
- the public backup surface is export-only;
- provider and Store source selection use explicit canonical contracts instead
  of display metadata or local-name heuristics;
- AI Gateway token-priced requests return `503` while exact durable token-usage
  capture is unavailable.

The obsolete in-repository `takosumi/mobile-kit` copy and its duplicate tests
were removed. The canonical reusable client package is the sibling
`../mobile-kit`.

## Remaining work

### H-01 — Split and establish provenance for the dirty worktrees

Priority: P0, before any further implementation or deployment.

The current branch contains a large cross-repository working set, and some
changes predated or ran concurrently with this audit. Path counts at this
checkpoint are informational rather than an authorship claim:

| Repository         | Changed paths |
| ------------------ | ------------: |
| `takosumi`         |           299 |
| `takosumi-cloud`   |            67 |
| `takosumi-private` |             2 |
| `takos-control`    |            37 |
| `takosumi-store`   |            16 |
| `mobile-kit`       |            27 |
| `takosumi-mobile`  |             4 |
| `takos-git`        |            98 |
| `takos-office`     |            43 |
| `yurucommu`        |            25 |
| `yurumeet`         |             2 |

Required resolution:

1. Inventory each changed path and distinguish pre-existing work from this
   remediation.
2. Group changes by contract/migration/runtime/release concern, not merely by
   repository.
3. Review and commit the groups independently.
4. Run the full affected-repository gates from those clean commit boundaries.
5. Do not deploy directly from the current mixed working tree.

### A-01 — Make Run execution recovery step-durable

Priority: P1.

The current `OpenTofuRunOwnerObject` owns scheduling, retry, and recovery with a
Durable Object record and alarms. Lease renewal loss now aborts external work,
but a process reset or lost response can still leave a long-running external
step with an outcome that must be inferred by recovery code. The remaining
architectural problem is not another retry loop; it is the absence of a
durable, fenced receipt for every externally visible step.

Target design:

- use a Workflow or an equivalent durable step ledger for long execution;
- restrict Durable Object alarms to short wake-up/coordination ticks;
- give checkout, plan, apply, state commit, output commit, and release
  activation stable operation ids and exact run/lease/generation fences;
- persist started/completed/failed receipts around each side effect;
- make a retry adopt a proven result or replay an idempotent operation;
- make cancellation and lease loss invalidate all later receipts from the old
  owner.

Completion evidence:

- reset and lost-response tests at every step boundary;
- duplicate delivery and concurrent-owner tests;
- cancellation during external work;
- proof that no stale owner can publish state, outputs, or release activation.

Primary implementation area:
`worker/src/durable/OpenTofuRunOwnerObject.ts`,
`worker/src/durable/OpenTofuRunnerObject.ts`, and the Run/deploy-control ports.

### A-02 — Replace R2 inference with an immutable state commit manifest

Priority: P1.

State recovery currently has useful digest/custom-metadata verification and
cursor-paged R2 discovery, but R2 object metadata must not become the canonical
commit authority. State bytes, the current pointer, StateVersion, Output
generation, and the Run terminal need one exact logical commit identity.

Target design:

- write encrypted state and output artifacts under content-addressed,
  immutable keys;
- create an append-only commit manifest containing the Run id, Capsule id,
  prior generation, new generation, artifact digests, Output generation, and
  lease/fence identity;
- commit the manifest identity and current StateVersion/Output pointers with
  one database CAS/transaction;
- recover from the database manifest, then verify R2 bytes and digests;
- treat R2 `customMetadata` and bucket listing only as diagnostics/repair
  inputs, never as authority to advance current state;
- garbage-collect only artifacts proven unreachable from committed manifests.

Completion evidence:

- crash tests before and after every object write and database commit;
- stale-current-pointer and conflicting-generation tests;
- tampered/missing object tests;
- concurrent apply/restore fencing tests;
- a bounded, resumable orphan-artifact collector.

Primary implementation area:
`worker/src/durable/OpenTofuRunnerObject.ts`, state artifact stores, and
StateVersion/Output persistence ports.

### C-01 — Add an exact durable usage journal before token-priced AI

Priority: P1 for enabling the feature; current production behavior is safe.

`takosumi-cloud/extensions/ai-gateway/src/index.ts` intentionally rejects
token-priced model execution with
`ai_gateway_token_usage_capture_unavailable`. Keep that fail-closed response
until an exact post-provider usage journal exists.

The journal must bind:

- one stable request/operation id;
- Workspace, billing subject, offering/SKU, price-catalog version, and model;
- any precharge/reservation;
- provider request outcome and exact input/output token usage;
- the immutable commercial usage fact and billing commit;
- reconciliation state for timeouts where the provider outcome is unknown.

Retries must never execute the model or debit the ledger twice. A successful
model response must not be returned before the exact usage outcome is durably
captured, unless the product contract explicitly defines a separately durable
reconciliation path.

Completion evidence:

- lost provider response, lost journal response, duplicate request, journal
  outage, partial debit, and reconciliation tests;
- catalog-version and zero-rated model tests;
- operator evidence showing journal-to-ledger reconciliation;
- removal of the `503` gate only in the same reviewed release.

### C-02 — Bound all commercial and repair sweeps

Priority: P2.

Perform a focused follow-up over usage-window close, invoice projection,
provider reconciliation, artifact repair, and route repair schedulers. Every
sweep must use a durable opaque cursor, a bounded page size/work budget, and
per-item retry state so one poisoned record cannot cause head-of-line blocking
for an entire tenant or global window.

Completion evidence:

- multi-page restart tests;
- a permanently failing middle record while later records still progress;
- bounded CPU/subrequest assertions;
- retry backoff and terminal operator-visible failure evidence.

### B-01 — Reduce Accounts/platform composition coupling

Priority: P2.

The current documented contract intentionally has the Accounts router
authenticate and own the same-origin `/api/v1/*` entry point while delegating
control operations. The remaining problem is physical concentration and large
composition modules, not evidence that a second public host or route family is
needed.

Required resolution:

- keep the public origin and `/api/v1/*` contract stable;
- keep Accounts responsible for session/token authentication and exact
  Workspace membership;
- move domain route behavior behind small typed control-operation ports;
- make route inventory derive from one contract authority;
- split `deploy/platform/worker.ts`, Accounts control routing, Core bootstrap,
  and other god files by lifecycle/domain boundary;
- update `final-plan.md` first if the team decides that physical route
  ownership itself should change.

Completion evidence:

- route inventory and authorization parity tests before/after extraction;
- no Accounts import of Core implementation internals;
- no Cloud reach-in to OSS internals;
- unchanged public route/response compatibility.

### R-01 — Run full release and live-operator proof

Priority: P1 before release.

The final pass verified focused high-risk suites and static boundaries. It did
not run every repository's complete release suite or a live production/staging
deployment. Repository-green evidence is not live operator evidence.

After H-01:

1. Run the full Takosumi OSS, Cloud, Store, mobile, and affected application
   gates from clean commits.
2. Verify generated Worker bindings, bundle limits, release locks, pinned
   artifacts, migrations, and provider mirror behavior again.
3. Exercise staging plan/apply/cancel/restore/export and failure recovery.
4. Exercise commercial usage, Stripe webhook replay, period close, and invoice
   projection with test-mode evidence.
5. Run the completion audit with both repository and live-operator evidence.

## Last verified checkpoint

The following passed after the final focused fixes:

- Takosumi TypeScript check;
- generated Worker binding check;
- Core/lib import-boundary check;
- generalization-boundary check;
- focused Run/Restore/RunOwner/Runner/R2 tests: 83;
- platform route and Form route tests: 86;
- provider registry tests: 7;
- install selector/dashboard/reference/Capsule tests: 81;
- backup and control-authorization tests: 23;
- Takosumi Store tests: 207;
- `mobile-kit` check and tests: 190;
- `takosumi-mobile` check and tests: 19;
- Takosumi Cloud focused billing/usage/Stripe tests: 91;
- Cloud generated binding verification, platform typecheck, bundle, and dry-run;
- `git diff --check` in all eleven affected repositories.

These results describe this working-tree checkpoint only. Re-run them after
splitting or modifying the changes; do not treat the numbers as release
evidence.

## Recommended restart order

1. H-01: establish ownership and split the working set.
2. Re-run full repository gates to expose any integration failures hidden by
   the focused pass.
3. A-02: define and land the immutable state commit manifest.
4. A-01: move long Run execution onto durable, fenced step receipts.
5. C-01 and C-02: finish exact usage capture and bounded reconciliation.
6. B-01: perform the lower-risk physical decomposition.
7. R-01: collect staging/live operator evidence and only then consider release.

## Safety invariants while resuming

- Do not enable token-priced AI while C-01 is open.
- Do not treat R2 listing or `customMetadata` as canonical state authority.
- Do not let an expired/lost Run lease publish any externally visible result.
- Do not create a second state/output/run ledger during refactoring.
- Do not change `/api/v1` ownership semantics without updating the authority
  documents and parity tests.
- Do not deploy from the mixed, uncommitted multi-repository working set.
