import type {
  BundledRegistry,
  ConformanceTier,
  PackageDescriptor,
  PackageKind,
  PackageResolution,
  ProviderSupportReport,
  TrustRecord,
} from "../../domains/registry/mod.ts";

export type ConformanceIssueSeverity = "info" | "warning" | "blocked";
export type AcceptanceSeverity = "evidence" | "advisory" | "blocker";
export type ConformancePackageFamily =
  | "provider"
  | "resource"
  | "data"
  | "output";

export interface PackageConformanceIssue {
  readonly code: string;
  readonly severity: ConformanceIssueSeverity;
  readonly acceptanceSeverity: AcceptanceSeverity;
  readonly message: string;
  readonly packageRef?: string;
}

export interface PackageConformanceCheck {
  readonly name: string;
  readonly passed: boolean;
  readonly severity: ConformanceIssueSeverity;
  readonly message: string;
}

export interface PackageConformanceResult {
  readonly accepted: boolean;
  readonly packageRef: string;
  readonly packageKind: PackageKind;
  readonly family?: ConformancePackageFamily;
  readonly conformanceTier: ConformanceTier;
  readonly trustStatus: "trusted" | "untrusted" | "revoked" | "missing";
  readonly checks: readonly PackageConformanceCheck[];
  readonly issues: readonly PackageConformanceIssue[];
}

export interface ProviderConformanceRequirements {
  readonly resourceContracts?: readonly string[];
  readonly interfaceContracts?: readonly string[];
  readonly routeProtocols?: readonly string[];
  readonly dataContracts?: readonly string[];
  readonly outputContracts?: readonly string[];
  readonly capabilityProfiles?: readonly string[];
  readonly minimumTier?: ConformanceTier;
}

export interface ValidateResolvedPackageInput {
  readonly resolution: PackageResolution;
  readonly descriptor?: PackageDescriptor;
  readonly trustRecord?: TrustRecord;
  readonly minimumTier?: ConformanceTier;
}

export interface ValidateProviderSupportInput {
  readonly descriptor: PackageDescriptor;
  readonly resolution: PackageResolution;
  readonly trustRecord?: TrustRecord;
  readonly supportReport?: ProviderSupportReport;
  readonly requirements?: ProviderConformanceRequirements;
}

export interface AssessProviderInput {
  readonly providerRef: string;
  readonly requirements?: ProviderConformanceRequirements;
}

export interface PackageConformanceServiceOptions {
  readonly registry?: BundledRegistry;
}

const TIER_RANK: Record<ConformanceTier, number> = {
  unknown: 0,
  declared: 1,
  tested: 2,
  certified: 3,
};

const PACKAGE_FAMILY: Partial<Record<PackageKind, ConformancePackageFamily>> = {
  "provider-package": "provider",
  "resource-contract-package": "resource",
  "data-contract-package": "data",
  "output-contract-package": "output",
};

const PACKAGE_TYPE_BY_KIND: Partial<Record<PackageKind, string>> = {
  "provider-package": "provider",
  "resource-contract-package": "resource-contract",
  "data-contract-package": "data-contract",
  "output-contract-package": "output-contract",
};

export class PackageConformanceService {
  readonly #registry?: BundledRegistry;

  constructor(options: PackageConformanceServiceOptions = {}) {
    this.#registry = options.registry;
  }

  async assessProvider(
    input: AssessProviderInput,
  ): Promise<PackageConformanceResult> {
    if (!this.#registry) {
      throw new TypeError("registry is required to assess provider packages");
    }

    const resolution = await this.#registry.resolve(
      "provider-package",
      input.providerRef,
    );
    if (!resolution) {
      return blockedResult(
        input.providerRef,
        "provider-package",
        "package-resolution-missing",
        `Provider package ${input.providerRef} could not be resolved`,
      );
    }

