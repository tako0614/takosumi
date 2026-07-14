import {
  type PlatformReadinessEvidenceEntry,
  type PlatformReadinessEvidenceReferenceGap,
  type PlatformReadinessGapDetail,
  platformReadinessEvidenceEnvironments,
  type PlatformReadinessEvidenceReference,
  type PlatformReadinessEvidenceStatus,
  platformReadinessProductionTopologyKind,
  platformReadinessProductionTopologyMergeReportKind,
  platformReadinessProductionTopologyReportKind,
  platformReadinessPublicSummaryKind,
  platformReadinessPublicSummaryReportKind,
  platformReadinessKind,
  type PlatformReadinessReport,
  platformReadinessReportKind,
  platformReadinessRehearsalEnvironments,
  type PlatformReadinessRehearsalRun,
  productionTopologyDeployableRoles,
  type ProductionTopologyMergeReport,
  type ProductionTopologyPreflightReport,
  productionTopologyRequiredRoles,
} from "./cli-platform-readiness-constants.ts";
import {
  platformReadinessEvidenceSchemaErrors,
  type PlatformReadinessContribution,
} from "takosumi-contract";
import {
  composePlatformReadinessDefinition,
  OSS_PLATFORM_READINESS_DEFINITION,
  platformReadinessDefinitionFromDocument,
  type PlatformReadinessDefinition,
} from "./cli-platform-readiness-definition.ts";
import {
  actorIdentityValue,
  canonicalJson,
  isRecord,
  sha256Hex,
  stringValue,
} from "./cli-util.ts";

const orderedUserJourneyRehearsalStepIds = [
  "fresh-signup",
  "capsule-launch",
  "git-url-install",
] as const;

export function validatePlatformReadinessDocument(
  document: unknown,
): PlatformReadinessReport {
  const errors: string[] = [];
  if (!isRecord(document)) {
    return {
      kind: platformReadinessReportKind,
      ready: false,
      contributions: [],
      collectionClassHints: {},
      missingDomains: [...OSS_PLATFORM_READINESS_DEFINITION.domainIds],
      incompleteDomains: [],
      missingRehearsalSteps: [
        ...OSS_PLATFORM_READINESS_DEFINITION.rehearsalStepIds,
      ],
      incompleteRehearsalSteps: [],
      errors: ["document must be a JSON object"],
    };
  }

  if (document.kind !== platformReadinessKind) {
    errors.push(`kind must be ${platformReadinessKind}`);
  }

  const definitionResult = platformReadinessDefinitionFromDocument(document);
  errors.push(...definitionResult.errors);
  const definition = definitionResult.definition;

  const domainResult = validateEvidenceEntries(
    document.domains,
    definition.domainIds,
    "domains",
    undefined,
    definition,
  );
  const rehearsalRunResult = validatePlatformReadinessRehearsalRun(
    document.rehearsalRun,
  );
  const rehearsalResult = validateEvidenceEntries(
    document.rehearsal,
    definition.rehearsalStepIds,
    "rehearsal",
    rehearsalRunResult,
    definition,
  );
  const gapDetails = [
    ...buildPlatformReadinessGapDetails({
      entries: document.domains,
      requiredIds: definition.domainIds,
      scope: "domains",
      definition,
    }),
    ...buildPlatformReadinessGapDetails({
      entries: document.rehearsal,
      requiredIds: definition.rehearsalStepIds,
      scope: "rehearsal",
      rehearsalRun: rehearsalRunResult,
      definition,
    }),
  ];

  const report: PlatformReadinessReport = {
    kind: platformReadinessReportKind,
    ready:
      errors.length === 0 &&
      domainResult.missing.length === 0 &&
      domainResult.incomplete.length === 0 &&
      domainResult.errors.length === 0 &&
      rehearsalRunResult.errors.length === 0 &&
      rehearsalResult.missing.length === 0 &&
      rehearsalResult.incomplete.length === 0 &&
      rehearsalResult.errors.length === 0,
    contributions: definition.contributions.map(
      ({ id, version, capability }) => ({
        id,
        version,
        capability,
      }),
    ),
    collectionClassHints: Object.fromEntries(
      Object.entries(definition.collectionClassHints).map(([id, types]) => [
        id,
        [...types],
      ]),
    ),
    missingDomains: domainResult.missing,
    incompleteDomains: domainResult.incomplete,
    missingRehearsalSteps: rehearsalResult.missing,
    incompleteRehearsalSteps: rehearsalResult.incomplete,
    gapDetails,
    errors: [
      ...errors,
      ...domainResult.errors,
      ...rehearsalRunResult.errors,
      ...rehearsalResult.errors,
    ],
  };
  return report;
}

export function buildPlatformReadinessTemplate(
  contributions: readonly PlatformReadinessContribution[] = [],
): Record<string, unknown> {
  const definition = composePlatformReadinessDefinition(contributions);
  const templateEntry = (scope: "domains" | "rehearsal", id: string) => ({
    id,
    status: "blocked" satisfies PlatformReadinessEvidenceStatus,
    owner: "",
    environment: "",
    reviewer: "",
    completedAt: "",
    evidence: requiredEvidenceTypesFor(scope, id, definition).map((type) =>
      buildPlatformReadinessEvidenceTemplateReference(
        scope,
        id,
        type,
        definition,
      ),
    ),
  });
  return {
    kind: platformReadinessKind,
    contributions: definition.contributions,
    rehearsalRun: {
      id: "",
      environment: "",
      owner: "",
      reviewer: "",
      startedAt: "",
      completedAt: "",
    },
    domains: definition.domainIds.map((id) => ({
      ...templateEntry("domains", id),
      requiredEvidenceTypes: requiredEvidenceTypesFor(
        "domains",
        id,
        definition,
      ),
    })),
    rehearsal: definition.rehearsalStepIds.map((id) => ({
      ...templateEntry("rehearsal", id),
      runId: "",
      requiredEvidenceTypes: requiredEvidenceTypesFor(
        "rehearsal",
        id,
        definition,
      ),
    })),
  };
}

// Immutable pre-v1 evidence-document migration begins. Retired field names are
// read only so an operator can rewrite an old offline document once.
const legacyFinalModelEvidenceTypeMap = new Map([
  ["installation-created", "capsule-created"],
  ["installation-session", "capsule-session"],
  ["installation-plan-run", "capsule-plan-run"],
  ["install-apply", "capsule-apply"],
  ["per-installation-metrics", "per-capsule-metrics"],
  ["materialize-drill", "runner-profile-migration-drill"],
  ["materialize-cutover", "runner-profile-cutover"],
  ["self-host-import", "self-host-migration"],
  ["clean-import", "clean-migration"],
  ["post-import-login", "post-migration-login"],
  ["deploy-kill-switch", "run-kill-switch"],
  ["support-note", "release-note"],
  ["vulnerability-sla", "vulnerability-response-policy"],
]);

const legacyFinalModelEntryIdMap = new Map([
  ["quota-abuse-spend-control", "quota-abuse-control"],
  ["shared-cell-production-runtime", "runner-pool-production-runtime"],
  ["shared-cell-load", "runner-pool-load"],
  ["dedicated-materialize", "runner-profile-migration"],
  ["export-self-host-import", "export-self-host-migration"],
  ["legal-privacy-support", "legal-privacy"],
]);

const retiredFinalModelEvidenceTypes = new Set(["launch-token-consume"]);

const legacyFinalModelFieldMap = new Map([
  ["spaceId", "workspaceId"],
  ["installationId", "capsuleId"],
  ["tenantAInstallationId", "tenantACapsuleId"],
  ["tenantBInstallationId", "tenantBCapsuleId"],
  ["runtimeCellId", "runnerPoolId"],
  ["materializeOperationId", "migrationOperationId"],
  ["targetRuntimeTargetId", "targetRunnerProfileId"],
  ["sourceRuntimeTargetId", "sourceRunnerProfileId"],
  ["importId", "migrationId"],
  ["serviceGrantDigest", "interfaceBindingDigest"],
  ["supportNoteRef", "releaseNoteRef"],
]);

export interface PlatformReadinessFinalModelMigrationReport {
  kind: "takosumi.platform-readiness-final-model-migration-report@v1";
  changed: boolean;
  changes: Array<{
    kind:
      | "evidenceType"
      | "entryId"
      | "field"
      | "labelSet"
      | "dataClasses"
      | "documentKind"
      | "contributionProfile";
    from: string;
    to: string;
    count: number;
  }>;
}

