import { expect, test } from "bun:test";
import { assert, assertEquals, assertRejects } from "../../../test/assert.ts";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";
import { main } from "./main.ts";
import { runAccountsMigrateD1 } from "./cli-accounts-commands.ts";
import {
  applyD1AccountsMigrations,
  type D1ExecuteCommand,
} from "./cli-accounts-db.ts";
import { integerOption, parseOptions } from "./cli-options.ts";

const textEncoder = new TextEncoder();

async function makeTempFile(options: { suffix?: string } = {}): Promise<string> {
  const dir = await mkdtemp(pathJoin(tmpdir(), "takosumi-test-"));
  const file = pathJoin(dir, `tmp${options.suffix ?? ""}`);
  await writeFile(file, "");
  return file;
}

async function makeTempDir(options: { prefix?: string } = {}): Promise<string> {
  return await mkdtemp(pathJoin(tmpdir(), options.prefix ?? "takosumi-"));
}

async function removePath(
  target: string,
  options: { recursive?: boolean } = {},
): Promise<void> {
  await rm(target, { recursive: options.recursive ?? false, force: true });
}

async function writeTextFile(file: string, text: string): Promise<void> {
  await writeFile(file, text);
}

function envGet(name: string): string | undefined {
  return process.env[name];
}

function envSet(name: string, value: string): void {
  process.env[name] = value;
}

function envDelete(name: string): void {
  delete process.env[name];
}

async function testSha256HexDigest(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    textEncoder.encode(canonicalJson(value)),
  );
  return `sha256:${
    [...new Uint8Array(digest)].map((byte) =>
      byte.toString(16).padStart(2, "0")
    ).join("")
  }`;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${
      Object.keys(record).sort().map((key) =>
        `${JSON.stringify(key)}:${canonicalJson(record[key])}`
      ).join(",")
    }}`;
  }
  return JSON.stringify(value ?? null);
}

test("accounts seed prints a stable seed plan", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await main([
    "accounts",
    "seed",
    "--issuer",
    "https://accounts.example.test/",
    "--subject",
    "tsub_test",
    "--client-id",
    "takos-test",
    "--redirect-uri",
    "http://localhost:3000/callback,http://localhost:3001/callback",
  ], {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
  });

  expect(code).toEqual(0);
  expect(stderr).toEqual([]);
  const plan = JSON.parse(stdout.join("\n"));
  expect(plan.kind).toEqual("takosumi.accounts.seed@v1");
  expect(plan.issuer).toEqual("https://accounts.example.test");
  expect(plan.subject).toEqual("tsub_test");
  expect(plan.oidcClient.clientId).toEqual("takos-test");
  expect(plan.oidcClient.redirectUris).toEqual([
    "http://localhost:3000/callback",
    "http://localhost:3001/callback",
  ]);
});

test("accounts seed rejects non Takosumi subjects", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await main([
    "accounts",
    "seed",
    "--issuer",
    "https://accounts.example.test/",
    "--subject",
    "user_1",
  ], {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
  });

  expect(code).toEqual(2);
  expect(stdout).toEqual([]);
  expect(stderr).toEqual(["--subject must use the tsub_ prefix"]);
});

test("accounts seed default issuer is a generic localhost placeholder, never a takosumi.com host", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await main(["accounts", "seed", "--subject", "tsub_test"], {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
  });

  expect(code).toEqual(0);
  expect(stderr).toEqual([]);
  const plan = JSON.parse(stdout.join("\n"));
  expect(plan.issuer).toEqual("http://localhost:8787");
  expect(plan.issuer).not.toContain("takosumi.com");
});

type ManagedOfferingTemplateEntryForTest = Record<string, unknown> & {
  id?: unknown;
  requiredEvidenceTypes?: unknown;
};

type ManagedOfferingTemplateForTest = Record<string, unknown> & {
  rehearsalRun: Record<string, unknown>;
  domains: ManagedOfferingTemplateEntryForTest[];
  rehearsal: ManagedOfferingTemplateEntryForTest[];
};

const managedOfferingRehearsalStepIdsForTest = [
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
];

async function managedOfferingTemplateForTest(): Promise<
  ManagedOfferingTemplateForTest
> {
  const stdout: string[] = [];
  const code = await main(["launch-readiness", "template"], {
    stdout: (line) => stdout.push(line),
    stderr: () => undefined,
  });
  expect(code).toEqual(0);
  return JSON.parse(stdout.join("\n")) as ManagedOfferingTemplateForTest;
}

async function writeManagedOfferingReadinessForTest(
  file: string,
  document: unknown,
): Promise<string> {
  await writeTextFile(file, JSON.stringify(document));
  return await testSha256HexDigest(document);
}

function completeManagedOfferingEntry(
  rawEntry: ManagedOfferingTemplateEntryForTest,
  runId?: string,
): Record<string, unknown> {
  const requiredTypes = Array.isArray(rawEntry.requiredEvidenceTypes)
    ? rawEntry.requiredEvidenceTypes.filter((type): type is string =>
      typeof type === "string"
    )
    : ["command-transcript"];
  const id = typeof rawEntry.id === "string" ? rawEntry.id : "unknown";
  const rehearsalStepIndex = runId
    ? managedOfferingRehearsalStepIdsForTest.indexOf(id)
    : -1;
  const completedAt = rehearsalStepIndex >= 0
    ? `2026-05-12T01:${String(rehearsalStepIndex).padStart(2, "0")}:00Z`
    : "2026-05-12T01:00:00Z";
  return {
    ...rawEntry,
    ...(runId ? { runId } : {}),
    status: "passed",
    owner: "ops",
    environment: id === "production-topology"
      ? "staging+production"
      : "staging",
    reviewer: "release-owner",
    completedAt,
    evidence: requiredTypes.map((type) => ({
      type,
      ref: `runbook://managed-offering/${id}/${type}`,
      summary: `${id} ${type} evidence recorded in staging`,
      private: true,
      publicSummary:
        `${id} ${type} was reviewed as public-safe launch evidence.`,
      ...(runId ? { runId } : {}),
      ...structuredEvidenceFieldsForTest(type),
    })),
  };
}

function structuredEvidenceFieldsForTest(
  type: string,
): Record<string, unknown> {
  const topologyMatch = type.match(
    /^(staging|production)-(manifest|artifact-digest|migration-transcript|health-probe|tls-evidence|rollback-target)$/,
  );
  if (topologyMatch) {
    const topologyEnvironment = topologyMatch[1];
    switch (topologyMatch[2]) {
      case "manifest":
        return {
          topologyEnvironment,
          manifestRef:
            `artifact://topology/${topologyEnvironment}/manifest.json`,
          componentCount: 9,
        };
      case "artifact-digest":
        return {
          topologyEnvironment,
          artifactDigestEvidenceRef:
            `vault://topology/${topologyEnvironment}/artifact-digests`,
          deployableComponentCount: 6,
        };
      case "migration-transcript":
        return {
          topologyEnvironment,
          migrationTranscriptRef:
            `run://accounts-migrations/${topologyEnvironment}/2026-05-13`,
        };
      case "health-probe":
        return {
          topologyEnvironment,
          healthProbeEvidenceRef:
            `vault://topology/${topologyEnvironment}/health-probes`,
          healthProbeCount: 9,
        };
      case "tls-evidence":
        return {
          topologyEnvironment,
          tlsEvidenceRef: `vault://topology/${topologyEnvironment}/tls`,
        };
      case "rollback-target":
        return {
          topologyEnvironment,
          rollbackRef:
            `release://takosumi/${topologyEnvironment}/previous`,
          rollbackRole: "accounts",
          artifactDigest: testSha256Digest,
        };
    }
  }
  switch (type) {
    case "launch-brief":
      return {
        briefRef: "doc://launch/brief",
        targetCustomer: "early-self-hostable-team",
        launchScope: "managed-takos-starter",
        sku: "starter",
        quotaPlanRef: "policy://launch/starter-quotas",
        billingMeterRef: "meter://agent-compute-minutes",
        supportTier: "standard",
        supportSlaRef: "policy://support/standard-sla",
        freeTrialPolicyRef: "policy://billing/free-trial",
        acceptedUsePolicyRef: "policy://abuse/accepted-use",
        betaScopeRef: "doc://launch/beta-scope",
      };
    case "operator-signoff":
      return {
        signoffId: "signoff_launch_rehearsal",
        signedBy: "operator-owner",
      };
    case "stripe-sandbox":
      return {
        mode: "sandbox",
        checkoutSessionId: "cs_test_sandbox",
        webhookEventId: "evt_test_sandbox",
      };
    case "stripe-live":
      return {
        mode: "live",
        checkoutSessionId: "cs_live_rehearsal",
        webhookEventId: "evt_live_rehearsal",
      };
    case "entitlement":
      return {
        accountId: "acct_rehearsal",
        installationId: "inst_rehearsal",
        entitlementStatus: "active",
      };
    case "usage-meter":
      return {
        meter: "agent-compute-minutes",
        quantity: 42,
        usageReportId: "usage_rehearsal",
      };
    case "usage-aggregation-policy":
      return {
        policyRef: "runbook://billing/usage-aggregation-policy",
        windowStart: "2026-05-01T00:00:00Z",
        windowEnd: "2026-05-12T00:00:00Z",
      };
    case "invoice":
      return { invoiceId: "in_rehearsal", status: "paid" };
    case "tax-policy":
      return {
        policyRef: "runbook://billing/tax-policy",
        jurisdiction: "US",
      };
    case "plan-transition":
      return {
        subscriptionId: "sub_rehearsal",
        fromPlan: "starter",
        toPlan: "pro",
      };
    case "failed-payment":
      return {
        invoiceId: "in_failed_rehearsal",
        webhookEventId: "evt_payment_failed",
      };
    case "dunning":
      return {
        dunningRunId: "dunning_rehearsal",
        action: "suspend",
      };
    case "refund-credit":
      return {
        accountId: "acct_rehearsal",
        creditNoteId: "cn_rehearsal",
      };
    case "suspend-recover":
      return {
        suspensionEventId: "event_suspend_rehearsal",
        recoveryEventId: "event_recover_rehearsal",
      };
    case "oidc-conformance":
      return {
        conformanceRunId: "oidc_conformance_rehearsal",
        issuer: "https://accounts.takos.jp",
      };
    case "key-rotation-drill":
      return {
        rotationRunId: "key_rotation_rehearsal",
        keyId: "kid-rehearsal",
      };
    case "client-secret-rotation":
      return {
        rotationRunId: "client_secret_rotation_rehearsal",
        clientId: "client_rehearsal",
        oldSecretId: "secret_old_rehearsal",
        newSecretId: "secret_new_rehearsal",
        overlapWindowSeconds: 600,
        revocationEventId: "client_secret_revocation_rehearsal",
      };
    case "passkey-e2e":
      return {
        e2eRunId: "passkey_e2e_rehearsal",
        browser: "chromium",
      };
    case "rate-limit-test":
      return {
        testRunId: "rate_limit_rehearsal",
        policyRef: "policy://accounts/rate-limit",
      };
    case "audit-event":
      return {
        auditEventId: "audit_event_rehearsal",
        subject: "tsub_rehearsal",
      };
    case "fresh-user-smoke":
      return {
        smokeRunId: "fresh_user_smoke_rehearsal",
        accountId: "acct_rehearsal",
        spaceId: "space_rehearsal",
      };
    case "email-assurance":
      return {
        accountId: "acct_rehearsal",
        assuranceMethod: "email-verified",
        verifiedAt: "2026-05-12T00:30:00Z",
      };
    case "team-membership":
      return {
        accountId: "acct_rehearsal",
        spaceId: "space_rehearsal",
        membershipRole: "owner",
        membershipEventId: "membership_rehearsal",
      };
    case "quota-plan":
      return {
        planId: "starter",
        quotaPlanRef: "policy://quota/starter",
      };
    case "spend-cap":
      return {
        installationId: "inst_rehearsal",
        spendCapRef: "policy://spend-cap/starter",
        cap: 100,
        currency: "USD",
      };
    case "llm-tool-usage-cap":
      return {
        llmUsageCapRef: "policy://usage/llm-cap",
        toolUsageCapRef: "policy://usage/tool-cap",
      };
    case "quota-spike-drill":
      return {
        spikeRunId: "quota_spike_rehearsal",
        accountId: "acct_rehearsal",
        installationId: "inst_rehearsal",
        meter: "agent-compute-minutes",
        cap: 100,
        guardResult: "blocked",
      };
    case "noisy-tenant-throttle":
      return {
        throttleRunId: "noisy_tenant_throttle_rehearsal",
        tenantId: "tenant_rehearsal",
        result: "throttled",
      };
    case "deploy-kill-switch":
      return {
        killSwitchRunId: "deploy_kill_switch_rehearsal",
        deploymentId: "deploy_rehearsal",
        guardResult: "blocked",
      };
    case "abuse-queue-review":
      return {
        queueReviewId: "abuse_review_rehearsal",
        reviewQueueRef: "queue://abuse/rehearsal",
        decision: "reviewed",
      };
    case "operator-override":
      return {
        overrideEventId: "override_rehearsal",
        operatorId: "operator_rehearsal",
      };
    case "load-test":
      return {
        loadRunId: "shared_cell_load_rehearsal",
        tenantCount: 2,
        tenantAInstallationId: "inst_tenant_a",
        tenantBInstallationId: "inst_tenant_b",
        runtimeCellId: "cell_rehearsal",
      };
    case "isolation-test":
      return {
        isolationCheckId: "isolation_rehearsal",
        result: "passed",
      };
    case "metric-labels":
      return {
        dashboardRef: "dashboard://runtime/metrics",
        labelSet: "installation_id,tenant_id",
      };
    case "scale-drain-event":
      return {
        runtimeCellId: "cell_rehearsal",
        eventId: "scale_drain_event",
      };
    case "evacuation-record":
      return {
        evacuationRunId: "evacuation_rehearsal",
        runtimeCellId: "cell_rehearsal",
      };
    case "materialize-drill":
      return {
        materializeOperationId: "mat_rehearsal",
        installationId: "inst_rehearsal",
      };
    case "readiness-probe":
      return {
        probeRunId: "readiness_probe_rehearsal",
        endpoint: "https://app.takos.jp/health",
      };
    case "continuity-evidence":
      return {
        continuityCheckId: "continuity_rehearsal",
        installationId: "inst_rehearsal",
        sourceCommit: "abcdef0123456789abcdef0123456789abcdef01",
        oidcClientId: "oidc_client_rehearsal",
        domainName: "app.takos.jp",
        dataNamespace: "namespace_rehearsal",
        permissionScopeDigest: testSha256Digest,
        noDataLossCheckId: "no_data_loss_rehearsal",
      };
    case "encrypted-export":
      return {
        exportId: "export_rehearsal",
        archiveDigest: testSha256Digest,
        ageRecipient: "age1rehearsal",
      };
    case "self-host-import":
      return {
        importId: "import_rehearsal",
        targetHost: "selfhost.takos.local",
        oidcIssuer: "https://selfhost.takos.local/accounts",
      };
    case "sample-data-verification":
      return {
        verificationRunId: "sample_data_rehearsal",
        dataClasses: "chat,memory,file,git,default-app",
      };
    case "restore-transcript":
      return {
        restoreRunId: "restore_rehearsal",
        targetEnvironment: "staging-restore",
        transcriptRef: "run://restore/rehearsal",
      };
    case "dr-simulation":
      return {
        simulationRunId: "dr_simulation_rehearsal",
        scenario: "single-region-restore",
        decisionRef: "doc://dr/single-region-decision",
      };
    case "rpo-rto-sample":
      return {
        rpoSeconds: 60,
        rtoSeconds: 600,
      };
    case "audit-chain-verification":
      return {
        auditChainRef: "audit://chain/rehearsal",
        verificationRunId: "audit_verify_rehearsal",
      };
    case "restore-target-smoke":
      return {
        restoreTargetId: "restore_target_rehearsal",
        smokeRunId: "restore_target_smoke",
        result: "passed",
      };
    case "ci-equivalent":
      return {
        ciRunId: "ci_rehearsal",
        conclusion: "success",
      };
    case "sbom":
      return {
        sbomRef: "artifact://sbom/rehearsal.spdx.json",
        artifactDigest: testSha256Digest,
      };
    case "signature":
      return {
        signatureRef: "sig://artifact/rehearsal",
        keyId: "cosign-key-rehearsal",
      };
    case "image-digest":
      return {
        imageDigest: testSha256Digest,
      };
    case "package-version":
      return {
        packageName: "takosumi",
        packageVersion: "1.0.0-rc.1",
      };
    case "branch-protection-export":
      return {
        exportRef: "artifact://github/branch-protection.json",
        repository: "takosumi",
        reviewedAt: "2026-05-12T01:00:00Z",
      };
    case "artifact-policy":
      return {
        policyRef: "policy://release/immutable-artifacts",
        immutabilityRef: "artifact://release/immutability-check",
      };
    case "rollback-drill":
      return {
        rollbackRunId: "rollback_rehearsal",
        targetDigest: testSha256Digest,
      };
    case "threat-model":
      return {
        threatModelRef: "doc://security/threat-model",
        acceptedBy: "security-owner",
      };
    case "sandbox-review":
      return {
        reviewId: "sandbox_review_rehearsal",
        decision: "accepted",
      };
    case "vulnerability-sla":
      return {
        policyRef: "doc://security/vulnerability-sla",
        dashboardRef: "dashboard://vuln-sla",
      };
    case "secret-inventory":
      return {
        inventoryRef: "vault://secret-inventory/rehearsal",
        reviewedAt: "2026-05-12T01:00:00Z",
      };
    case "secret-rotation-run-log":
      return {
        rotationRunId: "secret_rotation_rehearsal",
        completedAt: "2026-05-12T01:30:00Z",
        result: "passed",
      };
    case "security-contact":
      return {
        contactTestId: "security_contact_rehearsal",
        result: "delivered",
      };
    case "deploy-control-abuse-blocked":
      return {
        scenarioId: "deploy_control_abuse_scenario",
        blockEventId: "deploy_control_abuse_block",
        policyRef: "policy://deploy-control/abuse-controls",
      };
    case "dashboard-link":
      return {
        dashboardRef: "dashboard://slo/managed-offering",
        panelId: "signup-login-install",
      };
    case "alert-routing":
      return {
        alertRouteId: "alert_route_rehearsal",
        primaryOncall: "primary-oncall",
      };
    case "synthetic-probe":
      return {
        probeId: "synthetic_probe_rehearsal",
        endpoint: "https://accounts.takos.jp/.well-known/openid-configuration",
        coveredEndpoints: ["signup", "login", "install", "launch", "export"],
      };
    case "sev-drill":
      return {
        incidentId: "sev_rehearsal",
        drillRunId: "sev_drill_rehearsal",
      };
    case "status-update":
      return {
        incidentId: "incident_rehearsal",
        statusPageUpdateId: "status_update_rehearsal",
      };
    case "legal-signoff":
      return {
        signoffId: "legal_signoff_rehearsal",
        signedBy: "legal-owner",
      };
    case "public-legal-pages":
      return {
        termsUrl: "https://docs.takos.jp/legal/terms",
        privacyUrl: "https://docs.takos.jp/legal/privacy",
        dpaUrl: "https://docs.takos.jp/legal/dpa",
      };
    case "support-mailbox-test":
      return {
        mailbox: "support@takos.jp",
        testId: "support_mailbox_rehearsal",
      };
    case "sar-delete-rehearsal":
      return {
        requestId: "sar_rehearsal",
        result: "passed",
      };
    case "billing-support-runbook":
      return {
        runbookRef: "runbook://support/billing",
        owner: "support-owner",
      };
    case "onboarding-guide":
      return {
        guideRef: "doc://customer/onboarding",
        reviewedBy: "support-owner",
      };
    case "admin-guide":
      return {
        guideRef: "doc://customer/admin",
        reviewedBy: "support-owner",
      };
    case "billing-faq":
      return {
        faqRef: "doc://customer/billing-faq",
        reviewedBy: "support-owner",
      };
    case "export-guide":
      return {
        guideRef: "doc://customer/export",
        reviewedBy: "support-owner",
      };
    case "escalation-matrix":
      return {
        matrixRef: "doc://customer/escalation",
        reviewedBy: "support-owner",
      };
    case "suspension-delete-export-wording":
      return {
        wordingRef: "doc://customer/lifecycle-wording",
        reviewedBy: "support-owner",
      };
    case "signup-event":
      return {
        eventId: "signup_event_rehearsal",
        accountId: "acct_rehearsal",
        spaceId: "space_rehearsal",
      };
    case "terms-acceptance":
      return {
        eventId: "terms_event_rehearsal",
        accountId: "acct_rehearsal",
        termsVersion: "2026-05-13",
      };
    case "entitlement-event":
      return {
        eventId: "entitlement_event_rehearsal",
        accountId: "acct_rehearsal",
        entitlementId: "ent_rehearsal",
      };
    case "launch-token-consume":
      return {
        installationId: "inst_rehearsal",
        launchTokenJti: "jti_rehearsal",
        sessionId: "session_rehearsal",
      };
    case "bundled-app-install":
      return {
        spaceId: "space_rehearsal",
        bundledAppInstallationIds: "docs,slide,excel,computer,yurucommu",
        eventId: "bundled_install_event",
      };
    case "default-app-reinstall":
      return {
        spaceId: "space_rehearsal",
        appId: "takos-docs",
        reinstallEventId: "reinstall_event",
      };
    case "default-app-uninstall":
      return {
        spaceId: "space_rehearsal",
        appId: "takos-docs",
        uninstallEventId: "uninstall_event",
      };
    case "installation-plan-run":
      return {
        sourceUrl: "https://github.com/tako0614/takos-docs.git",
        commitSha: "abcdef0123456789abcdef0123456789abcdef01",
        planDigest: testSha256Digest,
      };
    case "cost-review":
      return {
        planDigest: testSha256Digest,
        costEstimateId: "cost_estimate_rehearsal",
        approvedBy: "release-owner",
      };
    case "install-apply":
      return {
        installationId: "inst_rehearsal",
        deploymentId: "dep_rehearsal",
        applyEventId: "install_apply_event",
        planDigest: testSha256Digest,
      };
    case "oidc-login":
      return {
        installationId: "inst_rehearsal",
        oidcClientId: "client_rehearsal",
        sessionId: "app_session_rehearsal",
      };
    case "event-hash-chain":
      return {
        installationId: "inst_rehearsal",
        firstEventHash: testSha256Digest,
        lastEventHash: testSha256Digest,
      };
    case "quota-exceeded":
      return {
        accountId: "acct_rehearsal",
        meter: "agent-compute-minutes",
        cap: 100,
      };
    case "guard-action":
      return {
        accountId: "acct_rehearsal",
        action: "blocked",
        eventId: "guard_action_event",
      };
    case "override-audit":
      return {
        accountId: "acct_rehearsal",
        overrideEventId: "override_audit_event",
        reviewer: "release-owner",
      };
    case "two-tenant-load":
      return {
        tenantAInstallationId: "inst_tenant_a",
        tenantBInstallationId: "inst_tenant_b",
        runtimeCellId: "cell_rehearsal",
        loadRunId: "two_tenant_load",
      };
    case "isolation-proof":
      return {
        loadRunId: "two_tenant_load",
        isolationCheckId: "isolation_proof",
        result: "passed",
      };
    case "per-installation-metrics":
      return {
        runtimeCellId: "cell_rehearsal",
        tenantAInstallationId: "inst_tenant_a",
        tenantBInstallationId: "inst_tenant_b",
        metricsDashboardRef: "dashboard://runtime/per-installation",
      };
    case "scale-or-drain":
      return {
        runtimeCellId: "cell_rehearsal",
        eventId: "scale_or_drain_event",
        action: "drain",
      };
    case "readiness-before-cutover":
      return {
        installationId: "inst_rehearsal",
        probeRunId: "readiness_before_cutover",
        targetRuntimeTargetId: "rtb_dedicated",
      };
    case "materialize-cutover":
      return {
        installationId: "inst_rehearsal",
        materializeOperationId: "mat_rehearsal",
        targetRuntimeTargetId: "rtb_dedicated",
      };
    case "rollback-before-final":
      return {
        installationId: "inst_rehearsal",
        rollbackOperationId: "rollback_before_final",
        sourceRuntimeTargetId: "rtb_shared",
      };
    case "domain-preservation":
      return {
        installationId: "inst_rehearsal",
        domainName: "app.takos.jp",
        oidcClientId: "client_rehearsal",
      };
    case "preserve-evidence":
      return {
        installationId: "inst_rehearsal",
        sourceCommit: "abcdef0123456789abcdef0123456789abcdef01",
        oidcClientId: "client_rehearsal",
        domainName: "app.takos.jp",
        dataNamespace: "ns_rehearsal",
      };
    case "clean-import":
      return {
        importId: "import_rehearsal",
        targetHost: "selfhost.takos.local",
        result: "passed",
      };
    case "post-import-login":
      return {
        importId: "import_rehearsal",
        accountId: "acct_rehearsal",
        sessionId: "selfhost_session_rehearsal",
      };
    case "source-retention-state":
      return {
        accountId: "acct_rehearsal",
        retentionRecordId: "source_retention_rehearsal",
        state: "retained",
      };
    case "alert":
      return {
        incidentId: "incident_rehearsal",
        alertId: "alert_rehearsal",
      };
    case "ack":
      return {
        incidentId: "incident_rehearsal",
        acknowledgedBy: "primary-oncall",
      };
    case "postmortem":
      return {
        incidentId: "incident_rehearsal",
        mitigationEventId: "mitigation_rehearsal",
        postmortemRef: "doc://incident/postmortem",
        actionItemRef: "issue://incident/action-item",
      };
    case "release-promotion":
      return {
        releaseCandidate: "takosumi@1.0.0-rc.1",
        imageDigest: testSha256Digest,
        deployRunId: "deploy_rehearsal",
      };
    case "rollback":
      return {
        releaseCandidate: "takosumi@1.0.0-rc.1",
        rollbackRunId: "rollback_rehearsal",
        targetDigest: testSha256Digest,
      };
    case "support-note":
      return {
        releaseCandidate: "takosumi@1.0.0-rc.1",
        supportNoteRef: "doc://support/release-note",
      };
    case "export-or-delete-request":
      return {
        requestId: "privacy_request_rehearsal",
        accountId: "acct_rehearsal",
        requestType: "export",
      };
    case "login-disabled-or-exported":
      return {
        requestId: "privacy_request_rehearsal",
        accountId: "acct_rehearsal",
        result: "exported",
      };
    case "retention-record":
      return {
        requestId: "privacy_request_rehearsal",
        retentionRecordId: "retention_rehearsal",
        policyRef: "policy://privacy/retention",
      };
    case "invoice-paid":
      return {
        invoiceId: "in_paid_rehearsal",
        webhookEventId: "evt_invoice_paid",
      };
    case "dunning-suspension":
      return {
        invoiceId: "in_failed_rehearsal",
        dunningRunId: "dunning_rehearsal",
        suspensionEventId: "billing_suspend_event",
      };
    case "recovery-refund-credit":
      return {
        accountId: "acct_rehearsal",
        recoveryEventId: "billing_recovery_event",
        creditNoteId: "cn_recovery_rehearsal",
      };
    default:
      return {};
  }
}

