# Dashboard Git plan deadline test

- Owner/repository: Takosumi; issue #445; branch
  `fix/dashboard-plan-deadline-test-20261014`, based on latest origin/main
  `d527e8c22e0cf463313df21233de8d028541158f`.
- Cause: the test races a real 25 ms deadline against a real 100 ms watchdog
  under suite load. Source already races the complete coordinator, including
  the reconciliation pause, against one deadline and checks abort after the
  pause. Independent source review found no implementation defect.
- Scope: only tests. Fake timers verify pending at 24 ms and exact 504 timeout
  at 25 ms for install/revision create, reconcile and response bodies. A
  controlled pending cadence proves timeout bounds the pause; releasing it
  after timeout must not issue further commands. Also verify deadline cleanup
  after successful completion and same-key retry. Restore timers and fetch
  after every case. Do not relax assertions or extend the watchdog.
- Verification: negative mutation checks, repeated independent parallel test
  processes, and same-head complete canonical gate with `NODE_ENV` and
  `TAKOSUMI_ENVIRONMENT` unset. Reserve separate browser ports.
- Release order: ready PR and QA request; exact-head quality/release approval,
  then normal head-matched merge without force-push. Wait for ongoing #441
  stagingsync if any. Under the shared exclusive staging lock, inspect latest
  main and deployed provenance; use the official staging lane at most once if
  needed. Confirm staging target/config before each lane command. Re-run all
  canonical phases with the portable environment unset; record Worker Version,
  main SHA and pass/fail in private result.json and the PR comment.
- Boundaries: no production, existing Workspace/data, staging secret changes,
  or takos1 interactions. Private logs and operational records remain outside
  the repository. Release the lock in all outcomes. Four-hour maximum from
  2026-10-13 23:59:58 UTC; no QA approval leaves the PR ready and unmerged.
- Reversal/failure: this patch changes no product bytes, schema or data. Stop
  on publication failure, preserve raw diagnostics and target-touched status,
  and never blindly retry. Any validation failure remains a failure, is
  diagnosed, and requires a reviewed fix before further publication.
