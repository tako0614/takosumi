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
  buildAccountsDatabaseConfig,
  createAccountsStoreResource,
  loadAccountsMigrations,
} from "./cli-accounts-db.ts";
import {
  D1AccountsMigrationError,
  loadD1AccountsMigrationCatalog,
  type D1AccountsMigrationCatalog,
  type D1AccountsMigrationDatabase,
} from "../../accounts/service/src/d1-migrations.ts";
import {
  applyPlannedD1AccountsMigrations,
  assertD1AccountsApplyConfirmations,
  buildD1AccountsMigrationPlan,
  captureD1AccountsBackupEvidence,
  statusPlannedD1AccountsMigrations,
  verifyPlannedD1AccountsMigrations,
  type D1AccountsRemoteEnvironment,
} from "./cli-accounts-d1.ts";
import { resolve } from "node:path";
import {
  CloudflareD1RestTransport,
  D1RestTransportError,
} from "../../deploy/cloudflare/d1-rest-transport.ts";
import { realpath } from "node:fs/promises";
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

const ACCOUNTS_D1_SOURCE_ROOT = resolve(import.meta.dir, "../..");

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

export interface AccountsD1CliDependencies {
  readonly apiToken?: string;
  readonly readApiToken?: () => string | undefined;
  readonly catalog?: D1AccountsMigrationCatalog;
  readonly now?: () => number;
  readonly inspectSourceCheckout?: (input: {
    readonly sourceRoot: string;
  }) => Promise<{
    readonly commit: string;
    readonly status: string;
  }>;
  readonly fetch?: typeof fetch;
  readonly createDatabase?: (input: {
    readonly accountId: string;
    readonly databaseId: string;
    readonly apiToken: string;
  }) => D1AccountsMigrationDatabase;
  readonly readBookmark?: (input: {
    readonly accountId: string;
    readonly databaseId: string;
    readonly apiToken: string;
  }) => Promise<string>;
}

export async function runAccountsMigrateD1(
  args: string[],
  io: CliIo,
  dependencies: AccountsD1CliDependencies = {},
): Promise<number> {
  const options = parseOptions(args);
  if (options.help) {
    io.stdout(accountsMigrateD1HelpText());
    return 0;
  }
  const positionalMode = [
    "plan",
    "apply",
    "verify",
    "status",
    "backup-status",
  ].includes(args[0] ?? "")
    ? (args[0] as
        | "plan"
        | "apply"
        | "verify"
        | "status"
        | "backup-status")
    : undefined;
  const mode = positionalMode ??
    (booleanOption(options, "dryRun") ? "plan" : undefined);
  if (!mode) {
    io.stderr(
      "migrate-d1 mode must be plan, apply, verify, status, or backup-status",
    );
    return 2;
  }
  if (mode !== "plan" && booleanOption(options, "dryRun")) {
    io.stderr("--dry-run is only the legacy alias for migrate-d1 plan");
    return 2;
  }
  if (booleanOption(options, "local")) {
    io.stderr("--local is retired; local-substrate owns local D1 migration");
    return 2;
  }
  if (
    options.remote !== undefined ||
    options.wranglerConfig !== undefined ||
    options.env !== undefined
  ) {
    io.stderr(
      "--remote, --env, and --wrangler-config are retired; use explicit REST target options",
    );
    return 2;
  }
  const databaseId = optionalStringOption(options, "databaseId");
  const accountId = optionalStringOption(options, "accountId");
  const sourceCommit = optionalStringOption(options, "sourceCommit");
  const environmentValue = optionalStringOption(options, "environment");
  if (!databaseId || !accountId || !sourceCommit) {
    io.stderr("--database-id, --account-id, and --source-commit are required");
    return 2;
  }
  if (environmentValue !== "staging" && environmentValue !== "production") {
    io.stderr("--environment must be staging or production");
    return 2;
  }
  const environment = environmentValue as D1AccountsRemoteEnvironment;
  const backupEvidenceDigest = optionalStringOption(
    options,
    "backupEvidenceDigest",
  );
  const sourceRoot = ACCOUNTS_D1_SOURCE_ROOT;
  let observedSourceCommit: string;
  try {
    const source = await (
      dependencies.inspectSourceCheckout ?? inspectAccountsD1SourceCheckout
    )({ sourceRoot });
    if (!/^[0-9a-f]{40}$/u.test(source.commit)) {
      throw new D1AccountsMigrationError(
        "source_checkout_inspection_failed",
      );
    }
    if (source.commit !== sourceCommit) {
      throw new D1AccountsMigrationError("source_checkout_commit_mismatch");
    }
    if (typeof source.status !== "string") {
      throw new D1AccountsMigrationError(
        "source_checkout_inspection_failed",
      );
    }
    if (source.status.length !== 0) {
      throw new D1AccountsMigrationError("source_checkout_dirty");
    }
    observedSourceCommit = source.commit;
  } catch (error) {
    io.stderr(
      error instanceof D1AccountsMigrationError
        ? cliAccountsD1FailureCode(error)
        : "source_checkout_inspection_failed",
    );
    return 2;
  }
  let plan;
  try {
    plan = await buildD1AccountsMigrationPlan({
      sourceCommit: observedSourceCommit,
      environment,
      accountId,
      databaseId,
      ...(backupEvidenceDigest ? { backupEvidenceDigest } : {}),
    });
  } catch (error) {
    io.stderr(cliAccountsD1FailureCode(error));
    return 2;
  }
  if (mode === "plan") {
    io.stdout(JSON.stringify(plan, null, 2));
    return 0;
  }
  if (mode === "apply" && !backupEvidenceDigest) {
    io.stderr("backup_evidence_digest_required");
    return 2;
  }

  const applyConfirmations = {
    confirmSourceDigest:
      optionalStringOption(options, "confirmSourceDigest") ?? "",
    confirmCatalogDigest:
      optionalStringOption(options, "confirmCatalogDigest") ?? "",
    confirmTargetDigest:
      optionalStringOption(options, "confirmTargetDigest") ?? "",
    confirmConfigurationDigest:
      optionalStringOption(options, "confirmConfigurationDigest") ?? "",
  };
  if (mode === "apply") {
    try {
      await assertD1AccountsApplyConfirmations(plan, applyConfirmations);
    } catch (error) {
      const failureCode = cliAccountsD1FailureCode(error);
      io.stderr(
        JSON.stringify(
          {
            ...plan,
            mode,
            status: "invalid",
            issues: [failureCode],
            failureCode,
          },
          null,
          2,
        ),
      );
      return 1;
    }
  }

  const apiToken = (
    dependencies.apiToken ??
    dependencies.readApiToken?.() ??
    process.env.CLOUDFLARE_API_TOKEN
  )?.trim();
  if (!apiToken) {
    io.stderr("api_token_missing");
    return 2;
  }
  if (mode === "backup-status") {
    const out = optionalStringOption(options, "out");
    if (!out) {
      io.stderr("backup_evidence_out_required");
      return 2;
    }
    try {
      const bookmark = dependencies.readBookmark
        ? await dependencies.readBookmark({ accountId, databaseId, apiToken })
        : await new CloudflareD1RestTransport({
            accountId,
            databaseId,
            apiToken,
            ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
          }).readTimeTravelBookmark();
      const transcript = await captureD1AccountsBackupEvidence({
        plan,
        bookmark,
        capturedAt: new Date((dependencies.now ?? Date.now)()).toISOString(),
        out,
        sourceRoots: [sourceRoot],
      });
      io.stdout(JSON.stringify(transcript, null, 2));
      return 0;
    } catch (error) {
      const failureCode = cliAccountsD1FailureCode(error);
      io.stderr(
        JSON.stringify(
          {
            ...plan,
            mode,
            status: "invalid",
            issues: [failureCode],
            failureCode,
          },
          null,
          2,
        ),
      );
      return 1;
    }
  }
  const catalog =
    dependencies.catalog ?? (await loadD1AccountsMigrationCatalog());
  const database =
    dependencies.createDatabase?.({ accountId, databaseId, apiToken }) ??
    new CloudflareD1RestTransport({
      accountId,
      databaseId,
      apiToken,
      ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
    });
  try {
    const report =
      mode === "apply"
        ? await applyPlannedD1AccountsMigrations({
            database,
            catalog,
            plan,
            ...applyConfirmations,
            ...(dependencies.now ? { now: dependencies.now } : {}),
          })
        : mode === "verify"
          ? await verifyPlannedD1AccountsMigrations({ database, catalog, plan })
          : await statusPlannedD1AccountsMigrations({ database, catalog, plan });
    io.stdout(JSON.stringify(report, null, 2));
    return report.status === "invalid" ? 1 : 0;
  } catch (error) {
    const failureCode = cliAccountsD1FailureCode(error);
    io.stderr(
      JSON.stringify(
        {
          ...plan,
          mode,
          status: "invalid",
          issues: [failureCode],
          failureCode,
        },
        null,
        2,
      ),
    );
    return 1;
  }
}

