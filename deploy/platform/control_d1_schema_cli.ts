import { resolve } from "node:path";

import type { D1Database } from "../../worker/src/bindings.ts";
import {
  applyControlD1Schema,
  buildControlD1SchemaPlan,
  ControlD1SchemaError,
  fenceControlD1Schema,
  releaseControlD1Candidate,
  reconcileControlD1CandidateRelease,
  type ControlD1SchemaPlan,
  verifyControlD1TransferSource,
  verifyControlD1Candidate,
  verifyControlD1Schema,
} from "./control_d1_schema.ts";
import {
  ControlD1MaintenanceError,
  releaseControlD1MaintenanceFence,
  readControlD1MaintenanceReleaseReceipt,
  readControlD1MaintenanceState,
  type ControlD1MaintenanceFence,
} from "../../worker/src/d1_schema_maintenance.ts";
import {
  CloudflareControlD1RestDatabase,
  ControlD1RestError,
} from "./control_d1_schema_rest.ts";

type Command =
  | "plan"
  | "verify"
  | "transfer-source-verify"
  | "candidate-verify"
  | "candidate-release"
  | "candidate-release-status"
  | "fence"
  | "freeze"
  | "apply"
  | "release";
type Environment = "staging" | "production";

interface ParsedArgs {
  readonly command: Command;
  readonly environment?: Environment;
  readonly confirmManifest?: string;
  readonly confirmDatabaseId?: string;
  readonly confirmSourceExportSha256?: string;
  readonly confirmSourceExportBookmark?: string;
  readonly confirmFenceId?: string;
  readonly confirmFenceDigest?: string;
  readonly confirmReleaseReadinessDigest?: string;
  readonly releasedAt?: string;
  readonly dryRun: boolean;
  readonly retainMaintenanceFence: boolean;
  readonly confirmPredecessorSource?: string;
  readonly confirmPredecessorManifest?: string;
  readonly help: boolean;
}

interface MaintenanceFenceTransitionTranscript {
  readonly predecessorSourceCommit: string;
  readonly predecessorManifestDigest: string;
  readonly predecessorFenceId: string;
  readonly successorFenceId: string;
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
    (args.command === "apply" ||
      args.command === "fence" ||
      args.command === "freeze" ||
      args.command === "release" ||
      args.command === "candidate-verify" ||
      args.command === "candidate-release" ||
      args.command === "candidate-release-status" ||
      args.command === "transfer-source-verify") &&
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