    const descriptor = await this.#registry.getDescriptor(
      resolution.kind,
      resolution.ref,
      resolution.digest,
    );
    const trustRecord = resolution.trustRecordId
      ? await this.#registry.getTrustRecord(resolution.trustRecordId)
      : undefined;
    const supportReport = (await this.#registry.listProviderSupport()).find((
      report,
    ) =>
      report.providerPackageRef === resolution.ref &&
      report.providerPackageDigest === resolution.digest
    );

    if (!descriptor) {
      return this.validateResolvedPackage({
        resolution,
        descriptor,
        trustRecord,
        minimumTier: input.requirements?.minimumTier,
      });
    }

    return this.validateProviderSupport({
      descriptor,
      resolution,
      trustRecord,
      supportReport,
      requirements: input.requirements,
    });
  }

  validateResolvedPackage(
    input: ValidateResolvedPackageInput,
  ): PackageConformanceResult {
    const checks: PackageConformanceCheck[] = [];
    const issues: PackageConformanceIssue[] = [];
    const minimumTier = input.minimumTier ?? "declared";

    if (!input.descriptor) {
      addIssue(
        issues,
        "package-descriptor-missing",
        "blocked",
        `Descriptor is missing for ${input.resolution.kind}:${input.resolution.ref}@${input.resolution.digest}`,
        input.resolution.ref,
      );
    } else {
      this.#validateDescriptor(input.descriptor, checks, issues);
      if (input.descriptor.digest !== input.resolution.digest) {
        addIssue(
          issues,
          "descriptor-digest-mismatch",
          "blocked",
          "Descriptor digest does not match the resolved package digest",
          input.resolution.ref,
        );
      }
    }

    const trust = validateTrustRecord({
      resolution: input.resolution,
      trustRecord: input.trustRecord,
      minimumTier,
      packageRef: input.resolution.ref,
    });
    checks.push(...trust.checks);
    issues.push(...trust.issues);

    return freezeResult({
      accepted: !hasBlockedIssue(issues),
      packageRef: input.resolution.ref,
      packageKind: input.resolution.kind,
      family: PACKAGE_FAMILY[input.resolution.kind],
      conformanceTier: input.trustRecord?.conformanceTier ?? "unknown",
      trustStatus: trust.trustStatus,
      checks,
      issues,
    });
  }

  validateProviderSupport(
    input: ValidateProviderSupportInput,
  ): PackageConformanceResult {
    const base = this.validateResolvedPackage({
      resolution: input.resolution,
      descriptor: input.descriptor,
      trustRecord: input.trustRecord,
      minimumTier: input.requirements?.minimumTier,
    });
    const checks = [...base.checks];
    const issues = [...base.issues];
    const requirements = input.requirements ?? {};

    if (input.descriptor.kind !== "provider-package") {
      addIssue(
        issues,
        "provider-kind-mismatch",
        "blocked",
        "Provider support validation requires a provider-package descriptor",
        input.descriptor.ref,
      );
    }

    const declaredSupport = supportFromDescriptor(input.descriptor);
    if (!input.supportReport) {
      addIssue(
        issues,
        "capability-support-report-missing",
        "blocked",
        `Provider ${input.resolution.ref} does not have a capability support report`,
        input.resolution.ref,
      );
    } else {
      validateSupportReportCompatibility(
        input.supportReport,
        input.resolution,
        declaredSupport,
        requirements,
        checks,
        issues,
      );
    }

    validateRequiredFeatures(
      declaredSupport,
      input.supportReport,
      requirements,
      issues,
      input.resolution.ref,
    );

    return freezeResult({
      ...base,
      accepted: !hasBlockedIssue(issues),
      checks,
      issues,
    });
  }

  #validateDescriptor(
    descriptor: PackageDescriptor,
    checks: PackageConformanceCheck[],
    issues: PackageConformanceIssue[],
  ): void {
    const expectedType = PACKAGE_TYPE_BY_KIND[descriptor.kind];
    const body = descriptor.body as Record<string, unknown>;

    recordCheck(
      checks,
      issues,
      "descriptor.schemaVersion",
      body.schemaVersion === "takos.registry.package/v1",
      "blocked",
      "Descriptor declares takos.registry.package/v1 schema",
      "descriptor-schema-invalid",
      descriptor.ref,
    );
    recordCheck(
      checks,
      issues,
      "descriptor.packageType",
      typeof expectedType === "string" && body.packageType === expectedType,
      "blocked",
      `Descriptor packageType matches ${descriptor.kind}`,
      "descriptor-package-type-invalid",
      descriptor.ref,
    );
    recordCheck(
      checks,
      issues,
      "descriptor.identity",
      typeof body.id === "string" && typeof body.apiVersion === "string",
      "blocked",
      "Descriptor declares id and apiVersion",
      "descriptor-identity-missing",
      descriptor.ref,
    );

    switch (descriptor.kind) {
      case "provider-package":
        recordCheck(
          checks,
          issues,
          "provider.runtime",
          typeof body.runtime === "string" && body.runtime.length > 0,
          "blocked",
          "Provider declares a runtime adapter",
          "provider-runtime-missing",
          descriptor.ref,
        );
        recordCheck(
          checks,
          issues,
          "provider.supports",
          isObject(body.supports),
          "blocked",
          "Provider declares supported contract families",
          "provider-supports-missing",
          descriptor.ref,
        );
        break;
      case "resource-contract-package":
        recordCheck(
          checks,
          issues,
          "resource.capabilities",
          nonEmptyStringArray(body.capabilities),
          "blocked",
          "Resource contract declares capabilities",
          "resource-capabilities-missing",
          descriptor.ref,
        );
        recordCheck(
          checks,
          issues,
          "resource.resources",
          Array.isArray(body.resources) && body.resources.length > 0,
          "blocked",
          "Resource contract declares resource kinds",
          "resource-kinds-missing",
          descriptor.ref,
        );
        break;
      case "data-contract-package":
        recordCheck(
          checks,
          issues,
          "data.mediaTypes",
          nonEmptyStringArray(body.mediaTypes),
          "blocked",
          "Data contract declares media types",
          "data-media-types-missing",
          descriptor.ref,
        );
        recordCheck(
          checks,
          issues,
          "data.schemaKinds",
          nonEmptyStringArray(body.schemaKinds),
          "blocked",
          "Data contract declares schema kinds",
          "data-schema-kinds-missing",
          descriptor.ref,
        );
        break;
      case "output-contract-package":
        recordCheck(
          checks,
          issues,
          "output.kinds",
          nonEmptyStringArray(body.outputKinds),
          "blocked",
          "Output contract declares output kinds",
          "output-kinds-missing",
          descriptor.ref,
        );
        recordCheck(
          checks,
          issues,
          "output.protocols",
          nonEmptyStringArray(body.protocols),
          "blocked",
          "Output contract declares protocols",
          "output-protocols-missing",
          descriptor.ref,
        );
        break;
      default:
        addIssue(
          issues,
          "package-kind-unsupported",
          "warning",
          `Package kind ${descriptor.kind} does not have conformance checks yet`,
          descriptor.ref,
        );
    }
  }
}

