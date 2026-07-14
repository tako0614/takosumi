import { readFile } from "node:fs/promises";
import type { PlatformHardeningContribution } from "../contract/platform-hardening.ts";
import {
  TAKOSUMI_PRODUCTION_HARDENING_GATE_RESULT_KIND,
  type ProductionHardeningCheck,
  type ProductionHardeningContributionResult,
  type ProductionHardeningGateResult,
  platformHardeningContributions,
} from "../deploy/platform/production_hardening.ts";
import {
  type ProductionHardeningEvidenceValidation,
  validateProductionHardeningEvidenceFile,
} from "./validate-production-hardening-evidence.ts";

export interface ProductionHardeningGateVerification {
  readonly status: "passed";
  readonly manifestDigest: string;
  readonly generatedAt: string;
  readonly environment: ProductionHardeningEvidenceValidation["environment"];
  readonly enforced: boolean;
  readonly contributions: readonly VerifiedHardeningContribution[];
}

export interface VerifiedHardeningContribution {
  readonly id: string;
  readonly capability: string;
  readonly checks: readonly {
    readonly id: string;
    readonly evidenceRef: string;
    readonly evidenceDigest: string;
  }[];
}

export interface ProductionHardeningGateVerificationOptions {
  readonly evidenceRoot?: string;
  readonly contributions?: readonly PlatformHardeningContribution[];
  readonly requireEnforced?: boolean;
  readonly bearerToken?: string;
  readonly fetch?: typeof fetch;
}

export async function verifyProductionHardeningGateFiles(
  manifestPath: string,
  gateResponsePath: string,
  options: ProductionHardeningGateVerificationOptions = {},
): Promise<ProductionHardeningGateVerification> {
  const manifestValidation = await validateProductionHardeningEvidenceFile(
    manifestPath,
    {
      evidenceRoot: options.evidenceRoot,
      contributions: options.contributions,
    },
  );
  const gateResponse = readHardeningGateResponse(
    JSON.parse(await readFile(gateResponsePath, "utf8")),
  );
  return verifyProductionHardeningGateResponse(
    manifestValidation,
    gateResponse,
    options,
  );
}

export async function verifyProductionHardeningGateUrl(
  manifestPath: string,
  gateUrl: string,
  options: ProductionHardeningGateVerificationOptions = {},
): Promise<ProductionHardeningGateVerification> {
  const manifestValidation = await validateProductionHardeningEvidenceFile(
    manifestPath,
    {
      evidenceRoot: options.evidenceRoot,
      contributions: options.contributions,
    },
  );
  return verifyProductionHardeningGateResponse(
    manifestValidation,
    await fetchHardeningGateResponse(gateUrl, options),
    options,
  );
}

