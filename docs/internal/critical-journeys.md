# Local critical journeys

Takosumi has a small read-only feedback lane for the install/apply/readback/
destroy contracts used by the current GA loop:

```bash
bun run test:critical-journeys
```

The entrypoint is an inventory and runner. It reuses the existing portable Bun
tests; it does not implement another source, Run, Output, Interface, or
dashboard flow. It runs five groups:

| Group | Coverage | Negative control |
| --- | --- | --- |
| `source-install` | tracked Git tree scan, module/provider discovery, compatibility preparation, and source snapshots | ambiguous topology, remote modules, scan limits, missing auth, scope, and URL rejection |
| `plan-apply-approval` | destructive-plan approval, create-once apply, and stale propagation | unapproved plans and stale recovery checkpoints |
| `output-interface-readback` | public Output projection, Interface discovery, lifecycle readiness, and redaction | dangling/mismatched Output, cross-Workspace access, and secret-like values |
| `destroy-recreate-idempotency` | portable host retry/replay, interrupted lifecycle mutations, and Resource incarnation fencing | tenant/request substitution, corrupt or non-exact replays, and stale delete conflicts |
| `dashboard-install` | `/install` and `/new` Git URL/module-choice behavior plus the browser harness policy | non-ready compatibility, unsafe browser state, and required-route failures |

Every group names at least one negative control. The inventory validator
requires each group to contain existing `*_test.ts` files and only constructs
`bun test --timeout ...` commands rooted in the repository's portable test
trees. It accepts no mode or endpoint argument, so it cannot invoke a live,
staging, production, deploy, or smoke operation. The browser harness group is
the local policy/route harness; the Playwright portable browser suite remains
part of `bun run check:dashboard-browser` because it requires the built
dashboard artifact.

This lane is for failure locality and should stay within the T0 target of a
warm local p95 under 60 seconds. It is not a release or readiness gate. Always
run the complete owner gate for the exact candidate tree before handoff:

```bash
bun run check
```

Live staging, production, billing, recovery, and disaster-recovery evidence
remain intentionally outside this command.
