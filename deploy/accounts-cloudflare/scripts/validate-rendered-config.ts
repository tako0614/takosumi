import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

const defaultConfig = new URL(
  "../.wrangler/takosumi-accounts.deploy.toml",
  import.meta.url,
);

// Which deploy profile the rendered config targets. Validation walks only
// the sections that wrangler will actually serve for that profile.
//   - production: top-level `[vars]` + `[env.production.vars]`
//   - staging:    `[env.staging.vars]` only (top-level `[vars]` is the
//                 production-shaped default and is allowed to keep template
//                 values when only a staging rollout is in flight)
//   - local:      `[env.local.vars]` only, and placeholder hostnames /
//                 missing deploy control URL are tolerated (workers_dev defaults)
type DeployEnv = "production" | "staging" | "local";

interface Options {
  readonly config: string;
  readonly env: DeployEnv;
}

interface ValidationDetails {
  readonly configDigest: string;
  readonly mainPointsAtWorkerBundle: boolean;
  readonly managedOfferingAccessClosed: boolean;
  readonly d1BindingPresent: boolean;
  readonly d1DatabaseBlockPresent: boolean;
  readonly d1DatabaseIdPresent: boolean;
  readonly d1DatabaseIdValid: boolean;
  readonly d1DatabaseIdPlaceholder: boolean;
  readonly r2BindingPresent: boolean;
  readonly r2BucketBlockPresent: boolean;
  readonly assetsConfigured: boolean;
  readonly deployControlUrlPresent: boolean;
  readonly deployControlUrlValid: boolean;
  readonly deployControlUrlPlaceholder: boolean;
  readonly containerConfigured: boolean;
  readonly durableObjectPersistenceConfigured: boolean;
  readonly workersDev: boolean | null;
  readonly routeConfigured: boolean;
  readonly productionFacingVarsPresent: boolean;
  readonly missingProductionFacingVars: readonly string[];
}

interface ValidationReport extends ValidationDetails {
  readonly kind: "takosumi.cloudflare-rendered-config-validation@v1";
  readonly ok: boolean;
  readonly config: string;
  readonly errors: string[];
}

function parseArgs(args: string[]): Options {
  let config = defaultConfig.pathname;
  let env: DeployEnv = parseDeployEnv(
    readDeployEnvFromEnvironment() ?? "production",
  );
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") {
      continue;
    } else if (arg === "--config") {
      config = resolve(requiredValue(args, ++index, arg));
    } else if (arg === "--env") {
      env = parseDeployEnv(requiredValue(args, ++index, arg));
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new TypeError(`Unknown option: ${arg}`);
    }
  }
  return { config, env };
}

function parseDeployEnv(value: string): DeployEnv {
  if (value === "production" || value === "staging" || value === "local") {
    return value;
  }
  throw new TypeError(
    `--env must be one of: production, staging, local (received: ${value})`,
  );
}

function readDeployEnvFromEnvironment(): string | undefined {
  const value = process.env.TAKOSUMI_ACCOUNTS_CLOUDFLARE_DEPLOY_ENV;
  return value && value.length > 0 ? value : undefined;
}

function requiredValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (!value || value.startsWith("--")) {
    throw new TypeError(`${flag} requires a value`);
  }
  return value;
}

// Production-facing keys that must be present and non-empty in the rendered
// [vars] block before a real account-plane deploy can ship. The render
// pipeline rejects empty values for these keys when --env production /
// staging is selected; validate-rendered-config is the last-line gate that
// also rejects an operator hand-edit which removed one of them.
const PRODUCTION_FACING_VAR_KEYS: readonly string[] = [
  "TAKOSUMI_ACCOUNTS_ISSUER",
  "TAKOSUMI_ACCOUNTS_CLIENT_ID",
  "TAKOSUMI_ACCOUNTS_REDIRECT_URIS",
  "TAKOSUMI_ACCOUNTS_MANAGED_OFFERING_ACCESS",
  "TAKOSUMI_ACCOUNTS_DEPLOY_CONTROL_URL",
];

// Each TOML var section that wrangler may select per deploy profile.
//   - production: top-level `[vars]` + `[env.production.vars]` so that
//                 `wrangler deploy` and `wrangler deploy --env production`
//                 both ship the same configured values.
//   - staging:    only `[env.staging.vars]` is required. The top-level
//                 `[vars]` block remains the production-shaped default and is
//                 not gated for a staging-only render.
//   - local:      validation skips var checks entirely (local profiles may
//                 carry workers_dev / `.test` hostname defaults).
const PRODUCTION_FACING_VAR_SECTIONS: Readonly<
  Record<DeployEnv, readonly string[]>