export function migratePlatformReadinessDocumentToFinalModel(
  document: unknown,
  contributions: readonly PlatformReadinessContribution[] = [],
): {
  document: unknown;
  report: PlatformReadinessFinalModelMigrationReport;
} {
  const migrated = JSON.parse(JSON.stringify(document)) as unknown;
  const operationDrillEnvelope =
    isRecord(migrated) &&
    migrated.kind === "takosumi.operation-drill-evidence@v1" &&
    isRecord(migrated.readinessPatch);
  const migrationRoot = operationDrillEnvelope
    ? migrated.readinessPatch
    : migrated;
  const changes = new Map<
    string,
    PlatformReadinessFinalModelMigrationReport["changes"][number]
  >();
  const recordChange = (
    kind: PlatformReadinessFinalModelMigrationReport["changes"][number]["kind"],
    from: string,
    to: string,
  ) => {
    const key = `${kind}:${from}:${to}`;
    const existing = changes.get(key);
    if (existing) {
      existing.count += 1;
      return;
    }
    changes.set(key, { kind, from, to, count: 1 });
  };

  const renameField = (
    record: Record<string, unknown>,
    from: string,
    to: string,
  ) => {
    if (!Object.hasOwn(record, from)) return;
    if (!Object.hasOwn(record, to)) {
      record[to] = record[from];
    }
    delete record[from];
    recordChange("field", from, to);
  };

  const mapEvidenceType = (type: unknown): unknown => {
    if (typeof type !== "string") return type;
    const mapped = legacyFinalModelEvidenceTypeMap.get(type);
    if (!mapped) return type;
    recordChange("evidenceType", type, mapped);
    return mapped;
  };

  const migrateDataClasses = (value: unknown): unknown => {
    const classMap = new Map([
      ["space", "workspace"],
      ["installation", "capsule"],
    ]);
    if (Array.isArray(value)) {
      return value.map((item) => {
        if (typeof item !== "string") return item;
        const mapped = classMap.get(item);
        if (!mapped) return item;
        recordChange("dataClasses", item, mapped);
        return mapped;
      });
    }
    if (typeof value !== "string") return value;
    let changed = false;
    const next = value
      .split(/([,\s/]+)/u)
      .map((part) => {
        const mapped = classMap.get(part);
        if (!mapped) return part;
        changed = true;
        recordChange("dataClasses", part, mapped);
        return mapped;
      })
      .join("");
    return changed ? next : value;
  };

  const migrateRecord = (record: Record<string, unknown>) => {
    if (typeof record.id === "string") {
      const mappedId = legacyFinalModelEntryIdMap.get(record.id);
      if (mappedId) {
        recordChange("entryId", record.id, mappedId);
        record.id = mappedId;
      }
    }
    const originalType = typeof record.type === "string" ? record.type : "";
    if (typeof record.type === "string") {
      record.type = mapEvidenceType(record.type);
    }
    if (Array.isArray(record.requiredEvidenceTypes)) {
      record.requiredEvidenceTypes = record.requiredEvidenceTypes.flatMap(
        (type) => {
          if (
            typeof type === "string" &&
            retiredFinalModelEvidenceTypes.has(type)
          ) {
            recordChange("evidenceType", type, "(removed)");
            return [];
          }
          return [mapEvidenceType(type)];
        },
      );
    }
    if (Array.isArray(record.evidence)) {
      record.evidence = record.evidence.filter((item) => {
        if (!isRecord(item) || typeof item.type !== "string") return true;
        if (!retiredFinalModelEvidenceTypes.has(item.type)) return true;
        recordChange("evidenceType", item.type, "(removed)");
        return false;
      });
    }
    for (const [from, to] of legacyFinalModelFieldMap) {
      renameField(record, from, to);
    }
    const currentType = typeof record.type === "string" ? record.type : "";
    if (originalType === "install-apply" || currentType === "capsule-apply") {
      renameField(record, "applyEventId", "applyRunId");
      renameField(record, "deploymentId", "stateVersionId");
    }
    if (
      originalType === "deploy-kill-switch" ||
      currentType === "run-kill-switch"
    ) {
      renameField(record, "deploymentId", "runId");
    }
    if (
      typeof record.labelSet === "string" &&
      record.labelSet.includes("installation_id")
    ) {
      record.labelSet = record.labelSet.replaceAll(
        "installation_id",
        "capsule_id",
      );
      recordChange("labelSet", "installation_id", "capsule_id");
    }
    if (Object.hasOwn(record, "dataClasses")) {
      record.dataClasses = migrateDataClasses(record.dataClasses);
    }
  };

  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!isRecord(value)) return;
    migrateRecord(value as Record<string, unknown>);
    for (const item of Object.values(value)) visit(item);
  };
  visit(migrationRoot);

  if (!operationDrillEnvelope && isRecord(migrated)) {
    if (migrated.kind !== platformReadinessKind) {
      recordChange(
        "documentKind",
        typeof migrated.kind === "string" ? migrated.kind : "(missing)",
        platformReadinessKind,
      );
      migrated.kind = platformReadinessKind;
    }
    const selectedContributions =
      contributions.length > 0
        ? [...contributions]
        : Array.isArray(migrated.contributions)
          ? migrated.contributions
          : [];
    composePlatformReadinessDefinition(
      selectedContributions as PlatformReadinessContribution[],
    );
    const previousProfile = Array.isArray(migrated.contributions)
      ? migrated.contributions
          .filter(isRecord)
          .map((entry) => stringValue(entry.id) ?? "(invalid)")
          .join(",")
      : "(missing)";
    const nextProfile = selectedContributions
      .filter(isRecord)
      .map((entry) => stringValue(entry.id) ?? "(invalid)")
      .join(",");
    if (
      !Array.isArray(migrated.contributions) ||
      canonicalJson(migrated.contributions) !==
        canonicalJson(selectedContributions)
    ) {
      recordChange(
        "contributionProfile",
        previousProfile || "(none)",
        nextProfile || "(none)",
      );
      migrated.contributions = selectedContributions;
    }
  }

  const orderedChanges = [...changes.values()].sort((a, b) =>
    `${a.kind}:${a.from}:${a.to}`.localeCompare(`${b.kind}:${b.from}:${b.to}`),
  );
  return {
    document: migrated,
    report: {
      kind: "takosumi.platform-readiness-final-model-migration-report@v1",
      changed: orderedChanges.length > 0,
      changes: orderedChanges,
    },
  };
}
// Immutable pre-v1 evidence-document migration ends.

function buildPlatformReadinessEvidenceTemplateReference(
  scope: "domains" | "rehearsal",
  id: string,
  type: string,
  definition: PlatformReadinessDefinition,
): Record<string, unknown> {
  const requirement = definition.evidenceSchemas[type];
  const reference: Record<string, unknown> = {
    type,
    ref: `vault://platform-readiness/<rehearsal-run-id>/${scope}/${id}/${type}`,
    summary: "",
    private: true,
    publicSummary: "",
  };
  if (scope === "rehearsal") {
    reference.runId = "";
  }
  for (const [field, value] of Object.entries(requirement?.values ?? {})) {
    reference[field] = value;
  }
  for (const [field, allowedValues] of Object.entries(
    requirement?.allowedValues ?? {},
  )) {
    reference[field] = allowedValues[0] ?? "";
  }
  for (const field of requirement?.fields ?? []) {
    if (reference[field] === undefined) {
      reference[field] = platformReadinessTemplateFieldValue(
        field,
        requirement,
      );
    }
  }
  for (const alternatives of requirement?.anyOf ?? []) {
    for (const field of alternatives) {
      if (reference[field] === undefined) {
        reference[field] = platformReadinessTemplateFieldValue(
          field,
          requirement,
        );
      }
    }
  }
  return reference;
}

function platformReadinessTemplateFieldValue(
  field: string,
  schema: PlatformReadinessDefinition["evidenceSchemas"][string] | undefined,
): unknown {
  const format = schema?.formats?.[field];
  if (format === "sha256") return "sha256:<64-hex>";
  if (format === "git-commit-sha1") return "<40-hex-commit-sha>";
  if (format === "git-object-id") return "<40-or-64-hex-git-object-id>";
  if (format === "https-url") {
    return "https://accounts.example.invalid/<path>";
  }
  if (format === "evidence-ref") {
    return `vault://platform-readiness/<${field}>`;
  }
  if (format === "timestamp" || schema?.after?.[field]) {
    return "YYYY-MM-DDTHH:mm:ssZ";
  }
  const bound = schema?.numericBounds?.[field];
  if (bound) {
    return bound.exclusiveMinimum === true ? bound.minimum + 1 : bound.minimum;
  }
  const requiredItems = schema?.requiredItems?.[field];
  if (requiredItems) return [...requiredItems];
  return `<${field}>`;
}

function validatePlatformReadinessRehearsalRun(value: unknown): {
  runId: string | null;
  environment: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  errors: string[];
} {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return {
      runId: null,
      environment: null,
      startedAt: null,
      completedAt: null,
      errors: ["rehearsalRun must be an object"],
    };
  }
  const run = value as PlatformReadinessRehearsalRun;
  const runId =
    typeof run.id === "string" && run.id.trim().length > 0
      ? run.id.trim()
      : null;
  const environment =
    typeof run.environment === "string" && run.environment.trim().length > 0
      ? run.environment.trim()
      : null;
  if (!runId) {
    errors.push("rehearsalRun.id is required");
  }
  if (
    environment &&
    !isAllowedPlatformReadinessEnvironment(
      environment,
      platformReadinessRehearsalEnvironments,
    )
  ) {
    errors.push("rehearsalRun.environment must be staging or production");
  }
  for (const field of ["environment", "owner", "reviewer"] as const) {
    const fieldValue = run[field];
    if (typeof fieldValue !== "string" || fieldValue.trim().length === 0) {
      errors.push(`rehearsalRun.${field} is required`);
    }
  }
  const runOwner = actorIdentityValue(run.owner);
  const runReviewer = actorIdentityValue(run.reviewer);
  if (runOwner && runReviewer && runOwner === runReviewer) {
    errors.push("rehearsalRun.reviewer must differ from owner");
  }

  const startedAt = parseEvidenceDate(run.startedAt);
  const completedAt = parseEvidenceDate(run.completedAt);
  if (!startedAt) {
    errors.push("rehearsalRun.startedAt must be a valid date");
  }
  if (!completedAt) {
    errors.push("rehearsalRun.completedAt must be a valid date");
  }
  if (startedAt && completedAt && completedAt.getTime() < startedAt.getTime()) {
    errors.push("rehearsalRun.completedAt must be after startedAt");
  }
  if (completedAt && isFutureEvidenceDate(completedAt)) {
    errors.push("rehearsalRun.completedAt must not be in the future");
  }

  return { runId, environment, startedAt, completedAt, errors };
}

