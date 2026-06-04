import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import process from "node:process";

const cloudflareRoot = new URL("../", import.meta.url);
const defaultInput = new URL("wrangler.toml", cloudflareRoot);
const defaultOutput = new URL(
  ".wrangler/takosumi-accounts.deploy.toml",
  cloudflareRoot,
);
const workerBundle = new URL(
  ".wrangler/dist/takosumi-accounts-worker.mjs",
  cloudflareRoot,
);
// Bundled dashboard SPA build (Workers Static Assets). Like `main`, the
// `[assets].directory` value is rewritten to be relative to the rendered
// config's location so `wrangler deploy --config .wrangler/...` resolves it.
const dashboardAssets = new URL(
  "../../packages/dashboard-ui/.output/public",
  cloudflareRoot,
);

// Environment profile selects which [vars] block is "in scope" for validation.
//   --env production: strict — every production-facing var must be a non-empty,
//                     non-placeholder value. Default.
//   --env staging:    strict — same checks as production; only routes / names
//                     differ at the wrangler.toml [env.staging] level.
//   --env local:      lenient — workers_dev defaults are accepted and the
//                     deploy control URL / database id requirement is dropped so
//                     `wrangler dev --env local` can run against a local
//                     substrate stack without operator secrets.
type DeployEnv = "production" | "staging" | "local";

interface Options {
  readonly databaseId: string;
  readonly deployControlUrl: string;
  readonly input: string;
  readonly output: string;
  readonly workersDev: boolean;
  readonly keepRoutes: boolean;
  readonly env: DeployEnv;
}

function parseArgs(args: string[], env = process.env): Options {
  let databaseId = env.TAKOSUMI_ACCOUNTS_D1_DATABASE_ID ?? "";
  let deployControlUrl = env.TAKOSUMI_ACCOUNTS_DEPLOY_CONTROL_URL ?? "";
  let input = new URL(defaultInput).pathname;
  let output = new URL(defaultOutput).pathname;
  let workersDev = env.TAKOSUMI_ACCOUNTS_CLOUDFLARE_WORKERS_DEV === "1";
  let keepRoutes = env.TAKOSUMI_ACCOUNTS_CLOUDFLARE_KEEP_ROUTES === "1";
  let deployEnv: DeployEnv = parseDeployEnv(
    env.TAKOSUMI_ACCOUNTS_CLOUDFLARE_DEPLOY_ENV ?? "production",
  );

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") {
      continue;
    } else if (arg === "--database-id") {
      databaseId = requiredValue(args, ++index, arg);
    } else if (arg === "--deploy-control-url") {
      deployControlUrl = requiredValue(args, ++index, arg);
    } else if (arg === "--input") {
      input = resolve(requiredValue(args, ++index, arg));
    } else if (arg === "--output") {
      output = resolve(requiredValue(args, ++index, arg));
    } else if (arg === "--workers-dev") {
      workersDev = true;
      keepRoutes = false;
    } else if (arg === "--workers-dev-with-routes") {
      workersDev = true;
      keepRoutes = true;
    } else if (arg === "--custom-domain") {
      workersDev = false;
      keepRoutes = true;
    } else if (arg === "--env") {
      deployEnv = parseDeployEnv(requiredValue(args, ++index, arg));
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new TypeError(`Unknown option: ${arg}`);
    }
  }

  if (deployEnv === "local") {
    // Local profile: workers_dev defaults are fine; no real D1 / deployControl
    // required for `wrangler dev --env local`.
    if (databaseId && (!validUuid(databaseId) || placeholderUuid(databaseId))) {
      throw new TypeError(
        "If --database-id is supplied in local mode it must still be a non-placeholder D1 UUID.",
      );
    }
    if (deployControlUrl && !validUrl(deployControlUrl)) {
      throw new TypeError(
        "If --deploy-control-url is supplied in local mode it must still be a valid URL.",
      );
    }
  } else {
    if (!validUuid(databaseId) || placeholderUuid(databaseId)) {
      throw new TypeError(
        `A real non-placeholder D1 database UUID is required for --env ${deployEnv}. Pass --database-id or set TAKOSUMI_ACCOUNTS_D1_DATABASE_ID.`,
      );
    }
    if (!validUrl(deployControlUrl) || placeholderUrl(deployControlUrl)) {
      throw new TypeError(
        `A real non-placeholder Takosumi deploy control URL is required for --env ${deployEnv}. Pass --deploy-control-url or set TAKOSUMI_ACCOUNTS_DEPLOY_CONTROL_URL.`,
      );
    }
  }

  return {
    databaseId,
    deployControlUrl,
    input,
    output,
    workersDev,
    keepRoutes,
    env: deployEnv,
  };
}