function completeRehearsalRun(id = "rehearsal-2026-05-13") {
  return {
    id,
    environment: "staging",
    owner: "ops",
    reviewer: "release-owner",
    startedAt: "2026-05-12T00:00:00Z",
    completedAt: "2026-05-12T02:00:00Z",
  };
}

const testSha256Digest =
  "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function completeWranglerConfigValidationForTest(): Record<string, unknown> {
  return {
    kind: "takosumi.cloudflare-rendered-config-validation@v1",
    ok: true,
    configDigest: testSha256Digest,
    mainPointsAtWorkerBundle: true,
    managedOfferingAccessClosed: true,
    d1BindingPresent: true,
    d1DatabaseBlockPresent: true,
    d1DatabaseIdPresent: true,
    d1DatabaseIdValid: true,
    d1DatabaseIdPlaceholder: false,
    r2BindingPresent: true,
    r2BucketBlockPresent: true,
    deployControlUrlPresent: true,
    deployControlUrlValid: true,
    deployControlUrlPlaceholder: false,
    containerConfigured: false,
    durableObjectPersistenceConfigured: false,
    workersDev: true,
    routeConfigured: false,
  };
}

function completeProductionTopologyForTest(
  environment: "staging" | "production" = "staging",
): Record<string, unknown> {
  return {
    kind: "takosumi.production-topology@v1",
    environment,
    owner: "ops",
    reviewer: "release-owner",
    completedAt: "2026-05-13T00:00:00Z",
    manifestRef: `artifact://topology/${environment}/manifest.json`,
    migrationTranscriptRef:
      `run://accounts-migrations/${environment}/2026-05-13`,
    tlsEvidenceRef: `vault://topology/${environment}/tls`,
    artifactDigestEvidenceRef:
      `vault://topology/${environment}/artifact-digests`,
    healthProbeEvidenceRef: `vault://topology/${environment}/health-probes`,
    rollbackTarget: {
      ref: "release://takosumi/previous",
      role: "accounts",
      artifactDigest: testSha256Digest,
    },
    components: [
      "accounts",
      "dashboard",
      "takosumi-deploy-control",
      "service",
      "object-storage",
      "dns-tls",
    ].map((role) => ({
      id: role,
      role,
      healthProbeRef: `probe://${environment}/${role}`,
      ...(role === "accounts"
        ? {
          runtime: "cloudflare-worker",
          containerRuntime: false,
          wranglerConfigRef:
            `artifact://topology/${environment}/accounts/wrangler.toml`,
          wranglerConfigValidation: completeWranglerConfigValidationForTest(),
          bindings: [
            "D1:TAKOSUMI_ACCOUNTS_DB",
            "R2:TAKOSUMI_ACCOUNTS_EXPORTS",
          ],
        }
        : {}),
      ...(role === "object-storage" || role === "dns-tls"
        ? {}
        : { artifactDigest: testSha256Digest }),
    })),
  };
}

test("launch-readiness validate accepts complete managed offering evidence", async () => {
  const file = await makeTempFile({ suffix: ".json" });
  const document = await managedOfferingTemplateForTest();
  const rehearsalRun = completeRehearsalRun();
  document.rehearsalRun = rehearsalRun;
  document.domains = document.domains.map((entry) =>
    completeManagedOfferingEntry(entry)
  );
  document.rehearsal = document.rehearsal.map((entry) =>
    completeManagedOfferingEntry(entry, rehearsalRun.id)
  );
  await writeTextFile(
    file,
    JSON.stringify(document),
  );

  try {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await main([
      "launch-readiness",
      "validate",
      "--file",
      file,
      "--json",
    ], {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    });

    expect(code).toEqual(0);
    expect(stderr).toEqual([]);
    const report = JSON.parse(stdout.join("\n"));
    expect(report.kind).toEqual("takosumi.managed-offering-readiness-report@v1");
    expect(report.ready).toEqual(true);
    expect(report.evidenceDigest).toEqual(await testSha256HexDigest(document));
    expect(report.missingDomains).toEqual([]);
    expect(report.missingRehearsalSteps).toEqual([]);
  } finally {
    await removePath(file);
  }
});

test("launch-readiness public-summary emits a public-safe ready summary", async () => {
  const file = await makeTempFile({ suffix: ".json" });
  const document = await managedOfferingTemplateForTest();
  const rehearsalRun = completeRehearsalRun(
    "rehearsal-2026-05-13-staging",
  );
  document.rehearsalRun = rehearsalRun;
  document.domains = document.domains.map((entry) =>
    completeManagedOfferingEntry(entry)
  );
  document.rehearsal = document.rehearsal.map((entry) =>
    completeManagedOfferingEntry(entry, rehearsalRun.id)
  );
  const evidenceDigest = await writeManagedOfferingReadinessForTest(
    file,
    document,
  );

  try {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await main([
      "launch-readiness",
      "public-summary",
      "--file",
      file,
      "--evidence-ref",
      "vault://managed-readiness/staging/rehearsal.json",
      "--public-summary",
      "P0 evidence and one staged launch rehearsal passed; operator approval remains separate.",
    ], {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    });

    expect(code).toEqual(0);
    expect(stderr).toEqual([]);
    const summary = JSON.parse(stdout.join("\n"));
    expect(summary.kind).toEqual("takosumi.managed-offering-public-summary@v1");
    expect(summary.ready).toEqual(true);
    expect(summary.status).toEqual("validator-passed");
    expect(summary.date).toEqual("2026-05-12");
    expect(summary.environment).toEqual("staging");
    expect(summary.rehearsalRun).toEqual("rehearsal-2026-05-13-staging");
    expect(summary.validator.evidenceDigest).toEqual(evidenceDigest);
    expect(summary.privateEvidenceRefClass).toEqual("vault://...");
  } finally {
    await removePath(file);
  }
});

test("launch-readiness public-summary emits a markdown row", async () => {
  const file = await makeTempFile({ suffix: ".json" });
  const document = await managedOfferingTemplateForTest();
  const rehearsalRun = completeRehearsalRun(
    "rehearsal-2026-05-13-staging",
  );
  document.rehearsalRun = rehearsalRun;
  document.domains = document.domains.map((entry) =>
    completeManagedOfferingEntry(entry)
  );
  document.rehearsal = document.rehearsal.map((entry) =>
    completeManagedOfferingEntry(entry, rehearsalRun.id)
  );
  const evidenceDigest = await writeManagedOfferingReadinessForTest(
    file,
    document,
  );

  try {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await main([
      "launch-readiness",
      "public-summary",
      "--file",
      file,
      "--evidence-ref",
      "vault://managed-readiness/staging/rehearsal.json",
      "--public-summary",
      "P0 evidence and one staged launch rehearsal passed; operator approval remains separate.",
      "--markdown-row",
    ], {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    });

    expect(code).toEqual(0);
    expect(stderr).toEqual([]);
    const row = stdout.join("\n");
    expect(row.startsWith("| 2026-05-12 | staging |")).toBeTruthy();
    expect(row.includes(`evidenceDigest:${evidenceDigest}`)).toBeTruthy();
    expect(row.includes("vault://...")).toBeTruthy();
  } finally {
    await removePath(file);
  }
});

test("launch-readiness public-summary reports blocked evidence without private refs", async () => {
  const file = await makeTempFile({ suffix: ".json" });
  const document = await managedOfferingTemplateForTest();
  await writeManagedOfferingReadinessForTest(file, document);

  try {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await main([
      "launch-readiness",
      "public-summary",
      "--file",
      file,
    ], {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    });

    expect(code).toEqual(0);
    expect(stderr).toEqual([]);
    const summary = JSON.parse(stdout.join("\n"));
    expect(summary.ready).toEqual(false);
    expect(summary.status).toEqual("blocked");
    expect(summary.privateEvidenceRefClass).toEqual(null);
    expect(summary.validator.incompleteDomains.includes("offering-definition")).toBeTruthy();
  } finally {
    await removePath(file);
  }
});

test("launch-readiness public-summary rejects ready summaries without private evidence ref", async () => {
  const file = await makeTempFile({ suffix: ".json" });
  const document = await managedOfferingTemplateForTest();
  const rehearsalRun = completeRehearsalRun();
  document.rehearsalRun = rehearsalRun;
  document.domains = document.domains.map((entry) =>
    completeManagedOfferingEntry(entry)
  );
  document.rehearsal = document.rehearsal.map((entry) =>
    completeManagedOfferingEntry(entry, rehearsalRun.id)
  );
  await writeManagedOfferingReadinessForTest(file, document);

  try {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await main([
      "launch-readiness",
      "public-summary",
      "--file",
      file,
    ], {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    });

    expect(code).toEqual(2);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual([
      "--evidence-ref is required when readiness evidence is validator-ready",
    ]);
  } finally {
    await removePath(file);
  }
});

test("launch-readiness public-summary rejects sensitive public text", async () => {
  const file = await makeTempFile({ suffix: ".json" });
  const document = await managedOfferingTemplateForTest();
  const rehearsalRun = completeRehearsalRun();
  document.rehearsalRun = rehearsalRun;
  document.domains = document.domains.map((entry) =>
    completeManagedOfferingEntry(entry)
  );
  document.rehearsal = document.rehearsal.map((entry) =>
    completeManagedOfferingEntry(entry, rehearsalRun.id)
  );
  await writeManagedOfferingReadinessForTest(file, document);

  try {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await main([
      "launch-readiness",
      "public-summary",
      "--file",
      file,
      "--evidence-ref",
      "vault://managed-readiness/staging/rehearsal.json",
      "--public-summary",
      "P0 evidence and one staged launch rehearsal passed for support@example.test arn:aws:iam::123456789012:role/internal acct_sensitive1 cs_live_sensitive1.",
    ], {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    });

    expect(code).toEqual(2);
    expect(stdout).toEqual([]);
    expect(stderr.join("\n").includes(
        "--managed-offering-public-summary must not contain email addresses",
      )).toBeTruthy();
    expect(stderr.join("\n").includes(
        "--managed-offering-public-summary must not contain provider account IDs",
      )).toBeTruthy();
    expect(stderr.join("\n").includes(
        "--managed-offering-public-summary must not contain internal resource IDs",
      )).toBeTruthy();
    expect(stderr.join("\n").includes(
        "--managed-offering-public-summary must not contain Stripe object IDs",
      )).toBeTruthy();
  } finally {
    await removePath(file);
  }
});

test("launch-readiness public-summary validate accepts generated summaries", async () => {
  const readinessFile = await makeTempFile({ suffix: ".json" });
  const summaryFile = await makeTempFile({ suffix: ".json" });
  const document = await managedOfferingTemplateForTest();
  const rehearsalRun = completeRehearsalRun(
    "rehearsal-2026-05-13-staging",
  );
  document.rehearsalRun = rehearsalRun;
  document.domains = document.domains.map((entry) =>
    completeManagedOfferingEntry(entry)
  );
  document.rehearsal = document.rehearsal.map((entry) =>
    completeManagedOfferingEntry(entry, rehearsalRun.id)
  );
  await writeManagedOfferingReadinessForTest(readinessFile, document);

  try {
    const summaryStdout: string[] = [];
    const summaryCode = await main([
      "launch-readiness",
      "public-summary",
      "--file",
      readinessFile,
      "--evidence-ref",
      "vault://managed-readiness/staging/rehearsal.json",
      "--public-summary",
      "P0 evidence and one staged launch rehearsal passed; operator approval remains separate.",
    ], {
      stdout: (line) => summaryStdout.push(line),
      stderr: () => undefined,
    });
    expect(summaryCode).toEqual(0);
    await writeTextFile(summaryFile, summaryStdout.join("\n"));

    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await main([
      "launch-readiness",
      "public-summary",
      "validate",
      "--file",
      summaryFile,
      "--readiness-file",
      readinessFile,
      "--json",
    ], {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    });

    expect(code).toEqual(0);
    expect(stderr).toEqual([]);
    const report = JSON.parse(stdout.join("\n"));
    expect(report.kind).toEqual("takosumi.managed-offering-public-summary-report@v1");
    expect(report.valid).toEqual(true);
    expect(report.ready).toEqual(true);
    expect(report.errors).toEqual([]);
  } finally {
    await removePath(readinessFile);
    await removePath(summaryFile);
  }
});

test("launch-readiness public-summary validate rejects raw private evidence ref class even while blocked", async () => {
  const readinessFile = await makeTempFile({ suffix: ".json" });
  const summaryFile = await makeTempFile({ suffix: ".json" });
  const document = await managedOfferingTemplateForTest();
  await writeManagedOfferingReadinessForTest(readinessFile, document);

  try {
    const summaryStdout: string[] = [];
    const summaryCode = await main([
      "launch-readiness",
      "public-summary",
      "--file",
      readinessFile,
    ], {
      stdout: (line) => summaryStdout.push(line),
      stderr: () => undefined,
    });
    expect(summaryCode).toEqual(0);
    const summary = JSON.parse(summaryStdout.join("\n"));
    summary.privateEvidenceRefClass =
      "vault://managed-readiness/staging/rehearsal.json";
    await writeTextFile(summaryFile, JSON.stringify(summary));

    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await main([
      "launch-readiness",
      "public-summary",
      "validate",
      "--file",
      summaryFile,
      "--readiness-file",
      readinessFile,
      "--json",
    ], {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    });

    expect(code).toEqual(1);
    expect(stderr).toEqual([]);
    const report = JSON.parse(stdout.join("\n"));
    expect(report.ready).toEqual(false);
    expect(report.errors.includes(
        "privateEvidenceRefClass must be null or a redacted scheme class",
      )).toBeTruthy();
  } finally {
    await removePath(readinessFile);
    await removePath(summaryFile);
  }
});

test("launch-readiness public-summary validate rejects drifted summaries", async () => {
  const readinessFile = await makeTempFile({ suffix: ".json" });
  const summaryFile = await makeTempFile({ suffix: ".json" });
  const document = await managedOfferingTemplateForTest();
  const rehearsalRun = completeRehearsalRun(
    "rehearsal-2026-05-13-staging",
  );
  document.rehearsalRun = rehearsalRun;
  document.domains = document.domains.map((entry) =>
    completeManagedOfferingEntry(entry)
  );
  document.rehearsal = document.rehearsal.map((entry) =>
    completeManagedOfferingEntry(entry, rehearsalRun.id)
  );
  await writeManagedOfferingReadinessForTest(readinessFile, document);

  try {
    const summaryStdout: string[] = [];
    const summaryCode = await main([
      "launch-readiness",
      "public-summary",
      "--file",
      readinessFile,
      "--evidence-ref",
      "vault://managed-readiness/staging/rehearsal.json",
      "--public-summary",
      "P0 evidence and one staged launch rehearsal passed; operator approval remains separate.",
    ], {
      stdout: (line) => summaryStdout.push(line),
      stderr: () => undefined,
    });
    expect(summaryCode).toEqual(0);
    const summary = JSON.parse(summaryStdout.join("\n"));
    summary.rehearsalRun = "rehearsal-other";
    summary.validator.evidenceDigest =
      "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    summary.validator.incompleteDomains = ["offering-definition"];
    summary.validator.missingRehearsalSteps = ["fresh-signup"];
    summary.publicResult =
      "P0 evidence and one staged launch rehearsal passed for cus_sensitive1.";
    await writeTextFile(summaryFile, JSON.stringify(summary));

    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await main([
      "launch-readiness",
      "public-summary",
      "validate",
      "--file",
      summaryFile,
      "--readiness-file",
      readinessFile,
      "--json",
    ], {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    });

    expect(code).toEqual(1);
    expect(stderr).toEqual([]);
    const report = JSON.parse(stdout.join("\n"));
    expect(report.valid).toEqual(false);
    expect(report.errors.includes(
        "validator.evidenceDigest must match readiness file digest",
      )).toBeTruthy();
    expect(report.errors.includes(
        "validator.incompleteDomains must match readiness validation result",
      )).toBeTruthy();
    expect(report.errors.includes(
        "validator.missingRehearsalSteps must match readiness validation result",
      )).toBeTruthy();
    expect(report.errors.includes("rehearsalRun must match readiness file")).toBeTruthy();
    expect(report.errors.includes(
        "--managed-offering-public-summary must not contain Stripe object IDs",
      )).toBeTruthy();
  } finally {
    await removePath(readinessFile);
    await removePath(summaryFile);
  }
});

test("launch-readiness validate rejects self-approved rehearsal runs", async () => {
  const file = await makeTempFile({ suffix: ".json" });
  const document = await managedOfferingTemplateForTest();
  const rehearsalRun = {
    ...completeRehearsalRun(),
    owner: "Ops ",
    reviewer: "ops",
  };
  document.rehearsalRun = rehearsalRun;
  document.domains = document.domains.map((entry) =>
    completeManagedOfferingEntry(entry)
  );
  document.rehearsal = document.rehearsal.map((entry) =>
    completeManagedOfferingEntry(entry, rehearsalRun.id)
  );

  try {
    await writeTextFile(file, JSON.stringify(document));
    const stdout: string[] = [];
    const code = await main([
      "launch-readiness",
      "validate",
      "--file",
      file,
      "--json",
    ], {
      stdout: (line) => stdout.push(line),
      stderr: () => undefined,
    });

    expect(code).toEqual(1);
    const report = JSON.parse(stdout.join("\n"));
    expect(report.ready).toEqual(false);
    expect(report.errors.includes("rehearsalRun.reviewer must differ from owner")).toBeTruthy();
  } finally {
    await removePath(file);
  }
});

test("launch-readiness validate rejects self-approved evidence entries", async () => {
  const file = await makeTempFile({ suffix: ".json" });
  const document = await managedOfferingTemplateForTest();
  const rehearsalRun = completeRehearsalRun();
  document.rehearsalRun = rehearsalRun;
  document.domains = document.domains.map((entry) =>
    completeManagedOfferingEntry(entry)
  );
  document.rehearsal = document.rehearsal.map((entry) =>
    completeManagedOfferingEntry(entry, rehearsalRun.id)
  );
  document.domains[0] = {
    ...document.domains[0],
    owner: "Ops ",
    reviewer: "ops",
  };
  document.rehearsal[0] = {
    ...document.rehearsal[0],
    owner: "Ops ",
    reviewer: "ops",
  };

  try {
    await writeTextFile(file, JSON.stringify(document));
    const stdout: string[] = [];
    const code = await main([
      "launch-readiness",
      "validate",
      "--file",
      file,
      "--json",
    ], {
      stdout: (line) => stdout.push(line),
      stderr: () => undefined,
    });

    expect(code).toEqual(1);
    const report = JSON.parse(stdout.join("\n"));
    expect(report.ready).toEqual(false);
    expect(report.incompleteDomains.includes("offering-definition")).toBeTruthy();
    expect(report.incompleteRehearsalSteps.includes("fresh-signup")).toBeTruthy();
    expect(report.errors.includes(
        "domains.offering-definition.reviewer must differ from owner",
      )).toBeTruthy();
    expect(report.errors.includes(
        "rehearsal.fresh-signup.reviewer must differ from owner",
      )).toBeTruthy();
  } finally {
    await removePath(file);
  }
});

