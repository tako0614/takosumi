import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

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
  expect(block).toContain("deploy/platform/worker.ts");
  expect(block).toContain(
    "deploy/platform/.wrangler/dist/takosumi-platform-worker.mjs",
  );
  expect(block).toContain("--format esm");
  expect(block).toContain("--external cloudflare:workers");
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
  expect(workers).not.toContain("takosumi-website-build");
  expect(workers).not.toContain("takosumi-docs-build");
  expect(workers).toContain("takosumi-dashboard-build");
  expect(workers).toContain("takosumi-app-docs-build");
  expect(staticWaitBlock).toContain('wait_for_completed_service "$service"');
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
    "TAKOSUMI_ACCOUNTS_LOCAL_DEV_SESSION_ID=sess_local_substrate",
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
  expect(renderAccountsD1Migrations).toContain("listD1AccountsMigrations()");
  expect(renderAccountsD1Migrations).toContain(
    'kind: "takosumi.accounts.local-d1-migrations@v1"',
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
    "CREATE TABLE IF NOT EXISTS takosumi_accounts_schema_migrations",
  );
  expect(platformWorkerRunner).toContain("await database.exec(migration.sql)");
  expect(platformWorkerRunner).toContain(
    "INSERT INTO takosumi_accounts_schema_migrations",
  );
});

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