  if (
    args.command === "apply" ||
    args.command === "fence" ||
    args.command === "freeze" ||
    args.command === "release" ||
    args.command === "candidate-verify" ||
    args.command === "candidate-release" ||
    args.command === "candidate-release-status" ||
    args.command === "transfer-source-verify"
  ) {
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
  let remote: ControlD1RemoteTarget | undefined;
  try {
    remote = await createRemoteDatabase(args.environment, env);
    if (args.command === "transfer-source-verify") {
      if (
        !args.confirmManifest ||
        !args.confirmDatabaseId ||
        !args.confirmSourceExportSha256 ||
        !args.confirmSourceExportBookmark
      ) {
        throw new ControlD1SchemaError("transfer_source_confirmation_required");
      }
      if (remote.databaseId !== args.confirmDatabaseId) {
        throw new ControlD1SchemaError("transfer_source_target_mismatch");
      }
      const source = await verifyControlD1TransferSource(remote.database, plan, {
        environment: args.environment,
        sourceCommit: provenance.sourceCommit,
        manifestDigest: plan.manifestDigest,
        sourceDatabaseId: args.confirmDatabaseId,
        sourceExportSha256: args.confirmSourceExportSha256,
        sourceExportBookmark: args.confirmSourceExportBookmark,
      });
      write(
        JSON.stringify(
          sourceTranscript({
            plan,
            args,
            provenance,
            configurationDigest: remote.configurationDigest,
            source,
          }),
          null,
          2,
        ),
      );
      return source.status === "ready" ? 0 : 1;
    }
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

    if (
      args.command === "candidate-verify" ||
      args.command === "candidate-release" ||
      args.command === "candidate-release-status"
    ) {
      if (
        !args.confirmDatabaseId ||
        !args.confirmSourceExportSha256 ||
        !args.confirmFenceDigest
      ) {
        throw new ControlD1SchemaError("candidate_confirmation_required");
      }
      if (
        remote.databaseId !== args.confirmDatabaseId ||
        !/^sha256:[0-9a-f]{64}$/u.test(args.confirmSourceExportSha256)
      ) {
        throw new ControlD1SchemaError("candidate_target_confirmation_mismatch");
      }
      const candidateOptions = {
        environment: args.environment,
        sourceCommit: provenance.sourceCommit,
        manifestDigest: plan.manifestDigest,
        candidateDatabaseId: args.confirmDatabaseId,
        sourceExportSha256: args.confirmSourceExportSha256,
        expectedFenceDigest: args.confirmFenceDigest,
        ...(args.confirmFenceId
          ? { expectedFenceId: args.confirmFenceId }
          : {}),
      } as const;
      if (args.command === "candidate-verify") {
        const candidate = await verifyControlD1Candidate(
          remote.database,
          plan,
          candidateOptions,
        );
        write(
          JSON.stringify(
            candidateTranscript({
              plan,
              args,
              provenance,
              configurationDigest: remote.configurationDigest,
              candidate,
            }),
            null,
            2,
          ),
        );
        return candidate.status === "ready" ? 0 : 1;
      }
      if (!args.confirmReleaseReadinessDigest || !args.releasedAt) {
        throw new ControlD1SchemaError("candidate_release_confirmation_required");
      }
      const releaseOptions = {
        ...candidateOptions,
        confirmReleaseReadinessDigest: args.confirmReleaseReadinessDigest,
        releasedAt: args.releasedAt,
      } as const;
      const released =
        args.command === "candidate-release-status"
          ? await reconcileControlD1CandidateRelease(
              remote.database,
              plan,
              releaseOptions,
            )
          : await releaseControlD1Candidate(
              remote.database,
              plan,
              releaseOptions,
            );
      write(
        JSON.stringify(
          candidateReleaseTranscript({
            plan,
            args,
            provenance,
            configurationDigest: remote.configurationDigest,
            released,
          }),
          null,
          2,
        ),
      );
      return 0;
    }

    if (args.command === "release") {
      const state = await readControlD1MaintenanceState(remote.database);
      const fence =
        state.status === "active"
          ? state.fence
          : await readControlD1MaintenanceReleaseReceipt(remote.database);
      if (
        !fenceMatchesRelease(fence, {
          sourceCommit: provenance.sourceCommit,
          manifestDigest: plan.manifestDigest,
          environment: args.environment,
          databaseId: remote.databaseId ?? null,
        })
      ) {
        throw new ControlD1SchemaError("maintenance_fence_release_mismatch");
      }
      if (state.status === "active") {
        await releaseControlD1MaintenanceFence(
          remote.database,
          fence,
          provenance.generatedAt,
        );
      }
      const released = await readControlD1MaintenanceState(remote.database);
      if (released.status !== "inactive") {
        throw new ControlD1SchemaError("maintenance_fence_release_failed");
      }
      write(
        JSON.stringify(
          {
            kind: "takosumi.control-d1-schema-transcript@v1",
            mode: "release",
            environment: args.environment,
            status: "released",
            dryRun: false,
            ...provenance,
            ...planSummary(plan),
            configurationDigest: remote.configurationDigest,
            maintenanceFence: fence,
            maintenanceStatus: "released",
          },
          null,
          2,
        ),
      );
      return 0;
    }

    const maintenanceDrainMilliseconds =
      dependencies.maintenanceDrainMilliseconds ?? 5_000;
    if (args.command === "fence" || args.command === "freeze") {
      const releaseFreeze = args.command === "freeze";
      const fenced = await fenceControlD1Schema(remote.database, plan, {
        sourceCommit: provenance.sourceCommit,
        environment: args.environment,
        activatedAt: provenance.generatedAt,
        releasedAt: now,
        maintenanceDrainMilliseconds,
        waitForRequestDrain:
          dependencies.waitForRequestDrain ?? waitForRequestDrain,
        retainMaintenanceFence: true,
        databaseRole: releaseFreeze ? "in_place" : "legacy",
        releasePolicy: releaseFreeze ? "in_place" : "never",
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
    const activePredecessorFence =
      args.confirmPredecessorSource && args.confirmPredecessorManifest
        ? {
            sourceCommit: args.confirmPredecessorSource,
            manifestDigest: args.confirmPredecessorManifest,
          }
        : undefined;
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
      ...(activePredecessorFence ? { activePredecessorFence } : {}),
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
          ...(applied.predecessorMaintenanceFence
            ? {
                maintenanceFenceTransition: maintenanceFenceTransition(
                  applied.predecessorMaintenanceFence,
                  applied.maintenanceFence,
                ),
              }
            : {}),
          maintenanceStatus: applied.maintenanceStatus,
        }),
        null,
        2,
      ),
    );
    return applied.verification.status === "ready" ? 0 : 1;
  } catch (error) {
    const transition = remote
      ? await confirmedMaintenanceFenceTransition(
          remote.database,
          args,
          plan,
          provenance,
          remote.databaseId,
        )
      : undefined;
    write(
      failureTranscript(errorCode(error), plan, args, provenance, transition),
    );
    return 1;
  }
}

