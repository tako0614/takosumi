# PR #418 self-host QA fixes

- Owner/repository: Takosumi only; branch `feature/takosumi-tanto-selfhost-quickstart-20261013`.
- Scope: restrict Accounts environment forwarding and runtime image COPY;
  document the existing forward-only migration timing in the PR and changelog.
- Excluded: runner discovery (`/.well-known`, selfhost2), deployment, production
  DB changes, other worktrees/terminals, main pushes and force pushes.
- Verification: focused self-host contracts; isolated local Docker image build,
  disposable PostgreSQL migrations and HTTP probes; complete `bun run check`.
- Publication: ordinary feature-branch push; update PR #418 with local commands
  and results. User authorized squash merge only after the full local gate passes.
- Local gate finding: dashboard E2E initially refused occupied port 4179 after
  the test/build phases passed. Its portable fixture, browser URL and traffic
  assertions now share the existing `TAKOSUMI_E2E_PORT` setting; the full gate is
  rerun with dashboard/docs ports 24179/24180, without touching other processes.
- Focused contracts: 8 pass / 0 fail (two QA checks proved red before fixes).
  Entire node-postgres suite: 83 pass / 0 fail.
- Docker build and isolated image smoke: passed; HTTP, runtime env isolation,
  explicit upstream-secret override, CLI imports, migration 104/44 then 0/0.
  Disposable local containers, network and DB volume removed after the proof.
- Independent review: Compose/Docker/docs and E2E port diff have no blockers.
- Complete local gate: `env -u NODE_ENV TAKOSUMI_E2E_PORT=24179
  TAKOSUMI_DOCS_BROWSER_PORT=24180 bun run check` exited 0; all 19 phases
  completed in 347.05s. Portable tests: 5586 pass / 5 existing skips / 0 fail;
  dashboard portable browser: 33 pass / 2 live-profile skips; docs browser: 3 pass.
- Status: implementation, independent review and local verification complete;
  ready for the authorized feature push, PR evidence update and squash merge.
