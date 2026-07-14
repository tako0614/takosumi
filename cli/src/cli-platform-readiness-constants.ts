import type {
  PlatformReadinessConsistencyRule,
  PlatformReadinessEvidenceSchema,
} from "takosumi-contract";

export const platformReadinessKind = "takosumi.platform-readiness@v2";
export const platformReadinessReportKind =
  "takosumi.platform-readiness-report@v2";
export const platformReadinessPublicSummaryKind =
  "takosumi.platform-readiness-public-summary@v2";
export const platformReadinessPublicSummaryReportKind =
  "takosumi.platform-readiness-public-summary-report@v2";
export const platformReadinessProductionTopologyKind =
  "takosumi.production-topology@v1";
export const platformReadinessProductionTopologyReportKind =
  "takosumi.production-topology-preflight-report@v1";
export const platformReadinessProductionTopologyMergeReportKind =
  "takosumi.production-topology-merge-report@v1";
export const platformReadinessDomainIds = [
  "offering-definition",
  "production-topology",
  "oidc-account-security",
  "signup-tenant-lifecycle",
  "quota-abuse-control",
  "runner-pool-production-runtime",
  "runner-profile-migration",
  "export-self-host-sovereignty",
  "backup-dr",
  "observability-slo-on-call",
  "release-provenance",
  "security-operations",
  "legal-privacy",
] as const;
export const platformReadinessRehearsalStepIds = [
  "fresh-signup",
  "capsule-launch",
  "git-url-install",
  "quota-abuse-drill",
  "runner-pool-load",
  "runner-profile-migration",
  "export-self-host-migration",
  "backup-restore",
  "sev-simulation",
  "release-rollback",
  "privacy-operation",
] as const;
export const platformReadinessEvidenceEnvironments = [
  "staging",
  "production",
  "staging+production",
] as const;
export const platformReadinessRehearsalEnvironments = [
  "staging",
  "production",
] as const;

export const platformReadinessRequiredEvidenceTypes = {
  domains: {
    "offering-definition": ["launch-brief", "operator-signoff"],
    "production-topology": [
      "staging-manifest",
      "staging-artifact-digest",
      "staging-migration-transcript",
      "staging-health-probe",
      "staging-tls-evidence",
      "staging-rollback-target",
      "production-manifest",
      "production-artifact-digest",
      "production-migration-transcript",
      "production-health-probe",
      "production-tls-evidence",
      "production-rollback-target",
    ],
    "oidc-account-security": [
      "oidc-conformance",
      "key-rotation-drill",
      "client-secret-rotation",
      "rate-limit-test",
      "audit-event",
    ],
    "signup-tenant-lifecycle": [
      "fresh-user-smoke",
      "email-assurance",
      "team-membership",
      "capsule-created",
      "suspend-recover",
    ],
    "quota-abuse-control": [
      "quota-plan",
      "quota-spike-drill",
      "noisy-tenant-throttle",
      "run-kill-switch",
      "operator-override",
      "audit-event",
    ],
    "runner-pool-production-runtime": [
      "load-test",
      "isolation-test",
      "metric-labels",
      "scale-drain-event",
      "evacuation-record",
    ],
    "runner-profile-migration": [
      "runner-profile-migration-drill",
      "readiness-probe",
      "rollback-drill",
      "continuity-evidence",
    ],
    "export-self-host-sovereignty": [
      "encrypted-export",
      "self-host-migration",
      "sample-data-verification",
    ],
    "backup-dr": [
      "restore-transcript",
      "dr-simulation",
      "rpo-rto-sample",
      "audit-chain-verification",
      "restore-target-smoke",
    ],
    "observability-slo-on-call": [
      "dashboard-link",
      "alert-routing",
      "synthetic-probe",
      "sev-drill",
      "status-update",
    ],
    "release-provenance": [
      "ci-equivalent",
      "sbom",
      "signature",
      "image-digest",
      "package-version",
      "branch-protection-export",
      "artifact-policy",
      "rollback-drill",
    ],
    "security-operations": [
      "threat-model",
      "sandbox-review",
      "vulnerability-response-policy",
      "secret-inventory",
      "secret-rotation-run-log",
      "security-contact",
      "deploy-control-abuse-blocked",
    ],
    "legal-privacy": ["sar-delete-rehearsal"],
  },
  rehearsal: {
    "fresh-signup": ["signup-event", "email-assurance", "team-membership"],
    "capsule-launch": ["capsule-created", "capsule-session"],
    "git-url-install": [
      "capsule-plan-run",
      "cost-review",
      "capsule-apply",
      "oidc-login",
      "event-hash-chain",
    ],
    "quota-abuse-drill": ["quota-exceeded", "guard-action", "override-audit"],
    "runner-pool-load": [
      "two-tenant-load",
      "isolation-proof",
      "per-capsule-metrics",
      "scale-or-drain",
    ],
    "runner-profile-migration": [
      "readiness-before-cutover",
      "runner-profile-cutover",
      "rollback-before-final",
      "domain-preservation",
      "preserve-evidence",
    ],
    "export-self-host-migration": [
      "encrypted-export",
      "clean-migration",
      "post-migration-login",
      "sample-data-verification",
      "source-retention-state",
    ],
    "backup-restore": [
      "restore-transcript",
      "restore-target-smoke",
      "audit-chain-verification",
      "rpo-rto-sample",
    ],
    "sev-simulation": ["alert", "ack", "status-update", "postmortem"],
    "release-rollback": ["release-promotion", "rollback", "release-note"],
    "privacy-operation": [
      "export-or-delete-request",
      "login-disabled-or-exported",
      "retention-record",
    ],
  },
} as const;

