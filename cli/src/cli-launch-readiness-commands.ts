import { readFile, writeFile } from "node:fs/promises";
import {
  launchReadinessMigrateFinalModelHelpText,
  launchReadinessOidcAccountSecurityEvidenceHelpText,
  launchReadinessProductionTopologyMergeHelpText,
  launchReadinessProductionTopologyPreflightHelpText,
  launchReadinessProductionTopologyTemplateHelpText,
  launchReadinessPublicSummaryHelpText,
  launchReadinessPublicSummaryValidateHelpText,
  launchReadinessTemplateHelpText,
  launchReadinessValidateHelpText,
} from "./cli-help.ts";
import {
  booleanOption,
  optionalIntegerOption,
  optionalStringOption,
  parseOptions,
  validateHttpUrl,
} from "./cli-options.ts";
import {
  buildPlatformReadinessPublicSummary,
  buildPlatformReadinessTemplate,
  buildProductionTopologyTemplate,
  checkedEvidenceRef,
  defaultPlatformReadinessPublicSummary,
  formatPlatformReadinessPublicSummaryMarkdownRow,
  formatPlatformReadinessReport,
  formatProductionTopologyMergeReport,
  formatProductionTopologyPreflightReport,
  platformReadinessPublicSummaryErrors,
  platformReadinessDigest,
  mergeProductionTopologyPreflightReports,
  migratePlatformReadinessDocumentToFinalModel,
  publicEvidenceRefClass,
  validatePlatformReadinessPublicSummaryArtifact,
  validatePlatformReadinessDocument,
  validateProductionTopologyDocument,
} from "./cli-platform-readiness.ts";
import { canonicalJson, isRecord, sha256Hex } from "./cli-util.ts";
import {
  createPlatformReadinessContributionRegistry,
  isPlatformReadinessContribution,
  platformReadinessContributionErrors,
  type PlatformReadinessContribution,
} from "takosumi-contract";
import { platformReadinessDefinitionFromDocument } from "./cli-platform-readiness-definition.ts";
import type { CliIo } from "./cli-io.ts";

const oidcAccountSecurityEvidenceTypes = [
  "key-rotation-drill",
  "client-secret-rotation",
  "audit-event",
] as const;

export async function runLaunchReadinessValidate(
  args: string[],
  io: CliIo,
): Promise<number> {
  const options = parseOptions(args);
  if (options.help) {
    io.stdout(launchReadinessValidateHelpText());
    return 0;
  }
  const file = optionalStringOption(options, "file");
  if (!file) {
    io.stderr("--file is required");
    return 2;
  }

  let document;
  try {
    document = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    return 2;
  }

  const report = {
    ...validatePlatformReadinessDocument(document),
    evidenceDigest: await platformReadinessDigest(document),
  };
  if (booleanOption(options, "json")) {
    io.stdout(JSON.stringify(report, null, 2));
  } else if (report.ready) {
    io.stdout("Platform readiness launch readiness evidence is complete.");
  } else {
    io.stdout(formatPlatformReadinessReport(report));
  }
  return report.ready ? 0 : 1;
}