function validateEvidenceEntries(
  value: unknown,
  requiredIds: readonly string[],
  fieldName: "domains" | "rehearsal",
  rehearsalRun?: {
    runId: string | null;
    environment: string | null;
    startedAt: Date | null;
    completedAt: Date | null;
  },
  definition: PlatformReadinessDefinition = OSS_PLATFORM_READINESS_DEFINITION,
): { missing: string[]; incomplete: string[]; errors: string[] } {
  const errors: string[] = [];
  if (!Array.isArray(value)) {
    return {
      missing: [...requiredIds],
      incomplete: [],
      errors: [`${fieldName} must be an array`],
    };
  }

  const seen = new Map<string, PlatformReadinessEvidenceEntry>();
  const required = new Set(requiredIds);
  for (const [index, rawEntry] of value.entries()) {
    if (!isRecord(rawEntry)) {
      errors.push(`${fieldName}[${index}] must be an object`);
      continue;
    }
    const entry = rawEntry as PlatformReadinessEvidenceEntry;
    if (typeof entry.id !== "string" || entry.id.length === 0) {
      errors.push(`${fieldName}[${index}].id is required`);
      continue;
    }
    if (seen.has(entry.id)) {
      errors.push(`${fieldName}.${entry.id} is duplicated`);
      continue;
    }
    const environment =
      typeof entry.environment === "string" ? entry.environment.trim() : "";
    const allowedEnvironments =
      fieldName === "rehearsal"
        ? platformReadinessRehearsalEnvironments
        : platformReadinessEvidenceEnvironments;
    const environmentMessage =
      fieldName === "rehearsal"
        ? "staging or production"
        : "staging, production, or staging+production";
    if (
      environment &&
      !isAllowedPlatformReadinessEnvironment(environment, allowedEnvironments)
    ) {
      errors.push(
        `${fieldName}.${entry.id}.environment must be ${environmentMessage}`,
      );
    }
    if (
      fieldName === "domains" &&
      entry.id === "production-topology" &&
      environment &&
      environment !== "staging+production"
    ) {
      errors.push(
        "domains.production-topology.environment must be staging+production",
      );
    }
    const owner = actorIdentityValue(entry.owner);
    const reviewer = actorIdentityValue(entry.reviewer);
    if (entry.status === "passed" && owner && reviewer && owner === reviewer) {
      errors.push(`${fieldName}.${entry.id}.reviewer must differ from owner`);
    }
    if (Array.isArray(entry.evidence)) {
      for (const type of duplicatedEvidenceTypes(entry.evidence)) {
        errors.push(`${fieldName}.${entry.id}.evidence.${type} is duplicated`);
      }
      if (required.has(entry.id)) {
        const allowedEvidenceTypes = new Set(
          requiredEvidenceTypesFor(fieldName, entry.id, definition),
        );
        for (const type of unexpectedEvidenceTypes(
          entry.evidence,
          allowedEvidenceTypes,
        )) {
          errors.push(
            `${fieldName}.${entry.id}.evidence.${type} is not a required evidence type`,
          );
        }
      }
    }
    seen.set(entry.id, entry);
  }

  for (const id of seen.keys()) {
    if (!required.has(id)) {
      errors.push(`${fieldName}.${id} is not a recognized evidence id`);
    }
  }
  if (fieldName === "rehearsal") {
    validatePlatformReadinessRehearsalOrder(
      seen,
      orderedUserJourneyRehearsalStepIds,
      errors,
    );
  }

  const missing = requiredIds.filter((id) => !seen.has(id));
  const incomplete = requiredIds.filter((id) => {
    const entry = seen.get(id);
    return entry
      ? !isCompleteEvidenceEntry(
          entry,
          fieldName === "rehearsal" ? rehearsalRun : undefined,
          requiredEvidenceTypesFor(fieldName, id, definition),
          definition,
        )
      : false;
  });
  return { missing, incomplete, errors };
}

function validatePlatformReadinessRehearsalOrder(
  entries: Map<string, PlatformReadinessEvidenceEntry>,
  orderedIds: readonly string[],
  errors: string[],
): void {
  let previous: { id: string; completedAt: Date } | null = null;
  for (const id of orderedIds) {
    const entry = entries.get(id);
    if (!entry) continue;
    const completedAt = parseEvidenceDate(entry.completedAt);
    if (!completedAt) continue;
    if (previous && completedAt.getTime() <= previous.completedAt.getTime()) {
      errors.push(
        `rehearsal.${id}.completedAt must be after rehearsal.${previous.id}.completedAt`,
      );
    }
    previous = { id, completedAt };
  }
}

function requiredEvidenceTypesFor(
  fieldName: "domains" | "rehearsal",
  id: string,
  definition: PlatformReadinessDefinition = OSS_PLATFORM_READINESS_DEFINITION,
): readonly string[] {
  return (
    (
      definition.requiredEvidenceTypes[fieldName] as Record<
        string,
        readonly string[]
      >
    )[id] ?? []
  );
}

function buildPlatformReadinessGapDetails(input: {
  entries: unknown;
  requiredIds: readonly string[];
  scope: "domains" | "rehearsal";
  rehearsalRun?: {
    runId: string | null;
    environment: string | null;
    startedAt: Date | null;
    completedAt: Date | null;
  };
  definition: PlatformReadinessDefinition;
}): PlatformReadinessGapDetail[] {
  const entries = new Map<string, PlatformReadinessEvidenceEntry>();
  if (Array.isArray(input.entries)) {
    for (const entry of input.entries) {
      if (!isRecord(entry) || typeof entry.id !== "string") continue;
      if (!entries.has(entry.id)) {
        entries.set(entry.id, entry as PlatformReadinessEvidenceEntry);
      }
    }
  }

  return input.requiredIds.flatMap((id): PlatformReadinessGapDetail[] => {
    const requiredEvidenceTypes = [
      ...requiredEvidenceTypesFor(input.scope, id, input.definition),
    ];
    const entry = entries.get(id);
    if (!entry) {
      return [
        {
          scope: input.scope,
          id,
          status: "missing",
          requiredEvidenceTypes,
          presentEvidenceTypes: [],
          completeEvidenceTypes: [],
          missingEvidenceTypes: requiredEvidenceTypes,
          incompleteEvidenceTypes: [],
          evidenceReferenceGaps: requiredEvidenceTypes.map((type) => ({
            type,
            status: "missing",
            blockingFields: ["evidence"],
          })),
          blockingFields: ["entry"],
        },
      ];
    }

    if (
      isCompleteEvidenceEntry(
        entry,
        input.scope === "rehearsal" ? input.rehearsalRun : undefined,
        requiredEvidenceTypes,
        input.definition,
      )
    ) {
      return [];
    }

    const evidence = Array.isArray(entry.evidence) ? entry.evidence : [];
    const presentEvidenceTypes = orderedEvidenceTypes(evidence);
    const completeEvidenceTypes = orderedEvidenceTypes(
      evidence.filter((item) =>
        isCompleteEvidenceReference(item, input.definition),
      ),
    );
    const presentSet = new Set(presentEvidenceTypes);
    const completeSet = new Set(completeEvidenceTypes);
    const missingEvidenceTypes = requiredEvidenceTypes.filter(
      (type) => !presentSet.has(type),
    );
    const incompleteEvidenceTypes = requiredEvidenceTypes.filter(
      (type) => presentSet.has(type) && !completeSet.has(type),
    );
    const evidenceReferenceGaps = requiredEvidenceTypes
      .map((type) =>
        evidenceReferenceGapForType(type, evidence, input.definition),
      )
      .filter(
        (gap): gap is PlatformReadinessEvidenceReferenceGap => gap !== null,
      );

    return [
      {
        scope: input.scope,
        id,
        status: "incomplete",
        requiredEvidenceTypes,
        presentEvidenceTypes,
        completeEvidenceTypes,
        missingEvidenceTypes,
        incompleteEvidenceTypes,
        evidenceReferenceGaps,
        blockingFields: incompleteEvidenceBlockingFields(
          entry,
          input.scope,
          input.scope === "rehearsal" ? input.rehearsalRun : undefined,
          input.definition,
        ),
      },
    ];
  });
}

function orderedEvidenceTypes(evidence: unknown[]): string[] {
  const seen = new Set<string>();
  const types: string[] = [];
  for (const item of evidence) {
    if (!isRecord(item)) continue;
    const type = stringValue(item.type)?.trim();
    if (!type || seen.has(type)) continue;
    seen.add(type);
    types.push(type);
  }
  return types;
}

function evidenceReferenceGapForType(
  type: string,
  evidence: unknown[],
  definition: PlatformReadinessDefinition,
): PlatformReadinessEvidenceReferenceGap | null {
  const reference = evidence.find(
    (item) => isRecord(item) && stringValue(item.type)?.trim() === type,
  );
  if (!isRecord(reference)) {
    return {
      type,
      status: "missing",
      blockingFields: ["evidence"],
    };
  }
  if (isCompleteEvidenceReference(reference, definition)) return null;
  return {
    type,
    status: "incomplete",
    blockingFields: evidenceReferenceBlockingFields(
      reference,
      type,
      definition,
    ),
  };
}

