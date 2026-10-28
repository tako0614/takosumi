# Install environment preservation and review follow-ups

- Repository / owner: Takosumi only; branch
  `fix/install-environment-preserve-20261028`, based on `70085a3f6`.
- Scope: retain an existing install attempt's Capsule environment when the
  dashboard recreates it after edits, failure, expiration, or reopening. New
  installs that omit environment keep the server default. No selector, server
  authority, guard, persisted schema, or migration changes.
- Finding: TASK-0117 UX dogfooding identified the lost environment. Re-derive
  the value-free proposal against current main; do not retry live attempts.
- Review follow-ups: document `dependency_retired` scheduled-uninstall blocking,
  RunGroup failures, and exact removed backup section names; make
  `run_group.created` activity include refused Capsule failures like graph JSON.
- Validation: demonstrate regression failures before the source fixes, run
  focused pure-state/controller/activity tests, update portable browser request
  expectations, then run the complete `bun run check` gate.
- Delivery: one PR crediting TASK-0117, with a report at
  `/root/dev/tmp/tk0118/env-preserve-report.md`. No live retries or deploy.
- Reversal: revert the code commit. No durable data changes are performed.
