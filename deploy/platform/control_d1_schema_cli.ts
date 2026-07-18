import { resolve } from "node:path";

import type { D1Database } from "../../worker/src/bindings.ts";
import {
  applyControlD1Schema,
  buildControlD1SchemaPlan,
  ControlD1SchemaError,
  fenceControlD1Schema,
  type ControlD1SchemaPlan,
  verifyControlD1Schema,
} from "./control_d1_schema.ts";
import {
  ControlD1MaintenanceError,
  type ControlD1MaintenanceFence,
} from "../../worker/src/d1_schema_maintenance.ts";
import {
  CloudflareControlD1RestDatabase,
  ControlD1RestError,
} from "./control_d1_schema_rest.ts";

type Command = "plan" | "verify" | "fence" | "apply";
type Environment = "staging" | "production";

interface ParsedArgs {
  readonly command: Command;
  readonly environment?: Environment;
  readonly confirmManifest?: string;
  readonly dryRun: boolean;
  readonly retainMaintenanceFence: boolean;
  readonly help: boolean;
}

interface ControlD1RemoteTarget {
  readonly database: D1Database;
  readonly configurationDigest: string;
  readonly databaseId?: string;
}

interface CliDependencies {
  readonly createRemoteDatabase?: (
    environment: Environment,
    env: Readonly<Record<string, string | undefined>>,
  ) => ControlD1RemoteTarget | Promise<ControlD1RemoteTarget>;
  readonly now?: () => string;
  readonly sourceCommit?: string;
  readonly maintenanceDrainMilliseconds?: number;
  readonly waitForRequestDrain?: (milliseconds: number) => Promise<void>;
  readonly inspectSourceCheckout?: () => Promise<{
    readonly head: string;
    readonly clean: boolean;
  }>;
}

interface TranscriptProvenance {
  readonly generatedAt: string;
  readonly sourceCommit: string;
}