function evidenceReferenceBlockingFields(
  reference: Record<string, unknown>,
  type: string,
  definition: PlatformReadinessDefinition,
): string[] {
  const fields = new Set<string>();
  if (stringValue(reference.type)?.trim() !== type) fields.add("type");
  const ref = stringValue(reference.ref);
  if (!ref || isPlaceholderEvidenceRef(ref)) fields.add("ref");
  const summary = stringValue(reference.summary);
  if (
    !summary ||
    platformReadinessEvidenceSummaryErrors(summary, definition).length > 0
  ) {
    fields.add("summary");
  }
  for (const field of structuredEvidenceBlockingFields(
    reference,
    type,
    definition,
  )) {
    fields.add(field);
  }
  if (reference.private !== true) fields.add("private");
  const publicSummary = stringValue(reference.publicSummary);
  if (
    publicSummary === undefined ||
    platformReadinessPublicSummaryErrors(
      publicSummary,
      { requireLaunchScope: false },
      definition,
    ).length > 0
  ) {
    fields.add("publicSummary");
  }
  return [...fields].sort();
}

function structuredEvidenceBlockingFields(
  reference: Record<string, unknown>,
  type: string,
  definition: PlatformReadinessDefinition,
): string[] {
  const fields = new Set<string>();
  const requirement = definition.evidenceSchemas[type];
  if (!requirement) return [];
  for (const field of requirement.fields ?? []) {
    if (!hasNonEmptyEvidenceField(reference, field)) fields.add(field);
  }
  for (const alternatives of requirement.anyOf ?? []) {
    if (
      !alternatives.some((field) => hasNonEmptyEvidenceField(reference, field))
    ) {
      fields.add(`anyOf:${alternatives.join("|")}`);
    }
  }
  for (const error of platformReadinessEvidenceSchemaErrors(
    requirement,
    reference,
    type,
  )) {
    const fieldPrefix = `${type}.`;
    if (error.startsWith(fieldPrefix)) {
      const token = error.slice(fieldPrefix.length).split(/\s/u, 1)[0];
      if (token) fields.add(token);
      continue;
    }
    if (!error.includes(" requires one of ")) fields.add("crossField");
  }
  return [...fields].sort();
}

function incompleteEvidenceBlockingFields(
  entry: PlatformReadinessEvidenceEntry,
  scope: "domains" | "rehearsal",
  rehearsalRun?: {
    runId: string | null;
    environment: string | null;
    startedAt: Date | null;
    completedAt: Date | null;
  },
  definition: PlatformReadinessDefinition = OSS_PLATFORM_READINESS_DEFINITION,
): string[] {
  const fields = new Set<string>();
  if (entry.status !== "passed") fields.add("status");

  const environment =
    typeof entry.environment === "string" ? entry.environment.trim() : "";
  const allowedEnvironments =
    scope === "rehearsal"
      ? platformReadinessRehearsalEnvironments
      : platformReadinessEvidenceEnvironments;
  if (
    !environment ||
    !isAllowedPlatformReadinessEnvironment(environment, allowedEnvironments)
  ) {
    fields.add("environment");
  }
  if (scope === "domains" && entry.id === "production-topology") {
    if (environment !== "staging+production") fields.add("environment");
  }
  if (rehearsalRun?.environment && environment !== rehearsalRun.environment) {
    fields.add("environment");
  }

  const owner = typeof entry.owner === "string" ? entry.owner.trim() : "";
  const reviewer =
    typeof entry.reviewer === "string" ? entry.reviewer.trim() : "";
  const ownerIdentity = actorIdentityValue(entry.owner);
  const reviewerIdentity = actorIdentityValue(entry.reviewer);
  if (!owner || ownerIdentity === undefined) fields.add("owner");
  if (!reviewer || reviewerIdentity === undefined) fields.add("reviewer");
  if (ownerIdentity && reviewerIdentity && ownerIdentity === reviewerIdentity) {
    fields.add("reviewer");
  }

  const completedAt = parseEvidenceDate(entry.completedAt);
  if (!completedAt || isFutureEvidenceDate(completedAt)) {
    fields.add("completedAt");
  }
  if (
    completedAt &&
    rehearsalRun?.startedAt &&
    completedAt.getTime() < rehearsalRun.startedAt.getTime()
  ) {
    fields.add("completedAt");
  }
  if (
    completedAt &&
    rehearsalRun?.completedAt &&
    completedAt.getTime() > rehearsalRun.completedAt.getTime()
  ) {
    fields.add("completedAt");
  }

  if (!Array.isArray(entry.evidence) || entry.evidence.length === 0) {
    fields.add("evidence");
  }
  const entryRunId =
    typeof entry.runId === "string" && entry.runId.trim().length > 0
      ? entry.runId.trim()
      : null;
  if (scope === "rehearsal" && !entryRunId) {
    fields.add("runId");
  }
  if (scope === "rehearsal") {
    if (!entryRunId || !hasConsistentEvidenceRunId(entry, entryRunId)) {
      fields.add("evidence.runId");
    }
  }
  if (
    scope === "rehearsal" &&
    !hasConsistentRehearsalStepEvidence(entry, definition)
  ) {
    fields.add("evidence.consistency");
  }
  return [...fields].sort();
}

function isCompleteEvidenceEntry(
  entry: PlatformReadinessEvidenceEntry,
  rehearsalRun?: {
    runId: string | null;
    environment: string | null;
    startedAt: Date | null;
    completedAt: Date | null;
  },
  requiredEvidenceTypes: readonly string[] = [],
  definition: PlatformReadinessDefinition = OSS_PLATFORM_READINESS_DEFINITION,
): boolean {
  const entryRunId =
    typeof entry.runId === "string" && entry.runId.trim().length > 0
      ? entry.runId.trim()
      : null;
  const environment =
    typeof entry.environment === "string" ? entry.environment.trim() : "";
  const owner = typeof entry.owner === "string" ? entry.owner.trim() : "";
  const reviewer =
    typeof entry.reviewer === "string" ? entry.reviewer.trim() : "";
  const ownerIdentity = actorIdentityValue(entry.owner);
  const reviewerIdentity = actorIdentityValue(entry.reviewer);
  if (
    !isAllowedPlatformReadinessEnvironment(
      environment,
      platformReadinessEvidenceEnvironments,
    )
  ) {
    return false;
  }
  if (
    entry.id === "production-topology" &&
    environment !== "staging+production"
  ) {
    return false;
  }
  if (rehearsalRun?.environment && environment !== rehearsalRun.environment) {
    return false;
  }
  const completedAt = parseEvidenceDate(entry.completedAt);
  if (!completedAt || isFutureEvidenceDate(completedAt)) return false;
  if (
    rehearsalRun?.startedAt &&
    completedAt.getTime() < rehearsalRun.startedAt.getTime()
  ) {
    return false;
  }
  if (
    rehearsalRun?.completedAt &&
    completedAt.getTime() > rehearsalRun.completedAt.getTime()
  ) {
    return false;
  }
  return (
    entry.status === "passed" &&
    owner.length > 0 &&
    environment.length > 0 &&
    reviewer.length > 0 &&
    ownerIdentity !== undefined &&
    reviewerIdentity !== undefined &&
    reviewerIdentity !== ownerIdentity &&
    Array.isArray(entry.evidence) &&
    entry.evidence.some((item) =>
      isCompleteEvidenceReference(item, definition),
    ) &&
    hasRequiredEvidenceTypes(
      entry.evidence,
      requiredEvidenceTypes,
      definition,
    ) &&
    (!rehearsalRun ||
      (entryRunId !== null && hasConsistentEvidenceRunId(entry, entryRunId))) &&
    (!rehearsalRun || hasConsistentRehearsalStepEvidence(entry, definition))
  );
}

function parseEvidenceDate(value: unknown): Date | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const timestamp = value.trim();
  const match = timestamp.match(
    /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/,
  );
  if (!match) return null;
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) return null;
  const canonicalTimestamp = `${match[1]}T${match[2]}:${match[3]}:${match[4]}.${(
    match[5] ?? ""
  ).padEnd(3, "0")}Z`;
  return parsed.toISOString() === canonicalTimestamp ? parsed : null;
}

function isFutureEvidenceDate(value: Date): boolean {
  return value.getTime() > Date.now() + 5 * 60_000;
}

function isCompleteEvidenceReference(
  value: unknown,
  definition: PlatformReadinessDefinition = OSS_PLATFORM_READINESS_DEFINITION,
): boolean {
  if (!isRecord(value)) return false;
  // `PlatformReadinessEvidenceReference` declares every field as `unknown`, so
  // viewing the record through that interface is purely cosmetic — the per-
  // field `typeof` guards below are still the load-bearing checks.
  const reference: PlatformReadinessEvidenceReference = value;
  if (
    typeof reference.type !== "string" ||
    reference.type.trim().length === 0
  ) {
    return false;
  }
  if (
    typeof reference.ref !== "string" ||
    reference.ref.trim().length === 0 ||
    isPlaceholderEvidenceRef(reference.ref)
  ) {
    return false;
  }
  if (
    typeof reference.summary !== "string" ||
    reference.summary.trim().length === 0
  ) {
    return false;
  }
  if (
    platformReadinessEvidenceSummaryErrors(reference.summary, definition)
      .length > 0
  ) {
    return false;
  }
  if (
    !satisfiesStructuredEvidenceRequirement(
      value,
      reference.type.trim(),
      definition,
    )
  ) {
    return false;
  }
  if (reference.private !== true) {
    return false;
  }
  return (
    typeof reference.publicSummary === "string" &&
    platformReadinessPublicSummaryErrors(
      reference.publicSummary,
      { requireLaunchScope: false },
      definition,
    ).length === 0
  );
}

function satisfiesStructuredEvidenceRequirement(
  reference: Record<string, unknown>,
  type: string,
  definition: PlatformReadinessDefinition,
): boolean {
  const requirement = definition.evidenceSchemas[type];
  if (!requirement) return true;
  return (
    platformReadinessEvidenceSchemaErrors(requirement, reference, type)
      .length === 0
  );
}