export async function runLaunchReadinessPublicSummary(
  args: string[],
  io: CliIo,
): Promise<number> {
  if (args[0] === "validate") {
    return await runLaunchReadinessPublicSummaryValidate(args.slice(1), io);
  }
  const options = parseOptions(args);
  if (options.help) {
    io.stdout(launchReadinessPublicSummaryHelpText());
    return 0;
  }
  const file = optionalStringOption(options, "file");
  if (!file) {
    io.stderr("--file is required");
    return 2;
  }

  let document;
  try {
    document = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    return 2;
  }

  const report = {
    ...validatePlatformReadinessDocument(document),
    evidenceDigest: await platformReadinessDigest(document),
  };
  const evidenceRef = optionalStringOption(options, "evidenceRef");
  if (report.ready && !evidenceRef) {
    io.stderr(
      "--evidence-ref is required when readiness evidence is validator-ready",
    );
    return 2;
  }
  let evidenceRefClass: string | null = null;
  if (evidenceRef) {
    const evidenceRefResult = checkedEvidenceRef(evidenceRef, "--evidence-ref");
    if (evidenceRefResult.errors.length > 0) {
      io.stderr(evidenceRefResult.errors.join("\n"));
      return 2;
    }
    evidenceRefClass = publicEvidenceRefClass(evidenceRefResult.ref);
  }

  const publicSummary =
    optionalStringOption(options, "publicSummary") ??
    defaultPlatformReadinessPublicSummary(report.ready);
  const definitionResult = platformReadinessDefinitionFromDocument(document);
  const publicSummaryErrors = [
    ...definitionResult.errors,
    ...platformReadinessPublicSummaryErrors(
      publicSummary,
      { requireLaunchScope: report.ready },
      definitionResult.definition,
    ),
  ];
  if (publicSummaryErrors.length > 0) {
    io.stderr(publicSummaryErrors.join("\n"));
    return 2;
  }

  const summary = buildPlatformReadinessPublicSummary({
    document,
    report,
    evidenceRefClass,
    publicSummary,
  });
  if (booleanOption(options, "markdownRow")) {
    io.stdout(formatPlatformReadinessPublicSummaryMarkdownRow(summary));
  } else {
    io.stdout(JSON.stringify(summary, null, 2));
  }
  return 0;
}

export async function runLaunchReadinessOidcAccountSecurityEvidence(
  args: string[],
  io: CliIo,
): Promise<number> {
  const options = parseOptions(args);
  if (options.help) {
    io.stdout(launchReadinessOidcAccountSecurityEvidenceHelpText());
    return 0;
  }

  try {
    const file = requiredStringOption(options, "file");
    const out = optionalStringOption(options, "out");
    const issuer = normalizedHttpsIssuer(
      requiredStringOption(options, "issuer"),
    );
    const keyId = requiredStringOption(options, "keyId");
    const previousKeyId = requiredStringOption(options, "previousKeyId");
    if (previousKeyId === keyId) {
      throw new TypeError("--previous-key-id must differ from --key-id");
    }
    const rotationRunId = requiredStringOption(options, "rotationRunId");
    const clientId = requiredStringOption(options, "clientId");
    const oldSecretId = requiredStringOption(options, "oldSecretId");
    const newSecretId = requiredStringOption(options, "newSecretId");
    if (oldSecretId === newSecretId) {
      throw new TypeError("--old-secret-id must differ from --new-secret-id");
    }
    const overlapWindowSeconds =
      optionalIntegerOption(options, "overlapWindowSeconds") ??
      missingNumberOption("overlap-window-seconds");
    const revocationEventId = requiredStringOption(
      options,
      "revocationEventId",
    );
    const auditEventId = requiredStringOption(options, "auditEventId");
    const auditSubject = requiredStringOption(options, "auditSubject");
    const owner = requiredStringOption(options, "owner");
    const reviewer = requiredStringOption(options, "reviewer");
    if (owner.trim().toLowerCase() === reviewer.trim().toLowerCase()) {
      throw new TypeError("--reviewer must differ from --owner");
    }
    const environment =
      optionalStringOption(options, "environment") ?? "production";
    if (environment !== "production" && environment !== "staging") {
      throw new TypeError("--environment must be production or staging");
    }
    const completedAt =
      optionalStringOption(options, "completedAt") ?? new Date().toISOString();
    assertIsoTimestamp(completedAt, "--completed-at");
    const refPrefix =
      optionalStringOption(options, "refPrefix") ??
      `vault://platform-readiness/${rotationRunId}/domains/oidc-account-security`;
    assertConcreteEvidenceRefPrefix(refPrefix, "--ref-prefix");

    const jwks = await loadJwks({
      issuer,
      jwksFile: optionalStringOption(options, "jwksFile"),
    });
    const jwksKeyIds = keyIdsFromJwks(jwks);
    if (!jwksKeyIds.includes(keyId)) {
      throw new TypeError(
        `JWKS does not contain --key-id ${keyId}; found ${jwksKeyIds.join(", ") || "no kid values"}`,
      );
    }
    if (!jwksKeyIds.includes(previousKeyId)) {
      throw new TypeError(
        `JWKS does not contain --previous-key-id ${previousKeyId}; overlap JWKS must publish old and new keys`,
      );
    }
    const overlapJwksDigest = `sha256:${await sha256Hex(canonicalJson(jwks))}`;

    const document = JSON.parse(await readFile(file, "utf8"));
    const updatedDocument = mergeOidcAccountSecurityEvidence(document, {
      auditEventId,
      auditSubject,
      clientId,
      completedAt,
      environment,
      issuer,
      jwksKeyIds,
      keyId,
      newSecretId,
      oldSecretId,
      overlapJwksDigest,
      overlapWindowSeconds,
      owner,
      previousKeyId,
      refPrefix,
      reviewer,
      revocationEventId,
      rotationRunId,
    });
    if (out) {
      await writeFile(out, `${JSON.stringify(updatedDocument, null, 2)}\n`);
    }
    const report = validatePlatformReadinessDocument(updatedDocument);
    const oidcGap = report.gapDetails?.find(
      (gap) => gap.scope === "domains" && gap.id === "oidc-account-security",
    );
    const oidcReady = oidcGap === undefined;
    const output = {
      kind: "takosumi.oidc-account-security-readiness-evidence@v1",
      issuer,
      keyId,
      previousKeyId,
      overlapJwksDigest,
      jwksKeyIds,
      oidcReady,
      ...(oidcGap ? { oidcGap } : {}),
      ...(out ? { out } : { document: updatedDocument }),
    };
    if (booleanOption(options, "json") || !out) {
      io.stdout(JSON.stringify(output, null, 2));
    } else if (oidcReady) {
      io.stdout(`Updated ${out}; oidc-account-security evidence is complete.`);
    } else {
      io.stdout(
        `Updated ${out}; oidc-account-security evidence is incomplete.`,
      );
    }
    return oidcReady ? 0 : 1;
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    return error instanceof TypeError ? 2 : 1;
  }
}