test("launch-readiness validate fails closed for incomplete evidence", async () => {
  const file = await makeTempFile({ suffix: ".json" });
  await writeTextFile(
    file,
    JSON.stringify({
      kind: "takosumi.managed-offering-readiness@v1",
      rehearsalRun: {
        id: "",
        environment: "",
        owner: "",
        reviewer: "",
        startedAt: "",
        completedAt: "",
      },
      domains: [
        {
          id: "offering-definition",
          status: "blocked",
          owner: "ops",
          environment: "staging",
          reviewer: "release-owner",
          completedAt: "2026-05-13T00:00:00Z",
          evidence: [{
            type: "issue",
            ref: "issue://launch-brief",
            summary: "launch brief is not approved yet",
          }],
        },
      ],
      rehearsal: [],
    }),
  );

  try {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await main([
      "launch-readiness",
      "validate",
      "--file",
      file,
      "--json",
    ], {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    });

    expect(code).toEqual(1);
    expect(stderr).toEqual([]);
    const report = JSON.parse(stdout.join("\n"));
    expect(report.ready).toEqual(false);
    expect(report.incompleteDomains.includes("offering-definition")).toBeTruthy();
    expect(report.missingDomains.includes("production-topology")).toBeTruthy();
    expect(report.missingRehearsalSteps.includes("fresh-signup")).toBeTruthy();
  } finally {
    await removePath(file);
  }
});

test("launch-readiness template prints all required evidence ids as blocked", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await main(["launch-readiness", "template"], {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
  });

  expect(code).toEqual(0);
  expect(stderr).toEqual([]);
  const template = JSON.parse(stdout.join("\n"));
  expect(template.kind).toEqual("takosumi.managed-offering-readiness@v1");
  expect(template.rehearsalRun.id).toEqual("");
  expect(template.domains.length).toEqual(15);
  expect(template.rehearsal.length).toEqual(12);
  expect(template.domains.every((entry: { status: string }) =>
      entry.status === "blocked"
    )).toEqual(true);
  expect(template.domains.every((
      entry: { environment: string; reviewer: string },
    ) => entry.environment === "" && entry.reviewer === "")).toEqual(true);
  expect(template.rehearsal.some((entry: { id: string }) =>
      entry.id === "release-rollback"
    )).toEqual(true);
  expect(template.rehearsal.every((entry: { runId: string }) => entry.runId === "")).toEqual(true);
  const offeringDefinition = template.domains.find((
    entry: { id: string },
  ) => entry.id === "offering-definition");
  expect(offeringDefinition).toBeTruthy();
  expect(offeringDefinition.evidence.map((entry: { type: string }) => entry.type)).toEqual(offeringDefinition.requiredEvidenceTypes);
  expect(offeringDefinition.evidence[0].private).toEqual(true);
  expect(offeringDefinition.evidence[0].publicSummary).toEqual("");
  expect(offeringDefinition.evidence[0].briefRef).toEqual("vault://managed-readiness/<briefRef>");
  const billingOperation = template.rehearsal.find((
    entry: { id: string },
  ) => entry.id === "billing-operation");
  expect(billingOperation).toBeTruthy();
  expect(billingOperation.evidence.map((entry: { type: string }) => entry.type)).toEqual(billingOperation.requiredEvidenceTypes);
  expect(billingOperation.evidence[0].invoiceId).toEqual("<invoiceId>");
  expect(Object.fromEntries(
      template.domains.map((
        entry: { id: string; requiredEvidenceTypes: string[] },
      ) => [entry.id, entry.requiredEvidenceTypes]),
    )).toEqual({
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
    });
  expect(Object.fromEntries(
      template.rehearsal.map((
        entry: { id: string; requiredEvidenceTypes: string[] },
      ) => [entry.id, entry.requiredEvidenceTypes]),
    )).toEqual({
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
      "sev-simulation": ["alert", "ack", "status-update", "postmortem"],
      "release-rollback": ["release-promotion", "rollback", "support-note"],
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
    });
});

test("launch-readiness template output fails validation until evidence is filled", async () => {
  const templateStdout: string[] = [];
  const templateCode = await main(["launch-readiness", "template"], {
    stdout: (line) => templateStdout.push(line),
    stderr: () => undefined,
  });
  expect(templateCode).toEqual(0);

  const file = await makeTempFile({ suffix: ".json" });
  await writeTextFile(file, templateStdout.join("\n"));
  try {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await main([
      "launch-readiness",
      "validate",
      "--file",
      file,
      "--json",
    ], {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    });

    expect(code).toEqual(1);
    expect(stderr).toEqual([]);
    const report = JSON.parse(stdout.join("\n"));
    expect(report.ready).toEqual(false);
    expect(report.missingDomains).toEqual([]);
    expect(report.missingRehearsalSteps).toEqual([]);
    expect(report.incompleteDomains.includes("offering-definition")).toBeTruthy();
    expect(report.incompleteRehearsalSteps.includes("fresh-signup")).toBeTruthy();
  } finally {
    await removePath(file);
  }
});

test("launch-readiness validate rejects shallow evidence references", async () => {
  const file = await makeTempFile({ suffix: ".json" });
  await writeTextFile(
    file,
    JSON.stringify({
      kind: "takosumi.managed-offering-readiness@v1",
      rehearsalRun: {
        id: "rehearsal-2026-05-13",
        environment: "staging",
        owner: "ops",
        reviewer: "release-owner",
        startedAt: "2026-05-13T00:00:00Z",
        completedAt: "2026-05-13T02:00:00Z",
      },
      domains: [
        {
          id: "offering-definition",
          status: "passed",
          owner: "ops",
          environment: "staging",
          reviewer: "release-owner",
          completedAt: "2026-05-13T00:00:00Z",
          evidence: ["evidence://launch-brief"],
        },
      ],
      rehearsal: [],
    }),
  );

  try {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await main([
      "launch-readiness",
      "validate",
      "--file",
      file,
      "--json",
    ], {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    });

    expect(code).toEqual(1);
    expect(stderr).toEqual([]);
    const report = JSON.parse(stdout.join("\n"));
    expect(report.ready).toEqual(false);
    expect(report.incompleteDomains.includes("offering-definition")).toBeTruthy();
  } finally {
    await removePath(file);
  }
});

test("launch-readiness validate requires public summaries for private evidence", async () => {
  const file = await makeTempFile({ suffix: ".json" });
  const document = await managedOfferingTemplateForTest();
  const rehearsalRun = completeRehearsalRun();
  document.rehearsalRun = rehearsalRun;
  document.domains = document.domains.map((entry) =>
    completeManagedOfferingEntry(entry)
  );
  document.rehearsal = document.rehearsal.map((entry) =>
    completeManagedOfferingEntry(entry, rehearsalRun.id)
  );
  const offeringDefinition = document.domains.find((entry) =>
    entry.id === "offering-definition"
  ) as Record<string, unknown>;
  const evidence = offeringDefinition.evidence as Record<string, unknown>[];
  evidence[0] = { ...evidence[0], private: true };
  delete evidence[0].publicSummary;
  await writeTextFile(file, JSON.stringify(document));

  try {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await main([
      "launch-readiness",
      "validate",
      "--file",
      file,
      "--json",
    ], {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    });

    expect(code).toEqual(1);
    expect(stderr).toEqual([]);
    const report = JSON.parse(stdout.join("\n"));
    expect(report.ready).toEqual(false);
    expect(report.incompleteDomains.includes("offering-definition")).toBeTruthy();
  } finally {
    await removePath(file);
  }
});

test("launch-readiness validate requires evidence to be marked private", async () => {
  const file = await makeTempFile({ suffix: ".json" });
  const document = await managedOfferingTemplateForTest();
  const rehearsalRun = completeRehearsalRun();
  document.rehearsalRun = rehearsalRun;
  document.domains = document.domains.map((entry) =>
    completeManagedOfferingEntry(entry)
  );
  document.rehearsal = document.rehearsal.map((entry) =>
    completeManagedOfferingEntry(entry, rehearsalRun.id)
  );
  const offeringDefinition = document.domains.find((entry) =>
    entry.id === "offering-definition"
  ) as Record<string, unknown>;
  const evidence = offeringDefinition.evidence as Record<string, unknown>[];
  evidence[0] = { ...evidence[0], private: false };
  await writeTextFile(file, JSON.stringify(document));

  try {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await main([
      "launch-readiness",
      "validate",
      "--file",
      file,
      "--json",
    ], {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    });

    expect(code).toEqual(1);
    expect(stderr).toEqual([]);
    const report = JSON.parse(stdout.join("\n"));
    expect(report.ready).toEqual(false);
    expect(report.incompleteDomains.includes("offering-definition")).toBeTruthy();
  } finally {
    await removePath(file);
  }
});

test("launch-readiness validate rejects placeholder public summaries for private evidence", async () => {
  const file = await makeTempFile({ suffix: ".json" });
  const document = await managedOfferingTemplateForTest();
  const rehearsalRun = completeRehearsalRun();
  document.rehearsalRun = rehearsalRun;
  document.domains = document.domains.map((entry) =>
    completeManagedOfferingEntry(entry)
  );
  document.rehearsal = document.rehearsal.map((entry) =>
    completeManagedOfferingEntry(entry, rehearsalRun.id)
  );
  const offeringDefinition = document.domains.find((entry) =>
    entry.id === "offering-definition"
  ) as Record<string, unknown>;
  const evidence = offeringDefinition.evidence as Record<string, unknown>[];
  evidence[0] = {
    ...evidence[0],
    private: true,
    publicSummary: "todo",
  };
  await writeTextFile(file, JSON.stringify(document));

  try {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await main([
      "launch-readiness",
      "validate",
      "--file",
      file,
      "--json",
    ], {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    });

    expect(code).toEqual(1);
    expect(stderr).toEqual([]);
    const report = JSON.parse(stdout.join("\n"));
    expect(report.ready).toEqual(false);
    expect(report.incompleteDomains.includes("offering-definition")).toBeTruthy();
  } finally {
    await removePath(file);
  }
});

test("launch-readiness validate accepts private evidence summaries without launch-scope boilerplate", async () => {
  const file = await makeTempFile({ suffix: ".json" });
  const document = await managedOfferingTemplateForTest();
  const rehearsalRun = completeRehearsalRun();
  document.rehearsalRun = rehearsalRun;
  document.domains = document.domains.map((entry) =>
    completeManagedOfferingEntry(entry)
  );
  document.rehearsal = document.rehearsal.map((entry) =>
    completeManagedOfferingEntry(entry, rehearsalRun.id)
  );
  const offeringDefinition = document.domains.find((entry) =>
    entry.id === "offering-definition"
  ) as Record<string, unknown>;
  const evidence = offeringDefinition.evidence as Record<string, unknown>[];
  evidence[0] = {
    ...evidence[0],
    private: true,
    publicSummary:
      "Launch brief was reviewed in staging without private tenant data.",
  };
  await writeTextFile(file, JSON.stringify(document));

  try {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await main([
      "launch-readiness",
      "validate",
      "--file",
      file,
      "--json",
    ], {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    });

    expect(code).toEqual(0);
    expect(stderr).toEqual([]);
    const report = JSON.parse(stdout.join("\n"));
    expect(report.ready).toEqual(true);
  } finally {
    await removePath(file);
  }
});

test("launch-readiness validate rejects sensitive public summaries for private evidence", async () => {
  const file = await makeTempFile({ suffix: ".json" });
  const document = await managedOfferingTemplateForTest();
  const rehearsalRun = completeRehearsalRun();
  document.rehearsalRun = rehearsalRun;
  document.domains = document.domains.map((entry) =>
    completeManagedOfferingEntry(entry)
  );
  document.rehearsal = document.rehearsal.map((entry) =>
    completeManagedOfferingEntry(entry, rehearsalRun.id)
  );
  const offeringDefinition = document.domains.find((entry) =>
    entry.id === "offering-definition"
  ) as Record<string, unknown>;
  const evidence = offeringDefinition.evidence as Record<string, unknown>[];
  evidence[0] = {
    ...evidence[0],
    private: true,
    publicSummary:
      "Launch brief reviewed for cus_sensitive1 by support@example.test.",
  };
  await writeTextFile(file, JSON.stringify(document));

  try {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await main([
      "launch-readiness",
      "validate",
      "--file",
      file,
      "--json",
    ], {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    });

    expect(code).toEqual(1);
    expect(stderr).toEqual([]);
    const report = JSON.parse(stdout.join("\n"));
    expect(report.ready).toEqual(false);
    expect(report.incompleteDomains.includes("offering-definition")).toBeTruthy();
  } finally {
    await removePath(file);
  }
});

test("launch-readiness validate requires billing launch policy evidence", async () => {
  const file = await makeTempFile({ suffix: ".json" });
  const document = await managedOfferingTemplateForTest();
  const rehearsalRun = completeRehearsalRun();
  document.rehearsalRun = rehearsalRun;
  document.domains = document.domains.map((entry) =>
    completeManagedOfferingEntry(entry)
  );
  document.rehearsal = document.rehearsal.map((entry) =>
    completeManagedOfferingEntry(entry, rehearsalRun.id)
  );
  const billing = document.domains.find((entry) =>
    entry.id === "billing-entitlement"
  ) as Record<string, unknown>;
  billing.evidence = (billing.evidence as Record<string, unknown>[])
    .filter((entry) => entry.type !== "tax-policy");
  await writeTextFile(file, JSON.stringify(document));

  try {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await main([
      "launch-readiness",
      "validate",
      "--file",
      file,
      "--json",
    ], {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    });

    expect(code).toEqual(1);
    expect(stderr).toEqual([]);
    const report = JSON.parse(stdout.join("\n"));
    expect(report.ready).toEqual(false);
    expect(report.incompleteDomains.includes("billing-entitlement")).toBeTruthy();
  } finally {
    await removePath(file);
  }
});

test("launch-readiness validate requires structured high-risk P0 evidence", async () => {
  const file = await makeTempFile({ suffix: ".json" });
  const document = await managedOfferingTemplateForTest();
  const rehearsalRun = completeRehearsalRun();
  document.rehearsalRun = rehearsalRun;
  document.domains = document.domains.map((entry) =>
    completeManagedOfferingEntry(entry)
  );
  document.rehearsal = document.rehearsal.map((entry) =>
    completeManagedOfferingEntry(entry, rehearsalRun.id)
  );

  const backup = document.domains.find((entry) => entry.id === "backup-dr")!;
  const release = document.domains.find((entry) =>
    entry.id === "release-provenance"
  )!;
  const security = document.domains.find((entry) =>
    entry.id === "security-operations"
  )!;
  (backup.evidence as Array<Record<string, unknown>>).find((entry) =>
    entry.type === "rpo-rto-sample"
  )!.rpoSeconds = "";
  delete (release.evidence as Array<Record<string, unknown>>).find((entry) =>
    entry.type === "image-digest"
  )!.imageDigest;
  delete (security.evidence as Array<Record<string, unknown>>).find((entry) =>
    entry.type === "security-contact"
  )!.contactTestId;

  try {
    await writeTextFile(file, JSON.stringify(document));
    const stdout: string[] = [];
    const code = await main([
      "launch-readiness",
      "validate",
      "--file",
      file,
      "--json",
    ], {
      stdout: (line) => stdout.push(line),
      stderr: () => undefined,
    });

    expect(code).toEqual(1);
    const report = JSON.parse(stdout.join("\n"));
    expect(report.ready).toEqual(false);
    expect(report.incompleteDomains.includes("backup-dr")).toBeTruthy();
    expect(report.incompleteDomains.includes("release-provenance")).toBeTruthy();
    expect(report.incompleteDomains.includes("security-operations")).toBeTruthy();
  } finally {
    await removePath(file);
  }
});

test("launch-readiness validate requires structured staged rehearsal evidence", async () => {
  const file = await makeTempFile({ suffix: ".json" });
  const document = await managedOfferingTemplateForTest();
  const rehearsalRun = completeRehearsalRun();
  document.rehearsalRun = rehearsalRun;
  document.domains = document.domains.map((entry) =>
    completeManagedOfferingEntry(entry)
  );
  document.rehearsal = document.rehearsal.map((entry) =>
    completeManagedOfferingEntry(entry, rehearsalRun.id)
  );

  const freshSignup = document.rehearsal.find((entry) =>
    entry.id === "fresh-signup"
  )!;
  const oidcSecurity = document.domains.find((entry) =>
    entry.id === "oidc-account-security"
  )!;
  const gitInstall = document.rehearsal.find((entry) =>
    entry.id === "git-url-install"
  )!;
  const billingOperation = document.rehearsal.find((entry) =>
    entry.id === "billing-operation"
  )!;
  delete (freshSignup.evidence as Array<Record<string, unknown>>).find((
    entry,
  ) => entry.type === "team-membership")!.membershipEventId;
  delete (oidcSecurity.evidence as Array<Record<string, unknown>>).find((
    entry,
  ) => entry.type === "client-secret-rotation")!.revocationEventId;
  delete (gitInstall.evidence as Array<Record<string, unknown>>).find((
    entry,
  ) => entry.type === "install-apply")!.planDigest;
  delete (billingOperation.evidence as Array<Record<string, unknown>>).find((
    entry,
  ) => entry.type === "recovery-refund-credit")!.creditNoteId;

  try {
    await writeTextFile(file, JSON.stringify(document));
    const stdout: string[] = [];
    const code = await main([
      "launch-readiness",
      "validate",
      "--file",
      file,
      "--json",
    ], {
      stdout: (line) => stdout.push(line),
      stderr: () => undefined,
    });

    expect(code).toEqual(1);
    const report = JSON.parse(stdout.join("\n"));
    expect(report.ready).toEqual(false);
    expect(report.incompleteDomains.includes("oidc-account-security")).toBeTruthy();
    expect(report.incompleteRehearsalSteps.includes("fresh-signup")).toBeTruthy();
    expect(report.incompleteRehearsalSteps.includes("git-url-install")).toBeTruthy();
    expect(report.incompleteRehearsalSteps.includes("billing-operation")).toBeTruthy();
  } finally {
    await removePath(file);
  }
});

test("launch-readiness validate rejects malformed structured evidence field shapes", async () => {
  const file = await makeTempFile({ suffix: ".json" });
  const document = await managedOfferingTemplateForTest();
  const rehearsalRun = completeRehearsalRun();
  document.rehearsalRun = rehearsalRun;
  document.domains = document.domains.map((entry) =>
    completeManagedOfferingEntry(entry)
  );
  document.rehearsal = document.rehearsal.map((entry) =>
    completeManagedOfferingEntry(entry, rehearsalRun.id)
  );

  const billingEvidence = document.domains.find((entry) =>
    entry.id === "billing-entitlement"
  )!.evidence as Record<string, unknown>[];
  billingEvidence.find((entry) => entry.type === "usage-aggregation-policy")!
    .windowEnd = "2026-04-01T00:00:00Z";
  const releaseEvidence = document.domains.find((entry) =>
    entry.id === "release-provenance"
  )!.evidence as Record<string, unknown>[];
  releaseEvidence.find((entry) => entry.type === "image-digest")!.imageDigest =
    "latest";
  const gitInstallEvidence = document.rehearsal.find((entry) =>
    entry.id === "git-url-install"
  )!.evidence as Record<string, unknown>[];
  gitInstallEvidence.find((entry) => entry.type === "installation-plan-run")!
    .commitSha = "main";
  const freshSignupEvidence = document.rehearsal.find((entry) =>
    entry.id === "fresh-signup"
  )!.evidence as Record<string, unknown>[];
  freshSignupEvidence.find((entry) => entry.type === "email-assurance")!
    .verifiedAt = "not-a-date";
  const dedicatedEvidence = document.rehearsal.find((entry) =>
    entry.id === "dedicated-materialize"
  )!.evidence as Record<string, unknown>[];
  dedicatedEvidence.find((entry) => entry.type === "preserve-evidence")!
    .sourceCommit = "main";
  const sharedCellEvidence = document.domains.find((entry) =>
    entry.id === "shared-cell-production-runtime"
  )!.evidence as Record<string, unknown>[];
  sharedCellEvidence.find((entry) => entry.type === "load-test")!
    .tenantCount = 1;
  const materializeEvidence = document.domains.find((entry) =>
    entry.id === "dedicated-materialize"
  )!.evidence as Record<string, unknown>[];
  materializeEvidence.find((entry) => entry.type === "continuity-evidence")!
    .sourceCommit = "main";
  const exportEvidence = document.domains.find((entry) =>
    entry.id === "export-self-host-sovereignty"
  )!.evidence as Record<string, unknown>[];
  exportEvidence.find((entry) => entry.type === "sample-data-verification")!
    .dataClasses = "chat,memory,file";
  await writeTextFile(file, JSON.stringify(document));

  try {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await main([
      "launch-readiness",
      "validate",
      "--file",
      file,
      "--json",
    ], {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    });

    expect(code).toEqual(1);
    expect(stderr).toEqual([]);
    const report = JSON.parse(stdout.join("\n"));
    expect(report.ready).toEqual(false);
    expect(report.incompleteDomains.includes("billing-entitlement")).toBeTruthy();
    expect(report.incompleteDomains.includes("dedicated-materialize")).toBeTruthy();
    expect(report.incompleteDomains.includes("export-self-host-sovereignty")).toBeTruthy();
    expect(report.incompleteDomains.includes("release-provenance")).toBeTruthy();
    expect(report.incompleteDomains.includes("shared-cell-production-runtime")).toBeTruthy();
    expect(report.incompleteRehearsalSteps.includes("fresh-signup")).toBeTruthy();
    expect(report.incompleteRehearsalSteps.includes("git-url-install")).toBeTruthy();
    expect(report.incompleteRehearsalSteps.includes("dedicated-materialize")).toBeTruthy();
  } finally {
    await removePath(file);
  }
});

test("launch-readiness validate rejects non-passing structured evidence values", async () => {
  const file = await makeTempFile({ suffix: ".json" });
  const document = await managedOfferingTemplateForTest();
  const rehearsalRun = completeRehearsalRun();
  document.rehearsalRun = rehearsalRun;
  document.domains = document.domains.map((entry) =>
    completeManagedOfferingEntry(entry)
  );
  document.rehearsal = document.rehearsal.map((entry) =>
    completeManagedOfferingEntry(entry, rehearsalRun.id)
  );

  const billingEvidence = document.domains.find((entry) =>
    entry.id === "billing-entitlement"
  )!.evidence as Record<string, unknown>[];
  billingEvidence.find((entry) => entry.type === "invoice")!.status = "draft";
  const releaseEvidence = document.domains.find((entry) =>
    entry.id === "release-provenance"
  )!.evidence as Record<string, unknown>[];
  releaseEvidence.find((entry) => entry.type === "ci-equivalent")!
    .conclusion = "neutral";
  const securityEvidence = document.domains.find((entry) =>
    entry.id === "security-operations"
  )!.evidence as Record<string, unknown>[];
  securityEvidence.find((entry) => entry.type === "sandbox-review")!
    .decision = "pending";
  const quotaEvidence = document.rehearsal.find((entry) =>
    entry.id === "quota-abuse-drill"
  )!.evidence as Record<string, unknown>[];
  quotaEvidence.find((entry) => entry.type === "guard-action")!.action =
    "allowed";
  await writeTextFile(file, JSON.stringify(document));

  try {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await main([
      "launch-readiness",
      "validate",
      "--file",
      file,
      "--json",
    ], {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    });

    expect(code).toEqual(1);
    expect(stderr).toEqual([]);
    const report = JSON.parse(stdout.join("\n"));
    expect(report.ready).toEqual(false);
    expect(report.incompleteDomains.includes("billing-entitlement")).toBeTruthy();
    expect(report.incompleteDomains.includes("release-provenance")).toBeTruthy();
    expect(report.incompleteDomains.includes("security-operations")).toBeTruthy();
    expect(report.incompleteRehearsalSteps.includes("quota-abuse-drill")).toBeTruthy();
  } finally {
    await removePath(file);
  }
});

