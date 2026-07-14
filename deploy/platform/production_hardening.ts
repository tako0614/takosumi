import {
  isPlatformHardeningContribution,
  TAKOSUMI_PLATFORM_HARDENING_CONTRIBUTION_KIND,
  TAKOSUMI_PLATFORM_HARDENING_GATE_EVIDENCE_KIND,
  type PlatformHardeningContribution,
  type PlatformHardeningGateEvidence,
  type PlatformHardeningGateEvidenceCheck,
} from "../../contract/platform-hardening.ts";

export const TAKOSUMI_PRODUCTION_HARDENING_GATE_RESULT_KIND =
  "takosumi.production-hardening-gate-result@v1" as const;

const HARDENING_GATE_REF_PREFIX = "git+";
const HARDENING_GATE_COMMIT_PIN_PATTERN = /@[0-9a-f]{40,64}#/i;
const HARDENING_GATE_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

const OSS_PLATFORM_HARDENING_CONTRIBUTION_VALUE = {
  kind: TAKOSUMI_PLATFORM_HARDENING_CONTRIBUTION_KIND,
  id: "takosumi-oss",
  capability: "platform.hardening.oss-baseline.v1",
  checks: [
    {
      id: "runner-execution-smoke",
      title: "Runner execution smoke",
      description:
        "A configured runner executes a provider-backed Run and records StateVersion and Output evidence.",
      evidenceSchema: {
        required: [
          "runnerProfileId",
          "runnerBoundary",
          "healthStatus",
          "provider",
          "runId",
          "runStatus",
          "stateVersionId",
          "outputId",
        ],
        properties: {
          runnerProfileId: { type: "string" },
          runnerBoundary: { type: "string" },
          healthStatus: { type: "string", const: "healthy" },
          provider: { type: "string" },
          runId: { type: "string" },
          runStatus: { type: "string", const: "succeeded" },
          stateVersionId: { type: "string" },
          outputId: { type: "string" },
        },
      },
    },
    {
      id: "capsule-lifecycle-smoke",
      title: "Capsule lifecycle smoke",
      description:
        "The platform creates a scratch Capsule from an explicit Source, plans, applies, verifies, and destroys it through the public control-plane flow.",
      evidenceSchema: {
        required: [
          "serviceUrl",
          "scratchWorkspaceId",
          "capsuleSource",
          "credentialPath",
          "steps",
          "capsuleGateStatus",
          "policyStatus",
        ],
        properties: {
          serviceUrl: {
            type: "string",
            pattern: "^(?:https://|http://localhost(?::[0-9]+)?(?:/|$))",
            example: "https://operator.example",
          },
          scratchWorkspaceId: { type: "string" },
          capsuleSource: { type: "string" },
          credentialPath: { type: "string", const: "provider_connection" },
          steps: {
            type: "string-array",
            contains: [
              "providerConnection",
              "source",
              "capsule",
              "plan",
              "apply",
              "runtimeVerified",
              "outputRecorded",
              "destroy",
              "connectionRevoked",
            ],
          },
          capsuleGateStatus: { type: "string", const: "passed" },
          policyStatus: { type: "string", const: "passed" },
        },
      },
    },
    {
      id: "egress-enforcement",
      title: "Runner egress enforcement",
      description:
        "The selected runner boundary allows an explicitly required endpoint and denies a prohibited endpoint.",
      evidenceSchema: {
        required: [
          "runnerProfileId",
          "runnerBoundary",
          "networkPolicyConfigured",
          "allowedHost",
          "allowResult",
          "deniedHost",
          "denyResult",
          "denyStatusCode",
        ],
        properties: {
          runnerProfileId: { type: "string" },
          runnerBoundary: { type: "string" },
          networkPolicyConfigured: { type: "boolean", const: true },
          allowedHost: { type: "string" },
          allowResult: { type: "string", const: "allowed" },
          deniedHost: { type: "string" },
          denyResult: { type: "string", const: "denied" },
          denyStatusCode: { type: "number", minimum: 400 },
        },
      },
    },
    {
      id: "restore-rehearsal",
      title: "Restore rehearsal",
      description:
        "An operator-owned backup is validated or restored and the control ledger, StateVersions, Outputs, and audit chain are checked.",
      evidenceSchema: {
        required: [
          "target",
          "backupId",
          "restoreMode",
          "scopesVerified",
          "auditChainVerified",
          "rtoMinutes",
          "rpoMinutes",
        ],
        properties: {
          target: {
            type: "string",
            enum: ["staging", "isolated_recovery", "production_smoke"],
          },
          backupId: { type: "string" },
          restoreMode: {
            type: "string",
            enum: ["validate_only", "isolated_restore", "live_smoke_restore"],
          },
          scopesVerified: {
            type: "string-array",
            contains: [
              "controlLedger",
              "stateVersions",
              "outputs",
              "auditChain",
            ],
          },
          auditChainVerified: { type: "boolean", const: true },
          rtoMinutes: { type: "number", minimum: 0 },
          rpoMinutes: { type: "number", minimum: 0 },
        },
      },
    },
    {
      id: "credential-recipe-boundary",
      title: "Credential Recipe boundary",
      description:
        "Operator-installed recipes and an arbitrary declared-env recipe use Provider Connections without becoming provider execution admission.",
      evidenceSchema: {
        required: [
          "installedRecipeIds",
          "declaredEnvRecipeId",
          "declaredEnvRecipeVerified",
          "unregisteredProviderExecutionVerified",
          "recipePresenceUsedAsAdmission",
          "secretValuesReturned",
        ],
        properties: {
          installedRecipeIds: { type: "string-array" },
          declaredEnvRecipeId: { type: "string" },
          declaredEnvRecipeVerified: { type: "boolean", const: true },
          unregisteredProviderExecutionVerified: {
            type: "boolean",
            const: true,
          },
          recipePresenceUsedAsAdmission: { type: "boolean", const: false },
          secretValuesReturned: { type: "boolean", const: false },
        },
      },
    },
    {
      id: "secret-boundary",
      title: "Secret boundary",
      description:
        "Private credentials and control tokens remain absent from diagnostics, API, Run, usage, and hardening-gate payloads.",
      evidenceSchema: {
        required: [
          "forbiddenSecretClasses",
          "leakTargetsChecked",
          "diagnosticsRedacted",
          "apiPayloadsRedacted",
          "runPayloadsRedacted",
          "usagePayloadsRedacted",
          "hardeningGatePayloadsRedacted",
        ],
        properties: {
          forbiddenSecretClasses: {
            type: "string-array",
            contains: [
              "providerCredentials",
              "deployControlTokens",
              "stateBackendCredentials",
            ],
          },
          leakTargetsChecked: {
            type: "string-array",
            contains: [
              "runnerDiagnostics",
              "apiPayloads",
              "runPayloads",
              "usagePayloads",
              "hardeningGatePayloads",
            ],
          },
          diagnosticsRedacted: { type: "boolean", const: true },
          apiPayloadsRedacted: { type: "boolean", const: true },
          runPayloadsRedacted: { type: "boolean", const: true },
          usagePayloadsRedacted: { type: "boolean", const: true },
          hardeningGatePayloadsRedacted: { type: "boolean", const: true },
        },
      },
    },
  ],
} as const satisfies PlatformHardeningContribution;