export function verifyProductionHardeningGateResponse(
  manifestValidation: ProductionHardeningEvidenceValidation,
  gateResponse: unknown,
  options: ProductionHardeningGateVerificationOptions = {},
): ProductionHardeningGateVerification {
  const response = readHardeningGateResponse(gateResponse);
  if (response.configurationErrors.length) {
    throw new Error(
      `production hardening gate configuration drifted: ${response.configurationErrors.join(
        "; ",
      )}`,
    );
  }
  if (!response.ok) {
    throw new Error("production hardening gate response is not ok");
  }
  if (options.requireEnforced && !response.enforced) {
    throw new Error("production hardening gate is not enforced");
  }

  const expected = manifestValidation.gateEvidence.contributions;
  const responseIds = response.contributions.map(({ id }) => id);
  requireSameMembers(
    responseIds,
    expected.map(({ id }) => id),
    "production hardening gate contributions",
  );
  const contributions = expected.map((expectedContribution) => {
    const actual = response.contributions.find(
      ({ id }) => id === expectedContribution.id,
    );
    if (!actual) {
      throw new Error(
        `production hardening gate is missing contribution ${expectedContribution.id}`,
      );
    }
    if (actual.capability !== expectedContribution.capability) {
      throw new Error(
        `production hardening gate contribution ${actual.id} capability drifted`,
      );
    }
    requireSameMembers(
      actual.checks.map(({ id }) => id),
      expectedContribution.checks.map(({ id }) => id),
      `production hardening gate contribution ${actual.id} checks`,
    );
    return {
      id: actual.id,
      capability: actual.capability,
      checks: expectedContribution.checks.map((expectedCheck) => {
        const check = actual.checks.find(({ id }) => id === expectedCheck.id);
        if (!check) {
          throw new Error(
            `production hardening gate ${actual.id}/${expectedCheck.id} is missing`,
          );
        }
        if (!check.ok) {
          throw new Error(
            `production hardening gate ${actual.id}/${check.id} failed${
              check.reason ? `: ${check.reason}` : ""
            }`,
          );
        }
        if (check.evidenceRef !== expectedCheck.evidenceRef) {
          throw new Error(
            `production hardening gate ${actual.id}/${check.id} evidenceRef drifted`,
          );
        }
        if (check.evidenceDigest !== expectedCheck.evidenceDigest) {
          throw new Error(
            `production hardening gate ${actual.id}/${check.id} evidenceDigest drifted`,
          );
        }
        return {
          id: check.id,
          evidenceRef: expectedCheck.evidenceRef,
          evidenceDigest: expectedCheck.evidenceDigest,
        };
      }),
    } satisfies VerifiedHardeningContribution;
  });

  return {
    status: "passed",
    manifestDigest: manifestValidation.manifestDigest,
    generatedAt: manifestValidation.generatedAt,
    environment: manifestValidation.environment,
    enforced: response.enforced,
    contributions,
  };
}

export interface ProductionHardeningGatePublicSummary {
  readonly kind: "takosumi.production-hardening-gate-public-summary@v2";
  readonly status: "enforced" | "validated";
  readonly enforced: boolean;
  readonly date: string;
  readonly environment: ProductionHardeningGateVerification["environment"];
  readonly gate: "platform-hardening-gates";
  readonly validator: {
    readonly manifestDigest: string;
    readonly contributions: readonly {
      readonly id: string;
      readonly capability: string;
    }[];
  };
  readonly privateEvidenceRefClass: string;
  readonly publicResult: string;
  readonly notes: string;
}

export interface ProductionHardeningGatePublicSummaryReport {
  readonly kind: "takosumi.production-hardening-gate-public-summary-report@v2";
  readonly valid: boolean;
  readonly enforced: boolean;
  readonly errors: string[];
}

export function buildProductionHardeningGatePublicSummary(
  verification: ProductionHardeningGateVerification,
  publicSummary = defaultProductionHardeningPublicSummary(
    verification.enforced,
  ),
): ProductionHardeningGatePublicSummary {
  const errors = productionHardeningPublicSummaryErrors(publicSummary);
  if (errors.length) throw new Error(errors.join("\n"));
  return {
    kind: "takosumi.production-hardening-gate-public-summary@v2",
    status: verification.enforced ? "enforced" : "validated",
    enforced: verification.enforced,
    date: verification.generatedAt.slice(0, 10),
    environment: verification.environment,
    gate: "platform-hardening-gates",
    validator: {
      manifestDigest: verification.manifestDigest,
      contributions: verification.contributions.map(({ id, capability }) => ({
        id,
        capability,
      })),
    },
    privateEvidenceRefClass: evidenceRefClassForContributions(
      verification.contributions,
    ),
    publicResult: publicSummary.trim(),
    notes: verification.enforced
      ? "Configured hardening contributions and pinned evidence are enforced; raw evidence remains in the operator evidence store."
      : "Configured hardening contributions and pinned evidence were validated, but runtime enforcement is not enabled.",
  };
}

