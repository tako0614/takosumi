import { readFile } from "node:fs/promises";
import {
  type ProductionHardeningEvidenceValidation,
  validateProductionHardeningEvidenceFile,
} from "./validate-production-hardening-evidence.ts";

const REQUIRED_CHECKS = [
  "containerSmoke",
  "egressEnforcement",
  "providerTemplates",
  "secretBoundary",
] as const;

type RequiredCheck = (typeof REQUIRED_CHECKS)[number];

const EVIDENCE_ENV_BY_CHECK: Record<
  RequiredCheck,
  { readonly ref: string; readonly digest: string }
> = {
  containerSmoke: {
    ref: "TAKOSUMI_CLOUDFLARE_CONTAINER_SMOKE_EVIDENCE_REF",
    digest: "TAKOSUMI_CLOUDFLARE_CONTAINER_SMOKE_EVIDENCE_DIGEST",
  },
  egressEnforcement: {
    ref: "TAKOSUMI_EGRESS_ENFORCEMENT_EVIDENCE_REF",
    digest: "TAKOSUMI_EGRESS_ENFORCEMENT_EVIDENCE_DIGEST",
  },
  providerTemplates: {
    ref: "TAKOSUMI_PROVIDER_CATALOG_EVIDENCE_REF",
    digest: "TAKOSUMI_PROVIDER_CATALOG_EVIDENCE_DIGEST",
  },
  secretBoundary: {
    ref: "TAKOSUMI_SECRET_BOUNDARY_EVIDENCE_REF",
    digest: "TAKOSUMI_SECRET_BOUNDARY_EVIDENCE_DIGEST",
  },
};

interface HardeningGateResponse {
  readonly ok: boolean;
  readonly enforced: boolean;
  readonly checks: Record<RequiredCheck, HardeningGateCheck>;
}

interface HardeningGateCheck {
  readonly ok: boolean;
  readonly evidenceRef?: string;
  readonly evidenceDigest?: string;
  readonly reason?: string;
}

export interface ProductionHardeningGateVerification {
  readonly status: "passed";
  readonly manifestDigest: string;
  readonly generatedAt: string;
  readonly environment: ProductionHardeningEvidenceValidation["environment"];
  readonly enforced: boolean;
  readonly checks: Record<
    RequiredCheck,
    {
      readonly evidenceRef: string;
      readonly evidenceDigest: string;
    }
  >;
}

export interface ProductionHardeningGateVerificationOptions {
  readonly evidenceRoot?: string;
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
    { evidenceRoot: options.evidenceRoot },
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
    { evidenceRoot: options.evidenceRoot },
  );
  const response = await fetchHardeningGateResponse(gateUrl, options);
  return verifyProductionHardeningGateResponse(
    manifestValidation,
    response,
    options,
  );
}

export function verifyProductionHardeningGateResponse(
  manifestValidation: ProductionHardeningEvidenceValidation,
  gateResponse: unknown,
  options: ProductionHardeningGateVerificationOptions = {},
): ProductionHardeningGateVerification {
  const response = readHardeningGateResponse(gateResponse);
  if (!response.ok) {
    throw new Error("production hardening gate response is not ok");
  }
  if (options.requireEnforced && !response.enforced) {
    throw new Error("production hardening gate is not enforced");
  }

  const checks: ProductionHardeningGateVerification["checks"] = {
    containerSmoke: verifyGateCheck(
      "containerSmoke",
      response.checks.containerSmoke,
      manifestValidation.env,
    ),
    egressEnforcement: verifyGateCheck(
      "egressEnforcement",
      response.checks.egressEnforcement,
      manifestValidation.env,
    ),
    providerTemplates: verifyGateCheck(
      "providerTemplates",
      response.checks.providerTemplates,
      manifestValidation.env,
    ),
    secretBoundary: verifyGateCheck(
      "secretBoundary",
      response.checks.secretBoundary,
      manifestValidation.env,
    ),
  };

  return {
    status: "passed",
    manifestDigest: manifestValidation.manifestDigest,
    generatedAt: manifestValidation.generatedAt,
    environment: manifestValidation.environment,
    enforced: response.enforced,
    checks,
  };
}