function hasNonEmptyEvidenceField(
  reference: Record<string, unknown>,
  field: string,
): boolean {
  const value = reference[field];
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "boolean") return true;
  if (value && typeof value === "object") {
    return Object.keys(value).length > 0;
  }
  return typeof value === "string" && value.trim().length > 0;
}

function isPlaceholderEvidenceRef(ref: string): boolean {
  const normalized = ref.trim().toLowerCase();
  return (
    normalized.startsWith("evidence://") ||
    normalized.startsWith("topology://") ||
    normalized.includes("todo") ||
    normalized.includes("tbd") ||
    normalized.includes("dummy") ||
    normalized.includes("fake") ||
    normalized.includes("changeme") ||
    normalized.includes("placeholder") ||
    normalized.includes("example.com") ||
    normalized.includes("example.test") ||
    normalized.includes("example.invalid") ||
    normalized.includes("<") ||
    normalized.includes(">")
  );
}

function hasRequiredEvidenceTypes(
  evidence: unknown[],
  requiredTypes: readonly string[],
  definition: PlatformReadinessDefinition = OSS_PLATFORM_READINESS_DEFINITION,
): boolean {
  const completeTypes = new Set(
    evidence
      .filter((item) => isCompleteEvidenceReference(item, definition))
      .map((item) => (item as PlatformReadinessEvidenceReference).type)
      .filter((type): type is string => typeof type === "string")
      .map((type) => type.trim()),
  );
  return requiredTypes.every((type) => completeTypes.has(type));
}

function duplicatedEvidenceTypes(evidence: unknown[]): string[] {
  const seen = new Set<string>();
  const duplicated = new Set<string>();
  for (const item of evidence) {
    if (!isRecord(item)) continue;
    const type = stringValue(item.type);
    if (!type) continue;
    if (seen.has(type)) duplicated.add(type);
    seen.add(type);
  }
  return [...duplicated].sort();
}

function unexpectedEvidenceTypes(
  evidence: unknown[],
  allowedTypes: Set<string>,
): string[] {
  const unexpected = new Set<string>();
  for (const item of evidence) {
    if (!isRecord(item)) continue;
    const type = stringValue(item.type);
    if (type && !allowedTypes.has(type)) unexpected.add(type);
  }
  return [...unexpected].sort();
}

function hasConsistentRehearsalStepEvidence(
  entry: PlatformReadinessEvidenceEntry,
  definition: PlatformReadinessDefinition = OSS_PLATFORM_READINESS_DEFINITION,
): boolean {
  if (typeof entry.id !== "string" || !Array.isArray(entry.evidence)) {
    return true;
  }
  const evidenceByType = evidenceReferencesByType(entry.evidence);
  for (const rule of definition.consistencyRules.rehearsal[entry.id] ?? []) {
    if (!sameEvidenceField(evidenceByType, rule.evidenceTypes, rule.field)) {
      return false;
    }
  }
  return true;
}

function hasConsistentEvidenceRunId(
  entry: PlatformReadinessEvidenceEntry,
  runId: string,
): boolean {
  if (!Array.isArray(entry.evidence)) return false;
  return entry.evidence.every((item) => {
    if (!isRecord(item)) return false;
    return stringValue(item.runId) === runId;
  });
}

function evidenceReferencesByType(
  evidence: unknown[],
): Map<string, Record<string, unknown>> {
  const references = new Map<string, Record<string, unknown>>();
  for (const item of evidence) {
    if (!isRecord(item)) continue;
    const type = stringValue(item.type);
    if (type && !references.has(type)) references.set(type, item);
  }
  return references;
}

function sameEvidenceField(
  evidenceByType: Map<string, Record<string, unknown>>,
  types: readonly string[],
  field: string,
): boolean {
  const values = types.map((type) =>
    stringValue(evidenceByType.get(type)?.[field]),
  );
  return (
    values.every((value): value is string => Boolean(value)) &&
    values.every((value) => value === values[0])
  );
}

function isAllowedPlatformReadinessEnvironment(
  environment: string,
  allowed: readonly string[],
): boolean {
  return allowed.includes(environment);
}

export function formatPlatformReadinessReport(
  report: PlatformReadinessReport,
): string {
  const lines = ["Platform readiness launch readiness evidence is incomplete."];
  if (report.missingDomains.length > 0) {
    lines.push(`Missing P0 domains: ${report.missingDomains.join(", ")}`);
  }
  if (report.incompleteDomains.length > 0) {
    lines.push(`Incomplete P0 domains: ${report.incompleteDomains.join(", ")}`);
  }
  if (report.missingRehearsalSteps.length > 0) {
    lines.push(
      `Missing rehearsal steps: ${report.missingRehearsalSteps.join(", ")}`,
    );
  }
  if (report.incompleteRehearsalSteps.length > 0) {
    lines.push(
      `Incomplete rehearsal steps: ${report.incompleteRehearsalSteps.join(
        ", ",
      )}`,
    );
  }
  if (Array.isArray(report.gapDetails) && report.gapDetails.length > 0) {
    lines.push("Gap details:");
    for (const gap of report.gapDetails.slice(0, 12)) {
      const missingEvidence =
        gap.missingEvidenceTypes.length > 0
          ? `missing evidence: ${gap.missingEvidenceTypes.join(", ")}`
          : "missing evidence: none";
      const incompleteEvidence =
        gap.incompleteEvidenceTypes.length > 0
          ? `incomplete evidence: ${gap.incompleteEvidenceTypes.join(", ")}`
          : "incomplete evidence: none";
      const fields =
        gap.blockingFields.length > 0
          ? `fields: ${gap.blockingFields.join(", ")}`
          : "fields: none";
      const evidenceFields =
        gap.evidenceReferenceGaps.length > 0
          ? `evidence fields: ${gap.evidenceReferenceGaps
              .slice(0, 3)
              .map((item) => `${item.type}(${item.blockingFields.join(",")})`)
              .join("; ")}`
          : "evidence fields: none";
      lines.push(
        `- ${gap.scope}.${gap.id}: ${gap.status}; ${missingEvidence}; ${incompleteEvidence}; ${fields}; ${evidenceFields}`,
      );
    }
    if (report.gapDetails.length > 12) {
      lines.push(`- ... ${report.gapDetails.length - 12} more gap(s)`);
    }
  }
  for (const error of report.errors) {
    lines.push(`Error: ${error}`);
  }
  return lines.join("\n");
}

export function defaultPlatformReadinessPublicSummary(ready: boolean): string {
  return ready
    ? "P0 evidence and one staged launch rehearsal passed validator checks; operator approval is still required."
    : "Platform readiness remains blocked because P0 evidence and staged rehearsal checks have not passed.";
}

export function buildPlatformReadinessPublicSummary(input: {
  document: unknown;
  report: PlatformReadinessReport & { evidenceDigest: string };
  evidenceRefClass: string | null;
  publicSummary: string;
}): Record<string, unknown> {
  const rehearsalRun =
    isRecord(input.document) && isRecord(input.document.rehearsalRun)
      ? input.document.rehearsalRun
      : {};
  const completedAt = stringValue(rehearsalRun.completedAt);
  return {
    kind: platformReadinessPublicSummaryKind,
    status: input.report.ready ? "validator-passed" : "blocked",
    ready: input.report.ready,
    date: completedAt ? completedAt.slice(0, 10) : null,
    environment: stringValue(rehearsalRun.environment) ?? null,
    rehearsalRun: stringValue(rehearsalRun.id) ?? null,
    profile: {
      contributions: input.report.contributions,
    },
    validator: {
      ready: input.report.ready,
      evidenceDigest: input.report.evidenceDigest,
      missingDomains: input.report.missingDomains,
      incompleteDomains: input.report.incompleteDomains,
      missingRehearsalSteps: input.report.missingRehearsalSteps,
      incompleteRehearsalSteps: input.report.incompleteRehearsalSteps,
    },
    privateEvidenceRefClass: input.evidenceRefClass,
    publicResult: input.publicSummary.trim(),
    notes: input.report.ready
      ? "Platform activation still requires separate operator approval."
      : "Keep platform activation blocked until every P0 domain and one staged rehearsal pass validation.",
  };
}

