# Changelog

All notable user-visible changes to the published Takosumi packages live here. The workspace publishes 13 packages independently; entries below are grouped by package and dated by JSR publish.

Versions follow [Semantic Versioning](https://semver.org/) once each package crosses 1.0.0. Pre-1.0 minor bumps may carry breaking changes (documented per entry).

## Spec策定中 — Wave N-A component kind externalization (2026-05-21, Unreleased)

Wave J → K → L の minimization sequence の自然な終点として、 takosumi kernel を **pure contract executor** に近づけるため、component kind list を contract から外した。

- **Breaking — component kind resolution is operator-owned**: `@takos/takosumi-contract` から `COMPONENT_KINDS` / `KIND_URI_BY_NAME` / `KIND_NAME_BY_URI` / `TAKOSUMI_KIND_URI_BASE` / `resolveKindUri()` / `kindNameFromUri()` / `isComponentKind()` / `normalizeComponentKind()` を削除。 `Component.kind` は opaque non-empty string。
- **Parser**: `.takosumi.yml` parser は kind を catalog validate せず、authoring form を保持する。empty / non-string kind は従来通り reject。
- **Kernel plugin lookup**: `createPaaSApp({ kindAliases, plugins })` で operator-owned alias map を受け取り、short alias を provider lookup 前に URI 解決する。URI はそのまま使われ、未解決 alias は provider operation 前に lookup miss として fail-closed。
- **Reference descriptors**: takosumi.com reference descriptors は `packages/plugins/spec/kinds/v1/*.jsonld` と `packages/plugins/src/kinds/` に移動 / rescope。`https://takosumi.com/kinds/v1/*` は external reference descriptor examples。 `@takos/takosumi-plugins/kinds` は `TAKOSUMI_REFERENCE_KIND_URIS` / `TAKOSUMI_REFERENCE_KIND_ALIASES` / `TAKOSUMI_REFERENCE_KINDS` を export。
- **Provider packages**: 6 provider package は contract の removed kind helpers ではなく `@takos/takosumi-plugins/kinds` の reference URI helper を参照する。
- **Package boundary**: `@takos/takosumi-contract@2.6.0` keeps the root export focused on AppSpec / Installer API DTOs and exposes reference implementation helpers through explicit subpaths. The temporary compatibility umbrella is `@takos/takosumi-contract/reference/compat`.
- **JSR publish set**: release dry-run now covers all 13 packages, including `@takos/takosumi-installer`. `@takos/takosumi-plugins` no longer publishes cloud provider subpaths; provider factories live in the six provider packages.
- **Docs / RFC**: AppSpec、provider、reference descriptors、BuildSpec、RFC 0001、 README / CONVENTIONS / AGENTS を更新し、official kind = 0 と external reference descriptors の境界を明記。

Remaining follow-up:

- BuildSpec / Linux container build service の実装。
- operator DataAsset extension の実装面整理。

詳細 design は [RFC 0001](docs/rfc/0001-kernel-kind-agnostic.md) を参照。

## Spec策定中 — Wave M-G takosumi.com 単一 Pages project 統合 (2026-05-20, Unreleased)

Wave M-G で takosumi の public deploy 構造を `docs.takosumi.com` subdomain + apex 2-project 構成から **takosumi.com 単一 Pages project** に統合した (user mandate: 「メインのページに /docs いったら表示みたいな感じじゃなかったっけ」 + 「docs.takosumi.test は廃止」 + 「実際にデプロイするのと同じ方式にしてね」)。 Wave M-F (= 2026-05-20、 hostname 構造訂正、 user 確認待ち defer されていた takosumi/docs/ deploy 先決定) の延長であり、 production deploy 構造と local-substrate mirror が同形になる architectural restructure。 spec contract / JSR package surface には一切触らない (docs / deploy / wrangler / workflow 層のみ):

- **Architectural restructure — `takosumi/website/` を Pages 正本に**: `takosumi/website/` (= Solid Start landing) を Cloudflare Pages project `takosumi-website` の build root に昇格。 `takosumi/site/` (= minimal HTML landing + `takosumi-site` Pages project) と `takosumi/docs/` の standalone Pages config (= `takosumi-docs` project + `docs.takosumi.com` subdomain) は superseded。 build artifact は **1 つの `website/.output/public/`** に統合された:
  - `/` → Solid Start landing (= `vinxi build` 出力をそのまま root に配置)
  - `/docs/*` → VitePress build (= `docs/.vitepress/dist/` を overlay。既存 `docs/.vitepress/config.ts` の `base: "/docs/"` 設定が production / local の両 mount で kept)
  - `/contexts/*` → JSON-LD vocab (= `spec/contexts/` を overlay。 wire URL `https://takosumi.com/contexts/v1.jsonld` / related context documents が resolve。component kind descriptors は後続 Wave N-A で `packages/plugins/spec/kinds/` に移動)
- **Files**:
  - **新規**: `website/build.sh` (= 3-step merge build、 fail-closed)、 `website/wrangler.toml` (= `name = takosumi-website`, `pages_build_output_dir = ./.output/public`)、 `.github/workflows/
    website-deploy.yml` (= 旧 `docs-deploy.yml` を rename + 全 path trigger 拡張 + merged build step 化)。
  - **削除**: `takosumi/site/` (= `index.html`, `build.sh`, `README.md`, `wrangler.toml`, tracked `dist/*` artifacts)、 `takosumi/docs/wrangler.toml` (= `takosumi-docs` Pages project config)、 `.github/workflows/docs-deploy.yml` (= renamed to `website-deploy.yml`)。
  - **更新**: `deno.json` (= `site:*` 3 task → `website:*` 3 task に rename、 `spec:build` の copy target `site/dist/contexts/` → `website/.output/
    public/contexts/` に追従、 lint/fmt exclude を `site/dist` → `website/
    .output` + `website/.vinxi` に置換、 `docs:deploy` task は website に統合済のため削除)、 `DEPLOY.md` (= 3-section → 2-section に集約 + operator-side cleanup section 新規 + smoke / rollback narrative 更新)、 `README.md` (= docs URL `docs.takosumi.com/` → `takosumi.com/docs/`、 "Docs site (VitePress)" section を website-merged narrative に rewrite)、 `website/README.md` (= 新責務 = 単一 Pages artifact 説明)、 `docs/reference/public-spec-source-map.md` (= inline URL 5 hit を `docs.takosumi.com` → `takosumi.com/docs/` 置換)、 `deploy/local-substrate/docs/production-deploy-cloudflare.md` (= Step 3 narrative を merged Pages 構造 + dashboard cleanup banner に置換)。
- **Operator-side dashboard cleanup (= NOT in this commit、 manual action)**: `wrangler pages` は project / custom domain 削除を支持しないため、 `takosumi-docs` project + `docs.takosumi.com` custom domain と (=fresh deploy なら N/A の) `takosumi-site` project は Cloudflare dashboard で手動削除する。手順は `DEPLOY.md` §"Cleanup of legacy Pages projects" に明記。順序は「`takosumi-website` を deploy + apex DNS attach → `takosumi-docs` の `docs.takosumi.com` を detach + project 削除 → 旧 `takosumi-site` (存在すれば) apex detach + project 削除」。
- **Local-substrate (= `takosumi/deploy/local-substrate/`) は変更なし**: Caddyfile の `takosumi.test` block (= `handle_path /docs/*` + `handle` apex) は既に Wave M-F で「単一 host /docs/」構造に整合済のため、 production consolidation 後はそのまま使える。 compose.substrate.yml の `takosumi-website-build` + `takosumi-docs-build` 2 service は kept (= 各々 `.output/public/` と `.vitepress/dist/` を生成し、 Caddy が両 mount を serve)。 production の `website/build.sh` が両 step を sequential に実行する形と、 local-substrate が parallel container で実行する形の違いはあるが、生成 artifact の path / 内容は identical。
- **Spec contract / JSR / kernel / contract / installer / provider / runtime には一切触らない**: 完全に docs + deploy + wrangler + workflow scope。 AppSpec 3-field root (Wave K)、 Component 4-field (kind / spec / publish / listen)、 bare `apiVersion: v1` (Wave L) 等の contract end-state は不変。 `deno task check` / `lint` / `fmt:check` / `lint:json-ld` / `spec:check-drift` / `deno test --allow-all` 全 PASS で landing build (`bash website/build.sh`) も local verify 済。
- **No version bump**: 策定中 phase かつ docs / deploy scope のみのため publish version は固定。 announcement 時の collective minor bump (= Wave J/K/L と同時) に同梱予定。

## Spec策定中 — Wave L apiVersion group prefix removal (2026-05-20, Unreleased)

Wave L (= L-A 段) で AppSpec の `apiVersion` から k8s 風 group prefix を削除した (Wave K AppSpec root envelope minimization 2026-05-20 の連続、 user mandate: 「`takosumi.dev/v1` の group prefix は k8s convention の vestige、 Takosumi parser は `.takosumi.yml` のみ扱うので group は redundant、 `v1` のみに minimize」)。「底は自由 + minimum surface」原則の連続。

- **Breaking — `apiVersion` group prefix 削除**: AppSpec root の `apiVersion` literal を `"takosumi.dev/v1"` から bare `"v1"` に minimize。 group prefix は Kubernetes API 風の vestige であり、 Takosumi parser は単一ファイル (`.takosumi.yml`) のみ扱うため redundant。
- **Contract**: `@takos/takosumi-contract` の `APP_SPEC_API_VERSION` const を `"takosumi.dev/v1"` → `"v1"` に更新、 `AppSpec.apiVersion` literal type も追従。
- **Parser**: `@takos/takosumi-installer` の `yaml-parser.ts` で expect する apiVersion 文字列が自動的に `"v1"` に。 root に `apiVersion: takosumi.dev/v1` を含む YAML は schema reject (= `validationPhase: "schema"`, `validationPath: "$.apiVersion"`) になる (= Phase B legacy-use 同形 pattern、 fail-closed)。
- **Migration**: 旧 `apiVersion: takosumi.dev/v1` を含む `.takosumi.yml` は parser で reject される。 consumer は `apiVersion: v1` に書き換えで migration 完了。 6 consumer apps (yurucommu / takos-apps/{docs,slide,excel,computer} / road-to-me) の `.takosumi.yml` migration は L-B 段で実施 (= 本 wave は takosumi/ 内部 scope のみ)。
- **Test coverage**: parser に新 regression test 2 件追加: (1) root に `apiVersion: takosumi.dev/v1` を含む入力を schema reject、 (2) bare `apiVersion: v1` を含む最小 AppSpec を accept。既存 parser / kernel / acceptance / e2e fixture から `takosumi.dev/v1` 行を sweep 済。
- **CLI scaffold**: `takosumi init` の `worker-postgres` / `empty` template が bare `v1` を emit。
- **Docs**: `docs/reference/app-spec.md` / `docs/reference/manifest.md` の envelope narrative と version table を `"v1"` wording に更新、 YAML example から `takosumi.dev/v1` 行を全 sweep。
- **JSON-LD context は touch しない**: `spec/contexts/v1.jsonld` の canonical URI (= `https://takosumi.com/contexts/v1.jsonld`、 `https://takosumi.com/` vocab) は AppSpec の `apiVersion` value とは別概念。 JSON-LD URI structure は keep、 apiVersion value のみ変更。
- **No version bump yet**: 策定中 phase のため deno.json の version は固定。 Wave L announcement 時に collective minor bump を実施予定。

## Spec策定中 — Wave K AppSpec root envelope minimization (2026-05-20, Unreleased)

Wave K (= K-A 段) で AppSpec root envelope を更に minimize した (Wave J Component contract minimization 2026-05-19 の延長、 user mandate: 「kind: App は k8s vestige、 root kind が 1 値しかなく apiVersion で schema 判別に十分、削除」)。完全 kind-agnostic は Wave J で達成済、本 wave は root envelope の minimization。

- **Breaking — AppSpec root `kind: App` field 削除**: top-level AppSpec field から物理削除。 `apiVersion: takosumi.dev/v1` 単独で schema を discriminate する。内部 Component の `kind:` field (= materializer 解決の discriminator) は当然 keep。 AppSpec root は `{ apiVersion, metadata, components }` の 3 field に minimize された。
- **Contract**: `@takos/takosumi-contract` の `AppSpec` interface から `kind: typeof APP_SPEC_KIND` を削除、 `APP_SPEC_KIND` const も削除。
- **Parser**: `@takos/takosumi-installer` の `yaml-parser.ts` で `ROOT_KEYS` から `kind` を削除、既存の `apiVersion` check の後の `kind` check を削除。 root に `kind:` を含む YAML は `unknown-key` reject (= `validationPhase:
  "schema"`, `validationPath: "$.kind"`) になる (= Phase B legacy-use と同形 pattern)。
- **Migration**: 旧 `kind: App` を含む `.takosumi.yml` は parser で reject される。 consumer は `kind: App` 行を削除 (= `apiVersion: takosumi.dev/v1` 直下に `metadata:` を接続) で migration 完了。 6 consumer apps (yurucommu / takos-apps/{docs,slide,excel,computer} / road-to-me) の `.takosumi.yml` migration は K-B 段で実施 (= 本 wave は takosumi/ 内部 scope のみ)。
- **Test coverage**: parser に新 regression test 2 件追加: (1) root に `kind:` を含む入力を unknown-key reject、 (2) root に `kind:` を含まない最小 AppSpec (`apiVersion + metadata + components`) を accept。既存 parser / kernel / acceptance / e2e fixture から `kind: App` 行を sweep 済。
- **CLI scaffold**: `takosumi init` の `worker-postgres` / `empty` template が新 envelope を emit。
- **Docs**: `docs/reference/app-spec.md` 等の AppSpec envelope narrative を「3 field (`apiVersion + metadata + components`)」 wording に更新、 YAML example から `kind: App` 行を全 sweep。
- **No version bump yet**: 策定中 phase のため deno.json の version は固定。 Wave K announcement 時に collective minor bump を実施予定。

## Spec策定中 — Wave J Component contract minimization (2026-05-19, Unreleased)

Wave J で AppSpec contract surface を完全 kind-agnostic に minimize した (post-Phase-I 継続 evolution、 user mandate: route を kind-specific `spec` / materializer convention 側に置く):

- **Breaking — `Component.routes` 削除**: top-level Component field から物理削除。 worker materializer (= cloudflare-workers / deno-deploy shape provider) は `spec.routes` を実装慣習として読み続ける。 worker.jsonld からも `routes` 宣言を削除 (= kind contract が routes を mandate しない)。
- **Breaking — `AppSpec.interfaces` 削除**: top-level AppSpec field から物理削除。 launch / mcp / health endpoint は kind の open `spec:` 内、または別 kind / external publication で表現する。
- **Breaking — `AppSpec.permissions` 削除**: top-level AppSpec field から物理削除。 capability request は external publication / consumer-defined kind で model する。
- **Breaking — kernel routes machinery 削除**: `event-planner` / `rollout` services 完全削除 (= dormant、 installer pipeline から呼ばれていなかった)。 old compile layer が route declarations を drop し、kernel pipeline は route declarations を処理しない。 `AppSpecRoute` / `DeploymentRoute` 型は type-level shim として retain (= 6 cloud provider plugin の compile 互換のため)。
- **Migration**: old top-level route / interface / permission fields を含む AppSpec は parser で `schema` phase + `unknown-key` で reject される。 consumer は (1) routes を worker kind の `spec.routes` に nest、 (2) interfaces / permissions block を削除、で migration 完了。 6 consumer apps (yurucommu / takos-apps/{docs,slide,excel,computer} / road-to-me) は本 Wave で migrate 済。 takosumi cli `init` scaffold template も新 shape を emit。
- **No version bump yet**: 策定中 phase のため deno.json の version は固定 (contract 2.5.0 / kernel 0.14.0 / plugins 0.12.0 / cli 0.15.0 / all 0.17.0)。 Wave J announcement 時に collective minor bump を実施予定。

## Spec策定中 — Phase A–F (2026-05-19, Unreleased)

Phase A–F (= Wave-level spec re-baseline) で次の breaking change を確定:

- **Breaking — AppSpec connection edge を `publish` / `listen` に統合**: 旧 `use:` edge は AppSpec から廃止。 component は `publish` で local publication を宣言し、`listen.from` で `component.publication` または external publication path を参照する形に集約。旧 `${ref:...}` / `${secret-ref:...}` / `${bindings.*}` / `${secrets.*}` / `${installation.*}` / `${artifacts.*}` / `${params.*}` placeholder interpolation は parser から完全削除。 compiled intermediate / `workflowRef` 中間 entity も廃止。
- **Breaking — `kind: oidc` を takosumi-cloud に移動**: 旧 frozen kind 構造を廃止し、 `oidc` を本 repo から削除。 Takosumi Accounts (= takosumi-cloud) が `operator.identity.oidc` external publication path に OIDC client material を publish し、 worker は `listen.<binding>.from: operator.identity.oidc` で標準 env (`OIDC_ISSUER_URL` / `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` / `OIDC_REDIRECT_URIS`) を受け取る形に変更。本 repo には `spec/contexts/kinds/v1/oidc.jsonld` も `oidc` materializer (旧 `oidc-takosumi-accounts.ts`) も無い。
- **Breaking — Component kind は external**: `worker` / `postgres` / `object-store` / `custom-domain` / `web-service` は takosumi.com reference descriptors が publish する external descriptor 例として扱う。新 kind は任意 domain の URI + material contract + operator implementation binding で追加可能。
- **Breaking — Reference materializer binding**: takosumi.com reference implementation は `KernelPlugin` factory を返す plain array (= Vite-like adapter pattern, cloud provider package が提供する形式) として `createPaaSApp({ plugins: [...] })` に attach する。互換 implementation は別の registry / controller / operator catalog で同じ kind URI を実行できる。
- **Breaking — Cloud provider plugins を別 package に分離**: AWS / GCP / Cloudflare / Kubernetes / Deno Deploy / Self-host の materializer 実装は `@takos/takosumi-{aws,gcp,cloudflare,kubernetes,deno-deploy,selfhost}-providers` に分離して publish される。 takosumi core (kernel / plugins / cli) は cloud SDK に依存しない。 operator は必要な provider package を import して `plugins: [...]` に attach する。旧 `enableAws: true` / `createTakosumiProductionProviders(opts)` switch は撤回済。
- **Breaking — HTTP status flip**: kernel HTTP surface の status code を spec と整合化。 `failed_precondition` = **409** (旧 412)、 `resource_exhausted` = **413** (旧 429)。 client / docs / SDK は新 status に追従が必要。
- **Breaking — Idempotency-Key header 廃止**: 旧 `Idempotency-Key` HTTP header ベースの retry semantics を撤回。 idempotency は AppSpec digest + Installation/Deployment id で deterministic に成立し、別途 header は不要。
- `KernelPlugin` plain-array attach (Wave 9 で導入) は維持。provider plugin は operator distribution が普通の TypeScript module として import する。
- public deploy/install contract is reset to three concepts: AppSpec (`.takosumi.yml`), Installation, and Deployment. The public installer HTTP surface is the 5 endpoint `/v1/installations*` API.
- legacy public deployment routes, including `/v1/deployments` and `/api/public/v1/*`, are removed from the kernel route table and OpenAPI.
- `takosumi install`, `takosumi deploy`, and `takosumi rollback` use the installer API with `TAKOSUMI_INSTALLER_TOKEN`. `TAKOSUMI_DEPLOY_TOKEN` remains scoped to artifact write routes.

## takosumi-cli

### 0.15.0 — 2026-05-06

- **Breaking**: `.takosumi/manifest.yml` (and the `.takosumi/manifest.yaml` / `.takosumi/manifest.json` / `manifest.yml` / `manifest.yaml` / `manifest.json`) auto-discovery is removed. `takosumi deploy` / `plan` / `destroy` / `doctor` now require an explicit manifest path passed as the positional `<manifest>` argument or `--manifest <path>`. `loadManifest()` / `resolveManifestPath()` reject when the path is missing with `manifest path is required; pass <manifest> or --manifest <path>.` + `Project-layout discovery (.takosumi/manifest.yml) is provided by` + `standalone installer (sibling product), not this CLI.`. The `DEFAULT_MANIFEST_CANDIDATES` export is removed.
- **Breaking**: `takosumi init --project` is removed. `init` now writes the rendered manifest to the explicit `<output>` path (or stdout when omitted) and never creates a `.takosumi/` directory.
- The `.takosumi/` repository convention (project layout, workflow definitions, git push / webhook / build pipeline, cron / hook wiring) has moved to the `standalone installer` sibling product, which posts generated manifests back to the kernel via the deploy public route. Operators that want the old "drop a `.takosumi/manifest.yml` and run `takosumi deploy`" UX should adopt `standalone installer`.
- Published package imports now pin `@takos/takosumi-contract@^2.5.0`, matching the `TAKOSUMI_*` internal RPC naming policy.

### 0.14.0 — 2026-05-06

- Re-export bump tracking `takosumi-kernel@0.14.0` / `takosumi-plugins@0.12.0`. CLI surface unchanged; downstream manifest validation rejects `compute.<name>.build` and `resource.workflow@v1`.

### 0.13.0 — 2026-05-03

- **Breaking**: `expandManifestLocal()` / `takosumi deploy` / `takosumi
  destroy` now run `validateManifestEnvelope()` (from contract 2.4.0) before template expansion. Manifests missing `apiVersion: "1.0"` / `kind: Manifest` are rejected with `manifest envelope rejected: ...`.
- `takosumi init` scaffolded manifests now emit `apiVersion: "1.0"` / `kind: Manifest` (was `apiVersion: takosumi.com/hosting/v1` / `kind: TakosDistribution`).

### 0.12.0 — 2026-05-03

- `takosumi destroy <manifest>` now works in **local mode** (in-process destroy via the bundled in-memory providers). Previously printed "not yet wired" and exited.
- `takosumi deploy <manifest>` local mode now expands `template:` field manifests against bundled templates (`selfhosted-single-vm`, `web-app-on-cloudflare`). Previously errored when manifest had no `resources[]`.
- New helper exports from `@takos/takosumi-cli/local-runner`: `expandManifestLocal()` and `destroyLocal()`.

### 0.11.0 — 2026-05-02

- `~/.takosumi/config.yml` is consulted as a last-priority default for `--remote` / `--token` (resolution: flag > env > config file). Override path via `TAKOSUMI_CONFIG_FILE`.
- New `takosumi completions <bash|zsh|fish>` subcommand via `@cliffy/command/completions`.
- `takosumi server --detach` prints systemd / docker / nohup templates instead of pretending to daemonize (Deno lacks portable detach).

### 0.10.0 — earlier

- Provider-id namespacing under `@takos/<cloud>-<service>`. Current manifests use namespaced ids such as `@takos/aws-fargate`; bare provider ids are not the current public contract.

## takosumi-runtime-agent

### 0.7.0 — 2026-05-03

- **Selfhost connectors recover state across agent restarts.** `DockerComposeConnector` and `LocalDockerPostgresConnector` now query `docker inspect <handle>` for live status and reconstruct outputs from `NetworkSettings.Ports` / `Config.Env`. `SystemdUnitConnector` reads the on-disk unit file and runs `systemctl is-active`. Earlier versions returned `missing` from `describe()` after any agent restart, even though containers / units kept running.
- `apply()` retries port allocations up to 50 times when docker reports "port is already allocated" / "address already in use", so a re-deploy after restart no longer fails on stale port collisions.
- `SystemdUnitConnector` rendered unit files now embed `# X-Takos-HostPort=<n>` and `# X-Takos-InternalPort=<n>` markers so `describe()` can reconstruct outputs from disk. Hand-written units without the markers describe with status only.
- Published package imports now pin `@takos/takosumi-contract@^2.5.0`, matching the current runtime-agent lifecycle contract.
- Connector registration now wraps lifecycle hooks with bounded retry / credential-refresh resilience. Transient HTTP/network errors retry with exponential backoff, non-transient provider errors fail fast, and operators can inject a credential refresh hook through `ConnectorBootOptions.resilience`.

### 0.6.0 — 2026-05-02

- Connector `provider` field now uses `@takos/<cloud>-<service>` namespacing.
- New `verify` action across connectors for read-only credential smoke tests.

## takosumi-kernel

### Unreleased — docs-only (trust model simplification)

- **Docs-only**: plugin loading is documented as Vite-style operator imports and `createPaaSApp({ plugins })`; plugin package retrieval / verification stays operator-owned. No kernel runtime code change in this changelog entry; OIDC ID token signing and launch token issuance belong to Takosumi Accounts. Reference: [Supply Chain Trust](./docs/reference/supply-chain-trust.md), [Plugin Loading](./docs/reference/plugin-loading.md), [external-descriptor-registry-model](./docs/reference/architecture/external-descriptor-registry-model.md).

### 0.15.0 — 2026-05-07

- Public deploy route now enforces operator DataAsset metadata size before plan / apply side effects. Sizes must be non-negative integer byte counts and cannot exceed the registered DataAsset metadata `maxSize` (falling back to the kernel DataAsset cap for unknown metadata kinds); oversized DataAssets return 413 `resource_exhausted`.
- `UsageProjectionService` now supports per-Space CPU / storage / bandwidth quota tiers through `LocalUsageQuotaPolicy`, including `requireWithinQuota()` for fail-closed usage recording.
- `SlaBreachDetectionService` now evaluates operator-supplied thresholds, persists hysteresis state, and publishes `sla-warning-raised` / `sla-breach-detected` / `sla-recovering` / `sla-recovered` events to audit, outbox, and the operator notification signal path.
- Public deploy and deployment rollback paths now record `takosumi_deploy_operation_count`, `takosumi_apply_duration_seconds`, and `takosumi_rollback_duration_seconds` metrics for Prometheus / OTLP export. A deploy overview Grafana dashboard is included under `deploy/observability/grafana/`.
- Kernel API responses now propagate `x-request-id` / `x-correlation-id`, emit JSON HTTP request logs in staging / production, and attach request correlation ids to public deploy metrics.
- Kernel API request correlation now propagates W3C `traceparent`, records HTTP server spans in the configured `ObservabilitySink`, exports spans through native OTLP/HTTP JSON `/v1/traces`, and adds `trace_id` / `span_id` to JSON request logs.
- WAL-backed `applyV2` / `destroyV2` provider calls now record `takosumi.provider.apply` / `takosumi.provider.destroy` spans with operation id, operation kind, WAL stage, idempotency key, provider id, resource name, request id, and correlation id attributes.
- Runtime-agent RPC calls now propagate `traceparent` / request correlation headers and record client spans, runtime-agent work execution records `takosumi.runtime_agent.execute` spans, and the generic `TakosumiInternalClient` records `takosumi.internal_rpc.client` spans.
- Added the Observability Stack ownership reference, including managed vs self-hosted responsibilities, default SLI / SLO targets, and alert policy ownership.

### 0.14.0 — 2026-05-06

- **Breaking**: kernel-side workflow primitive reservation withdrawn. The reserved `triggers` / `execute-step-operation` / `declarable-hooks` reference pages were removed; workflow / trigger / hook semantics are owned by `standalone installer` (upstream sibling product). See [Workflow Placement Rationale](./docs/reference/architecture/workflow-extension-design.md).
- **Breaking**: `compute.<name>.build` field removed from the manifest schema. Manifests carrying `build` / `build.fromWorkflow` are now rejected with a validation error. `compute` requires explicit `type` for non-container runtimes plus an `image:` URI with a port.
- **Breaking**: `resource.workflow@v1` shape registration removed from the bundled shape catalog. Manifests that declare a `workflow@v1` resource are rejected.
- `inferComputeType` no longer derives a runtime from the (removed) `build` field; explicit `type` is required.
- Published package imports now pin `@takos/takosumi-contract@^2.5.0`, matching the `TAKOSUMI_INTERNAL_PATHS` / internal RPC exports used by the kernel.
- The Kernel HTTP API reference now separates implemented routes from workflow-shaped concerns owned by `standalone installer`, and the docs include a public spec source map with drift tests.

### 0.13.0 — 2026-05-03

- **Breaking**: deploy public route now invokes `validateManifestEnvelope()` from contract 2.4.0 — manifests missing `apiVersion: "1.0"` / `kind: Manifest` are rejected with HTTP 400 and a path-prefixed error.
- **Breaking**: bare provider ids (`aws-fargate`, `cloud-run`, `local-docker`, etc.) are now **rejected** at the resource resolver with a namespaced-replacement suggestion. Current manifests must write every `provider:` field as `@takos/<cloud>-<service>`.

### 0.12.0 — 2026-05-02

- Deployment record store backend logged at boot (`SQL (TAKOSUMI_DATABASE_URL)` vs `in-memory`) so operators see when persistence falls back.
- Dev-mode in-memory adapter fallback warning skipped when caller passes no adapters at all (test boots), to keep test output clean.

### 0.11.0 — 2026-05-02

- Bootstrap split into `bootstrap/registry_setup`, `worker_daemon`, `readiness`, `deploy_record_store`, `agent_detection` for readability. Public API (`createPaaSApp`) unchanged.
- `registerProvider` warns on collision unless `allowOverride: true`.
- Dev-mode in-memory adapter fallbacks logged so operators see silent persistence loss before going to prod.

## takosumi-plugins

### 0.12.0 — 2026-05-06

- **Breaking**: `resource.workflow@v1` shape registration removed from the bundled shape catalog. Workflow / cron / hook resources are now plugin shapes provided by upstream products such as `standalone installer`.

### 0.11.0 — 2026-05-03

- Bundled shape provider registry (`shape-providers/factories.ts`) now uses `satisfies readonly XxxCapability[]` on each entry's `capabilities` array. Capability typos in the catalog are caught at compile time (TypeScript `TS2820` "Did you mean ..." suggestion). The runtime shape remains a `readonly string[]` to match the provider contract.

### 0.10.0 — 2026-05-02

- 21 production providers under `@takos/<cloud>-<service>` namespacing. Current manifests use namespaced provider ids.
- Bundled DataAsset metadata discovery: `oci-image`, `js-bundle`, `lambda-zip`, `static-bundle`, `wasm`. `GET /v1/artifacts/kinds` lists registered metadata kinds; CLI `takosumi artifact kinds` queries it.

## takosumi-contract

### 2.5.0 — 2026-05-03

- `ProviderPlugin` gains an optional `Capability extends string = string` type parameter so plugins can pin `capabilities: readonly Capability[]` to their shape's published capability union (e.g. `WebServiceCapability`). Untyped plugins keep working — `Capability` defaults to `string`.

### 2.4.0 — 2026-05-03

- **Breaking**: new `Manifest` envelope type with required `apiVersion: "1.0"` and `kind: "Manifest"` fields. Exports `MANIFEST_API_VERSION`, `MANIFEST_KIND`, `validateManifestEnvelope()`, `ManifestEnvelopeIssue`, `ManifestMetadata`. Operators must prepend these two fields to every manifest YAML / JSON.

### 2.3.0 — 2026-05-02

- DataAsset metadata kind discovery exports (`registerArtifactKind`, `listArtifactKinds`, `getArtifactKind`).
- `registerProvider` collision warning + `allowOverride` opt-out.

## takosumi (umbrella)

### 0.17.0 — 2026-05-06

- Re-export bump tracking `takosumi-cli@0.15.0`.
- **Breaking** (downstream): the bundled CLI no longer auto-discovers `.takosumi/manifest.yml` / `manifest.yml`; pass the manifest path explicitly to every `deploy` / `plan` / `destroy` / `doctor` invocation. `takosumi init --project` is gone. The `.takosumi/` project-layout convention has moved to the `standalone installer` sibling product.

### 0.16.0 — 2026-05-06

- Re-export bump tracking `takosumi-kernel@0.14.0`, `takosumi-plugins@0.12.0`, and `takosumi-cli@0.14.0`.
- **Breaking** (downstream): kernel workflow primitive reservation withdrawn, `compute.<name>.build` removed from the manifest schema, and `resource.workflow@v1` shape removed from the bundled catalog. The `triggers` / `execute-step-operation` / `declarable-hooks` reference pages were deleted; consult [Workflow Placement Rationale](./docs/reference/architecture/workflow-extension-design.md) for the new ownership boundary.

### 0.15.0 — 2026-05-03

- Re-export bump tracking `takosumi-contract@2.5.0` and `takosumi-plugins@0.11.0`. Capability typos in bundled providers are caught at compile time.

### 0.14.0 — 2026-05-03

- Re-export bump tracking `takosumi-contract@2.4.0`, `takosumi-kernel@0.13.0`, `takosumi-cli@0.13.0`. Manifest envelope (`apiVersion: "1.0"` / `kind: Manifest`) is now required across the board.

### 0.13.0 — 2026-05-03

- Re-export bump tracking `takosumi-cli@0.12.0` and `takosumi-runtime-agent@0.7.0`.

### 0.12.0 — 2026-05-02

- Re-export bump tracking `takosumi-kernel@0.12.0` and `takosumi-cli@0.11.0`.