export interface ProductionHardeningGatePublicSummary {
  readonly kind: "takosumi.production-hardening-gate-public-summary@v1";
  readonly status: "enforced" | "validated";
  readonly enforced: boolean;
  readonly date: string;
  readonly environment: ProductionHardeningGateVerification["environment"];
  readonly gate: "platform-hardening-gates";
  readonly validator: {
    readonly manifestDigest: string;
    readonly checkCount: number;
    readonly checks: readonly RequiredCheck[];
  };
  readonly privateEvidenceRefClass: string;
  readonly publicResult: string;
  readonly notes: string;
}

export interface ProductionHardeningGatePublicSummaryReport {
  readonly kind: "takosumi.production-hardening-gate-public-summary-report@v1";
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
  const publicSummaryErrors =
    productionHardeningPublicSummaryErrors(publicSummary);
  if (publicSummaryErrors.length > 0) {
    throw new Error(publicSummaryErrors.join("\n"));
  }
  return {
    kind: "takosumi.production-hardening-gate-public-summary@v1",
    status: verification.enforced ? "enforced" : "validated",
    enforced: verification.enforced,
    date: verification.generatedAt.slice(0, 10),
    environment: verification.environment,
    gate: "platform-hardening-gates",
    validator: {
      manifestDigest: verification.manifestDigest,
      checkCount: REQUIRED_CHECKS.length,
      checks: [...REQUIRED_CHECKS],
    },
    privateEvidenceRefClass: evidenceRefClassForChecks(verification.checks),
    publicResult: publicSummary.trim(),
    notes: verification.enforced
      ? "Internal hardening gate is enforced; raw evidence remains in the private operator evidence store."
      : "Internal hardening gate validated but is not enforced.",
  };
}

export function validateProductionHardeningGatePublicSummaryArtifact(
  summary: unknown,
  verification: ProductionHardeningGateVerification,
): ProductionHardeningGatePublicSummaryReport {
  const errors: string[] = [];
  if (!isRecord(summary)) {
    return {
      kind: "takosumi.production-hardening-gate-public-summary-report@v1",
      valid: false,
      enforced: verification.enforced,
      errors: ["summary must be an object"],
    };
  }
  if (summary.kind !== "takosumi.production-hardening-gate-public-summary@v1") {
    errors.push(
      "kind must be takosumi.production-hardening-gate-public-summary@v1",
    );
  }
  const expectedStatus = verification.enforced ? "enforced" : "validated";
  if (summary.status !== expectedStatus) {
    errors.push(`status must be ${expectedStatus}`);
  }
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
    if (validator.checkCount !== REQUIRED_CHECKS.length) {
      errors.push("validator.checkCount must match required check count");
    }
    if (!sameStringArray(validator.checks, REQUIRED_CHECKS)) {
      errors.push("validator.checks must match required checks");
    }
  }
  if (
    summary.privateEvidenceRefClass !==
    evidenceRefClassForChecks(verification.checks)
  ) {
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
  return {
    kind: "takosumi.production-hardening-gate-public-summary-report@v1",
    valid: errors.length === 0,
    enforced: verification.enforced,
    errors,
  };
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
    summary.publicResult,
  ]
    .map(markdownTableCell)
    .join(" | ")
    .replace(/^/, "| ")
    .replace(/$/, " |");
}

