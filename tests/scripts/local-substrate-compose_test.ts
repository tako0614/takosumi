import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Miniflare } from "miniflare";
import {
  applyD1AccountsMigrationBatch,
  loadD1AccountsMigrationCatalog,
  readD1AccountsMigrationState,
  type D1AccountsMigrationDatabase,
} from "../../accounts/service/src/d1-migrations.ts";
import { applyLocalAccountsD1Migrations } from "../../deploy/local-substrate/wrappers/takosumi-platform-worker-runner.mjs";

const composePath = resolve(
  import.meta.dir,
  "../../deploy/local-substrate/compose.substrate.yml",
);
const compose = readFileSync(composePath, "utf8");
const upScriptPath = resolve(
  import.meta.dir,
  "../../deploy/local-substrate/scripts/up.sh",
);
const upScript = readFileSync(upScriptPath, "utf8");
const miniflareDockerfilePath = resolve(
  import.meta.dir,
  "../../deploy/local-substrate/wrappers/Dockerfile.miniflare",
);
const miniflareDockerfile = readFileSync(miniflareDockerfilePath, "utf8");
const cliSmokePath = resolve(
  import.meta.dir,
  "../../deploy/local-substrate/scripts/cli-smoke.sh",
);
const cliSmoke = readFileSync(cliSmokePath, "utf8");
const workersCliSmoke = readFileSync(
  resolve(
    import.meta.dir,
    "../../deploy/local-substrate/scripts/workers-cli-smoke.sh",
  ),
  "utf8",
);
const routeRegistrarSmoke = readFileSync(
  resolve(
    import.meta.dir,
    "../../deploy/local-substrate/scripts/route-registrar-smoke.sh",
  ),
  "utf8",
);
const k6Baseline = readFileSync(
  resolve(
    import.meta.dir,
    "../../deploy/local-substrate/scripts/k6-baseline.js",
  ),
  "utf8",
);
const k6BaselineWrapper = readFileSync(
  resolve(
    import.meta.dir,
    "../../deploy/local-substrate/scripts/k6-baseline.sh",
  ),
  "utf8",
);
const tenantIsolationPath = resolve(
  import.meta.dir,
  "../../deploy/local-substrate/scripts/tenant-isolation.sh",
);
const tenantIsolation = readFileSync(tenantIsolationPath, "utf8");
const coreMigratePath = resolve(
  import.meta.dir,
  "../../core/scripts/db-migrate.ts",
);
const coreMigrate = readFileSync(coreMigratePath, "utf8");
const nodePostgresServerPath = resolve(
  import.meta.dir,
  "../../deploy/node-postgres/src/server.ts",
);
const nodePostgresServer = readFileSync(nodePostgresServerPath, "utf8");
const ingressComposePath = resolve(
  import.meta.dir,
  "../../deploy/local-substrate/compose.ingress.yml",
);
const ingressCompose = readFileSync(ingressComposePath, "utf8");
const caddyfilePath = resolve(
  import.meta.dir,
  "../../deploy/local-substrate/caddy/Caddyfile",
);
const caddyfile = readFileSync(caddyfilePath, "utf8");
const cloudEnvPath = resolve(
  import.meta.dir,
  "../../deploy/local-substrate/env/cloud.env",
);
const cloudEnv = readFileSync(cloudEnvPath, "utf8");
const serviceWorkerEnvPath = resolve(
  import.meta.dir,
  "../../deploy/local-substrate/env/takosumi-service-worker.env",
);
const serviceWorkerEnv = readFileSync(serviceWorkerEnvPath, "utf8");
const platformWorkerRunnerPath = resolve(
  import.meta.dir,
  "../../deploy/local-substrate/wrappers/takosumi-platform-worker-runner.mjs",
);
const platformWorkerRunner = readFileSync(platformWorkerRunnerPath, "utf8");
const smokePath = resolve(
  import.meta.dir,
  "../../deploy/local-substrate/scripts/smoke.sh",
);
const smoke = readFileSync(smokePath, "utf8");
const migrationIdempotency = readFileSync(
  resolve(
    import.meta.dir,
    "../../deploy/local-substrate/scripts/migration-idempotency.sh",
  ),
  "utf8",
);
const composeHelpers = readFileSync(
  resolve(
    import.meta.dir,
    "../../deploy/local-substrate/scripts/compose-helpers.sh",
  ),
  "utf8",
);
const otelSmoke = readFileSync(
  resolve(
    import.meta.dir,
    "../../deploy/local-substrate/scripts/otel-smoke.sh",
  ),
  "utf8",
);
const mailpitSmoke = readFileSync(
  resolve(
    import.meta.dir,
    "../../deploy/local-substrate/scripts/mailpit-smoke.sh",
  ),
  "utf8",
);
const workerdTlsNegativePath = resolve(
  import.meta.dir,
  "../../deploy/local-substrate/scripts/workerd-tls-negative.sh",
);
const workerdTlsNegative = readFileSync(workerdTlsNegativePath, "utf8");
const renderAccountsD1MigrationsPath = resolve(
  import.meta.dir,
  "../../deploy/local-substrate/scripts/render-accounts-d1-migrations.ts",
);
const renderAccountsD1Migrations = readFileSync(
  renderAccountsD1MigrationsPath,
  "utf8",
);
const otelConfigPath = resolve(
  import.meta.dir,
  "../../deploy/local-substrate/otel/config.yaml",
);
const otelConfig = readFileSync(otelConfigPath, "utf8");
const appArmorComposePath = resolve(
  import.meta.dir,
  "../../deploy/local-substrate/compose.substrate.apparmor-unconfined.yml",
);
const appArmorCompose = readFileSync(appArmorComposePath, "utf8");