export function validateProductionHardeningGatePublicSummaryArtifact(
  summary: unknown,
  verification: ProductionHardeningGateVerification,
): ProductionHardeningGatePublicSummaryReport {
  const errors: string[] = [];
  if (!isRecord(summary)) {
    return summaryReport(verification, ["summary must be an object"]);
  }
  if (summary.kind !== "takosumi.production-hardening-gate-public-summary@v2") {
    errors.push(
      "kind must be takosumi.production-hardening-gate-public-summary@v2",
    );
  }
  const expectedStatus = verification.enforced ? "enforced" : "validated";
  if (summary.status !== expectedStatus)
    errors.push(`status must be ${expectedStatus}`);
  if (summary.enforced !== verification.enforced) {
    errors.push("enforced must match gate verification");
  }
  if (summary.date !== verification.generatedAt.slice(0, 10)) {
    errors.push("date must match manifest generatedAt date");
  }
  if (summary.environment !== verification.environment) {
    errors.push("environment must match manifest environment");
  }
  if (summary.gate !== "platform-hardening-gates") {
    errors.push("gate must be platform-hardening-gates");
  }
  const validator = isRecord(summary.validator) ? summary.validator : undefined;
  if (!validator) {
    errors.push("validator must be an object");
  } else {
    if (validator.manifestDigest !== verification.manifestDigest) {
      errors.push("validator.manifestDigest must match manifest digest");
    }
    const contributions = Array.isArray(validator.contributions)
      ? validator.contributions
      : undefined;
    if (!contributions) {
      errors.push("validator.contributions must be an array");
    } else if (
      JSON.stringify(contributions) !==
      JSON.stringify(
        verification.contributions.map(({ id, capability }) => ({
          id,
          capability,
        })),
      )
    ) {
      errors.push("validator.contributions must match gate verification");
    }
    for (const key of Object.keys(validator)) {
      if (key !== "manifestDigest" && key !== "contributions") {
        errors.push(`validator.${key} is not public summary material`);
      }
    }
  }
  const expectedRefClass = evidenceRefClassForContributions(
    verification.contributions,
  );
  if (summary.privateEvidenceRefClass !== expectedRefClass) {
    errors.push("privateEvidenceRefClass must match redacted evidence refs");
  }
  if (
    typeof summary.privateEvidenceRefClass !== "string" ||
    !hasPublicSafeEvidenceRefClass(summary.privateEvidenceRefClass)
  ) {
    errors.push("privateEvidenceRefClass must be a redacted scheme class");
  }
  if (typeof summary.publicResult !== "string") {
    errors.push("publicResult is required");
  } else {
    errors.push(
      ...productionHardeningPublicSummaryErrors(summary.publicResult),
    );
  }
  if (typeof summary.notes !== "string") {
    errors.push("notes is required");
  } else {
    errors.push(
      ...productionHardeningPublicSummaryErrors(summary.notes).map((error) =>
        error.replace("--public-summary", "notes"),
      ),
    );
  }
  return summaryReport(verification, errors);
}

export function formatProductionHardeningGatePublicSummaryMarkdownRow(
  summary: ProductionHardeningGatePublicSummary,
): string {
  return [
    summary.date,
    summary.status,
    summary.environment,
    summary.gate,
    summary.privateEvidenceRefClass,
    summary.validator.manifestDigest,
    summary.validator.contributions.map(({ id }) => id).join(", "),
    summary.publicResult,
  ]
    .map(markdownTableCell)
    .join(" | ")
    .replace(/^/, "| ")
    .replace(/$/, " |");
}

function readHardeningGateResponse(
  value: unknown,
): ProductionHardeningGateResult {
  const row = record(value, "production hardening gate response");
  if (row.kind !== TAKOSUMI_PRODUCTION_HARDENING_GATE_RESULT_KIND) {
    throw new Error(
      `production hardening gate response kind must be ${TAKOSUMI_PRODUCTION_HARDENING_GATE_RESULT_KIND}`,
    );
  }
  if (typeof row.ok !== "boolean" || typeof row.enforced !== "boolean") {
    throw new Error("production hardening gate response flags are invalid");
  }
  if (
    !Array.isArray(row.configurationErrors) ||
    !row.configurationErrors.every((value) => typeof value === "string")
  ) {
    throw new Error(
      "production hardening gate response configurationErrors must be a string array",
    );
  }
  if (!Array.isArray(row.contributions)) {
    throw new Error(
      "production hardening gate response contributions must be an array",
    );
  }
  const contributions = row.contributions.map(readContributionResult);
  if (
    new Set(contributions.map(({ id }) => id)).size !== contributions.length
  ) {
    throw new Error(
      "production hardening gate response contribution ids must be unique",
    );
  }
  return {
    kind: TAKOSUMI_PRODUCTION_HARDENING_GATE_RESULT_KIND,
    ok: row.ok,
    enforced: row.enforced,
    configurationErrors: row.configurationErrors,
    contributions,
  };
}