async function runLaunchReadinessPublicSummaryValidate(
  args: string[],
  io: CliIo,
): Promise<number> {
  const options = parseOptions(args);
  if (options.help) {
    io.stdout(launchReadinessPublicSummaryValidateHelpText());
    return 0;
  }
  const file = optionalStringOption(options, "file");
  const readinessFile = optionalStringOption(options, "readinessFile");
  if (!file || !readinessFile) {
    io.stderr("--file and --readiness-file are required");
    return 2;
  }

  let summary;
  let readinessDocument;
  try {
    summary = JSON.parse(await readFile(file, "utf8"));
    readinessDocument = JSON.parse(await readFile(readinessFile, "utf8"));
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    return 2;
  }

  const readinessReport = {
    ...validatePlatformReadinessDocument(readinessDocument),
    evidenceDigest: await platformReadinessDigest(readinessDocument),
  };
  const report = validatePlatformReadinessPublicSummaryArtifact(
    summary,
    readinessDocument,
    readinessReport,
  );
  if (booleanOption(options, "json")) {
    io.stdout(JSON.stringify(report, null, 2));
  } else if (report.valid) {
    io.stdout("Platform readiness public summary is valid.");
  } else {
    io.stdout(
      [
        "Platform readiness public summary is invalid.",
        ...report.errors.map((error) => `Error: ${error}`),
      ].join("\n"),
    );
  }
  return report.valid ? 0 : 1;
}