test("local-substrate builds the single composed platform worker", () => {
  const workerBuilds = compose.matchAll(
    /takosumi-service-worker-build:[\s\S]*?--outfile deploy\/platform\/\.wrangler\/dist\/takosumi[^\n]+/g,
  );

  const blocks = [...workerBuilds].map((match) => match[0]);
  // ONE build only — the old two-bundle scaffold (a control-plane bundle + a
  // mislabeled "accounts" bundle, both from worker/src/index.ts) is gone.
  expect(blocks.length).toBe(1);
  const [block] = blocks;
  expect(block).toContain("set -e");
  expect(block).toContain("deploy/platform/worker.ts");
  expect(block).toContain(
    "deploy/platform/.wrangler/dist/takosumi-platform-worker.mjs",
  );
  expect(block).toContain("--format esm");
  expect(block).toContain("--external cloudflare:workers");
  expect(block).toContain("--external @cloudflare/containers");
  // No stale scaffold output path survives.
  expect(compose).not.toContain("deploy/cloudflare/.wrangler/dist");
  expect(compose).not.toContain("worker/src/index.ts");
  expect(compose).toContain(
    "bun deploy/local-substrate/scripts/render-accounts-d1-migrations.ts",
  );
  expect(compose).toContain(
    "deploy/platform/.wrangler/dist/takosumi-accounts-d1-migrations.json",
  );
});

test("local-substrate static builders use read-only sources and isolated outputs", () => {
  const dashboardBuild = compose.match(
    /takosumi-dashboard-build:[\s\S]*?volumes:\n(?<block>(?:      - .+\n)+)/,
  )?.[0];

  expect(dashboardBuild).toBeDefined();
  expect(dashboardBuild).toContain("working_dir: /build/dashboard");
  expect(dashboardBuild).toContain("- ../../../takosumi:/source:ro");
  expect(dashboardBuild).toContain(
    "- ../../../takosumi/dashboard/dist:/output",
  );

  for (const service of [
    "takosumi-website-build",
    "takosumi-docs-build",
    "takosumi-dashboard-build",
    "takosumi-app-docs-build",
  ]) {
    const block = compose.match(
      new RegExp(`${service}:[\\s\\S]*?(?=\\n  [a-zA-Z0-9_-]+:|\\n?$)`),
    )?.[0];
    expect(block, service).toBeDefined();
    expect(block).toContain("/source:ro");
    expect(block).toContain("--exclude=node_modules");
  }

  expect(compose).toContain("npm ci --no-fund --no-audit");
  expect(compose).toContain("bun install --frozen-lockfile");
  expect(compose).not.toContain("npm install --no-fund --no-audit");
  expect(dashboardBuild).not.toContain("../../../takosumi:/work");
  expect(compose).toContain("takosumi-local-static-builder:node22");
  expect(compose).toContain("apt-get install -y --no-install-recommends git");
  expect(compose).toContain("takosumi-app-docs-build:");

  const appDocsBuild = compose.match(
    /takosumi-app-docs-build:[\s\S]*?(?=\n  [a-zA-Z0-9_-]+:|\n?$)/,
  )?.[0];
  expect(appDocsBuild).toContain("takosumi-dashboard-build:");
  expect(appDocsBuild).not.toContain("--exclude=dashboard/dist");
  expect(appDocsBuild).toContain("cp -a dashboard/dist/. /dashboard-output/");
});

test("local-substrate waits only for builders active in the selected profile", () => {
  const staticWaitBlock = upScript.match(
    /static_build_services=\(\)[\s\S]*?for service in "\$\{static_build_services\[@\]\}"; do[\s\S]*?done/,
  )?.[0];
  expect(staticWaitBlock).toBeDefined();
  const postgres = staticWaitBlock?.match(
    /postgres\)[\s\S]*?static_build_services=\((?<services>[\s\S]*?)\)[\s\S]*?;;/,
  )?.groups?.services;
  const workers = staticWaitBlock?.match(
    /workers\)[\s\S]*?static_build_services=\((?<services>[\s\S]*?)\)[\s\S]*?;;/,
  )?.groups?.services;

  expect(postgres).toContain("takosumi-website-build");
  expect(postgres).toContain("takosumi-docs-build");
  expect(postgres).toContain("takosumi-dashboard-build");
  expect(postgres).toContain("takosumi-app-docs-build");
  expect(workers).toContain("takosumi-website-build");
  expect(workers).toContain("takosumi-docs-build");
  expect(workers).toContain("takosumi-dashboard-build");
  expect(workers).toContain("takosumi-app-docs-build");
  expect(staticWaitBlock).toContain('wait_for_completed_service "$service"');
});

test("local-substrate smoke defaults to the canonical workers profile", () => {
  expect(composeHelpers).toContain(
    'local profile="${TAKOSUMI_LOCAL_SUBSTRATE_PROFILE:-workers}"',
  );
  expect(composeHelpers).toMatch(/postgres\|workers\)/);
  expect(composeHelpers).toContain(
    "TAKOSUMI_LOCAL_SUBSTRATE_PROFILE must be postgres or workers",
  );
  expect(smoke).toContain('PROFILE="$(local_substrate_profile)"');
  expect(smoke).toContain('export TAKOSUMI_LOCAL_SUBSTRATE_PROFILE="$PROFILE"');
  expect(smoke).not.toContain("--profile postgres");
  expect(smoke).toContain(
    'TAKOSUMI_SERVICE_URL="${TAKOSUMI_SERVICE_URL:-https://service.takosumi.test}"',
  );
  expect(smoke).toContain("export TAKOSUMI_SERVICE_URL");
  expect(migrationIdempotency).toContain(
    'PROFILE="$(local_substrate_profile)"',
  );
  expect(migrationIdempotency).toContain('--profile "$PROFILE"');
  expect(migrationIdempotency).not.toContain("--profile postgres");
});