function parseDeployEnv(value: string): DeployEnv {
  if (value === "production" || value === "staging" || value === "local") {
    return value;
  }
  throw new TypeError(
    `--env must be one of: production, staging, local (received: ${value})`,
  );
}

function requiredValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (!value || value.startsWith("--")) {
    throw new TypeError(`${flag} requires a value`);
  }
  return value;
}

function validUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .test(value);
}

// Reject obvious placeholder UUIDs. A real D1 UUID returned by
// `wrangler d1 create` is uniformly distributed; the following patterns are
// almost always template or hand-typed placeholders and must never reach a
// rendered deploy config:
//   - all hex digits identical (e.g. 00000000-..., ffffffff-...)
//   - canonical "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" template literal
//   - the well-known stub 12345678-1234-4123-8123-123456789012
//   - low-entropy sequences (e.g. only 0/1/x characters across the UUID)
//   - any UUID where one hex character makes up more than half of all hex
//     positions ("looks like a placeholder" heuristic)
function placeholderUuid(value: string): boolean {
  const lowered = value.toLowerCase();
  const literalPlaceholders = new Set<string>([
    "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
    "00000000-0000-0000-0000-000000000000",
    "11111111-1111-4111-8111-111111111111",
    "12345678-1234-4123-8123-123456789012",
    "12345678-1234-1234-1234-123456789012",
    "deadbeef-dead-beef-dead-beefdeadbeef",
  ]);
  if (literalPlaceholders.has(lowered)) return true;
  const normalized = lowered.replaceAll("-", "");
  // All-same character (e.g. all zeros, all ones, all x). The strict UUIDv4
  // regex would already reject all-x, but the loose canonical placeholder
  // form is still common in templates and we want a clear placeholder error.
  if (new Set(normalized).size === 1) return true;
  // Low-entropy set of only placeholder-class characters.
  const placeholderCharSet = new Set(["0", "1", "x"]);
  if (
    normalized.length > 0 &&
    [...normalized].every((char) => placeholderCharSet.has(char))
  ) {
    return true;
  }
  // One character dominates more than half of the UUID.
  const counts = new Map<string, number>();
  for (const char of normalized) {
    counts.set(char, (counts.get(char) ?? 0) + 1);
  }
  for (const count of counts.values()) {
    if (count > normalized.length / 2) return true;
  }
  return false;
}

function validUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function placeholderUrl(value: string): boolean {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host === "localhost" ||
      host.endsWith(".localhost") ||
      host === "example.com" ||
      host.endsWith(".example.com") ||
      host === "example.test" ||
      host.endsWith(".example.test") ||
      host === "test" ||
      host.endsWith(".test");
  } catch {
    return true;
  }
}

