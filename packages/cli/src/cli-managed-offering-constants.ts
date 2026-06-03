export const managedOfferingReadinessKind =
  "takosumi.managed-offering-readiness@v1";
export const managedOfferingReadinessReportKind =
  "takosumi.managed-offering-readiness-report@v1";
export const managedOfferingPublicSummaryKind =
  "takosumi.managed-offering-public-summary@v1";
export const managedOfferingPublicSummaryReportKind =
  "takosumi.managed-offering-public-summary-report@v1";
export const managedOfferingProductionTopologyKind =
  "takosumi.production-topology@v1";
export const managedOfferingProductionTopologyReportKind =
  "takosumi.production-topology-preflight-report@v1";
export const managedOfferingProductionTopologyMergeReportKind =
  "takosumi.production-topology-merge-report@v1";
export const managedOfferingDomainIds = [
  "offering-definition",
  "production-topology",
  "oidc-account-security",
  "signup-tenant-lifecycle",
  "billing-entitlement",
  "quota-abuse-spend-control",
  "shared-cell-production-runtime",
  "dedicated-materialize",
  "export-self-host-sovereignty",
  "backup-dr",
  "observability-slo-on-call",
  "release-provenance",
  "security-operations",
  "legal-privacy-support",
  "customer-operations",
] as const;
export const managedOfferingRehearsalStepIds = [
  "fresh-signup",
  "use-takos-launch",
  "git-url-install",
  "quota-abuse-drill",
  "shared-cell-load",
  "dedicated-materialize",
  "export-self-host-import",
  "backup-restore",
  "sev-simulation",
  "release-rollback",
  "privacy-operation",
  "billing-operation",
] as const;
export const managedOfferingEvidenceEnvironments = [
  "staging",
  "production",
  "staging+production",
] as const;
export const managedOfferingRehearsalEnvironments = [
  "staging",
  "production",
] as const;