function readContributionResult(
  value: unknown,
  index: number,
): ProductionHardeningContributionResult {
  const row = record(value, `production hardening contribution ${index}`);
  if (
    typeof row.id !== "string" ||
    !row.id.trim() ||
    typeof row.capability !== "string" ||
    !row.capability.trim() ||
    !Array.isArray(row.checks)
  ) {
    throw new Error(`production hardening contribution ${index} is invalid`);
  }
  const checks = row.checks.map((check, checkIndex) =>
    readHardeningGateCheck(check, `${row.id}/${checkIndex}`),
  );
  if (new Set(checks.map(({ id }) => id)).size !== checks.length) {
    throw new Error(
      `production hardening contribution ${row.id} check ids must be unique`,
    );
  }
  return { id: row.id, capability: row.capability, checks };
}

function readHardeningGateCheck(
  value: unknown,
  label: string,
): ProductionHardeningCheck {
  const row = record(value, `production hardening gate ${label}`);
  if (typeof row.id !== "string" || !row.id.trim()) {
    throw new Error(`production hardening gate ${label}.id is required`);
  }
  if (typeof row.ok !== "boolean") {
    throw new Error(`production hardening gate ${label}.ok must be boolean`);
  }
  return {
    id: row.id,
    ok: row.ok,
    evidenceRef:
      typeof row.evidenceRef === "string" ? row.evidenceRef : undefined,
    evidenceDigest:
      typeof row.evidenceDigest === "string" ? row.evidenceDigest : undefined,
    reason: typeof row.reason === "string" ? row.reason : undefined,
  };
}

async function fetchHardeningGateResponse(
  gateUrl: string,
  options: ProductionHardeningGateVerificationOptions,
): Promise<unknown> {
  const parsed = new URL(gateUrl);
  if (parsed.protocol !== "https:" && parsed.hostname !== "localhost") {
    throw new Error("production hardening gate URL must be https");
  }
  if (!options.bearerToken) {
    throw new Error("production hardening gate bearer token is required");
  }
  const response = await (options.fetch ?? fetch)(parsed, {
    headers: {
      authorization: `Bearer ${options.bearerToken}`,
      accept: "application/json",
    },
  });
  if (!response.ok) {
    throw new Error(
      `production hardening gate request failed: HTTP ${response.status}`,
    );
  }
  return await response.json();
}

function requireSameMembers(
  actual: readonly string[],
  expected: readonly string[],
  label: string,
): void {
  const duplicate = actual.find(
    (value, index) => actual.indexOf(value) !== index,
  );
  if (duplicate) throw new Error(`${label} has duplicate ${duplicate}`);
  for (const value of expected) {
    if (!actual.includes(value))
      throw new Error(`${label} is missing ${value}`);
  }
  for (const value of actual) {
    if (!expected.includes(value))
      throw new Error(`${label} has unknown ${value}`);
  }
}

function summaryReport(
  verification: ProductionHardeningGateVerification,
  errors: string[],
): ProductionHardeningGatePublicSummaryReport {
  return {
    kind: "takosumi.production-hardening-gate-public-summary-report@v2",
    valid: errors.length === 0,
    enforced: verification.enforced,
    errors,
  };
}

function defaultProductionHardeningPublicSummary(enforced: boolean): string {
  return enforced
    ? "Pinned operator evidence for every configured production-hardening contribution was validated and enforced by the platform gate."
    : "Pinned operator evidence for every configured production-hardening contribution was validated, but enforcement is not enabled.";
}