if (
  !isPlatformHardeningContribution(OSS_PLATFORM_HARDENING_CONTRIBUTION_VALUE)
) {
  throw new TypeError("OSS platform hardening contribution is invalid");
}

export const OSS_PLATFORM_HARDENING_CONTRIBUTION: PlatformHardeningContribution =
  OSS_PLATFORM_HARDENING_CONTRIBUTION_VALUE;

export interface ProductionHardeningGateEnv {
  readonly TAKOSUMI_PRODUCTION_HARDENING_GATE?: unknown;
  readonly TAKOSUMI_PLATFORM_HARDENING_CONTRIBUTIONS?: unknown;
  readonly TAKOSUMI_PLATFORM_HARDENING_EVIDENCE?: unknown;
}

export interface ProductionHardeningCheck {
  readonly id: string;
  readonly ok: boolean;
  readonly evidenceRef?: string;
  readonly evidenceDigest?: string;
  readonly reason?: string;
}

export interface ProductionHardeningContributionResult {
  readonly id: string;
  readonly capability: string;
  readonly checks: readonly ProductionHardeningCheck[];
}

export interface ProductionHardeningGateResult {
  readonly kind: typeof TAKOSUMI_PRODUCTION_HARDENING_GATE_RESULT_KIND;
  readonly ok: boolean;
  readonly enforced: boolean;
  readonly configurationErrors: readonly string[];
  readonly contributions: readonly ProductionHardeningContributionResult[];
}