export function mapIssueSeverityToAcceptance(
  severity: ConformanceIssueSeverity,
): AcceptanceSeverity {
  switch (severity) {
    case "blocked":
      return "blocker";
    case "warning":
      return "advisory";
    case "info":
      return "evidence";
  }
}

function validateTrustRecord(input: {
  readonly resolution: PackageResolution;
  readonly trustRecord?: TrustRecord;
  readonly minimumTier: ConformanceTier;
  readonly packageRef: string;
}): {
  readonly checks: readonly PackageConformanceCheck[];
  readonly issues: readonly PackageConformanceIssue[];
  readonly trustStatus: PackageConformanceResult["trustStatus"];
} {
  const checks: PackageConformanceCheck[] = [];
  const issues: PackageConformanceIssue[] = [];
  const record = input.trustRecord;

  if (!record) {
    addIssue(
      issues,
      "trust-record-missing",
      "blocked",
      `Trust record is missing for ${input.resolution.kind}:${input.resolution.ref}`,
      input.packageRef,
    );
    return { checks, issues, trustStatus: "missing" };
  }

  recordCheck(
    checks,
    issues,
    "trust.compatible-package",
    record.packageKind === input.resolution.kind &&
      record.packageRef === input.resolution.ref &&
      record.packageDigest === input.resolution.digest,
    "blocked",
    "Trust record matches resolved package kind, ref, and digest",
    "trust-record-incompatible",
    input.packageRef,
  );

  if (record.status === "revoked") {
    addIssue(
      issues,
      "trust-record-revoked",
      "blocked",
      record.reason
        ? `Trust record has been revoked: ${record.reason}`
        : "Trust record has been revoked",
      input.packageRef,
    );
  } else if (record.status !== "active") {
    addIssue(
      issues,
      "trust-record-not-active",
      "blocked",
      `Trust record is ${record.status}`,
      input.packageRef,
    );
  }

  if (record.trustLevel === "untrusted") {
    addIssue(
      issues,
      "trust-level-untrusted",
      "blocked",
      "Trust record marks the package as untrusted",
      input.packageRef,
    );
  }

  recordCheck(
    checks,
    issues,
    "trust.minimum-tier",
    tierAtLeast(record.conformanceTier, input.minimumTier),
    "blocked",
    `Trust record satisfies minimum conformance tier ${input.minimumTier}`,
    "conformance-tier-too-low",
    input.packageRef,
  );

  return {
    checks,
    issues,
    trustStatus: record.status === "revoked"
      ? "revoked"
      : record.status === "active" && record.trustLevel !== "untrusted"
      ? "trusted"
      : "untrusted",
  };
}