export async function runControlD1SchemaCli(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>> = process.env,
  write: (value: string) => void = console.log,
  dependencies: CliDependencies = {},
): Promise<number> {
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch {
    write(failureTranscript("arguments_invalid"));
    return 1;
  }
  if (args.help) {
    write(helpText());
    return 0;
  }

  const now = dependencies.now ?? (() => new Date().toISOString());
  let provenance: TranscriptProvenance;
  try {
    provenance = {
      generatedAt: transcriptTimestamp(now()),
      sourceCommit: sourceCommit(
        dependencies.sourceCommit ?? env.TAKOSUMI_CONTROL_D1_SOURCE_COMMIT,
      ),
    };
  } catch (error) {
    write(failureTranscript(errorCode(error), undefined, args));
    return 1;
  }

  let plan: ControlD1SchemaPlan;
  try {
    plan = await buildControlD1SchemaPlan();
  } catch (error) {
    write(failureTranscript(errorCode(error), undefined, args, provenance));
    return 1;
  }

  if (args.command === "plan" || args.dryRun) {
    write(
      JSON.stringify(
        planTranscript(plan, args, provenance, args.dryRun),
        null,
        2,
      ),
    );
    return 0;
  }
  if (!args.environment) {
    write(failureTranscript("environment_required", plan, args, provenance));
    return 1;
  }
  if (
    (args.command === "apply" || args.command === "fence") &&
    args.confirmManifest !== plan.manifestDigest
  ) {
    write(
      failureTranscript(
        "manifest_confirmation_required",
        plan,
        args,
        provenance,
      ),
    );
    return 1;
  }

  if (args.command === "apply" || args.command === "fence") {
    try {
      const source = await (
        dependencies.inspectSourceCheckout ?? inspectSourceCheckout
      )();
      if (source.head !== provenance.sourceCommit) {
        throw new ControlD1SchemaError("source_commit_mismatch");
      }
      if (!source.clean) {
        throw new ControlD1SchemaError("source_checkout_dirty");
      }
    } catch (error) {
      write(failureTranscript(errorCode(error), plan, args, provenance));
      return 1;
    }
  }

  const createRemoteDatabase =
    dependencies.createRemoteDatabase ?? defaultRemoteDatabase;
  try {
    const remote = await createRemoteDatabase(args.environment, env);
    if (args.command === "verify") {
      const verification = await verifyControlD1Schema(remote.database, plan);
      write(
        JSON.stringify(
          operationTranscript({
            plan,
            args,
            provenance,
            configurationDigest: remote.configurationDigest,
            verification,
          }),
          null,
          2,
        ),
      );
      return verification.status === "ready" ? 0 : 1;
    }

    const maintenanceDrainMilliseconds =
      dependencies.maintenanceDrainMilliseconds ?? 5_000;
    if (args.command === "fence") {
      const fenced = await fenceControlD1Schema(remote.database, plan, {
        sourceCommit: provenance.sourceCommit,
        environment: args.environment,
        activatedAt: provenance.generatedAt,
        releasedAt: now,
        maintenanceDrainMilliseconds,
        waitForRequestDrain:
          dependencies.waitForRequestDrain ?? waitForRequestDrain,
        retainMaintenanceFence: true,
        databaseRole: "legacy",
        releasePolicy: "never",
        databaseId: remote.databaseId,
      });
      write(
        JSON.stringify(
          fenceTranscript({
            plan,
            args,
            provenance,
            configurationDigest: remote.configurationDigest,
            maintenanceFence: fenced.maintenanceFence,
            maintenanceDrainMilliseconds: fenced.maintenanceDrainMilliseconds,
          }),
          null,
          2,
        ),
      );
      return 0;
    }
    const applied = await applyControlD1Schema(remote.database, plan, {
      sourceCommit: provenance.sourceCommit,
      environment: args.environment,
      activatedAt: provenance.generatedAt,
      releasedAt: now,
      maintenanceDrainMilliseconds,
      waitForRequestDrain:
        dependencies.waitForRequestDrain ?? waitForRequestDrain,
      retainMaintenanceFence: args.retainMaintenanceFence,
      databaseRole: "in_place",
      releasePolicy: "in_place",
      databaseId: remote.databaseId,
    });
    write(
      JSON.stringify(
        operationTranscript({
          plan,
          args,
          provenance,
          configurationDigest: remote.configurationDigest,
          verification: applied.verification,
          appliedMigrationVersions: applied.appliedMigrationVersions,
          maintenanceDrainMilliseconds: applied.maintenanceDrainMilliseconds,
          maintenanceFence: applied.maintenanceFence,
          maintenanceStatus: applied.maintenanceStatus,
        }),
        null,
        2,
      ),
    );
    return applied.verification.status === "ready" ? 0 : 1;
  } catch (error) {
    write(failureTranscript(errorCode(error), plan, args, provenance));
    return 1;
  }
}

function fenceTranscript(input: {
  readonly plan: ControlD1SchemaPlan;
  readonly args: ParsedArgs;
  readonly provenance: TranscriptProvenance;
  readonly configurationDigest: string;
  readonly maintenanceFence: ControlD1MaintenanceFence;
  readonly maintenanceDrainMilliseconds: number;
}) {
  return {
    kind: "takosumi.control-d1-schema-transcript@v1",
    mode: "fence",
    environment: input.args.environment,
    status: "fenced",
    dryRun: false,
    ...input.provenance,
    ...planSummary(input.plan),
    configurationDigest: input.configurationDigest,
    maintenanceFence: input.maintenanceFence,
    maintenanceStatus: "retained",
    maintenanceDrainMilliseconds: input.maintenanceDrainMilliseconds,
  };
}

async function defaultRemoteDatabase(
  environment: Environment,
  env: Readonly<Record<string, string | undefined>>,
): Promise<ControlD1RemoteTarget> {
  const prefix = `TAKOSUMI_CONTROL_D1_${environment.toUpperCase()}`;
  const accountId = requiredEnv(
    env[`${prefix}_CLOUDFLARE_ACCOUNT_ID`],
    "account_id_missing",
  );
  const databaseId = requiredEnv(
    env[`${prefix}_DATABASE_ID`],
    "database_id_missing",
  );
  const apiToken = requiredEnv(
    env[`${prefix}_CLOUDFLARE_API_TOKEN`],
    "api_token_missing",
  );
  return {
    database: new CloudflareControlD1RestDatabase({
      accountId,
      databaseId,
      apiToken,
    }),
    configurationDigest: await sha256(
      JSON.stringify({
        environment,
        accountId,
        databaseId,
        apiOrigin: "https://api.cloudflare.com",
      }),
    ),
    databaseId,
  };
}