test("launch-readiness validate rejects placeholder structured evidence refs", async () => {
  const file = await makeTempFile({ suffix: ".json" });
  const document = await managedOfferingTemplateForTest();
  const rehearsalRun = completeRehearsalRun();
  document.rehearsalRun = rehearsalRun;
  document.domains = document.domains.map((entry) =>
    completeManagedOfferingEntry(entry)
  );
  document.rehearsal = document.rehearsal.map((entry) =>
    completeManagedOfferingEntry(entry, rehearsalRun.id)
  );

  const productionTopology = document.domains.find((entry) =>
    entry.id === "production-topology"
  )!.evidence as Record<string, unknown>[];
  productionTopology.find((entry) => entry.type === "staging-manifest")!
    .manifestRef = "evidence://todo";
  const securityEvidence = document.domains.find((entry) =>
    entry.id === "security-operations"
  )!.evidence as Record<string, unknown>[];
  securityEvidence.find((entry) => entry.type === "threat-model")!
    .threatModelRef = "https://example.com/threat-model";
  const legalEvidence = document.domains.find((entry) =>
    entry.id === "legal-privacy-support"
  )!.evidence as Record<string, unknown>[];
  legalEvidence.find((entry) => entry.type === "public-legal-pages")!
    .termsUrl = "https://accounts.example.invalid/terms";
  await writeTextFile(file, JSON.stringify(document));

  try {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await main([
      "launch-readiness",
      "validate",
      "--file",
      file,
      "--json",
    ], {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    });

    expect(code).toEqual(1);
    expect(stderr).toEqual([]);
    const report = JSON.parse(stdout.join("\n"));
    expect(report.ready).toEqual(false);
    expect(report.incompleteDomains.includes("production-topology")).toBeTruthy();
    expect(report.incompleteDomains.includes("security-operations")).toBeTruthy();
    expect(report.incompleteDomains.includes("legal-privacy-support")).toBeTruthy();
  } finally {
    await removePath(file);
  }
});

test("launch-readiness validate rejects placeholder generic structured fields", async () => {
  const file = await makeTempFile({ suffix: ".json" });
  const document = await managedOfferingTemplateForTest();
  const rehearsalRun = completeRehearsalRun();
  document.rehearsalRun = rehearsalRun;
  document.domains = document.domains.map((entry) =>
    completeManagedOfferingEntry(entry)
  );
  document.rehearsal = document.rehearsal.map((entry) =>
    completeManagedOfferingEntry(entry, rehearsalRun.id)
  );

  const securityEvidence = document.domains.find((entry) =>
    entry.id === "oidc-account-security"
  )!.evidence as Record<string, unknown>[];
  securityEvidence.find((entry) => entry.type === "oidc-conformance")!
    .issuer = "https://accounts.example.test";
  const signupEvidence = document.rehearsal.find((entry) =>
    entry.id === "fresh-signup"
  )!.evidence as Record<string, unknown>[];
  signupEvidence.find((entry) => entry.type === "signup-event")!.accountId =
    "<accountId>";
  await writeTextFile(file, JSON.stringify(document));

  try {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await main([
      "launch-readiness",
      "validate",
      "--file",
      file,
      "--json",
    ], {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    });

    expect(code).toEqual(1);
    expect(stderr).toEqual([]);
    const report = JSON.parse(stdout.join("\n"));
    expect(report.ready).toEqual(false);
    expect(report.incompleteDomains.includes("oidc-account-security")).toBeTruthy();
    expect(report.incompleteRehearsalSteps.includes("fresh-signup")).toBeTruthy();
  } finally {
    await removePath(file);
  }
});

test("launch-readiness validate rejects placeholder evidence summaries", async () => {
  const file = await makeTempFile({ suffix: ".json" });
  const document = await managedOfferingTemplateForTest();
  const rehearsalRun = completeRehearsalRun();
  document.rehearsalRun = rehearsalRun;
  document.domains = document.domains.map((entry) =>
    completeManagedOfferingEntry(entry)
  );
  document.rehearsal = document.rehearsal.map((entry) =>
    completeManagedOfferingEntry(entry, rehearsalRun.id)
  );

  const offeringDefinition = document.domains.find((entry) =>
    entry.id === "offering-definition"
  )!.evidence as Record<string, unknown>[];
  offeringDefinition.find((entry) => entry.type === "launch-brief")!.summary =
    "todo";
  await writeTextFile(file, JSON.stringify(document));

  try {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await main([
      "launch-readiness",
      "validate",
      "--file",
      file,
      "--json",
    ], {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    });

    expect(code).toEqual(1);
    expect(stderr).toEqual([]);
    const report = JSON.parse(stdout.join("\n"));
    expect(report.ready).toEqual(false);
    expect(report.incompleteDomains.includes("offering-definition")).toBeTruthy();
  } finally {
    await removePath(file);
  }
});

test("launch-readiness validate rejects sensitive evidence summaries", async () => {
  const file = await makeTempFile({ suffix: ".json" });
  const document = await managedOfferingTemplateForTest();
  const rehearsalRun = completeRehearsalRun();
  document.rehearsalRun = rehearsalRun;
  document.domains = document.domains.map((entry) =>
    completeManagedOfferingEntry(entry)
  );
  document.rehearsal = document.rehearsal.map((entry) =>
    completeManagedOfferingEntry(entry, rehearsalRun.id)
  );

  const billingEvidence = document.domains.find((entry) =>
    entry.id === "billing-entitlement"
  )!.evidence as Record<string, unknown>[];
  billingEvidence.find((entry) => entry.type === "stripe-live")!.summary =
    "Live billing evidence used sk_live_sensitive12345 during rehearsal.";
  await writeTextFile(file, JSON.stringify(document));

  try {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await main([
      "launch-readiness",
      "validate",
      "--file",
      file,
      "--json",
    ], {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    });

    expect(code).toEqual(1);
    expect(stderr).toEqual([]);
    const report = JSON.parse(stdout.join("\n"));
    expect(report.ready).toEqual(false);
    expect(report.incompleteDomains.includes("billing-entitlement")).toBeTruthy();
  } finally {
    await removePath(file);
  }
});

test("launch-readiness validate rejects duplicated evidence types", async () => {
  const file = await makeTempFile({ suffix: ".json" });
  const document = await managedOfferingTemplateForTest();
  const rehearsalRun = completeRehearsalRun();
  document.rehearsalRun = rehearsalRun;
  document.domains = document.domains.map((entry) =>
    completeManagedOfferingEntry(entry)
  );
  document.rehearsal = document.rehearsal.map((entry) =>
    completeManagedOfferingEntry(entry, rehearsalRun.id)
  );

  const offeringDefinition = document.domains.find((entry) =>
    entry.id === "offering-definition"
  ) as Record<string, unknown>;
  const evidence = offeringDefinition.evidence as Record<string, unknown>[];
  evidence.push({ ...evidence[0] });
  await writeTextFile(file, JSON.stringify(document));

  try {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await main([
      "launch-readiness",
      "validate",
      "--file",
      file,
      "--json",
    ], {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    });

    expect(code).toEqual(1);
    expect(stderr).toEqual([]);
    const report = JSON.parse(stdout.join("\n"));
    expect(report.ready).toEqual(false);
    expect(report.errors.includes(
        "domains.offering-definition.evidence.launch-brief is duplicated",
      )).toBeTruthy();
  } finally {
    await removePath(file);
  }
});

test("launch-readiness validate rejects unexpected evidence types", async () => {
  const file = await makeTempFile({ suffix: ".json" });
  const document = await managedOfferingTemplateForTest();
  const rehearsalRun = completeRehearsalRun();
  document.rehearsalRun = rehearsalRun;
  document.domains = document.domains.map((entry) =>
    completeManagedOfferingEntry(entry)
  );
  document.rehearsal = document.rehearsal.map((entry) =>
    completeManagedOfferingEntry(entry, rehearsalRun.id)
  );

  const offeringDefinition = document.domains.find((entry) =>
    entry.id === "offering-definition"
  ) as Record<string, unknown>;
  const domainEvidence = offeringDefinition.evidence as Record<
    string,
    unknown
  >[];
  domainEvidence.push({
    type: "ad-hoc-note",
    ref: "runbook://managed-offering/offering-definition/ad-hoc-note",
    summary: "An ad hoc note should not be accepted as launch evidence.",
  });
  const freshSignup = document.rehearsal.find((entry) =>
    entry.id === "fresh-signup"
  ) as Record<string, unknown>;
  const rehearsalEvidence = freshSignup.evidence as Record<string, unknown>[];
  rehearsalEvidence.push({
    type: "extra-signup-screenshot",
    ref: "artifact://managed-offering/fresh-signup/screenshot",
    summary: "An extra screenshot is not part of the canonical evidence set.",
  });
  await writeTextFile(file, JSON.stringify(document));

  try {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await main([
      "launch-readiness",
      "validate",
      "--file",
      file,
      "--json",
    ], {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    });

    expect(code).toEqual(1);
    expect(stderr).toEqual([]);
    const report = JSON.parse(stdout.join("\n"));
    expect(report.ready).toEqual(false);
    expect(report.errors.includes(
        "domains.offering-definition.evidence.ad-hoc-note is not a required evidence type",
      )).toBeTruthy();
    expect(report.errors.includes(
        "rehearsal.fresh-signup.evidence.extra-signup-screenshot is not a required evidence type",
      )).toBeTruthy();
  } finally {
    await removePath(file);
  }
});

test("launch-readiness validate rejects inconsistent staged rehearsal references", async () => {
  const file = await makeTempFile({ suffix: ".json" });
  const document = await managedOfferingTemplateForTest();
  const rehearsalRun = completeRehearsalRun();
  document.rehearsalRun = rehearsalRun;
  document.domains = document.domains.map((entry) =>
    completeManagedOfferingEntry(entry)
  );
  document.rehearsal = document.rehearsal.map((entry) =>
    completeManagedOfferingEntry(entry, rehearsalRun.id)
  );

  const freshSignupEvidence = document.rehearsal.find((entry) =>
    entry.id === "fresh-signup"
  )!.evidence as Record<string, unknown>[];
  freshSignupEvidence.find((entry) => entry.type === "terms-acceptance")!
    .accountId = "acct_other";
  const gitInstallEvidence = document.rehearsal.find((entry) =>
    entry.id === "git-url-install"
  )!.evidence as Record<string, unknown>[];
  gitInstallEvidence.find((entry) => entry.type === "oidc-login")!
    .installationId = "inst_other";
  const billingEvidence = document.rehearsal.find((entry) =>
    entry.id === "billing-operation"
  )!.evidence as Record<string, unknown>[];
  billingEvidence.find((entry) => entry.type === "dunning-suspension")!
    .invoiceId = "in_other";
  const sharedCellEvidence = document.rehearsal.find((entry) =>
    entry.id === "shared-cell-load"
  )!.evidence as Record<string, unknown>[];
  sharedCellEvidence.find((entry) => entry.type === "per-installation-metrics")!
    .runtimeCellId = "cell_other";
  const dedicatedEvidence = document.rehearsal.find((entry) =>
    entry.id === "dedicated-materialize"
  )!.evidence as Record<string, unknown>[];
  dedicatedEvidence.find((entry) => entry.type === "domain-preservation")!
    .domainName = "other.takos.jp";
  const exportEvidence = document.rehearsal.find((entry) =>
    entry.id === "export-self-host-import"
  )!.evidence as Record<string, unknown>[];
  exportEvidence.find((entry) => entry.type === "source-retention-state")!
    .accountId = "acct_other";
  await writeTextFile(file, JSON.stringify(document));

  try {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await main([
      "launch-readiness",
      "validate",
      "--file",
      file,
      "--json",
    ], {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    });

    expect(code).toEqual(1);
    expect(stderr).toEqual([]);
    const report = JSON.parse(stdout.join("\n"));
    expect(report.ready).toEqual(false);
    expect(report.incompleteRehearsalSteps.includes("fresh-signup")).toBeTruthy();
    expect(report.incompleteRehearsalSteps.includes("git-url-install")).toBeTruthy();
    expect(report.incompleteRehearsalSteps.includes("shared-cell-load")).toBeTruthy();
    expect(report.incompleteRehearsalSteps.includes("dedicated-materialize")).toBeTruthy();
    expect(report.incompleteRehearsalSteps.includes("export-self-host-import")).toBeTruthy();
    expect(report.incompleteRehearsalSteps.includes("billing-operation")).toBeTruthy();
  } finally {
    await removePath(file);
  }
});

test("launch-readiness validate rejects generic IDs for structured billing evidence", async () => {
  const file = await makeTempFile({ suffix: ".json" });
  const document = await managedOfferingTemplateForTest();
  const rehearsalRun = completeRehearsalRun();
  document.rehearsalRun = rehearsalRun;
  document.domains = document.domains.map((entry) =>
    completeManagedOfferingEntry(entry)
  );
  document.rehearsal = document.rehearsal.map((entry) =>
    completeManagedOfferingEntry(entry, rehearsalRun.id)
  );
  const billing = document.domains.find((entry) =>
    entry.id === "billing-entitlement"
  ) as Record<string, unknown>;
  const evidence = billing.evidence as Record<string, unknown>[];
  const stripeLive = evidence.find((entry) => entry.type === "stripe-live");
  expect(stripeLive).toBeTruthy();
  stripeLive.checkoutSessionId = "checkout_live_rehearsal";
  stripeLive.webhookEventId = "webhook_live_rehearsal";
  const billingOperation = document.rehearsal.find((entry) =>
    entry.id === "billing-operation"
  ) as Record<string, unknown>;
  const operationEvidence = billingOperation.evidence as Record<
    string,
    unknown
  >[];
  operationEvidence.find((entry) => entry.type === "invoice-paid")!.invoiceId =
    "invoice_paid_rehearsal";
  operationEvidence.find((entry) => entry.type === "recovery-refund-credit")!
    .creditNoteId = "credit_note_recovery_rehearsal";
  await writeTextFile(file, JSON.stringify(document));

  try {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await main([
      "launch-readiness",
      "validate",
      "--file",
      file,
      "--json",
    ], {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    });

    expect(code).toEqual(1);
    expect(stderr).toEqual([]);
    const report = JSON.parse(stdout.join("\n"));
    expect(report.ready).toEqual(false);
    expect(report.incompleteDomains.includes("billing-entitlement")).toBeTruthy();
    expect(report.incompleteRehearsalSteps.includes("billing-operation")).toBeTruthy();
  } finally {
    await removePath(file);
  }
});

test("launch-readiness validate rejects mixed rehearsal run evidence", async () => {
  const file = await makeTempFile({ suffix: ".json" });
  const document = await managedOfferingTemplateForTest();
  document.rehearsalRun = completeRehearsalRun("rehearsal-a");
  document.domains = document.domains.map((entry) =>
    completeManagedOfferingEntry(entry)
  );
  document.rehearsal = document.rehearsal.map((
    entry,
    index: number,
  ) =>
    completeManagedOfferingEntry(
      entry,
      index === 0 ? "rehearsal-b" : "rehearsal-a",
    )
  );
  const useTakosEvidence = document.rehearsal.find((entry) =>
    entry.id === "use-takos-launch"
  )!.evidence as Record<string, unknown>[];
  useTakosEvidence[0].runId = "rehearsal-b";
  await writeTextFile(
    file,
    JSON.stringify(document),
  );

  try {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await main([
      "launch-readiness",
      "validate",
      "--file",
      file,
      "--json",
    ], {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    });

    expect(code).toEqual(1);
    expect(stderr).toEqual([]);
    const report = JSON.parse(stdout.join("\n"));
    expect(report.ready).toEqual(false);
    expect(report.incompleteRehearsalSteps.includes("fresh-signup")).toBeTruthy();
    expect(report.incompleteRehearsalSteps.includes("use-takos-launch")).toBeTruthy();
  } finally {
    await removePath(file);
  }
});

test("launch-readiness validate rejects rehearsal environment mismatch", async () => {
  const file = await makeTempFile({ suffix: ".json" });
  const document = await managedOfferingTemplateForTest();
  const rehearsalRun = completeRehearsalRun("rehearsal-a");
  document.rehearsalRun = rehearsalRun;
  document.domains = document.domains.map((entry) =>
    completeManagedOfferingEntry(entry)
  );
  document.rehearsal = document.rehearsal.map((entry) =>
    completeManagedOfferingEntry(entry, rehearsalRun.id)
  );
  document.rehearsal[0].environment = "production";
  await writeTextFile(file, JSON.stringify(document));

  try {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await main([
      "launch-readiness",
      "validate",
      "--file",
      file,
      "--json",
    ], {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    });

    expect(code).toEqual(1);
    expect(stderr).toEqual([]);
    const report = JSON.parse(stdout.join("\n"));
    expect(report.ready).toEqual(false);
    expect(report.incompleteRehearsalSteps.includes("fresh-signup")).toBeTruthy();
  } finally {
    await removePath(file);
  }
});

test("launch-readiness validate rejects future rehearsal evidence", async () => {
  const file = await makeTempFile({ suffix: ".json" });
  const document = await managedOfferingTemplateForTest();
  const rehearsalRun = completeRehearsalRun("rehearsal-a");
  document.rehearsalRun = rehearsalRun;
  document.domains = document.domains.map((entry) =>
    completeManagedOfferingEntry(entry)
  );
  document.rehearsal = document.rehearsal.map((entry) =>
    completeManagedOfferingEntry(entry, rehearsalRun.id)
  );
  document.rehearsal[0].completedAt = "2999-01-01T00:00:00Z";
  await writeTextFile(file, JSON.stringify(document));

  try {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await main([
      "launch-readiness",
      "validate",
      "--file",
      file,
      "--json",
    ], {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    });

    expect(code).toEqual(1);
    expect(stderr).toEqual([]);
    const report = JSON.parse(stdout.join("\n"));
    expect(report.ready).toEqual(false);
    expect(report.incompleteRehearsalSteps.includes("fresh-signup")).toBeTruthy();
  } finally {
    await removePath(file);
  }
});

test("launch-readiness validate rejects loose or non-UTC evidence timestamps", async () => {
  const file = await makeTempFile({ suffix: ".json" });
  const document = await managedOfferingTemplateForTest();
  const rehearsalRun = {
    ...completeRehearsalRun("rehearsal-a"),
    startedAt: "2026-05-12 00:00:00",
  };
  document.rehearsalRun = rehearsalRun;
  document.domains = document.domains.map((entry) =>
    completeManagedOfferingEntry(entry)
  );
  document.rehearsal = document.rehearsal.map((entry) =>
    completeManagedOfferingEntry(entry, rehearsalRun.id)
  );
  document.domains[0].completedAt = "2026-05-12T01:00:00+09:00";
  document.rehearsal[0].completedAt = "2026-05-12 01:00:00";
  const billingEvidence = document.domains.find((entry) =>
    entry.id === "billing-entitlement"
  )!.evidence as Record<string, unknown>[];
  billingEvidence.find((entry) => entry.type === "usage-aggregation-policy")!
    .windowStart = "2026-05-01";
  await writeTextFile(file, JSON.stringify(document));

  try {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await main([
      "launch-readiness",
      "validate",
      "--file",
      file,
      "--json",
    ], {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    });

    expect(code).toEqual(1);
    expect(stderr).toEqual([]);
    const report = JSON.parse(stdout.join("\n"));
    expect(report.ready).toEqual(false);
    expect(report.errors.includes(
        "rehearsalRun.startedAt must be a valid date",
      )).toBeTruthy();
    expect(report.incompleteDomains.includes("offering-definition")).toBeTruthy();
    expect(report.incompleteDomains.includes("billing-entitlement")).toBeTruthy();
    expect(report.incompleteRehearsalSteps.includes("fresh-signup")).toBeTruthy();
  } finally {
    await removePath(file);
  }
});

test("launch-readiness validate rejects invalid calendar timestamps", async () => {
  const file = await makeTempFile({ suffix: ".json" });
  const document = await managedOfferingTemplateForTest();
  const rehearsalRun = {
    ...completeRehearsalRun("rehearsal-a"),
    startedAt: "2026-02-29T00:00:00Z",
  };
  document.rehearsalRun = rehearsalRun;
  document.domains = document.domains.map((entry) =>
    completeManagedOfferingEntry(entry)
  );
  document.rehearsal = document.rehearsal.map((entry) =>
    completeManagedOfferingEntry(entry, rehearsalRun.id)
  );
  document.rehearsal[0].completedAt = "2026-02-31T01:00:00Z";
  const securityEvidence = document.domains.find((entry) =>
    entry.id === "security-operations"
  )!.evidence as Record<string, unknown>[];
  securityEvidence.find((entry) => entry.type === "secret-inventory")!
    .reviewedAt = "2026-02-31T00:00:00Z";
  await writeTextFile(file, JSON.stringify(document));

  try {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await main([
      "launch-readiness",
      "validate",
      "--file",
      file,
      "--json",
    ], {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    });

    expect(code).toEqual(1);
    expect(stderr).toEqual([]);
    const report = JSON.parse(stdout.join("\n"));
    expect(report.ready).toEqual(false);
    expect(report.errors.includes(
        "rehearsalRun.startedAt must be a valid date",
      )).toBeTruthy();
    expect(report.incompleteDomains.includes("security-operations")).toBeTruthy();
    expect(report.incompleteRehearsalSteps.includes("fresh-signup")).toBeTruthy();
  } finally {
    await removePath(file);
  }
});

test("launch-readiness validate rejects unsupported rehearsal environments", async () => {
  const file = await makeTempFile({ suffix: ".json" });
  const document = await managedOfferingTemplateForTest();
  document.rehearsalRun = {
    ...completeRehearsalRun("rehearsal-a"),
    environment: "dev",
  };
  document.domains = document.domains.map((entry) =>
    completeManagedOfferingEntry(entry)
  );
  document.rehearsal = document.rehearsal.map((entry) => ({
    ...completeManagedOfferingEntry(entry, "rehearsal-a"),
    environment: "dev",
  }));
  await writeTextFile(file, JSON.stringify(document));

  try {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await main([
      "launch-readiness",
      "validate",
      "--file",
      file,
      "--json",
    ], {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    });

    expect(code).toEqual(1);
    expect(stderr).toEqual([]);
    const report = JSON.parse(stdout.join("\n"));
    expect(report.ready).toEqual(false);
    expect(report.errors.includes(
        "rehearsalRun.environment must be staging or production",
      )).toBeTruthy();
    expect(report.errors.includes(
        "rehearsal.fresh-signup.environment must be staging or production",
      )).toBeTruthy();
  } finally {
    await removePath(file);
  }
});

