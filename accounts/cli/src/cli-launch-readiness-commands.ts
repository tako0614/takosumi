import { readFile, writeFile } from "node:fs/promises";
import {
  launchReadinessMigrateFinalModelHelpText,
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
  optionalStringOption,
  parseOptions,
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
import type { CliIo } from "./cli-io.ts";

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
  const publicSummaryErrors = platformReadinessPublicSummaryErrors(
    publicSummary,
    { requireLaunchScope: report.ready },
  );
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

export function runLaunchReadinessTemplate(args: string[], io: CliIo): number {
  const options = parseOptions(args);
  if (options.help) {
    io.stdout(launchReadinessTemplateHelpText());
    return 0;
  }
  io.stdout(JSON.stringify(buildPlatformReadinessTemplate(), null, 2));
  return 0;
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

  const result = migratePlatformReadinessDocumentToFinalModel(document);
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