function verifyGateCheck(
  name: RequiredCheck,
  check: HardeningGateCheck,
  env: Record<string, string>,
): { readonly evidenceRef: string; readonly evidenceDigest: string } {
  if (!check.ok) {
    throw new Error(
      `production hardening gate ${name} failed${
        check.reason ? `: ${check.reason}` : ""
      }`,
    );
  }
  const expected = EVIDENCE_ENV_BY_CHECK[name];
  const expectedRef = env[expected.ref];
  const expectedDigest = env[expected.digest];
  if (check.evidenceRef !== expectedRef) {
    throw new Error(`production hardening gate ${name} evidenceRef drifted`);
  }
  if (check.evidenceDigest !== expectedDigest) {
    throw new Error(`production hardening gate ${name} evidenceDigest drifted`);
  }
  return { evidenceRef: expectedRef, evidenceDigest: expectedDigest };
}

function readHardeningGateResponse(value: unknown): HardeningGateResponse {
  const row = record(value, "production hardening gate response");
  if (typeof row.ok !== "boolean") {
    throw new Error("production hardening gate response ok must be boolean");
  }
  if (typeof row.enforced !== "boolean") {
    throw new Error(
      "production hardening gate response enforced must be boolean",
    );
  }
  const checksRow = record(row.checks, "production hardening gate checks");
  const checks = {} as Record<RequiredCheck, HardeningGateCheck>;
  for (const name of REQUIRED_CHECKS) {
    checks[name] = readHardeningGateCheck(checksRow[name], name);
  }
  return { ok: row.ok, enforced: row.enforced, checks };
}

