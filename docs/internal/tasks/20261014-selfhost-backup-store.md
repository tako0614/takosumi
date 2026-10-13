# TASK-0031: self-host pre-destroy export and uninstall UI

- Worktree: `takosumi-backupstore-20261014`; branch:
  `fix/takosumi-selfhost-backup-store-20261014`.
- Baseline: `1b08419c1b074f2c6b5b75a49b57cd7f0b8396ad`, including merged #422.
- Scope: Takosumi only. The WIP recovery report's row 4 is a specification
  reference; no WIP files are copied. Other repositories/worktrees are untouched.
- Authority: implement and test the self-host adapter, push normally, open a
  ready PR, and request quality/release QA. Merge only after GitHub CI is green
  and the quality/release owner explicitly approves. No staging/production
  deployment, source-pin changes, main push, force push, or credential/data
  destruction is authorized. Staging publication belongs to stagingsync.

## Persistence and security boundary

- A configured `TAKOSUMI_BACKUP_ARTIFACTS_DIR` enables the existing backup lane
  in the Bun/PostgreSQL composer. Compose sets a path on `takosumi-runtime`;
  the image seeds that mount with bun-owned private directories. Direct/custom
  compositions must supply a durable owner-only mount explicitly.
- Control, state and service-data payloads use the existing `StateArtifactCrypto`
  seal. The public artifact manifest uses `putPlain` and still has mode 0600.
  No credentials or private keys are stored in Git or output projections.
- Validated references map to flat SHA-256 filenames. Absolute/traversal keys,
  symlinked roots/ancestors, unsafe permissions, symlink/hardlink artifacts and
  occupied references are refused. Files/directories require 0600/0700 and the
  process owner. Publication fsyncs bytes before atomic no-replace linking and
  fsyncs the directory before returning pointer metadata.
- The host supplies `backupStateObjectReader` from its runner's exact sealed
  state store. No state layout or provider backend is inferred. A missing
  reader/object keeps the existing honest export failure semantics.
- #422 timing is retained: owners can export during grace, and the finalizer
  exports once after the deadline before its ordinary teardown pipeline. No
  uninstall admission, grace-period or teardown-authority contract is changed.
- There is no database schema migration. Existing backup references are opaque
  pointers; the new adapter changes only an explicitly configured local host.

## Validation and handoff

- Focused coverage: sealed bytes and persisted readback, public sidecars,
  pointer digest/size, permissions, traversal/link defense, immutable concurrent
  publication, composed self-host grace and finalizer exports, launcher hiding
  and dependency warnings.
- Required complete gate:
  `env -u NODE_ENV TAKOSUMI_E2E_PORT=26421 TAKOSUMI_DOCS_BROWSER_PORT=26422 bun run check`.
- The ready PR records command outcomes and the exact tested commit. Independent
  source review covers the filesystem and composition boundary before handoff.
- Independent source review: no material blocker in the adapter/composer/image
  mount; unit tests and resolved Compose settings confirmed. This internal review
  is separate from the required quality/release owner's explicit approval.
  The filesystem parent is operator-trusted: concurrent replacement by an actor
  with access to that parent is outside this private mount boundary. Compose
  seeds it as bun-owned 0700. Stateful custom hosts still require the explicit
  reader; this is not a guarantee that arbitrary runner stores can be exported.
- This session publishes no runtime target. Operators must preserve both DB
  schemas, the runtime volume, runner state/artifact stores and keys separately;
  a partial control export has no complete restore importer. Reverting the image
  does not delete exports; keep the volume for forward repair or manual inspection.