function productionHardeningPublicSummaryErrors(value: string): string[] {
  const summary = value.trim();
  const errors: string[] = [];
  if (summary.length < 40) {
    errors.push("--public-summary must be at least 40 characters");
  }
  if (
    /[<>{}]|todo|tbd|placeholder|example\.com|localhost|127\.0\.0\.1/iu.test(
      summary,
    )
  ) {
    errors.push("--public-summary must not be a placeholder");
  }
  if (
    /\b(?:git\+ssh|git\+https|https?|ssh|vault):\/\/[^\s|]+/iu.test(summary) ||
    /\b[a-z0-9+.-]+:\/\/\.\.\.[^\s|]*/iu.test(summary) ||
    /(?:^|[\s/])evidence\/[A-Za-z0-9._/-]+/u.test(summary) ||
    /takosumi-private/iu.test(summary)
  ) {
    errors.push("--public-summary must not contain private evidence refs");
  }
  if (/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu.test(summary)) {
    errors.push("--public-summary must not contain email addresses");
  }
  if (
    /\b(?:authorization:\s*)?bearer\s+[A-Za-z0-9._-]{10,}\b/iu.test(summary)
  ) {
    errors.push("--public-summary must not contain secrets or bearer tokens");
  }
  if (
    /\barn:aws[a-z-]*:[^\s]+:\d{12}:[^\s]+/iu.test(summary) ||
    /\b\d{12}\b/u.test(summary)
  ) {
    errors.push("--public-summary must not contain provider account IDs");
  }
  if (
    /\b(?:projects|subscriptions|resourceGroups)\/[A-Za-z0-9._:-]{4,}\b/iu.test(
      summary,
    ) ||
    /\b(?:tenant|account|capsule|workspace|resource)[_-]?(?:id)?[:=]\s*[A-Za-z0-9._:-]{6,}\b/iu.test(
      summary,
    ) ||
    /\b(?:acct|capsule|workspace|run|res)_[A-Za-z0-9._-]{6,}\b/u.test(summary)
  ) {
    errors.push("--public-summary must not contain internal resource IDs");
  }
  return errors;
}

function evidenceRefClassForContributions(
  contributions: readonly VerifiedHardeningContribution[],
): string {
  const classes = new Set<string>();
  for (const contribution of contributions) {
    for (const check of contribution.checks) {
      classes.add(publicEvidenceRefClass(check.evidenceRef));
    }
  }
  return [...classes].sort().join(", ");
}

function hasPublicSafeEvidenceRefClass(value: string): boolean {
  return /^([a-z][a-z0-9+.-]*:\/\/\.\.\.)(,\s*[a-z][a-z0-9+.-]*:\/\/\.\.\.)*$/i.test(
    value,
  );
}

