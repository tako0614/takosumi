# Changelog

All notable user-visible changes to the published Takosumi packages live
here. The workspace publishes six packages independently; entries below
are grouped by package and dated by JSR publish.

Versions follow [Semantic Versioning](https://semver.org/) once each
package crosses 1.0.0. Pre-1.0 minor bumps may carry breaking changes
(documented per entry).

## takosumi-cli

### 0.12.0 — 2026-05-03

- `takosumi destroy <manifest>` now works in **local mode** (in-process
  destroy via the bundled in-memory providers). Previously printed
  "not yet wired" and exited.
- `takosumi deploy <manifest>` local mode now expands `template:` field
  manifests against bundled templates (`selfhosted-single-vm`,
  `web-app-on-cloudflare`). Previously errored when manifest had no
  `resources[]`.
- New helper exports from `@takos/takosumi-cli/local-runner`:
  `expandManifestLocal()` and `destroyLocal()`.

### 0.11.0 — 2026-05-02

- `~/.takosumi/config.yml` is consulted as a last-priority default for
  `--remote` / `--token` (resolution: flag > env > config file >
  deprecated env alias). Override path via `TAKOSUMI_CONFIG_FILE`.
- New `takosumi completions <bash|zsh|fish>` subcommand via
  `@cliffy/command/completions`.
- `takosumi server --detach` prints systemd / docker / nohup templates
  instead of pretending to daemonize (Deno lacks portable detach).

### 0.10.0 — earlier

- Provider-id namespacing under `@takos/<cloud>-<service>`. Bare ids
  (`aws-fargate` etc.) accepted with deprecation warning, slated for
  removal.

## takosumi-runtime-agent

### 0.7.0 — 2026-05-03

- **Selfhost connectors recover state across agent restarts.**
  `DockerComposeConnector` and `LocalDockerPostgresConnector` now query
  `docker inspect <handle>` for live status and reconstruct outputs
  from `NetworkSettings.Ports` / `Config.Env`. `SystemdUnitConnector`
  reads the on-disk unit file and runs `systemctl is-active`. Earlier
  versions returned `missing` from `describe()` after any agent
  restart, even though containers / units kept running.
- `apply()` retries port allocations up to 50 times when docker reports
  "port is already allocated" / "address already in use", so a re-deploy
  after restart no longer fails on stale port collisions.
- `SystemdUnitConnector` rendered unit files now embed
  `# X-Takos-HostPort=<n>` and `# X-Takos-InternalPort=<n>` markers so
  `describe()` can reconstruct outputs from disk. Hand-written units
  without the markers describe with status only.

### 0.6.0 — 2026-05-02

- Connector `provider` field migrated to `@takos/<cloud>-<service>`
  namespacing.
- New `verify` action across connectors for read-only credential smoke
  tests.

## takosumi-kernel

### 0.12.0 — 2026-05-02

- Deployment record store backend logged at boot
  (`SQL (TAKOSUMI_DATABASE_URL)` vs `in-memory`) so operators see when
  persistence falls back.
- Dev-mode in-memory adapter fallback warning skipped when caller
  passes no adapters at all (test boots), to keep test output clean.

### 0.11.0 — 2026-05-02

- Bootstrap split into `bootstrap/registry_setup`, `worker_daemon`,
  `readiness`, `deploy_record_store`, `agent_detection` for
  readability. Public API (`createPaaSApp`) unchanged.
- `registerProvider` warns on collision unless `allowOverride: true`.
- Dev-mode in-memory adapter fallbacks logged so operators see
  silent persistence loss before going to prod.

## takosumi-plugins

### 0.10.0 — 2026-05-02

- 21 production providers under `@takos/<cloud>-<service>` namespacing
  (was bare ids). Resolves bare ids with a deprecation warning.
- Bundled artifact-kind registry: `oci-image`, `js-bundle`, `lambda-zip`,
  `static-bundle`, `wasm`. `GET /v1/artifacts/kinds` lists registered
  kinds; CLI `takosumi artifact kinds` queries it.

## takosumi-contract

### 2.3.0 — 2026-05-02

- Artifact-kind registry exports
  (`registerArtifactKind`, `listArtifactKinds`, `getArtifactKind`).
- `registerProvider` collision warning + `allowOverride` opt-out.

## takosumi (umbrella)

### 0.13.0 — 2026-05-03

- Re-export bump tracking `takosumi-cli@0.12.0` and
  `takosumi-runtime-agent@0.7.0`.

### 0.12.0 — 2026-05-02

- Re-export bump tracking `takosumi-kernel@0.12.0` and
  `takosumi-cli@0.11.0`.
