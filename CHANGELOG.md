# Changelog

All notable user-visible changes to the published Takosumi packages live here.
The workspace publishes six packages independently; entries below are grouped by
package and dated by JSR publish.

Versions follow [Semantic Versioning](https://semver.org/) once each package
crosses 1.0.0. Pre-1.0 minor bumps may carry breaking changes (documented per
entry).

## Spec策定中 — Phase A–F (2026-05-19, Unreleased)

Phase A–F (= Wave-level spec re-baseline) で次の breaking change を確定:

- **Breaking — AppSpec connection edge を `publish` / `listen` に統合**: 旧
  `use:` edge は AppSpec から廃止。 component 間の接続は (1) `publish:
  [<namespacePath>]` で material を namespace registry に登録、 (2) `listen:
  { <namespacePath>: { as, prefix?, mount? } }` で他 component の material を
  env / mount として受け取る、 の 2 つに集約。 旧 `${ref:...}` /
  `${secret-ref:...}` / `${bindings.*}` / `${secrets.*}` / `${installation.*}`
  / `${artifacts.*}` / `${params.*}` placeholder interpolation は parser から
  完全削除。 "compiled manifest" / `workflowRef` 中間 entity も廃止。
- **Breaking — `kind: oidc` を takosumi-cloud に移動**: 旧 frozen 5 kind 構造を
  廃止し、 `oidc` を本 repo から削除。 Takosumi Accounts (= takosumi-cloud) が
  `operator.identity.oidc` namespace path に OIDC client material を publish
  し、 worker は `listen.operator.identity.oidc` で標準 env (`OIDC_ISSUER_URL`
  / `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` / `OIDC_REDIRECT_URIS`) を受け取る
  形に変更。 本 repo には `spec/contexts/kinds/v1/oidc.jsonld` も `oidc`
  materializer (旧 `oidc-takosumi-accounts.ts`) も無い。
- **Breaking — Component kind catalog は extensible**: 旧 "5 frozen" model を
  撤回し、 Takosumi curated は 4 kind (`worker` / `postgres` / `object-store`
  / `custom-domain`) に縮小。 新 kind は **任意 domain で JSON-LD publish +
  materializer 実装** で追加可能。 各 kind の JSON-LD document が **spec /
  publishes / listens / outputs を一体宣言** する。 旧 5 shape 名 (`worker@v1`
  / `web-service@v1` / `worker@v1` / `database-postgres@v1` 等) は AppSpec /
  docs / kernel から完全除去。
- **Breaking — Materializer = KernelPlugin | InlineMaterializer**: kind 実装は
  2 形態を受理する。 (1) `KernelPlugin` factory を返す plain array (= Vite
  plugin pattern, cloud provider package が提供する形式) と (2) `createPaaSApp
  ({ materializers: [...] })` に inline 関数を渡す形式。 plugin convention は
  実装の 1 形態に過ぎず、 inline 関数でも contract を満たせば成立する。
- **Breaking — Cloud provider plugins を別 package に分離**: AWS / GCP /
  Cloudflare / Kubernetes / Deno Deploy / Self-host の materializer 実装は
  `@takos/takosumi-{aws,gcp,cloudflare,kubernetes,deno-deploy,selfhost}-providers`
  に分離して publish される。 takosumi core (kernel / plugins / cli) は cloud
  SDK に依存しない。 operator は必要な provider package を import して
  `plugins: [...]` に attach する。 旧 `enableAws: true` /
  `createTakosumiProductionProviders(opts)` switch は撤回済。
- **Breaking — HTTP status flip**: kernel HTTP surface の status code を spec
  と整合化。 `failed_precondition` = **409** (旧 412)、 `resource_exhausted` =
  **413** (旧 429)。 client / docs / SDK は新 status に追従が必要。
- **Breaking — Idempotency-Key header 廃止**: 旧 `Idempotency-Key` HTTP header
  ベースの retry semantics を撤回。 idempotency は AppSpec digest +
  Installation/Deployment id で deterministic に成立し、 別途 header は不要。
- `KernelPlugin` plain-array attach (Wave 9 で導入) は維持。 旧
  `createAdapters()` / port-based plugin host / `KernelPluginPortKind` /
  `TakosumiKernelPluginManifest` / plugin marketplace / signed manifest fetch
  / trusted publisher key registry は kernel に持たない (= 全削除済)。
- public deploy/install contract is reset to three concepts: AppSpec
  (`.takosumi.yml`), Installation, and Deployment. The public installer HTTP
  surface is the 5 endpoint `/v1/installations*` API.
- legacy public deployment routes, including `/v1/deployments` and
  `/api/public/v1/*`, are removed from the kernel route table and OpenAPI.
- `takosumi install`, `takosumi deploy`, and `takosumi rollback` use the
  installer API with `TAKOSUMI_INSTALLER_TOKEN`. `TAKOSUMI_DEPLOY_TOKEN` remains
  scoped to artifact write routes.

## takosumi-cli

### 0.15.0 — 2026-05-06

- **Breaking**: `.takosumi/manifest.yml` (and the `.takosumi/manifest.yaml` /
  `.takosumi/manifest.json` / `manifest.yml` / `manifest.yaml` /
  `manifest.json`) auto-discovery is removed. `takosumi deploy` / `plan` /
  `destroy` / `doctor` now require an explicit manifest path passed as the
  positional `<manifest>` argument or `--manifest <path>`. `loadManifest()` /
  `resolveManifestPath()` reject when the path is missing with
  `manifest path is required; pass <manifest> or --manifest <path>.` +
  `Project-layout discovery (.takosumi/manifest.yml) is provided by` +
  `standalone installer (sibling product), not this CLI.`. The
  `DEFAULT_MANIFEST_CANDIDATES` export is removed.
- **Breaking**: `takosumi init --project` is removed. `init` now writes the
  rendered manifest to the explicit `<output>` path (or stdout when omitted) and
  never creates a `.takosumi/` directory.
- The `.takosumi/` repository convention (project layout, workflow definitions,
  git push / webhook / build pipeline, cron / hook wiring) has moved to the
  `standalone installer` sibling product, which posts generated manifests back
  to the kernel via `legacy raw deploy route`. Operators that want the old "drop
  a `.takosumi/manifest.yml` and run `takosumi deploy`" UX should adopt
  `standalone installer`.
- Published package imports now pin `@takos/takosumi-contract@^2.5.0`, matching
  the `TAKOSUMI_*` internal RPC naming policy.

### 0.14.0 — 2026-05-06

- Re-export bump tracking `takosumi-kernel@0.14.0` / `takosumi-plugins@0.12.0`.
  CLI surface unchanged; downstream manifest validation rejects
  `compute.<name>.build` and `resource.workflow@v1`.

### 0.13.0 — 2026-05-03

- **Breaking**: `expandManifestLocal()` / `takosumi deploy` /
  `takosumi
  destroy` now run `validateManifestEnvelope()` (from contract
  2.4.0) before template expansion. Manifests missing `apiVersion: "1.0"` /
  `kind: Manifest` are rejected with `manifest envelope rejected: ...`.
- `takosumi init` scaffolded manifests now emit `apiVersion: "1.0"` /
  `kind: Manifest` (was `apiVersion: takosumi.com/hosting/v1` /
  `kind: TakosDistribution`).

### 0.12.0 — 2026-05-03

- `takosumi destroy <manifest>` now works in **local mode** (in-process destroy
  via the bundled in-memory providers). Previously printed "not yet wired" and
  exited.
- `takosumi deploy <manifest>` local mode now expands `template:` field
  manifests against bundled templates (`selfhosted-single-vm`,
  `web-app-on-cloudflare`). Previously errored when manifest had no
  `resources[]`.
- New helper exports from `@takos/takosumi-cli/local-runner`:
  `expandManifestLocal()` and `destroyLocal()`.

### 0.11.0 — 2026-05-02

- `~/.takosumi/config.yml` is consulted as a last-priority default for
  `--remote` / `--token` (resolution: flag > env > config file). Override path
  via `TAKOSUMI_CONFIG_FILE`.
- New `takosumi completions <bash|zsh|fish>` subcommand via
  `@cliffy/command/completions`.
- `takosumi server --detach` prints systemd / docker / nohup templates instead
  of pretending to daemonize (Deno lacks portable detach).

### 0.10.0 — earlier

- Provider-id namespacing under `@takos/<cloud>-<service>`. Current manifests
  use namespaced ids such as `@takos/aws-fargate`; bare provider ids are not the
  current public contract.

## takosumi-runtime-agent

### 0.7.0 — 2026-05-03

- **Selfhost connectors recover state across agent restarts.**
  `DockerComposeConnector` and `LocalDockerPostgresConnector` now query
  `docker inspect <handle>` for live status and reconstruct outputs from
  `NetworkSettings.Ports` / `Config.Env`. `SystemdUnitConnector` reads the
  on-disk unit file and runs `systemctl is-active`. Earlier versions returned
  `missing` from `describe()` after any agent restart, even though containers /
  units kept running.
- `apply()` retries port allocations up to 50 times when docker reports "port is
  already allocated" / "address already in use", so a re-deploy after restart no
  longer fails on stale port collisions.
- `SystemdUnitConnector` rendered unit files now embed `# X-Takos-HostPort=<n>`
  and `# X-Takos-InternalPort=<n>` markers so `describe()` can reconstruct
  outputs from disk. Hand-written units without the markers describe with status
  only.
- Published package imports now pin `@takos/takosumi-contract@^2.5.0`, matching
  the current runtime-agent lifecycle contract.
- Connector registration now wraps lifecycle hooks with bounded retry /
  credential-refresh resilience. Transient HTTP/network errors retry with
  exponential backoff, non-transient provider errors fail fast, and operators
  can inject a credential refresh hook through
  `ConnectorBootOptions.resilience`.

### 0.6.0 — 2026-05-02

- Connector `provider` field now uses `@takos/<cloud>-<service>` namespacing.
- New `verify` action across connectors for read-only credential smoke tests.

## takosumi-kernel

### Unreleased — docs-only (trust model simplification)

- **Docs-only**: CatalogRelease trust is documented as operator-pinned sha256
  digest (`CATALOG_DIGEST`) + TLS fetch, not publisher signing. Aligns the
  kernel docs with the ecosystem-wide "TLS + digest pin + 1 signing domain
  (OIDC)" model (ecosystem Wave 11/12). No kernel runtime code change in this
  changelog entry; the kernel itself still has no OIDC ID token signing and no
  launch token signing — both belong to Takosumi Accounts. Reference:
  [Supply Chain Trust](./docs/reference/supply-chain-trust.md),
  [paas-provider-architecture § Supply chain trust](./docs/reference/architecture/paas-provider-architecture.md#supply-chain-trust),
  [catalog-release-descriptor-model](./docs/reference/architecture/catalog-release-descriptor-model.md).

### 0.15.0 — 2026-05-07

- Public `legacy raw deploy route` now enforces manifest-declared
  `spec.artifact.size` before plan / apply side effects. Sizes must be
  non-negative integer byte counts and cannot exceed the registered
  artifact-kind `maxSize` (falling back to the kernel artifact cap for unknown
  kinds); oversized artifacts return 413 `resource_exhausted`.
- `UsageProjectionService` now supports per-Space CPU / storage / bandwidth
  quota tiers through `LocalUsageQuotaPolicy`, including `requireWithinQuota()`
  for fail-closed usage recording.
- `SlaBreachDetectionService` now evaluates operator-supplied thresholds,
  persists hysteresis state, and publishes `sla-warning-raised` /
  `sla-breach-detected` / `sla-recovering` / `sla-recovered` events to audit,
  outbox, and the operator notification signal path.
- Public deploy and deployment rollback paths now record
  `takosumi_deploy_operation_count`, `takosumi_apply_duration_seconds`, and
  `takosumi_rollback_duration_seconds` metrics for Prometheus / OTLP export. A
  deploy overview Grafana dashboard is included under
  `deploy/observability/grafana/`.
- Kernel API responses now propagate `x-request-id` / `x-correlation-id`, emit
  JSON HTTP request logs in staging / production, and attach request correlation
  ids to public deploy metrics.
- Kernel API request correlation now propagates W3C `traceparent`, records HTTP
  server spans in the configured `ObservabilitySink`, exports spans through
  native OTLP/HTTP JSON `/v1/traces`, and adds `trace_id` / `span_id` to JSON
  request logs.
- WAL-backed `applyV2` / `destroyV2` provider calls now record
  `takosumi.provider.apply` / `takosumi.provider.destroy` spans with operation
  id, operation kind, WAL stage, idempotency key, provider id, resource name,
  request id, and correlation id attributes.
- Runtime-agent RPC calls now propagate `traceparent` / request correlation
  headers and record client spans, runtime-agent work execution records
  `takosumi.runtime_agent.execute` spans, and the generic
  `TakosumiInternalClient` records `takosumi.internal_rpc.client` spans.
- Added the Observability Stack ownership reference, including managed vs
  self-hosted responsibilities, default SLI / SLO targets, and alert policy
  ownership.

### 0.14.0 — 2026-05-06

- **Breaking**: kernel-side workflow primitive reservation withdrawn. The
  reserved `triggers` / `execute-step-operation` / `declarable-hooks` reference
  pages were removed; workflow / trigger / hook semantics are owned by
  `standalone installer` (upstream sibling product). See
  [Workflow Placement Rationale](./docs/reference/architecture/workflow-extension-design.md).
- **Breaking**: `compute.<name>.build` field removed from the manifest schema.
  Manifests carrying `build` / `build.fromWorkflow` are now rejected with a
  validation error. `compute` requires explicit `type` for non-container
  runtimes plus an `image:` URI with a port.
- **Breaking**: `resource.workflow@v1` shape registration removed from the
  bundled shape catalog. Manifests that declare a `workflow@v1` resource are
  rejected.
- `inferComputeType` no longer derives a runtime from the (removed) `build`
  field; explicit `type` is required.
- Published package imports now pin `@takos/takosumi-contract@^2.5.0`, matching
  the `TAKOSUMI_INTERNAL_PATHS` / internal RPC exports used by the kernel.
- The Kernel HTTP API reference now separates implemented routes from
  workflow-shaped concerns owned by `standalone installer`, and the docs include
  a public spec source map with drift tests.

### 0.13.0 — 2026-05-03

- **Breaking**: `legacy raw deploy route` (deploy public route) now invokes
  `validateManifestEnvelope()` from contract 2.4.0 — manifests missing
  `apiVersion: "1.0"` / `kind: Manifest` are rejected with HTTP 400 and a
  path-prefixed error.
- **Breaking**: bare provider ids (`aws-fargate`, `cloud-run`, `local-docker`,
  etc.) are now **rejected** at the resource resolver with a
  namespaced-replacement suggestion. Current manifests must write every
  `provider:` field as `@takos/<cloud>-<service>`.

### 0.12.0 — 2026-05-02

- Deployment record store backend logged at boot (`SQL (TAKOSUMI_DATABASE_URL)`
  vs `in-memory`) so operators see when persistence falls back.
- Dev-mode in-memory adapter fallback warning skipped when caller passes no
  adapters at all (test boots), to keep test output clean.

### 0.11.0 — 2026-05-02

- Bootstrap split into `bootstrap/registry_setup`, `worker_daemon`, `readiness`,
  `deploy_record_store`, `agent_detection` for readability. Public API
  (`createPaaSApp`) unchanged.
- `registerProvider` warns on collision unless `allowOverride: true`.
- Dev-mode in-memory adapter fallbacks logged so operators see silent
  persistence loss before going to prod.

## takosumi-plugins

### 0.12.0 — 2026-05-06

- **Breaking**: `resource.workflow@v1` shape registration removed from the
  bundled shape catalog. Workflow / cron / hook resources are now plugin shapes
  provided by upstream products such as `standalone installer`.

### 0.11.0 — 2026-05-03

- Bundled provider catalog (`shape-providers/factories.ts`) now uses
  `satisfies readonly XxxCapability[]` on each entry's `capabilities` array.
  Capability typos in the catalog are caught at compile time (TypeScript
  `TS2820` "Did you mean ..." suggestion). The runtime shape remains a
  `readonly string[]` to match the provider contract.

### 0.10.0 — 2026-05-02

- 21 production providers under `@takos/<cloud>-<service>` namespacing. Current
  manifests use namespaced provider ids.
- Bundled artifact-kind registry: `oci-image`, `js-bundle`, `lambda-zip`,
  `static-bundle`, `wasm`. `GET /v1/artifacts/kinds` lists registered kinds; CLI
  `takosumi artifact kinds` queries it.

## takosumi-contract

### 2.5.0 — 2026-05-03

- `ProviderPlugin` gains an optional `Capability extends string = string` type
  parameter so plugins can pin `capabilities: readonly Capability[]` to their
  shape's published capability union (e.g. `WebServiceCapability`). Untyped
  plugins keep working — `Capability` defaults to `string`.

### 2.4.0 — 2026-05-03

- **Breaking**: new `Manifest` envelope type with required `apiVersion: "1.0"`
  and `kind: "Manifest"` fields. Exports `MANIFEST_API_VERSION`,
  `MANIFEST_KIND`, `validateManifestEnvelope()`, `ManifestEnvelopeIssue`,
  `ManifestMetadata`. Operators must prepend these two fields to every manifest
  YAML / JSON.

### 2.3.0 — 2026-05-02

- Artifact-kind registry exports (`registerArtifactKind`, `listArtifactKinds`,
  `getArtifactKind`).
- `registerProvider` collision warning + `allowOverride` opt-out.

## takosumi (umbrella)

### 0.17.0 — 2026-05-06

- Re-export bump tracking `takosumi-cli@0.15.0`.
- **Breaking** (downstream): the bundled CLI no longer auto-discovers
  `.takosumi/manifest.yml` / `manifest.yml`; pass the manifest path explicitly
  to every `deploy` / `plan` / `destroy` / `doctor` invocation.
  `takosumi init --project` is gone. The `.takosumi/` project-layout convention
  has moved to the `standalone installer` sibling product.

### 0.16.0 — 2026-05-06

- Re-export bump tracking `takosumi-kernel@0.14.0`, `takosumi-plugins@0.12.0`,
  and `takosumi-cli@0.14.0`.
- **Breaking** (downstream): kernel workflow primitive reservation withdrawn,
  `compute.<name>.build` removed from the manifest schema, and
  `resource.workflow@v1` shape removed from the bundled catalog. The `triggers`
  / `execute-step-operation` / `declarable-hooks` reference pages were deleted;
  consult
  [Workflow Placement Rationale](./docs/reference/architecture/workflow-extension-design.md)
  for the new ownership boundary.

### 0.15.0 — 2026-05-03

- Re-export bump tracking `takosumi-contract@2.5.0` and
  `takosumi-plugins@0.11.0`. Capability typos in bundled providers are caught at
  compile time.

### 0.14.0 — 2026-05-03

- Re-export bump tracking `takosumi-contract@2.4.0`, `takosumi-kernel@0.13.0`,
  `takosumi-cli@0.13.0`. Manifest envelope (`apiVersion: "1.0"` /
  `kind: Manifest`) is now required across the board.

### 0.13.0 — 2026-05-03

- Re-export bump tracking `takosumi-cli@0.12.0` and
  `takosumi-runtime-agent@0.7.0`.

### 0.12.0 — 2026-05-02

- Re-export bump tracking `takosumi-kernel@0.12.0` and `takosumi-cli@0.11.0`.