const REVIEWED_GIT_CONFIG_ARGS = [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.attributesFile=/dev/null",
  "-c",
  "commit.gpgSign=false",
  "-c",
  "tag.gpgSign=false",
] as const;

export async function inspectAccountsD1SourceCheckout(input: {
  readonly sourceRoot: string;
}): Promise<{ readonly commit: string; readonly status: string }> {
  try {
    const expectedRoot = await realpath(ACCOUNTS_D1_SOURCE_ROOT);
    const requestedRoot = await realpath(input.sourceRoot);
    if (requestedRoot !== expectedRoot) {
      throw new D1AccountsMigrationError(
        "source_checkout_inspection_failed",
      );
    }
    const topLevel = (
      await accountsD1GitOutput(expectedRoot, [
        "rev-parse",
        "--show-toplevel",
      ])
    ).trim();
    if ((await realpath(topLevel)) !== expectedRoot) {
      throw new D1AccountsMigrationError(
        "source_checkout_inspection_failed",
      );
    }
    const commit = (
      await accountsD1GitOutput(expectedRoot, ["rev-parse", "HEAD"])
    ).trim();
    const status = await accountsD1GitOutput(expectedRoot, [
      "status",
      "--porcelain",
      "--untracked-files=all",
    ]);
    return { commit, status };
  } catch (error) {
    if (error instanceof D1AccountsMigrationError) throw error;
    throw new D1AccountsMigrationError("source_checkout_inspection_failed");
  }
}

async function accountsD1GitOutput(
  sourceRoot: string,
  args: readonly string[],
): Promise<string> {
  const child = Bun.spawn(
    ["git", ...REVIEWED_GIT_CONFIG_ARGS, "-C", sourceRoot, ...args],
    {
      env: Object.fromEntries(
        Object.entries({
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          TMPDIR: process.env.TMPDIR,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_TERMINAL_PROMPT: "0",
          LC_ALL: "C",
          LANG: "C",
        }).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      ),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [exitCode, output] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new D1AccountsMigrationError("source_checkout_inspection_failed");
  }
  return output;
}

function cliAccountsD1FailureCode(error: unknown): string {
  if (
    error instanceof D1AccountsMigrationError ||
    error instanceof D1RestTransportError
  ) {
    return /^[a-z][a-z0-9_]{0,127}$/u.test(error.code)
      ? error.code
      : "accounts_d1_operation_failed";
  }
  return "accounts_d1_operation_failed";
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