// Env-aware substitution.
//
// `wrangler.toml` carries one shared top-level `[vars]` block and three
// per-environment `[env.<production|staging|local>.vars]` overrides. The
// `TAKOSUMI_ACCOUNTS_DEPLOY_CONTROL_URL = ""` placeholder appears in every block
// because each environment may target a different deployControl host. A naive
// `.replace(/TAKOSUMI_ACCOUNTS_DEPLOY_CONTROL_URL = "[^"]*"/, ...)` only replaces
// the first match, leaving the other env blocks with the empty placeholder,
// which then fails validation.
//
// The substitution rule is:
//   - When `--env production`, replace the top-level `[vars]` value AND the
//     `[env.production.vars]` value so `wrangler deploy` and
//     `wrangler deploy --env production` both ship the same configured URL.
//   - When `--env staging`, replace ONLY the `[env.staging.vars]` value so
//     production / local stay at whatever the template defines and the
//     staging deploy is the only one that picks up the supplied URL.
//   - When `--env local`, replace ONLY the `[env.local.vars]` value (this
//     keeps `wrangler dev --env local` honest about the local profile and
//     never bleeds an operator-supplied URL into production blocks).
//
// `database_id` only appears once in the top-level `[[d1_databases]]` block
// (D1 bindings are shared across all wrangler envs), so we still use the
// single-match replace for it.
function renderConfig(source: string, options: Options): string {
  let rendered = source;
  if (options.databaseId) {
    rendered = rendered.replace(
      /database_id = "[^"]+"/,
      `database_id = "${options.databaseId}"`,
    );
  }
  if (options.deployControlUrl) {
    rendered = substituteDeployControlUrl(
      rendered,
      options.env,
      options.deployControlUrl,
    );
  }

  rendered = rendered.replace(
    /main = "[^"]+"/,
    `main = "${
      relative(dirname(options.output), workerBundle.pathname).replaceAll(
        "\\",
        "/",
      )
    }"`,
  );

  // wrangler runs the [build] custom command from the wrangler INVOCATION cwd
  // (not the config dir), while the command's relative paths (src/worker.ts,
  // .wrangler/dist) are written relative to the input config dir. Prefix the
  // command with an absolute `cd` into that dir so it works regardless of where
  // wrangler is invoked. Without this the custom build fails with
  // `FileNotFound opening root directory "src"`.
  const buildDir = dirname(resolve(options.input)).replaceAll("\\", "/");
  rendered = rendered.replace(
    /command = '([^']*)'/,
    (_match, command: string) =>
      command.includes(`cd ${buildDir} &&`)
        ? `command = '${command}'`
        : `command = 'cd ${buildDir} && ${command}'`,
  );

  const assetsDirectory = relative(
    dirname(options.output),
    dashboardAssets.pathname,
  ).replaceAll("\\", "/");
  rendered = rendered.replace(
    /directory = "[^"]+"/,
    `directory = "${assetsDirectory}"`,
  );
  if (!rendered.includes(`directory = "${assetsDirectory}"`)) {
    throw new TypeError(
      `render-config: failed to rewrite [assets].directory to "${assetsDirectory}" — no directory entry matched the template`,
    );
  }

  if (
    options.env !== "local" &&
    !rendered.includes(`database_id = "${options.databaseId}"`)
  ) {
    throw new TypeError(
      "Could not replace d1_databases.database_id in wrangler config",
    );
  }
  if (
    options.env !== "local" &&
    !deployControlUrlMatchesScopedBlocks(
      rendered,
      options.env,
      options.deployControlUrl,
    )
  ) {
    throw new TypeError(
      `Could not replace TAKOSUMI_ACCOUNTS_DEPLOY_CONTROL_URL for --env ${options.env} in wrangler config`,
    );
  }

  if (options.workersDev) {
    rendered = rendered.replace(
      /workers_dev = (true|false)/,
      "workers_dev = true",
    );
  } else {
    rendered = rendered.replace(
      /workers_dev = (true|false)/,
      "workers_dev = false",
    );
  }

  if (!options.keepRoutes) {
    rendered = rendered.replace(
      /\n\[\[routes\]\]\n[\s\S]*?(?=\n\[build\])/,
      "",
    );
  } else {
    if (!rendered.includes("[[routes]]")) {
      throw new TypeError(
        "Custom-domain config requires a [[routes]] block in the input wrangler config",
      );
    }
  }

  if (options.env !== "local") {
    enforceProductionFacingVars(rendered, options.env);
  }

  return rendered;
}