/** Cross-reference equality rules for the built-in rehearsal evidence. */
export const platformReadinessConsistencyRules: {
  readonly domains: Readonly<
    Record<string, readonly PlatformReadinessConsistencyRule[]>
  >;
  readonly rehearsal: Readonly<
    Record<string, readonly PlatformReadinessConsistencyRule[]>
  >;
} = {
  domains: {},
  rehearsal: {
    "fresh-signup": [
      {
        field: "accountId",
        evidenceTypes: ["signup-event", "email-assurance", "team-membership"],
      },
      {
        field: "workspaceId",
        evidenceTypes: ["signup-event", "team-membership"],
      },
    ],
    "capsule-launch": [
      {
        field: "capsuleId",
        evidenceTypes: ["capsule-created", "capsule-session"],
      },
    ],
    "git-url-install": [
      {
        field: "planDigest",
        evidenceTypes: ["capsule-plan-run", "cost-review", "capsule-apply"],
      },
      {
        field: "capsuleId",
        evidenceTypes: [
          "capsule-plan-run",
          "capsule-apply",
          "oidc-login",
          "event-hash-chain",
        ],
      },
    ],
    "quota-abuse-drill": [
      {
        field: "accountId",
        evidenceTypes: ["quota-exceeded", "guard-action", "override-audit"],
      },
    ],
    "runner-pool-load": [
      {
        field: "loadRunId",
        evidenceTypes: ["two-tenant-load", "isolation-proof"],
      },
      {
        field: "runnerPoolId",
        evidenceTypes: [
          "two-tenant-load",
          "per-capsule-metrics",
          "scale-or-drain",
        ],
      },
      {
        field: "tenantACapsuleId",
        evidenceTypes: ["two-tenant-load", "per-capsule-metrics"],
      },
      {
        field: "tenantBCapsuleId",
        evidenceTypes: ["two-tenant-load", "per-capsule-metrics"],
      },
    ],
    "runner-profile-migration": [
      {
        field: "capsuleId",
        evidenceTypes: [
          "readiness-before-cutover",
          "runner-profile-cutover",
          "rollback-before-final",
          "domain-preservation",
          "preserve-evidence",
        ],
      },
      {
        field: "targetRunnerProfileId",
        evidenceTypes: ["readiness-before-cutover", "runner-profile-cutover"],
      },
      {
        field: "oidcClientId",
        evidenceTypes: ["domain-preservation", "preserve-evidence"],
      },
      {
        field: "domainName",
        evidenceTypes: ["domain-preservation", "preserve-evidence"],
      },
    ],
    "export-self-host-migration": [
      {
        field: "migrationId",
        evidenceTypes: ["clean-migration", "post-migration-login"],
      },
      {
        field: "accountId",
        evidenceTypes: ["post-migration-login", "source-retention-state"],
      },
    ],
    "sev-simulation": [
      {
        field: "incidentId",
        evidenceTypes: ["alert", "ack", "status-update", "postmortem"],
      },
    ],
    "release-rollback": [
      {
        field: "releaseCandidate",
        evidenceTypes: ["release-promotion", "rollback", "release-note"],
      },
    ],
    "privacy-operation": [
      {
        field: "requestId",
        evidenceTypes: [
          "export-or-delete-request",
          "login-disabled-or-exported",
          "retention-record",
        ],
      },
      {
        field: "accountId",
        evidenceTypes: [
          "export-or-delete-request",
          "login-disabled-or-exported",
        ],
      },
    ],
  },
};

