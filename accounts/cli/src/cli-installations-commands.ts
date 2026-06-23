import process from "node:process";
import { readFile, writeFile } from "node:fs/promises";
import {
  type TakosumiSubject,
  TAKOSUMI_ACCOUNTS_INSTALLATIONS_PATH,
  takosumiAccountsInstallationExportPath,
  takosumiAccountsInstallationMaterializePath,
  takosumiAccountsInstallationPath,
  takosumiAccountsInstallationStatusPath,
} from "@takosjp/takosumi-accounts-contract";
import {
  installationsExportHelpText,
  installationsImportPlanHelpText,
  installationsInspectHelpText,
  installationsListHelpText,
  installationsMaterializeHelpText,
  installationsStatusHelpText,
  installationsUninstallHelpText,
} from "./cli-help.ts";
import {
  parseAccountsInstallationExportBundleInput,
  planInstallationImport,
} from "@takosjp/takosumi-accounts-service";
import {
  booleanOption,
  commaSeparatedOption,
  installationIdempotencyKey,
  optionalNonNegativeIntegerOption,
  optionalStringOption,
  parseOptions,
} from "./cli-options.ts";
import { materializeApprovalDigest } from "./cli-util.ts";
import { isSha256Digest } from "./cli-platform-readiness.ts";
import {
  formatInstallationInspect,
  formatInstallationOperation,
  formatInstallationsList,
  formatInstallationStatus,
  formatInstallationUninstall,
} from "./cli-format.ts";
import {
  installationStatusPatchBody,
  requestAccountsApi,
} from "./cli-accounts-api.ts";
import type { CliIo } from "./cli-io.ts";

const installationStatuses = [
  "installing",
  "ready",
  "suspended",
  "exported",
  "failed",
] as const;

