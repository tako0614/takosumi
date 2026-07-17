import type {
  FormDefinition,
  FormPackage,
  InstalledFormReference,
  JsonValue,
  StandardFormAdmissionEvidence,
  StandardFormAdmissionResult,
  StandardFormConformanceProof,
} from "takosumi-contract";
import {
  installedFormReferenceKey,
  isInstalledFormReference,
  isSha256Digest,
  STANDARD_FORM_ADMISSION_API_VERSION,
} from "takosumi-contract";

const REQUIRED_OPERATIONS = [
  "create",
  "read",
  "update",
  "delete",
  "import",
  "refresh",
] as const;

const FORBIDDEN_EVIDENCE_KEYS = new Set([
  "credential",
  "credentials",
  "secret",
  "password",
  "token",
  "provider",
  "providers",
  "target",
  "targets",
  "manager",
  "capacity",
  "price",
  "pricing",
  "sku",
  "billing",
  "quota",
  "sla",
  "command",
  "script",
  "executable",
  "binary",
  "code",
]);

/**
 * Evaluates standard admission only after the injected Takoform package
 * verifier produced the retained definition/package rows. This is not a
 * second package parser, registry, lifecycle ledger, or execution authority.
 */
export function evaluateStandardFormAdmission(input: {
  readonly definition: FormDefinition;
  readonly package: FormPackage;
  /** Exact id of the host-injected Takoform package verifier instance. */
  readonly trustedPackageVerifierId: string;
  readonly evidence: StandardFormAdmissionEvidence;
}): StandardFormAdmissionResult {
  const errors: string[] = [];
  const { definition, package: packageRecord, evidence } = input;
  const exact = installedFormReferenceKey(definition.identity);

  if (evidence.apiVersion !== STANDARD_FORM_ADMISSION_API_VERSION) {
    errors.push("unsupported standard-admission apiVersion");
  }
  if (!isInstalledFormReference(evidence.identity)) {
    errors.push("evidence identity is not an exact InstalledFormReference");
  } else if (installedFormReferenceKey(evidence.identity) !== exact) {
    errors.push("evidence identity does not match the verified definition");
  }
  if (evidence.classification !== "portable-standard") {
    errors.push("classification must be portable-standard");
  }
  if (
    !isSha256Digest(evidence.approvedSchemaDigest) ||
    evidence.approvedSchemaDigest !== definition.identity.formRef.schemaDigest
  ) {
    errors.push("approved schema digest does not match the exact FormRef");
  }
  if (
    packageRecord.packageDigest !== definition.identity.packageDigest ||
    packageRecord.status !== "installed" ||
    packageRecord.verifierId !== input.trustedPackageVerifierId ||
    !packageRecord.definitionRefs.some(
      (ref) =>
        installedFormReferenceKey({
          formRef: ref,
          packageDigest: packageRecord.packageDigest,
        }) === exact,
    )
  ) {
    errors.push("definition lacks one installed Takoform-verified package");
  }
  if (takoformStatus(definition) !== "standard") {
    errors.push("verified definition status is not standard");
  }
  for (const operation of REQUIRED_OPERATIONS) {
    if (!definition.operations.includes(operation)) {
      errors.push(`verified definition lacks ${operation} lifecycle operation`);
    }
  }

  if (
    !Object.values(evidence.audit.lifecycle).every((value) => value === true)
  ) {
    errors.push(
      "lifecycle audit must explicitly pass every portable operation",
    );
  }
  if (evidence.audit.immutability.reviewed !== true) {
    errors.push("immutability audit must explicitly pass");
  }
  if (
    !Object.values(evidence.audit.security).every((value) => value === true)
  ) {
    errors.push("security audit must explicitly pass every boundary");
  }
  if (
    !Object.values(evidence.audit.interfaces).every((value) => value === true)
  ) {
    errors.push("Interface audit must explicitly pass every boundary");
  }

  const immutableFields = takoformImmutableFields(definition);
  if (!sameStringSet(immutableFields, evidence.audit.immutability.fields)) {
    errors.push("immutability audit does not match the verified definition");
  }
  if (evidence.fixtures.positive.length === 0) {
    errors.push("at least one canonical positive fixture is required");
  }
  if (evidence.fixtures.negative.length === 0) {
    errors.push("at least one canonical negative fixture is required");
  }
  const positiveNames = fixtureNames(
    evidence.fixtures.positive,
    "positive",
    errors,
  );
  const negativeNames = fixtureNames(
    evidence.fixtures.negative,
    "negative",
    errors,
  );
  if (positiveNames.size !== evidence.fixtures.positive.length) {
    errors.push("positive fixture names must be unique");
  }
  if (negativeNames.size !== evidence.fixtures.negative.length) {
    errors.push("negative fixture names must be unique");
  }
  for (const fixture of evidence.fixtures.negative) {
    if (!/^[a-z][a-z0-9._-]{2,127}$/u.test(fixture.expectedErrorCode)) {
      errors.push(`negative fixture ${fixture.name} lacks a stable error code`);
    }
  }
  rejectForbiddenEvidenceKeys(evidence as unknown as JsonValue, "$", errors);
  verifyProof(
    "host",
    evidence.conformance.host,
    evidence.identity,
    positiveNames,
    negativeNames,
    errors,
  );
  verifyProof(
    "provider",
    evidence.conformance.provider,
    evidence.identity,
    positiveNames,
    negativeNames,
    errors,
  );

  return { admitted: errors.length === 0, errors };
}