export const platformReadinessStructuredEvidenceRequirements: Record<
  string,
  PlatformReadinessEvidenceSchema
> = {
  "staging-manifest": {
    fields: ["topologyEnvironment", "manifestRef", "componentCount"],
    values: { topologyEnvironment: "staging" },
  },
  "staging-artifact-digest": {
    fields: [
      "topologyEnvironment",
      "deployableComponentCount",
      "artifactDigestEvidenceRef",
    ],
    values: { topologyEnvironment: "staging" },
  },
  "staging-migration-transcript": {
    fields: ["topologyEnvironment", "migrationTranscriptRef"],
    values: { topologyEnvironment: "staging" },
  },
  "staging-health-probe": {
    fields: [
      "topologyEnvironment",
      "healthProbeEvidenceRef",
      "healthProbeCount",
    ],
    values: { topologyEnvironment: "staging" },
  },
  "staging-tls-evidence": {
    fields: ["topologyEnvironment", "tlsEvidenceRef"],
    values: { topologyEnvironment: "staging" },
  },
  "staging-rollback-target": {
    fields: [
      "topologyEnvironment",
      "rollbackRef",
      "rollbackRole",
      "artifactDigest",
    ],
    values: { topologyEnvironment: "staging" },
  },
  "production-manifest": {
    fields: ["topologyEnvironment", "manifestRef", "componentCount"],
    values: { topologyEnvironment: "production" },
  },
  "production-artifact-digest": {
    fields: [
      "topologyEnvironment",
      "deployableComponentCount",
      "artifactDigestEvidenceRef",
    ],
    values: { topologyEnvironment: "production" },
  },
  "production-migration-transcript": {
    fields: ["topologyEnvironment", "migrationTranscriptRef"],
    values: { topologyEnvironment: "production" },
  },
  "production-health-probe": {
    fields: [
      "topologyEnvironment",
      "healthProbeEvidenceRef",
      "healthProbeCount",
    ],
    values: { topologyEnvironment: "production" },
  },
  "production-tls-evidence": {
    fields: ["topologyEnvironment", "tlsEvidenceRef"],
    values: { topologyEnvironment: "production" },
  },
  "production-rollback-target": {
    fields: [
      "topologyEnvironment",
      "rollbackRef",
      "rollbackRole",
      "artifactDigest",
    ],
    values: { topologyEnvironment: "production" },
  },
  "launch-brief": {
    fields: [
      "briefRef",
      "targetCustomer",
      "launchScope",
      "quotaPlanRef",
      "acceptedUsePolicyRef",
    ],
  },
  "operator-signoff": {
    fields: ["signoffId", "signedBy"],
  },
  "suspend-recover": {
    fields: ["suspensionEventId", "recoveryEventId"],
  },
  "oidc-conformance": {
    fields: ["conformanceRunId", "issuer"],
  },
  "key-rotation-drill": {
    fields: ["rotationRunId", "keyId", "previousKeyId", "overlapJwksDigest"],
  },
  "client-secret-rotation": {
    fields: [
      "rotationRunId",
      "clientId",
      "oldSecretId",
      "newSecretId",
      "overlapWindowSeconds",
      "revocationEventId",
    ],
  },
  "passkey-e2e": {
    fields: ["e2eRunId", "browser"],
  },
  "rate-limit-test": {
    fields: ["testRunId", "policyRef"],
  },
  "audit-event": {
    fields: ["auditEventId", "subject"],
  },
  "fresh-user-smoke": {
    fields: ["smokeRunId", "accountId", "workspaceId"],
  },
  "email-assurance": {
    fields: ["accountId", "assuranceMethod", "verifiedAt"],
    allowedValues: {
      assuranceMethod: [
        "email-verified",
        "upstream-identity-session",
        "operator-invited",
        "enterprise-idp",
      ],
    },
  },
  "team-membership": {
    fields: ["accountId", "workspaceId", "membershipRole", "membershipEventId"],
    allowedValues: { membershipRole: ["owner", "admin", "member"] },
  },
  "quota-plan": {
    fields: ["planId", "quotaPlanRef"],
  },
  "quota-spike-drill": {
    fields: [
      "spikeRunId",
      "accountId",
      "workspaceId",
      "meter",
      "cap",
      "guardResult",
    ],
    allowedValues: { guardResult: ["blocked", "suspended", "queued"] },
  },
  "noisy-tenant-throttle": {
    fields: ["throttleRunId", "tenantId", "result"],
    allowedValues: { result: ["throttled", "isolated", "blocked"] },
  },
  "run-kill-switch": {
    fields: ["killSwitchRunId", "runId", "guardResult"],
    allowedValues: { guardResult: ["blocked", "suspended", "queued"] },
  },
  "operator-override": {
    fields: ["overrideEventId", "operatorId"],
  },
  "load-test": {
    fields: [
      "loadRunId",
      "tenantCount",
      "tenantACapsuleId",
      "tenantBCapsuleId",
      "runnerPoolId",
    ],
  },
  "isolation-test": {
    fields: ["isolationCheckId", "result"],
    allowedValues: { result: ["passed"] },
  },
  "metric-labels": {
    fields: ["dashboardRef", "labelSet"],
  },
  "scale-drain-event": {
    fields: ["runnerPoolId", "eventId"],
  },
  "evacuation-record": {
    fields: ["evacuationRunId", "runnerPoolId"],
  },
  "runner-profile-migration-drill": {
    fields: ["migrationOperationId", "capsuleId"],
  },
  "readiness-probe": {
    fields: ["probeRunId", "endpoint"],
  },
  "continuity-evidence": {
    fields: [
      "continuityCheckId",
      "capsuleId",
      "sourceCommit",
      "oidcClientId",
      "domainName",
      "dataNamespace",
      "interfaceBindingDigest",
      "noDataLossCheckId",
    ],
  },
  "encrypted-export": {
    fields: ["exportId", "archiveDigest", "ageRecipient"],
  },
  "self-host-migration": {
    fields: ["migrationId", "targetHost", "oidcIssuer"],
  },
  "sample-data-verification": {
    fields: ["verificationRunId", "dataClasses"],
  },
  "restore-transcript": {
    fields: ["restoreRunId", "targetEnvironment", "transcriptRef"],
  },
  "dr-simulation": {
    fields: ["simulationRunId", "scenario", "decisionRef"],
  },
  "rpo-rto-sample": {
    fields: ["rpoSeconds", "rtoSeconds"],
  },
  "audit-chain-verification": {
    fields: ["auditChainRef", "verificationRunId"],
  },
  "restore-target-smoke": {
    fields: ["restoreTargetId", "smokeRunId", "result"],
    allowedValues: { result: ["passed"] },
  },
  "ci-equivalent": {
    fields: ["ciRunId", "conclusion"],
    allowedValues: { conclusion: ["success"] },
  },
  sbom: {
    fields: ["sbomRef", "artifactDigest"],
  },
  signature: {
    fields: ["signatureRef", "keyId"],
  },
  "image-digest": {
    fields: ["imageDigest"],
  },
  "package-version": {
    fields: ["packageName", "packageVersion"],
  },
  "branch-protection-export": {
    fields: ["exportRef", "repository", "reviewedAt"],
  },
  "artifact-policy": {
    fields: ["policyRef", "immutabilityRef"],
  },
  "rollback-drill": {
    fields: ["rollbackRunId", "targetDigest"],
  },
  "threat-model": {
    fields: ["threatModelRef", "acceptedBy"],
  },
  "sandbox-review": {
    fields: ["reviewId", "decision"],
    allowedValues: { decision: ["accepted"] },
  },
  "vulnerability-response-policy": {
    fields: ["policyRef", "dashboardRef"],
  },
  "secret-inventory": {
    fields: ["inventoryRef", "reviewedAt"],
  },
  "secret-rotation-run-log": {
    fields: ["rotationRunId", "completedAt", "result"],
    allowedValues: { result: ["passed"] },
  },
  "security-contact": {
    fields: ["contactTestId", "result"],
    allowedValues: { result: ["delivered"] },
  },
  "deploy-control-abuse-blocked": {
    fields: ["scenarioId", "blockEventId", "policyRef"],
  },
  "dashboard-link": {
    fields: ["dashboardRef", "panelId"],
  },
  "alert-routing": {
    fields: ["alertRouteId", "primaryOncall"],
  },
  "synthetic-probe": {
    fields: ["probeId", "endpoint", "coveredEndpoints"],
  },
  "sev-drill": {
    fields: ["incidentId", "drillRunId"],
  },
  "status-update": {
    fields: ["incidentId", "statusPageUpdateId"],
  },
  "sar-delete-rehearsal": {
    fields: ["requestId", "result"],
    allowedValues: { result: ["passed"] },
  },
  "signup-event": {
    fields: ["eventId", "workspaceId"],
    anyOf: [["accountId", "sessionSubject", "sessionSubjectDigest"]],
  },
  "capsule-created": {
    fields: ["capsuleId", "workspaceId", "sourceUrl", "commitSha"],
  },
  "capsule-session": {
    fields: ["capsuleId"],
    anyOf: [
      ["subject", "sessionSubject", "sessionSubjectDigest"],
      ["sessionId", "sessionSubject", "sessionSubjectDigest"],
    ],
  },
  "capsule-plan-run": {
    fields: ["capsuleId", "planRunId", "sourceUrl", "commitSha", "planDigest"],
  },
  "cost-review": {
    fields: ["planDigest", "approvedBy"],
    anyOf: [["costEstimateId", "costReviewEventId", "billingMode"]],
  },
  "capsule-apply": {
    fields: ["capsuleId", "applyRunId", "stateVersionId", "planDigest"],
  },
  "oidc-login": {
    fields: ["capsuleId"],
    anyOf: [
      ["oidcClientId", "issuer"],
      ["sessionId", "sessionSubject", "sessionSubjectDigest"],
    ],
  },
  "event-hash-chain": {
    fields: ["capsuleId", "firstEventHash", "lastEventHash"],
  },
  "quota-exceeded": {
    fields: ["accountId", "meter", "cap"],
  },
  "guard-action": {
    fields: ["accountId", "action", "eventId"],
    allowedValues: { action: ["blocked", "suspended", "queued"] },
  },
  "override-audit": {
    fields: ["accountId", "overrideEventId", "reviewer"],
  },
  "two-tenant-load": {
    fields: [
      "tenantACapsuleId",
      "tenantBCapsuleId",
      "runnerPoolId",
      "loadRunId",
    ],
  },
  "isolation-proof": {
    fields: ["loadRunId", "isolationCheckId", "result"],
    allowedValues: { result: ["passed"] },
  },
  "per-capsule-metrics": {
    fields: [
      "runnerPoolId",
      "tenantACapsuleId",
      "tenantBCapsuleId",
      "metricsDashboardRef",
    ],
  },
  "scale-or-drain": {
    fields: ["runnerPoolId", "eventId", "action"],
    allowedValues: { action: ["scale", "drain"] },
  },
  "runner-profile-cutover": {
    fields: ["capsuleId", "migrationOperationId", "targetRunnerProfileId"],
  },
  "readiness-before-cutover": {
    fields: ["capsuleId", "probeRunId", "targetRunnerProfileId"],
  },
  "rollback-before-final": {
    fields: ["capsuleId", "rollbackOperationId", "sourceRunnerProfileId"],
  },
  "domain-preservation": {
    fields: ["capsuleId", "domainName", "oidcClientId"],
  },
  "preserve-evidence": {
    fields: [
      "capsuleId",
      "sourceCommit",
      "oidcClientId",
      "domainName",
      "dataNamespace",
    ],
  },
  "clean-migration": {
    fields: ["migrationId", "targetHost", "result"],
    allowedValues: { result: ["passed"] },
  },
  "post-migration-login": {
    fields: ["migrationId", "accountId", "sessionId"],
  },
  "source-retention-state": {
    fields: ["accountId", "retentionRecordId", "state"],
    allowedValues: { state: ["retained", "delete-pending", "deleted"] },
  },
  alert: {
    fields: ["incidentId", "alertId"],
  },
  ack: {
    fields: ["incidentId", "acknowledgedBy"],
  },
  postmortem: {
    fields: [
      "incidentId",
      "mitigationEventId",
      "postmortemRef",
      "actionItemRef",
    ],
  },
  "release-promotion": {
    fields: ["releaseCandidate", "imageDigest", "deployRunId"],
  },
  rollback: {
    fields: ["releaseCandidate", "rollbackRunId", "targetDigest"],
  },
  "release-note": {
    fields: ["releaseCandidate", "releaseNoteRef"],
  },
  "export-or-delete-request": {
    fields: ["requestId", "accountId", "requestType"],
    allowedValues: { requestType: ["export", "delete"] },
  },
  "login-disabled-or-exported": {
    fields: ["requestId", "accountId", "result"],
    allowedValues: { result: ["login-disabled", "exported", "deleted"] },
  },
  "retention-record": {
    fields: ["requestId", "retentionRecordId", "policyRef"],
  },
};

