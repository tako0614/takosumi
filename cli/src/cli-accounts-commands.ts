import {
  normalizeIssuer,
  TAKOSUMI_ACCOUNTS_ACCOUNT_TOKENS_PATH,
  takosumiAccountsAccountTokenRevokePath,
  type TakosumiSubject,
} from "@takosjp/takosumi-accounts-contract";
import {
  createEphemeralAccountsHandler,
  InMemoryAccountsStore,
} from "@takosjp/takosumi-accounts-service";
import {
  accountsMigrateD1HelpText,
  accountsMigrateHelpText,
  accountsSeedHelpText,
  accountsServeHelpText,
  accountsTokensCreateHelpText,
  accountsTokensHelpText,
  accountsTokensListHelpText,
  accountsTokensRevokeHelpText,
} from "./cli-help.ts";
import {
  booleanOption,
  integerOption,
  optionalStringOption,
  parseOptions,
  stringOption,
} from "./cli-options.ts";
import { splitCsv } from "./cli-util.ts";
import {
  accountsTokenCreateBody,
  requestAccountsApi,
} from "./cli-accounts-api.ts";
import {
  type AccountsDatabaseConfig,
  accountsMigratePlan,
  type AccountsStoreResource,
  applyAccountsMigrations,
  applyD1AccountsMigrations,
  buildAccountsDatabaseConfig,
  createAccountsStoreResource,
  type D1ExecuteCommand,
  loadAccountsMigrations,
} from "./cli-accounts-db.ts";
import {
  buildPasskeyOptions,
  buildUpstreamOAuthOptions,
} from "./cli-accounts-auth.ts";
import {
  formatAccountsTokenCreate,
  formatAccountsTokenRevoke,
  formatAccountsTokensList,
} from "./cli-format.ts";
import type { CliIo } from "./cli-io.ts";

export interface AccountsSeedPlan {
  kind: "takosumi.accounts.seed@v1";
  issuer: string;
  subject: TakosumiSubject;
  oidcClient: {
    clientId: string;
    redirectUris: readonly string[];
  };
}

export function runAccountsSeed(args: string[], io: CliIo): number {
  const options = parseOptions(args);
  if (options.help) {
    io.stdout(accountsSeedHelpText());
    return 0;
  }

  let plan;
  try {
    plan = buildAccountsSeedPlan(options);
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    return 2;
  }

  io.stdout(JSON.stringify(plan, null, 2));
  return 0;
}