function publicEvidenceRefClass(ref: string): string {
  const match = ref.trim().match(/^([a-z][a-z0-9+.-]*):\/\//i);
  return match ? `${match[1].toLowerCase()}://...` : "opaque-ref";
}

function markdownTableCell(value: string): string {
  return value.replaceAll("|", "\\|").replace(/\s+/g, " ").trim();
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${name} must be an object`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

if (import.meta.main) {
  try {
    const args = parseCliArgs(Bun.argv.slice(2));
    if (!args.manifestPath || (!args.gateResponsePath && !args.gateUrl)) {
      console.log(
        "Usage: bun scripts/verify-production-hardening-gates.ts <manifest.json> <hardening-gates.json> [--contribution contribution.json] [--evidence-root path] [--require-enforced] [--public-summary text] [--markdown-row]\n       bun scripts/verify-production-hardening-gates.ts <manifest.json> --url <operator-origin>/internal/platform/hardening-gates [--contribution contribution.json] [--bearer-env TAKOSUMI_DEPLOY_CONTROL_TOKEN] [--evidence-root path] [--require-enforced]",
      );
      process.exit(
        Bun.argv.some((arg) => arg === "--help" || arg === "-h") ? 0 : 1,
      );
    }
    const contributions = await loadRegistry(args.contributionPaths);
    const options = {
      evidenceRoot: args.evidenceRoot,
      contributions,
      requireEnforced: args.requireEnforced,
      bearerToken: Bun.env[args.bearerEnv],
    };
    const result = args.gateUrl
      ? await verifyProductionHardeningGateUrl(
          args.manifestPath,
          args.gateUrl,
          options,
        )
      : await verifyProductionHardeningGateFiles(
          args.manifestPath,
          args.gateResponsePath!,
          options,
        );
    if (args.publicSummaryFile) {
      const summary = JSON.parse(
        await readFile(args.publicSummaryFile, "utf8"),
      );
      const report = validateProductionHardeningGatePublicSummaryArtifact(
        summary,
        result,
      );
      console.log(JSON.stringify(report, null, 2));
      process.exit(report.valid ? 0 : 1);
    }
    if (args.markdownRow || args.publicSummary) {
      const summary = buildProductionHardeningGatePublicSummary(
        result,
        args.publicSummary,
      );
      console.log(
        args.markdownRow
          ? formatProductionHardeningGatePublicSummaryMarkdownRow(summary)
          : JSON.stringify(summary, null, 2),
      );
    } else {
      console.log(JSON.stringify(result, null, 2));
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

async function loadRegistry(
  paths: readonly string[],
): Promise<readonly PlatformHardeningContribution[]> {
  return platformHardeningContributions(
    await Promise.all(
      paths.map(async (path) => JSON.parse(await readFile(path, "utf8"))),
    ),
  );
}

function parseCliArgs(args: readonly string[]): {
  readonly manifestPath?: string;
  readonly gateResponsePath?: string;
  readonly gateUrl?: string;
  readonly evidenceRoot?: string;
  readonly requireEnforced: boolean;
  readonly bearerEnv: string;
  readonly markdownRow: boolean;
  readonly publicSummary?: string;
  readonly publicSummaryFile?: string;
  readonly contributionPaths: readonly string[];
} {
  let manifestPath: string | undefined;
  let gateResponsePath: string | undefined;
  let gateUrl: string | undefined;
  let evidenceRoot: string | undefined;
  let requireEnforced = false;
  let bearerEnv = "TAKOSUMI_DEPLOY_CONTROL_TOKEN";
  let markdownRow = false;
  let publicSummary: string | undefined;
  let publicSummaryFile: string | undefined;
  const contributionPaths: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") {
      return { requireEnforced, bearerEnv, markdownRow, contributionPaths };
    }
    if (arg === "--require-enforced") {
      requireEnforced = true;
      continue;
    }
    if (arg === "--markdown-row") {
      markdownRow = true;
      continue;
    }
    if (
      arg === "--public-summary" ||
      arg === "--public-summary-file" ||
      arg === "--evidence-root" ||
      arg === "--url" ||
      arg === "--bearer-env" ||
      arg === "--contribution"
    ) {
      const value = args[index + 1];
      if (!value) throw new Error(`${arg} requires a value`);
      if (arg === "--public-summary") publicSummary = value;
      else if (arg === "--public-summary-file") publicSummaryFile = value;
      else if (arg === "--evidence-root") evidenceRoot = value;
      else if (arg === "--url") gateUrl = value;
      else if (arg === "--bearer-env") bearerEnv = value;
      else contributionPaths.push(value);
      index += 1;
      continue;
    }
    if (arg.startsWith("--")) throw new Error(`unknown argument: ${arg}`);
    if (!manifestPath) manifestPath = arg;
    else if (!gateResponsePath) gateResponsePath = arg;
    else throw new Error(`unexpected argument: ${arg}`);
  }
  if (gateUrl && gateResponsePath) {
    throw new Error("pass either a gate response file or --url, not both");
  }
  return {
    manifestPath,
    gateResponsePath,
    gateUrl,
    evidenceRoot,
    requireEnforced,
    bearerEnv,
    markdownRow,
    publicSummary,
    publicSummaryFile,
    contributionPaths,
  };
}