export function platformHardeningContributions(
  additional: unknown,
): readonly PlatformHardeningContribution[] {
  const contributions: PlatformHardeningContribution[] = [
    OSS_PLATFORM_HARDENING_CONTRIBUTION,
  ];
  if (additional !== undefined) {
    if (!Array.isArray(additional)) {
      throw new TypeError(
        "TAKOSUMI_PLATFORM_HARDENING_CONTRIBUTIONS must be a runtime contribution array",
      );
    }
    for (const contribution of additional) {
      if (!isPlatformHardeningContribution(contribution)) {
        throw new TypeError("platform hardening contribution is invalid");
      }
      contributions.push(contribution);
    }
  }
  const ids = contributions.map(({ id }) => id);
  if (new Set(ids).size !== ids.length) {
    throw new TypeError("platform hardening contribution ids must be unique");
  }
  return contributions;
}

export function evaluateProductionHardeningGates(
  env: ProductionHardeningGateEnv,
): ProductionHardeningGateResult {
  const enforced = env.TAKOSUMI_PRODUCTION_HARDENING_GATE === "enforce";
  const contributions = platformHardeningContributions(
    env.TAKOSUMI_PLATFORM_HARDENING_CONTRIBUTIONS,
  );
  const parsedEvidence = readGateEvidence(
    env.TAKOSUMI_PLATFORM_HARDENING_EVIDENCE,
  );
  const configurationErrors = parsedEvidence.errors.length
    ? [...parsedEvidence.errors]
    : registryDriftErrors(contributions, parsedEvidence.evidence);

  const results = contributions.map((contribution) => {
    const evidenceContribution = parsedEvidence.evidence?.contributions.find(
      ({ id }) => id === contribution.id,
    );
    return {
      id: contribution.id,
      capability: contribution.capability,
      checks: contribution.checks.map((definition) => {
        const evidence = evidenceContribution?.checks.find(
          ({ id }) => id === definition.id,
        );
        return evidenceCheck(definition.id, evidence);
      }),
    } satisfies ProductionHardeningContributionResult;
  });
  return {
    kind: TAKOSUMI_PRODUCTION_HARDENING_GATE_RESULT_KIND,
    ok:
      configurationErrors.length === 0 &&
      results.every((contribution) =>
        contribution.checks.every((check) => check.ok),
      ),
    enforced,
    configurationErrors,
    contributions: results,
  };
}

function readGateEvidence(value: unknown): {
  readonly evidence?: PlatformHardeningGateEvidence;
  readonly errors: readonly string[];
} {
  if (value === undefined || value === null || value === "") {
    return { errors: [] };
  }
  let parsed: unknown = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed) as unknown;
    } catch {
      return {
        errors: ["TAKOSUMI_PLATFORM_HARDENING_EVIDENCE must be valid JSON"],
      };
    }
  }
  if (!isRecord(parsed)) {
    return {
      errors: ["TAKOSUMI_PLATFORM_HARDENING_EVIDENCE must be an object"],
    };
  }
  if (parsed.kind !== TAKOSUMI_PLATFORM_HARDENING_GATE_EVIDENCE_KIND) {
    return {
      errors: [
        `TAKOSUMI_PLATFORM_HARDENING_EVIDENCE.kind must be ${TAKOSUMI_PLATFORM_HARDENING_GATE_EVIDENCE_KIND}`,
      ],
    };
  }
  if (!Array.isArray(parsed.contributions)) {
    return {
      errors: [
        "TAKOSUMI_PLATFORM_HARDENING_EVIDENCE.contributions must be an array",
      ],
    };
  }
  const contributions: PlatformHardeningGateEvidence["contributions"][number][] =
    [];
  for (const [index, item] of parsed.contributions.entries()) {
    if (!isRecord(item) || !nonEmptyString(item.id)) {
      return {
        errors: [`hardening evidence contribution ${index} is invalid`],
      };
    }
    if (!nonEmptyString(item.capability) || !Array.isArray(item.checks)) {
      return {
        errors: [`hardening evidence contribution ${item.id} is invalid`],
      };
    }
    const checks: PlatformHardeningGateEvidenceCheck[] = [];
    for (const [checkIndex, check] of item.checks.entries()) {
      if (!isRecord(check) || !nonEmptyString(check.id)) {
        return {
          errors: [
            `hardening evidence contribution ${item.id} check ${checkIndex} is invalid`,
          ],
        };
      }
      checks.push({
        id: check.id,
        evidenceRef:
          typeof check.evidenceRef === "string" ? check.evidenceRef : "",
        evidenceDigest:
          typeof check.evidenceDigest === "string" ? check.evidenceDigest : "",
      });
    }
    contributions.push({ id: item.id, capability: item.capability, checks });
  }
  return {
    evidence: {
      kind: TAKOSUMI_PLATFORM_HARDENING_GATE_EVIDENCE_KIND,
      contributions,
    },
    errors: [],
  };
}

