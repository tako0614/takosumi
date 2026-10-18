import { readFile } from "node:fs/promises";
import { posix } from "node:path";
import { expect, test } from "bun:test";
import { parse as parseYaml } from "yaml";

// The published self-host procedure (docs/concepts/self-host.md and
// deploy/node-postgres/README.md) is `cp .env.example .env`, edit, then
// `docker compose up -d`. These checks derive what that procedure needs from
// the real import graph, workspaces, and docs rather than pinning file text,
// so a new runtime import or a renamed script cannot silently break it again.

const ROOT = new URL("../../../", import.meta.url);
const read = (path: string) => readFile(new URL(path, ROOT), "utf8");

type DockerStage = { readonly name: string; readonly body: string };

function dockerStages(dockerfile: string): DockerStage[] {
  const stages: DockerStage[] = [];
  let current: { name: string; lines: string[] } | undefined;
  for (const line of dockerfile.split("\n")) {
    const from = /^FROM\s+\S+(?:\s+AS\s+(\S+))?\s*$/u.exec(line);
    if (from) {
      if (current) stages.push({ name: current.name, body: current.lines.join("\n") });
      current = { name: from[1] ?? "final", lines: [] };
      continue;
    }
    current?.lines.push(line);
  }
  if (current) stages.push({ name: current.name, body: current.lines.join("\n") });
  return stages;
}

function stage(dockerfile: string, name: string): string {
  const found = dockerStages(dockerfile).find((entry) => entry.name === name);
  if (!found) throw new Error(`Dockerfile has no ${name} stage`);
  return found.body;
}

/** Repository paths a stage copies from the build context. */
function copiedPaths(stageBody: string): string[] {
  const paths: string[] = [];
  for (const match of stageBody.matchAll(/^COPY\s+(?!--from)(.+)$/gmu)) {
    const parts = match[1]!.trim().split(/\s+/u);
    paths.push(...parts.slice(0, -1));
  }
  return paths;
}

/** Repository paths the runtime stage copies from the deps stage. */
function runtimeCopiedPaths(stageBody: string): string[] {
  return [...stageBody.replace(/\\\n/gu, " ").matchAll(
    /^COPY\s+--from=deps\s+(?:--chown=\S+\s+)?(.+)$/gmu,
  )].flatMap((match) =>
    match[1]!.trim().split(/\s+/u).slice(0, -1).map((path) =>
      path.replace(/^\/work\/?/u, "")
    )
  );
}

function covered(path: string, copied: readonly string[]): boolean {
  return copied.some((entry) => path === entry || path.startsWith(`${entry}/`));
}

async function repoLocalRuntimeInputs(entrypoint: string): Promise<string[]> {
  const result = await Bun.build({
    entrypoints: [new URL(entrypoint, ROOT).pathname],
    target: "bun",
    metafile: true,
    throw: false,
  } as Parameters<typeof Bun.build>[0] & { metafile: true; throw: false });
  if (!result.success) {
    throw new AggregateError(result.logs, `bundling ${entrypoint} failed`);
  }
  const metafile = (result as unknown as {
    metafile: { inputs: Record<string, unknown> };
  }).metafile;
  return Object.keys(metafile.inputs).filter(
    (input) => !input.startsWith("node_modules/") && !input.startsWith("/"),
  );
}

test("node-postgres deps stage ships every root workspace and runtime import", async () => {
  const [dockerfile, rootPackage] = await Promise.all([
    read("deploy/node-postgres/Dockerfile"),
    read("package.json").then(
      (source) => JSON.parse(source) as { workspaces: string[] },
    ),
  ]);
  const deps = stage(dockerfile, "deps");
  const copied = copiedPaths(deps);
  expect(deps).toContain("RUN bun install --frozen-lockfile");
  // tsconfig paths resolve takosumi-contract/* and @takosumi/providers at runtime.
  expect(copied).toContain("tsconfig.json");

  // `bun install --frozen-lockfile` needs each workspace manifest; sources are
  // checked below against the import graph.
  const missingWorkspaces = rootPackage.workspaces.filter(
    (workspace) => !covered(`${workspace}/package.json`, copied),
  );
  expect(missingWorkspaces).toEqual([]);

  // The service image runs src/server.ts; the migrations container runs the CLI.
  const inputs = [
    ...(await repoLocalRuntimeInputs("deploy/node-postgres/src/server.ts")),
    ...(await repoLocalRuntimeInputs("cli/src/main.ts")),
  ];
  expect(inputs.length).toBeGreaterThan(0);
  const missingInputs = [...new Set(inputs)].filter(
    (input) => !covered(input, copied),
  );
  expect(missingInputs).toEqual([]);
});

