import {
  platformReadinessDomainIds,
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
  platformReadinessRehearsalStepIds,
  platformReadinessRequiredEvidenceTypes,
  platformReadinessStructuredEvidenceRequirements,
  productionTopologyDeployableRoles,
  type ProductionTopologyMergeReport,
  type ProductionTopologyPreflightReport,
  productionTopologyRequiredRoles,
} from "./cli-platform-readiness-constants.ts";
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
      missingDomains: [...platformReadinessDomainIds],
      incompleteDomains: [],
      missingRehearsalSteps: [...platformReadinessRehearsalStepIds],
      incompleteRehearsalSteps: [],
      errors: ["document must be a JSON object"],
    };
  }

  if (document.kind !== platformReadinessKind) {
    errors.push(`kind must be ${platformReadinessKind}`);
  }

  const domainResult = validateEvidenceEntries(
    document.domains,
    platformReadinessDomainIds,
    "domains",
  );
  const rehearsalRunResult = validatePlatformReadinessRehearsalRun(
    document.rehearsalRun,
  );
  const rehearsalResult = validateEvidenceEntries(
    document.rehearsal,
    platformReadinessRehearsalStepIds,
    "rehearsal",
    rehearsalRunResult,
  );
  const gapDetails = [
    ...buildPlatformReadinessGapDetails({
      entries: document.domains,
      requiredIds: platformReadinessDomainIds,
      scope: "domains",
    }),
    ...buildPlatformReadinessGapDetails({
      entries: document.rehearsal,
      requiredIds: platformReadinessRehearsalStepIds,
      scope: "rehearsal",
      rehearsalRun: rehearsalRunResult,
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

export function buildPlatformReadinessTemplate(): Record<string, unknown> {
  const templateEntry = (scope: "domains" | "rehearsal", id: string) => ({
    id,
    status: "blocked" satisfies PlatformReadinessEvidenceStatus,
    owner: "",
    environment: "",
    reviewer: "",
    completedAt: "",
    evidence: requiredEvidenceTypesFor(scope, id).map((type) =>
      buildPlatformReadinessEvidenceTemplateReference(scope, id, type),
    ),
  });
  return {
    kind: platformReadinessKind,
    rehearsalRun: {
      id: "",
      environment: "",
      owner: "",
      reviewer: "",
      startedAt: "",
      completedAt: "",
    },
    domains: platformReadinessDomainIds.map((id) => ({
      ...templateEntry("domains", id),
      requiredEvidenceTypes: requiredEvidenceTypesFor("domains", id),
    })),
    rehearsal: platformReadinessRehearsalStepIds.map((id) => ({
      ...templateEntry("rehearsal", id),
      runId: "",
      requiredEvidenceTypes: requiredEvidenceTypesFor("rehearsal", id),
    })),
  };
}

const legacyFinalModelEvidenceTypeMap = new Map([
  ["installation-created", "capsule-created"],
  ["installation-session", "capsule-session"],
  ["installation-plan-run", "capsule-plan-run"],
  ["install-apply", "capsule-apply"],
  ["per-installation-metrics", "per-capsule-metrics"],
  ["deploy-kill-switch", "run-kill-switch"],
]);

const legacyFinalModelFieldMap = new Map([
  ["spaceId", "workspaceId"],
  ["installationId", "capsuleId"],
  ["tenantAInstallationId", "tenantACapsuleId"],
  ["tenantBInstallationId", "tenantBCapsuleId"],
]);

export interface PlatformReadinessFinalModelMigrationReport {
  kind: "takosumi.platform-readiness-final-model-migration-report@v1";
  changed: boolean;
  changes: Array<{
    kind: "evidenceType" | "field" | "labelSet" | "dataClasses";
    from: string;
    to: string;
    count: number;
  }>;
}

export function migratePlatformReadinessDocumentToFinalModel(
  document: unknown,
): {
  document: unknown;
  report: PlatformReadinessFinalModelMigrationReport;
} {
  const migrated = JSON.parse(JSON.stringify(document)) as unknown;
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
    const originalType = typeof record.type === "string" ? record.type : "";
    if (typeof record.type === "string") {
      record.type = mapEvidenceType(record.type);
    }
    if (Array.isArray(record.requiredEvidenceTypes)) {
      record.requiredEvidenceTypes =
        record.requiredEvidenceTypes.map(mapEvidenceType);
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
  visit(migrated);

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

function buildPlatformReadinessEvidenceTemplateReference(
  scope: "domains" | "rehearsal",
  id: string,
  type: string,
): Record<string, unknown> {
  const requirement = platformReadinessStructuredEvidenceRequirements[type];
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
      reference[field] = platformReadinessTemplateFieldValue(field);
    }
  }
  for (const alternatives of requirement?.anyOf ?? []) {
    for (const field of alternatives) {
      if (reference[field] === undefined) {
        reference[field] = platformReadinessTemplateFieldValue(field);
      }
    }
  }
  return reference;
}

function platformReadinessTemplateFieldValue(field: string): unknown {
  if (field.endsWith("Digest") || field.endsWith("Hash")) {
    return "sha256:<64-hex>";
  }
  if (field === "commitSha" || field === "sourceCommit") {
    return "<40-hex-commit-sha>";
  }
  if (field.endsWith("Url")) return "https://accounts.example.invalid/<path>";
  if (field.endsWith("Ref")) return `vault://platform-readiness/<${field}>`;
  if (
    [
      "completedAt",
      "reviewedAt",
      "verifiedAt",
      "windowStart",
      "windowEnd",
    ].includes(field)
  ) {
    return "YYYY-MM-DDTHH:mm:ssZ";
  }
  if (
    [
      "quantity",
      "rpoSeconds",
      "rtoSeconds",
      "cap",
      "overlapWindowSeconds",
      "tenantCount",
      "componentCount",
      "deployableComponentCount",
      "healthProbeCount",
    ].includes(field)
  ) {
    return 0;
  }
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
          requiredEvidenceTypesFor(fieldName, entry.id),
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
          requiredEvidenceTypesFor(fieldName, id),
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
): readonly string[] {
  return (
    (
      platformReadinessRequiredEvidenceTypes[fieldName] as Record<
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
      ...requiredEvidenceTypesFor(input.scope, id),
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
      )
    ) {
      return [];
    }

    const evidence = Array.isArray(entry.evidence) ? entry.evidence : [];
    const presentEvidenceTypes = orderedEvidenceTypes(evidence);
    const completeEvidenceTypes = orderedEvidenceTypes(
      evidence.filter(isCompleteEvidenceReference),
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
      .map((type) => evidenceReferenceGapForType(type, evidence))
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
  if (isCompleteEvidenceReference(reference)) return null;
  return {
    type,
    status: "incomplete",
    blockingFields: evidenceReferenceBlockingFields(reference, type),
  };
}

function evidenceReferenceBlockingFields(
  reference: Record<string, unknown>,
  type: string,
): string[] {
  const fields = new Set<string>();
  if (stringValue(reference.type)?.trim() !== type) fields.add("type");
  const ref = stringValue(reference.ref);
  if (!ref || isPlaceholderEvidenceRef(ref)) fields.add("ref");
  const summary = stringValue(reference.summary);
  if (!summary || platformReadinessEvidenceSummaryErrors(summary).length > 0) {
    fields.add("summary");
  }
  for (const field of structuredEvidenceBlockingFields(reference, type)) {
    fields.add(field);
  }
  if (reference.private !== true) fields.add("private");
  const publicSummary = stringValue(reference.publicSummary);
  if (
    publicSummary === undefined ||
    platformReadinessPublicSummaryErrors(publicSummary, {
      requireLaunchScope: false,
    }).length > 0
  ) {
    fields.add("publicSummary");
  }
  return [...fields].sort();
}

function structuredEvidenceBlockingFields(
  reference: Record<string, unknown>,
  type: string,
): string[] {
  const fields = new Set<string>();
  const requirement = platformReadinessStructuredEvidenceRequirements[type];
  if (!requirement) return [];
  for (const [field, expectedValue] of Object.entries(
    requirement.values ?? {},
  )) {
    if (stringValue(reference[field]) !== expectedValue) fields.add(field);
  }
  for (const [field, allowedValues] of Object.entries(
    requirement.allowedValues ?? {},
  )) {
    const value = stringValue(reference[field]);
    if (!value || !allowedValues.includes(value)) fields.add(field);
  }
  for (const field of requirement.fields ?? []) {
    if (
      !hasNonEmptyEvidenceField(reference, field) ||
      !hasValidStructuredEvidenceFieldShape(reference, field)
    ) {
      fields.add(field);
    }
  }
  for (const alternatives of requirement.anyOf ?? []) {
    if (
      !alternatives.some(
        (field) =>
          hasNonEmptyEvidenceField(reference, field) &&
          hasValidStructuredEvidenceFieldShape(reference, field),
      )
    ) {
      fields.add(`anyOf:${alternatives.join("|")}`);
    }
  }
  if (!hasValidStructuredEvidenceCrossFieldShape(reference, type)) {
    fields.add("crossField");
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
  if (scope === "rehearsal" && !hasConsistentRehearsalStepEvidence(entry)) {
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
    entry.evidence.some(isCompleteEvidenceReference) &&
    hasRequiredEvidenceTypes(entry.evidence, requiredEvidenceTypes) &&
    (!rehearsalRun ||
      (entryRunId !== null && hasConsistentEvidenceRunId(entry, entryRunId))) &&
    (!rehearsalRun || hasConsistentRehearsalStepEvidence(entry))
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

function isCompleteEvidenceReference(value: unknown): boolean {
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
  if (platformReadinessEvidenceSummaryErrors(reference.summary).length > 0) {
    return false;
  }
  if (!satisfiesStructuredEvidenceRequirement(value, reference.type.trim())) {
    return false;
  }
  if (reference.private !== true) {
    return false;
  }
  return (
    typeof reference.publicSummary === "string" &&
    platformReadinessPublicSummaryErrors(reference.publicSummary, {
      requireLaunchScope: false,
    }).length === 0
  );
}

function satisfiesStructuredEvidenceRequirement(
  reference: Record<string, unknown>,
  type: string,
): boolean {
  const requirement = platformReadinessStructuredEvidenceRequirements[type];
  if (!requirement) return true;
  for (const [field, expectedValue] of Object.entries(
    requirement.values ?? {},
  )) {
    if (stringValue(reference[field]) !== expectedValue) return false;
  }
  for (const [field, allowedValues] of Object.entries(
    requirement.allowedValues ?? {},
  )) {
    const value = stringValue(reference[field]);
    if (!value || !allowedValues.includes(value)) return false;
  }
  for (const field of requirement.fields ?? []) {
    if (!hasNonEmptyEvidenceField(reference, field)) return false;
    if (!hasValidStructuredEvidenceFieldShape(reference, field)) return false;
  }
  for (const alternatives of requirement.anyOf ?? []) {
    if (
      !alternatives.some(
        (field) =>
          hasNonEmptyEvidenceField(reference, field) &&
          hasValidStructuredEvidenceFieldShape(reference, field),
      )
    ) {
      return false;
    }
  }
  if (!hasValidStructuredEvidenceCrossFieldShape(reference, type)) {
    return false;
  }
  return true;
}

function hasNonEmptyEvidenceField(
  reference: Record<string, unknown>,
  field: string,
): boolean {
  const value = reference[field];
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.length > 0;
  return typeof value === "string" && value.trim().length > 0;
}

function hasValidStructuredEvidenceFieldShape(
  reference: Record<string, unknown>,
  field: string,
): boolean {
  const value = reference[field];
  if (field.endsWith("Digest") || field.endsWith("Hash")) {
    return isSha256Digest(value);
  }
  if (field.endsWith("Ref")) {
    return (
      typeof value === "string" &&
      value.trim().length > 0 &&
      !isPlaceholderEvidenceRef(value)
    );
  }
  if (field === "commitSha" || field === "sourceCommit") {
    return typeof value === "string" && /^[a-fA-F0-9]{40}$/.test(value);
  }
  if (field.endsWith("Url")) {
    return (
      isHttpsUrl(value) &&
      typeof value === "string" &&
      !isPlaceholderEvidenceRef(value)
    );
  }
  if (
    [
      "quantity",
      "rpoSeconds",
      "rtoSeconds",
      "cap",
      "overlapWindowSeconds",
      "tenantCount",
      "componentCount",
      "deployableComponentCount",
      "healthProbeCount",
    ].includes(field)
  ) {
    return typeof value === "number" && Number.isFinite(value) && value > 0;
  }
  if (field === "coveredEndpoints") {
    return hasRequiredDataClasses(value, [
      "signup",
      "login",
      "install",
      "launch",
      "export",
    ]);
  }
  if (
    [
      "completedAt",
      "reviewedAt",
      "verifiedAt",
      "windowStart",
      "windowEnd",
    ].includes(field)
  ) {
    const parsed = parseEvidenceDate(value);
    return Boolean(parsed && !isFutureEvidenceDate(parsed));
  }
  if (typeof value === "string" && isPlaceholderEvidenceRef(value)) {
    return false;
  }
  return true;
}

function hasValidStructuredEvidenceCrossFieldShape(
  reference: Record<string, unknown>,
  type: string,
): boolean {
  switch (type) {
    case "stripe-sandbox":
      return (
        hasStripeId(reference.checkoutSessionId, "cs_test_") &&
        hasStripeId(reference.webhookEventId, "evt_")
      );
    case "stripe-live":
      return (
        hasStripeId(reference.checkoutSessionId, "cs_live_") &&
        hasStripeId(reference.webhookEventId, "evt_")
      );
    case "invoice":
      return hasStripeId(reference.invoiceId, "in_");
    case "failed-payment":
    case "invoice-paid":
      return (
        hasStripeId(reference.invoiceId, "in_") &&
        hasStripeId(reference.webhookEventId, "evt_")
      );
    case "dunning-suspension":
      return hasStripeId(reference.invoiceId, "in_");
    case "plan-transition":
      return hasStripeId(reference.subscriptionId, "sub_");
    case "load-test":
      return (
        typeof reference.tenantCount === "number" &&
        reference.tenantCount >= 2 &&
        stringValue(reference.tenantACapsuleId) !==
          stringValue(reference.tenantBCapsuleId)
      );
    case "continuity-evidence":
      return stringValue(reference.noDataLossCheckId) !== undefined;
    case "sample-data-verification":
      return hasRequiredDataClasses(reference.dataClasses, [
        "account",
        "workspace",
        "capsule",
        "run",
        "output",
      ]);
    case "refund-credit":
    case "recovery-refund-credit":
      return (
        (reference.refundId === undefined ||
          hasStripeId(reference.refundId, "re_")) &&
        (reference.creditNoteId === undefined ||
          hasStripeId(reference.creditNoteId, "cn_"))
      );
    case "usage-aggregation-policy": {
      const windowStart = parseEvidenceDate(reference.windowStart);
      const windowEnd = parseEvidenceDate(reference.windowEnd);
      return Boolean(
        windowStart && windowEnd && windowEnd.getTime() > windowStart.getTime(),
      );
    }
    default:
      return true;
  }
}

function hasRequiredDataClasses(
  value: unknown,
  required: readonly string[],
): boolean {
  const classes = Array.isArray(value)
    ? value
        .map((item) => stringValue(item))
        .filter((item): item is string => item !== undefined)
    : typeof value === "string"
      ? value.split(/[,\s/]+/u).map((item) => item.trim())
      : [];
  const present = new Set(classes.filter(Boolean));
  return required.every((item) => present.has(item));
}

function hasStripeId(value: unknown, prefix: string): boolean {
  return (
    typeof value === "string" &&
    value.trim().startsWith(prefix) &&
    /^[a-z]+_(?:test_|live_)?[A-Za-z0-9_]{6,}$/.test(value.trim())
  );
}

function isHttpsUrl(value: unknown): boolean {
  if (typeof value !== "string" || value.trim().length === 0) return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
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
): boolean {
  const completeTypes = new Set(
    evidence
      .filter(isCompleteEvidenceReference)
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
): boolean {
  if (typeof entry.id !== "string" || !Array.isArray(entry.evidence)) {
    return true;
  }
  const evidenceByType = evidenceReferencesByType(entry.evidence);
  switch (entry.id) {
    case "fresh-signup":
      return (
        sameEvidenceField(
          evidenceByType,
          [
            "signup-event",
            "email-assurance",
            "team-membership",
            "terms-acceptance",
            "entitlement-event",
          ],
          "accountId",
        ) &&
        sameEvidenceField(
          evidenceByType,
          ["signup-event", "team-membership"],
          "workspaceId",
        )
      );
    case "capsule-launch":
      return sameEvidenceField(
        evidenceByType,
        ["launch-token-consume", "capsule-created", "capsule-session"],
        "capsuleId",
      );
    case "git-url-install":
      return (
        sameEvidenceField(
          evidenceByType,
          ["capsule-plan-run", "cost-review", "capsule-apply"],
          "planDigest",
        ) &&
        sameEvidenceField(
          evidenceByType,
          [
            "capsule-plan-run",
            "capsule-apply",
            "oidc-login",
            "event-hash-chain",
          ],
          "capsuleId",
        )
      );
    case "quota-abuse-drill":
      return sameEvidenceField(
        evidenceByType,
        ["quota-exceeded", "guard-action", "override-audit"],
        "accountId",
      );
    case "shared-cell-load":
      return (
        sameEvidenceField(
          evidenceByType,
          ["two-tenant-load", "isolation-proof"],
          "loadRunId",
        ) &&
        sameEvidenceField(
          evidenceByType,
          ["two-tenant-load", "per-capsule-metrics", "scale-or-drain"],
          "runtimeCellId",
        ) &&
        sameEvidenceField(
          evidenceByType,
          ["two-tenant-load", "per-capsule-metrics"],
          "tenantACapsuleId",
        ) &&
        sameEvidenceField(
          evidenceByType,
          ["two-tenant-load", "per-capsule-metrics"],
          "tenantBCapsuleId",
        ) &&
        differentEvidenceFields(
          evidenceByType,
          "two-tenant-load",
          "tenantACapsuleId",
          "tenantBCapsuleId",
        )
      );
    case "dedicated-materialize":
      return (
        sameEvidenceField(
          evidenceByType,
          [
            "readiness-before-cutover",
            "materialize-cutover",
            "rollback-before-final",
            "domain-preservation",
            "preserve-evidence",
          ],
          "capsuleId",
        ) &&
        sameEvidenceField(
          evidenceByType,
          ["readiness-before-cutover", "materialize-cutover"],
          "targetRuntimeTargetId",
        ) &&
        sameEvidenceField(
          evidenceByType,
          ["domain-preservation", "preserve-evidence"],
          "oidcClientId",
        ) &&
        sameEvidenceField(
          evidenceByType,
          ["domain-preservation", "preserve-evidence"],
          "domainName",
        )
      );
    case "export-self-host-import":
      return (
        sameEvidenceField(
          evidenceByType,
          ["clean-import", "post-import-login"],
          "importId",
        ) &&
        sameEvidenceField(
          evidenceByType,
          ["post-import-login", "source-retention-state"],
          "accountId",
        )
      );
    case "sev-simulation":
      return sameEvidenceField(
        evidenceByType,
        ["alert", "ack", "status-update", "postmortem"],
        "incidentId",
      );
    case "release-rollback":
      return sameEvidenceField(
        evidenceByType,
        ["release-promotion", "rollback", "support-note"],
        "releaseCandidate",
      );
    case "privacy-operation":
      return (
        sameEvidenceField(
          evidenceByType,
          [
            "export-or-delete-request",
            "login-disabled-or-exported",
            "retention-record",
          ],
          "requestId",
        ) &&
        sameEvidenceField(
          evidenceByType,
          ["export-or-delete-request", "login-disabled-or-exported"],
          "accountId",
        )
      );
    case "billing-operation":
      return sameEvidenceField(
        evidenceByType,
        ["failed-payment", "dunning-suspension"],
        "invoiceId",
      );
    default:
      return true;
  }
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

function differentEvidenceFields(
  evidenceByType: Map<string, Record<string, unknown>>,
  type: string,
  leftField: string,
  rightField: string,
): boolean {
  const reference = evidenceByType.get(type);
  const left = stringValue(reference?.[leftField]);
  const right = stringValue(reference?.[rightField]);
  return Boolean(left && right && left !== right);
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
    : "Platform readiness launch readiness remains blocked because validator checks have not passed.";
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
      ? "Public signup and paid access still require separate operator approval."
      : "Keep public launch blocked until every P0 domain and one staged rehearsal pass validation.",
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
      ...platformReadinessPublicSummaryErrors(publicResult, {
        requireLaunchScope: ready,
      }),
    );
  }
  errors.push(
    ...platformReadinessSummaryRedactionErrors(
      JSON.stringify(summary),
      "platform readiness public summary artifact",
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
  const accountsComponent = components.find(
    (component) => stringValue(component.role) === "accounts",
  );
  if (accountsComponent) {
    errors.push(...accountsWorkerSubstrateErrors(accountsComponent));
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

function accountsWorkerSubstrateErrors(
  component: Record<string, unknown>,
): string[] {
  const errors: string[] = [];
  if (component.runtime !== "cloudflare-worker") {
    errors.push("accounts component runtime must be cloudflare-worker");
  }
  if (component.containerRuntime !== true) {
    errors.push("accounts component containerRuntime must be true");
  }
  const wranglerConfigRef = checkedEvidenceRef(
    component.wranglerConfigRef,
    "accounts component wranglerConfigRef",
  );
  errors.push(...wranglerConfigRef.errors);
  errors.push(
    ...accountsWorkerConfigValidationErrors(component.wranglerConfigValidation),
  );
  const bindings = Array.isArray(component.bindings)
    ? component.bindings.filter(
        (item): item is string => typeof item === "string",
      )
    : [];
  if (!Array.isArray(component.bindings)) {
    errors.push("accounts component bindings must be an array");
  }
  for (const requiredBinding of [
    "D1:TAKOSUMI_ACCOUNTS_DB",
    "R2:TAKOSUMI_ACCOUNTS_EXPORTS",
  ]) {
    if (!bindings.includes(requiredBinding)) {
      errors.push(
        `accounts component bindings must include ${requiredBinding}`,
      );
    }
  }
  return errors;
}

function accountsWorkerConfigValidationErrors(value: unknown): string[] {
  const errors: string[] = [];
  const report = isRecord(value) ? value : null;
  if (!report) {
    return ["accounts component wranglerConfigValidation must be an object"];
  }
  if (report.kind !== "takosumi.cloudflare-rendered-config-validation@v1") {
    errors.push(
      "accounts component wranglerConfigValidation.kind must be takosumi.cloudflare-rendered-config-validation@v1",
    );
  }
  if (report.ok !== true) {
    errors.push("accounts component wranglerConfigValidation.ok must be true");
  }
  if (!isSha256Digest(report.configDigest)) {
    errors.push(
      "accounts component wranglerConfigValidation.configDigest must be a sha256: digest",
    );
  }
  const expectedTrueFields = [
    "mainPointsAtWorkerBundle",
    "bareOriginIssuerConfigured",
    "platformAccessClosed",
    "d1BindingPresent",
    "d1DatabaseBlockPresent",
    "d1DatabaseIdPresent",
    "d1DatabaseIdValid",
    "controlD1BindingPresent",
    "r2BindingPresent",
    "r2BucketBlockPresent",
    "containerConfigured",
    "durableObjectPersistenceConfigured",
    "runnerDurableObjectBindingPresent",
    "runQueueConfigured",
  ];
  for (const field of expectedTrueFields) {
    if (report[field] !== true) {
      errors.push(
        `accounts component wranglerConfigValidation.${field} must be true`,
      );
    }
  }
  const expectedFalseFields = ["d1DatabaseIdPlaceholder"];
  for (const field of expectedFalseFields) {
    if (report[field] !== false) {
      errors.push(
        `accounts component wranglerConfigValidation.${field} must be false`,
      );
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
      ...(role === "accounts"
        ? {
            runtime: "cloudflare-worker",
            containerRuntime: true,
            wranglerConfigRef: `vault://platform-readiness/<rehearsal-run-id>/production-topology/${environment}/accounts/wrangler-config`,
            wranglerConfigValidation: {
              kind: "takosumi.cloudflare-rendered-config-validation@v1",
              ok: true,
              configDigest: "sha256:<64-hex>",
              mainPointsAtWorkerBundle: true,
              bareOriginIssuerConfigured: true,
              platformAccessClosed: true,
              d1BindingPresent: true,
              d1DatabaseBlockPresent: true,
              d1DatabaseIdPresent: true,
              d1DatabaseIdValid: true,
              d1DatabaseIdPlaceholder: false,
              controlD1BindingPresent: true,
              r2BindingPresent: true,
              r2BucketBlockPresent: true,
              containerConfigured: true,
              durableObjectPersistenceConfigured: true,
              runnerDurableObjectBindingPresent: true,
              runQueueConfigured: true,
            },
            bindings: [
              "D1:TAKOSUMI_ACCOUNTS_DB",
              "R2:TAKOSUMI_ACCOUNTS_EXPORTS",
            ],
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
  return errors;
}

export function platformReadinessPublicSummaryErrors(
  value: string,
  options: { requireLaunchScope?: boolean } = {},
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

export function platformReadinessSummaryRedactionErrors(
  summary: string,
  label: string,
): string[] {
  const errors: string[] = [];
  if (/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu.test(summary)) {
    errors.push(`${label} must not contain email addresses`);
  }
  if (
    /\b(?:cus|sub|in|pi|pm|price|prod|cs|evt|re|cn)_[A-Za-z0-9_]{6,}\b/u.test(
      summary,
    )
  ) {
    errors.push(`${label} must not contain Stripe object IDs`);
  }
  if (
    /\bsk_(?:test|live)_[A-Za-z0-9]{6,}\b/u.test(summary) ||
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