test("workers smoke uses the private probe host without opening the public app seam", () => {
  expect(serviceWorkerEnv).toContain("TAKOSUMI_EXPOSE_INTERNAL_EDGE=1");
  expect(serviceWorkerEnv).toContain(
    "TAKOSUMI_OPERATOR_CONTROL_MCP_ENABLED=1",
  );
  expect(cloudEnv).not.toContain("TAKOSUMI_OPERATOR_CONTROL_MCP_ENABLED");
  expect(caddyfile).toContain("respond @private 404");
  expect(cliSmoke).toContain(
    'workers) DEFAULT_SERVICE_URL="https://service.takosumi.test"',
  );
  expect(cliSmoke).toContain('--resolve "${BASH_REMATCH[1]}:443:127.0.0.1"');
  expect(workersCliSmoke).toContain(
    '"https://${SERVICE_HOST}/internal/v1/runner-profiles"',
  );
  expect(workersCliSmoke).not.toContain(
    '"https://app.takosumi.test/internal/v1/runner-profiles"',
  );
  expect(k6Baseline).toContain(
    '__ENV.TAKOSUMI_SERVICE_URL || "https://service.takosumi.test"',
  );
  expect(k6BaselineWrapper).toContain(
    "--add-host service.takosumi.test:host-gateway",
  );
});

test("workers k6 baseline stays below local Miniflare saturation", () => {
  expect(k6BaselineWrapper).toContain('PROFILE="$(local_substrate_profile)"');
  expect(k6BaselineWrapper).toContain(
    'K6_REQUEST_RATE="${TAKOSUMI_K6_REQUEST_RATE:-1}"',
  );
  expect(k6BaselineWrapper).toContain(
    '-e TAKOSUMI_K6_REQUEST_RATE="$K6_REQUEST_RATE"',
  );
  expect(k6Baseline).toContain('__ENV.TAKOSUMI_K6_REQUEST_RATE || "10"');
  expect(k6Baseline).toContain("rate: REQUEST_RATE");
});

test("route registrar smoke follows the active local-substrate profile", () => {
  expect(routeRegistrarSmoke).toContain('PROFILE="$(local_substrate_profile)"');
  expect(routeRegistrarSmoke).toContain(
    'workers) REGISTRAR_CONTAINER="local-substrate-route-registrar-workers-1"',
  );
  expect(routeRegistrarSmoke).toContain(
    'postgres) REGISTRAR_CONTAINER="local-substrate-route-registrar-1"',
  );
  expect(routeRegistrarSmoke).toContain(
    "docker inspect -f '{{.State.Status}}' \"$REGISTRAR_CONTAINER\"",
  );
  expect(routeRegistrarSmoke).toContain(
    'recent_logs=$(docker logs --since 30s "$REGISTRAR_CONTAINER" 2>&1)',
  );
  expect(routeRegistrarSmoke).toContain(
    'grep -q "synced .* dynamic route" <<<"$recent_logs"',
  );
  expect(routeRegistrarSmoke).not.toMatch(/docker logs[^\n]*\n?\s*\| grep -q/u);
});

test("workers smoke starts every profile-specific production mirror dependency", () => {
  for (const service of [
    "takosumi-website-build",
    "takosumi-docs-build",
    "jaeger",
    "otel-collector",
    "mailpit",
  ]) {
    const block = compose.match(
      new RegExp(`(?:^|\\n)  ${service}:[\\s\\S]*?(?=\\n  [a-zA-Z0-9_-]+:|$)`),
    )?.[0];
    expect(block, service).toBeDefined();
    expect(block).toContain('profiles: ["postgres", "workers"]');
  }
});

test("host-side observability probes resolve the local ingress explicitly", () => {
  expect(
    otelSmoke.match(/--resolve "jaeger\.takosumi\.test:443:127\.0\.0\.1"/g),
  ).toHaveLength(2);
  expect(
    mailpitSmoke.match(/--resolve "mailpit\.takosumi\.test:443:127\.0\.0\.1"/g),
  ).toHaveLength(3);
});

test("local-substrate waits for regular completed containers fail-closed", () => {
  const waitFunction = upScript.match(
    /wait_for_completed_service\(\) \{[\s\S]*?\n\}/,
  )?.[0];
  expect(waitFunction).toBeDefined();
  expect(waitFunction).toContain('ps --all -q "$service"');
  expect(waitFunction).toContain('"com.docker.compose.oneoff"');
  expect(waitFunction).toContain('if [[ "$oneoff" != "True" ]]');
  expect(waitFunction).toContain('echo "$service was not created"');
  expect(upScript).toContain(
    'LOCAL_WAIT_TIMEOUT_SECONDS="${TAKOSUMI_LOCAL_WAIT_TIMEOUT_SECONDS:-600}"',
  );
  expect(upScript).toContain("=~ ^[1-9][0-9]*$");
  expect(waitFunction).toContain(
    "deadline=$((SECONDS + LOCAL_WAIT_TIMEOUT_SECONDS))",
  );
  expect(waitFunction).toContain("while (( SECONDS < deadline )); do");
  expect(waitFunction).not.toContain("seq 1 120");
});

test("local-substrate cloud migration prepares core and accounts tables", () => {
  const migrateBlock = compose.match(
    /cloud-migrate:[\s\S]*?env_file:\n(?<block>(?:      - .+\n)+)/,
  )?.[0];

  expect(migrateBlock).toBeDefined();
  expect(migrateBlock).toContain(
    "bun core/scripts/db-migrate.ts --env=production",
  );
  expect(migrateBlock).toContain("bun cli/src/main.ts accounts migrate");
  expect(migrateBlock).toContain(
    "bun deploy/local-substrate/scripts/seed-dev-session.ts",
  );
  expect(migrateBlock).toContain(
    'DATABASE_URL="$$TAKOSUMI_ACCOUNTS_DATABASE_URL"',
  );
});