function fenceMatchesRelease(
  fence: ControlD1MaintenanceFence | null,
  expected: {
    readonly sourceCommit: string;
    readonly manifestDigest: string;
    readonly environment: Environment;
    readonly databaseId: string | null;
  },
): fence is ControlD1MaintenanceFence {
  return Boolean(
    fence &&
    fence.sourceCommit === expected.sourceCommit &&
    fence.manifestDigest === expected.manifestDigest &&
    fence.environment === expected.environment &&
    fence.databaseRole === "in_place" &&
    fence.releasePolicy === "in_place" &&
    fence.databaseId === expected.databaseId &&
    fence.sourceExportSha256 === null,
  );
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
    mode: input.args.command,
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
  readonly maintenanceFenceTransition?: MaintenanceFenceTransitionTranscript;
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
    ...(input.maintenanceFenceTransition
      ? { maintenanceFenceTransition: input.maintenanceFenceTransition }
      : {}),
    ...(input.maintenanceStatus
      ? { maintenanceStatus: input.maintenanceStatus }
      : {}),
    verification: input.verification,
  };
}

function candidateTranscript(input: {
  readonly plan: ControlD1SchemaPlan;
  readonly args: ParsedArgs;
  readonly provenance: TranscriptProvenance;
  readonly configurationDigest: string;
  readonly candidate: Awaited<ReturnType<typeof verifyControlD1Candidate>>;
}) {
  return {
    kind: "takosumi.control-d1-schema-transcript@v1",
    mode: input.args.command,
    environment: input.args.environment,
    status: input.candidate.status,
    dryRun: false,
    ...input.provenance,
    ...planSummary(input.plan),
    configurationDigest: input.configurationDigest,
    candidateDatabaseId: input.candidate.candidateDatabaseId,
    sourceExportSha256: input.candidate.sourceExportSha256,
    candidateFenceDigest: input.candidate.candidateFenceDigest,
    maintenanceFenceDigest: input.candidate.candidateFenceDigest,
    maintenanceFence: input.candidate.maintenanceFence,
    maintenanceStatus: input.candidate.maintenanceStatus,
    guardInventory: input.candidate.guardInventory,
    integrity: input.candidate.integrity,
    verification: input.candidate.verification,
    issues: input.candidate.issues,
  };
}