> = {
  production: ["[vars]", "[env.production.vars]"],
  staging: ["[env.staging.vars]"],
  local: [],
};

function inspectRenderedConfig(
  source: string,
  env: DeployEnv,
): ValidationDetails {
  const databaseId = configString(source, "database_id");
  // For env-scoped lookups (deploy control URL / managed offering access) prefer
  // the value from the env's first selected block. This keeps a
  // staging-only render honest: `[vars]` may legitimately stay empty in a
  // staging-only deploy as long as `[env.staging.vars]` is fully populated.
  const deployControlUrl = readScopedVar(
    source,
    env,
    "TAKOSUMI_ACCOUNTS_DEPLOY_CONTROL_URL",
  );
  const managedOfferingAccess = readScopedVar(
    source,
    env,
    "TAKOSUMI_ACCOUNTS_MANAGED_OFFERING_ACCESS",
  );
  const workersDev = configBoolean(source, "workers_dev");
  // Walk every production-facing var section selected by the target deploy
  // profile so that an operator hand-edit which empties out one of the
  // wrangler-served blocks still fails the gate. The missing key list is
  // formatted as "<section>.<key>" so the operator can tell which block
  // needs to be refilled.
  const missingProductionFacingVars: string[] = [];
  for (const header of PRODUCTION_FACING_VAR_SECTIONS[env]) {
    const section = sliceSection(source, header);
    if (section === undefined) {
      for (const key of PRODUCTION_FACING_VAR_KEYS) {
        missingProductionFacingVars.push(`${header}.${key}`);
      }
      continue;
    }
    for (const key of PRODUCTION_FACING_VAR_KEYS) {
      const value = configString(section, key);
      if (!value || value.trim().length === 0) {
        missingProductionFacingVars.push(`${header}.${key}`);
      }
    }
  }
  return {
    configDigest: `sha256:${createHash("sha256").update(source).digest("hex")}`,
    mainPointsAtWorkerBundle:
      /main = "[^"]*takosumi-accounts-worker\.mjs"/.test(source),
    managedOfferingAccessClosed: managedOfferingAccess === "closed",
    d1BindingPresent: source.includes('binding = "TAKOSUMI_ACCOUNTS_DB"'),
    d1DatabaseBlockPresent: /^\[\[d1_databases\]\]/m.test(source),
    d1DatabaseIdPresent: Boolean(databaseId),
    d1DatabaseIdValid: databaseId ? validUuid(databaseId) : false,
    d1DatabaseIdPlaceholder: databaseId ? placeholderUuid(databaseId) : false,
    r2BindingPresent: source.includes('binding = "TAKOSUMI_ACCOUNTS_EXPORTS"'),
    r2BucketBlockPresent: /^\[\[r2_buckets\]\]/m.test(source),
    assetsConfigured: /^\[assets\]/m.test(source) &&
      source.includes('binding = "ASSETS"'),
    deployControlUrlPresent: Boolean(deployControlUrl),
    deployControlUrlValid: deployControlUrl ? validUrl(deployControlUrl) : false,
    deployControlUrlPlaceholder: deployControlUrl
      ? placeholderUrl(deployControlUrl)
      : false,
    containerConfigured: /^\[\[containers\]\]/m.test(source),
    durableObjectPersistenceConfigured: /^\[\[durable_objects\.bindings\]\]/m
      .test(source),
    workersDev,
    routeConfigured: /^\[\[routes\]\]/m.test(source),
    productionFacingVarsPresent: missingProductionFacingVars.length === 0,
    missingProductionFacingVars,
  };
}