function validateSupportReportCompatibility(
  report: ProviderSupportReport,
  resolution: PackageResolution,
  declaredSupport: ProviderFeatureSets,
  requirements: ProviderConformanceRequirements,
  checks: PackageConformanceCheck[],
  issues: PackageConformanceIssue[],
): void {
  recordCheck(
    checks,
    issues,
    "support-report.provider",
    report.providerPackageRef === resolution.ref &&
      report.providerPackageDigest === resolution.digest,
    "blocked",
    "Capability support report matches provider package ref and digest",
    "capability-support-report-incompatible",
    resolution.ref,
  );

  const minimumTier = requirements.minimumTier ?? "declared";
  recordCheck(
    checks,
    issues,
    "support-report.minimum-tier",
    tierAtLeast(report.conformanceTier, minimumTier),
    "blocked",
    `Capability support report satisfies minimum conformance tier ${minimumTier}`,
    "support-report-tier-too-low",
    resolution.ref,
  );

  validateNoUndeclared(
    report.resourceContracts,
    declaredSupport.resourceContracts,
    "resource contract",
    resolution.ref,
    issues,
  );
  validateNoUndeclared(
    report.interfaceContracts ?? [],
    declaredSupport.interfaceContracts,
    "interface contract",
    resolution.ref,
    issues,
  );
  validateNoUndeclared(
    report.routeProtocols ?? [],
    declaredSupport.routeProtocols,
    "route protocol",
    resolution.ref,
    issues,
  );
  validateNoUndeclared(
    report.capabilityProfiles,
    declaredSupport.capabilityProfiles,
    "capability profile",
    resolution.ref,
    issues,
  );
}

function validateRequiredFeatures(
  declaredSupport: ProviderFeatureSets,
  report: ProviderSupportReport | undefined,
  requirements: ProviderConformanceRequirements,
  issues: PackageConformanceIssue[],
  providerRef: string,
): void {
  const reportedResources = new Set(report?.resourceContracts ?? []);
  const reportedInterfaces = new Set(report?.interfaceContracts ?? []);
  const reportedProtocols = new Set(report?.routeProtocols ?? []);
  const reportedProfiles = new Set(report?.capabilityProfiles ?? []);
  const declaredResources = new Set(declaredSupport.resourceContracts);
  const declaredInterfaces = new Set(declaredSupport.interfaceContracts);
  const declaredProtocols = new Set(declaredSupport.routeProtocols);
  const declaredData = new Set(declaredSupport.dataContracts);
  const declaredOutputs = new Set(declaredSupport.outputContracts);
  const declaredProfiles = new Set(declaredSupport.capabilityProfiles);

  requireAll(
    requirements.resourceContracts,
    declaredResources,
    reportedResources,
    "resource contract",
    providerRef,
    issues,
  );
  requireAll(
    requirements.interfaceContracts,
    declaredInterfaces,
    reportedInterfaces,
    "interface contract",
    providerRef,
    issues,
  );
  requireAll(
    requirements.routeProtocols,
    declaredProtocols,
    reportedProtocols,
    "route protocol",
    providerRef,
    issues,
  );
  requireAll(
    requirements.dataContracts,
    declaredData,
    reportedProfiles,
    "data contract",
    providerRef,
    issues,
  );
  requireAll(
    requirements.outputContracts,
    declaredOutputs,
    reportedProfiles,
    "output contract",
    providerRef,
    issues,
  );
  requireAll(
    requirements.capabilityProfiles,
    declaredProfiles,
    reportedProfiles,
    "capability profile",
    providerRef,
    issues,
  );
}

function requireAll(
  required: readonly string[] | undefined,
  declared: ReadonlySet<string>,
  reported: ReadonlySet<string>,
  featureLabel: string,
  packageRef: string,
  issues: PackageConformanceIssue[],
): void {
  for (const feature of required ?? []) {
    if (!declared.has(feature) || !reported.has(feature)) {
      addIssue(
        issues,
        "required-feature-missing",
        "blocked",
        `Required ${featureLabel} ${feature} is not declared and reported as supported`,
        packageRef,
      );
    }
  }
}

function validateNoUndeclared(
  reported: readonly string[],
  declared: readonly string[],
  label: string,
  packageRef: string,
  issues: PackageConformanceIssue[],
): void {
  const declaredSet = new Set(declared);
  for (const feature of reported) {
    if (!declaredSet.has(feature)) {
      addIssue(
        issues,
        "support-report-undeclared-feature",
        "warning",
        `Capability support report lists undeclared ${label} ${feature}`,
        packageRef,
      );
    }
  }
}