export async function runAccountsMigrate(
  args: string[],
  io: CliIo,
): Promise<number> {
  const options = parseOptions(args);
  if (options.help) {
    io.stdout(accountsMigrateHelpText());
    return 0;
  }

  let databaseConfig;
  try {
    databaseConfig = await buildAccountsDatabaseConfig(options);
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    return 2;
  }
  if (!databaseConfig && !booleanOption(options, "dryRun")) {
    io.stderr("--database-url or TAKOSUMI_ACCOUNTS_DATABASE_URL is required");
    return 2;
  }

  let migrations;
  try {
    migrations = await loadAccountsMigrations();
  } catch (error) {
    io.stderr(
      `Failed to load Accounts migrations: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return 1;
  }

  if (booleanOption(options, "dryRun")) {
    io.stdout(
      JSON.stringify(accountsMigratePlan(databaseConfig, migrations), null, 2),
    );
    return 0;
  }

  try {
    const result = await applyAccountsMigrations(
      databaseConfig as AccountsDatabaseConfig,
      migrations,
    );
    io.stdout(`Takosumi Accounts migrations applied: ${result.applied.length}`);
    if (result.skipped.length > 0) {
      io.stdout(
        `Takosumi Accounts migrations skipped: ${result.skipped.length}`,
      );
    }
    return 0;
  } catch (error) {
    io.stderr(
      `Failed to apply Accounts migrations: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return 1;
  }
}

/**
 * Run the `accounts migrate-d1` subcommand.
 *
 * Translates CLI flags (`--database-id`, `--account-id`, `--dry-run`,
 * `--json`) into an `applyD1AccountsMigrations` call. The option name is
 * historical; Wrangler 4's `d1 execute` positional is a database name or
 * binding. Tests can substitute a different `D1ExecuteCommand` through the
 * optional second argument to keep the suite hermetic (the production code path
 * shells out to `bunx wrangler d1 execute`, which would hit the real Cloudflare
 * API).
 *
 * Exit codes:
 *   - 0 on success.
 *   - 1 on a wrangler failure or any unhandled error during apply.
 *   - 2 on missing or invalid flags.
 */
export async function runAccountsMigrateD1(
  args: string[],
  io: CliIo,
  injectedCommand?: D1ExecuteCommand,
): Promise<number> {
  const options = parseOptions(args);
  if (options.help) {
    io.stdout(accountsMigrateD1HelpText());
    return 0;
  }
  const databaseId = optionalStringOption(options, "databaseId");
  if (!databaseId) {
    io.stderr("--database-id is required");
    return 2;
  }
  const accountId = optionalStringOption(options, "accountId");
  const dryRun = booleanOption(options, "dryRun");
  // `--local`/`--remote` select the wrangler D1 target. `--remote` is the
  // default and is mutually exclusive with `--local`.
  const local = booleanOption(options, "local");
  if (local && booleanOption(options, "remote")) {
    io.stderr("--local and --remote are mutually exclusive");
    return 2;
  }
  const env = optionalStringOption(options, "env");
  const wranglerConfig = optionalStringOption(options, "wranglerConfig");
  try {
    const report = await applyD1AccountsMigrations({
      databaseId,
      ...(accountId ? { accountId } : {}),
      dryRun,
      ...(local ? { target: "local" as const } : {}),
      ...(env ? { env } : {}),
      ...(wranglerConfig ? { wranglerConfig } : {}),
      ...(injectedCommand ? { command: injectedCommand } : {}),
    });
    if (dryRun || booleanOption(options, "json")) {
      io.stdout(JSON.stringify(report, null, 2));
    } else {
      io.stdout(
        `D1 migrations applied: ${report.applied.length} (skipped ${report.skipped.length}).`,
      );
    }
    return 0;
  } catch (error) {
    io.stderr(
      `Failed to apply D1 migrations: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return 1;
  }
}

export async function runAccountsServe(
  args: string[],
  io: CliIo,
): Promise<number> {
  const options = parseOptions(args);
  if (options.help) {
    io.stdout(accountsServeHelpText());
    return 0;
  }

  let seedPlan;
  try {
    seedPlan = buildAccountsSeedPlan(options);
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    return 2;
  }
  const hostname = stringOption(options, "hostname", "127.0.0.1");
  let port: number;
  try {
    port = integerOption(options, "port", 8787);
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    return 2;
  }
  let upstreamOAuth;
  try {
    upstreamOAuth = buildUpstreamOAuthOptions(options);
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    return 2;
  }
  let passkeys;
  try {
    passkeys = buildPasskeyOptions(options);
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    return 2;
  }
  let databaseConfig;
  try {
    databaseConfig = await buildAccountsDatabaseConfig(options);
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    return 2;
  }
  const devSessionId = optionalStringOption(options, "devSessionId");
  if (devSessionId && !devSessionId.startsWith("sess_")) {
    io.stderr("--dev-session-id must use the sess_ prefix");
    return 2;
  }
  if (devSessionId && databaseConfig) {
    io.stderr(
      "--dev-session-id is only supported with in-memory accounts serve",
    );
    return 2;
  }
  const servePlan = {
    kind: "takosumi.accounts.serve@v1",
    hostname,
    port,
    issuer: seedPlan.issuer,
    subject: seedPlan.subject,
    oidcClient: seedPlan.oidcClient,
    upstreamOAuth: upstreamOAuth
      ? {
          configured: true,
          providers: upstreamOAuth.providers.map(
            (provider) => provider.providerId,
          ),
          sessionTtlMs: upstreamOAuth.sessionTtlMs,
        }
      : { configured: false },
    passkeys: passkeys
      ? {
          configured: true,
          rpId: passkeys.rpId,
          rpName: passkeys.rpName,
          origin: passkeys.origin,
          sessionTtlMs: passkeys.sessionTtlMs,
        }
      : { configured: false },
    accountPlaneFacades: ["identity", "sessions", "OIDC", "PAT"],
    persistence: databaseConfig
      ? {
          configured: true,
          driver: "postgres",
          source: databaseConfig.source,
        }
      : {
          configured: false,
          driver: "memory",
        },
    devSession: {
      configured: Boolean(devSessionId),
    },
  };
  if (booleanOption(options, "dryRun")) {
    io.stdout(JSON.stringify(servePlan, null, 2));
    return 0;
  }

  let storeResource: AccountsStoreResource;
  try {
    storeResource = await createAccountsStoreResource(databaseConfig);
  } catch (error) {
    io.stderr(
      `Failed to initialize Accounts persistence: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return 1;
  }
  try {
    const accountsStore = storeResource.store ?? new InMemoryAccountsStore();
    if (devSessionId) {
      const now = Date.now();
      await accountsStore.saveAccount({
        subject: seedPlan.subject,
        createdAt: now,
        updatedAt: now,
      });
      await accountsStore.saveAccountSession({
        sessionId: devSessionId,
        subject: seedPlan.subject,
        createdAt: now,
        expiresAt: now + 60 * 60 * 1000,
      });
    }
    const handler = await createEphemeralAccountsHandler({
      issuer: seedPlan.issuer,
      subject: seedPlan.subject,
      // `accounts serve` is the dev/local seeding path: the ephemeral
      // per-process signing key is deliberate here even when the dev issuer is
      // https-style (e.g. `*.takosumi.test` under Pebble TLS for LAN dev), so
      // opt out of the fail-closed ephemeral-key guard. Production wiring uses
      // the Cloudflare / node-postgres distributions with a stable JWK.
      allowEphemeralKeyOnHttpsIssuer: true,
      clients: [
        {
          clientId: seedPlan.oidcClient.clientId,
          redirectUris: seedPlan.oidcClient.redirectUris,
        },
      ],
      store: accountsStore,
      upstreamOAuth,
      passkeys,
    });
    Bun.serve({ hostname, port, fetch: handler });
    io.stdout(`Takosumi Accounts listening at http://${hostname}:${port}`);
    io.stdout(`Accounts persistence: ${servePlan.persistence.driver}`);
    await new Promise(() => {});
    return 0;
  } finally {
    await storeResource.close?.();
  }
}

export async function runAccountsTokens(
  args: string[],
  io: CliIo,
): Promise<number> {
  const [command, ...rest] = args;
  if (!command || command === "--help" || command === "-h") {
    io.stdout(accountsTokensHelpText());
    return 0;
  }
  if (command === "list") return await runAccountsTokensList(rest, io);
  if (command === "create") return await runAccountsTokensCreate(rest, io);
  if (command === "revoke") return await runAccountsTokensRevoke(rest, io);
  io.stderr(`Unknown accounts tokens command: ${command}`);
  io.stderr(accountsTokensHelpText());
  return 2;
}

async function runAccountsTokensList(
  args: string[],
  io: CliIo,
): Promise<number> {
  const options = parseOptions(args);
  if (options.help) {
    io.stdout(accountsTokensListHelpText());
    return 0;
  }
  try {
    const response = await requestAccountsApi({
      path: TAKOSUMI_ACCOUNTS_ACCOUNT_TOKENS_PATH,
      options,
    });
    io.stdout(
      formatAccountsTokensList(response, booleanOption(options, "json")),
    );
    return 0;
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

async function runAccountsTokensCreate(
  args: string[],
  io: CliIo,
): Promise<number> {
  const options = parseOptions(args);
  if (options.help) {
    io.stdout(accountsTokensCreateHelpText());
    return 0;
  }
  let body;
  try {
    body = accountsTokenCreateBody(options);
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    return 2;
  }
  try {
    const response = await requestAccountsApi({
      method: "POST",
      path: TAKOSUMI_ACCOUNTS_ACCOUNT_TOKENS_PATH,
      body,
      options,
    });
    io.stdout(
      formatAccountsTokenCreate(response, booleanOption(options, "json")),
    );
    return 0;
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

async function runAccountsTokensRevoke(
  args: string[],
  io: CliIo,
): Promise<number> {
  const [tokenId, ...rest] = args;
  const options = parseOptions(rest);
  if (options.help) {
    io.stdout(accountsTokensRevokeHelpText());
    return 0;
  }
  if (!tokenId || tokenId.startsWith("--")) {
    io.stderr("token id is required");
    return 2;
  }
  try {
    const response = await requestAccountsApi({
      method: "POST",
      path: takosumiAccountsAccountTokenRevokePath(tokenId),
      options,
    });
    io.stdout(
      formatAccountsTokenRevoke(response, booleanOption(options, "json")),
    );
    return 0;
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

function buildAccountsSeedPlan(
  options: Record<string, string | boolean>,
): AccountsSeedPlan {
  // The issuer is the bare worker origin (the platform worker's
  // app.takosumi.com, or a self-hoster's own origin); there is no implicit
  // takosumi-branded default. The seed/serve scaffold is dev-only, so when no
  // --issuer is supplied we fall back to a generic localhost placeholder (never
  // a takosumi.com host). Production seeds must pass --issuer explicitly.
  const issuer = normalizeIssuer(
    stringOption(options, "issuer", "http://localhost:8787"),
  );
  const subject = stringOption(options, "subject", "tsub_dev_seed");
  if (!subject.startsWith("tsub_")) {
    throw new TypeError("--subject must use the tsub_ prefix");
  }

  return {
    kind: "takosumi.accounts.seed@v1",
    issuer,
    subject: subject as TakosumiSubject,
    oidcClient: {
      clientId: stringOption(options, "clientId", "local-client"),
      redirectUris: splitCsv(
        stringOption(
          options,
          "redirectUri",
          "http://localhost:5173/auth/oidc/callback",
        ),
      ),
    },
  };
}