function validateRenderedConfig(details: ValidationDetails): string[] {
  const errors: string[] = [];
  if (!details.d1DatabaseIdPresent) {
    errors.push("d1_databases.database_id is required");
  } else if (details.d1DatabaseIdPlaceholder) {
    errors.push("d1_databases.database_id must not be a placeholder UUID");
  } else if (!details.d1DatabaseIdValid) {
    errors.push("d1_databases.database_id must be a D1 UUID");
  }

  if (!details.deployControlUrlPresent) {
    errors.push("TAKOSUMI_ACCOUNTS_DEPLOY_CONTROL_URL is required");
  } else if (!details.deployControlUrlValid) {
    errors.push("TAKOSUMI_ACCOUNTS_DEPLOY_CONTROL_URL must be a URL");
  } else if (details.deployControlUrlPlaceholder) {
    errors.push(
      "TAKOSUMI_ACCOUNTS_DEPLOY_CONTROL_URL must not use example, test, or localhost hosts",
    );
  }

  if (!details.managedOfferingAccessClosed) {
    errors.push(
      'TAKOSUMI_ACCOUNTS_MANAGED_OFFERING_ACCESS must remain "closed" in deploy config; open access is supplied only by the final audited serve args',
    );
  }
  if (!details.d1BindingPresent) {
    errors.push("TAKOSUMI_ACCOUNTS_DB D1 binding is required");
  }
  if (!details.r2BindingPresent) {
    errors.push("TAKOSUMI_ACCOUNTS_EXPORTS R2 binding is required");
  }
  if (!details.d1DatabaseBlockPresent) {
    errors.push("[[d1_databases]] block is required");
  }
  if (!details.r2BucketBlockPresent) {
    errors.push("[[r2_buckets]] block is required");
  }
  if (!details.assetsConfigured) {
    errors.push(
      '[assets] with binding = "ASSETS" is required to serve the dashboard SPA from the Worker',
    );
  }
  if (details.containerConfigured) {
    errors.push("Cloudflare Containers must not be configured for Accounts");
  }
  if (details.durableObjectPersistenceConfigured) {
    errors.push(
      "Durable Objects must not be configured for Accounts persistence",
    );
  }
  if (!details.mainPointsAtWorkerBundle) {
    errors.push("main must point at the bundled Accounts Worker module");
  }
  if (!details.productionFacingVarsPresent) {
    errors.push(
      `Production-facing var blocks are missing required keys: ${
        details.missingProductionFacingVars.join(", ")
      }`,
    );
  }
  return errors;
}

function configString(source: string, key: string): string | undefined {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = source.match(new RegExp(`${escaped}\\s*=\\s*"([^"]*)"`));
  return match?.[1]?.trim() || undefined;
}

// Return the substring that belongs to the TOML section that starts at the
// given header (e.g. `[vars]`, `[env.production.vars]`). The section extends
// until the next `\n[`-prefixed header or end of file. Returns undefined when
// the header is not present.
function sliceSection(source: string, header: string): string | undefined {
  const headerIndex = source.indexOf(header);
  if (headerIndex < 0) return undefined;
  const after = headerIndex + header.length;
  const next = source.indexOf("\n[", after);
  return source.slice(headerIndex, next < 0 ? source.length : next);
}

// Read a `key = "value"` entry by walking the env's selected sections in
// order. Returns the first non-empty value found. For local (no scoped
// sections) we fall back to the top-level `[vars]` so `wrangler dev
// --env local` users still get the shared default for fields that don't
// have a local override.
function readScopedVar(
  source: string,
  env: DeployEnv,
  key: string,
): string | undefined {
  const sections = PRODUCTION_FACING_VAR_SECTIONS[env];
  const lookup = sections.length > 0 ? sections : ["[vars]"];
  for (const header of lookup) {
    const section = sliceSection(source, header);
    if (!section) continue;
    const value = configString(section, key);
    if (value && value.length > 0) return value;
  }
  return undefined;
}

function configBoolean(source: string, key: string): boolean | null {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = source.match(new RegExp(`${escaped}\\s*=\\s*(true|false)`));
  return match?.[1] === "true" ? true : match?.[1] === "false" ? false : null;
}

function validUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .test(value);
}

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
  if (new Set(normalized).size === 1) return true;
  const placeholderCharSet = new Set(["0", "1", "x"]);
  if (
    normalized.length > 0 &&
    [...normalized].every((char) => placeholderCharSet.has(char))
  ) {
    return true;
  }
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

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const source = await readFile(options.config, "utf8");
  const details = inspectRenderedConfig(source, options.env);
  const errors = validateRenderedConfig(details);
  const report: ValidationReport = {
    kind: "takosumi.cloudflare-rendered-config-validation@v1",
    ok: errors.length === 0,
    config: options.config,
    errors,
    ...details,
  };
  console.log(JSON.stringify(report, null, 2));
  if (errors.length > 0) {
    process.exit(1);
  }
}

function printHelp(): void {
  console.log(
    `Usage: bun run deploy:accounts-cloudflare:validate-config -- [options]

Options:
  --config <path>  Rendered wrangler config path.
  --env <profile>  Deploy profile: production (default) | staging | local.
                   Selects which [vars] / [env.<profile>.vars] sections are
                   walked for production-facing key presence. Also reads
                   TAKOSUMI_ACCOUNTS_CLOUDFLARE_DEPLOY_ENV.
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