function sourceTranscript(input: {
  readonly plan: ControlD1SchemaPlan;
  readonly args: ParsedArgs;
  readonly provenance: TranscriptProvenance;
  readonly configurationDigest: string;
  readonly source: Awaited<ReturnType<typeof verifyControlD1TransferSource>>;
}) {
  return {
    ...input.source,
    mode: input.args.command,
    dryRun: false,
    ...input.provenance,
    ...planSummary(input.plan),
    configurationDigest: input.configurationDigest,
  };
}

function candidateReleaseTranscript(input: {
  readonly plan: ControlD1SchemaPlan;
  readonly args: ParsedArgs;
  readonly provenance: TranscriptProvenance;
  readonly configurationDigest: string;
  readonly released: Awaited<ReturnType<typeof releaseControlD1Candidate>>;
}) {
  return {
    kind: "takosumi.control-d1-schema-transcript@v1",
    mode: input.args.command,
    environment: input.args.environment,
    status: input.released.status,
    dryRun: false,
    ...input.provenance,
    ...planSummary(input.plan),
    configurationDigest: input.configurationDigest,
    candidateDatabaseId: input.released.candidateDatabaseId,
    sourceExportSha256: input.released.sourceExportSha256,
    releaseReadinessDigest: input.released.releaseReadinessDigest,
    candidateFenceDigest: input.released.candidateFenceDigest,
    maintenanceFenceDigest: input.released.candidateFenceDigest,
    maintenanceFence: input.released.maintenanceFence,
    maintenanceStatus: input.released.maintenanceStatus,
    lostAcknowledgementReconciled:
      input.released.lostAcknowledgementReconciled,
    guardInventory: input.released.guardInventory,
    integrity: input.released.integrity,
    verification: input.released.verification,
  };
}