async function fetchHardeningGateResponse(
  gateUrl: string,
  options: ProductionHardeningGateVerificationOptions,
): Promise<unknown> {
  const parsed = new URL(gateUrl);
  if (parsed.protocol !== "https:" && parsed.hostname !== "localhost") {
    throw new Error("production hardening gate URL must be https");
  }
  const bearerToken = options.bearerToken;
  if (!bearerToken) {
    throw new Error("production hardening gate bearer token is required");
  }
  const fetchImpl = options.fetch ?? fetch;
  const response = await fetchImpl(parsed, {
    headers: {
      authorization: `Bearer ${bearerToken}`,
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

function readHardeningGateCheck(
  value: unknown,
  name: RequiredCheck,
): HardeningGateCheck {
  const row = record(value, `production hardening gate ${name}`);
  if (typeof row.ok !== "boolean") {
    throw new Error(`production hardening gate ${name}.ok must be boolean`);
  }
  return {
    ok: row.ok,
    evidenceRef:
      typeof row.evidenceRef === "string" ? row.evidenceRef : undefined,
    evidenceDigest:
      typeof row.evidenceDigest === "string" ? row.evidenceDigest : undefined,
    reason: typeof row.reason === "string" ? row.reason : undefined,
  };
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

if (import.meta.main) {
  try {
    const {
      manifestPath,
      gateResponsePath,
      gateUrl,
      evidenceRoot,
      requireEnforced,
      bearerEnv,
      markdownRow,
      publicSummary,
      publicSummaryFile,
    } = parseCliArgs(Bun.argv.slice(2));
    if (!manifestPath || (!gateResponsePath && !gateUrl)) {
      console.log(
        "Usage: bun scripts/verify-production-hardening-gates.ts <manifest.json> <hardening-gates.json> [--evidence-root path] [--require-enforced] [--public-summary text] [--markdown-row]\n       bun scripts/verify-production-hardening-gates.ts <manifest.json> --url https://app.takosumi.com/internal/platform/hardening-gates [--bearer-env TAKOSUMI_DEPLOY_CONTROL_TOKEN] [--evidence-root path] [--require-enforced] [--public-summary text] [--markdown-row]\n       bun scripts/verify-production-hardening-gates.ts <manifest.json> <hardening-gates.json> --public-summary-file <summary.json> [--require-enforced]",
      );
      process.exit(
        Bun.argv.some((arg) => arg === "--help" || arg === "-h") ? 0 : 1,
      );
    }
    const result = gateUrl
      ? await verifyProductionHardeningGateUrl(manifestPath, gateUrl, {
          evidenceRoot,
          requireEnforced,
          bearerToken: Bun.env[bearerEnv],
        })
      : await verifyProductionHardeningGateFiles(
          manifestPath,
          gateResponsePath!,
          { evidenceRoot, requireEnforced },
        );
    if (publicSummaryFile) {
      const summary = JSON.parse(await readFile(publicSummaryFile, "utf8"));
      const report = validateProductionHardeningGatePublicSummaryArtifact(
        summary,
        result,
      );
      console.log(JSON.stringify(report, null, 2));
      process.exit(report.valid ? 0 : 1);
    }
    if (markdownRow || publicSummary) {
      const summary = buildProductionHardeningGatePublicSummary(
        result,
        publicSummary,
      );
      console.log(
        markdownRow
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

function parseCliArgs(args: readonly string[]): {
  readonly manifestPath?: string;
  readonly gateResponsePath?: string;
  readonly gateUrl?: string;
  readonly evidenceRoot?: string;
  readonly requireEnforced?: boolean;
  readonly bearerEnv: string;
  readonly markdownRow: boolean;
  readonly publicSummary?: string;
  readonly publicSummaryFile?: string;
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
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") return {};
    if (arg === "--require-enforced") {
      requireEnforced = true;
      continue;
    }
    if (arg === "--markdown-row") {
      markdownRow = true;
      continue;
    }
    if (arg === "--public-summary") {
      publicSummary = args[index + 1];
      if (!publicSummary) throw new Error("--public-summary requires text");
      index += 1;
      continue;
    }
    if (arg === "--public-summary-file") {
      publicSummaryFile = args[index + 1];
      if (!publicSummaryFile) {
        throw new Error("--public-summary-file requires a path");
      }
      index += 1;
      continue;
    }
    if (arg === "--evidence-root") {
      evidenceRoot = args[index + 1];
      if (!evidenceRoot) throw new Error("--evidence-root requires a path");
      index += 1;
      continue;
    }
    if (arg === "--url") {
      gateUrl = args[index + 1];
      if (!gateUrl) throw new Error("--url requires a URL");
      index += 1;
      continue;
    }
    if (arg === "--bearer-env") {
      bearerEnv = args[index + 1];
      if (!bearerEnv) throw new Error("--bearer-env requires an env var name");
      index += 1;
      continue;
    }
    if (arg.startsWith("--")) throw new Error(`unknown argument: ${arg}`);
    if (!manifestPath) {
      manifestPath = arg;
      continue;
    }
    if (!gateResponsePath) {
      gateResponsePath = arg;
      continue;
    }
    throw new Error(`unexpected argument: ${arg}`);
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
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameStringArray(value: unknown, expected: readonly string[]): boolean {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every((item, index) => item === expected[index])
  );
}

function defaultProductionHardeningPublicSummary(enforced: boolean): string {
  return enforced
    ? "Container smoke, egress enforcement, provider templates, and secret-boundary hardening checks passed the enforced platform gate."
    : "Container smoke, egress enforcement, provider templates, and secret-boundary hardening checks passed validation but enforcement is not enabled.";
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
    /\b(?:cus|sub|in|pi|pm|price|prod|cs|evt|re|cn)_[A-Za-z0-9_]{6,}\b/u.test(
      summary,
    )
  ) {
    errors.push("--public-summary must not contain Stripe object IDs");
  }
  if (
    /\bsk_(?:test|live)_[A-Za-z0-9]{6,}\b/u.test(summary) ||
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
    /\b(?:tenant|account|installation|space|resource)[_-]?(?:id)?[:=]\s*[A-Za-z0-9._:-]{6,}\b/iu.test(
      summary,
    ) ||
    /\b(?:acct|inst|tenant|space|run|res)_[A-Za-z0-9._-]{6,}\b/u.test(summary)
  ) {
    errors.push("--public-summary must not contain internal resource IDs");
  }
  return errors;
}

function evidenceRefClassForChecks(
  checks: ProductionHardeningGateVerification["checks"],
): string {
  const classes = new Set<string>();
  for (const check of Object.values(checks)) {
    classes.add(publicEvidenceRefClass(check.evidenceRef));
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