// Names of TOML sections that hold per-env vars. The top-level `[vars]` is
// treated as the production shared default.
const ENV_VAR_SECTIONS: Readonly<Record<DeployEnv, readonly string[]>> = {
  production: ["[vars]", "[env.production.vars]"],
  staging: ["[env.staging.vars]"],
  local: ["[env.local.vars]"],
};

// Replace `TAKOSUMI_ACCOUNTS_DEPLOY_CONTROL_URL = "<old>"` only inside the var
// sections owned by `env`. Other env blocks keep their template values.
function substituteDeployControlUrl(
  source: string,
  env: DeployEnv,
  deployControlUrl: string,
): string {
  const sections = ENV_VAR_SECTIONS[env];
  let rewritten = source;
  for (const header of sections) {
    rewritten = replaceVarInSection(
      rewritten,
      header,
      "TAKOSUMI_ACCOUNTS_DEPLOY_CONTROL_URL",
      deployControlUrl,
    );
  }
  return rewritten;
}

function deployControlUrlMatchesScopedBlocks(
  rendered: string,
  env: DeployEnv,
  deployControlUrl: string,
): boolean {
  const sections = ENV_VAR_SECTIONS[env];
  for (const header of sections) {
    const value = readVarInSection(
      rendered,
      header,
      "TAKOSUMI_ACCOUNTS_DEPLOY_CONTROL_URL",
    );
    if (value !== deployControlUrl) return false;
  }
  return true;
}

// Replace a single `<key> = "<old>"` line only inside the TOML section that
// starts at `header` (e.g. `[env.staging.vars]`) and extends until the next
// `[`-prefixed section header or end of file. Returns the source unchanged
// when the section is missing or the key is not present in that section.
function replaceVarInSection(
  source: string,
  header: string,
  key: string,
  value: string,
): string {
  const section = locateSection(source, header);
  if (!section) return source;
  const keyPattern = new RegExp(`(^|\\n)${escapeRegExp(key)}\\s*=\\s*"[^"]*"`);
  const within = source.slice(section.start, section.end);
  const replaced = within.replace(
    keyPattern,
    (_match, leading: string) => `${leading}${key} = "${value}"`,
  );
  if (replaced === within) return source;
  return `${source.slice(0, section.start)}${replaced}${
    source.slice(section.end)
  }`;
}

function readVarInSection(
  source: string,
  header: string,
  key: string,
): string | undefined {
  const section = locateSection(source, header);
  if (!section) return undefined;
  const within = source.slice(section.start, section.end);
  const match = new RegExp(`(?:^|\\n)${escapeRegExp(key)}\\s*=\\s*"([^"]*)"`)
    .exec(within);
  return match ? match[1] : undefined;
}

interface SectionBounds {
  readonly start: number;
  readonly end: number;
}