export function publicEvidenceRefClass(ref: string | undefined): string {
  if (!ref) return "opaque-ref";
  const match = ref.trim().match(/^([a-z][a-z0-9+.-]*):\/\//i);
  return match ? `${match[1].toLowerCase()}://...` : "opaque-ref";
}

export function formatPlatformReadinessPublicSummaryMarkdownRow(
  summary: Record<string, unknown>,
): string {
  const validator = isRecord(summary.validator) ? summary.validator : {};
  const validatorText = `ready:${String(summary.ready)} / evidenceDigest:${
    stringValue(validator.evidenceDigest) ?? "none"
  }`;
  return [
    stringValue(summary.date) ?? "_TBD_",
    stringValue(summary.environment) ?? "_TBD_",
    stringValue(summary.rehearsalRun) ?? "_TBD_",
    validatorText,
    stringValue(summary.publicResult) ?? "",
    stringValue(summary.privateEvidenceRefClass) ?? "_TBD_",
    stringValue(summary.notes) ?? "",
  ]
    .map(markdownTableCell)
    .join(" | ")
    .replace(/^/, "| ")
    .replace(/$/, " |");
}

function markdownTableCell(value: string): string {
  return value.replaceAll("|", "\\|").replace(/\s+/g, " ").trim();
}

export function validatePlatformReadinessPublicSummaryArtifact(
  summary: unknown,
  readinessDocument: unknown,
  readinessReport: PlatformReadinessReport & { evidenceDigest: string },
): Record<string, unknown> & { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const definitionResult =
    platformReadinessDefinitionFromDocument(readinessDocument);
  const definition = definitionResult.definition;
  errors.push(...definitionResult.errors);
  if (!isRecord(summary)) {
    return {
      kind: platformReadinessPublicSummaryReportKind,
      valid: false,
      ready: false,
      evidenceDigest: readinessReport.evidenceDigest,
      errors: ["summary must be a JSON object"],
    };
  }
  if (summary.kind !== platformReadinessPublicSummaryKind) {
    errors.push(`kind must be ${platformReadinessPublicSummaryKind}`);
  }
  const ready = summary.ready === true;
  if (typeof summary.ready !== "boolean") {
    errors.push("ready must be a boolean");
  }
  if (ready && summary.status !== "validator-passed") {
    errors.push("status must be validator-passed when ready=true");
  }
  if (!ready && summary.status !== "blocked") {
    errors.push("status must be blocked when ready=false");
  }
  if (ready !== readinessReport.ready) {
    errors.push("ready must match readiness validation result");
  }

  const profile = isRecord(summary.profile) ? summary.profile : null;
  if (!profile) {
    errors.push("profile must be an object");
  } else if (
    JSON.stringify(profile.contributions) !==
    JSON.stringify(readinessReport.contributions)
  ) {
    errors.push("profile.contributions must match readiness validation result");
  }

  const validator = isRecord(summary.validator) ? summary.validator : null;
  if (!validator) {
    errors.push("validator must be an object");
  } else {
    if (validator.ready !== ready) {
      errors.push("validator.ready must match summary.ready");
    }
    if (validator.evidenceDigest !== readinessReport.evidenceDigest) {
      errors.push("validator.evidenceDigest must match readiness file digest");
    }
    for (const field of [
      "missingDomains",
      "incompleteDomains",
      "missingRehearsalSteps",
      "incompleteRehearsalSteps",
    ] as const) {
      if (!sameStringArray(validator[field], readinessReport[field])) {
        errors.push(
          `validator.${field} must match readiness validation result`,
        );
      }
    }
  }

  const publicResult = stringValue(summary.publicResult);
  if (!publicResult) {
    errors.push("publicResult is required");
  } else {
    errors.push(
      ...platformReadinessPublicSummaryErrors(
        publicResult,
        { requireLaunchScope: ready },
        definition,
      ),
    );
  }
  errors.push(
    ...platformReadinessSummaryRedactionErrors(
      JSON.stringify(summary),
      "platform readiness public summary artifact",
    ),
  );
  errors.push(
    ...platformReadinessContributionRedactionErrors(
      JSON.stringify(summary),
      "platform readiness public summary artifact",
      definition,
    ),
  );

  const privateEvidenceRefClass = summary.privateEvidenceRefClass;
  const hasEvidenceRefClass =
    privateEvidenceRefClass !== null && privateEvidenceRefClass !== undefined;
  if (
    hasEvidenceRefClass &&
    (typeof privateEvidenceRefClass !== "string" ||
      !/^[a-z][a-z0-9+.-]*:\/\/\.\.\.$/i.test(privateEvidenceRefClass))
  ) {
    errors.push(
      "privateEvidenceRefClass must be null or a redacted scheme class",
    );
  }
  if (ready && !hasEvidenceRefClass) {
    errors.push(
      "privateEvidenceRefClass must be a scheme class when ready=true",
    );
  }

  const rehearsalRun =
    isRecord(readinessDocument) && isRecord(readinessDocument.rehearsalRun)
      ? readinessDocument.rehearsalRun
      : {};
  const expectedRunId = stringValue(rehearsalRun.id);
  const expectedEnvironment = stringValue(rehearsalRun.environment);
  const expectedCompletedAt = stringValue(rehearsalRun.completedAt);
  const expectedDate = expectedCompletedAt
    ? expectedCompletedAt.slice(0, 10)
    : null;
  if (expectedRunId && summary.rehearsalRun !== expectedRunId) {
    errors.push("rehearsalRun must match readiness file");
  }
  if (expectedEnvironment && summary.environment !== expectedEnvironment) {
    errors.push("environment must match readiness file");
  }
  if (expectedDate && summary.date !== expectedDate) {
    errors.push("date must match readiness file completedAt");
  }

  return {
    kind: platformReadinessPublicSummaryReportKind,
    valid: errors.length === 0,
    ready,
    evidenceDigest: readinessReport.evidenceDigest,
    errors,
  };
}

function sameStringArray(value: unknown, expected: readonly string[]): boolean {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every((item, index) => item === expected[index])
  );
}

export function validateProductionTopologyDocument(
  document: unknown,
): ProductionTopologyPreflightReport {
  const errors: string[] = [];
  if (!isRecord(document)) {
    return {
      kind: platformReadinessProductionTopologyReportKind,
      ready: false,
      environment: null,
      missingRoles: [...productionTopologyRequiredRoles],
      errors: ["document must be a JSON object"],
    };
  }

  if (document.kind !== platformReadinessProductionTopologyKind) {
    errors.push(`kind must be ${platformReadinessProductionTopologyKind}`);
  }
  const environment = stringValue(document.environment) ?? null;
  if (environment !== "staging" && environment !== "production") {
    errors.push("environment must be staging or production");
  }
  for (const field of ["owner", "reviewer"] as const) {
    if (!stringValue(document[field])) errors.push(`${field} is required`);
  }
  const owner = actorIdentityValue(document.owner);
  const reviewer = actorIdentityValue(document.reviewer);
  if (owner && reviewer && owner === reviewer) {
    errors.push("reviewer must differ from owner");
  }
  const completedAt = parseEvidenceDate(document.completedAt);
  if (!completedAt) {
    errors.push("completedAt must be a valid date");
  } else if (isFutureEvidenceDate(completedAt)) {
    errors.push("completedAt must not be in the future");
  }

  const manifestRef = checkedEvidenceRef(document.manifestRef, "manifestRef");
  const migrationTranscriptRef = checkedEvidenceRef(
    document.migrationTranscriptRef,
    "migrationTranscriptRef",
  );
  const tlsEvidenceRef = checkedEvidenceRef(
    document.tlsEvidenceRef,
    "tlsEvidenceRef",
  );
  const artifactDigestEvidenceRef = checkedEvidenceRef(
    document.artifactDigestEvidenceRef,
    "artifactDigestEvidenceRef",
  );
  const healthProbeEvidenceRef = checkedEvidenceRef(
    document.healthProbeEvidenceRef,
    "healthProbeEvidenceRef",
  );
  errors.push(
    ...[
      manifestRef,
      migrationTranscriptRef,
      tlsEvidenceRef,
      artifactDigestEvidenceRef,
      healthProbeEvidenceRef,
    ].flatMap((item) => item.errors),
  );

  const rollbackTarget = isRecord(document.rollbackTarget)
    ? document.rollbackTarget
    : null;
  if (!rollbackTarget) {
    errors.push("rollbackTarget must be an object");
  }
  const rollbackRef = checkedEvidenceRef(
    rollbackTarget?.ref,
    "rollbackTarget.ref",
  );
  errors.push(...rollbackRef.errors);
  if (!isSha256Digest(rollbackTarget?.artifactDigest)) {
    errors.push("rollbackTarget.artifactDigest must be a sha256: digest");
  }
  const rollbackRole = stringValue(rollbackTarget?.role);
  if (!rollbackRole) {
    errors.push("rollbackTarget.role is required");
  } else if (!productionTopologyDeployableRoles.has(rollbackRole)) {
    errors.push("rollbackTarget.role must be a deployable component role");
  }

  const rawComponents = Array.isArray(document.components)
    ? document.components
    : [];
  const components = rawComponents.filter(isRecord);
  if (!Array.isArray(document.components)) {
    errors.push("components must be an array");
  }
  const roles = new Set(
    components
      .map((component) => stringValue(component.role))
      .filter((role): role is string => Boolean(role)),
  );
  const missingRoles = productionTopologyRequiredRoles.filter(
    (role) => !roles.has(role),
  );
  if (rollbackRole && !roles.has(rollbackRole)) {
    errors.push("rollbackTarget.role must reference a declared component role");
  }
  for (const role of missingRoles) {
    errors.push(`missing component role: ${role}`);
  }

  const componentIds = new Map<string, number>();
  const componentRoles = new Map<string, number>();
  for (const [index, rawComponent] of rawComponents.entries()) {
    const label = `components[${index}]`;
    if (!isRecord(rawComponent)) {
      errors.push(`${label} must be an object`);
      continue;
    }
    const component = rawComponent;
    const role = stringValue(component.role);
    const id = stringValue(component.id);
    if (!id) {
      errors.push(`${label}.id is required`);
    } else {
      const previousId = componentIds.get(id);
      if (previousId != null) {
        errors.push(`${label}.id duplicates components[${previousId}].id`);
      }
      componentIds.set(id, index);
    }
    if (!role) {
      errors.push(`${label}.role is required`);
    } else {
      const previousRole = componentRoles.get(role);
      if (previousRole != null) {
        errors.push(
          `${label}.role duplicates components[${previousRole}].role`,
        );
      }
      componentRoles.set(role, index);
    }
    if (role && !productionTopologyRequiredRoles.includes(role as never)) {
      errors.push(`${label}.role is not recognized`);
    }
    const healthProbeRef = checkedEvidenceRef(
      component.healthProbeRef,
      `${label}.healthProbeRef`,
    );
    errors.push(...healthProbeRef.errors);
    if (role && productionTopologyDeployableRoles.has(role)) {
      if (!isSha256Digest(component.artifactDigest)) {
        errors.push(`${label}.artifactDigest must be a sha256: digest`);
      }
    }
  }
  for (const component of components) {
    const role = stringValue(component.role);
    if (role && productionTopologyDeployableRoles.has(role)) {
      errors.push(...componentRuntimeEvidenceErrors(component, role));
    }
  }

  const ready = errors.length === 0;
  return {
    kind: platformReadinessProductionTopologyReportKind,
    ready,
    environment,
    missingRoles,
    errors,
    ...(ready
      ? {
          evidenceEntry: productionTopologyEvidenceEntry({
            document,
            environment: environment as "staging" | "production",
            manifestRef: manifestRef.ref as string,
            migrationTranscriptRef: migrationTranscriptRef.ref as string,
            tlsEvidenceRef: tlsEvidenceRef.ref as string,
            rollbackRef: rollbackRef.ref as string,
            artifactDigestEvidenceRef: artifactDigestEvidenceRef.ref as string,
            healthProbeEvidenceRef: healthProbeEvidenceRef.ref as string,
          }),
        }
      : {}),
  };
}