test("node-postgres dashboard handler receives real control-plane operations", () => {
  expect(nodePostgresServer).toContain(
    "buildAccountsHandler(config, store, controlPlaneOperations)",
  );
  expect(nodePostgresServer).toContain("{ controlPlaneOperations }");
});

test("local-substrate core migration can use installed pg dependency", () => {
  expect(coreMigrate).toContain('await import("npm:pg@^8.11.0")');
  expect(coreMigrate).toContain('await import("pg")');
  expect(coreMigrate).toContain("pgModule.default?.Pool ?? pgModule.Pool");
});

test("local-substrate AppArmor path runs migrations outside compose networking", () => {
  expect(upScript).toContain("bun core/scripts/db-migrate.ts --env=production");
  expect(upScript).toContain("bun cli/src/main.ts accounts migrate");
  expect(upScript).toContain(
    "bun deploy/local-substrate/scripts/seed-dev-session.ts",
  );
  expect(upScript).toContain("--env-file");
  expect(upScript).toContain("env/cloud.env");
  expect(upScript).toContain("-e DATABASE_URL=");
  expect(appArmorCompose).toContain("cloud-migrate:");
  expect(appArmorCompose).toContain("- /bin/sh");
});

test("local-substrate AppArmor override removes docker-healthcheck dependency", () => {
  expect(compose).toContain(
    "until pg_isready -h postgres -U takos -d postgres",
  );
  expect(compose).toContain(
    "for db in takosumi_app takosumi takosumi_accounts",
  );

  for (const service of [
    "substrate-postgres",
    "substrate-redis",
    "substrate-minio",
    "opentofu-runner",
    "cloud",
    "takosumi-service-worker",
  ]) {
    const block = appArmorCompose.match(
      new RegExp(`${service}:[\\s\\S]*?(?=\\n  [a-zA-Z0-9_-]+:|\\n?$)`),
    )?.[0];
    expect(block, `${service} override`).toBeDefined();
    expect(block).toContain("apparmor=unconfined");
    expect(block).toContain("disable: true");
  }

  expect(appArmorCompose).toContain("condition: service_started");
  expect(appArmorCompose).not.toContain("condition: service_healthy");
  expect(appArmorCompose).toMatch(
    /takosumi-service-worker:[\s\S]*?opentofu-runner:[\s\S]*?condition: service_started/,
  );
  expect(appArmorCompose).toContain("substrate-postgres-init:");
  expect(appArmorCompose).toContain("substrate-minio-init:");
  expect(appArmorCompose).toContain('- "true"');
});

test("local-substrate up rebuilds runtime images before starting", () => {
  expect(upScript).toContain(
    'compose_substrate --profile "$PROFILE" up -d --force-recreate',
  );
  expect(upScript).toContain("substrate_up_args=(up -d --build)");
  expect(upScript).toContain("substrate_up_args+=(--force-recreate)");
  expect(upScript).toContain(
    'compose_substrate --profile "$PROFILE" "${substrate_up_args[@]}"',
  );
});

test("local-substrate postgres profile runs OpenTofu through the mirrored runner container", () => {
  const runnerBlock = compose.match(
    /opentofu-runner:[\s\S]*?(?=\n  [a-zA-Z0-9_-]+:|\n?$)/,
  )?.[0];
  const cloudBlock = compose.match(
    /cloud:[\s\S]*?(?=\n  [a-zA-Z0-9_-]+:|\n?$)/,
  )?.[0];

  expect(runnerBlock).toBeDefined();
  expect(runnerBlock).toContain("dockerfile: runner/Dockerfile");
  expect(runnerBlock).toContain("http://127.0.0.1:8080/healthz");
  expect(runnerBlock).toContain("- opentofu-runner");
  expect(cloudBlock).toContain("opentofu-runner:");
  expect(cloudBlock).toContain(
    "TAKOSUMI_LOCAL_OPENTOFU_RUNNER_URL: http://opentofu-runner:8080",
  );
  expect(cloudBlock).toContain(
    "TAKOSUMI_DEFAULT_RUNNER_PROFILE_ID: opentofu-default",
  );
});

test("workers profile relays the RUNNER durable object to the local runner", () => {
  const runnerBlock = compose.match(
    /opentofu-runner:[\s\S]*?(?=\n  [a-zA-Z0-9_-]+:|\n?$)/,
  )?.[0];
  const workerBlock = compose.match(
    /takosumi-service-worker:[\s\S]*?(?=\n  [a-zA-Z0-9_-]+:|\n?$)/,
  )?.[0];
  expect(runnerBlock).toContain('profiles: ["postgres", "workers"]');
  expect(workerBlock).toContain("opentofu-runner:");
  expect(serviceWorkerEnv).toContain(
    "TAKOSUMI_LOCAL_OPENTOFU_RUNNER_URL=http://opentofu-runner:8080",
  );
  expect(platformWorkerRunner).toContain(
    'className: "LocalSubstrateOpenTofuRunnerProxyObject"',
  );
});

test("local-substrate cloud service is an unprivileged Bun control plane", () => {
  const cloudBlock = compose.match(
    /cloud:[\s\S]*?(?=\n  [a-zA-Z0-9_-]+:|\n?$)/,
  )?.[0];
  expect(cloudBlock).toBeDefined();
  expect(cloudBlock).toContain("image: oven/bun:1");
  expect(cloudBlock).not.toContain("/var/run/docker.sock:/var/run/docker.sock");
  expect(cloudBlock).not.toContain("agent:");
});