function mergeOidcAccountSecurityEvidence(
  document: unknown,
  input: {
    auditEventId: string;
    auditSubject: string;
    clientId: string;
    completedAt: string;
    environment: string;
    issuer: string;
    jwksKeyIds: readonly string[];
    keyId: string;
    newSecretId: string;
    oldSecretId: string;
    overlapJwksDigest: string;
    overlapWindowSeconds: number;
    owner: string;
    previousKeyId: string;
    refPrefix: string;
    reviewer: string;
    revocationEventId: string;
    rotationRunId: string;
  },
): Record<string, unknown> {
  if (!isRecord(document)) {
    throw new TypeError("readiness document must be a JSON object");
  }
  if (!Array.isArray(document.domains)) {
    throw new TypeError("readiness document domains must be an array");
  }
  const domains = document.domains.map((entry: unknown) => {
    if (!isRecord(entry) || entry.id !== "oidc-account-security") return entry;
    const existingEvidence = Array.isArray(entry.evidence)
      ? entry.evidence.filter(
          (item: unknown) =>
            !isRecord(item) || !isOidcAccountSecurityEvidenceType(item.type),
        )
      : [];
    return {
      ...entry,
      status: "passed",
      owner: input.owner,
      reviewer: input.reviewer,
      environment: input.environment,
      completedAt: input.completedAt,
      evidence: [
        ...existingEvidence,
        {
          type: "key-rotation-drill",
          ref: `${input.refPrefix}/key-rotation-drill`,
          summary:
            "OIDC signing key rotation overlap was verified against the hosted issuer JWKS.",
          private: true,
          publicSummary:
            "OIDC signing key rotation was verified against the hosted issuer JWKS.",
          rotationRunId: input.rotationRunId,
          keyId: input.keyId,
          previousKeyId: input.previousKeyId,
          issuer: input.issuer,
          overlapJwksDigest: input.overlapJwksDigest,
          jwksKeyIds: input.jwksKeyIds,
        },
        {
          type: "client-secret-rotation",
          ref: `${input.refPrefix}/client-secret-rotation`,
          summary:
            "Upstream OAuth client secret rotation and old-secret revocation were recorded.",
          private: true,
          publicSummary:
            "Upstream OAuth client secret rotation and revocation were recorded.",
          rotationRunId: input.rotationRunId,
          clientId: input.clientId,
          oldSecretId: input.oldSecretId,
          newSecretId: input.newSecretId,
          overlapWindowSeconds: input.overlapWindowSeconds,
          revocationEventId: input.revocationEventId,
        },
        {
          type: "audit-event",
          ref: `${input.refPrefix}/audit-event`,
          summary:
            "OIDC account-security rotation was recorded in the operator audit log.",
          private: true,
          publicSummary:
            "OIDC account-security rotation was recorded in the operator audit log.",
          auditEventId: input.auditEventId,
          subject: input.auditSubject,
        },
      ],
    };
  });
  if (
    !domains.some(
      (entry: unknown) =>
        isRecord(entry) && entry.id === "oidc-account-security",
    )
  ) {
    throw new TypeError(
      "readiness document is missing domains.oidc-account-security",
    );
  }
  return { ...document, domains };
}

function isOidcAccountSecurityEvidenceType(
  value: unknown,
): value is (typeof oidcAccountSecurityEvidenceTypes)[number] {
  return (
    typeof value === "string" &&
    oidcAccountSecurityEvidenceTypes.includes(
      value as (typeof oidcAccountSecurityEvidenceTypes)[number],
    )
  );
}

async function loadJwks(input: {
  issuer: string;
  jwksFile?: string;
}): Promise<Record<string, unknown>> {
  if (input.jwksFile) {
    const value = JSON.parse(await readFile(input.jwksFile, "utf8"));
    if (!isRecord(value))
      throw new TypeError("--jwks-file must be a JSON object");
    return value;
  }
  const discoveryUrl = `${input.issuer}/.well-known/openid-configuration`;
  const discovery = await fetchJsonObject(discoveryUrl, "OIDC discovery");
  if (discovery.issuer !== input.issuer) {
    throw new TypeError("OIDC discovery issuer does not match --issuer");
  }
  const jwksUri =
    typeof discovery.jwks_uri === "string" ? discovery.jwks_uri : null;
  if (!jwksUri) throw new TypeError("OIDC discovery is missing jwks_uri");
  return await fetchJsonObject(jwksUri, "OIDC JWKS");
}

