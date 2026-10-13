# Hosted docs in platform release assets

- Owner/repository: Takosumi only; branch
  `fix/stagingsync-hosted-docs-20261013`.
- Problem: both platform release lanes rebuild the dashboard with Vite, which
  clears the output directory, but omit the hosted-docs overlay. The local
  dashboard gate builds docs separately, so it can pass while publication
  contains only the SPA shell at `/docs/`.
- Scope: build hosted docs after each release dashboard build and seal the
  complete asset tree. Cover the full deterministic plan and routine code lane.
- Verification: a regression must fail before the fix and pass afterward;
  complete `env -u NODE_ENV bun run check`; inspect the official plan's sealed
  `docs/index.html` and browser-check the deployed `/docs/` route.
- Publication: ordinary fix-branch PR and squash merge, then one serialized
  staging official plan/execute from a clean materialization of latest main.
- Authority: staging only. Existing immutable runner image must have verified
  provenance from a main ancestor. No runner/registry publication, database
  migration, credential change, production config, or production operation.
- Reversal: owner platform restore uses the sealed predecessor Version/image,
  subject to compatibility with the current schema. No automatic rollback.
- Failure: stop after the first failed publication; preserve the owner
  checkpoint and diagnostics and distinguish refusal from incomplete upload.

Operator configuration, release evidence, and test screenshots stay outside
the repository. This task does not qualify optional private Run-file execution
on a runner image predating that capability.