test("launch-readiness validate rejects combined-environment rehearsal steps", async () => {
  const file = await makeTempFile({ suffix: ".json" });
  const document = await managedOfferingTemplateForTest();
  const rehearsalRun = completeRehearsalRun("rehearsal-a");
  document.rehearsalRun = rehearsalRun;
  document.domains = document.domains.map((entry) =>
    completeManagedOfferingEntry(entry)
  );
  document.rehearsal = document.rehearsal.map((entry) =>
    completeManagedOfferingEntry(entry, rehearsalRun.id)
  );
  document.rehearsal[0].environment = "staging+production";
  await writeTextFile(file, JSON.stringify(document));

  try {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await main([
      "launch-readiness",
      "validate",
      "--file",
      file,
      "--json",
    ], {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    });

    expect(code).toEqual(1);
    expect(stderr).toEqual([]);
    const report = JSON.parse(stdout.join("\n"));
    expect(report.ready).toEqual(false);
    expect(report.errors.includes(
        "rehearsal.fresh-signup.environment must be staging or production",
      )).toBeTruthy();
    expect(report.incompleteRehearsalSteps.includes("fresh-signup")).toBeTruthy();
  } finally {
    await removePath(file);
  }
});

test("launch-readiness validate rejects out-of-order staged rehearsal evidence", async () => {
  const file = await makeTempFile({ suffix: ".json" });
  const document = await managedOfferingTemplateForTest();
  const rehearsalRun = completeRehearsalRun("rehearsal-a");
  document.rehearsalRun = rehearsalRun;
  document.domains = document.domains.map((entry) =>
    completeManagedOfferingEntry(entry)
  );
  document.rehearsal = document.rehearsal.map((entry) =>
    completeManagedOfferingEntry(entry, rehearsalRun.id)
  );
  document.rehearsal[0].completedAt = "2026-05-12T01:00:00Z";
  document.rehearsal[1].completedAt = "2026-05-12T00:30:00Z";
  await writeTextFile(file, JSON.stringify(document));

  try {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await main([
      "launch-readiness",
      "validate",
      "--file",
      file,
      "--json",
    ], {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    });

    expect(code).toEqual(1);
    expect(stderr).toEqual([]);
    const report = JSON.parse(stdout.join("\n"));
    expect(report.ready).toEqual(false);
    expect(report.errors.includes(
        "rehearsal.use-takos-launch.completedAt must be after rehearsal.fresh-signup.completedAt",
      )).toBeTruthy();
  } finally {
    await removePath(file);
  }
});

test("launch-readiness production-topology preflight emits production-topology evidence", async () => {
  const file = await makeTempFile({ suffix: ".json" });
  await writeTextFile(
    file,
    JSON.stringify(completeProductionTopologyForTest()),
  );
  try {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await main([
      "launch-readiness",
      "production-topology",
      "preflight",
      "--file",
      file,
      "--json",
    ], {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    });

    expect(code).toEqual(0);
    expect(stderr).toEqual([]);
    const report = JSON.parse(stdout.join("\n"));
    expect(report.kind).toEqual("takosumi.production-topology-preflight-report@v1");
    expect(report.ready).toEqual(true);
    expect(report.missingRoles).toEqual([]);
    expect(report.evidenceEntry.id).toEqual("production-topology");
    expect(report.evidenceEntry.evidence[0].topologyEnvironment).toEqual("staging");
    expect(report.evidenceEntry.evidence[0].componentCount).toEqual(6);
    expect(report.evidenceEntry.evidence[1].ref).toEqual("vault://topology/staging/artifact-digests");
    expect(report.evidenceEntry.evidence[3].ref).toEqual("vault://topology/staging/health-probes");
    expect(report.evidenceEntry.evidence[5].rollbackRole).toEqual("accounts");
    expect(report.evidenceEntry.evidence[5].artifactDigest).toEqual(testSha256Digest);
    expect(report.evidenceEntry.evidence.map((entry: { type: string }) =>
        entry.type
      )).toEqual([
        "staging-manifest",
        "staging-artifact-digest",
        "staging-migration-transcript",
        "staging-health-probe",
        "staging-tls-evidence",
        "staging-rollback-target",
      ]);
  } finally {
    await removePath(file);
  }
});

test("launch-readiness production-topology template prints preflight input shape", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await main([
    "launch-readiness",
    "production-topology",
    "template",
    "--environment",
    "production",
  ], {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
  });

  expect(code).toEqual(0);
  expect(stderr).toEqual([]);
  const template = JSON.parse(stdout.join("\n"));
  expect(template.kind).toEqual("takosumi.production-topology@v1");
  expect(template.environment).toEqual("production");
  expect(template.artifactDigestEvidenceRef).toEqual("vault://managed-readiness/<rehearsal-run-id>/production-topology/production/artifact-digests");
  expect(template.healthProbeEvidenceRef).toEqual("vault://managed-readiness/<rehearsal-run-id>/production-topology/production/health-probes");
  expect(template.rollbackTarget.role).toEqual("accounts");
  expect(template.components.length).toEqual(6);
  expect(template.components.map((entry: { role: string }) => entry.role)).toEqual([
      "accounts",
      "dashboard",
      "takosumi-deploy-control",
      "service",
      "object-storage",
      "dns-tls",
    ]);
  const accountsTemplate = template.components.find((
    entry: { role: string },
  ) => entry.role === "accounts");
  expect(accountsTemplate.wranglerConfigValidation.kind).toEqual("takosumi.cloudflare-rendered-config-validation@v1");
  expect(accountsTemplate.wranglerConfigValidation.ok).toEqual(true);
  expect(accountsTemplate.wranglerConfigValidation.d1BindingPresent).toEqual(true);
  expect(accountsTemplate.wranglerConfigValidation.r2BindingPresent).toEqual(true);

  const file = await makeTempFile({ suffix: ".json" });
  await writeTextFile(file, JSON.stringify(template));
  try {
    const preflightStdout: string[] = [];
    const preflightCode = await main([
      "launch-readiness",
      "production-topology",
      "preflight",
      "--file",
      file,
      "--json",
    ], {
      stdout: (line) => preflightStdout.push(line),
      stderr: () => undefined,
    });
    expect(preflightCode).toEqual(1);
    const report = JSON.parse(preflightStdout.join("\n"));
    expect(report.ready).toEqual(false);
    expect(report.errors.includes("owner is required")).toBeTruthy();
    expect(report.errors.includes(
        "rollbackTarget.artifactDigest must be a sha256: digest",
      )).toBeTruthy();
  } finally {
    await removePath(file);
  }
});

test("launch-readiness production-topology merge emits combined topology evidence", async () => {
  const stagingTopologyFile = await makeTempFile({ suffix: ".json" });
  const productionTopologyFile = await makeTempFile({ suffix: ".json" });
  const stagingReportFile = await makeTempFile({ suffix: ".json" });
  const productionReportFile = await makeTempFile({ suffix: ".json" });
  const readinessFile = await makeTempFile({ suffix: ".json" });
  await writeTextFile(
    stagingTopologyFile,
    JSON.stringify(completeProductionTopologyForTest("staging")),
  );
  await writeTextFile(
    productionTopologyFile,
    JSON.stringify(completeProductionTopologyForTest("production")),
  );
  try {
    for (
      const [topologyFile, reportFile] of [
        [stagingTopologyFile, stagingReportFile],
        [productionTopologyFile, productionReportFile],
      ]
    ) {
      const preflightStdout: string[] = [];
      const preflightCode = await main([
        "launch-readiness",
        "production-topology",
        "preflight",
        "--file",
        topologyFile,
        "--json",
      ], {
        stdout: (line) => preflightStdout.push(line),
        stderr: () => undefined,
      });
      expect(preflightCode).toEqual(0);
      await writeTextFile(reportFile, preflightStdout.join("\n"));
    }

    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await main([
      "launch-readiness",
      "production-topology",
      "merge",
      "--staging-report",
      stagingReportFile,
      "--production-report",
      productionReportFile,
      "--json",
    ], {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    });

    expect(code).toEqual(0);
    expect(stderr).toEqual([]);
    const report = JSON.parse(stdout.join("\n"));
    expect(report.kind).toEqual("takosumi.production-topology-merge-report@v1");
    expect(report.ready).toEqual(true);
    expect(report.evidenceEntry.environment).toEqual("staging+production");
    expect(report.evidenceEntry.evidence.length).toEqual(12);
    expect(report.evidenceEntry.evidence[0].type).toEqual("staging-manifest");
    expect(report.evidenceEntry.evidence[6].type).toEqual("production-manifest");

    const document = await managedOfferingTemplateForTest();
    const rehearsalRun = completeRehearsalRun();
    document.rehearsalRun = rehearsalRun;
    document.domains = document.domains.map((entry) =>
      entry.id === "production-topology"
        ? report.evidenceEntry
        : completeManagedOfferingEntry(entry)
    );
    document.rehearsal = document.rehearsal.map((entry) =>
      completeManagedOfferingEntry(entry, rehearsalRun.id)
    );
    await writeTextFile(readinessFile, JSON.stringify(document));

    const validateStdout: string[] = [];
    const validateCode = await main([
      "launch-readiness",
      "validate",
      "--file",
      readinessFile,
      "--json",
    ], {
      stdout: (line) => validateStdout.push(line),
      stderr: () => undefined,
    });
    expect(validateCode).toEqual(0);
    expect(JSON.parse(validateStdout.join("\n")).ready).toEqual(true);
  } finally {
    await removePath(stagingTopologyFile);
    await removePath(productionTopologyFile);
    await removePath(stagingReportFile);
    await removePath(productionReportFile);
    await removePath(readinessFile);
  }
});

test("launch-readiness production-topology merge rejects missing production report", async () => {
  const stagingTopologyFile = await makeTempFile({ suffix: ".json" });
  const stagingReportFile = await makeTempFile({ suffix: ".json" });
  await writeTextFile(
    stagingTopologyFile,
    JSON.stringify(completeProductionTopologyForTest("staging")),
  );
  try {
    const preflightStdout: string[] = [];
    const preflightCode = await main([
      "launch-readiness",
      "production-topology",
      "preflight",
      "--file",
      stagingTopologyFile,
      "--json",
    ], {
      stdout: (line) => preflightStdout.push(line),
      stderr: () => undefined,
    });
    expect(preflightCode).toEqual(0);
    await writeTextFile(stagingReportFile, preflightStdout.join("\n"));

    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await main([
      "launch-readiness",
      "production-topology",
      "merge",
      "--staging-report",
      stagingReportFile,
      "--production-report",
      stagingReportFile,
      "--json",
    ], {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    });

    expect(code).toEqual(1);
    expect(stderr).toEqual([]);
    const report = JSON.parse(stdout.join("\n"));
    expect(report.ready).toEqual(false);
    expect(report.errors.includes(
        "production preflight report.environment must be production",
      )).toBeTruthy();
  } finally {
    await removePath(stagingTopologyFile);
    await removePath(stagingReportFile);
  }
});

test("launch-readiness validate rejects generic production topology evidence refs", async () => {
  const file = await makeTempFile({ suffix: ".json" });
  const document = await managedOfferingTemplateForTest();
  const rehearsalRun = completeRehearsalRun();
  document.rehearsalRun = rehearsalRun;
  document.domains = document.domains.map((entry) =>
    completeManagedOfferingEntry(entry)
  );
  document.rehearsal = document.rehearsal.map((entry) =>
    completeManagedOfferingEntry(entry, rehearsalRun.id)
  );
  const productionTopology = document.domains.find((entry) =>
    entry.id === "production-topology"
  )!;
  productionTopology.evidence = (
    productionTopology.requiredEvidenceTypes as string[]
  ).map((type) => ({
    type,
    ref: `runbook://managed-offering/production-topology/${type}`,
    summary: `${type} was noted in a generic runbook`,
  }));
  await writeTextFile(file, JSON.stringify(document));

  try {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await main([
      "launch-readiness",
      "validate",
      "--file",
      file,
      "--json",
    ], {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    });

    expect(code).toEqual(1);
    expect(stderr).toEqual([]);
    const report = JSON.parse(stdout.join("\n"));
    expect(report.ready).toEqual(false);
    expect(report.incompleteDomains.includes("production-topology")).toBeTruthy();
  } finally {
    await removePath(file);
  }
});

test("launch-readiness validate rejects production topology with single-environment domain", async () => {
  const file = await makeTempFile({ suffix: ".json" });
  const document = await managedOfferingTemplateForTest();
  const rehearsalRun = completeRehearsalRun();
  document.rehearsalRun = rehearsalRun;
  document.domains = document.domains.map((entry) =>
    completeManagedOfferingEntry(entry)
  );
  document.rehearsal = document.rehearsal.map((entry) =>
    completeManagedOfferingEntry(entry, rehearsalRun.id)
  );
  const productionTopology = document.domains.find((entry) =>
    entry.id === "production-topology"
  )!;
  productionTopology.environment = "staging";
  await writeTextFile(file, JSON.stringify(document));

  try {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await main([
      "launch-readiness",
      "validate",
      "--file",
      file,
      "--json",
    ], {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    });

    expect(code).toEqual(1);
    expect(stderr).toEqual([]);
    const report = JSON.parse(stdout.join("\n"));
    expect(report.ready).toEqual(false);
    expect(report.errors.includes(
        "domains.production-topology.environment must be staging+production",
      )).toBeTruthy();
    expect(report.incompleteDomains.includes("production-topology")).toBeTruthy();
  } finally {
    await removePath(file);
  }
});

test("launch-readiness validate rejects staging-only production topology evidence", async () => {
  const topologyFile = await makeTempFile({ suffix: ".json" });
  const readinessFile = await makeTempFile({ suffix: ".json" });
  await writeTextFile(
    topologyFile,
    JSON.stringify(completeProductionTopologyForTest()),
  );
  try {
    const preflightStdout: string[] = [];
    const preflightCode = await main([
      "launch-readiness",
      "production-topology",
      "preflight",
      "--file",
      topologyFile,
      "--json",
    ], {
      stdout: (line) => preflightStdout.push(line),
      stderr: () => undefined,
    });
    expect(preflightCode).toEqual(0);
    const preflightReport = JSON.parse(preflightStdout.join("\n"));

    const document = await managedOfferingTemplateForTest();
    const rehearsalRun = completeRehearsalRun();
    document.rehearsalRun = rehearsalRun;
    document.domains = document.domains.map((entry) =>
      entry.id === "production-topology"
        ? preflightReport.evidenceEntry
        : completeManagedOfferingEntry(entry)
    );
    document.rehearsal = document.rehearsal.map((entry) =>
      completeManagedOfferingEntry(entry, rehearsalRun.id)
    );
    await writeTextFile(readinessFile, JSON.stringify(document));

    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await main([
      "launch-readiness",
      "validate",
      "--file",
      readinessFile,
      "--json",
    ], {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    });

    expect(code).toEqual(1);
    expect(stderr).toEqual([]);
    const report = JSON.parse(stdout.join("\n"));
    expect(report.ready).toEqual(false);
    expect(report.incompleteDomains.includes("production-topology")).toBeTruthy();
  } finally {
    await removePath(topologyFile);
    await removePath(readinessFile);
  }
});

test("launch-readiness production-topology preflight rejects future evidence", async () => {
  const file = await makeTempFile({ suffix: ".json" });
  const topology = completeProductionTopologyForTest();
  topology.completedAt = "2999-01-01T00:00:00Z";
  await writeTextFile(file, JSON.stringify(topology));
  try {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await main([
      "launch-readiness",
      "production-topology",
      "preflight",
      "--file",
      file,
      "--json",
    ], {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    });

    expect(code).toEqual(1);
    expect(stderr).toEqual([]);
    const report = JSON.parse(stdout.join("\n"));
    expect(report.ready).toEqual(false);
    expect(report.errors.includes("completedAt must not be in the future")).toBeTruthy();
  } finally {
    await removePath(file);
  }
});

test("launch-readiness production-topology preflight rejects loose timestamps", async () => {
  const file = await makeTempFile({ suffix: ".json" });
  const topology = completeProductionTopologyForTest();
  topology.completedAt = "2026-05-13";
  await writeTextFile(file, JSON.stringify(topology));
  try {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await main([
      "launch-readiness",
      "production-topology",
      "preflight",
      "--file",
      file,
      "--json",
    ], {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    });

    expect(code).toEqual(1);
    expect(stderr).toEqual([]);
    const report = JSON.parse(stdout.join("\n"));
    expect(report.ready).toEqual(false);
    expect(report.errors.includes("completedAt must be a valid date")).toBeTruthy();
  } finally {
    await removePath(file);
  }
});

test("launch-readiness production-topology preflight rejects invalid calendar timestamps", async () => {
  const file = await makeTempFile({ suffix: ".json" });
  const topology = completeProductionTopologyForTest();
  topology.completedAt = "2026-02-31T00:00:00Z";
  await writeTextFile(file, JSON.stringify(topology));
  try {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await main([
      "launch-readiness",
      "production-topology",
      "preflight",
      "--file",
      file,
      "--json",
    ], {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    });

    expect(code).toEqual(1);
    expect(stderr).toEqual([]);
    const report = JSON.parse(stdout.join("\n"));
    expect(report.ready).toEqual(false);
    expect(report.errors.includes("completedAt must be a valid date")).toBeTruthy();
  } finally {
    await removePath(file);
  }
});

test("launch-readiness production-topology preflight rejects self-review", async () => {
  const file = await makeTempFile({ suffix: ".json" });
  const topology = completeProductionTopologyForTest();
  topology.owner = "Ops ";
  topology.reviewer = "ops";
  await writeTextFile(file, JSON.stringify(topology));
  try {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await main([
      "launch-readiness",
      "production-topology",
      "preflight",
      "--file",
      file,
      "--json",
    ], {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    });

    expect(code).toEqual(1);
    expect(stderr).toEqual([]);
    const report = JSON.parse(stdout.join("\n"));
    expect(report.ready).toEqual(false);
    expect(report.errors.includes("reviewer must differ from owner")).toBeTruthy();
  } finally {
    await removePath(file);
  }
});

test("launch-readiness production-topology preflight rejects mutable artifacts", async () => {
  const file = await makeTempFile({ suffix: ".json" });
  const topology = completeProductionTopologyForTest();
  const components = topology.components as Record<string, unknown>[];
  components[0].artifactDigest = "latest";
  await writeTextFile(file, JSON.stringify(topology));
  try {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await main([
      "launch-readiness",
      "production-topology",
      "preflight",
      "--file",
      file,
      "--json",
    ], {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    });

    expect(code).toEqual(1);
    expect(stderr).toEqual([]);
    const report = JSON.parse(stdout.join("\n"));
    expect(report.ready).toEqual(false);
    expect(report.errors.includes(
        "components[0].artifactDigest must be a sha256: digest",
      )).toBeTruthy();
  } finally {
    await removePath(file);
  }
});

test("launch-readiness production-topology preflight rejects duplicate components and invalid rollback role", async () => {
  const file = await makeTempFile({ suffix: ".json" });
  const topology = completeProductionTopologyForTest();
  topology.rollbackTarget = {
    ref: "release://takosumi/previous",
    role: "object-storage",
    artifactDigest: testSha256Digest,
  };
  const components = topology.components as Record<string, unknown>[];
  components[1].id = components[0].id;
  components[1].role = components[0].role;
  (topology.components as unknown[]).push("not-a-component-object");
  await writeTextFile(file, JSON.stringify(topology));
  try {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await main([
      "launch-readiness",
      "production-topology",
      "preflight",
      "--file",
      file,
      "--json",
    ], {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    });

    expect(code).toEqual(1);
    expect(stderr).toEqual([]);
    const report = JSON.parse(stdout.join("\n"));
    expect(report.ready).toEqual(false);
    expect(report.errors.includes("components[1].id duplicates components[0].id")).toBeTruthy();
    expect(report.errors.includes(
        "components[1].role duplicates components[0].role",
      )).toBeTruthy();
    expect(report.errors.includes(
        "rollbackTarget.role must be a deployable component role",
      )).toBeTruthy();
    expect(report.errors.includes("components[6] must be an object")).toBeTruthy();
  } finally {
    await removePath(file);
  }
});

test("launch-readiness production-topology preflight rejects placeholders and missing roles", async () => {
  const file = await makeTempFile({ suffix: ".json" });
  const topology = completeProductionTopologyForTest();
  topology.manifestRef = "evidence://todo";
  topology.components = (topology.components as Record<string, unknown>[])
    .filter((component) => component.role !== "dns-tls");
  await writeTextFile(file, JSON.stringify(topology));
  try {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await main([
      "launch-readiness",
      "production-topology",
      "preflight",
      "--file",
      file,
      "--json",
    ], {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    });

    expect(code).toEqual(1);
    expect(stderr).toEqual([]);
    const report = JSON.parse(stdout.join("\n"));
    expect(report.ready).toEqual(false);
    expect(report.missingRoles).toEqual(["dns-tls"]);
    expect(report.errors.includes("manifestRef must not be a placeholder")).toBeTruthy();
  } finally {
    await removePath(file);
  }
});

test("launch-readiness production-topology preflight rejects missing field-level evidence", async () => {
  const file = await makeTempFile({ suffix: ".json" });
  const topology = completeProductionTopologyForTest();
  topology.migrationTranscriptRef = "run://todo";
  topology.tlsEvidenceRef = "";
  topology.artifactDigestEvidenceRef = "topology://staging/artifact-digests";
  delete topology.healthProbeEvidenceRef;
  topology.rollbackTarget = {
    ref: "release://takosumi/previous",
  };
  const components = topology.components as Record<string, unknown>[];
  delete components[0].healthProbeRef;
  await writeTextFile(file, JSON.stringify(topology));
  try {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await main([
      "launch-readiness",
      "production-topology",
      "preflight",
      "--file",
      file,
      "--json",
    ], {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    });

    expect(code).toEqual(1);
    expect(stderr).toEqual([]);
    const report = JSON.parse(stdout.join("\n"));
    expect(report.ready).toEqual(false);
    expect(report.errors.includes(
        "migrationTranscriptRef must not be a placeholder",
      )).toBeTruthy();
    expect(report.errors.includes("tlsEvidenceRef is required")).toBeTruthy();
    expect(report.errors.includes(
        "artifactDigestEvidenceRef must not be a placeholder",
      )).toBeTruthy();
    expect(report.errors.includes("healthProbeEvidenceRef is required")).toBeTruthy();
    expect(report.errors.includes(
        "rollbackTarget.artifactDigest must be a sha256: digest",
      )).toBeTruthy();
    expect(report.errors.includes("rollbackTarget.role is required")).toBeTruthy();
    expect(report.errors.includes("components[0].healthProbeRef is required")).toBeTruthy();
  } finally {
    await removePath(file);
  }
});