function componentRuntimeEvidenceErrors(
  component: Record<string, unknown>,
  role: string,
): string[] {
  const errors: string[] = [];
  const label = `${role} component`;
  if (!stringValue(component.runtime)) {
    errors.push(`${label} runtime must be a non-empty implementation token`);
  }
  const runtimeEvidenceRef = checkedEvidenceRef(
    component.runtimeEvidenceRef,
    `${label} runtimeEvidenceRef`,
  );
  errors.push(...runtimeEvidenceRef.errors);
  errors.push(
    ...componentRuntimeValidationErrors(component.runtimeValidation, label),
  );
  if (component.bindings !== undefined) {
    if (
      !Array.isArray(component.bindings) ||
      component.bindings.some((binding) => !stringValue(binding))
    ) {
      errors.push(`${label} bindings must be an array of non-empty tokens`);
    }
  }
  return errors;
}

function componentRuntimeValidationErrors(
  value: unknown,
  label: string,
): string[] {
  const errors: string[] = [];
  const report = isRecord(value) ? value : null;
  if (!report) {
    return [`${label} runtimeValidation must be an object`];
  }
  if (!stringValue(report.kind)) {
    errors.push(`${label} runtimeValidation.kind must be a non-empty token`);
  }
  if (report.ok !== true) {
    errors.push(`${label} runtimeValidation.ok must be true`);
  }
  if (!isSha256Digest(report.evidenceDigest)) {
    errors.push(
      `${label} runtimeValidation.evidenceDigest must be a sha256: digest`,
    );
  }
  if (!isRecord(report.checks) || Object.keys(report.checks).length === 0) {
    errors.push(`${label} runtimeValidation.checks must be a non-empty object`);
  } else {
    for (const [check, passed] of Object.entries(report.checks)) {
      if (!/^[A-Za-z0-9_.:-]+$/u.test(check) || passed !== true) {
        errors.push(`${label} runtimeValidation.checks.${check} must be true`);
      }
    }
  }
  return errors;
}

export function checkedEvidenceRef(
  value: unknown,
  label: string,
): { ref?: string; errors: string[] } {
  const ref = stringValue(value);
  if (!ref) return { errors: [`${label} is required`] };
  if (isPlaceholderEvidenceRef(ref)) {
    return { errors: [`${label} must not be a placeholder`] };
  }
  return { ref, errors: [] };
}

export function isSha256Digest(value: unknown): boolean {
  return typeof value === "string" && /^sha256:[a-fA-F0-9]{64}$/.test(value);
}

function productionTopologyEvidenceEntry(input: {
  document: Record<string, unknown>;
  environment: "staging" | "production";
  manifestRef: string;
  migrationTranscriptRef: string;
  tlsEvidenceRef: string;
  rollbackRef: string;
  artifactDigestEvidenceRef: string;
  healthProbeEvidenceRef: string;
}): Record<string, unknown> {
  const components = Array.isArray(input.document.components)
    ? input.document.components.filter(isRecord)
    : [];
  const deployableCount = components.filter((component) =>
    productionTopologyDeployableRoles.has(stringValue(component.role) ?? ""),
  ).length;
  const rollbackTarget = isRecord(input.document.rollbackTarget)
    ? input.document.rollbackTarget
    : {};
  return {
    id: "production-topology",
    requiredEvidenceTypes: requiredEvidenceTypesFor(
      "domains",
      "production-topology",
    ),
    status: "passed",
    owner: stringValue(input.document.owner),
    environment: input.environment,
    reviewer: stringValue(input.document.reviewer),
    completedAt: stringValue(input.document.completedAt),
    evidence: [
      {
        type: `${input.environment}-manifest`,
        ref: input.manifestRef,
        summary: `Production topology manifest declares ${components.length} required components for ${input.environment}.`,
        private: true,
        publicSummary: `Production topology manifest shape was reviewed for ${input.environment}.`,
        topologyEnvironment: input.environment,
        manifestRef: input.manifestRef,
        componentCount: components.length,
      },
      {
        type: `${input.environment}-artifact-digest`,
        ref: input.artifactDigestEvidenceRef,
        summary: `${deployableCount} deployable topology components are pinned by sha256 artifact digest.`,
        private: true,
        publicSummary: `Deployable topology components use immutable artifact digests for ${input.environment}.`,
        topologyEnvironment: input.environment,
        artifactDigestEvidenceRef: input.artifactDigestEvidenceRef,
        deployableComponentCount: deployableCount,
      },
      {
        type: `${input.environment}-migration-transcript`,
        ref: input.migrationTranscriptRef,
        summary: "Accounts/service migration transcript is attached.",
        private: true,
        publicSummary: `Migration transcript evidence was attached for ${input.environment}.`,
        topologyEnvironment: input.environment,
        migrationTranscriptRef: input.migrationTranscriptRef,
      },
      {
        type: `${input.environment}-health-probe`,
        ref: input.healthProbeEvidenceRef,
        summary:
          "Every declared component has a concrete health probe reference.",
        private: true,
        publicSummary: `Health probe evidence covers every topology component in ${input.environment}.`,
        topologyEnvironment: input.environment,
        healthProbeEvidenceRef: input.healthProbeEvidenceRef,
        healthProbeCount: components.length,
      },
      {
        type: `${input.environment}-tls-evidence`,
        ref: input.tlsEvidenceRef,
        summary: "Public hostname TLS evidence is attached.",
        private: true,
        publicSummary: `Public hostname TLS evidence was attached for ${input.environment}.`,
        topologyEnvironment: input.environment,
        tlsEvidenceRef: input.tlsEvidenceRef,
      },
      {
        type: `${input.environment}-rollback-target`,
        ref: input.rollbackRef,
        summary: "Rollback target uses an immutable sha256 artifact digest.",
        private: true,
        publicSummary: `Rollback target evidence uses an immutable digest for ${input.environment}.`,
        topologyEnvironment: input.environment,
        rollbackRef: input.rollbackRef,
        rollbackRole: stringValue(rollbackTarget.role),
        artifactDigest: stringValue(rollbackTarget.artifactDigest),
      },
    ],
  };
}

export function buildProductionTopologyTemplate(
  environment: "staging" | "production",
): Record<string, unknown> {
  return {
    kind: platformReadinessProductionTopologyKind,
    environment,
    owner: "",
    reviewer: "",
    completedAt: "",
    manifestRef: `vault://platform-readiness/<rehearsal-run-id>/production-topology/${environment}/manifest`,
    migrationTranscriptRef: `vault://platform-readiness/<rehearsal-run-id>/production-topology/${environment}/migration-transcript`,
    tlsEvidenceRef: `vault://platform-readiness/<rehearsal-run-id>/production-topology/${environment}/tls`,
    artifactDigestEvidenceRef: `vault://platform-readiness/<rehearsal-run-id>/production-topology/${environment}/artifact-digests`,
    healthProbeEvidenceRef: `vault://platform-readiness/<rehearsal-run-id>/production-topology/${environment}/health-probes`,
    rollbackTarget: {
      ref: `vault://platform-readiness/<rehearsal-run-id>/production-topology/${environment}/rollback-target`,
      role: "accounts",
      artifactDigest: "sha256:<64-hex>",
    },
    components: productionTopologyRequiredRoles.map((role) => ({
      id: `<${role}-component-id>`,
      role,
      healthProbeRef: `vault://platform-readiness/<rehearsal-run-id>/production-topology/${environment}/${role}/health-probe`,
      ...(productionTopologyDeployableRoles.has(role)
        ? {
            runtime: "<operator-runtime-token>",
            runtimeEvidenceRef: `vault://platform-readiness/<rehearsal-run-id>/production-topology/${environment}/${role}/runtime`,
            runtimeValidation: {
              kind: "operator.runtime-validation@v1",
              ok: true,
              evidenceDigest: "sha256:<64-hex>",
              checks: { operatorReviewed: true },
            },
            bindings: [],
          }
        : {}),
      ...(productionTopologyDeployableRoles.has(role)
        ? { artifactDigest: "sha256:<64-hex>" }
        : {}),
    })),
  };
}

export function formatProductionTopologyPreflightReport(
  report: ProductionTopologyPreflightReport,
): string {
  const lines = ["Production topology preflight failed."];
  if (report.missingRoles.length > 0) {
    lines.push(`Missing roles: ${report.missingRoles.join(", ")}`);
  }
  for (const error of report.errors) {
    lines.push(`Error: ${error}`);
  }
  return lines.join("\n");
}