function failureTranscript(
  failureCode: string,
  plan?: ControlD1SchemaPlan,
  args?: ParsedArgs,
  provenance?: TranscriptProvenance,
  maintenanceFenceTransition?: MaintenanceFenceTransitionTranscript,
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
      ...(maintenanceFenceTransition ? { maintenanceFenceTransition } : {}),
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

function maintenanceFenceTransition(
  predecessor: ControlD1MaintenanceFence,
  successor: ControlD1MaintenanceFence,
): MaintenanceFenceTransitionTranscript {
  return {
    predecessorSourceCommit: predecessor.sourceCommit,
    predecessorManifestDigest: predecessor.manifestDigest,
    predecessorFenceId: predecessor.fenceId,
    successorFenceId: successor.fenceId,
  };
}

async function confirmedMaintenanceFenceTransition(
  database: D1Database,
  args: ParsedArgs,
  plan: ControlD1SchemaPlan,
  provenance: TranscriptProvenance,
  databaseId: string | undefined,
): Promise<MaintenanceFenceTransitionTranscript | undefined> {
  if (!args.confirmPredecessorSource || !args.confirmPredecessorManifest) {
    return undefined;
  }
  try {
    const state = await readControlD1MaintenanceState(database);
    if (
      state.status !== "active" ||
      state.fence.sourceCommit !== provenance.sourceCommit ||
      state.fence.manifestDigest !== plan.manifestDigest ||
      state.fence.environment !== args.environment ||
      state.fence.databaseRole !== "in_place" ||
      state.fence.releasePolicy !== "in_place" ||
      state.fence.databaseId !== (databaseId ?? null) ||
      state.fence.sourceExportSha256 !== null ||
      state.fence.predecessor?.sourceCommit !== args.confirmPredecessorSource ||
      state.fence.predecessor.manifestDigest !== args.confirmPredecessorManifest
    ) {
      return undefined;
    }
    return {
      predecessorSourceCommit: args.confirmPredecessorSource,
      predecessorManifestDigest: args.confirmPredecessorManifest,
      predecessorFenceId: state.fence.predecessor.fenceId,
      successorFenceId: state.fence.fenceId,
    };
  } catch {
    return undefined;
  }
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
    command !== "transfer-source-verify" &&
    command !== "candidate-verify" &&
    command !== "candidate-release" &&
    command !== "candidate-release-status" &&
    command !== "fence" &&
    command !== "freeze" &&
    command !== "apply" &&
    command !== "release"
  ) {
    throw new Error("command_invalid");
  }
  let environment: Environment | undefined;
  let confirmManifest: string | undefined;
  let confirmDatabaseId: string | undefined;
  let confirmSourceExportSha256: string | undefined;
  let confirmSourceExportBookmark: string | undefined;
  let confirmFenceId: string | undefined;
  let confirmFenceDigest: string | undefined;
  let confirmReleaseReadinessDigest: string | undefined;
  let releasedAt: string | undefined;
  let dryRun = false;
  let retainMaintenanceFence = false;
  let confirmPredecessorSource: string | undefined;
  let confirmPredecessorManifest: string | undefined;
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
    if (arg === "--confirm-database-id") {
      confirmDatabaseId = argv[++index]?.trim();
      if (!confirmDatabaseId) throw new Error("candidate_database_id_invalid");
      continue;
    }
    if (arg === "--confirm-source-export-sha256") {
      confirmSourceExportSha256 = argv[++index]?.trim();
      if (!/^sha256:[0-9a-f]{64}$/u.test(confirmSourceExportSha256 ?? "")) {
        throw new Error("candidate_source_export_invalid");
      }
      continue;
    }
    if (arg === "--confirm-source-export-bookmark") {
      confirmSourceExportBookmark = argv[++index]?.trim();
      if (!/^[A-Za-z0-9_:.=-]{1,256}$/u.test(confirmSourceExportBookmark ?? "")) {
        throw new Error("transfer_source_bookmark_invalid");
      }
      continue;
    }
    if (arg === "--confirm-fence-id") {
      confirmFenceId = argv[++index]?.trim();
      if (!/^sha256:[0-9a-f]{64}$/u.test(confirmFenceId ?? "")) {
        throw new Error("candidate_fence_id_invalid");
      }
      continue;
    }
    if (arg === "--confirm-fence-digest") {
      confirmFenceDigest = argv[++index]?.trim();
      if (!/^sha256:[0-9a-f]{64}$/u.test(confirmFenceDigest ?? "")) {
        throw new Error("candidate_fence_digest_invalid");
      }
      continue;
    }
    if (arg === "--confirm-release-readiness-digest") {
      confirmReleaseReadinessDigest = argv[++index]?.trim();
      if (
        !/^sha256:[0-9a-f]{64}$/u.test(confirmReleaseReadinessDigest ?? "")
      ) {
        throw new Error("candidate_release_readiness_invalid");
      }
      continue;
    }
    if (arg === "--released-at") {
      releasedAt = argv[++index]?.trim();
      if (!releasedAt) throw new Error("candidate_release_time_invalid");
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
    if (arg === "--confirm-predecessor-source") {
      confirmPredecessorSource = argv[++index];
      if (!/^[0-9a-f]{40}$/u.test(confirmPredecessorSource ?? "")) {
        throw new Error("predecessor_source_invalid");
      }
      continue;
    }
    if (arg === "--confirm-predecessor-manifest") {
      confirmPredecessorManifest = argv[++index];
      if (!/^sha256:[0-9a-f]{64}$/u.test(confirmPredecessorManifest ?? "")) {
        throw new Error("predecessor_manifest_invalid");
      }
      continue;
    }
    throw new Error("argument_unknown");
  }
  if (command !== "apply" && dryRun) throw new Error("dry_run_invalid");
  if (command !== "apply" && retainMaintenanceFence) {
    throw new Error("retain_fence_invalid");
  }
  if (
    command !== "apply" ||
    dryRun ||
    Boolean(confirmPredecessorSource) !== Boolean(confirmPredecessorManifest)
  ) {
    if (confirmPredecessorSource || confirmPredecessorManifest) {
      throw new Error("predecessor_confirmation_invalid");
    }
  }
  if (
    command !== "candidate-verify" &&
    command !== "candidate-release" &&
    command !== "candidate-release-status" &&
    command !== "transfer-source-verify" &&
    (confirmDatabaseId ||
      confirmSourceExportSha256 ||
      confirmSourceExportBookmark ||
      confirmFenceId ||
      confirmFenceDigest ||
      confirmReleaseReadinessDigest ||
      releasedAt)
  ) {
    throw new Error("candidate_confirmation_invalid");
  }
  if (
    command === "candidate-verify" &&
    (confirmReleaseReadinessDigest || releasedAt)
  ) {
    throw new Error("candidate_release_confirmation_invalid");
  }
  if (
    (command === "candidate-release" || command === "candidate-release-status") &&
    !releasedAt
  ) {
    throw new Error("candidate_release_time_required");
  }
  return {
    command,
    environment,
    confirmManifest,
    confirmDatabaseId,
    confirmSourceExportSha256,
    confirmSourceExportBookmark,
    confirmFenceId,
    confirmFenceDigest,
    confirmReleaseReadinessDigest,
    releasedAt,
    dryRun,
    retainMaintenanceFence,
    confirmPredecessorSource,
    confirmPredecessorManifest,
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
  bun scripts/control-d1-schema.ts freeze --environment staging|production --confirm-manifest sha256:...
  bun scripts/control-d1-schema.ts release --environment staging|production --confirm-manifest sha256:...
  bun scripts/control-d1-schema.ts verify --environment staging|production
  bun scripts/control-d1-schema.ts transfer-source-verify --environment staging|production --confirm-manifest sha256:...
    --confirm-database-id <source-id> --confirm-source-export-sha256 sha256:...
    --confirm-source-export-bookmark <bookmark>
  bun scripts/control-d1-schema.ts candidate-verify --environment staging|production --confirm-manifest sha256:...
    --confirm-database-id <candidate-id> --confirm-source-export-sha256 sha256:...
    [--confirm-fence-id sha256:...] --confirm-fence-digest sha256:...
  bun scripts/control-d1-schema.ts candidate-release --environment staging|production --confirm-manifest sha256:...
    --confirm-database-id <candidate-id> --confirm-source-export-sha256 sha256:...
    [--confirm-fence-id sha256:...] --confirm-fence-digest sha256:...
    --confirm-release-readiness-digest sha256:... --released-at <ISO>
  bun scripts/control-d1-schema.ts candidate-release-status --environment staging|production --confirm-manifest sha256:...
    --confirm-database-id <candidate-id> --confirm-source-export-sha256 sha256:...
    [--confirm-fence-id sha256:...] --confirm-fence-digest sha256:...
    --confirm-release-readiness-digest sha256:... --released-at <ISO>
  bun scripts/control-d1-schema.ts apply --environment staging|production --confirm-manifest sha256:... [--retain-maintenance-fence]
    [--confirm-predecessor-source <40hex> --confirm-predecessor-manifest sha256:...]

plan and apply --dry-run are local-only and perform no remote request. verify is
read-only. fence freezes a legacy database without changing its application
schema and is never releasable. freeze acquires the exact short-lived in-place
release fence without changing schema; release removes only that exact fence.
apply requires the exact manifest digest emitted by plan. Official
Cloud blue/green candidates use --retain-maintenance-fence through cutover.
release also requires the same source, manifest, environment, and database
after the Worker cutover is proven.
candidate-verify is read-only and accepts only an active candidate/cutover
fence with the exact candidate database, source-export, and fence digest (an
optional fence id confirmation is checked when supplied). candidate-release repeats that verification, requires the exact
external promotion/readiness digest, releases only that candidate fence once,
and re-reads its inactive receipt. It never releases legacy or in-place
fences and never touches Accounts.
candidate-release-status is read-only and is the only reconciliation path for
an ambiguous candidate-release acknowledgement; it requires the same exact
confirmations and accepts only an already inactive matching receipt.
transfer-source-verify is read-only and accepts only the exact permanent
legacy/never source fence. It emits canonical guard, strict integrity/FK,
logical table, protected-content, export-lineage, and capture-authority
digests; it never emits rows or raw SQL.
The paired predecessor confirmations allow one exact immediate-predecessor
active in-place fence to transition atomically to the new reviewed plan; they
never release application writes between plans.

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