const positiveReadinessNumber = {
  minimum: 0,
  exclusiveMinimum: true,
} as const;

/**
 * Explicit validation metadata for the OSS readiness evidence vocabulary.
 * Runtime validation never derives semantics from a field suffix or evidence
 * type token; optional contributions carry the same data in their schemas.
 */
export const platformReadinessStructuredEvidenceRules: Readonly<
  Record<string, PlatformReadinessEvidenceSchema>
> = {
  "staging-manifest": {
    formats: { manifestRef: "evidence-ref" },
    numericBounds: { componentCount: positiveReadinessNumber },
  },
  "staging-artifact-digest": {
    formats: { artifactDigestEvidenceRef: "evidence-ref" },
    numericBounds: { deployableComponentCount: positiveReadinessNumber },
  },
  "staging-migration-transcript": {
    formats: { migrationTranscriptRef: "evidence-ref" },
  },
  "staging-health-probe": {
    formats: { healthProbeEvidenceRef: "evidence-ref" },
    numericBounds: { healthProbeCount: positiveReadinessNumber },
  },
  "staging-tls-evidence": {
    formats: { tlsEvidenceRef: "evidence-ref" },
  },
  "staging-rollback-target": {
    formats: { rollbackRef: "evidence-ref", artifactDigest: "sha256" },
  },
  "production-manifest": {
    formats: { manifestRef: "evidence-ref" },
    numericBounds: { componentCount: positiveReadinessNumber },
  },
  "production-artifact-digest": {
    formats: { artifactDigestEvidenceRef: "evidence-ref" },
    numericBounds: { deployableComponentCount: positiveReadinessNumber },
  },
  "production-migration-transcript": {
    formats: { migrationTranscriptRef: "evidence-ref" },
  },
  "production-health-probe": {
    formats: { healthProbeEvidenceRef: "evidence-ref" },
    numericBounds: { healthProbeCount: positiveReadinessNumber },
  },
  "production-tls-evidence": {
    formats: { tlsEvidenceRef: "evidence-ref" },
  },
  "production-rollback-target": {
    formats: { rollbackRef: "evidence-ref", artifactDigest: "sha256" },
  },
  "launch-brief": {
    formats: {
      briefRef: "evidence-ref",
      quotaPlanRef: "evidence-ref",
      acceptedUsePolicyRef: "evidence-ref",
    },
  },
  "key-rotation-drill": {
    formats: { overlapJwksDigest: "sha256" },
  },
  "client-secret-rotation": {
    numericBounds: { overlapWindowSeconds: positiveReadinessNumber },
  },
  "rate-limit-test": { formats: { policyRef: "evidence-ref" } },
  "email-assurance": { formats: { verifiedAt: "timestamp" } },
  "quota-plan": { formats: { quotaPlanRef: "evidence-ref" } },
  "quota-spike-drill": { numericBounds: { cap: { minimum: 0 } } },
  "load-test": {
    numericBounds: { tenantCount: { minimum: 2 } },
    distinctFields: [["tenantACapsuleId", "tenantBCapsuleId"]],
  },
  "metric-labels": { formats: { dashboardRef: "evidence-ref" } },
  "continuity-evidence": {
    formats: {
      sourceCommit: "git-object-id",
      interfaceBindingDigest: "sha256",
    },
  },
  "encrypted-export": { formats: { archiveDigest: "sha256" } },
  "sample-data-verification": {
    requiredItems: {
      dataClasses: ["account", "workspace", "capsule", "run", "output"],
    },
  },
  "restore-transcript": { formats: { transcriptRef: "evidence-ref" } },
  "dr-simulation": { formats: { decisionRef: "evidence-ref" } },
  "rpo-rto-sample": {
    numericBounds: {
      rpoSeconds: positiveReadinessNumber,
      rtoSeconds: positiveReadinessNumber,
    },
  },
  "audit-chain-verification": {
    formats: { auditChainRef: "evidence-ref" },
  },
  sbom: {
    formats: { sbomRef: "evidence-ref", artifactDigest: "sha256" },
  },
  signature: { formats: { signatureRef: "evidence-ref" } },
  "image-digest": { formats: { imageDigest: "sha256" } },
  "branch-protection-export": {
    formats: { exportRef: "evidence-ref", reviewedAt: "timestamp" },
  },
  "artifact-policy": {
    formats: { policyRef: "evidence-ref", immutabilityRef: "evidence-ref" },
  },
  "rollback-drill": { formats: { targetDigest: "sha256" } },
  "threat-model": { formats: { threatModelRef: "evidence-ref" } },
  "vulnerability-response-policy": {
    formats: { policyRef: "evidence-ref", dashboardRef: "evidence-ref" },
  },
  "secret-inventory": {
    formats: { inventoryRef: "evidence-ref", reviewedAt: "timestamp" },
  },
  "secret-rotation-run-log": { formats: { completedAt: "timestamp" } },
  "deploy-control-abuse-blocked": {
    formats: { policyRef: "evidence-ref" },
  },
  "dashboard-link": { formats: { dashboardRef: "evidence-ref" } },
  "synthetic-probe": {
    requiredItems: {
      coveredEndpoints: ["signup", "login", "install", "launch", "export"],
    },
  },
  "signup-event": { formats: { sessionSubjectDigest: "sha256" } },
  "capsule-created": {
    formats: { sourceUrl: "https-url", commitSha: "git-commit-sha1" },
  },
  "capsule-session": { formats: { sessionSubjectDigest: "sha256" } },
  "capsule-plan-run": {
    formats: {
      sourceUrl: "https-url",
      commitSha: "git-commit-sha1",
      planDigest: "sha256",
    },
  },
  "cost-review": { formats: { planDigest: "sha256" } },
  "capsule-apply": { formats: { planDigest: "sha256" } },
  "oidc-login": { formats: { sessionSubjectDigest: "sha256" } },
  "event-hash-chain": {
    formats: { firstEventHash: "sha256", lastEventHash: "sha256" },
  },
  "quota-exceeded": { numericBounds: { cap: { minimum: 0 } } },
  "two-tenant-load": {
    distinctFields: [["tenantACapsuleId", "tenantBCapsuleId"]],
  },
  "per-capsule-metrics": {
    formats: { metricsDashboardRef: "evidence-ref" },
  },
  "preserve-evidence": { formats: { sourceCommit: "git-object-id" } },
  postmortem: {
    formats: {
      postmortemRef: "evidence-ref",
      actionItemRef: "evidence-ref",
    },
  },
  "release-promotion": { formats: { imageDigest: "sha256" } },
  rollback: { formats: { targetDigest: "sha256" } },
  "release-note": { formats: { releaseNoteRef: "evidence-ref" } },
  "retention-record": { formats: { policyRef: "evidence-ref" } },
};