test("launch-readiness production-topology preflight requires Accounts Worker D1/R2 evidence", async () => {
  const file = await makeTempFile({ suffix: ".json" });
  const topology = completeProductionTopologyForTest("staging");
  const components = topology.components as Record<string, unknown>[];
  const accounts = components.find((component) =>
    component.role === "accounts"
  )!;
  accounts.runtime = "cloudflare-container";
  accounts.containerRuntime = true;
  accounts.bindings = ["KV:TAKOSUMI_ACCOUNTS_CACHE"];
  delete accounts.wranglerConfigRef;
  delete accounts.wranglerConfigValidation;
  await writeTextFile(file, JSON.stringify(topology));

  try {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await main([
      "launch-readiness",
      "production-topology",
      "preflight",
      "--file",
      file,
    ], {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    });

    expect(code).toEqual(1);
    const output = [...stdout, ...stderr].join("\n");
    expect(output.includes("accounts component runtime must be cloudflare-worker")).toBeTruthy();
    expect(output.includes("accounts component containerRuntime must be false")).toBeTruthy();
    expect(output.includes("accounts component wranglerConfigRef is required")).toBeTruthy();
    expect(output.includes(
      "accounts component wranglerConfigValidation must be an object",
    )).toBeTruthy();
    expect(output.includes(
      "accounts component bindings must include D1:TAKOSUMI_ACCOUNTS_DB",
    )).toBeTruthy();
    expect(output.includes(
      "accounts component bindings must include R2:TAKOSUMI_ACCOUNTS_EXPORTS",
    )).toBeTruthy();
  } finally {
    await removePath(file);
  }
});

test("launch-readiness production-topology preflight rejects weak Accounts rendered config validation", async () => {
  const file = await makeTempFile({ suffix: ".json" });
  const topology = completeProductionTopologyForTest("staging");
  const components = topology.components as Record<string, unknown>[];
  const accounts = components.find((component) =>
    component.role === "accounts"
  )!;
  accounts.wranglerConfigValidation = {
    ...completeWranglerConfigValidationForTest(),
    ok: false,
    configDigest: "sha256:not-a-digest",
    d1DatabaseIdPlaceholder: true,
    r2BindingPresent: false,
    containerConfigured: true,
  };
  await writeTextFile(file, JSON.stringify(topology));

  try {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await main([
      "launch-readiness",
      "production-topology",
      "preflight",
      "--file",
      file,
    ], {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    });

    expect(code).toEqual(1);
    const output = [...stdout, ...stderr].join("\n");
    expect(output.includes(
      "accounts component wranglerConfigValidation.ok must be true",
    )).toBeTruthy();
    expect(output.includes(
      "accounts component wranglerConfigValidation.configDigest must be a sha256: digest",
    )).toBeTruthy();
    expect(output.includes(
      "accounts component wranglerConfigValidation.d1DatabaseIdPlaceholder must be false",
    )).toBeTruthy();
    expect(output.includes(
      "accounts component wranglerConfigValidation.r2BindingPresent must be true",
    )).toBeTruthy();
    expect(output.includes(
      "accounts component wranglerConfigValidation.containerConfigured must be false",
    )).toBeTruthy();
  } finally {
    await removePath(file);
  }
});

test("accounts serve dry-run prints server plan", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await main([
    "accounts",
    "serve",
    "--dry-run",
    "--issuer",
    "https://accounts.example.test",
    "--subject",
    "tsub_test",
    "--client-id",
    "takos-test",
    "--redirect-uri",
    "http://localhost:3000/callback",
    "--hostname",
    "127.0.0.1",
    "--port",
    "9797",
  ], {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
  });

  expect(code).toEqual(0);
  expect(stderr).toEqual([]);
  const plan = JSON.parse(stdout.join("\n"));
  expect(plan.kind).toEqual("takosumi.accounts.serve@v1");
  expect(plan.hostname).toEqual("127.0.0.1");
  expect(plan.port).toEqual(9797);
  expect(plan.oidcClient.clientId).toEqual("takos-test");
  expect(plan.stripeBilling.configured).toEqual(false);
  expect(plan.upstreamOAuth.configured).toEqual(false);
  expect(plan.passkeys.configured).toEqual(false);
  expect(plan.managedOfferingAccess).toEqual({
    status: "closed",
    source: "default",
  });
  expect(plan.persistence).toEqual({
    configured: false,
    driver: "memory",
  });
  expect(plan.devSession).toEqual({
    configured: false,
  });
  expect(plan.workloadPlatformServices.paths.includes("identity.primary.oidc")).toEqual(true);
  expect(plan.workloadPlatformServices.paths.includes("billing.primary.default")).toEqual(true);
  expect(plan.accountPlaneFacades).toEqual([
    "dashboard web/API",
    "Takosumi Accounts deploy facade",
  ]);
});

test("accounts serve dry-run reports explicit in-memory dev sessions", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await main([
    "accounts",
    "serve",
    "--dry-run",
    "--issuer",
    "https://accounts.example.test",
    "--subject",
    "tsub_test",
    "--dev-session-id",
    "sess_dev_test",
  ], {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
  });

  expect(code).toEqual(0);
  expect(stderr).toEqual([]);
  const plan = JSON.parse(stdout.join("\n"));
  expect(plan.devSession).toEqual({
    configured: true,
  });
});

test("accounts serve rejects dev sessions with Postgres persistence", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await main([
    "accounts",
    "serve",
    "--dry-run",
    "--issuer",
    "https://accounts.example.test",
    "--dev-session-id",
    "sess_dev_test",
    "--database-url",
    "postgres://accounts:secret@db.internal:5432/takosumi_accounts",
  ], {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
  });

  expect(code).toEqual(2);
  expect(stdout).toEqual([]);
  expect(stderr).toEqual([
    "--dev-session-id is only supported with in-memory accounts serve",
  ]);
});

test("accounts serve dry-run requires readiness evidence before opening managed offering access", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await main([
    "accounts",
    "serve",
    "--dry-run",
    "--managed-offering-access",
    "open",
  ], {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
  });

  expect(code).toEqual(2);
  expect(stdout).toEqual([]);
  expect(stderr).toEqual([
    "--managed-offering-access open requires --managed-offering-readiness-file",
  ]);
});

test("accounts serve dry-run rejects incomplete managed offering readiness evidence", async () => {
  const file = await makeTempFile({ suffix: ".json" });
  const document = {
    kind: "takosumi.managed-offering-readiness@v1",
    domains: [],
    rehearsal: [],
  };
  const readinessDigest = await writeManagedOfferingReadinessForTest(
    file,
    document,
  );
  try {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await main([
      "accounts",
      "serve",
      "--dry-run",
      "--managed-offering-access",
      "open",
      "--managed-offering-readiness-file",
      file,
      "--managed-offering-readiness-digest",
      readinessDigest,
      "--managed-offering-evidence-ref",
      "vault://managed-readiness/staging/rehearsal.json",
      "--managed-offering-approval-ref",
      "approval://managed-readiness/staging/operator-approval.json",
      "--managed-offering-public-summary",
      "P0 evidence and one staged launch rehearsal passed.",
    ], {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    });

    expect(code).toEqual(2);
    expect(stdout).toEqual([]);
    expect(stderr.join("\n").includes("Missing P0 domains")).toBeTruthy();
  } finally {
    await removePath(file);
  }
});

test("accounts serve dry-run requires matching managed offering readiness digest", async () => {
  const file = await makeTempFile({ suffix: ".json" });
  const document = await managedOfferingTemplateForTest();
  document.rehearsalRun = completeRehearsalRun(
    "rehearsal-2026-05-13-staging",
  );
  document.domains = document.domains.map((entry) =>
    completeManagedOfferingEntry(entry)
  );
  document.rehearsal = document.rehearsal.map((entry) =>
    completeManagedOfferingEntry(entry, "rehearsal-2026-05-13-staging")
  );
  await writeManagedOfferingReadinessForTest(file, document);

  try {
    const missingDigestStdout: string[] = [];
    const missingDigestStderr: string[] = [];
    const missingDigestCode = await main([
      "accounts",
      "serve",
      "--dry-run",
      "--managed-offering-access",
      "open",
      "--managed-offering-readiness-file",
      file,
      "--managed-offering-evidence-ref",
      "vault://managed-readiness/staging/rehearsal.json",
      "--managed-offering-approval-ref",
      "approval://managed-readiness/staging/operator-approval.json",
      "--managed-offering-public-summary",
      "P0 evidence and one staged launch rehearsal passed.",
    ], {
      stdout: (line) => missingDigestStdout.push(line),
      stderr: (line) => missingDigestStderr.push(line),
    });

    expect(missingDigestCode).toEqual(2);
    expect(missingDigestStdout).toEqual([]);
    expect(missingDigestStderr).toEqual([
      "--managed-offering-access open requires --managed-offering-readiness-digest",
    ]);

    const mismatchStdout: string[] = [];
    const mismatchStderr: string[] = [];
    const mismatchCode = await main([
      "accounts",
      "serve",
      "--dry-run",
      "--managed-offering-access",
      "open",
      "--managed-offering-readiness-file",
      file,
      "--managed-offering-readiness-digest",
      testSha256Digest,
      "--managed-offering-evidence-ref",
      "vault://managed-readiness/staging/rehearsal.json",
      "--managed-offering-approval-ref",
      "approval://managed-readiness/staging/operator-approval.json",
      "--managed-offering-public-summary",
      "P0 evidence and one staged launch rehearsal passed.",
    ], {
      stdout: (line) => mismatchStdout.push(line),
      stderr: (line) => mismatchStderr.push(line),
    });

    expect(mismatchCode).toEqual(2);
    expect(mismatchStdout).toEqual([]);
    expect(mismatchStderr).toEqual([
      "--managed-offering-readiness-digest must match the readiness file digest",
    ]);
  } finally {
    await removePath(file);
  }
});

test("accounts serve dry-run requires separate managed offering approval", async () => {
  const file = await makeTempFile({ suffix: ".json" });
  const document = await managedOfferingTemplateForTest();
  document.rehearsalRun = completeRehearsalRun(
    "rehearsal-2026-05-13-staging",
  );
  document.domains = document.domains.map((entry) =>
    completeManagedOfferingEntry(entry)
  );
  document.rehearsal = document.rehearsal.map((entry) =>
    completeManagedOfferingEntry(entry, "rehearsal-2026-05-13-staging")
  );
  const readinessDigest = await writeManagedOfferingReadinessForTest(
    file,
    document,
  );

  try {
    const missingApprovalStdout: string[] = [];
    const missingApprovalStderr: string[] = [];
    const missingApprovalCode = await main([
      "accounts",
      "serve",
      "--dry-run",
      "--managed-offering-access",
      "open",
      "--managed-offering-readiness-file",
      file,
      "--managed-offering-readiness-digest",
      readinessDigest,
      "--managed-offering-evidence-ref",
      "vault://managed-readiness/staging/rehearsal.json",
      "--managed-offering-public-summary",
      "P0 evidence and one staged launch rehearsal passed.",
    ], {
      stdout: (line) => missingApprovalStdout.push(line),
      stderr: (line) => missingApprovalStderr.push(line),
    });

    expect(missingApprovalCode).toEqual(2);
    expect(missingApprovalStdout).toEqual([]);
    expect(missingApprovalStderr).toEqual([
      "--managed-offering-access open requires --managed-offering-evidence-ref, --managed-offering-public-summary, and --managed-offering-approval-ref",
    ]);

    const placeholderApprovalStdout: string[] = [];
    const placeholderApprovalStderr: string[] = [];
    const placeholderApprovalCode = await main([
      "accounts",
      "serve",
      "--dry-run",
      "--managed-offering-access",
      "open",
      "--managed-offering-readiness-file",
      file,
      "--managed-offering-readiness-digest",
      readinessDigest,
      "--managed-offering-evidence-ref",
      "vault://managed-readiness/staging/rehearsal.json",
      "--managed-offering-approval-ref",
      "approval://todo",
      "--managed-offering-public-summary",
      "P0 evidence and one staged launch rehearsal passed.",
    ], {
      stdout: (line) => placeholderApprovalStdout.push(line),
      stderr: (line) => placeholderApprovalStderr.push(line),
    });

    expect(placeholderApprovalCode).toEqual(2);
    expect(placeholderApprovalStdout).toEqual([]);
    expect(placeholderApprovalStderr).toEqual([
      "--managed-offering-approval-ref must not be a placeholder",
    ]);

    const sameApprovalStdout: string[] = [];
    const sameApprovalStderr: string[] = [];
    const sameApprovalCode = await main([
      "accounts",
      "serve",
      "--dry-run",
      "--managed-offering-access",
      "open",
      "--managed-offering-readiness-file",
      file,
      "--managed-offering-readiness-digest",
      readinessDigest,
      "--managed-offering-evidence-ref",
      "vault://managed-readiness/staging/rehearsal.json",
      "--managed-offering-approval-ref",
      "vault://managed-readiness/staging/rehearsal.json",
      "--managed-offering-public-summary",
      "P0 evidence and one staged launch rehearsal passed.",
    ], {
      stdout: (line) => sameApprovalStdout.push(line),
      stderr: (line) => sameApprovalStderr.push(line),
    });

    expect(sameApprovalCode).toEqual(2);
    expect(sameApprovalStdout).toEqual([]);
    expect(sameApprovalStderr).toEqual([
      "--managed-offering-approval-ref must differ from --managed-offering-evidence-ref",
    ]);
  } finally {
    await removePath(file);
  }
});

test("accounts serve dry-run rejects placeholder managed offering access summaries", async () => {
  const file = await makeTempFile({ suffix: ".json" });
  const document = await managedOfferingTemplateForTest();
  document.rehearsalRun = completeRehearsalRun(
    "rehearsal-2026-05-13-staging",
  );
  document.domains = document.domains.map((entry) =>
    completeManagedOfferingEntry(entry)
  );
  document.rehearsal = document.rehearsal.map((entry) =>
    completeManagedOfferingEntry(entry, "rehearsal-2026-05-13-staging")
  );
  const readinessDigest = await writeManagedOfferingReadinessForTest(
    file,
    document,
  );

  try {
    const placeholderRefStdout: string[] = [];
    const placeholderRefStderr: string[] = [];
    const placeholderRefCode = await main([
      "accounts",
      "serve",
      "--dry-run",
      "--managed-offering-access",
      "open",
      "--managed-offering-readiness-file",
      file,
      "--managed-offering-readiness-digest",
      readinessDigest,
      "--managed-offering-evidence-ref",
      "evidence://todo",
      "--managed-offering-approval-ref",
      "approval://managed-readiness/staging/operator-approval.json",
      "--managed-offering-public-summary",
      "P0 evidence and one staged launch rehearsal passed.",
    ], {
      stdout: (line) => placeholderRefStdout.push(line),
      stderr: (line) => placeholderRefStderr.push(line),
    });

    expect(placeholderRefCode).toEqual(2);
    expect(placeholderRefStdout).toEqual([]);
    expect(placeholderRefStderr).toEqual([
      "--managed-offering-evidence-ref must not be a placeholder",
    ]);

    const shallowSummaryStdout: string[] = [];
    const shallowSummaryStderr: string[] = [];
    const shallowSummaryCode = await main([
      "accounts",
      "serve",
      "--dry-run",
      "--managed-offering-access",
      "open",
      "--managed-offering-readiness-file",
      file,
      "--managed-offering-readiness-digest",
      readinessDigest,
      "--managed-offering-evidence-ref",
      "vault://managed-readiness/staging/rehearsal.json",
      "--managed-offering-approval-ref",
      "approval://managed-readiness/staging/operator-approval.json",
      "--managed-offering-public-summary",
      "todo",
    ], {
      stdout: (line) => shallowSummaryStdout.push(line),
      stderr: (line) => shallowSummaryStderr.push(line),
    });

    expect(shallowSummaryCode).toEqual(2);
    expect(shallowSummaryStdout).toEqual([]);
    const shallowSummaryError = shallowSummaryStderr.join("\n");
    expect(shallowSummaryError.includes(
        "--managed-offering-public-summary must be at least 40 characters",
      )).toBeTruthy();
    expect(shallowSummaryError.includes(
        "--managed-offering-public-summary must not be a placeholder",
      )).toBeTruthy();

    const genericSummaryStdout: string[] = [];
    const genericSummaryStderr: string[] = [];
    const genericSummaryCode = await main([
      "accounts",
      "serve",
      "--dry-run",
      "--managed-offering-access",
      "open",
      "--managed-offering-readiness-file",
      file,
      "--managed-offering-readiness-digest",
      readinessDigest,
      "--managed-offering-evidence-ref",
      "vault://managed-readiness/staging/rehearsal.json",
      "--managed-offering-approval-ref",
      "approval://managed-readiness/staging/operator-approval.json",
      "--managed-offering-public-summary",
      "Launch readiness was reviewed and approved by the operator team.",
    ], {
      stdout: (line) => genericSummaryStdout.push(line),
      stderr: (line) => genericSummaryStderr.push(line),
    });

    expect(genericSummaryCode).toEqual(2);
    expect(genericSummaryStdout).toEqual([]);
    const genericSummaryError = genericSummaryStderr.join("\n");
    expect(genericSummaryError.includes(
        "--managed-offering-public-summary must mention P0 evidence",
      )).toBeTruthy();
    expect(genericSummaryError.includes(
        "--managed-offering-public-summary must mention the staged launch rehearsal",
      )).toBeTruthy();

    const sensitiveSummaryStdout: string[] = [];
    const sensitiveSummaryStderr: string[] = [];
    const sensitiveSummaryCode = await main([
      "accounts",
      "serve",
      "--dry-run",
      "--managed-offering-access",
      "open",
      "--managed-offering-readiness-file",
      file,
      "--managed-offering-readiness-digest",
      readinessDigest,
      "--managed-offering-evidence-ref",
      "vault://managed-readiness/staging/rehearsal.json",
      "--managed-offering-approval-ref",
      "approval://managed-readiness/staging/operator-approval.json",
      "--managed-offering-public-summary",
      "P0 evidence and one staged launch rehearsal passed for cus_sensitive1.",
    ], {
      stdout: (line) => sensitiveSummaryStdout.push(line),
      stderr: (line) => sensitiveSummaryStderr.push(line),
    });

    expect(sensitiveSummaryCode).toEqual(2);
    expect(sensitiveSummaryStdout).toEqual([]);
    expect(sensitiveSummaryStderr.join("\n").includes(
        "--managed-offering-public-summary must not contain Stripe object IDs",
      )).toBeTruthy();
  } finally {
    await removePath(file);
  }
});

test("accounts serve dry-run records open managed offering access after readiness evidence passes", async () => {
  const file = await makeTempFile({ suffix: ".json" });
  const document = await managedOfferingTemplateForTest();
  document.rehearsalRun = completeRehearsalRun(
    "rehearsal-2026-05-13-staging",
  );
  document.domains = document.domains.map((entry) =>
    completeManagedOfferingEntry(entry)
  );
  document.rehearsal = document.rehearsal.map((entry) =>
    completeManagedOfferingEntry(entry, "rehearsal-2026-05-13-staging")
  );
  const readinessDigest = await writeManagedOfferingReadinessForTest(
    file,
    document,
  );

  try {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await main([
      "accounts",
      "serve",
      "--dry-run",
      "--managed-offering-access",
      "open",
      "--managed-offering-readiness-file",
      file,
      "--managed-offering-readiness-digest",
      readinessDigest,
      "--managed-offering-evidence-ref",
      "vault://managed-readiness/staging/rehearsal.json",
      "--managed-offering-approval-ref",
      "approval://managed-readiness/staging/operator-approval.json",
      "--managed-offering-public-summary",
      "P0 evidence and one staged launch rehearsal passed.",
    ], {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    });

    expect(code).toEqual(0);
    expect(stderr).toEqual([]);
    const plan = JSON.parse(stdout.join("\n"));
    expect(plan.managedOfferingAccess).toEqual({
      status: "open",
      source: "--managed-offering-access",
      readinessFile: file,
      readinessDigest,
      evidenceRef: "vault://managed-readiness/staging/rehearsal.json",
      approvalRef:
        "approval://managed-readiness/staging/operator-approval.json",
      publicSummary: "P0 evidence and one staged launch rehearsal passed.",
    });
  } finally {
    await removePath(file);
  }
});

test("accounts serve dry-run prints shared-cell warm pool slots", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await main([
    "accounts",
    "serve",
    "--dry-run",
    "--shared-cell-slots",
    "tokyo-cell-01:2,tokyo-cell-02:1",
  ], {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
  });

  expect(code).toEqual(0);
  expect(stderr).toEqual([]);
  const plan = JSON.parse(stdout.join("\n"));
  expect(plan.sharedCellRuntime).toEqual({
    configured: true,
    source: "--shared-cell-slots",
    slots: [
      { cellId: "tokyo-cell-01", capacity: 2 },
      { cellId: "tokyo-cell-02", capacity: 1 },
    ],
  });
});

test("accounts serve dry-run prints shared-cell scale-out policy", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await main([
    "accounts",
    "serve",
    "--dry-run",
    "--shared-cell-slots",
    "tokyo-cell-01:2",
    "--shared-cell-scale-out-policy",
    JSON.stringify({
      strategy: "available-slots",
      minAvailableSlots: 1,
      maxCells: 3,
    }),
  ], {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
  });

  expect(code).toEqual(0);
  expect(stderr).toEqual([]);
  const plan = JSON.parse(stdout.join("\n"));
  expect(plan.sharedCellRuntime.scaleOutPolicy).toEqual({
    source: "--shared-cell-scale-out-policy",
    policy: {
      strategy: "available-slots",
      minAvailableSlots: 1,
      maxCells: 3,
    },
  });
});

test("accounts serve dry-run reads shared-cell warm pool slots from env", async () => {
  const previous = envGet("TAKOSUMI_ACCOUNTS_SHARED_CELL_SLOTS");
  const stdout: string[] = [];
  const stderr: string[] = [];
  try {
    envSet(
      "TAKOSUMI_ACCOUNTS_SHARED_CELL_SLOTS",
      "tokyo-cell-01:1",
    );
    const code = await main([
      "accounts",
      "serve",
      "--dry-run",
    ], {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    });

    expect(code).toEqual(0);
    expect(stderr).toEqual([]);
    const plan = JSON.parse(stdout.join("\n"));
    expect(plan.sharedCellRuntime).toEqual({
      configured: true,
      source: "TAKOSUMI_ACCOUNTS_SHARED_CELL_SLOTS",
      slots: [
        { cellId: "tokyo-cell-01", capacity: 1 },
      ],
    });
  } finally {
    if (previous === undefined) {
      envDelete("TAKOSUMI_ACCOUNTS_SHARED_CELL_SLOTS");
    } else {
      envSet("TAKOSUMI_ACCOUNTS_SHARED_CELL_SLOTS", previous);
    }
  }
});

test("accounts serve dry-run prints materialize worker config", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await main([
    "accounts",
    "serve",
    "--dry-run",
    "--materialize-worker-url",
    "https://workers.example.test/materialize",
    "--materialize-worker-token",
    "secret-worker-token",
  ], {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
  });

  expect(code).toEqual(0);
  expect(stderr).toEqual([]);
  const plan = JSON.parse(stdout.join("\n"));
  expect(plan.materializeWorker).toEqual({
    configured: true,
    source: "--materialize-worker-url",
    url: "https://workers.example.test/materialize",
    tokenConfigured: true,
  });
});

test("accounts serve dry-run prints workload platform service resolver config", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await main([
    "accounts",
    "serve",
    "--dry-run",
    "--workload-platform-service-resolver-token",
    "resolver-token",
    "--billing-portal-url",
    "https://cloud.example.test/account/billing",
  ], {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
  });

  expect(code).toEqual(0);
  expect(stderr).toEqual([]);
  const plan = JSON.parse(stdout.join("\n"));
  expect(plan.workloadPlatformServices.resolver).toEqual({
    configured: true,
    source: "--workload-platform-service-resolver-token",
    tokenConfigured: true,
    billingPortalUrl: "https://cloud.example.test/account/billing",
  });
});