function registryDriftErrors(
  registry: readonly PlatformHardeningContribution[],
  evidence: PlatformHardeningGateEvidence | undefined,
): readonly string[] {
  if (!evidence) return [];
  const errors: string[] = [];
  if (
    new Set(evidence.contributions.map(({ id }) => id)).size !==
    evidence.contributions.length
  ) {
    errors.push("hardening evidence has duplicate contribution ids");
  }
  const registryIds = new Set(registry.map(({ id }) => id));
  for (const item of evidence.contributions) {
    const definition = registry.find(({ id }) => id === item.id);
    if (!definition) {
      errors.push(`hardening evidence has unknown contribution ${item.id}`);
      continue;
    }
    if (item.capability !== definition.capability) {
      errors.push(
        `hardening evidence contribution ${item.id} capability drifted`,
      );
    }
    const definitionCheckIds = new Set(definition.checks.map(({ id }) => id));
    for (const check of item.checks) {
      if (!definitionCheckIds.has(check.id)) {
        errors.push(
          `hardening evidence contribution ${item.id} has unknown check ${check.id}`,
        );
      }
    }
    if (new Set(item.checks.map(({ id }) => id)).size !== item.checks.length) {
      errors.push(
        `hardening evidence contribution ${item.id} has duplicate checks`,
      );
    }
  }
  for (const definition of registry) {
    if (!evidence.contributions.some(({ id }) => id === definition.id)) {
      errors.push(
        `hardening evidence is missing contribution ${definition.id}`,
      );
    }
  }
  if (registryIds.size !== registry.length) {
    errors.push("hardening contribution registry has duplicate ids");
  }
  return errors;
}

function evidenceCheck(
  id: string,
  evidence: PlatformHardeningGateEvidenceCheck | undefined,
): ProductionHardeningCheck {
  if (!evidence) return { id, ok: false, reason: "missing_evidence" };
  const evidenceRef = evidence.evidenceRef.trim();
  const evidenceDigest = evidence.evidenceDigest.trim();
  if (!evidenceRef) return { id, ok: false, reason: "missing_evidence_ref" };
  if (!evidenceRef.startsWith(HARDENING_GATE_REF_PREFIX)) {
    return {
      id,
      ok: false,
      evidenceRef,
      reason: "evidence_ref_must_be_git_ref",
    };
  }
  if (!HARDENING_GATE_COMMIT_PIN_PATTERN.test(evidenceRef)) {
    return {
      id,
      ok: false,
      evidenceRef,
      reason: "evidence_ref_must_be_commit_pinned",
    };
  }
  if (!evidenceDigest) {
    return { id, ok: false, evidenceRef, reason: "missing_evidence_digest" };
  }
  if (!HARDENING_GATE_DIGEST_PATTERN.test(evidenceDigest)) {
    return {
      id,
      ok: false,
      evidenceRef,
      evidenceDigest,
      reason: "evidence_digest_must_be_sha256",
    };
  }
  return { id, ok: true, evidenceRef, evidenceDigest };
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