test("node-postgres dashboard stage builds from the dashboard lockfile alone", async () => {
  const [dockerfile, viteConfig] = await Promise.all([
    read("deploy/node-postgres/Dockerfile"),
    read("dashboard/vite.config.ts"),
  ]);
  const dashboard = stage(dockerfile, "dashboard");
  const copied = copiedPaths(dashboard);
  // The root manifest lists workspaces this stage does not carry, so a root
  // install here fails with `Workspace not found`.
  expect(dashboard).not.toMatch(/^RUN bun install/mu);
  expect(dashboard).toContain("RUN cd dashboard && bun install --frozen-lockfile");
  const aliasTargets = [...viteConfig.matchAll(/"\.\.\/([^"]+)"/gu)].map(
    (match) => match[1]!,
  );
  expect(aliasTargets.length).toBeGreaterThan(0);
  expect(aliasTargets.filter((target) => !covered(target, copied))).toEqual([]);
});

test("node-postgres runtime copies its import graph and migration SQL without the Cloudflare distribution", async () => {
  const dockerfile = await read("deploy/node-postgres/Dockerfile");
  const copied = runtimeCopiedPaths(stage(dockerfile, "final"));
  expect(copied).not.toContain("");
  expect(copied).not.toContain("deploy/cloudflare");
  expect(copied).toContain("node_modules");
  expect(copied).toContain("tsconfig.json");
  expect(covered("accounts/service/migrations/001_app_installation_ledger.sql", copied)).toBe(true);
  const inputs = (await Promise.all([
    "deploy/node-postgres/src/server.ts",
    "cli/src/main.ts",
    "core/scripts/db-migrate.ts",
  ].map(repoLocalRuntimeInputs))).flat();
  expect([...new Set(inputs)].filter((input) => !covered(input, copied))).toEqual([]);
  expect(covered("deploy/cloudflare/worker.ts", copied)).toBe(false);
});

test("node-postgres app-docs stage has git when vitepress lastUpdated is on", async () => {
  const [dockerfile, appDocsConfig] = await Promise.all([
    read("deploy/node-postgres/Dockerfile"),
    read("app-docs/.vitepress/config.ts"),
  ]);
  if (!/lastUpdated:\s*true/u.test(appDocsConfig)) return;
  expect(stage(dockerfile, "app-docs")).toMatch(
    /apt-get install -y --no-install-recommends git\b/u,
  );
});

/** Repository paths of the relative modules a config file imports, read as text. */
function relativeImports(source: string, fromDir: string): string[] {
  return [...source.matchAll(
    /^\s*(?:import|export)\s+(?!type\b)(?:[^;]*?\bfrom\s+)?["'](\.{1,2}\/[^"']+)["']/gmu,
  )].map((match) => {
    const resolved = posix.normalize(posix.join(fromDir, match[1]!));
    return /\.[cm]?[jt]s$/u.test(resolved) ? resolved : `${resolved}.ts`;
  });
}

test("node-postgres app-docs stage copies the docs helpers its config imports", async () => {
  const [dockerfile, appDocsConfig] = await Promise.all([
    read("deploy/node-postgres/Dockerfile"),
    read("app-docs/.vitepress/config.ts"),
  ]);
  // app-docs/.vitepress/config.ts imports shared helpers from docs/.vitepress;
  // the app-docs build fails unless its own stage copies them from the context.
  const imports = relativeImports(appDocsConfig, "app-docs/.vitepress");
  expect(imports.length).toBeGreaterThan(0);
  await Promise.all(imports.map(read));
  const copied = copiedPaths(stage(dockerfile, "app-docs"));
  expect(imports.filter((input) => !covered(input, copied))).toEqual([]);
});