async function fetchJsonObject(
  url: string,
  label: string,
): Promise<Record<string, unknown>> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new TypeError(`${label} request failed: HTTP ${response.status}`);
  }
  const value = await response.json();
  if (!isRecord(value))
    throw new TypeError(`${label} response must be an object`);
  return value;
}

function keyIdsFromJwks(jwks: Record<string, unknown>): string[] {
  const keys = Array.isArray(jwks.keys) ? jwks.keys : [];
  return keys
    .map((entry) =>
      isRecord(entry) && typeof entry.kid === "string" ? entry.kid : "",
    )
    .filter(Boolean)
    .sort();
}

function requiredStringOption(
  options: Record<string, string | boolean>,
  key: string,
): string {
  const value = optionalStringOption(options, key);
  if (!value) throw new TypeError(`--${kebabOption(key)} is required`);
  return value;
}

function missingNumberOption(key: string): never {
  throw new TypeError(`--${key} is required`);
}

function normalizedHttpsIssuer(value: string): string {
  const validated = validateHttpUrl(value, "--issuer");
  const url = new URL(validated);
  if (url.protocol !== "https:") {
    throw new TypeError("--issuer must be an https:// URL");
  }
  url.pathname = url.pathname.replace(/\/+$/u, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/u, "");
}

function assertIsoTimestamp(value: string, label: string): void {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value)) {
    throw new TypeError(`${label} must be an ISO-8601 UTC timestamp`);
  }
  const parsed = new Date(value);
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.getTime() > Date.now() + 300000
  ) {
    throw new TypeError(`${label} must be a non-future ISO-8601 UTC timestamp`);
  }
}

function assertConcreteEvidenceRefPrefix(value: string, label: string): void {
  const normalized = value.trim().toLowerCase();
  if (
    normalized.length === 0 ||
    normalized.includes("<") ||
    normalized.includes(">") ||
    normalized.includes("placeholder") ||
    normalized.includes("example.") ||
    normalized.includes("todo") ||
    normalized.includes("tbd")
  ) {
    throw new TypeError(`${label} must be a concrete private evidence ref`);
  }
}

