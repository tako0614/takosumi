import process from "node:process";
import { readFile, writeFile } from "node:fs/promises";
import {
  type TakosumiSubject,
  TAKOSUMI_ACCOUNTS_INSTALLATIONS_PATH,
  takosumiAccountsCapsuleExportOperationPath,
  takosumiAccountsCapsulePlanRunsPath,
  takosumiAccountsCapsuleExportPath,
  takosumiAccountsCapsuleMaterializePath,
  takosumiAccountsCapsulePath,
  takosumiAccountsCapsuleStatusPath,
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
  type CapsuleImportPlan,
  parseAccountsCapsuleExportBundleInput,
  planCapsuleImport,
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
  formatCapsuleInspect,
  formatCapsuleOperation,
  formatCapsulesList,
  formatCapsuleStatus,
  formatCapsuleUninstall,
} from "./cli-format.ts";
import {
  AccountsApiError,
  installationStatusPatchBody,
  requestAccountsApi,
} from "./cli-accounts-api.ts";
import type { CliIo } from "./cli-io.ts";
import {
  canonicalProviderAddress,
  providerForAddress,
} from "@takosumi/providers";

const installationStatuses = [
  "installing",
  "ready",
  "suspended",
  "exported",
  "failed",
] as const;

const installationImportModes = [
  "shared-cell",
  "dedicated",
  "self-hosted",
] as const;

const DEFAULT_IMPORT_INSTALL_CONFIG_ID = "cfg-default-opentofu-capsule";
const DEFAULT_IMPORT_ENVIRONMENT = "production";