function planTranscript(
  plan: ControlD1SchemaPlan,
  args: ParsedArgs,
  provenance: TranscriptProvenance,
  dryRun: boolean,
) {
  return {
    kind: "takosumi.control-d1-schema-transcript@v1",
    mode: args.command,
    environment: args.environment ?? "local-plan",
    status: "planned",
    dryRun,
    ...provenance,
    ...planSummary(plan),
    migrations: plan.migrations,
  };
}

function operationTranscript(input: {
  readonly plan: ControlD1SchemaPlan;
  readonly args: ParsedArgs;
  readonly provenance: TranscriptProvenance;
  readonly configurationDigest: string;
  readonly verification: Awaited<ReturnType<typeof verifyControlD1Schema>>;
  readonly appliedMigrationVersions?: readonly number[];
  readonly maintenanceDrainMilliseconds?: number;
  readonly maintenanceFence?: ControlD1MaintenanceFence;
  readonly maintenanceStatus?: "retained" | "released";
}) {
  return {
    kind: "takosumi.control-d1-schema-transcript@v1",
    mode: input.args.command,
    environment: input.args.environment,
    status: input.verification.status,
    dryRun: false,
    ...input.provenance,
    ...planSummary(input.plan),
    configurationDigest: input.configurationDigest,
    ...(input.appliedMigrationVersions
      ? { appliedMigrationVersions: input.appliedMigrationVersions }
      : {}),
    ...(input.maintenanceDrainMilliseconds === undefined
      ? {}
      : {
          maintenanceDrainMilliseconds: input.maintenanceDrainMilliseconds,
        }),
    ...(input.maintenanceFence
      ? { maintenanceFence: input.maintenanceFence }
      : {}),
    ...(input.maintenanceStatus
      ? { maintenanceStatus: input.maintenanceStatus }
      : {}),
    verification: input.verification,
  };
}

function failureTranscript(
  failureCode: string,
  plan?: ControlD1SchemaPlan,
  args?: ParsedArgs,
  provenance?: TranscriptProvenance,
): string {
  return JSON.stringify(
    {
      kind: "takosumi.control-d1-schema-transcript@v1",
      mode: args?.command ?? "unknown",
      environment: args?.environment ?? "unknown",
      status: "failed",
      dryRun: args?.dryRun ?? false,
      failureCode,
      ...(provenance ?? {}),
      ...(plan ? planSummary(plan) : {}),
    },
    null,
    2,
  );
}

function planSummary(plan: ControlD1SchemaPlan) {
  return {
    manifestVersion: plan.manifestVersion,
    manifestDigest: plan.manifestDigest,
    schemaDigest: plan.schemaDigest,
    ledgerDigest: plan.ledgerDigest,
    expectedLatestMigrationVersion: plan.migrations.at(-1)?.version ?? 0,
    expectedMigrationCount: plan.migrations.length,
    expectedTableCount: plan.tables.length,
    retiredTables: plan.retiredTables,
  };
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  if (argv.includes("--help") || argv.includes("-h")) {
    return {
      command: "plan",
      dryRun: false,
      retainMaintenanceFence: false,
      help: true,
    };
  }
  const command = argv[0];
  if (
    command !== "plan" &&
    command !== "verify" &&
    command !== "fence" &&
    command !== "apply"
  ) {
    throw new Error("command_invalid");
  }
  let environment: Environment | undefined;
  let confirmManifest: string | undefined;
  let dryRun = false;
  let retainMaintenanceFence = false;
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--environment") {
      const value = argv[++index];
      if (value !== "staging" && value !== "production") {
        throw new Error("environment_invalid");
      }
      environment = value;
      continue;
    }
    if (arg === "--confirm-manifest") {
      confirmManifest = argv[++index];
      if (!confirmManifest) throw new Error("confirmation_invalid");
      continue;
    }
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--retain-maintenance-fence") {
      retainMaintenanceFence = true;
      continue;
    }
    throw new Error("argument_unknown");
  }
  if (command !== "apply" && dryRun) throw new Error("dry_run_invalid");
  if (command !== "apply" && retainMaintenanceFence) {
    throw new Error("retain_fence_invalid");
  }
  return {
    command,
    environment,
    confirmManifest,
    dryRun,
    retainMaintenanceFence,
    help: false,
  };
}