test("accounts serve dry-run prints metadata export worker config", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await main([
    "accounts",
    "serve",
    "--dry-run",
    "--export-output-dir",
    "/var/lib/takosumi/exports",
    "--export-download-base-url",
    "https://downloads.example.test/accounts/exports",
    "--export-download-ttl-ms",
    "60000",
  ], {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
  });

  expect(code).toEqual(0);
  expect(stderr).toEqual([]);
  const plan = JSON.parse(stdout.join("\n"));
  expect(plan.exportWorker).toEqual({
    configured: true,
    source: "--export-output-dir/--export-download-base-url",
    outputDirectory: "/var/lib/takosumi/exports",
    downloadBaseUrl: "https://downloads.example.test/accounts/exports",
    ttlMs: 60000,
  });
});

test("accounts serve dry-run prints static data export and restore config", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await main([
    "accounts",
    "serve",
    "--dry-run",
    "--export-output-dir",
    "/var/lib/takosumi/exports",
    "--export-download-base-url",
    "https://downloads.example.test/accounts/exports",
    "--export-data-dir",
    "/var/lib/takosumi/export-data",
    "--import-data-restore-dir",
    "/var/lib/takosumi/import-data",
  ], {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
  });

  expect(code).toEqual(0);
  expect(stderr).toEqual([]);
  const plan = JSON.parse(stdout.join("\n"));
  expect(plan.exportWorker).toEqual({
    configured: true,
    source: "--export-output-dir/--export-download-base-url",
    outputDirectory: "/var/lib/takosumi/exports",
    downloadBaseUrl: "https://downloads.example.test/accounts/exports",
    dataDirectory: "/var/lib/takosumi/export-data",
  });
  expect(plan.importDataRestorer).toEqual({
    configured: true,
    source: "--import-data-restore-dir",
    outputDirectory: "/var/lib/takosumi/import-data",
  });
});

test("accounts serve rejects partial materialize worker config", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await main([
    "accounts",
    "serve",
    "--dry-run",
    "--materialize-worker-token",
    "secret-worker-token",
  ], {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
  });

  expect(code).toEqual(2);
  expect(stdout).toEqual([]);
  expect(stderr).toEqual([
    "Materialize worker requires --materialize-worker-url or TAKOSUMI_ACCOUNTS_MATERIALIZE_WORKER_URL",
  ]);
});

test("accounts serve rejects billing portal without workload resolver token", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await main([
    "accounts",
    "serve",
    "--dry-run",
    "--billing-portal-url",
    "https://cloud.example.test/account/billing",
  ], {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
  });

  expect(code).toEqual(2);
  expect(stdout).toEqual([]);
  expect(stderr).toEqual([
    "--billing-portal-url requires --workload-platform-service-resolver-token or TAKOSUMI_ACCOUNTS_WORKLOAD_PLATFORM_SERVICE_RESOLVER_TOKEN",
  ]);
});

test("accounts serve rejects partial metadata export worker config", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await main([
    "accounts",
    "serve",
    "--dry-run",
    "--export-output-dir",
    "/var/lib/takosumi/exports",
  ], {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
  });

  expect(code).toEqual(2);
  expect(stdout).toEqual([]);
  expect(stderr).toEqual([
    "Metadata export worker requires --export-output-dir and --export-download-base-url",
  ]);
});

test("accounts serve dry-run redacts Stripe billing secrets", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await main([
    "accounts",
    "serve",
    "--dry-run",
    "--stripe-secret-key",
    "sk_test",
    "--stripe-webhook-secret",
    "whsec_test",
    "--stripe-api-base",
    "https://api.stripe.test/v1",
    "--stripe-webhook-tolerance-seconds",
    "600",
  ], {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
  });

  expect(code).toEqual(0);
  expect(stderr).toEqual([]);
  const plan = JSON.parse(stdout.join("\n"));
  expect(plan.stripeBilling).toEqual({
    configured: true,
    stripeApiBase: "https://api.stripe.test/v1",
    webhookToleranceSeconds: 600,
  });
  expect(stdout.join("\n").includes("sk_test")).toEqual(false);
  expect(stdout.join("\n").includes("whsec_test")).toEqual(false);
});

test("accounts serve dry-run redacts Postgres persistence URL", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await main([
    "accounts",
    "serve",
    "--dry-run",
    "--database-url",
    "postgres://accounts:secret@db.internal:5432/takosumi_accounts",
  ], {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
  });

  expect(code).toEqual(0);
  expect(stderr).toEqual([]);
  const plan = JSON.parse(stdout.join("\n"));
  expect(plan.persistence).toEqual({
    configured: true,
    driver: "postgres",
    source: "--database-url",
  });
  expect(plan.devSession).toEqual({
    configured: false,
  });
  expect(stdout.join("\n").includes("accounts:secret")).toEqual(false);
  expect(stdout.join("\n").includes("db.internal")).toEqual(false);
});

test("accounts serve dry-run redacts upstream OAuth secrets", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await main([
    "accounts",
    "serve",
    "--dry-run",
    "--subject-secret",
    "subject-secret",
    "--github-client-id",
    "github-client",
    "--github-client-secret",
    "github-secret",
    "--github-redirect-uri",
    "https://accounts.example.test/v1/auth/upstream/callback",
    "--upstream-session-ttl-ms",
    "60000",
  ], {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
  });

  expect(code).toEqual(0);
  expect(stderr).toEqual([]);
  const plan = JSON.parse(stdout.join("\n"));
  expect(plan.upstreamOAuth).toEqual({
    configured: true,
    providers: ["github"],
    sessionTtlMs: 60000,
  });
  expect(stdout.join("\n").includes("subject-secret")).toEqual(false);
  expect(stdout.join("\n").includes("github-secret")).toEqual(false);
});

test("accounts serve dry-run accepts custom upstream OIDC provider", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await main([
    "accounts",
    "serve",
    "--dry-run",
    "--subject-secret",
    "subject-secret",
    "--oidc-provider-id",
    "keycloak",
    "--oidc-issuer",
    "https://idp.example.test/realms/takos",
    "--oidc-authorization-endpoint",
    "https://idp.example.test/realms/takos/protocol/openid-connect/auth",
    "--oidc-token-endpoint",
    "https://idp.example.test/realms/takos/protocol/openid-connect/token",
    "--oidc-userinfo-endpoint",
    "https://idp.example.test/realms/takos/protocol/openid-connect/userinfo",
    "--oidc-client-id",
    "keycloak-client",
    "--oidc-client-secret",
    "keycloak-secret",
    "--oidc-redirect-uri",
    "https://accounts.example.test/v1/auth/upstream/callback",
    "--oidc-scopes",
    "openid,email,profile",
  ], {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
  });

  expect(code).toEqual(0);
  expect(stderr).toEqual([]);
  const plan = JSON.parse(stdout.join("\n"));
  expect(plan.upstreamOAuth).toEqual({
    configured: true,
    providers: ["keycloak"],
  });
  expect(stdout.join("\n").includes("subject-secret")).toEqual(false);
  expect(stdout.join("\n").includes("keycloak-secret")).toEqual(false);
});

test("accounts serve dry-run prints passkey relying party config", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await main([
    "accounts",
    "serve",
    "--dry-run",
    "--passkey-rp-id",
    "accounts.example.test",
    "--passkey-rp-name",
    "Takosumi Accounts",
    "--passkey-origin",
    "https://accounts.example.test",
    "--passkey-session-ttl-ms",
    "60000",
  ], {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
  });

  expect(code).toEqual(0);
  expect(stderr).toEqual([]);
  const plan = JSON.parse(stdout.join("\n"));
  expect(plan.passkeys).toEqual({
    configured: true,
    rpId: "accounts.example.test",
    rpName: "Takosumi Accounts",
    origin: "https://accounts.example.test",
    sessionTtlMs: 60000,
  });
});

test("accounts serve dry-run redacts deploy control token", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await main([
    "accounts",
    "serve",
    "--dry-run",
    "--deploy-control-url",
    "http://takosumi.internal:8788",
    "--deploy-control-token",
    "deploy-control-secret",
  ], {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
  });

  expect(code).toEqual(0);
  expect(stderr).toEqual([]);
  const plan = JSON.parse(stdout.join("\n"));
  expect(plan.deployControl).toEqual({
    configured: true,
    url: "http://takosumi.internal:8788",
    tokenConfigured: true,
  });
  expect(stdout.join("\n").includes("deploy-control-secret")).toEqual(false);
});

test("accounts serve dry-run redacts static use edge materials", async () => {
  const root = await makeTempDir({ prefix: "takosumi-use-edges-" });
  const materialsPath = `${root}/use-edges.json`;
  const stdout: string[] = [];
  const stderr: string[] = [];
  try {
    await writeTextFile(
      materialsPath,
      JSON.stringify({
        db: {
          kind: "database.postgres@v1",
          configRef: "takosumi-accounts://installations/template/db",
          secretRefs: ["secret://db/password"],
          env: {
            DATABASE_URL: "postgres://takos:secret@db.internal/takos",
          },
        },
      }),
    );
    const code = await main([
      "accounts",
      "serve",
      "--dry-run",
      "--use-edge-materials-file",
      materialsPath,
    ], {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    });

    expect(code).toEqual(0);
    expect(stderr).toEqual([]);
    const plan = JSON.parse(stdout.join("\n"));
    expect(plan.bindingMaterializer).toEqual({
      configured: true,
      source: "--use-edge-materials-file",
      bindings: ["db"],
    });
    expect(stdout.join("\n").includes("postgres://takos:secret")).toEqual(false);
    expect(stdout.join("\n").includes("secret://db/password")).toEqual(false);
  } finally {
    await removePath(root, { recursive: true });
  }
});

test("accounts serve rejects malformed static use edge materials", async () => {
  const root = await makeTempDir({ prefix: "takosumi-use-edges-" });
  const materialsPath = `${root}/use-edges.json`;
  const stdout: string[] = [];
  const stderr: string[] = [];
  try {
    await writeTextFile(
      materialsPath,
      JSON.stringify({
        db: { env: { DATABASE_URL: "postgres://takos:secret@db/takos" } },
      }),
    );
    const code = await main([
      "accounts",
      "serve",
      "--dry-run",
      "--use-edge-materials-file",
      materialsPath,
    ], {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    });

    expect(code).toEqual(2);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual(["use edge material 'db' requires configRef"]);
  } finally {
    await removePath(root, { recursive: true });
  }
});

test("accounts serve rejects malformed shared-cell warm pool slot shape", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await main([
    "accounts",
    "serve",
    "--dry-run",
    "--shared-cell-slots",
    "bad-entry",
  ], {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
  });

  expect(code).toEqual(2);
  expect(stdout).toEqual([]);
  expect(stderr).toEqual([
    "shared-cell slots must use cell-id:capacity entries",
  ]);
});

test("accounts serve rejects malformed shared-cell warm pool slots", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await main([
    "accounts",
    "serve",
    "--dry-run",
    "--shared-cell-slots",
    "Tokyo Cell:0",
  ], {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
  });

  expect(code).toEqual(2);
  expect(stdout).toEqual([]);
  expect(stderr).toEqual([
    "shared-cell slot capacity must be a positive integer",
  ]);
});

test("accounts serve rejects shared-cell scale-out policy without slots", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await main([
    "accounts",
    "serve",
    "--dry-run",
    "--shared-cell-scale-out-policy",
    JSON.stringify({ strategy: "manual" }),
  ], {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
  });

  expect(code).toEqual(2);
  expect(stdout).toEqual([]);
  expect(stderr).toEqual([
    "shared-cell scale-out policy requires shared-cell slots",
  ]);
});

test("accounts serve rejects malformed shared-cell scale-out policy", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await main([
    "accounts",
    "serve",
    "--dry-run",
    "--shared-cell-slots",
    "tokyo-cell-01:2",
    "--shared-cell-scale-out-policy",
    JSON.stringify({
      strategy: "available-slots",
      minAvailableSlots: -1,
      maxCells: 3,
    }),
  ], {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
  });

  expect(code).toEqual(2);
  expect(stdout).toEqual([]);
  expect(stderr).toEqual([
    "shared-cell scale-out policy minAvailableSlots must be a non-negative integer",
  ]);
});

test("accounts serve rejects invalid ports", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await main([
    "accounts",
    "serve",
    "--dry-run",
    "--port",
    "nope",
  ], {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
  });

  expect(code).toEqual(2);
  expect(stdout).toEqual([]);
  expect(stderr).toEqual(["--port must be a positive integer"]);
});

test("accounts serve rejects invalid database URLs", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await main([
    "accounts",
    "serve",
    "--dry-run",
    "--database-url",
    "http://db.internal/takosumi_accounts",
  ], {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
  });

  expect(code).toEqual(2);
  expect(stdout).toEqual([]);
  expect(stderr).toEqual([
    "--database-url must be a postgres:// or postgresql:// URL",
  ]);
});

test("accounts serve rejects partial Stripe billing config", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await main([
    "accounts",
    "serve",
    "--dry-run",
    "--stripe-secret-key",
    "sk_test",
  ], {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
  });

  expect(code).toEqual(2);
  expect(stdout).toEqual([]);
  expect(stderr).toEqual([
    "Stripe billing requires --stripe-secret-key and --stripe-webhook-secret",
  ]);
});

test("accounts serve rejects partial upstream OAuth config", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await main([
    "accounts",
    "serve",
    "--dry-run",
    "--subject-secret",
    "subject-secret",
    "--github-client-id",
    "github-client",
  ], {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
  });

  expect(code).toEqual(2);
  expect(stdout).toEqual([]);
  expect(stderr).toEqual([
    "--github-client-id and --github-redirect-uri are required together",
  ]);
});

test("accounts serve rejects partial custom upstream OIDC config", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await main([
    "accounts",
    "serve",
    "--dry-run",
    "--subject-secret",
    "subject-secret",
    "--oidc-provider-id",
    "keycloak",
    "--oidc-client-id",
    "keycloak-client",
  ], {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
  });

  expect(code).toEqual(2);
  expect(stdout).toEqual([]);
  expect(stderr).toEqual([
    "OIDC upstream provider requires --oidc-issuer, --oidc-authorization-endpoint, --oidc-token-endpoint, --oidc-userinfo-endpoint, --oidc-redirect-uri",
  ]);
});

test("accounts serve rejects partial passkey config", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await main([
    "accounts",
    "serve",
    "--dry-run",
    "--passkey-rp-id",
    "accounts.example.test",
  ], {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
  });

  expect(code).toEqual(2);
  expect(stdout).toEqual([]);
  expect(stderr).toEqual([
    "Passkeys require --passkey-rp-id, --passkey-rp-name, and --passkey-origin",
  ]);
});

test("accounts migrate dry-run prints ordered migration plan", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await main([
    "accounts",
    "migrate",
    "--dry-run",
    "--database-url",
    "postgres://accounts:secret@db.internal:5432/takosumi_accounts",
  ], {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
  });

  expect(code).toEqual(0);
  expect(stderr).toEqual([]);
  const plan = JSON.parse(stdout.join("\n"));
  expect(plan.kind).toEqual("takosumi.accounts.migrate@v1");
  expect(plan.database).toEqual({
    configured: true,
    driver: "postgres",
    source: "--database-url",
  });
  expect(plan.migrations.length).toEqual(23);
  expect(plan.migrations[0].name).toEqual("001_app_installation_ledger.sql");
  expect(plan.migrations[16].name).toEqual("017_drop_binding_grant_runtime_binding.sql");
  expect(plan.migrations[22].name).toEqual("023_account_email_verified.sql");
  expect(plan.migrations[0].checksum.startsWith("sha256:")).toEqual(true);
  expect(stdout.join("\n").includes("accounts:secret")).toEqual(false);
  expect(stdout.join("\n").includes("db.internal")).toEqual(false);
});

test("accounts migrate requires database URL when applying", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await main(["accounts", "migrate"], {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
  });

  expect(code).toEqual(2);
  expect(stdout).toEqual([]);
  expect(stderr).toEqual([
    "--database-url or TAKOSUMI_ACCOUNTS_DATABASE_URL is required",
  ]);
});

test("accounts launch-tokens cleanup dry-run prints retention cutoffs", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await main([
    "accounts",
    "launch-tokens",
    "cleanup",
    "--dry-run",
    "--database-url",
    "postgres://accounts:secret@db.internal:5432/takosumi_accounts",
    "--now",
    "2026-05-13T12:00:00Z",
    "--expired-retention-hours",
    "1",
    "--used-retention-hours",
    "2",
  ], {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
  });

  expect(code).toEqual(0);
  expect(stderr).toEqual([]);
  const plan = JSON.parse(stdout.join("\n"));
  expect(plan.kind).toEqual("takosumi.accounts.launch-token-cleanup@v1");
  expect(plan.database).toEqual({
    configured: true,
    driver: "postgres",
    source: "--database-url",
  });
  expect(plan.dryRun).toEqual(true);
  expect(plan.cutoffs.expiredBefore).toEqual("2026-05-13T11:00:00.000Z");
  expect(plan.cutoffs.usedBefore).toEqual("2026-05-13T10:00:00.000Z");
  expect(stdout.join("\n").includes("accounts:secret")).toEqual(false);
  expect(stdout.join("\n").includes("db.internal")).toEqual(false);
});

test("accounts launch-tokens cleanup requires database URL when applying", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await main(["accounts", "launch-tokens", "cleanup"], {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
  });

  expect(code).toEqual(2);
  expect(stdout).toEqual([]);
  expect(stderr).toEqual([
    "--database-url or TAKOSUMI_ACCOUNTS_DATABASE_URL is required",
  ]);
});