test("local-substrate cli smoke exercises Git Source Capsule plan/apply", () => {
  expect(cliSmoke).toContain('post_json "/internal/v1/sources"');
  expect(cliSmoke).toContain(
    'post_json "/internal/v1/sources/$SOURCE_ID/sync"',
  );
  expect(cliSmoke).toContain(
    'post_json "/internal/v1/workspaces/$WORKSPACE_ID/capsules"',
  );
  expect(cliSmoke).toContain(
    'post_json "/internal/v1/capsules/$CAPSULE_ID/plan"',
  );
  expect(cliSmoke).toContain('post_json "/internal/v1/apply-runs"');
  expect(cliSmoke).toContain('wait_for_run "$PLAN_ID" "plan"');
  expect(cliSmoke).toContain('wait_for_run "$APPLY_ID" "apply"');
  expect(cliSmoke).not.toContain(
    "/internal/v1/workspaces/$WORKSPACE_ID/uploads",
  );
  expect(cliSmoke).not.toContain('post_json "/internal/v1/deploy"');
  expect(cliSmoke).not.toContain("/internal/v1/plan-runs");
  expect(cliSmoke).toContain('expected.pop("planId", None)');
  expect(cliSmoke).toContain('expected.pop("runnerId", None)');
  expect(cliSmoke).toContain('expected["planRunId"] = plan_run_id');
  expect(cliSmoke).toContain('expected["runnerProfileId"] = runner_profile_id');
});

test("local-substrate tenant isolation follows the final Workspace response", () => {
  expect(tenantIsolation).toContain(
    "print((d.get('workspace') or {}).get('id', ''))",
  );
  expect(tenantIsolation).not.toContain("d.get('space')");
});

test("local-substrate internal bridge explicitly allows container communication", () => {
  expect(ingressCompose).toContain(
    'com.docker.network.bridge.enable_icc: "true"',
  );
  expect(ingressCompose).toContain(
    'com.docker.network.bridge.enable_ip_masquerade: "true"',
  );
});

test("local-substrate platform worker is reachable through the ingress proxy", () => {
  expect(compose).not.toContain('"18788:8788"');
  expect(miniflareDockerfile).toContain("EXPOSE 8788");
  expect(caddyfile).toContain(
    "service.takosumi.test, service-worker.takosumi.test",
  );
  expect(caddyfile).toContain("reverse_proxy takosumi-service-worker:8788");
});

test("local-substrate routes the canonical app host to the active profile", () => {
  expect(ingressCompose).toContain(
    "TAKOSUMI_LOCAL_APP_UPSTREAM: ${TAKOSUMI_LOCAL_APP_UPSTREAM:-cloud:8787}",
  );
  expect(caddyfile).toContain("reverse_proxy {$TAKOSUMI_LOCAL_APP_UPSTREAM}");
  expect(upScript).toMatch(
    /workers\)\s+TAKOSUMI_LOCAL_APP_UPSTREAM="takosumi-service-worker:8788"/,
  );
  expect(upScript).toMatch(
    /""\|postgres\)\s+TAKOSUMI_LOCAL_APP_UPSTREAM="cloud:8787"/,
  );
  expect(upScript).toContain("export TAKOSUMI_LOCAL_APP_UPSTREAM");
});

test("local-substrate ingress blocks private and retired control seams", () => {
  expect(caddyfile).toContain(
    "@private path /internal/* /api/spaces /api/spaces/* /api/connections /api/connections/*",
  );
  expect(caddyfile).toContain("respond @private 404");
  expect(caddyfile).toContain("/hooks/* /mcp/* /internal/*");
});

test("local-substrate ships no fixed dev session bearer and keeps ingress loopback by default", () => {
  // The dev fixture session is a real bearer that reaches the local OpenTofu
  // runner, and the ingress can be published on a LAN, so neither the credential
  // nor the exposure may be a checked-in default.
  for (const env of [cloudEnv, serviceWorkerEnv]) {
    expect(env).not.toContain("TAKOSUMI_ACCOUNTS_LOCAL_DEV_SESSION_ID=sess_");
  }
  expect(compose).toContain(
    "TAKOSUMI_ACCOUNTS_LOCAL_DEV_SESSION_ID: ${TAKOSUMI_ACCOUNTS_LOCAL_DEV_SESSION_ID:-}",
  );
  expect(upScript).toContain(
    'TAKOSUMI_ACCOUNTS_LOCAL_DEV_SESSION_ID="sess_$(openssl rand -hex 24)"',
  );
  expect(upScript).toContain("export TAKOSUMI_ACCOUNTS_LOCAL_DEV_SESSION_ID");
  expect(composeHelpers).toContain("local_substrate_dev_session_id()");
  for (const script of [smoke, tenantIsolation]) {
    expect(script).not.toContain("sess_local_substrate");
    expect(script).toContain("$(local_substrate_dev_session_id)");
  }
  expect(ingressCompose).toContain(
    '"${TAKOSUMI_LOCAL_SUBSTRATE_INGRESS_HOST_BIND:-127.0.0.1}:${TAKOSUMI_LOCAL_SUBSTRATE_INGRESS_HTTPS_PORT:-443}:443"',
  );
  expect(ingressCompose).toContain(
    '"${TAKOSUMI_LOCAL_SUBSTRATE_INGRESS_HOST_BIND:-127.0.0.1}:${TAKOSUMI_LOCAL_SUBSTRATE_INGRESS_HTTP_PORT:-80}:80"',
  );
  expect(ingressCompose).not.toContain('- "443:443"');
  expect(upScript).toContain(
    'export TAKOSUMI_LOCAL_SUBSTRATE_INGRESS_HOST_BIND="$INGRESS_HOST_BIND"',
  );
});