function requiredEnv(value: string | undefined, code: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new ControlD1RestError(code);
  return normalized;
}

function sourceCommit(value: string | undefined): string {
  const normalized = value?.trim();
  if (!normalized) throw new ControlD1SchemaError("source_commit_required");
  if (!/^[0-9a-f]{40}$/u.test(normalized)) {
    throw new ControlD1SchemaError("source_commit_invalid");
  }
  return normalized;
}

function transcriptTimestamp(value: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString() !== value) {
    throw new ControlD1SchemaError("transcript_time_invalid");
  }
  return value;
}

function errorCode(error: unknown): string {
  if (
    error instanceof ControlD1SchemaError ||
    error instanceof ControlD1RestError ||
    error instanceof ControlD1MaintenanceError
  ) {
    const code = error.code.split(":", 1)[0] ?? "";
    return /^[a-z][a-z0-9_]{0,127}$/u.test(code)
      ? code
      : "control_d1_schema_failed";
  }
  return "control_d1_schema_failed";
}

function helpText(): string {
  return `Usage:
  bun scripts/control-d1-schema.ts plan
  bun scripts/control-d1-schema.ts apply --dry-run [--environment staging|production]
  bun scripts/control-d1-schema.ts fence --environment staging|production --confirm-manifest sha256:...
  bun scripts/control-d1-schema.ts verify --environment staging|production
  bun scripts/control-d1-schema.ts apply --environment staging|production --confirm-manifest sha256:... [--retain-maintenance-fence]

plan and apply --dry-run are local-only and perform no remote request. verify is
read-only. fence freezes a legacy database without changing its application
schema. apply requires the exact manifest digest emitted by plan. Official
Cloud blue/green candidates use --retain-maintenance-fence through cutover.

Remote commands read TAKOSUMI_CONTROL_D1_<ENV>_CLOUDFLARE_ACCOUNT_ID,
TAKOSUMI_CONTROL_D1_<ENV>_DATABASE_ID, and
TAKOSUMI_CONTROL_D1_<ENV>_CLOUDFLARE_API_TOKEN. Every command requires
TAKOSUMI_CONTROL_D1_SOURCE_COMMIT as the exact lowercase 40-character OSS
Takosumi commit. Tokens and raw Cloudflare response bodies are never emitted.`;
}

async function sha256(value: string): Promise<string> {
  const valueDigest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return `sha256:${[...new Uint8Array(valueDigest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}

async function waitForRequestDrain(milliseconds: number): Promise<void> {
  if (!Number.isInteger(milliseconds) || milliseconds < 0) {
    throw new ControlD1SchemaError("maintenance_drain_invalid");
  }
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

async function inspectSourceCheckout(): Promise<{
  readonly head: string;
  readonly clean: boolean;
}> {
  const checkout = resolve(import.meta.dir, "../..");
  const [head, status] = await Promise.all([
    runGit(checkout, ["rev-parse", "HEAD"]),
    runGit(checkout, ["status", "--porcelain", "--untracked-files=all"]),
  ]);
  return { head, clean: status.length === 0 };
}

async function runGit(
  checkout: string,
  args: readonly string[],
): Promise<string> {
  const child = Bun.spawn(["git", "-C", checkout, ...args], {
    env: Object.fromEntries(
      Object.entries({
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        TMPDIR: process.env.TMPDIR,
        LANG: process.env.LANG,
      }).filter((entry): entry is [string, string] => entry[1] !== undefined),
    ),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, , exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) {
    throw new ControlD1SchemaError("source_checkout_invalid");
  }
  return stdout.trim();
}