export async function runCapsulesList(
  args: string[],
  io: CliIo,
): Promise<number> {
  const options = parseOptions(args);
  if (options.help) {
    io.stdout(installationsListHelpText());
    return 0;
  }
  const workspaceId =
    optionalStringOption(options, "space") ?? process.env.TAKOS_SPACE_ID;
  if (!workspaceId) {
    io.stderr("--space or TAKOS_SPACE_ID is required");
    return 2;
  }
  try {
    const response = await requestAccountsApi({
      path: `${TAKOSUMI_ACCOUNTS_INSTALLATIONS_PATH}?space_id=${encodeURIComponent(
        workspaceId,
      )}`,
      options,
    });
    io.stdout(
      formatCapsulesList(response, booleanOption(options, "json")),
    );
    return 0;
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

export async function runCapsulesInspect(
  args: string[],
  io: CliIo,
): Promise<number> {
  const [capsuleId, ...rest] = args;
  const options = parseOptions(rest);
  if (options.help) {
    io.stdout(installationsInspectHelpText());
    return 0;
  }
  if (!capsuleId || capsuleId.startsWith("--")) {
    io.stderr("installation id is required");
    return 2;
  }
  try {
    const response = await requestAccountsApi({
      path: takosumiAccountsCapsulePath(capsuleId),
      options,
    });
    io.stdout(
      formatCapsuleInspect(response, booleanOption(options, "json")),
    );
    return 0;
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

export async function runCapsulesUninstall(
  args: string[],
  io: CliIo,
): Promise<number> {
  const [capsuleId, ...rest] = args;
  const options = parseOptions(rest);
  if (options.help) {
    io.stdout(installationsUninstallHelpText());
    return 0;
  }
  if (!capsuleId || capsuleId.startsWith("--")) {
    io.stderr("installation id is required");
    return 2;
  }
  const reason = optionalStringOption(options, "reason");
  try {
    const response = await requestAccountsApi({
      method: "DELETE",
      path: takosumiAccountsCapsulePath(capsuleId),
      body: reason ? { reason } : undefined,
      options,
    });
    io.stdout(
      formatCapsuleUninstall(response, booleanOption(options, "json")),
    );
    return 0;
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

export async function runCapsulesStatus(
  args: string[],
  io: CliIo,
): Promise<number> {
  const [capsuleId, ...rest] = args;
  const options = parseOptions(rest);
  if (options.help) {
    io.stdout(installationsStatusHelpText());
    return 0;
  }
  if (!capsuleId || capsuleId.startsWith("--")) {
    io.stderr("installation id is required");
    return 2;
  }
  const status = optionalStringOption(options, "status");
  if (!status) {
    io.stderr("--status is required");
    return 2;
  }
  if (!isCapsuleStatus(status)) {
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
      path: takosumiAccountsCapsuleStatusPath(capsuleId),
      body,
      options,
    });
    io.stdout(
      formatCapsuleStatus(response, booleanOption(options, "json")),
    );
    return 0;
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

export async function runCapsulesMaterialize(
  args: string[],
  io: CliIo,
): Promise<number> {
  const [capsuleId, ...rest] = args;
  const options = parseOptions(rest);
  if (options.help) {
    io.stdout(installationsMaterializeHelpText());
    return 0;
  }
  if (!capsuleId || capsuleId.startsWith("--")) {
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
      capsuleId,
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
      path: takosumiAccountsCapsuleMaterializePath(capsuleId),
      body,
      idempotencyKey: installationIdempotencyKey(options),
      extraHeaders,
      options,
    });
    io.stdout(
      formatCapsuleOperation(
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

export async function runCapsulesExport(
  args: string[],
  io: CliIo,
): Promise<number> {
  const [capsuleId, ...rest] = args;
  const options = parseOptions(rest);
  if (options.help) {
    io.stdout(installationsExportHelpText());
    return 0;
  }
  if (!capsuleId || capsuleId.startsWith("--")) {
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
      path: takosumiAccountsCapsuleExportPath(capsuleId),
      body,
      idempotencyKey: installationIdempotencyKey(options),
      options,
    });
    io.stdout(
      formatCapsuleOperation(
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

export async function runCapsulesExportOperation(
  args: string[],
  io: CliIo,
): Promise<number> {
  const [capsuleId, operationId, ...rest] = args;
  const options = parseOptions(rest);
  if (options.help) {
    io.stdout(installationsExportOperationHelpText());
    return 0;
  }
  if (!capsuleId || capsuleId.startsWith("--")) {
    io.stderr("installation id is required");
    return 2;
  }
  if (!operationId || operationId.startsWith("--")) {
    io.stderr("operation id is required");
    return 2;
  }
  try {
    const response = await requestAccountsApi({
      path: takosumiAccountsCapsuleExportOperationPath(
        capsuleId,
        operationId,
      ),
      options,
    });
    io.stdout(
      formatCapsuleOperation(
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

export async function runCapsulesImportPlan(
  args: string[],
  io: CliIo,
): Promise<number> {
  const options = parseOptions(args);
  if (options.help) {
    io.stdout(installationsImportPlanHelpText());
    return 0;
  }
  try {
    const plan = await buildCapsuleImportPlanFromOptions(options);
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

export async function runCapsulesImportApply(
  args: string[],
  io: CliIo,
): Promise<number> {
  const options = parseOptions(args);
  if (options.help) {
    io.stdout(installationsImportApplyHelpText());
    return 0;
  }
  try {
    const plan = await loadCapsuleImportPlan(options);
    const deployControlPlanRequest =
      await targetDeployControlPlanRequestForImportApply({
        plan,
        options,
      });
    const planRunResponse = await requestAccountsApi({
      method: "POST",
      path: takosumiAccountsCapsulePlanRunsPath(),
      body: deployControlPlanRequest,
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
        "Capsule import apply submitted",
        `  planRunId: ${String(projectionRequest.planRunId)}`,
        ...(installation && typeof installation.id === "string"
          ? [`  capsuleId: ${installation.id}`]
          : []),
      ].join("\n"),
    );
    return 0;
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

async function targetDeployControlPlanRequestForImportApply(input: {
  plan: CapsuleImportPlan;
  options: Record<string, string | boolean>;
}): Promise<Record<string, unknown>> {
  const request = await withImportVariablesFromOptions(
    {
      ...importPlanRecord(
        input.plan.deployControlPlanRequest,
        "deployControlPlanRequest",
      ),
    },
    input.options,
  );
  const requestWithRequiredProviders = withImportRequiredProvidersFromOptions(
    request,
    input.options,
  );
  if (stringValue(requestWithRequiredProviders.capsuleId)) {
    return requestWithRequiredProviders;
  }
  const source = importPlanRecord(
    requestWithRequiredProviders.source,
    "deployControlPlanRequest.source",
  );
  const sourceUrl = stringField(
    source,
    "url",
    "deployControlPlanRequest.source",
  );
  if (isTakosumiUploadSourceUrl(sourceUrl)) {
    throw new Error(
      "import-apply cannot restore a metadata-only upload source. " +
        "Use a bundle whose source.gitUrl is a restorable Git URL, or provide " +
        "a data-bearing export/archive restore flow before import-apply.",
    );
  }
  const targetWorkspaceId = stringField(
    requestWithRequiredProviders,
    "workspaceId",
    "deployControlPlanRequest",
  );
  const sourceId = await createTargetSourceForImportApply({
    plan: input.plan,
    source,
    targetWorkspaceId,
    options: input.options,
  });
  const sourceSync = await requestAccountsApi({
    method: "POST",
    path: `/api/v1/sources/${encodeURIComponent(sourceId)}/sync`,
    body: {},
    options: input.options,
  });
  await waitForImportApplyRun({
    run: importPlanRecord(sourceSync, "source sync response").run,
    options: input.options,
    label: "source sync",
  });
  const capsuleId = await createTargetCapsuleForImportApply({
    plan: input.plan,
    sourceId,
    targetWorkspaceId,
    options: input.options,
  });
  return {
    ...requestWithRequiredProviders,
    capsuleId,
    operation: "create",
  };
}

async function importVariablesFromOptions(
  options: Record<string, string | boolean>,
): Promise<Record<string, unknown> | undefined> {
  const variablesJson = optionalStringOption(options, "variablesJson");
  const variablesFile = optionalStringOption(options, "variablesFile");
  if (variablesJson && variablesFile) {
    throw new Error(
      "--variables-json and --variables-file are mutually exclusive",
    );
  }
  if (variablesJson) {
    return parseImportVariables(
      parseJsonOption(variablesJson, "--variables-json"),
      "--variables-json",
    );
  }
  if (variablesFile) {
    return parseImportVariables(
      parseJsonFile(await readFile(variablesFile, "utf8"), variablesFile),
      variablesFile,
    );
  }
  return undefined;
}

function parseJsonOption(text: string, label: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

function parseImportVariables(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value;
}

async function withImportVariablesFromOptions(
  request: Record<string, unknown>,
  options: Record<string, string | boolean>,
): Promise<Record<string, unknown>> {
  return withImportVariables(
    request,
    await importVariablesFromOptions(options),
  );
}

function withImportVariables(
  request: Record<string, unknown>,
  variables: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!variables) return request;
  const existingVariables = isRecord(request.variables)
    ? request.variables
    : {};
  return {
    ...request,
    variables: {
      ...existingVariables,
      ...variables,
    },
  };
}

function importApplyProviderConnections(
  options: Record<string, string | boolean>,
): readonly Record<string, string>[] {
  const raw = optionalStringOption(options, "provider");
  if (!raw) return [];
  return raw.split(",").map((pair) => {
    const [providerRaw, ...connectionParts] = pair.split("=");
    const providerWithAlias = providerRaw?.trim();
    const connectionId = connectionParts.join("=").trim();
    if (!providerWithAlias || !connectionId) {
      throw new Error(
        "--provider must be provider=providerConnectionId or provider@alias=providerConnectionId",
      );
    }
    const { provider, alias } = importApplyProviderAlias(providerWithAlias);
    return {
      provider,
      alias,
      connectionId,
    };
  });
}

function importApplyProviderAlias(input: string): {
  readonly provider: string;
  readonly alias: string;
} {
  const at = input.lastIndexOf("@");
  if (at <= 0) return { provider: input, alias: "main" };
  const provider = input.slice(0, at).trim();
  const alias = input.slice(at + 1).trim();
  if (!provider || !alias || alias.includes("/") || alias.includes("=")) {
    throw new Error(
      "--provider alias syntax must be provider@alias=providerConnectionId",
    );
  }
  return { provider, alias };
}

function withImportRequiredProvidersFromOptions(
  request: Record<string, unknown>,
  options: Record<string, string | boolean>,
): Record<string, unknown> {
  const requiredProviders = importApplyRequiredProviders(options);
  if (requiredProviders.length === 0) return request;
  const existingProviders = Array.isArray(request.requiredProviders)
    ? request.requiredProviders.filter(
        (value): value is string =>
          typeof value === "string" && value.length > 0,
      )
    : [];
  const merged = Array.from(
    new Set([...existingProviders, ...requiredProviders]),
  ).sort();
  return { ...request, requiredProviders: merged };
}

function importApplyRequiredProviders(
  options: Record<string, string | boolean>,
): readonly string[] {
  return Array.from(
    new Set(
      importApplyProviderConnections(options).map((connection) =>
        importApplyRequiredProviderAddress(connection.provider),
      ),
    ),
  ).sort();
}

function importApplyRequiredProviderAddress(provider: string): string {
  return (
    providerForAddress(provider)?.providerAddresses[0] ??
    canonicalProviderAddress(provider)
  );
}

async function createTargetSourceForImportApply(input: {
  plan: CapsuleImportPlan;
  source: Record<string, unknown>;
  targetWorkspaceId: string;
  options: Record<string, string | boolean>;
}): Promise<string> {
  const sourceUrl = stringField(
    input.source,
    "url",
    "deployControlPlanRequest.source",
  );
  const createSource = await requestAccountsApi({
    method: "POST",
    path: "/api/v1/sources",
    body: {
      workspaceId: input.targetWorkspaceId,
      name: importApplyName(input.plan, "source"),
      url: sourceUrl,
      ...(stringValue(input.source.ref)
        ? { defaultRef: stringValue(input.source.ref) }
        : {}),
      ...(stringValue(input.source.path)
        ? { defaultPath: stringValue(input.source.path) }
        : stringValue(input.source.modulePath)
          ? { defaultPath: stringValue(input.source.modulePath) }
          : {}),
    },
    options: input.options,
  });
  const source = importPlanRecord(
    importPlanRecord(createSource, "source create response").source,
    "source",
  );
  return stringField(source, "id", "source");
}

async function createTargetCapsuleForImportApply(input: {
  plan: CapsuleImportPlan;
  sourceId: string;
  targetWorkspaceId: string;
  options: Record<string, string | boolean>;
}): Promise<string> {
  const installConfigId =
    optionalStringOption(input.options, "installConfigId") ??
    DEFAULT_IMPORT_INSTALL_CONFIG_ID;
  const environment =
    optionalStringOption(input.options, "environment") ??
    DEFAULT_IMPORT_ENVIRONMENT;
  const path = `/api/v1/workspaces/${encodeURIComponent(input.targetWorkspaceId)}/capsules`;
  const providerConnections = importApplyProviderConnections(input.options);
  const body = {
    name: importApplyName(input.plan, "installation"),
    environment,
    sourceId: input.sourceId,
    installConfigId,
  };
  let created: unknown;
  try {
    created = await requestAccountsApi({
      method: "POST",
      path,
      body,
      options: input.options,
    });
  } catch (error) {
    const duplicateCapsuleId =
      duplicateCapsuleIdFromAccountsError(error);
    if (!duplicateCapsuleId) throw error;
    if (providerConnections.length > 0) {
      await putTargetCapsuleProviderConnections({
        capsuleId: duplicateCapsuleId,
        providerConnections,
        options: input.options,
      });
    }
    return duplicateCapsuleId;
  }
  const installation = importPlanRecord(
    importPlanRecord(created, "installation create response").installation,
    "installation",
  );
  const capsuleId = stringField(installation, "id", "installation");
  if (providerConnections.length > 0) {
    await putTargetCapsuleProviderConnections({
      capsuleId,
      providerConnections,
      options: input.options,
    });
  }
  return capsuleId;
}

async function putTargetCapsuleProviderConnections(input: {
  capsuleId: string;
  providerConnections: readonly Record<string, string>[];
  options: Record<string, string | boolean>;
}): Promise<void> {
  await requestAccountsApi({
    method: "PUT",
    path: `/api/v1/capsules/${encodeURIComponent(input.capsuleId)}/provider-connections`,
    body: { connections: input.providerConnections },
    options: input.options,
  });
}

function duplicateCapsuleIdFromAccountsError(
  error: unknown,
): string | undefined {
  if (!(error instanceof AccountsApiError) || error.status !== 409) {
    return undefined;
  }
  const body = isRecord(error.body) ? error.body : undefined;
  const errorRecord = isRecord(body?.error) ? body.error : undefined;
  if (stringValue(errorRecord?.code) !== "failed_precondition") {
    return undefined;
  }
  const details = isRecord(errorRecord?.details)
    ? errorRecord.details
    : undefined;
  if (stringValue(details?.reason) !== "duplicate_installation") {
    return undefined;
  }
  return stringValue(details?.capsuleId);
}

async function waitForImportApplyRun(input: {
  run: unknown;
  options: Record<string, string | boolean>;
  label: string;
}): Promise<Record<string, unknown>> {
  let run = importPlanRecord(input.run, `${input.label} run`);
  const initialStatus = stringValue(run.status);
  if (initialStatus && isTerminalImportApplyRunStatus(initialStatus)) {
    if (initialStatus !== "succeeded") {
      throw new Error(
        `${input.label} run ${stringField(run, "id", input.label)} is ${initialStatus}`,
      );
    }
    return run;
  }
  const runId = stringField(run, "id", `${input.label} run`);
  const timeoutMs =
    (optionalNonNegativeIntegerOption(input.options, "waitTimeoutSeconds") ??
      120) * 1000;
  const intervalMs =
    optionalNonNegativeIntegerOption(input.options, "waitIntervalMs") ?? 1000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    await sleep(intervalMs);
    const response = await requestAccountsApi({
      path: `/api/v1/runs/${encodeURIComponent(runId)}`,
      options: input.options,
    });
    run = importPlanRecord(
      importPlanRecord(response, `${input.label} run response`).run,
      `${input.label} run`,
    );
    const status = stringValue(run.status);
    if (status && isTerminalImportApplyRunStatus(status)) {
      if (status !== "succeeded") {
        throw new Error(`${input.label} run ${runId} is ${status}`);
      }
      return run;
    }
  }
  throw new Error(`${input.label} run ${runId} did not finish before timeout`);
}

function isTerminalImportApplyRunStatus(status: string): boolean {
  return (
    status === "succeeded" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "canceled"
  );
}

function importApplyName(
  plan: CapsuleImportPlan,
  suffix: "source" | "installation",
): string {
  const request = importPlanRecord(
    plan.accountsProjectionRequestTemplate ?? plan.request,
    "accountsProjectionRequestTemplate",
  );
  const appId = stringValue(request.appId) ?? "imported-capsule";
  return `${appId}-${suffix}`.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 80);
}

function isTakosumiUploadSourceUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.hostname === "uploads.takosumi.com";
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function loadCapsuleImportPlan(
  options: Record<string, string | boolean>,
): Promise<CapsuleImportPlan> {
  const planFile = optionalStringOption(options, "planFile");
  if (planFile) {
    return parseCapsuleImportPlan(
      parseJsonFile(await readFile(planFile, "utf8"), planFile),
    );
  }
  return await buildCapsuleImportPlanFromOptions(options);
}

async function buildCapsuleImportPlanFromOptions(
  options: Record<string, string | boolean>,
): Promise<CapsuleImportPlan> {
  const bundleFile = optionalStringOption(options, "bundleFile");
  const targetIssuer = optionalStringOption(options, "targetIssuer");
  const targetAccountId = optionalStringOption(options, "targetAccount");
  const targetWorkspaceId = optionalStringOption(options, "targetWorkspace");
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
  if (!targetWorkspaceId) {
    throw new Error("--target-workspace is required");
  }
  if (!createdBySubject || !createdBySubject.startsWith("tsub_")) {
    throw new Error("--created-by-subject must be a tsub_ subject");
  }
  const mode = optionalStringOption(options, "mode") ?? "self-hosted";
  if (!isCapsuleImportMode(mode)) {
    throw new Error(
      "--mode must be one of: shared-cell, dedicated, self-hosted",
    );
  }
  const bundle = parseAccountsCapsuleExportBundleInput(
    parseJsonFile(await readFile(bundleFile, "utf8"), bundleFile),
  );
  const plan = planCapsuleImport({
    bundle,
    targetIssuer,
    targetAccountId,
    targetWorkspaceId,
    createdBySubject: createdBySubject as TakosumiSubject,
    targetCapsuleId: optionalStringOption(options, "targetCapsuleId"),
    mode,
  });
  return {
    ...plan,
    deployControlPlanRequest: await withImportVariablesFromOptions(
      { ...plan.deployControlPlanRequest },
      options,
    ),
  };
}

function projectionCreateRequestFromImportPlan(input: {
  plan: CapsuleImportPlan;
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
  delete request.capsuleId;
  const source = importPlanRecord(request.source, "accounts projection source");
  if (!stringValue(source.url) && stringValue(source.gitUrl)) {
    request.source = { ...source, url: stringValue(source.gitUrl) };
  }
  return request;
}

function parseCapsuleImportPlan(value: unknown): CapsuleImportPlan {
  const record = importPlanRecord(value, "installation import plan");
  if (record.kind !== "takosumi.accounts.capsule-import-plan@v1") {
    throw new Error(
      "installation import plan kind must be takosumi.accounts.capsule-import-plan@v1",
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
  return record as unknown as CapsuleImportPlan;
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

function isCapsuleStatus(
  value: string,
): value is (typeof installationStatuses)[number] {
  return installationStatuses.includes(
    value as (typeof installationStatuses)[number],
  );
}

function isCapsuleImportMode(
  value: string,
): value is (typeof installationImportModes)[number] {
  return installationImportModes.includes(
    value as (typeof installationImportModes)[number],
  );
}