function kebabOption(key: string): string {
  return key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

export async function runLaunchReadinessTemplate(
  args: string[],
  io: CliIo,
): Promise<number> {
  const options = parseOptions(args);
  if (options.help) {
    io.stdout(launchReadinessTemplateHelpText());
    return 0;
  }
  try {
    const contributions = await loadPlatformReadinessContributionFile(
      optionalStringOption(options, "contributionFile"),
    );
    io.stdout(
      JSON.stringify(buildPlatformReadinessTemplate(contributions), null, 2),
    );
    return 0;
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

export async function runLaunchReadinessMigrateFinalModel(
  args: string[],
  io: CliIo,
): Promise<number> {
  const options = parseOptions(args);
  if (options.help) {
    io.stdout(launchReadinessMigrateFinalModelHelpText());
    return 0;
  }
  const file = optionalStringOption(options, "file");
  const out = optionalStringOption(options, "out");
  const dryRun = booleanOption(options, "dryRun");
  const check = booleanOption(options, "check");
  if (!file) {
    io.stderr("--file is required");
    return 2;
  }
  if (!out && !dryRun && !check) {
    io.stderr("--out is required unless --dry-run or --check is set");
    return 2;
  }

  let document;
  try {
    document = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    return 2;
  }

  let contributions: readonly PlatformReadinessContribution[];
  try {
    contributions = await loadPlatformReadinessContributionFile(
      optionalStringOption(options, "contributionFile"),
    );
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    return 2;
  }

  const result = migratePlatformReadinessDocumentToFinalModel(
    document,
    contributions,
  );
  if (out && !dryRun && !check) {
    await writeFile(out, `${JSON.stringify(result.document, null, 2)}\n`);
  }

  if (booleanOption(options, "json")) {
    io.stdout(JSON.stringify(result.report, null, 2));
  } else if (result.report.changed) {
    io.stdout(
      [
        "Platform readiness evidence contains legacy final-model names.",
        ...result.report.changes.map(
          (change) =>
            `  ${change.kind}: ${change.from} -> ${change.to} (${change.count})`,
        ),
        out && !dryRun && !check ? `Wrote migrated evidence to ${out}` : null,
      ]
        .filter((line): line is string => typeof line === "string")
        .join("\n"),
    );
  } else {
    io.stdout("Platform readiness evidence already uses final-model names.");
  }
  return check && result.report.changed ? 1 : 0;
}

async function loadPlatformReadinessContributionFile(
  file: string | undefined,
): Promise<readonly PlatformReadinessContribution[]> {
  if (!file) return [];
  const parsed = JSON.parse(await readFile(file, "utf8")) as unknown;
  const values = Array.isArray(parsed) ? parsed : [parsed];
  if (values.length === 0) {
    throw new TypeError("--contribution-file must not be an empty array");
  }
  const errors = values.flatMap((value, index) =>
    isPlatformReadinessContribution(value)
      ? []
      : platformReadinessContributionErrors(
          value,
          `--contribution-file entry ${index}`,
        ),
  );
  if (errors.length > 0) throw new TypeError(errors.join("\n"));
  return createPlatformReadinessContributionRegistry(values).contributions;
}

export function runLaunchReadinessProductionTopologyTemplate(
  args: string[],
  io: CliIo,
): number {
  const options = parseOptions(args);
  if (options.help) {
    io.stdout(launchReadinessProductionTopologyTemplateHelpText());
    return 0;
  }
  const environment = optionalStringOption(options, "environment") ?? "staging";
  if (environment !== "staging" && environment !== "production") {
    io.stderr("--environment must be staging or production");
    return 2;
  }
  io.stdout(
    JSON.stringify(buildProductionTopologyTemplate(environment), null, 2),
  );
  return 0;
}

export async function runLaunchReadinessProductionTopologyPreflight(
  args: string[],
  io: CliIo,
): Promise<number> {
  const options = parseOptions(args);
  if (options.help) {
    io.stdout(launchReadinessProductionTopologyPreflightHelpText());
    return 0;
  }
  const file = optionalStringOption(options, "file");
  if (!file) {
    io.stderr("--file is required");
    return 2;
  }

  let document;
  try {
    document = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    return 2;
  }

  const report = validateProductionTopologyDocument(document);
  if (booleanOption(options, "json")) {
    io.stdout(JSON.stringify(report, null, 2));
  } else if (report.ready) {
    io.stdout("Production topology preflight passed.");
  } else {
    io.stdout(formatProductionTopologyPreflightReport(report));
  }
  return report.ready ? 0 : 1;
}

export async function runLaunchReadinessProductionTopologyMerge(
  args: string[],
  io: CliIo,
): Promise<number> {
  const options = parseOptions(args);
  if (options.help) {
    io.stdout(launchReadinessProductionTopologyMergeHelpText());
    return 0;
  }
  const stagingReportFile = optionalStringOption(options, "stagingReport");
  const productionReportFile = optionalStringOption(
    options,
    "productionReport",
  );
  if (!stagingReportFile || !productionReportFile) {
    io.stderr("--staging-report and --production-report are required");
    return 2;
  }

  let stagingReport;
  let productionReport;
  try {
    stagingReport = JSON.parse(await readFile(stagingReportFile, "utf8"));
    productionReport = JSON.parse(await readFile(productionReportFile, "utf8"));
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    return 2;
  }

  const report = mergeProductionTopologyPreflightReports(
    stagingReport,
    productionReport,
  );
  if (booleanOption(options, "json")) {
    io.stdout(JSON.stringify(report, null, 2));
  } else if (report.ready) {
    io.stdout("Production topology evidence merge passed.");
  } else {
    io.stdout(formatProductionTopologyMergeReport(report));
  }
  return report.ready ? 0 : 1;
}
