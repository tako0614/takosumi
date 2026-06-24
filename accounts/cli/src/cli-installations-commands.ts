import process from "node:process";
import { readFile, writeFile } from "node:fs/promises";
import {
  type TakosumiSubject,
  TAKOSUMI_ACCOUNTS_INSTALLATIONS_PATH,
  takosumiAccountsInstallationExportOperationPath,
  takosumiAccountsInstallationPlanRunsPath,
  takosumiAccountsInstallationExportPath,
  takosumiAccountsInstallationMaterializePath,
  takosumiAccountsInstallationPath,
  takosumiAccountsInstallationStatusPath,
} from "@takosjp/takosumi-accounts-contract";
import {
  installationsExportHelpText,
  installationsExportOperationHelpText,
  installationsImportApplyHelpText,
  installationsImportPlanHelpText,
  installationsInspectHelpText,
  installationsListHelpText,
  installationsMaterializeHelpText,
  installationsStatusHelpText,
  installationsUninstallHelpText,
} from "./cli-help.ts";
import {
  type InstallationImportPlan,
  parseAccountsInstallationExportBundleInput,
  planInstallationImport,
  TAKOSUMI_MATERIALIZE_DRILL_TOKEN_HEADER,
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
  let extraHeaders: Record<string, string> | undefined;
  try {
    extraHeaders = await materializeDrillHeaders(options);
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    return 2;
  }
  try {
    const response = await requestAccountsApi({
      method: "POST",
      path: takosumiAccountsInstallationMaterializePath(installationId),
      body,
      idempotencyKey: installationIdempotencyKey(options),
      extraHeaders,
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

async function materializeDrillHeaders(
  options: Record<string, string | boolean>,
): Promise<Record<string, string> | undefined> {
  const token =
    stringOrRequiredValueOption(options, "drillToken") ??
    (await optionalTrimmedFileOption(options, "drillTokenFile")) ??
    process.env.TAKOSUMI_MATERIALIZE_DRILL_TOKEN;
  if (!token) return undefined;
  return { [TAKOSUMI_MATERIALIZE_DRILL_TOKEN_HEADER]: token };
}

async function optionalTrimmedFileOption(
  options: Record<string, string | boolean>,
  key: string,
): Promise<string | undefined> {
  const path = stringOrRequiredValueOption(options, key);
  if (!path) return undefined;
  const value = (await readFile(path, "utf8")).trim();
  return value.length > 0 ? value : undefined;
}

function stringOrRequiredValueOption(
  options: Record<string, string | boolean>,
  key: string,
): string | undefined {
  const value = options[key];
  if (value === true) {
    throw new TypeError(`--${kebabCaseForMessage(key)} requires a value`);
  }
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function kebabCaseForMessage(key: string): string {
  return key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
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

export async function runInstallationsExportOperation(
  args: string[],
  io: CliIo,
): Promise<number> {
  const [installationId, operationId, ...rest] = args;
  const options = parseOptions(rest);
  if (options.help) {
    io.stdout(installationsExportOperationHelpText());
    return 0;
  }
  if (!installationId || installationId.startsWith("--")) {
    io.stderr("installation id is required");
    return 2;
  }
  if (!operationId || operationId.startsWith("--")) {
    io.stderr("operation id is required");
    return 2;
  }
  try {
    const response = await requestAccountsApi({
      path: takosumiAccountsInstallationExportOperationPath(
        installationId,
        operationId,
      ),
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
  try {
    const plan = await buildInstallationImportPlanFromOptions(options);
    await writeOrPrintJson({
      value: plan,
      outFile: optionalStringOption(options, "outFile"),
      successMessage: "Wrote installation import plan",
      io,
    });
    return 0;
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

export async function runInstallationsImportApply(
  args: string[],
  io: CliIo,
): Promise<number> {
  const options = parseOptions(args);
  if (options.help) {
    io.stdout(installationsImportApplyHelpText());
    return 0;
  }
  try {
    const plan = await loadInstallationImportPlan(options);
    const planRunResponse = await requestAccountsApi({
      method: "POST",
      path: takosumiAccountsInstallationPlanRunsPath(),
      body: importPlanRecord(
        plan.deployControlPlanRequest,
        "deployControlPlanRequest",
      ),
      options,
    });
    const planRun = importPlanRecord(planRunResponse, "PlanRun response");
    const publicPlanRun = importPlanRecord(planRun.planRun, "planRun");
    const planRunStatus = stringField(publicPlanRun, "status", "planRun");
    if (planRunStatus !== "succeeded") {
      throw new Error(
        `target PlanRun ${stringField(publicPlanRun, "id", "planRun")} is ${planRunStatus}; import-apply requires a succeeded reviewed plan`,
      );
    }
    const expected = importPlanRecord(planRun.expected, "expected");
    assertApplyExpectedGuard(expected);
    const projectionRequest = projectionCreateRequestFromImportPlan({
      plan,
      expected,
      planRunId: stringField(publicPlanRun, "id", "planRun"),
    });
    const projectionResponse = await requestAccountsApi({
      method: "POST",
      path: TAKOSUMI_ACCOUNTS_INSTALLATIONS_PATH,
      body: projectionRequest,
      idempotencyKey: installationIdempotencyKey(options),
      options,
    });
    const result = {
      kind: "takosumi.accounts.installation-import-apply-result@v1",
      importPlanKind: plan.kind,
      targetIssuer: plan.targetIssuer,
      sourceIssuer: plan.sourceIssuer,
      planRunId: projectionRequest.planRunId,
      projectionRequest,
      planRun: planRunResponse,
      projection: projectionResponse,
    };
    if (
      booleanOption(options, "json") ||
      optionalStringOption(options, "outFile")
    ) {
      await writeOrPrintJson({
        value: result,
        outFile: optionalStringOption(options, "outFile"),
        successMessage: "Wrote installation import apply result",
        io,
      });
      return 0;
    }
    const projection = importPlanRecord(projectionResponse, "projection");
    const installation = isRecord(projection.installation)
      ? projection.installation
      : undefined;
    io.stdout(
      [
        "Installation import apply submitted",
        `  planRunId: ${String(projectionRequest.planRunId)}`,
        ...(installation && typeof installation.id === "string"
          ? [`  installationId: ${installation.id}`]
          : []),
      ].join("\n"),
    );
    return 0;
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

async function loadInstallationImportPlan(
  options: Record<string, string | boolean>,
): Promise<InstallationImportPlan> {
  const planFile = optionalStringOption(options, "planFile");
  if (planFile) {
    return parseInstallationImportPlan(
      parseJsonFile(await readFile(planFile, "utf8"), planFile),
    );
  }
  return await buildInstallationImportPlanFromOptions(options);
}

async function buildInstallationImportPlanFromOptions(
  options: Record<string, string | boolean>,
): Promise<InstallationImportPlan> {
  const bundleFile = optionalStringOption(options, "bundleFile");
  const targetIssuer = optionalStringOption(options, "targetIssuer");
  const targetAccountId = optionalStringOption(options, "targetAccount");
  const targetSpaceId = optionalStringOption(options, "targetSpace");
  const createdBySubject = optionalStringOption(options, "createdBySubject");
  if (!bundleFile) {
    throw new Error("--bundle-file is required");
  }
  if (!targetIssuer) {
    throw new Error("--target-issuer is required");
  }
  if (!targetAccountId) {
    throw new Error("--target-account is required");
  }
  if (!targetSpaceId) {
    throw new Error("--target-space is required");
  }
  if (!createdBySubject || !createdBySubject.startsWith("tsub_")) {
    throw new Error("--created-by-subject must be a tsub_ subject");
  }
  const mode = optionalStringOption(options, "mode") ?? "self-hosted";
  if (mode !== "self-hosted" && mode !== "dedicated") {
    throw new Error("--mode must be self-hosted or dedicated");
  }
  const bundle = parseAccountsInstallationExportBundleInput(
    parseJsonFile(await readFile(bundleFile, "utf8"), bundleFile),
  );
  return planInstallationImport({
    bundle,
    targetIssuer,
    targetAccountId,
    targetSpaceId,
    createdBySubject: createdBySubject as TakosumiSubject,
    targetInstallationId: optionalStringOption(options, "targetInstallationId"),
    mode,
  });
}

function projectionCreateRequestFromImportPlan(input: {
  plan: InstallationImportPlan;
  expected: Record<string, unknown>;
  planRunId: string;
}): Record<string, unknown> {
  const template = importPlanRecord(
    input.plan.accountsProjectionRequestTemplate ?? input.plan.request,
    "accountsProjectionRequestTemplate",
  );
  const request: Record<string, unknown> = {
    ...template,
    planRunId: input.planRunId,
    expected: input.expected,
  };
  delete request.installationId;
  const source = importPlanRecord(request.source, "accounts projection source");
  if (!stringValue(source.url) && stringValue(source.gitUrl)) {
    request.source = { ...source, url: stringValue(source.gitUrl) };
  }
  return request;
}

function parseInstallationImportPlan(value: unknown): InstallationImportPlan {
  const record = importPlanRecord(value, "installation import plan");
  if (record.kind !== "takosumi.accounts.installation-import-plan@v1") {
    throw new Error(
      "installation import plan kind must be takosumi.accounts.installation-import-plan@v1",
    );
  }
  if (!isRecord(record.deployControlPlanRequest)) {
    throw new Error(
      "installation import plan requires deployControlPlanRequest",
    );
  }
  if (!isRecord(record.accountsProjectionRequestTemplate)) {
    throw new Error(
      "installation import plan requires accountsProjectionRequestTemplate",
    );
  }
  return record as unknown as InstallationImportPlan;
}

function assertApplyExpectedGuard(expected: Record<string, unknown>): void {
  for (const key of [
    "planRunId",
    "runnerProfileId",
    "sourceDigest",
    "variablesDigest",
    "policyDecisionDigest",
    "planDigest",
    "planArtifactDigest",
  ]) {
    stringField(expected, key, "expected");
  }
}

function importPlanRecord(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function stringField(
  value: Record<string, unknown>,
  key: string,
  label: string,
): string {
  const field = stringValue(value[key]);
  if (!field) throw new Error(`${label}.${key} is required`);
  return field;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function writeOrPrintJson(input: {
  value: unknown;
  outFile?: string;
  successMessage: string;
  io: CliIo;
}): Promise<void> {
  const output = `${JSON.stringify(input.value, null, 2)}\n`;
  if (input.outFile) {
    await writeFile(input.outFile, output);
    input.io.stdout(`${input.successMessage} to ${input.outFile}`);
    return;
  }
  input.io.stdout(output.trimEnd());
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
