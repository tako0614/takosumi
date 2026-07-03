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
const serviceDockerfilePath = resolve(
  import.meta.dir,
  "../../deploy/local-substrate/wrappers/Dockerfile.service",
);
const serviceDockerfile = readFileSync(serviceDockerfilePath, "utf8");
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
});

test("local-substrate dashboard build sees the whole Takosumi workspace", () => {
  const dashboardBuild = compose.match(
    /takosumi-dashboard-build:[\s\S]*?volumes:\n(?<block>(?:      - .+\n)+)/,
  )?.[0];

  expect(dashboardBuild).toBeDefined();
  expect(dashboardBuild).toContain("working_dir: /work/dashboard");
  expect(dashboardBuild).toContain("- ../../../takosumi:/work");
  expect(dashboardBuild).not.toContain(
    "- ../../../takosumi/dashboard:/dashboard",
  );
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
    "buildAccountsHandler(\n        config,\n        store,\n        deployControl,\n        controlPlaneOperations,\n      )",
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
    "agent",
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
  expect(upScript).toContain("substrate_up_args=(up -d --build)");
  expect(upScript).toContain("substrate_up_args+=(--force-recreate)");
  expect(upScript).toContain(
    'compose_substrate --profile "$PROFILE" "${substrate_up_args[@]}"',
  );
});

test("local-substrate service image copies the current Docker compose plugin path", () => {
  expect(serviceDockerfile).toContain("/usr/local/libexec/docker/cli-plugins");
  expect(serviceDockerfile).not.toContain("cli-implementations");
});

test("local-substrate service image includes OpenTofu runner dependencies", () => {
  expect(serviceDockerfile).toContain("ARG OPENTOFU_VERSION=");
  expect(serviceDockerfile).toContain("/usr/local/bin/tofu");
  expect(serviceDockerfile).toContain("apt-get install");
  expect(serviceDockerfile).toContain("zstd");
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
    "TAKOSUMI_DEFAULT_RUNNER_PROFILE_ID: cloudflare-default",
  );
});

test("local-substrate cloud service uses the OpenTofu-capable service image", () => {
  const cloudBlock = compose.match(
    /cloud:[\s\S]*?(?=\n  [a-zA-Z0-9_-]+:|\n?$)/,
  )?.[0];
  expect(cloudBlock).toBeDefined();
  expect(cloudBlock).toContain("dockerfile: wrappers/Dockerfile.service");
  expect(cloudBlock).not.toContain("image: oven/bun:1");
  expect(cloudBlock).not.toContain("/var/run/docker.sock:/var/run/docker.sock");
});

test("local-substrate cli smoke exercises Git Source Capsule plan/apply", () => {
  expect(cliSmoke).toContain('post_json "/internal/v1/sources"');
  expect(cliSmoke).toContain(
    'post_json "/internal/v1/sources/$SOURCE_ID/sync"',
  );
  expect(cliSmoke).toContain(
    'post_json "/internal/v1/workspaces/$SPACE_ID/capsules"',
  );
  expect(cliSmoke).toContain(
    'post_json "/internal/v1/capsules/$INSTALLATION_ID/plan"',
  );
  expect(cliSmoke).toContain('post_json "/internal/v1/apply-runs"');
  expect(cliSmoke).not.toContain("/internal/v1/workspaces/$SPACE_ID/uploads");
  expect(cliSmoke).not.toContain('post_json "/internal/v1/deploy"');
  expect(cliSmoke).not.toContain("/internal/v1/plan-runs");
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
  expect(compose).toContain('"18788:8788"');
  expect(miniflareDockerfile).toContain("EXPOSE 8788");
  expect(caddyfile).toContain(
    "service.takosumi.test, service-worker.takosumi.test",
  );
  expect(caddyfile).toContain("reverse_proxy host.docker.internal:18788");
});

test("local-substrate cloud env is wired for Google-only OAuth and a real dev session", () => {
  expect(cloudEnv).toContain("TAKOSUMI_ACCOUNTS_UPSTREAM_GOOGLE_CLIENT_ID=");
  expect(cloudEnv).toContain(
    "TAKOSUMI_ACCOUNTS_UPSTREAM_GOOGLE_AUTHORIZATION_ENDPOINT=https://oauth-mock.test/google/authorize",
  );
  expect(cloudEnv).toContain(
    "TAKOSUMI_ACCOUNTS_LOCAL_DEV_SESSION_ID=sess_local_substrate",
  );
  expect(cloudEnv).toContain(
    "TAKOSUMI_ACCOUNTS_PASSKEY_RP_ID=app.takosumi.test",
  );
  expect(cloudEnv).toContain(
    "TAKOSUMI_ACCOUNTS_STRIPE_API_KEY=sk_test_local_substrate_fixture",
  );
  expect(cloudEnv).not.toContain("UPSTREAM_GITHUB");
});

test("local-substrate OTel collector forwards to the reachable Jaeger OTLP port", () => {
  expect(compose).toContain('"14317:4317"');
  expect(compose).toContain('"127.0.0.1:14318:4318"');
  expect(compose).toContain("host.docker.internal:host-gateway");
  expect(otelConfig).toContain("endpoint: host.docker.internal:14317");
  expect(otelConfig).not.toContain("endpoint: jaeger:4317");
});