function verifyProof(
  label: string,
  proof: StandardFormConformanceProof,
  identity: InstalledFormReference,
  positive: ReadonlySet<string>,
  negative: ReadonlySet<string>,
  errors: string[],
): void {
  if (
    proof.status !== "passed" ||
    !isInstalledFormReference(proof.identity) ||
    installedFormReferenceKey(proof.identity) !==
      installedFormReferenceKey(identity) ||
    proof.subject.trim() === "" ||
    proof.runnerVersion.trim() === "" ||
    !isSha256Digest(proof.evidenceDigest)
  ) {
    errors.push(`${label} conformance proof is invalid or identity-mismatched`);
  }
  if (!sameStringSet(proof.positiveFixtures, [...positive])) {
    errors.push(`${label} conformance proof lacks exact positive coverage`);
  }
  if (!sameStringSet(proof.negativeFixtures, [...negative])) {
    errors.push(`${label} conformance proof lacks exact negative coverage`);
  }
}

function fixtureNames(
  fixtures: readonly { readonly name: string }[],
  label: string,
  errors: string[],
): Set<string> {
  const names = new Set<string>();
  for (const fixture of fixtures) {
    if (!/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(fixture.name)) {
      errors.push(`${label} fixture name is not canonical: ${fixture.name}`);
    }
    names.add(fixture.name);
  }
  return names;
}

function takoformStatus(definition: FormDefinition): string | undefined {
  const takoform = definition.metadata?.takoform;
  return isRecord(takoform) && typeof takoform.status === "string"
    ? takoform.status
    : undefined;
}

function takoformImmutableFields(
  definition: FormDefinition,
): readonly string[] {
  const takoform = definition.metadata?.takoform;
  if (!isRecord(takoform) || !Array.isArray(takoform.immutableFields))
    return [];
  return takoform.immutableFields.filter(
    (value): value is string => typeof value === "string",
  );
}

function sameStringSet(
  left: readonly string[],
  right: readonly string[],
): boolean {
  const a = [...new Set(left)].sort();
  const b = [...new Set(right)].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function rejectForbiddenEvidenceKeys(
  value: JsonValue,
  path: string,
  errors: string[],
): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      rejectForbiddenEvidenceKeys(entry, `${path}[${index}]`, errors),
    );
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    const structuralProviderProof =
      path === "$.conformance" && key === "provider";
    if (
      !structuralProviderProof &&
      FORBIDDEN_EVIDENCE_KEYS.has(key.toLowerCase())
    ) {
      errors.push(`forbidden standard-admission field ${key} at ${path}`);
    }
    rejectForbiddenEvidenceKeys(child as JsonValue, `${path}.${key}`, errors);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
