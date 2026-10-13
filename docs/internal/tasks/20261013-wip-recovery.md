# TASK-0031 WIP recovery on current main

- Owner: Takosumi only, `chore/takosumi-tanto-wipaudit-20261013`.
- Source: `origin/wip/main-dirty-20260901` (`5e401695a`), compared from its
  merge-base `ed4f309c4`; predecessor audit dated 2026-10-13.
- Initial current main: `3f88f9150` (includes self-host procedure PR #418).
- Method: recover compatible behavior on current source, not the old complete
  files. The snapshot predates current Run authority, private-file custody,
  deadline, Interface materialization, and schema contracts.
- Authorized publication: ordinary feature push, ready PR, local `bun run check`
  plus focused tests, squash merge through GitHub, then staging-only publication
  through the documented owner entrypoint and staging HTTP checks.
- Prohibited: direct main push, force-push, production operations, image/registry
  publication, destructive data/credential operations, changes to the original
  dirty checkout or other worktrees. No persisted schema change is recovered.

## Recovered behavior

| Audit area | Recovery |
| --- | --- |
| B-W1 diagnostics | Expose repair failure counts and bounded outcome metrics; phase-only warnings for source poll, stale auto-plan and drift failures |
| B-W2 metrics | Remove Workspace/Capsule identity labels at emission and scrape rendering, remove Grafana tenant selectors, record first-admission queue latency once after a won running claim |
| B-W4 SSE | Recheck live Workspace authorization periodically; bound lifetime, abort/cancel and buffering; credential revalidation uses the canonical Accounts auth gate |
| B-W4/E read efficiency | Keyset Run pages, batch Plan lookup for Run projection and aggregate Capsule usage in all three store implementations; preserve legacy list limits/order and add an optional next cursor |
| C-W1 self-host operations | Restore Japanese/English operations pages using the actual #418 procedures and storage/runner boundaries |
| C-W1 runtime store | Advertise an optional public store URL through discovery and select it in the dashboard without rebuilding; reject credential/query/fragment URLs |
| D / 9 / 11 | Recover repository-owned Git-install setup/presentation and compatible dashboard wiring fixes; do not duplicate draft PR #420 |
| 10 / 11 | Repair app-handoff documentation references and recover the focused unused-export ratchet intent |

## Disposition of the remaining audit items

These are not patches valid against the current main contract. Their desired
future behavior requires a new design or belongs to an existing owner PR.

| Item | Why the snapshot is not recovered |
| --- | --- |
| A0-A2 uninstall, scheduler, scoped export, destroy UI and file backup store | Existing PR #422 implements a different revision/authority-fenced design. The WIP changes plain DELETE semantics, lacks atomic intent creation, and mixes other Capsule records into export |
| A3 automatic failed-install destroy / A4 automatic re-plan | Introduces unattended mutation/system approval and new persistent state; no current compatible authority contract or migration |
| Recovery keyset/cursor tables and billing-pending physical column | WIP migration numbers collide; SQL trusts stale heartbeat columns; billing backfill differs from the current latest-marker rule. Current retirement/materialization paths cannot be replaced |
| Generic work-item queue | Only WIP deferred-destroy handler uses it; PR #422 uses a different scheduler, so this queue has no current consumer |
| Sweep rotation and backlog gauges | Depends on the invalid cursor/queue schema patch. A new current-schema recovery design is separate work |
| Metric aggregates and alerts | WIP has D1-only durability, migration collision and a literal NUL; alerts reference gauges not present in main. Do not advertise unavailable alerts |
| Audit verification checkpoint | Stops rechecking historical records and weakens full-chain integrity |
| Per-attempt billing key, queue-age budget, Workspace slots | WIP counts unrelated retry markers and can duplicate old/new billing keys; its semantics conflict with current Run deadline/custody/lease contracts |
| Runner max-concurrency, shared-token gate and Compose runner | Needs a runner release/composition change. WIP token comparison accepts differing suffixes beyond 64 bytes; image/registry publication is forbidden in this task |
| Coordination sharding and running cancellation | Regresses current joinable leases, mutation receipts and running-cancel refusal; may release custody while provider mutation is still running |
| Profile timeout, keepalive, platform deploy script, old Idempotency coordinator | Superseded by current deadline, per-dispatch Container lifecycle, staging owner surfaces and plan-record idempotency |
| API 404 collapse, token-bucket policy, expanded idempotency | Changes current authorization/error/plan contracts. WIP mapping deletes 405 and depends on removed coordinator; not a compatible transplant |
| Shared SSE fan-out | Retained bounded per-viewer loop so authorization and cancellation stay per request; a cache/subscriber redesign is not needed for revocation repair |
| Runner apply progress | Changes the runner-to-owner protocol and image; cannot be activated by this code-only staging release |
| Runner stderr disclosure / stable-tag default | Conflicts with current structured error projection / direct-Git HEAD policy |
| OIDC authorization-code redemption rewrite | Outside TASK-0031, colliding Accounts migration 037 and independent identity lifecycle change |
| WIP internal architecture/spec rewrites | Predates current OSS/Host ownership; canonical current docs remain authoritative |
| Fixture DB reset helper | Destructive tooling with no required consumer in this recovery; cannot enter the read-only gate |
| Old dashboard browser port helper | Superseded by #418 portable-origin support |
| Store-repository CSS and dirty store install fixes | Different owning repository, outside this branch and explicitly protected dirty work |

## Additional small-hunk disposition

- Narrow `InterfaceOutputStore` to the three read methods the current resolver uses.
- Interface service predicate refactoring already exists in main. WIP Resource-output
  predicates and portable declaration materialization restore deleted Host flows.
- The current OpenTofu graph compiler deliberately refuses unsupported JSON
  semantics. Do not revive the WIP heuristic JSON-to-HCL renderer.
- Current environment binding resolution checks exact module-local/child-alias
  identity and duplicate conflicts; WIP same-source selection regresses it.
- PostgreSQL/D1 SQL-result adapters recognize different dialects; the WIP shared
  `pg_result` extraction is not a compatible common adapter.

## Verification and staging evidence

Focused commands/results, full local gate, independent review, PR/merge identity
and staging outcome are recorded with the PR. The staging config is held outside
Git and its values are never included here. Read-only initial staging status
refused with `platform_worker_release_container_not_ready`; publication must use
the owner command and stop on any failed/incomplete result without blind retry.