test("node-postgres compose applies both schemas and passes only declared service settings", async () => {
  const compose = parseYaml(await read("deploy/node-postgres/docker-compose.yml")) as {
    services: Record<
      string,
      {
        env_file?: unknown;
        environment?: Record<string, string>;
        command?: unknown;
        depends_on?: Record<string, { condition: string }>;
      }
    >;
  };
  const migrations = compose.services.migrations!;
  const migrationCommand = JSON.stringify(migrations.command);
  expect(migrationCommand).toContain("/app/core/scripts/db-migrate.ts --env=production");
  expect(migrationCommand).toContain("/app/cli/src/main.ts accounts migrate");
  expect(Object.keys(migrations.environment ?? {})).toEqual(
    expect.arrayContaining(["DATABASE_URL", "TAKOSUMI_ACCOUNTS_DATABASE_URL"]),
  );

  const accounts = compose.services.accounts!;
  expect(accounts.env_file).toBeUndefined();
  expect(accounts.environment).not.toHaveProperty("POSTGRES_PASSWORD");
  expect(accounts.environment).not.toHaveProperty("TAKOSUMI_ACCOUNTS_PUBLIC_HOSTNAME");
  expect(accounts.environment).not.toHaveProperty("COMPANY_SSO_CLIENT_SECRET");
  // Every documented service option must still reach the process. Arbitrary
  // upstream secret binding names require an explicit operator override.
  const example = await read("deploy/node-postgres/.env.example");
  const serviceSettings = [...example.matchAll(/^#?\s*(TAKOSUMI_[A-Z0-9_]+)=/gmu)]
    .map((match) => match[1]!)
    .filter((key) => key !== "TAKOSUMI_ACCOUNTS_PUBLIC_HOSTNAME");
  for (const key of serviceSettings) {
    expect(accounts.environment?.[key]).toBeDefined();
    if (key !== "TAKOSUMI_ACCOUNTS_DATABASE_URL") {
      expect(accounts.environment?.[key]).toStartWith(`\u0024{${key}:-`);
    }
  }
  expect(accounts.depends_on?.migrations?.condition).toBe(
    "service_completed_successfully",
  );
});

test(".env.example declares every secret the composed server reads at boot", async () => {
  const example = await read("deploy/node-postgres/.env.example");
  const entries = new Map(
    [...example.matchAll(/^([A-Z][A-Z0-9_]*)=(.*)$/gmu)].map((match) => [
      match[1]!,
      match[2]!,
    ]),
  );
  for (const key of [
    "POSTGRES_PASSWORD",
    "TAKOSUMI_ACCOUNTS_ISSUER",
    "TAKOSUMI_ACCOUNTS_PUBLIC_HOSTNAME",
    "TAKOSUMI_ACCOUNTS_ES256_PRIVATE_JWK",
    "TAKOSUMI_ACCOUNTS_OIDC_PAIRWISE_SUBJECT_SECRET",
    "TAKOSUMI_ACCOUNT_SESSION_HASH_SALT",
    "TAKOSUMI_SECRET_STORE_PASSPHRASE",
    "TAKOSUMI_DEPLOY_CONTROL_TOKEN",
  ]) {
    expect(entries.has(key)).toBe(true);
  }
  // A placeholder long enough to pass the 32-byte check would seal real
  // credentials under a published value; empty makes a forgotten key fail closed.
  expect(entries.get("TAKOSUMI_SECRET_STORE_PASSPHRASE")).toBe("");
});

test("self-host backup exports use a persistent private mount under the read-only runtime", async () => {
  const compose = parseYaml(await read("deploy/node-postgres/docker-compose.yml")) as {
    services: Record<string, { user?: string; read_only?: boolean; volumes?: string[]; environment?: Record<string, string> }>;
    volumes: Record<string, unknown>;
  };
  const accounts = compose.services.accounts!;
  expect(accounts.user).toBe("1000:1000");
  expect(accounts.read_only).toBe(true);
  expect(accounts.volumes).toContain("takosumi-runtime:/var/lib/takosumi");
  expect(compose.volumes).toHaveProperty("takosumi-runtime");
  expect(accounts.environment?.TAKOSUMI_BACKUP_ARTIFACTS_DIR).toBe("${TAKOSUMI_BACKUP_ARTIFACTS_DIR:-/var/lib/takosumi/backups}");
  const runtime = stage(await read("deploy/node-postgres/Dockerfile"), "final");
  expect(runtime).toContain("mkdir -p /var/lib/takosumi/backups");
  expect(runtime).toContain("chown -R bun:bun /var/lib/takosumi");
  expect(runtime).toContain("chmod 0700 /var/lib/takosumi /var/lib/takosumi/backups");
});

test("self-host docs only run package scripts that exist", async () => {
  const rootPackage = JSON.parse(await read("package.json")) as {
    scripts: Record<string, string>;
  };
  const docs = [
    "README.md",
    "README.en.md",
    "docs/getting-started/quickstart.md",
    "docs/en/getting-started/quickstart.md",
    "docs/concepts/self-host.md",
    "docs/en/concepts/self-host.md",
    "docs/self-host/index.md",
    "docs/self-host/cloudflare.md",
    "docs/self-host/bun-postgres.md",
    "docs/self-host/upgrade.md",
    "docs/self-host/backup-restore.md",
    "docs/self-host/troubleshooting.md",
    "docs/en/self-host/index.md",
    "docs/en/self-host/cloudflare.md",
    "docs/en/self-host/bun-postgres.md",
    "docs/en/self-host/upgrade.md",
    "docs/en/self-host/backup-restore.md",
    "docs/en/self-host/troubleshooting.md",
    "docs/reference/cli.md",
    "docs/en/reference/cli.md",
    "deploy/node-postgres/README.md",
    "docs/operations/platform-worker-deploy.md",
  ];
  const missing: string[] = [];
  for (const doc of docs) {
    const text = await read(doc);
    for (const match of text.matchAll(/\bbun run ([a-z][\w:-]*)/gu)) {
      if (!(match[1]! in rootPackage.scripts)) missing.push(`${doc}: ${match[1]}`);
    }
  }
  expect(missing).toEqual([]);
  // The dashboard is not a root workspace; the documented build must install it.
  expect(rootPackage.scripts["build:dashboard"]).toContain(
    "cd dashboard && bun install --frozen-lockfile",
  );
});