export const productionTopologyRequiredRoles = [
  "accounts",
  "dashboard",
  "takosumi-deploy-control",
  "service",
  "object-storage",
  "dns-tls",
] as const;
export const productionTopologyDeployableRoles = new Set([
  "accounts",
  "dashboard",
  "takosumi-deploy-control",
  "service",
]);

export type PlatformReadinessEvidenceStatus = "passed" | "failed" | "blocked";

export interface PlatformReadinessEvidenceEntry {
  id?: unknown;
  runId?: unknown;
  status?: unknown;
  owner?: unknown;
  environment?: unknown;
  reviewer?: unknown;
  completedAt?: unknown;
  evidence?: unknown;
}

export interface PlatformReadinessRehearsalRun {
  id?: unknown;
  environment?: unknown;
  owner?: unknown;
  reviewer?: unknown;
  startedAt?: unknown;
  completedAt?: unknown;
}

export interface PlatformReadinessEvidenceReference {
  type?: unknown;
  ref?: unknown;
  summary?: unknown;
  private?: unknown;
  publicSummary?: unknown;
  runId?: unknown;
}

export interface PlatformReadinessReport {
  kind: typeof platformReadinessReportKind;
  ready: boolean;
  contributions: Array<{
    id: string;
    version: string;
    capability: string;
  }>;
  collectionClassHints: Record<string, string[]>;
  evidenceDigest?: string;
  missingDomains: string[];
  incompleteDomains: string[];
  missingRehearsalSteps: string[];
  incompleteRehearsalSteps: string[];
  gapDetails?: PlatformReadinessGapDetail[];
  errors: string[];
}

export interface PlatformReadinessGapDetail {
  scope: "domains" | "rehearsal";
  id: string;
  status: "missing" | "incomplete";
  requiredEvidenceTypes: string[];
  presentEvidenceTypes: string[];
  completeEvidenceTypes: string[];
  missingEvidenceTypes: string[];
  incompleteEvidenceTypes: string[];
  evidenceReferenceGaps: PlatformReadinessEvidenceReferenceGap[];
  blockingFields: string[];
}

export interface PlatformReadinessEvidenceReferenceGap {
  type: string;
  status: "missing" | "incomplete";
  blockingFields: string[];
}

export interface ProductionTopologyPreflightReport {
  kind: typeof platformReadinessProductionTopologyReportKind;
  ready: boolean;
  environment: string | null;
  missingRoles: string[];
  errors: string[];
  evidenceEntry?: Record<string, unknown>;
}

export interface ProductionTopologyMergeReport {
  kind: typeof platformReadinessProductionTopologyMergeReportKind;
  ready: boolean;
  errors: string[];
  evidenceEntry?: Record<string, unknown>;
}