export const managedOfferingRequiredEvidenceTypes = {
  domains: {
    "offering-definition": [
      "launch-brief",
      "operator-signoff",
    ],
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
      "passkey-e2e",
      "rate-limit-test",
      "audit-event",
    ],
    "signup-tenant-lifecycle": [
      "fresh-user-smoke",
      "email-assurance",
      "team-membership",
      "launch-token-consume",
      "bundled-app-install",
      "terms-acceptance",
      "suspend-recover",
    ],
    "billing-entitlement": [
      "stripe-sandbox",
      "stripe-live",
      "entitlement",
      "usage-meter",
      "usage-aggregation-policy",
      "invoice",
      "tax-policy",
      "plan-transition",
      "failed-payment",
      "dunning",
      "refund-credit",
      "suspend-recover",
    ],
    "quota-abuse-spend-control": [
      "quota-plan",
      "spend-cap",
      "llm-tool-usage-cap",
      "quota-spike-drill",
      "noisy-tenant-throttle",
      "deploy-kill-switch",
      "abuse-queue-review",
      "operator-override",
      "audit-event",
    ],
    "shared-cell-production-runtime": [
      "load-test",
      "isolation-test",
      "metric-labels",
      "scale-drain-event",
      "evacuation-record",
    ],
    "dedicated-materialize": [
      "materialize-drill",
      "readiness-probe",
      "rollback-drill",
      "continuity-evidence",
    ],
    "export-self-host-sovereignty": [
      "encrypted-export",
      "self-host-import",
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
      "vulnerability-sla",
      "secret-inventory",
      "secret-rotation-run-log",
      "security-contact",
      "deploy-control-abuse-blocked",
    ],
    "legal-privacy-support": [
      "legal-signoff",
      "public-legal-pages",
      "support-mailbox-test",
      "sar-delete-rehearsal",
      "billing-support-runbook",
    ],
    "customer-operations": [
      "onboarding-guide",
      "admin-guide",
      "billing-faq",
      "export-guide",
      "escalation-matrix",
      "suspension-delete-export-wording",
    ],
  },
  rehearsal: {
    "fresh-signup": [
      "signup-event",
      "email-assurance",
      "team-membership",
      "terms-acceptance",
      "entitlement-event",
    ],
    "use-takos-launch": [
      "launch-token-consume",
      "bundled-app-install",
      "default-app-uninstall",
      "default-app-reinstall",
    ],
    "git-url-install": [
      "installation-plan-run",
      "cost-review",
      "install-apply",
      "oidc-login",
      "event-hash-chain",
    ],
    "quota-abuse-drill": [
      "quota-exceeded",
      "guard-action",
      "override-audit",
    ],
    "shared-cell-load": [
      "two-tenant-load",
      "isolation-proof",
      "per-installation-metrics",
      "scale-or-drain",
    ],
    "dedicated-materialize": [
      "readiness-before-cutover",
      "materialize-cutover",
      "rollback-before-final",
      "domain-preservation",
      "preserve-evidence",
    ],
    "export-self-host-import": [
      "encrypted-export",
      "clean-import",
      "post-import-login",
      "sample-data-verification",
      "source-retention-state",
    ],
    "backup-restore": [
      "restore-transcript",
      "restore-target-smoke",
      "audit-chain-verification",
      "rpo-rto-sample",
    ],
    "sev-simulation": [
      "alert",
      "ack",
      "status-update",
      "postmortem",
    ],
    "release-rollback": [
      "release-promotion",
      "rollback",
      "support-note",
    ],
    "privacy-operation": [
      "export-or-delete-request",
      "login-disabled-or-exported",
      "retention-record",
    ],
    "billing-operation": [
      "invoice-paid",
      "failed-payment",
      "dunning-suspension",
      "recovery-refund-credit",
    ],
  },
} as const;
export const managedOfferingStructuredEvidenceRequirements: Record<
  string,
  {
    fields?: readonly string[];
    anyOf?: readonly (readonly string[])[];
    values?: Record<string, string>;
    allowedValues?: Record<string, readonly string[]>;
  }
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
      "sku",
      "quotaPlanRef",
      "billingMeterRef",
      "supportTier",
      "supportSlaRef",
      "freeTrialPolicyRef",
      "acceptedUsePolicyRef",
      "betaScopeRef",
    ],
  },
  "operator-signoff": {
    fields: ["signoffId", "signedBy"],
  },
  "stripe-sandbox": {
    fields: ["checkoutSessionId", "webhookEventId"],
    values: { mode: "sandbox" },
  },
  "stripe-live": {
    fields: ["checkoutSessionId", "webhookEventId"],
    values: { mode: "live" },
  },
  entitlement: {
    fields: ["accountId", "installationId", "entitlementStatus"],
    allowedValues: { entitlementStatus: ["active"] },
  },
  "usage-meter": {
    fields: ["meter", "quantity", "usageReportId"],
  },
  "usage-aggregation-policy": {
    fields: ["policyRef", "windowStart", "windowEnd"],
  },
  invoice: {
    fields: ["invoiceId", "status"],
    allowedValues: { status: ["paid"] },
  },
  "tax-policy": {
    fields: ["policyRef", "jurisdiction"],
  },
  "plan-transition": {
    fields: ["subscriptionId", "fromPlan", "toPlan"],
  },
  "failed-payment": {
    fields: ["invoiceId", "webhookEventId"],
  },
  dunning: {
    fields: ["dunningRunId", "action"],
    allowedValues: { action: ["dunning-notified", "suspend"] },
  },
  "refund-credit": {
    fields: ["accountId"],
    anyOf: [["refundId", "creditNoteId"]],
  },
  "suspend-recover": {
    fields: ["suspensionEventId", "recoveryEventId"],
  },
  "oidc-conformance": {
    fields: ["conformanceRunId", "issuer"],
  },
  "key-rotation-drill": {
    fields: ["rotationRunId", "keyId"],
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
    fields: ["smokeRunId", "accountId", "spaceId"],
  },
  "email-assurance": {
    fields: ["accountId", "assuranceMethod", "verifiedAt"],
    allowedValues: {
      assuranceMethod: ["email-verified", "operator-invited", "enterprise-idp"],
    },
  },
  "team-membership": {
    fields: ["accountId", "spaceId", "membershipRole", "membershipEventId"],
    allowedValues: { membershipRole: ["owner", "admin", "member"] },
  },
  "quota-plan": {
    fields: ["planId", "quotaPlanRef"],
  },
  "spend-cap": {
    fields: ["installationId", "spendCapRef", "cap", "currency"],
  },
  "llm-tool-usage-cap": {
    fields: ["llmUsageCapRef", "toolUsageCapRef"],
  },
  "quota-spike-drill": {
    fields: [
      "spikeRunId",
      "accountId",
      "installationId",
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
  "deploy-kill-switch": {
    fields: ["killSwitchRunId", "deploymentId", "guardResult"],
    allowedValues: { guardResult: ["blocked", "suspended", "queued"] },
  },
  "abuse-queue-review": {
    fields: ["queueReviewId", "reviewQueueRef", "decision"],
    allowedValues: { decision: ["reviewed", "blocked", "allowed"] },
  },
  "operator-override": {
    fields: ["overrideEventId", "operatorId"],
  },
  "load-test": {
    fields: [
      "loadRunId",
      "tenantCount",
      "tenantAInstallationId",
      "tenantBInstallationId",
      "runtimeCellId",
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
    fields: ["runtimeCellId", "eventId"],
  },
  "evacuation-record": {
    fields: ["evacuationRunId", "runtimeCellId"],
  },
  "materialize-drill": {
    fields: ["materializeOperationId", "installationId"],
  },
  "readiness-probe": {
    fields: ["probeRunId", "endpoint"],
  },
  "continuity-evidence": {
    fields: [
      "continuityCheckId",
      "installationId",
      "sourceCommit",
      "oidcClientId",
      "domainName",
      "dataNamespace",
      "permissionScopeDigest",
      "noDataLossCheckId",
    ],
  },
  "encrypted-export": {
    fields: ["exportId", "archiveDigest", "ageRecipient"],
  },
  "self-host-import": {
    fields: ["importId", "targetHost", "oidcIssuer"],
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
  "vulnerability-sla": {
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
  "legal-signoff": {
    fields: ["signoffId", "signedBy"],
  },
  "public-legal-pages": {
    fields: ["termsUrl", "privacyUrl", "dpaUrl"],
  },
  "support-mailbox-test": {
    fields: ["mailbox", "testId"],
  },
  "sar-delete-rehearsal": {
    fields: ["requestId", "result"],
    allowedValues: { result: ["passed"] },
  },
  "billing-support-runbook": {
    fields: ["runbookRef", "owner"],
  },
  "onboarding-guide": {
    fields: ["guideRef", "reviewedBy"],
  },
  "admin-guide": {
    fields: ["guideRef", "reviewedBy"],
  },
  "billing-faq": {
    fields: ["faqRef", "reviewedBy"],
  },
  "export-guide": {
    fields: ["guideRef", "reviewedBy"],
  },
  "escalation-matrix": {
    fields: ["matrixRef", "reviewedBy"],
  },
  "suspension-delete-export-wording": {
    fields: ["wordingRef", "reviewedBy"],
  },
  "signup-event": {
    fields: ["eventId", "accountId", "spaceId"],
  },
  "terms-acceptance": {
    fields: ["eventId", "accountId", "termsVersion"],
  },
  "entitlement-event": {
    fields: ["eventId", "accountId", "entitlementId"],
  },
  "launch-token-consume": {
    fields: ["installationId", "launchTokenJti", "sessionId"],
  },
  "bundled-app-install": {
    fields: ["spaceId", "bundledAppInstallationIds", "eventId"],
  },
  "default-app-reinstall": {
    fields: ["spaceId", "appId", "reinstallEventId"],
  },
  "default-app-uninstall": {
    fields: ["spaceId", "appId", "uninstallEventId"],
  },
  "installation-plan-run": {
    fields: ["sourceUrl", "commitSha", "planDigest"],
  },
  "cost-review": {
    fields: ["planDigest", "costEstimateId", "approvedBy"],
  },
  "install-apply": {
    fields: [
      "installationId",
      "deploymentId",
      "applyEventId",
      "planDigest",
    ],
  },
  "oidc-login": {
    fields: ["installationId", "oidcClientId", "sessionId"],
  },
  "event-hash-chain": {
    fields: ["installationId", "firstEventHash", "lastEventHash"],
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
      "tenantAInstallationId",
      "tenantBInstallationId",
      "runtimeCellId",
      "loadRunId",
    ],
  },
  "isolation-proof": {
    fields: ["loadRunId", "isolationCheckId", "result"],
    allowedValues: { result: ["passed"] },
  },
  "per-installation-metrics": {
    fields: [
      "runtimeCellId",
      "tenantAInstallationId",
      "tenantBInstallationId",
      "metricsDashboardRef",
    ],
  },
  "scale-or-drain": {
    fields: ["runtimeCellId", "eventId", "action"],
    allowedValues: { action: ["scale", "drain"] },
  },
  "materialize-cutover": {
    fields: [
      "installationId",
      "materializeOperationId",
      "targetRuntimeTargetId",
    ],
  },
  "readiness-before-cutover": {
    fields: ["installationId", "probeRunId", "targetRuntimeTargetId"],
  },
  "rollback-before-final": {
    fields: [
      "installationId",
      "rollbackOperationId",
      "sourceRuntimeTargetId",
    ],
  },
  "domain-preservation": {
    fields: ["installationId", "domainName", "oidcClientId"],
  },
  "preserve-evidence": {
    fields: [
      "installationId",
      "sourceCommit",
      "oidcClientId",
      "domainName",
      "dataNamespace",
    ],
  },
  "clean-import": {
    fields: ["importId", "targetHost", "result"],
    allowedValues: { result: ["passed"] },
  },
  "post-import-login": {
    fields: ["importId", "accountId", "sessionId"],
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
  "support-note": {
    fields: ["releaseCandidate", "supportNoteRef"],
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
  "invoice-paid": {
    fields: ["invoiceId", "webhookEventId"],
  },
  "dunning-suspension": {
    fields: ["invoiceId", "dunningRunId", "suspensionEventId"],
  },
  "recovery-refund-credit": {
    fields: ["accountId", "recoveryEventId"],
    anyOf: [["refundId", "creditNoteId"]],
  },
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

export type ManagedOfferingEvidenceStatus = "passed" | "failed" | "blocked";

export interface ManagedOfferingEvidenceEntry {
  id?: unknown;
  runId?: unknown;
  status?: unknown;
  owner?: unknown;
  environment?: unknown;
  reviewer?: unknown;
  completedAt?: unknown;
  evidence?: unknown;
}

export interface ManagedOfferingRehearsalRun {
  id?: unknown;
  environment?: unknown;
  owner?: unknown;
  reviewer?: unknown;
  startedAt?: unknown;
  completedAt?: unknown;
}

export interface ManagedOfferingEvidenceReference {
  type?: unknown;
  ref?: unknown;
  summary?: unknown;
  private?: unknown;
  publicSummary?: unknown;
}

export interface ManagedOfferingReadinessReport {
  kind: typeof managedOfferingReadinessReportKind;
  ready: boolean;
  evidenceDigest?: string;
  missingDomains: string[];
  incompleteDomains: string[];
  missingRehearsalSteps: string[];
  incompleteRehearsalSteps: string[];
  errors: string[];
}

export interface ProductionTopologyPreflightReport {
  kind: typeof managedOfferingProductionTopologyReportKind;
  ready: boolean;
  environment: string | null;
  missingRoles: string[];
  errors: string[];
  evidenceEntry?: Record<string, unknown>;
}

export interface ProductionTopologyMergeReport {
  kind: typeof managedOfferingProductionTopologyMergeReportKind;
  ready: boolean;
  errors: string[];
  evidenceEntry?: Record<string, unknown>;
}