function locateSection(
  source: string,
  header: string,
): SectionBounds | undefined {
  const headerIndex = source.indexOf(header);
  if (headerIndex < 0) return undefined;
  const after = headerIndex + header.length;
  // The next section starts at the first `\n[` after the header. Use that as
  // the end boundary so per-section replacements never leak across blocks.
  const next = source.indexOf("\n[", after);
  return {
    start: headerIndex,
    end: next < 0 ? source.length : next,
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Production-facing keys whose top-level [vars] entry must be a non-empty,
// non-placeholder string before the rendered config can ship to a real
// account-plane Worker. Local profile may leave some of these empty because
// `wrangler dev --env local` overlays the [env.local.vars] block.
const PRODUCTION_REQUIRED_VARS: readonly string[] = [
  "TAKOSUMI_ACCOUNTS_ISSUER",
  "TAKOSUMI_ACCOUNTS_CLIENT_ID",
  "TAKOSUMI_ACCOUNTS_REDIRECT_URIS",
  "TAKOSUMI_ACCOUNTS_MANAGED_OFFERING_ACCESS",
  "TAKOSUMI_ACCOUNTS_DEPLOY_CONTROL_URL",
];

function enforceProductionFacingVars(
  rendered: string,
  deployEnv: DeployEnv,
): void {
  const errors: string[] = [];
  // For production we want both the top-level [vars] block (which `wrangler
  // deploy` selects by default) and [env.production.vars] (selected by
  // `wrangler deploy --env production`) to contain real values. For staging
  // we only require [env.staging.vars]; the top-level block is the
  // production-shaped default and is checked under --env production. Local
  // never reaches this function.
  const sections = ENV_VAR_SECTIONS[deployEnv];
  for (const header of sections) {
    const section = locateSection(rendered, header);
    if (!section) {
      errors.push(
        `${header} section is missing in rendered wrangler config`,
      );
      continue;
    }
    for (const key of PRODUCTION_REQUIRED_VARS) {
      const value = readVarInSection(rendered, header, key);
      if (value === undefined) {
        errors.push(
          `${header}.${key} is missing for --env ${deployEnv}`,
        );
        continue;
      }
      if (value.trim().length === 0) {
        errors.push(
          `${header}.${key} must be a non-empty string for --env ${deployEnv}`,
        );
      }
    }
    const issuer = readVarInSection(
      rendered,
      header,
      "TAKOSUMI_ACCOUNTS_ISSUER",
    );
    if (issuer && placeholderUrl(issuer)) {
      errors.push(
        `${header}.TAKOSUMI_ACCOUNTS_ISSUER must not be a placeholder host for --env ${deployEnv}`,
      );
    }
    const redirects = readVarInSection(
      rendered,
      header,
      "TAKOSUMI_ACCOUNTS_REDIRECT_URIS",
    );
    if (redirects) {
      for (
        const candidate of redirects.split(/[,\s]+/u).map((value) =>
          value.trim()
        ).filter((value) => value.length > 0)
      ) {
        if (!validUrl(candidate)) {
          errors.push(
            `${header}.TAKOSUMI_ACCOUNTS_REDIRECT_URIS contains a non-URL value (${candidate})`,
          );
        } else if (placeholderUrl(candidate)) {
          errors.push(
            `${header}.TAKOSUMI_ACCOUNTS_REDIRECT_URIS must not use placeholder hosts for --env ${deployEnv} (${candidate})`,
          );
        }
      }
    }
  }
  if (errors.length > 0) {
    throw new TypeError(
      `render-config refused to write --env ${deployEnv} config:\n  - ${
        errors.join("\n  - ")
      }`,
    );
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const source = await readFile(options.input, "utf8");
  const rendered = renderConfig(source, options);
  await mkdir(dirname(options.output), { recursive: true });
  await writeFile(options.output, rendered);
  console.log(JSON.stringify({
    ok: true,
    output: options.output,
    deployControlUrlConfigured: options.env === "local"
      ? Boolean(options.deployControlUrl)
      : true,
    workersDev: options.workersDev,
    keepRoutes: options.keepRoutes,
    env: options.env,
  }));
}

function printHelp(): void {
  console.log(
    `Usage: bun run deploy:accounts-cloudflare:render-config -- [options]

Options:
  --database-id <uuid>  D1 database UUID. Defaults to TAKOSUMI_ACCOUNTS_D1_DATABASE_ID.
  --deploy-control-url <url> Takosumi deployControl base URL. Defaults to TAKOSUMI_ACCOUNTS_DEPLOY_CONTROL_URL.
  --output <path>      Rendered wrangler config path.
  --workers-dev        Render for a closed Workers.dev bootstrap deploy.
  --workers-dev-with-routes
                       Render with Workers.dev enabled and custom-domain routes kept.
  --custom-domain      Render for the tracked accounts.takosumi.com route.
  --env <profile>      Deploy profile: production (default) | staging | local.
                       Production and staging enforce non-empty real vars;
                       local accepts workers_dev defaults.
`,
  );
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