test("local-substrate cloud env uses explicit upstream descriptors and a real dev session", () => {
  expect(cloudEnv).toContain("TAKOSUMI_ACCOUNTS_UPSTREAM_PROVIDERS=");
  expect(cloudEnv).toContain(
    '\"authorizationEndpoint\":\"https://oauth-mock.test/local-oidc/authorize\"',
  );
  expect(cloudEnv).toContain(
    '\"clientSecretEnv\":\"TAKOSUMI_LOCAL_OIDC_CLIENT_SECRET\"',
  );
  expect(cloudEnv).not.toContain("UPSTREAM_GOOGLE_CLIENT_ID");
  expect(cloudEnv).not.toContain("TAKOSUMI_ACCOUNTS_LOCAL_DEV_SPACE_ID");
  expect(cloudEnv).not.toContain("TAKOSUMI_ACCOUNTS_LOCAL_DEV_ACCOUNT_ID");
  expect(cloudEnv).toContain(
    "TAKOSUMI_ACCOUNTS_LOCAL_DEV_SUBJECT=tsub_takosumi_accounts_local",
  );
  expect(cloudEnv).toContain(
    "TAKOSUMI_ACCOUNTS_PASSKEY_RP_ID=app.takosumi.test",
  );
  expect(cloudEnv).not.toContain("TAKOSUMI_ACCOUNTS_STRIPE");
  expect(cloudEnv).not.toContain("UPSTREAM_GITHUB");
  for (const env of [cloudEnv, serviceWorkerEnv]) {
    expect(env).not.toContain("http://oauth-mock:8789");
    expect(env).toContain(
      '\"tokenEndpoint\":\"https://oauth-mock.test/local-oidc/token\"',
    );
    expect(env).toContain(
      '\"userInfoEndpoint\":\"https://oauth-mock.test/local-oidc/userinfo\"',
    );
  }

  const cloudBlock = compose.match(
    /cloud:[\s\S]*?(?=\n  [a-zA-Z0-9_-]+:|\n?$)/,
  )?.[0];
  const workerBlock = compose.match(
    /takosumi-service-worker:[\s\S]*?(?=\n  [a-zA-Z0-9_-]+:|\n?$)/,
  )?.[0];
  expect(cloudBlock).toContain(
    "NODE_EXTRA_CA_CERTS: /local-substrate-runtime/pebble-issuance-root.pem",
  );
  expect(workerBlock).not.toContain("NODE_EXTRA_CA_CERTS");
  expect(workerBlock).toContain("./caddy/runtime:/local-substrate-runtime:ro");
  expect(serviceWorkerEnv).toContain(
    "WORKER_OUTBOUND_CA_CERT_PATH=/local-substrate-runtime/pebble-issuance-root.pem",
  );
});

test("local-substrate configures workerd outbound TLS with the explicit Pebble root", () => {
  expect(platformWorkerRunner).toContain(
    "process.env.WORKER_OUTBOUND_CA_CERT_PATH",
  );
  expect(platformWorkerRunner).toContain(
    '"/local-substrate-runtime/pebble-issuance-root.pem"',
  );
  expect(platformWorkerRunner).toContain(
    'readFileSync(outboundCaCertPath, "utf8")',
  );
  expect(platformWorkerRunner).toContain(
    "outbound CA certificate is missing or unreadable",
  );
  expect(platformWorkerRunner).toContain(
    "outbound CA certificate is not PEM encoded",
  );
  expect(platformWorkerRunner).toContain("outboundService:");
  expect(platformWorkerRunner).toContain(
    'allow: ["public", "private", "240.0.0.0/4"]',
  );
  expect(platformWorkerRunner).toContain("trustBrowserCas: true");
  expect(platformWorkerRunner).toContain(
    "trustedCertificates: [outboundCaCert]",
  );
  expect(platformWorkerRunner).not.toContain("NODE_TLS_REJECT_UNAUTHORIZED");
  expect(platformWorkerRunner).not.toContain("rejectUnauthorized");
  expect(platformWorkerRunner).not.toContain("http://oauth-mock");
});

test("local-substrate migrates the local accounts D1 before serving traffic", () => {
  expect(renderAccountsD1Migrations).toContain(
    "loadD1AccountsMigrationCatalog()",
  );
  expect(renderAccountsD1Migrations).toContain(
    'kind: "takosumi.accounts.local-d1-migrations@v2"',
  );
  expect(serviceWorkerEnv).toContain(
    "WORKER_ACCOUNTS_D1_MIGRATIONS_PATH=/worker/takosumi-accounts-d1-migrations.json",
  );
  expect(serviceWorkerEnv).toContain("TAKOSUMI_ACCOUNTS_ES256_PRIVATE_JWK=");
  expect(serviceWorkerEnv).toContain(
    "TAKOSUMI_ACCOUNTS_OIDC_PAIRWISE_SUBJECT_SECRET=local-substrate-oidc-pairwise-subject-secret-fixture",
  );
  expect(platformWorkerRunner).toContain(
    "await applyLocalAccountsD1Migrations(mf, accountsD1MigrationsPath)",
  );
  expect(platformWorkerRunner).toContain(
    'miniflare.getD1Database("TAKOSUMI_ACCOUNTS_DB")',
  );
  expect(platformWorkerRunner).toContain(
    "migrationRuntime.backfillD1AccountsActivationDigests(database)",
  );
  expect(platformWorkerRunner).toContain(
    "migrationRuntime.applyD1AccountsMigrationBatch(",
  );
  expect(platformWorkerRunner).toContain(
    "migrationRuntime.readD1AccountsMigrationState(",
  );
  expect(platformWorkerRunner).not.toContain(
    "await database.exec(migration.sql)",
  );
  expect(platformWorkerRunner).not.toContain("readLocalAccountsD1Prefix");
});