export async function runInstallationsList(
  args: string[],
  io: CliIo,
): Promise<number> {
  const options = parseOptions(args);
  if (options.help) {
    io.stdout(installationsListHelpText());
    return 0;
  }
  const spaceId =
    optionalStringOption(options, "space") ?? process.env.TAKOS_SPACE_ID;
  if (!spaceId) {
    io.stderr("--space or TAKOS_SPACE_ID is required");
    return 2;
  }
  try {
    const response = await requestAccountsApi({
      path: `${TAKOSUMI_ACCOUNTS_INSTALLATIONS_PATH}?space_id=${encodeURIComponent(
        spaceId,
      )}`,
      options,
    });
    io.stdout(
      formatInstallationsList(response, booleanOption(options, "json")),
    );
    return 0;
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

export async function runInstallationsInspect(
  args: string[],
  io: CliIo,
): Promise<number> {
  const [installationId, ...rest] = args;
  const options = parseOptions(rest);
  if (options.help) {
    io.stdout(installationsInspectHelpText());
    return 0;
  }
  if (!installationId || installationId.startsWith("--")) {
    io.stderr("installation id is required");
    return 2;
  }
  try {
    const response = await requestAccountsApi({
      path: takosumiAccountsInstallationPath(installationId),
      options,
    });
    io.stdout(
      formatInstallationInspect(response, booleanOption(options, "json")),
    );
    return 0;
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

export async function runInstallationsUninstall(
  args: string[],
  io: CliIo,
): Promise<number> {
  const [installationId, ...rest] = args;
  const options = parseOptions(rest);
  if (options.help) {
    io.stdout(installationsUninstallHelpText());
    return 0;
  }
  if (!installationId || installationId.startsWith("--")) {
    io.stderr("installation id is required");
    return 2;
  }
  const reason = optionalStringOption(options, "reason");
  try {
    const response = await requestAccountsApi({
      method: "DELETE",
      path: takosumiAccountsInstallationPath(installationId),
      body: reason ? { reason } : undefined,
      options,
    });
    io.stdout(
      formatInstallationUninstall(response, booleanOption(options, "json")),
    );
    return 0;
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

export async function runInstallationsStatus(
  args: string[],
  io: CliIo,
): Promise<number> {
  const [installationId, ...rest] = args;
  const options = parseOptions(rest);
  if (options.help) {
    io.stdout(installationsStatusHelpText());
    return 0;
  }
  if (!installationId || installationId.startsWith("--")) {
    io.stderr("installation id is required");
    return 2;
  }
  const status = optionalStringOption(options, "status");
  if (!status) {
    io.stderr("--status is required");
    return 2;
  }
  if (!isInstallationStatus(status)) {
    io.stderr(`--status must be one of: ${installationStatuses.join(", ")}`);
    return 2;
  }
  let body;
  try {
    body = installationStatusPatchBody(status, options);
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    return 2;
  }
  try {
    const response = await requestAccountsApi({
      method: "PATCH",
      path: takosumiAccountsInstallationStatusPath(installationId),
      body,
      options,
    });
    io.stdout(
      formatInstallationStatus(response, booleanOption(options, "json")),
    );
    return 0;
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

export async function runInstallationsMaterialize(
  args: string[],
  io: CliIo,
): Promise<number> {
  const [installationId, ...rest] = args;
  const options = parseOptions(rest);
  if (options.help) {
    io.stdout(installationsMaterializeHelpText());
    return 0;
  }
  if (!installationId || installationId.startsWith("--")) {
    io.stderr("installation id is required");
    return 2;
  }
  const region = optionalStringOption(options, "region");
  if (!region) {
    io.stderr("--region is required");
    return 2;
  }
  if (!booleanOption(options, "costAck")) {
    io.stderr("--cost-ack is required");
    return 2;
  }
  const mode = optionalStringOption(options, "mode") ?? "dedicated";
  if (mode !== "dedicated") {
    io.stderr("--mode must be dedicated");
    return 2;
  }

  let drainSeconds;
  try {
    drainSeconds = optionalNonNegativeIntegerOption(options, "drainSeconds");
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    return 2;
  }
  const cutoverStrategy =
    optionalStringOption(options, "cutoverStrategy") ?? "blue-green";
  if (cutoverStrategy !== "blue-green" && cutoverStrategy !== "cutover-now") {
    io.stderr("--cutover-strategy must be blue-green or cutover-now");
    return 2;
  }
  const plan = {
    ...(optionalStringOption(options, "compute")
      ? { compute: optionalStringOption(options, "compute") }
      : {}),
    ...(optionalStringOption(options, "database")
      ? { database: optionalStringOption(options, "database") }
      : {}),
    ...(optionalStringOption(options, "objectStore")
      ? { objectStore: optionalStringOption(options, "objectStore") }
      : {}),
  };
  const cutover = {
    strategy: cutoverStrategy,
    ...(drainSeconds === undefined ? {} : { drainSeconds }),
  };
  const explicitPermissionDigest = optionalStringOption(
    options,
    "permissionDigest",
  );
  if (explicitPermissionDigest && !isSha256Digest(explicitPermissionDigest)) {
    io.stderr("--permission-digest must be sha256:<64-hex>");
    return 2;
  }
  const permissionDigest =
    explicitPermissionDigest ??
    (await materializeApprovalDigest({
      installationId,
      mode,
      region,
      plan,
      cutover,
    }));
  const body = {
    mode,
    region,
    plan,
    cutover,
    confirm: {
      costAck: true,
      permissionDigest,
    },
  };
  try {
    const response = await requestAccountsApi({
      method: "POST",
      path: takosumiAccountsInstallationMaterializePath(installationId),
      body,
      idempotencyKey: installationIdempotencyKey(options),
      options,
    });
    io.stdout(
      formatInstallationOperation(
        response,
        booleanOption(options, "json"),
        "Materialize",
      ),
    );
    return 0;
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

export async function runInstallationsExport(
  args: string[],
  io: CliIo,
): Promise<number> {
  const [installationId, ...rest] = args;
  const options = parseOptions(rest);
  if (options.help) {
    io.stdout(installationsExportHelpText());
    return 0;
  }
  if (!installationId || installationId.startsWith("--")) {
    io.stderr("installation id is required");
    return 2;
  }
  const format = optionalStringOption(options, "format") ?? "bundle";
  if (format !== "bundle") {
    io.stderr("--format must be bundle");
    return 2;
  }
  const encryptionMethod =
    optionalStringOption(options, "encryptionMethod") ?? "none";
  if (encryptionMethod !== "none" && encryptionMethod !== "age") {
    io.stderr("--encryption-method must be none or age");
    return 2;
  }
  const recipients = commaSeparatedOption(options, "recipient");
  if (encryptionMethod === "age" && recipients.length === 0) {
    io.stderr("--recipient is required when --encryption-method age");
    return 2;
  }
  const data = commaSeparatedOption(options, "data");
  const secrets = optionalStringOption(options, "secrets");
  if (
    secrets !== undefined &&
    secrets !== "templates-only" &&
    secrets !== "with-references"
  ) {
    io.stderr("--secrets must be templates-only or with-references");
    return 2;
  }
  const body = {
    includeData: booleanOption(options, "includeData"),
    format,
    encryption: {
      method: encryptionMethod,
      ...(recipients.length > 0 ? { recipients } : {}),
    },
    scope: {
      ...(data.length > 0 ? { data } : {}),
      ...(secrets ? { secrets } : {}),
    },
  };
  try {
    const response = await requestAccountsApi({
      method: "POST",
      path: takosumiAccountsInstallationExportPath(installationId),
      body,
      idempotencyKey: installationIdempotencyKey(options),
      options,
    });
    io.stdout(
      formatInstallationOperation(
        response,
        booleanOption(options, "json"),
        "Export",
      ),
    );
    return 0;
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

export async function runInstallationsImportPlan(
  args: string[],
  io: CliIo,
): Promise<number> {
  const options = parseOptions(args);
  if (options.help) {
    io.stdout(installationsImportPlanHelpText());
    return 0;
  }
  const bundleFile = optionalStringOption(options, "bundleFile");
  const targetIssuer = optionalStringOption(options, "targetIssuer");
  const targetAccountId = optionalStringOption(options, "targetAccount");
  const targetSpaceId = optionalStringOption(options, "targetSpace");
  const createdBySubject = optionalStringOption(options, "createdBySubject");
  if (!bundleFile) {
    io.stderr("--bundle-file is required");
    return 2;
  }
  if (!targetIssuer) {
    io.stderr("--target-issuer is required");
    return 2;
  }
  if (!targetAccountId) {
    io.stderr("--target-account is required");
    return 2;
  }
  if (!targetSpaceId) {
    io.stderr("--target-space is required");
    return 2;
  }
  if (!createdBySubject || !createdBySubject.startsWith("tsub_")) {
    io.stderr("--created-by-subject must be a tsub_ subject");
    return 2;
  }
  const mode = optionalStringOption(options, "mode") ?? "self-hosted";
  if (mode !== "self-hosted" && mode !== "dedicated") {
    io.stderr("--mode must be self-hosted or dedicated");
    return 2;
  }
  try {
    const bundle = parseAccountsInstallationExportBundleInput(
      parseJsonFile(await readFile(bundleFile, "utf8"), bundleFile),
    );
    const plan = planInstallationImport({
      bundle,
      targetIssuer,
      targetAccountId,
      targetSpaceId,
      createdBySubject: createdBySubject as TakosumiSubject,
      targetInstallationId: optionalStringOption(
        options,
        "targetInstallationId",
      ),
      mode,
    });
    const output = `${JSON.stringify(plan, null, 2)}\n`;
    const outFile = optionalStringOption(options, "outFile");
    if (outFile) {
      await writeFile(outFile, output);
      io.stdout(`Wrote installation import plan to ${outFile}`);
    } else {
      io.stdout(output.trimEnd());
    }
    return 0;
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

function parseJsonFile(text: string, file: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${file} is not valid JSON`);
  }
}

function isInstallationStatus(
  value: string,
): value is (typeof installationStatuses)[number] {
  return installationStatuses.includes(
    value as (typeof installationStatuses)[number],
  );
}
