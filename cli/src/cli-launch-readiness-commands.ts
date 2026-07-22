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

const identitySecurityRotationLogKind =
  "takosumi.identity-security-rotation-log@v1";

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
    const rotationLog = await loadIdentitySecurityRotationLog(
      requiredStringOption(options, "rotationLogFile"),
      issuer,
    );
    const refPrefix =
      optionalStringOption(options, "refPrefix") ??
      `vault://platform-readiness/${rotationLog.rotationRunId}/identity-security-rotation`;
    assertConcreteEvidenceRefPrefix(refPrefix, "--ref-prefix");

    const overlapJwks = await loadPublicJwksFile(
      requiredStringOption(options, "overlapJwksFile"),
      "--overlap-jwks-file",
    );
    const postRevocationJwks = await loadPublicJwksFile(
      requiredStringOption(options, "postRevocationJwksFile"),
      "--post-revocation-jwks-file",
    );
    const overlapJwksKeyIds = keyIdsFromJwks(overlapJwks);
    const postRevocationJwksKeyIds = keyIdsFromJwks(postRevocationJwks);
    if (!overlapJwksKeyIds.includes(rotationLog.keyRotation.keyId)) {
      throw new TypeError(
        `overlap JWKS does not contain active key id ${rotationLog.keyRotation.keyId}`,
      );
    }
    if (!overlapJwksKeyIds.includes(rotationLog.keyRotation.previousKeyId)) {
      throw new TypeError(
        `overlap JWKS does not contain previous key id ${rotationLog.keyRotation.previousKeyId}`,
      );
    }
    if (!postRevocationJwksKeyIds.includes(rotationLog.keyRotation.keyId)) {
      throw new TypeError(
        `post-revocation JWKS does not contain active key id ${rotationLog.keyRotation.keyId}`,
      );
    }
    if (
      postRevocationJwksKeyIds.includes(rotationLog.keyRotation.previousKeyId)
    ) {
      throw new TypeError(
        `post-revocation JWKS still contains previous key id ${rotationLog.keyRotation.previousKeyId}`,
      );
    }
    const overlapJwksDigest = `sha256:${await sha256Hex(canonicalJson(overlapJwks))}`;
    const postRevocationJwksDigest = `sha256:${await sha256Hex(canonicalJson(postRevocationJwks))}`;

    const document = JSON.parse(await readFile(file, "utf8"));
    const updatedDocument = mergeOidcAccountSecurityEvidence(document, {
      ...rotationLog,
      issuer,
      overlapJwksKeyIds,
      overlapJwksDigest,
      postRevocationJwksKeyIds,
      postRevocationJwksDigest,
      refPrefix,
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
      keyId: rotationLog.keyRotation.keyId,
      previousKeyId: rotationLog.keyRotation.previousKeyId,
      overlapJwksDigest,
      postRevocationJwksDigest,
      overlapJwksKeyIds,
      postRevocationJwksKeyIds,
      rotationRunId: rotationLog.rotationRunId,
      securityRotationRunLogMerged: true,
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
    auditEvent: IdentitySecurityRotationLog["auditEvent"];
    completedAt: string;
    environment: "production" | "staging";
    issuer: string;
    keyRotation: IdentitySecurityRotationLog["keyRotation"];
    clientSecretRotation: IdentitySecurityRotationLog["clientSecretRotation"];
    overlapJwksKeyIds: readonly string[];
    overlapJwksDigest: string;
    owner: string;
    postRevocationJwksKeyIds: readonly string[];
    postRevocationJwksDigest: string;
    refPrefix: string;
    reviewer: string;
    rotationRunId: string;
    startedAt: string;
    result: "passed";
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
          ref: `${input.refPrefix}/domains/oidc-account-security/key-rotation-drill`,
          summary:
            "OIDC signing key overlap and previous-key removal were verified against captured hosted issuer JWKS documents.",
          private: true,
          publicSummary:
            "OIDC signing key overlap and previous-key removal were verified.",
          rotationRunId: input.rotationRunId,
          keyId: input.keyRotation.keyId,
          previousKeyId: input.keyRotation.previousKeyId,
          issuer: input.issuer,
          overlapJwksDigest: input.overlapJwksDigest,
          postRevocationJwksDigest: input.postRevocationJwksDigest,
          overlapJwksKeyIds: input.overlapJwksKeyIds,
          postRevocationJwksKeyIds: input.postRevocationJwksKeyIds,
          previousKeyRemovedAt: input.keyRotation.previousKeyRemovedAt,
        },
        {
          type: "client-secret-rotation",
          ref: `${input.refPrefix}/domains/oidc-account-security/client-secret-rotation`,
          summary:
            "Upstream OAuth client secret rotation and old-secret revocation were recorded.",
          private: true,
          publicSummary:
            "Upstream OAuth client secret rotation and revocation were recorded.",
          rotationRunId: input.rotationRunId,
          clientId: input.clientSecretRotation.clientId,
          oldSecretId: input.clientSecretRotation.oldSecretId,
          newSecretId: input.clientSecretRotation.newSecretId,
          overlapWindowSeconds: input.clientSecretRotation.overlapWindowSeconds,
          revocationEventId: input.clientSecretRotation.revocationEventId,
        },
        {
          type: "audit-event",
          ref: `${input.refPrefix}/domains/oidc-account-security/audit-event`,
          summary:
            "OIDC account-security rotation was recorded in the operator audit log.",
          private: true,
          publicSummary:
            "OIDC account-security rotation was recorded in the operator audit log.",
          auditEventId: input.auditEvent.id,
          subject: input.auditEvent.subject,
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
  let foundSecurityOperations = false;
  const domainsWithRotationLog = domains.map((entry: unknown) => {
    if (!isRecord(entry) || entry.id !== "security-operations") return entry;
    foundSecurityOperations = true;
    const existingEvidence = Array.isArray(entry.evidence)
      ? entry.evidence.filter(
          (item: unknown) =>
            !isRecord(item) || item.type !== "secret-rotation-run-log",
        )
      : [];
    return {
      ...entry,
      evidence: [
        ...existingEvidence,
        {
          type: "secret-rotation-run-log",
          ref: `${input.refPrefix}/domains/security-operations/secret-rotation-run-log`,
          summary:
            "Identity security rotation completed with previous key and OAuth client secret revocation recorded.",
          private: true,
          publicSummary:
            "Identity security secret rotation and revocation were recorded.",
          rotationRunId: input.rotationRunId,
          completedAt: input.completedAt,
          result: input.result,
        },
      ],
    };
  });
  if (!foundSecurityOperations) {
    throw new TypeError(
      "readiness document is missing domains.security-operations",
    );
  }
  return { ...document, domains: domainsWithRotationLog };
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

interface IdentitySecurityRotationLog {
  readonly kind: typeof identitySecurityRotationLogKind;
  readonly rotationRunId: string;
  readonly environment: "production" | "staging";
  readonly issuer: string;
  readonly owner: string;
  readonly reviewer: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly result: "passed";
  readonly keyRotation: {
    readonly keyId: string;
    readonly previousKeyId: string;
    readonly overlapCapturedAt: string;
    readonly previousKeyRemovedAt: string;
    readonly postRevocationCapturedAt: string;
  };
  readonly clientSecretRotation: {
    readonly clientId: string;
    readonly oldSecretId: string;
    readonly newSecretId: string;
    readonly overlapStartedAt: string;
    readonly oldSecretRevokedAt: string;
    readonly overlapWindowSeconds: number;
    readonly revocationEventId: string;
  };
  readonly auditEvent: {
    readonly id: string;
    readonly subject: string;
    readonly at: string;
  };
}

async function loadIdentitySecurityRotationLog(
  file: string,
  issuer: string,
): Promise<IdentitySecurityRotationLog> {
  const value = JSON.parse(await readFile(file, "utf8")) as unknown;
  const root = exactRecord(value, "--rotation-log-file", [
    "kind",
    "rotationRunId",
    "environment",
    "issuer",
    "owner",
    "reviewer",
    "startedAt",
    "completedAt",
    "result",
    "keyRotation",
    "clientSecretRotation",
    "auditEvent",
  ]);
  if (root.kind !== identitySecurityRotationLogKind) {
    throw new TypeError(
      `--rotation-log-file kind must be ${identitySecurityRotationLogKind}`,
    );
  }
  const environment = requiredLogString(root, "environment", "rotation log");
  if (environment !== "production" && environment !== "staging") {
    throw new TypeError(
      "rotation log environment must be production or staging",
    );
  }
  const logIssuer = normalizedHttpsIssuer(
    requiredLogString(root, "issuer", "rotation log"),
  );
  if (logIssuer !== issuer) {
    throw new TypeError("rotation log issuer does not match --issuer");
  }
  const owner = requiredLogString(root, "owner", "rotation log");
  const reviewer = requiredLogString(root, "reviewer", "rotation log");
  if (owner.trim().toLowerCase() === reviewer.trim().toLowerCase()) {
    throw new TypeError("rotation log reviewer must differ from owner");
  }
  const startedAt = requiredLogTimestamp(root, "startedAt", "rotation log");
  const completedAt = requiredLogTimestamp(root, "completedAt", "rotation log");
  if (timestampMillis(completedAt) < timestampMillis(startedAt)) {
    throw new TypeError("rotation log completedAt must not precede startedAt");
  }
  if (root.result !== "passed") {
    throw new TypeError("rotation log result must be passed");
  }

  const keyRotation = exactRecord(
    root.keyRotation,
    "rotation log keyRotation",
    [
      "keyId",
      "previousKeyId",
      "overlapCapturedAt",
      "previousKeyRemovedAt",
      "postRevocationCapturedAt",
    ],
  );
  const keyId = requiredLogString(keyRotation, "keyId", "keyRotation");
  const previousKeyId = requiredLogString(
    keyRotation,
    "previousKeyId",
    "keyRotation",
  );
  if (keyId === previousKeyId) {
    throw new TypeError("rotation log key ids must differ");
  }
  const overlapCapturedAt = requiredLogTimestamp(
    keyRotation,
    "overlapCapturedAt",
    "keyRotation",
  );
  const previousKeyRemovedAt = requiredLogTimestamp(
    keyRotation,
    "previousKeyRemovedAt",
    "keyRotation",
  );
  const postRevocationCapturedAt = requiredLogTimestamp(
    keyRotation,
    "postRevocationCapturedAt",
    "keyRotation",
  );
  if (
    timestampMillis(overlapCapturedAt) < timestampMillis(startedAt) ||
    timestampMillis(overlapCapturedAt) >=
      timestampMillis(previousKeyRemovedAt) ||
    timestampMillis(previousKeyRemovedAt) >
      timestampMillis(postRevocationCapturedAt) ||
    timestampMillis(postRevocationCapturedAt) > timestampMillis(completedAt)
  ) {
    throw new TypeError(
      "rotation log key timestamps must order overlap capture, previous-key removal, post-revocation capture, completion",
    );
  }

  const clientSecretRotation = exactRecord(
    root.clientSecretRotation,
    "rotation log clientSecretRotation",
    [
      "clientId",
      "oldSecretId",
      "newSecretId",
      "overlapStartedAt",
      "oldSecretRevokedAt",
      "overlapWindowSeconds",
      "revocationEventId",
    ],
  );
  const oldSecretId = requiredLogString(
    clientSecretRotation,
    "oldSecretId",
    "clientSecretRotation",
  );
  const newSecretId = requiredLogString(
    clientSecretRotation,
    "newSecretId",
    "clientSecretRotation",
  );
  if (oldSecretId === newSecretId) {
    throw new TypeError("rotation log client secret ids must differ");
  }
  const overlapStartedAt = requiredLogTimestamp(
    clientSecretRotation,
    "overlapStartedAt",
    "clientSecretRotation",
  );
  const oldSecretRevokedAt = requiredLogTimestamp(
    clientSecretRotation,
    "oldSecretRevokedAt",
    "clientSecretRotation",
  );
  const overlapWindowSeconds = clientSecretRotation.overlapWindowSeconds;
  if (
    typeof overlapWindowSeconds !== "number" ||
    !Number.isInteger(overlapWindowSeconds) ||
    overlapWindowSeconds <= 0
  ) {
    throw new TypeError(
      "rotation log clientSecretRotation.overlapWindowSeconds must be a positive integer",
    );
  }
  const measuredOverlapSeconds = Math.floor(
    (timestampMillis(oldSecretRevokedAt) - timestampMillis(overlapStartedAt)) /
      1000,
  );
  if (measuredOverlapSeconds !== overlapWindowSeconds) {
    throw new TypeError(
      "rotation log client secret overlapWindowSeconds must match the recorded timestamps",
    );
  }
  if (
    timestampMillis(overlapStartedAt) < timestampMillis(startedAt) ||
    timestampMillis(oldSecretRevokedAt) > timestampMillis(completedAt)
  ) {
    throw new TypeError(
      "rotation log client secret overlap must fall within the rotation run",
    );
  }

  const auditEvent = exactRecord(root.auditEvent, "rotation log auditEvent", [
    "id",
    "subject",
    "at",
  ]);
  const auditAt = requiredLogTimestamp(auditEvent, "at", "auditEvent");
  if (
    timestampMillis(auditAt) < timestampMillis(startedAt) ||
    timestampMillis(auditAt) > timestampMillis(completedAt)
  ) {
    throw new TypeError(
      "rotation log audit event timestamp must fall within the rotation run",
    );
  }

  return {
    kind: identitySecurityRotationLogKind,
    rotationRunId: requiredLogString(root, "rotationRunId", "rotation log"),
    environment,
    issuer: logIssuer,
    owner,
    reviewer,
    startedAt,
    completedAt,
    result: "passed",
    keyRotation: {
      keyId,
      previousKeyId,
      overlapCapturedAt,
      previousKeyRemovedAt,
      postRevocationCapturedAt,
    },
    clientSecretRotation: {
      clientId: requiredLogString(
        clientSecretRotation,
        "clientId",
        "clientSecretRotation",
      ),
      oldSecretId,
      newSecretId,
      overlapStartedAt,
      oldSecretRevokedAt,
      overlapWindowSeconds,
      revocationEventId: requiredLogString(
        clientSecretRotation,
        "revocationEventId",
        "clientSecretRotation",
      ),
    },
    auditEvent: {
      id: requiredLogString(auditEvent, "id", "auditEvent"),
      subject: requiredLogString(auditEvent, "subject", "auditEvent"),
      at: auditAt,
    },
  };
}

async function loadPublicJwksFile(
  file: string,
  label: string,
): Promise<Record<string, unknown>> {
  const value = JSON.parse(await readFile(file, "utf8")) as unknown;
  const jwks = exactRecord(value, label, ["keys"]);
  if (!Array.isArray(jwks.keys) || jwks.keys.length === 0) {
    throw new TypeError(`${label} must be a non-empty JWK Set object`);
  }
  const seen = new Set<string>();
  for (const [index, rawEntry] of jwks.keys.entries()) {
    const entry = exactRecord(rawEntry, `${label}.keys[${index}]`, [
      "kid",
      "kty",
      "crv",
      "x",
      "y",
      "use",
      "alg",
      "key_ops",
    ]);
    for (const field of ["kid", "kty", "crv", "x", "y"] as const) {
      if (
        typeof entry[field] !== "string" ||
        entry[field].trim().length === 0
      ) {
        throw new TypeError(`${label}.keys[${index}].${field} is required`);
      }
    }
    if (entry.kty !== "EC" || entry.crv !== "P-256") {
      throw new TypeError(
        `${label}.keys[${index}] must be an ES256 public JWK`,
      );
    }
    if (entry.use !== undefined && entry.use !== "sig") {
      throw new TypeError(`${label}.keys[${index}].use must be sig`);
    }
    if (entry.alg !== undefined && entry.alg !== "ES256") {
      throw new TypeError(`${label}.keys[${index}].alg must be ES256`);
    }
    if (
      entry.key_ops !== undefined &&
      (!Array.isArray(entry.key_ops) ||
        entry.key_ops.length !== 1 ||
        entry.key_ops[0] !== "verify")
    ) {
      throw new TypeError(
        `${label}.keys[${index}].key_ops must contain only verify`,
      );
    }
    if (seen.has(entry.kid as string)) {
      throw new TypeError(`${label} contains duplicate kid ${entry.kid}`);
    }
    seen.add(entry.kid as string);
  }
  return jwks;
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

function exactRecord(
  value: unknown,
  label: string,
  allowedKeys: readonly string[],
): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
  const unexpected = Object.keys(value).filter(
    (key) => !allowedKeys.includes(key),
  );
  if (unexpected.length > 0) {
    throw new TypeError(
      `${label} contains unexpected fields: ${unexpected.join(", ")}`,
    );
  }
  return value;
}

function requiredLogString(
  record: Record<string, unknown>,
  field: string,
  label: string,
): string {
  const value = record[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${label}.${field} must be a non-empty string`);
  }
  return value.trim();
}

function requiredLogTimestamp(
  record: Record<string, unknown>,
  field: string,
  label: string,
): string {
  const value = requiredLogString(record, field, label);
  assertIsoTimestamp(value, `${label}.${field}`);
  return value;
}

function timestampMillis(value: string): number {
  return new Date(value).getTime();
}

function requiredStringOption(
  options: Record<string, string | boolean>,
  key: string,
): string {
  const value = optionalStringOption(options, key);
  if (!value) throw new TypeError(`--${kebabOption(key)} is required`);
  return value;
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