test("local-substrate Accounts D1 runner exposes an import-safe migration seam", async () => {
  const process = Bun.spawn(
    [
      "bun",
      "-e",
      `const module = await import(${JSON.stringify(pathToFileURL(platformWorkerRunnerPath).href)}); if (typeof module.applyLocalAccountsD1Migrations !== "function") process.exit(2);`,
    ],
    {
      cwd: resolve(import.meta.dir, "../.."),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  expect(await process.exited).toBe(0);
});

test("local-substrate rendered migration artifact is the Accounts-owned catalog", async () => {
  const directory = await mkdtemp(join(tmpdir(), "takosumi-accounts-d1-"));
  const output = join(directory, "catalog.json");
  const runtimeOutput = join(directory, "catalog.runtime.mjs");
  try {
    const process = Bun.spawn(["bun", renderAccountsD1MigrationsPath, output], {
      cwd: resolve(import.meta.dir, "../.."),
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await process.exited).toBe(0);
    const artifact = JSON.parse(await readFile(output, "utf8"));
    const catalog = await loadD1AccountsMigrationCatalog();
    expect(artifact).toEqual({
      kind: "takosumi.accounts.local-d1-migrations@v2",
      catalogDigest: catalog.digest,
      policyDigest: catalog.policyDigest,
      headVersion: catalog.headVersion,
      migrations: catalog.migrations,
      schemaClosures: catalog.schemaClosures,
      preLedgerPolicy: catalog.preLedgerPolicy,
    });
    expect(await Bun.file(runtimeOutput).exists()).toBe(true);
    const runtime = await import(
      `${pathToFileURL(runtimeOutput).href}?test=${Date.now()}`
    );
    expect(await runtime.loadD1AccountsMigrationCatalog()).toEqual(catalog);
    expect(typeof runtime.backfillD1AccountsActivationDigests).toBe("function");
    expect(typeof runtime.applyD1AccountsMigrationBatch).toBe("function");
    expect(typeof runtime.readD1AccountsMigrationState).toBe("function");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("local-substrate upgrades a persisted exact-v3 Accounts D1 through the shared bounded policy", async () => {
  const directory = await mkdtemp(join(tmpdir(), "takosumi-local-d1-v3-"));
  const artifactPath = join(directory, "catalog.json");
  const runtime = localAccountsD1Runtime(join(directory, "persist"));
  try {
    await renderLocalAccountsD1Artifact(artifactPath);
    const database = (await runtime.getD1Database(
      "ACCOUNTS",
    )) as unknown as D1AccountsMigrationDatabase;
    const catalog = await loadD1AccountsMigrationCatalog();
    for (const migration of catalog.migrations.slice(0, 4)) {
      await applyD1AccountsMigrationBatch(
        database,
        migration,
        1_000 + migration.version,
      );
    }
    for (let index = 0; index < 205; index += 1) {
      const key = `local-client-${String(index).padStart(3, "0")}`;
      await database
        .prepare(
          "INSERT INTO takosumi_accounts_documents (bucket, key, document, updated_at) VALUES ('oidc_clients', ?, ?, 2000)",
        )
        .bind(key, JSON.stringify({ clientId: key, capsuleId: `cap_${key}` }))
        .run();
    }

    const batchSizes: number[] = [];
    const observed: D1AccountsMigrationDatabase = {
      prepare: (sql) => database.prepare(sql),
      batch(statements) {
        batchSizes.push(statements.length);
        return database.batch(statements);
      },
    };
    const report = await applyLocalAccountsD1Migrations(
      { getD1Database: () => Promise.resolve(observed) },
      artifactPath,
    );
    expect(report).toMatchObject({
      applied: [4],
      activationDigestBackfill: {
        inventoryCount: 205,
        candidateCount: 205,
        chunkCount: 3,
        missingAfter: 0,
      },
    });
    expect(batchSizes).toEqual([2, 2, 2, 4]);
    const state = await readD1AccountsMigrationState(database, catalog);
    expect(state).toMatchObject({
      headVersion: 4,
      exactPrefixLength: 5,
      missingActivationDigestCount: 0,
      issues: [],
    });
    await runtime.ready;
    expect((await runtime.dispatchFetch("http://local.test/")).status).toBe(200);
  } finally {
    await runtime.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);

test("local-substrate rejects malformed legacy clients before any migration write", async () => {
  const directory = await mkdtemp(join(tmpdir(), "takosumi-local-d1-drift-"));
  const artifactPath = join(directory, "catalog.json");
  const runtime = localAccountsD1Runtime(join(directory, "persist"));
  try {
    await renderLocalAccountsD1Artifact(artifactPath);
    const database = (await runtime.getD1Database(
      "ACCOUNTS",
    )) as unknown as D1AccountsMigrationDatabase;
    const catalog = await loadD1AccountsMigrationCatalog();
    for (const migration of catalog.migrations.slice(0, 4)) {
      await applyD1AccountsMigrationBatch(database, migration, 1_000);
    }
    await database
      .prepare(
        "INSERT INTO takosumi_accounts_documents (bucket, key, document, updated_at) VALUES ('oidc_clients', 'valid-before-drift', ?, 2000), ('oidc_clients', 'invalid-capsule', ?, 2000)",
      )
      .bind(
        JSON.stringify({
          clientId: "valid-before-drift",
          capsuleId: "cap_valid",
        }),
        JSON.stringify({ clientId: "invalid-capsule" }),
      )
      .run();
    let writes = 0;
    const observed: D1AccountsMigrationDatabase = {
      prepare: (sql) => database.prepare(sql),
      batch(statements) {
        writes += 1;
        return database.batch(statements);
      },
    };
    await expect(
      applyLocalAccountsD1Migrations(
        { getD1Database: () => Promise.resolve(observed) },
        artifactPath,
      ),
    ).rejects.toThrow("activation_digest_backfill_inventory_drift");
    expect(writes).toBe(0);
    const state = await readD1AccountsMigrationState(database, catalog);
    expect(state.headVersion).toBe(3);
    expect(state.ledgerShape).toBe("legacy");
    const valid = await database
      .prepare(
        "SELECT document FROM takosumi_accounts_documents WHERE bucket = 'oidc_clients' AND key = 'valid-before-drift'",
      )
      .first<{ readonly document: string }>();
    expect(Object.hasOwn(JSON.parse(valid?.document ?? "null"), "activationDigest"))
      .toBe(false);
  } finally {
    await runtime.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);

test("local-substrate reconciles lost acknowledgement, restarts, and rejects policy drift", async () => {
  const directory = await mkdtemp(join(tmpdir(), "takosumi-local-d1-retry-"));
  const artifactPath = join(directory, "catalog.json");
  const runtimeModulePath = join(directory, "catalog.runtime.mjs");
  const runtime = localAccountsD1Runtime(join(directory, "persist"));
  try {
    await renderLocalAccountsD1Artifact(artifactPath);
    const database = (await runtime.getD1Database(
      "ACCOUNTS",
    )) as unknown as D1AccountsMigrationDatabase;
    const catalog = await loadD1AccountsMigrationCatalog();
    for (const migration of catalog.migrations.slice(0, 4)) {
      await applyD1AccountsMigrationBatch(database, migration, 1_000);
    }
    await database
      .prepare(
        "INSERT INTO takosumi_accounts_documents (bucket, key, document, updated_at) VALUES ('oidc_clients', 'lost-local-ack', ?, 2000)",
      )
      .bind(
        JSON.stringify({
          clientId: "lost-local-ack",
          capsuleId: "cap_lost_local_ack",
        }),
      )
      .run();
    let loseFirstBatch = true;
    const lostAck: D1AccountsMigrationDatabase = {
      prepare: (sql) => database.prepare(sql),
      async batch(statements) {
        const results = await database.batch(statements);
        if (loseFirstBatch) {
          loseFirstBatch = false;
          throw new Error("simulated_local_lost_ack");
        }
        return results;
      },
    };
    const first = await applyLocalAccountsD1Migrations(
      { getD1Database: () => Promise.resolve(lostAck) },
      artifactPath,
    );
    expect(first.activationDigestBackfill).toMatchObject({
      lostAcknowledgementReconciledChunks: 1,
      missingAfter: 0,
    });
    const restarted = await applyLocalAccountsD1Migrations(
      { getD1Database: () => Promise.resolve(database) },
      artifactPath,
    );
    expect(restarted).toMatchObject({ applied: [], current: 4 });

    const canonicalArtifact = JSON.parse(await readFile(artifactPath, "utf8"));
    const tamperedArtifacts = [
      {
        ...structuredClone(canonicalArtifact),
        preLedgerPolicy: {
          ...canonicalArtifact.preLedgerPolicy,
          chunkSize: 99,
        },
      },
      {
        ...structuredClone(canonicalArtifact),
        schemaClosures: canonicalArtifact.schemaClosures.map(
          (closure: { headVersion: number; objects: readonly unknown[] }) =>
            closure.headVersion === 3
              ? { ...closure, objects: closure.objects.slice(1) }
              : closure,
        ),
      },
    ];
    for (const [index, artifact] of tamperedArtifacts.entries()) {
      const tamperedPath = join(directory, `tampered-${index}.json`);
      await Bun.write(tamperedPath, JSON.stringify(artifact));
      let databaseReads = 0;
      await expect(
        applyLocalAccountsD1Migrations(
          {
            getD1Database() {
              databaseReads += 1;
              return Promise.resolve(database);
            },
          },
          tamperedPath,
          { runtimeModulePath },
        ),
      ).rejects.toThrow("accounts D1 migration policy mismatch");
      expect(databaseReads).toBe(0);
    }
  } finally {
    await runtime.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);

test("local-substrate proves workerd rejects the same TLS chain without the explicit root", () => {
  expect(smoke).toContain("workerd-tls-negative.sh");
  expect(smoke).toContain("oauth.workerd-untrusted-ca");
  expect(workerdTlsNegative).toContain("outboundService:");
  expect(workerdTlsNegative).toContain(
    'allow: ["public", "private", "240.0.0.0/4"]',
  );
  expect(workerdTlsNegative).toContain("trustBrowserCas: true");
  expect(workerdTlsNegative).not.toContain("trustedCertificates:");
  expect(workerdTlsNegative).not.toContain("NODE_TLS_REJECT_UNAUTHORIZED");
  expect(workerdTlsNegative).not.toContain("rejectUnauthorized");
  expect(workerdTlsNegative).not.toContain("http://oauth-mock");
});

test("local-substrate OTel collector forwards to the reachable Jaeger OTLP port", () => {
  expect(compose).not.toContain('"14317:4317"');
  expect(compose).not.toContain('"16686:16686"');
  expect(compose).toContain('"127.0.0.1:14318:4318"');
  expect(compose).toContain("host.docker.internal:host-gateway");
  expect(otelConfig).toContain("endpoint: jaeger:4317");
});

async function renderLocalAccountsD1Artifact(output: string): Promise<void> {
  const process = Bun.spawn(["bun", renderAccountsD1MigrationsPath, output], {
    cwd: resolve(import.meta.dir, "../.."),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stderr] = await Promise.all([
    process.exited,
    new Response(process.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(`local Accounts D1 render failed: ${stderr}`);
  }
}

function localAccountsD1Runtime(persistPath: string): Miniflare {
  return new Miniflare({
    compatibilityDate: "2026-07-17",
    modules: [
      {
        type: "ESModule",
        path: "local-accounts-d1-startup-proof.mjs",
        contents:
          "export default { fetch(){ return new Response('started') } }",
      },
    ],
    d1Databases: { ACCOUNTS: "local-accounts-d1-startup-proof" },
    d1Persist: persistPath,
  });
}