interface ProviderFeatureSets {
  readonly resourceContracts: readonly string[];
  readonly interfaceContracts: readonly string[];
  readonly routeProtocols: readonly string[];
  readonly dataContracts: readonly string[];
  readonly outputContracts: readonly string[];
  readonly capabilityProfiles: readonly string[];
}

function supportFromDescriptor(
  descriptor: PackageDescriptor,
): ProviderFeatureSets {
  const supports = (descriptor.body as Record<string, unknown>).supports;
  const support = isObject(supports) ? supports : {};
  const dataContracts = stringArray(support.dataContracts);
  const outputContracts = stringArray(support.outputContracts);
  const interfaceContracts = interfaceContractsFromProviderDescriptor(
    descriptor.body,
    support,
  );
  const routeProtocols = routeProtocolsFromInterfaces(interfaceContracts);
  return {
    resourceContracts: stringArray(support.resourceContracts),
    interfaceContracts,
    routeProtocols,
    dataContracts,
    outputContracts,
    capabilityProfiles: [
      ...stringArray(support.capabilityProfiles),
      ...interfaceContracts,
      ...routeProtocols.map((protocol) => `route.${protocol}`),
      ...dataContracts,
      ...outputContracts,
    ],
  };
}

function interfaceContractsFromProviderDescriptor(
  body: unknown,
  support: Record<string, unknown>,
): readonly string[] {
  const explicit = stringArray(support.interfaceContracts);
  const materialized = isObject(body)
    ? materializationProfileInterfaces(body.materializationProfiles)
    : [];
  return uniqueStrings([...explicit, ...materialized]);
}

function materializationProfileInterfaces(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  const interfaces: string[] = [];
  for (const profile of value) {
    if (!isObject(profile)) continue;
    const contracts = profile.contracts;
    if (!isObject(contracts)) continue;
    interfaces.push(...stringArray(contracts.interfaces));
  }
  return interfaces;
}

function routeProtocolsFromInterfaces(
  interfaceContracts: readonly string[],
): readonly string[] {
  const protocols: string[] = [];
  for (const contract of interfaceContracts) {
    if (contract === "interface.http@v1") protocols.push("http");
    if (contract === "interface.tcp@v1") protocols.push("tcp");
    if (contract === "interface.udp@v1") protocols.push("udp");
    if (contract === "interface.queue@v1") protocols.push("queue");
  }
  return uniqueStrings(protocols);
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}

function recordCheck(
  checks: PackageConformanceCheck[],
  issues: PackageConformanceIssue[],
  name: string,
  passed: boolean,
  severity: ConformanceIssueSeverity,
  message: string,
  issueCode: string,
  packageRef: string,
): void {
  checks.push(Object.freeze({ name, passed, severity, message }));
  if (!passed) addIssue(issues, issueCode, severity, message, packageRef);
}

function addIssue(
  issues: PackageConformanceIssue[],
  code: string,
  severity: ConformanceIssueSeverity,
  message: string,
  packageRef?: string,
): void {
  issues.push(Object.freeze({
    code,
    severity,
    acceptanceSeverity: mapIssueSeverityToAcceptance(severity),
    message,
    packageRef,
  }));
}

function blockedResult(
  packageRef: string,
  packageKind: PackageKind,
  code: string,
  message: string,
): PackageConformanceResult {
  const issues: PackageConformanceIssue[] = [];
  addIssue(issues, code, "blocked", message, packageRef);
  return freezeResult({
    accepted: false,
    packageRef,
    packageKind,
    family: PACKAGE_FAMILY[packageKind],
    conformanceTier: "unknown",
    trustStatus: "missing",
    checks: [],
    issues,
  });
}

function freezeResult(
  result: PackageConformanceResult,
): PackageConformanceResult {
  return Object.freeze({
    ...result,
    checks: Object.freeze([...result.checks]),
    issues: Object.freeze([...result.issues]),
  });
}

function tierAtLeast(
  actual: ConformanceTier,
  minimum: ConformanceTier,
): boolean {
  return TIER_RANK[actual] >= TIER_RANK[minimum];
}

function hasBlockedIssue(issues: readonly PackageConformanceIssue[]): boolean {
  return issues.some((issue) => issue.severity === "blocked");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function nonEmptyStringArray(value: unknown): boolean {
  return stringArray(value).length > 0;
}