test("accounts tokens list calls the Accounts PAT endpoint", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const requests: Request[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    return Promise.resolve(Response.json({
      tokens: [{
        id: "pat_1",
        subject: "tsub_owner",
        name: "CLI",
        prefix: "takpat_abc",
        scopes: ["read", "write"],
        created_at: "2026-05-12T00:00:00.000Z",
      }],
    }));
  }) as typeof fetch;

  try {
    const code = await main([
      "accounts",
      "tokens",
      "list",
      "--accounts-url",
      "http://accounts.local/",
      "--token",
      "sess_owner",
      "--json",
    ], {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    });

    expect(code).toEqual(0);
    expect(stderr).toEqual([]);
    expect(requests[0]?.url).toEqual("http://accounts.local/v1/account/tokens");
    expect(requests[0]?.method).toEqual("GET");
    expect(requests[0]?.headers.get("authorization")).toEqual("Bearer sess_owner");
    expect(JSON.parse(stdout.join("\n")).tokens[0].id).toEqual("pat_1");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("accounts tokens create posts name scopes and expiry", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const requests: Array<{ request: Request; body: string }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const request = new Request(input, init);
    requests.push({ request, body: await request.clone().text() });
    return Response.json({
      token: "takpat_created",
      token_record: {
        id: "pat_2",
        subject: "tsub_owner",
        name: "Workstation",
        prefix: "takpat_cre",
        scopes: ["read", "admin"],
        created_at: "2026-05-12T00:00:00.000Z",
        expires_at: "2026-06-01T00:00:00.000Z",
      },
    }, { status: 201 });
  }) as typeof fetch;

  try {
    const code = await main([
      "accounts",
      "tokens",
      "create",
      "--accounts-url",
      "http://accounts.local",
      "--token",
      "sess_owner",
      "--name",
      "Workstation",
      "--scope",
      "read,admin",
      "--expires-at",
      "2026-06-01T00:00:00.000Z",
      "--json",
    ], {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    });

    expect(code).toEqual(0);
    expect(stderr).toEqual([]);
    expect(requests[0]?.request.url).toEqual("http://accounts.local/v1/account/tokens");
    expect(requests[0]?.request.method).toEqual("POST");
    expect(requests[0]?.request.headers.get("authorization")).toEqual("Bearer sess_owner");
    expect(JSON.parse(requests[0]?.body ?? "{}")).toEqual({
      name: "Workstation",
      scopes: ["read", "admin"],
      expires_at: "2026-06-01T00:00:00.000Z",
    });
    expect(JSON.parse(stdout.join("\n")).token).toEqual("takpat_created");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("accounts tokens revoke posts the target token id", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const requests: Request[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    return Promise.resolve(Response.json({
      token: {
        id: "pat_2",
        subject: "tsub_owner",
        name: "Workstation",
        prefix: "takpat_cre",
        scopes: ["read", "admin"],
        created_at: "2026-05-12T00:00:00.000Z",
        revoked_at: "2026-05-12T00:05:00.000Z",
      },
    }));
  }) as typeof fetch;

  try {
    const code = await main([
      "accounts",
      "tokens",
      "revoke",
      "pat_2",
      "--accounts-url",
      "http://accounts.local",
      "--token",
      "sess_owner",
    ], {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    });

    expect(code).toEqual(0);
    expect(stderr).toEqual([]);
    expect(requests[0]?.url).toEqual("http://accounts.local/v1/account/tokens/pat_2/revoke");
    expect(requests[0]?.method).toEqual("POST");
    expect(stdout.join("\n")).toEqual([
        "Personal access token pat_2",
        "  name: Workstation",
        "  state: revoked",
      ].join("\n"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("accounts tokens create rejects invalid PAT scopes before fetch", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;
  globalThis.fetch = (() => {
    fetchCalled = true;
    return Promise.reject(new Error("fetch should not be called"));
  }) as typeof fetch;

  try {
    const code = await main([
      "accounts",
      "tokens",
      "create",
      "--scope",
      "service.import@v1",
    ], {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    });

    expect(code).toEqual(2);
    expect(stdout).toEqual([]);
    expect(fetchCalled).toEqual(false);
    expect(stderr).toEqual(["--scope must contain only: read, write, admin"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("installations list calls Takosumi Accounts with the target space", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const requests: Request[] = [];
  const originalFetch = globalThis.fetch;
  const originalSpaceId = envGet("TAKOS_SPACE_ID");
  globalThis.fetch = ((input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    return Promise.resolve(Response.json({
      installations: [{
        id: "inst_1",
        app_id: "takos.chat",
        status: "ready",
        mode: "shared-cell",
      }],
    }));
  }) as typeof fetch;
  envSet("TAKOS_SPACE_ID", "space_1");

  try {
    const code = await main([
      "installations",
      "list",
      "--accounts-url",
      "http://accounts.local/",
      "--token",
      "sess_accounts",
      "--json",
    ], {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    });

    expect(code).toEqual(0);
    expect(stderr).toEqual([]);
    expect(requests[0]?.url).toEqual("http://accounts.local/v1/installations?space_id=space_1");
    expect(requests[0]?.headers.get("authorization")).toEqual("Bearer sess_accounts");
    expect(JSON.parse(stdout.join("\n")).installations[0].id).toEqual("inst_1");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalSpaceId === undefined) {
      envDelete("TAKOS_SPACE_ID");
    } else {
      envSet("TAKOS_SPACE_ID", originalSpaceId);
    }
  }
});

test("installations inspect prints use edges and permission scopes", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const requests: Request[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    return Promise.resolve(Response.json({
      installation: {
        id: "inst_1",
        app_id: "takos.chat",
        status: "ready",
        mode: "shared-cell",
        space_id: "space_1",
        source: {
          url: "https://github.com/takos/takos",
          ref: "v1.2.3",
        },
      },
      use_edges: [{
        name: "auth",
        kind: "identity.oidc@v1",
      }],
      permission_scopes: [{
        capability: "deploy.intent.write",
        revoked_at: null,
      }, {
        capability: "logs.read.own",
        revoked_at: "2026-05-09T00:00:00.000Z",
      }],
      oidc_client: {
        client_id: "toc_inst_1",
        token_endpoint_auth_method: "client_secret_post",
        redirect_uris: ["http://localhost:8787/auth/oidc/callback"],
      },
      runtime_target: null,
    }));
  }) as typeof fetch;

  try {
    const code = await main([
      "installations",
      "inspect",
      "inst_1",
      "--accounts-url",
      "http://accounts.local",
      "--token",
      "sess_accounts",
    ], {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    });

    expect(code).toEqual(0);
    expect(stderr).toEqual([]);
    expect(requests[0]?.url).toEqual("http://accounts.local/v1/installations/inst_1");
    expect(requests[0]?.headers.get("authorization")).toEqual("Bearer sess_accounts");
    const output = stdout.join("\n");
    expect(output.includes("Installation inst_1")).toEqual(true);
    expect(output.includes("Use edges:")).toEqual(true);
    expect(output.includes("auth  identity.oidc@v1")).toEqual(true);
    expect(output.includes("toc_inst_1  client_secret_post")).toEqual(true);
    expect(output.includes("http://localhost:8787/auth/oidc/callback")).toEqual(true);
    expect(output.includes("Permission scopes:")).toEqual(true);
    expect(output.includes("deploy.intent.write  active")).toEqual(true);
    expect(output.includes("logs.read.own  revoked")).toEqual(true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("installations uninstall deletes through ledger-retained Accounts route", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const requests: Request[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    return Promise.resolve(Response.json({
      installation: {
        id: "inst_1",
        status: "suspended",
      },
      revoked_permission_scopes: [{
        id: "grant_logs",
        capability: "logs.read.own",
        revoked_at: "2026-05-09T01:00:00.000Z",
      }],
      event: {
        type: "installation.uninstalled",
      },
    }));
  }) as typeof fetch;

  try {
    const code = await main([
      "installations",
      "uninstall",
      "inst_1",
      "--reason",
      "user removed app",
      "--accounts-url",
      "http://accounts.local",
      "--token",
      "accounts-token",
    ], {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    });

    expect(code).toEqual(0);
    expect(stderr).toEqual([]);
    expect(requests[0]?.url).toEqual("http://accounts.local/v1/installations/inst_1");
    expect(requests[0]?.method).toEqual("DELETE");
    expect(requests[0]?.headers.get("authorization")).toEqual("Bearer accounts-token");
    expect(requests[0]?.headers.get("content-type")).toEqual("application/json");
    expect(await requests[0]?.json()).toEqual({ reason: "user removed app" });
    expect(stdout.join("\n")).toEqual([
        "Installation inst_1",
        "  status: suspended",
        "  revoked permission scopes: 1",
        "  event: installation.uninstalled",
      ].join("\n"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("installations status patches the target installation", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const requests: Request[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    return Promise.resolve(Response.json({
      installation: {
        id: "inst_1",
        status: "ready",
      },
    }));
  }) as typeof fetch;

  try {
    const code = await main([
      "installations",
      "status",
      "inst_1",
      "--status",
      "ready",
      "--reason",
      "healthcheck passed",
      "--accounts-url",
      "http://accounts.local",
      "--token",
      "accounts-token",
    ], {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    });

    expect(code).toEqual(0);
    expect(stderr).toEqual([]);
    expect(requests[0]?.url).toEqual("http://accounts.local/v1/installations/inst_1/status");
    expect(requests[0]?.method).toEqual("PATCH");
    expect(requests[0]?.headers.get("authorization")).toEqual("Bearer accounts-token");
    expect(requests[0]?.headers.get("content-type")).toEqual("application/json");
    expect(await requests[0]?.json()).toEqual({
      status: "ready",
      reason: "healthcheck passed",
    });
    expect(stdout.join("\n")).toEqual("Installation inst_1\n  status: ready");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("installations status sends operation completion metadata", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const requests: Request[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    return Promise.resolve(Response.json({
      installation: {
        id: "inst_1",
        status: "ready",
        mode: "dedicated",
      },
      event: {
        type: "installation.materialize-succeeded",
      },
    }));
  }) as typeof fetch;

  try {
    const code = await main([
      "installations",
      "status",
      "inst_1",
      "--status",
      "ready",
      "--mode",
      "dedicated",
      "--operation-id",
      "op_materialize",
      "--runtime-target-record-id",
      "rtb_1",
      "--runtime-target-type",
      "dedicated",
      "--runtime-target-id",
      "tokyo-dedicated-01",
      "--reason",
      "dedicated runtime ready",
      "--accounts-url",
      "http://accounts.local",
    ], {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    });

    expect(code).toEqual(0);
    expect(stderr).toEqual([]);
    expect(await requests[0]?.json()).toEqual({
      status: "ready",
      reason: "dedicated runtime ready",
      mode: "dedicated",
      operationId: "op_materialize",
      runtimeTarget: {
        runtimeTargetId: "rtb_1",
        targetType: "dedicated",
        targetId: "tokyo-dedicated-01",
      },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("installations status sends operation failure metadata", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const requests: Request[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    return Promise.resolve(Response.json({
      installation: {
        id: "inst_1",
        status: "failed",
      },
      event: {
        type: "installation.export-failed",
      },
    }));
  }) as typeof fetch;

  try {
    const code = await main([
      "installations",
      "status",
      "inst_1",
      "--status",
      "failed",
      "--operation",
      "export",
      "--operation-id",
      "op_export",
      "--reason",
      "bundle writer failed",
      "--error",
      "bundle writer failed",
      "--accounts-url",
      "http://accounts.local",
    ], {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    });

    expect(code).toEqual(0);
    expect(stderr).toEqual([]);
    expect(await requests[0]?.json()).toEqual({
      status: "failed",
      reason: "bundle writer failed",
      operation: "export",
      operationId: "op_export",
      error: "bundle writer failed",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("installations status rejects missing or invalid status", async () => {
  const missingStdout: string[] = [];
  const missingStderr: string[] = [];
  const missingCode = await main([
    "installations",
    "status",
    "inst_1",
  ], {
    stdout: (line) => missingStdout.push(line),
    stderr: (line) => missingStderr.push(line),
  });
  expect(missingCode).toEqual(2);
  expect(missingStdout).toEqual([]);
  expect(missingStderr).toEqual(["--status is required"]);

  const invalidStdout: string[] = [];
  const invalidStderr: string[] = [];
  const invalidCode = await main([
    "installations",
    "status",
    "inst_1",
    "--status",
    "paused",
  ], {
    stdout: (line) => invalidStdout.push(line),
    stderr: (line) => invalidStderr.push(line),
  });
  expect(invalidCode).toEqual(2);
  expect(invalidStdout).toEqual([]);
  expect(invalidStderr).toEqual([
    "--status must be one of: installing, ready, suspended, exported, failed",
  ]);
});

test("installations materialize posts a dedicated request", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const requests: Request[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    return Promise.resolve(Response.json({
      operationId: "op_materialize",
      installationId: "inst_1",
      fromMode: "shared-cell",
      toMode: "dedicated",
      trackingUrl:
        "/v1/installations/inst_1/events?types=installation.materialize-requested",
    }));
  }) as typeof fetch;

  try {
    const code = await main([
      "installations",
      "materialize",
      "inst_1",
      "--mode",
      "dedicated",
      "--region",
      "tokyo",
      "--compute",
      "small",
      "--database",
      "small",
      "--object-store",
      "standard",
      "--cutover-strategy",
      "blue-green",
      "--drain-seconds",
      "30",
      "--cost-ack",
      "--idempotency-key",
      "idem-materialize",
      "--accounts-url",
      "http://accounts.local",
      "--token",
      "accounts-token",
    ], {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    });

    expect(code).toEqual(0);
    expect(stderr).toEqual([]);
    expect(requests[0]?.url).toEqual("http://accounts.local/v1/installations/inst_1/materialize");
    expect(requests[0]?.method).toEqual("POST");
    expect(requests[0]?.headers.get("authorization")).toEqual("Bearer accounts-token");
    expect(requests[0]?.headers.get("idempotency-key")).toEqual("idem-materialize");
    expect(await requests[0]?.json()).toEqual({
      mode: "dedicated",
      region: "tokyo",
      plan: {
        compute: "small",
        database: "small",
        objectStore: "standard",
      },
      cutover: {
        strategy: "blue-green",
        drainSeconds: 30,
      },
      confirm: {
        costAck: true,
        permissionDigest: await testSha256HexDigest({
          operation: "materialize",
          installationId: "inst_1",
          mode: "dedicated",
          region: "tokyo",
          plan: {
            compute: "small",
            database: "small",
            objectStore: "standard",
          },
          cutover: {
            strategy: "blue-green",
            drainSeconds: 30,
          },
        }),
      },
    });
    expect(stdout.join("\n")).toEqual([
        "Materialize operation op_materialize",
        "  installation: inst_1",
        "  mode: shared-cell -> dedicated",
        "  tracking: /v1/installations/inst_1/events?types=installation.materialize-requested",
      ].join("\n"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("installations materialize rejects unsupported modes", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await main([
    "installations",
    "materialize",
    "inst_1",
    "--mode",
    "shared-cell",
    "--region",
    "tokyo",
    "--cost-ack",
  ], {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
  });

  expect(code).toEqual(2);
  expect(stdout).toEqual([]);
  expect(stderr).toEqual(["--mode must be dedicated"]);
});

test("installations materialize requires explicit cost acknowledgement", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await main([
    "installations",
    "materialize",
    "inst_1",
    "--region",
    "tokyo",
  ], {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
  });

  expect(code).toEqual(2);
  expect(stdout).toEqual([]);
  expect(stderr).toEqual(["--cost-ack is required"]);
});

test("installations export posts a pending bundle request", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const requests: Request[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    return Promise.resolve(Response.json({
      operationId: "op_export",
      status: "preparing",
      trackingUrl:
        "/v1/installations/inst_1/events?types=installation.export-requested",
      downloadUrl: null,
      downloadExpiresAt: null,
    }));
  }) as typeof fetch;

  try {
    const code = await main([
      "installations",
      "export",
      "inst_1",
      "--include-data",
      "--encryption-method",
      "age",
      "--recipient",
      "age1one,age1two",
      "--data",
      "postgres,blobs",
      "--secrets",
      "templates-only",
      "--idempotency-key",
      "idem-export",
      "--accounts-url",
      "http://accounts.local",
      "--token",
      "accounts-token",
    ], {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    });

    expect(code).toEqual(0);
    expect(stderr).toEqual([]);
    expect(requests[0]?.url).toEqual("http://accounts.local/v1/installations/inst_1/export");
    expect(requests[0]?.method).toEqual("POST");
    expect(requests[0]?.headers.get("idempotency-key")).toEqual("idem-export");
    expect(await requests[0]?.json()).toEqual({
      includeData: true,
      format: "bundle",
      encryption: {
        method: "age",
        recipients: ["age1one", "age1two"],
      },
      scope: {
        data: ["postgres", "blobs"],
        secrets: "templates-only",
      },
    });
    expect(stdout.join("\n")).toEqual([
        "Export operation op_export",
        "  status: preparing",
        "  tracking: /v1/installations/inst_1/events?types=installation.export-requested",
      ].join("\n"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("installations export requires age recipients", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await main([
    "installations",
    "export",
    "inst_1",
    "--encryption-method",
    "age",
  ], {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
  });

  expect(code).toEqual(2);
  expect(stdout).toEqual([]);
  expect(stderr).toEqual([
    "--recipient is required when --encryption-method age",
  ]);
});


// ---------------------------------------------------------------------------
// accounts migrate-d1 (Cloudflare D1 migration runner)
//
// The runner is built around the injectable `D1ExecuteCommand` seam so the
// real `npx wrangler d1 execute` shell-out can be replaced with a hermetic
// fake. These tests exercise the forward-only apply path, version-skip
// de-dup, the wrangler `--json` envelope parsing, and the fail-without-insert
// behaviour on a mid-flight error — none of which the production code path
// can verify against the live Cloudflare API.
// ---------------------------------------------------------------------------

interface RecordedD1Call {
  readonly op: "execute" | "query";
  readonly sql: string;
  readonly databaseId: string;
  readonly accountId?: string;
}

/**
 * Hermetic D1 execute command backed by an in-memory `version -> row` map.
 * `execute` records the SQL and, when it is the runner's tracking INSERT,
 * stores the version. `query` returns the recorded versions, simulating the
 * `SELECT version FROM takosumi_accounts_schema_migrations` round-trip.
 */
function createFakeD1Command(
  options: { readonly seedVersions?: readonly number[] } = {},
): {
  readonly command: D1ExecuteCommand;
  readonly calls: RecordedD1Call[];
  readonly versions: () => number[];
} {
  const calls: RecordedD1Call[] = [];
  const versions = new Set<number>(options.seedVersions ?? []);
  const command: D1ExecuteCommand = {
    execute(input) {
      calls.push({
        op: "execute",
        sql: input.sql,
        databaseId: input.databaseId,
        ...(input.accountId ? { accountId: input.accountId } : {}),
      });
      const insertMatch = input.sql.match(
        /INSERT INTO takosumi_accounts_schema_migrations \(version, name, applied_at\) VALUES \((\d+),/,
      );
      if (insertMatch) versions.add(Number(insertMatch[1]));
      return Promise.resolve({ stdout: "" });
    },
    query<T>(input: {
      readonly databaseId: string;
      readonly accountId?: string;
      readonly sql: string;
    }): Promise<readonly T[]> {
      calls.push({
        op: "query",
        sql: input.sql,
        databaseId: input.databaseId,
        ...(input.accountId ? { accountId: input.accountId } : {}),
      });
      const rows = [...versions].sort((a, b) => a - b)
        .map((version) => ({ version })) as unknown as T[];
      return Promise.resolve(rows);
    },
  };
  return {
    command,
    calls,
    versions: () => [...versions].sort((a, b) => a - b),
  };
}

test("migrate-d1 dry-run makes zero wrangler calls", async () => {
  const fake = createFakeD1Command();
  const report = await applyD1AccountsMigrations({
    databaseId: "db-uuid",
    dryRun: true,
    command: fake.command,
  });
  expect(fake.calls.length).toEqual(0);
  expect(report.applied).toEqual([]);
  expect(report.skipped).toEqual([]);
  expect(report.kind).toEqual("takosumi.accounts.migrate-d1@v1");
  expect(report.dryRun).toEqual(true);
  // The plan lists the bootstrap migration (version 0) without applying it.
  expect(report.migrations[0].version).toEqual(0);
});

test("migrate-d1 applies the bootstrap version on a clean DB", async () => {
  const fake = createFakeD1Command();
  const report = await applyD1AccountsMigrations({
    databaseId: "db-uuid",
    accountId: "acct-1",
    dryRun: false,
    command: fake.command,
  });
  expect(report.applied).toEqual([0]);
  expect(report.skipped).toEqual([]);
  // Records the version the Worker's ensureD1SchemaVersion later reads
  // (EXPECTED_D1_SCHEMA_VERSION = 0) into the same table name.
  expect(fake.versions()).toEqual([0]);
  // First write ensures the tracking table exists, with the exact name the
  // Worker reads.
  expect(fake.calls[0].sql.includes(
      "CREATE TABLE IF NOT EXISTS takosumi_accounts_schema_migrations",
    )).toBeTruthy();
  // The SELECT and the per-migration writes carry the account id through.
  expect(fake.calls.every((call) => call.accountId === "acct-1")).toBeTruthy();
  const inserted = fake.calls.find((call) =>
    call.sql.startsWith("INSERT INTO takosumi_accounts_schema_migrations")
  );
  expect(inserted).toBeTruthy();
});

test("migrate-d1 skips an already-applied version (idempotent re-run)", async () => {
  const fake = createFakeD1Command({ seedVersions: [0] });
  const report = await applyD1AccountsMigrations({
    databaseId: "db-uuid",
    dryRun: false,
    command: fake.command,
  });
  expect(report.applied).toEqual([]);
  expect(report.skipped).toEqual([0]);
  // No tracking INSERT and no migration body execute on the skip path; the
  // only writes are the idempotent CREATE TABLE + the SELECT.
  const inserts = fake.calls.filter((call) =>
    call.sql.startsWith("INSERT INTO takosumi_accounts_schema_migrations")
  );
  expect(inserts.length).toEqual(0);
});

test("migrate-d1 parses the wrangler --json array-of-envelopes shape", async () => {
  // The default command returns wrangler's structured envelope. Verify the
  // version-skip logic reads versions out of the nested results array, both
  // for the array-wrapped and bare-object envelope shapes wrangler emits.
  const captured: string[] = [];
  const wranglerJson = JSON.stringify([
    { results: [{ results: [{ version: 0 }] }] },
  ]);
  const command: D1ExecuteCommand = {
    execute(input) {
      captured.push(input.sql);
      return Promise.resolve({ stdout: "" });
    },
    query<T>(): Promise<readonly T[]> {
      const parsed = JSON.parse(wranglerJson) as Array<
        { results?: Array<{ results?: Array<{ version: number }> }> }
      >;
      const rows: { version: number }[] = [];
      for (const envelope of parsed) {
        for (const result of envelope.results ?? []) {
          for (const row of result.results ?? []) rows.push(row);
        }
      }
      return Promise.resolve(rows as unknown as T[]);
    },
  };
  const report = await applyD1AccountsMigrations({
    databaseId: "db-uuid",
    dryRun: false,
    command,
  });
  // version 0 came back from the parsed envelope, so it is skipped.
  expect(report.skipped).toEqual([0]);
  expect(report.applied).toEqual([]);
});

test("migrate-d1 leaves the ledger untouched when a migration body fails", async () => {
  const inserts: string[] = [];
  const command: D1ExecuteCommand = {
    execute(input) {
      if (input.sql.startsWith("INSERT INTO")) {
        inserts.push(input.sql);
        return Promise.resolve({ stdout: "" });
      }
      // Fail on the bootstrap migration body (not the CREATE TABLE / INSERT).
      if (input.sql.includes("takosumi_accounts_documents")) {
        return Promise.reject(new Error("wrangler exited with code 1"));
      }
      return Promise.resolve({ stdout: "" });
    },
    query<T>(): Promise<readonly T[]> {
      return Promise.resolve([] as unknown as T[]);
    },
  };
  await assertRejects(
    () =>
      applyD1AccountsMigrations({
        databaseId: "db-uuid",
        dryRun: false,
        command,
      }),
    Error,
    "wrangler exited with code 1",
  );
  // Mid-flight failure must NOT record the tracking row, so a re-run retries.
  expect(inserts.length).toEqual(0);
});

test("accounts migrate-d1 CLI requires --database-id", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await runAccountsMigrateD1([], {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
  });
  expect(code).toEqual(2);
  expect(stderr).toEqual(["--database-id is required"]);
});

test("accounts migrate-d1 CLI applies via the injected command and exits 0", async () => {
  const fake = createFakeD1Command();
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await runAccountsMigrateD1(
    ["--database-id", "db-uuid", "--json"],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    },
    fake.command,
  );
  expect(code).toEqual(0);
  expect(stderr).toEqual([]);
  const report = JSON.parse(stdout.join("\n"));
  expect(report.applied).toEqual([0]);
  expect(fake.versions()).toEqual([0]);
});

test("accounts migrate-d1 CLI surfaces a wrangler failure as exit 1", async () => {
  const command: D1ExecuteCommand = {
    execute() {
      return Promise.reject(new Error("wrangler exited with code 1: boom"));
    },
    query<T>(): Promise<readonly T[]> {
      return Promise.resolve([] as unknown as T[]);
    },
  };
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await runAccountsMigrateD1(
    ["--database-id", "db-uuid"],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    },
    command,
  );
  expect(code).toEqual(1);
  expect(stdout).toEqual([]);
  expect(stderr[0].includes("Failed to apply D1 migrations")).toBeTruthy();
  expect(stderr[0].includes("wrangler exited with code 1")).toBeTruthy();
});

test("accounts migrate-d1 CLI rejects --local with --remote", async () => {
  const fake = createFakeD1Command();
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await runAccountsMigrateD1(
    ["--database-id", "db-uuid", "--local", "--remote"],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    },
    fake.command,
  );
  expect(code).toEqual(2);
  expect(stderr).toEqual(["--local and --remote are mutually exclusive"]);
  expect(fake.calls.length).toEqual(0);
});

test("accounts serve rejects a non-integer --port (integerOption throws)", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await main([
    "accounts",
    "serve",
    "--dry-run",
    "--port",
    "not-a-number",
  ], {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
  });
  expect(code).toEqual(2);
  expect(stdout).toEqual([]);
  expect(stderr).toEqual(["--port must be a positive integer"]);
});

test("accounts serve accepts a valid --port in the dry-run plan", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await main([
    "accounts",
    "serve",
    "--dry-run",
    "--port",
    "9090",
  ], {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
  });
  expect(code).toEqual(0);
  expect(stderr).toEqual([]);
  const plan = JSON.parse(stdout.join("\n"));
  expect(plan.port).toEqual(9090);
});

// ---------------------------------------------------------------------------
// parseOptions / integerOption (cli-options.ts)
// ---------------------------------------------------------------------------

test("parseOptions: --key=value carries a flag-like value verbatim", () => {
  // Space-separated form mis-parses a value that looks like a flag, so the
  // inline `--key=value` form is the canonical way to pass it.
  const options = parseOptions(["--reason=--keep-going", "--json"]);
  expect(options.reason).toEqual("--keep-going");
  expect(options.json).toEqual(true);
});

test("parseOptions: a value-bearing flag followed by --flag is boolean", () => {
  // Documented limitation: `--reason --json` cannot tell that --reason wanted
  // a value, so it stays boolean. Both flags are still parsed (no swallowing
  // of the trailing --json).
  const options = parseOptions(["--reason", "--json"]);
  expect(options.reason).toEqual(true);
  expect(options.json).toEqual(true);
});

test("parseOptions: -- ends option parsing", () => {
  const options = parseOptions(["--dry-run", "--", "--not-a-flag"]);
  expect(options.dryRun).toEqual(true);
  // Tokens after the sentinel are not interpreted as flags.
  expect(options.notAFlag).toEqual(undefined);
  expect(Object.keys(options).includes("")).toEqual(false);
});

test("integerOption throws TypeError on an invalid value", () => {
  let threw = false;
  try {
    integerOption({ port: "0" }, "port", 8787);
  } catch (error) {
    threw = true;
    expect(error instanceof TypeError).toBeTruthy();
    expect((error as TypeError).message).toEqual("--port must be a positive integer");
  }
  expect(threw).toBeTruthy();
});

test("integerOption returns the fallback when the flag is absent", () => {
  expect(integerOption({}, "port", 8787)).toEqual(8787);
  expect(integerOption({ port: "443" }, "port", 8787)).toEqual(443);
});