export function mergeProductionTopologyPreflightReports(
  stagingReport: unknown,
  productionReport: unknown,
): ProductionTopologyMergeReport {
  const errors: string[] = [];
  const staging = productionTopologyEntryFromPreflightReport(
    stagingReport,
    "staging",
  );
  const production = productionTopologyEntryFromPreflightReport(
    productionReport,
    "production",
  );
  errors.push(...staging.errors, ...production.errors);

  const stagingEntry = staging.evidenceEntry;
  const productionEntry = production.evidenceEntry;
  if (!stagingEntry || !productionEntry) {
    return {
      kind: platformReadinessProductionTopologyMergeReportKind,
      ready: false,
      errors,
    };
  }

  const owner = stringValue(stagingEntry.owner);
  const reviewer = stringValue(stagingEntry.reviewer);
  if (!owner || !reviewer) {
    errors.push("staging evidence entry owner and reviewer are required");
  }
  if (owner !== stringValue(productionEntry.owner)) {
    errors.push("staging and production owner must match");
  }
  if (reviewer !== stringValue(productionEntry.reviewer)) {
    errors.push("staging and production reviewer must match");
  }

  const completedAt = latestEvidenceTimestamp([
    stagingEntry.completedAt,
    productionEntry.completedAt,
  ]);
  if (!completedAt) {
    errors.push("staging and production completedAt must be valid timestamps");
  }

  const mergedEntry = {
    id: "production-topology",
    requiredEvidenceTypes: requiredEvidenceTypesFor(
      "domains",
      "production-topology",
    ),
    status: "passed",
    owner,
    environment: "staging+production",
    reviewer,
    completedAt,
    evidence: [
      ...(Array.isArray(stagingEntry.evidence) ? stagingEntry.evidence : []),
      ...(Array.isArray(productionEntry.evidence)
        ? productionEntry.evidence
        : []),
    ],
  };
  if (
    !isCompleteEvidenceEntry(
      mergedEntry,
      undefined,
      requiredEvidenceTypesFor("domains", "production-topology"),
    )
  ) {
    errors.push("merged production-topology evidence is incomplete");
  }

  return {
    kind: platformReadinessProductionTopologyMergeReportKind,
    ready: errors.length === 0,
    errors,
    ...(errors.length === 0 ? { evidenceEntry: mergedEntry } : {}),
  };
}

function productionTopologyEntryFromPreflightReport(
  report: unknown,
  environment: "staging" | "production",
): { evidenceEntry?: Record<string, unknown>; errors: string[] } {
  const errors: string[] = [];
  const label = `${environment} preflight report`;
  if (!isRecord(report)) {
    return { errors: [`${label} must be an object`] };
  }
  if (report.kind !== platformReadinessProductionTopologyReportKind) {
    errors.push(
      `${label}.kind must be ${platformReadinessProductionTopologyReportKind}`,
    );
  }
  if (report.ready !== true) {
    errors.push(`${label}.ready must be true`);
  }
  if (report.environment !== environment) {
    errors.push(`${label}.environment must be ${environment}`);
  }
  if (!isRecord(report.evidenceEntry)) {
    errors.push(`${label}.evidenceEntry must be an object`);
    return { errors };
  }
  const entry = report.evidenceEntry;
  if (entry.id !== "production-topology") {
    errors.push(`${label}.evidenceEntry.id must be production-topology`);
  }
  if (entry.status !== "passed") {
    errors.push(`${label}.evidenceEntry.status must be passed`);
  }
  if (entry.environment !== environment) {
    errors.push(`${label}.evidenceEntry.environment must be ${environment}`);
  }
  const expectedTypes = requiredEvidenceTypesFor(
    "domains",
    "production-topology",
  ).filter((type) => type.startsWith(`${environment}-`));
  const actualTypes = Array.isArray(entry.evidence)
    ? entry.evidence
        .map((item) => (isRecord(item) ? stringValue(item.type) : undefined))
        .filter((type): type is string => Boolean(type))
    : [];
  const missing = expectedTypes.filter((type) => !actualTypes.includes(type));
  const extra = actualTypes.filter((type) => !expectedTypes.includes(type));
  if (missing.length > 0) {
    errors.push(`${label}.evidenceEntry missing ${missing.join(", ")}`);
  }
  if (extra.length > 0) {
    errors.push(`${label}.evidenceEntry has unexpected ${extra.join(", ")}`);
  }
  const evidenceItems = Array.isArray(entry.evidence) ? entry.evidence : [];
  for (const duplicate of duplicatedEvidenceTypes(evidenceItems)) {
    errors.push(`${label}.evidenceEntry.evidence.${duplicate} is duplicated`);
  }
  for (const item of evidenceItems) {
    if (!isCompleteEvidenceReference(item)) {
      errors.push(`${label}.evidenceEntry has incomplete evidence reference`);
      break;
    }
  }
  return errors.length > 0 ? { errors } : { evidenceEntry: entry, errors };
}

function latestEvidenceTimestamp(values: unknown[]): string | null {
  let latest: { raw: string; date: Date } | null = null;
  for (const value of values) {
    const raw = stringValue(value);
    const parsed = parseEvidenceDate(raw);
    if (!raw || !parsed) return null;
    if (!latest || parsed.getTime() > latest.date.getTime()) {
      latest = { raw, date: parsed };
    }
  }
  return latest?.raw ?? null;
}

export function formatProductionTopologyMergeReport(
  report: ProductionTopologyMergeReport,
): string {
  const lines = ["Production topology evidence merge failed."];
  for (const error of report.errors) {
    lines.push(`Error: ${error}`);
  }
  return lines.join("\n");
}
export async function platformReadinessDigest(
  document: unknown,
): Promise<string> {
  return `sha256:${await sha256Hex(canonicalJson(document))}`;
}

export function platformReadinessEvidenceSummaryErrors(
  value: string,
  definition: PlatformReadinessDefinition = OSS_PLATFORM_READINESS_DEFINITION,
): string[] {
  const summary = value.trim();
  const errors: string[] = [];
  if (summary.length < 20) {
    errors.push(
      "platform readiness evidence summary must be at least 20 characters",
    );
  }
  if (isPlaceholderEvidenceRef(summary)) {
    errors.push(
      "platform readiness evidence summary must not be a placeholder",
    );
  }
  errors.push(
    ...platformReadinessSummaryRedactionErrors(
      summary,
      "platform readiness evidence summary",
    ),
  );
  errors.push(
    ...platformReadinessContributionRedactionErrors(
      summary,
      "platform readiness evidence summary",
      definition,
    ),
  );
  return errors;
}

export function platformReadinessPublicSummaryErrors(
  value: string,
  options: { requireLaunchScope?: boolean } = {},
  definition: PlatformReadinessDefinition = OSS_PLATFORM_READINESS_DEFINITION,
): string[] {
  const summary = value.trim();
  const errors: string[] = [];
  if (summary.length < 40) {
    errors.push("--platform-public-summary must be at least 40 characters");
  }
  if (isPlaceholderEvidenceRef(summary)) {
    errors.push("--platform-public-summary must not be a placeholder");
  }
  errors.push(
    ...platformReadinessSummaryRedactionErrors(
      summary,
      "--platform-public-summary",
    ),
  );
  errors.push(
    ...platformReadinessContributionRedactionErrors(
      summary,
      "--platform-public-summary",
      definition,
    ),
  );
  if (options.requireLaunchScope) {
    if (!/\bp0\b/i.test(summary) || !/(evidence|証跡)/iu.test(summary)) {
      errors.push("--platform-public-summary must mention P0 evidence");
    }
    if (!/(staged|rehearsal|リハーサル)/iu.test(summary)) {
      errors.push(
        "--platform-public-summary must mention the staged launch rehearsal",
      );
    }
  }
  return errors;
}

function platformReadinessContributionRedactionErrors(
  summary: string,
  label: string,
  definition: PlatformReadinessDefinition,
): string[] {
  return definition.forbiddenSummaryPatterns.flatMap((pattern) =>
    new RegExp(pattern, "u").test(summary)
      ? [`${label} contains an extension-protected identifier`]
      : [],
  );
}

export function platformReadinessSummaryRedactionErrors(
  summary: string,
  label: string,
): string[] {
  const errors: string[] = [];
  if (/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu.test(summary)) {
    errors.push(`${label} must not contain email addresses`);
  }
  if (
    /\b(?:authorization:\s*)?bearer\s+[A-Za-z0-9._-]{10,}\b/iu.test(summary)
  ) {
    errors.push(`${label} must not contain secrets or bearer tokens`);
  }
  if (
    /\barn:aws[a-z-]*:[^\s]+:\d{12}:[^\s]+/iu.test(summary) ||
    /\b\d{12}\b/u.test(summary)
  ) {
    errors.push(`${label} must not contain provider account IDs`);
  }
  if (
    /\b(?:projects|subscriptions|resourceGroups)\/[A-Za-z0-9._:-]{4,}\b/iu.test(
      summary,
    ) ||
    /\b(?:tenant|account|workspace|capsule|installation|space|resource)[_-]?(?:id)?[:=]\s*[A-Za-z0-9._:-]{6,}\b/iu.test(
      summary,
    ) ||
    /\b(?:acct|ws|cap|inst|tenant|space|run|res)_[A-Za-z0-9._-]{6,}\b/u.test(
      summary,
    )
  ) {
    errors.push(`${label} must not contain internal resource IDs`);
  }
  return errors;
}
