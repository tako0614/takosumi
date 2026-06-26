import { expect, test } from "bun:test";
import {
  assert,
  assertEquals,
  assertRejects,
} from "../../../helpers/assert.ts";
import {
  access,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";
import { main } from "../../../../accounts/cli/src/main.ts";
import { runAccountsMigrateD1 } from "../../../../accounts/cli/src/cli-accounts-commands.ts";
import {
  applyD1AccountsMigrations,
  type D1ExecuteCommand,
} from "../../../../accounts/cli/src/cli-accounts-db.ts";
import {
  integerOption,
  parseOptions,
} from "../../../../accounts/cli/src/cli-options.ts";
import { runPlatformSecrets } from "../../../../accounts/cli/src/cli-platform-secrets-commands.ts";

const textEncoder = new TextEncoder();

async function makeTempFile(
  options: { suffix?: string } = {},
): Promise<string> {
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

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
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
  return `sha256:${[...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

test("accounts seed prints a stable seed plan", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await main(
    [
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
    ],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    },
  );

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
  const code = await main(
    [
      "accounts",
      "seed",
      "--issuer",
      "https://accounts.example.test/",
      "--subject",
      "user_1",
    ],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    },
  );

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

type PlatformReadinessTemplateEntryForTest = Record<string, unknown> & {
  id?: unknown;
  requiredEvidenceTypes?: unknown;
};

type PlatformReadinessTemplateForTest = Record<string, unknown> & {
  rehearsalRun: Record<string, unknown>;
  domains: PlatformReadinessTemplateEntryForTest[];
  rehearsal: PlatformReadinessTemplateEntryForTest[];
};

const platformReadinessRehearsalStepIdsForTest = [
  "fresh-signup",
  "capsule-launch",
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

async function platformReadinessTemplateForTest(): Promise<PlatformReadinessTemplateForTest> {
  const stdout: string[] = [];
  const code = await main(["launch-readiness", "template"], {
    stdout: (line) => stdout.push(line),
    stderr: () => undefined,
  });
  expect(code).toEqual(0);
  return JSON.parse(stdout.join("\n")) as PlatformReadinessTemplateForTest;
}

async function writePlatformReadinessForTest(
  file: string,
  document: unknown,
): Promise<string> {
  await writeTextFile(file, JSON.stringify(document));
  return await testSha256HexDigest(document);
}

function completePlatformReadinessEntry(
  rawEntry: PlatformReadinessTemplateEntryForTest,
  runId?: string,
): Record<string, unknown> {
  const requiredTypes = Array.isArray(rawEntry.requiredEvidenceTypes)
    ? rawEntry.requiredEvidenceTypes.filter(
        (type): type is string => typeof type === "string",
      )
    : ["command-transcript"];
  const id = typeof rawEntry.id === "string" ? rawEntry.id : "unknown";
  const rehearsalStepIndex = runId
    ? platformReadinessRehearsalStepIdsForTest.indexOf(id)
    : -1;
  const completedAt =
    rehearsalStepIndex >= 0
      ? `2026-05-12T01:${String(rehearsalStepIndex).padStart(2, "0")}:00Z`
      : "2026-05-12T01:00:00Z";
  return {
    ...rawEntry,
    ...(runId ? { runId } : {}),
    status: "passed",
    owner: "ops",
    environment:
      id === "production-topology" ? "staging+production" : "staging",
    reviewer: "release-owner",
    completedAt,
    evidence: requiredTypes.map((type) => ({
      type,
      ref: `runbook://platform-readiness/${id}/${type}`,
      summary: `${id} ${type} evidence recorded in staging`,
      private: true,
      publicSummary: `${id} ${type} was reviewed as public-safe launch evidence.`,
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
          manifestRef: `artifact://topology/${topologyEnvironment}/manifest.json`,
          componentCount: 9,
        };
      case "artifact-digest":
        return {
          topologyEnvironment,
          artifactDigestEvidenceRef: `vault://topology/${topologyEnvironment}/artifact-digests`,
          deployableComponentCount: 6,
        };
      case "migration-transcript":
        return {
          topologyEnvironment,
          migrationTranscriptRef: `run://accounts-migrations/${topologyEnvironment}/2026-05-13`,
        };
      case "health-probe":
        return {
          topologyEnvironment,
          healthProbeEvidenceRef: `vault://topology/${topologyEnvironment}/health-probes`,
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
          rollbackRef: `release://takosumi/${topologyEnvironment}/previous`,
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
        launchScope: "platform-capsule-starter",
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
        workspaceId: "ws_rehearsal",
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
        issuer: "https://app.takosumi.com",
      };
    case "key-rotation-drill":
      return {
        rotationRunId: "key_rotation_rehearsal",
        keyId: "kid-rehearsal",
        previousKeyId: "kid-rehearsal-before",
        overlapJwksDigest:
          "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
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
        workspaceId: "ws_rehearsal",
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
        workspaceId: "ws_rehearsal",
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
        workspaceId: "ws_rehearsal",
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
        workspaceId: "ws_rehearsal",
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
    case "run-kill-switch":
      return {
        killSwitchRunId: "deploy_kill_switch_rehearsal",
        runId: "run_rehearsal",
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
        tenantACapsuleId: "cap_tenant_a",
        tenantBCapsuleId: "cap_tenant_b",
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
        labelSet: "capsule_id,tenant_id",
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
        capsuleId: "cap_rehearsal",
      };
    case "readiness-probe":
      return {
        probeRunId: "readiness_probe_rehearsal",
        endpoint: "https://app.takosumi.com/healthz",
      };
    case "continuity-evidence":
      return {
        continuityCheckId: "continuity_rehearsal",
        capsuleId: "cap_rehearsal",
        sourceCommit: "abcdef0123456789abcdef0123456789abcdef01",
        oidcClientId: "oidc_client_rehearsal",
        domainName: "api.acme.example",
        dataNamespace: "namespace_rehearsal",
        serviceGrantDigest: testSha256Digest,
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
        dataClasses: "account,workspace,capsule,run,output",
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
        dashboardRef: "dashboard://slo/platform-readiness",
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
        endpoint: "https://app.takosumi.com/.well-known/openid-configuration",
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
        termsUrl: "https://takosumi.com/legal/terms",
        privacyUrl: "https://takosumi.com/legal/privacy",
        dpaUrl: "https://takosumi.com/legal/dpa",
      };
    case "support-mailbox-test":
      return {
        mailbox: "support@takosumi.com",
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
        workspaceId: "ws_rehearsal",
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
        capsuleId: "cap_rehearsal",
        launchTokenJti: "jti_rehearsal",
        sessionId: "session_rehearsal",
      };
    case "capsule-created":
      return {
        capsuleId: "cap_rehearsal",
        workspaceId: "ws_rehearsal",
        sourceUrl: "https://github.com/tako0614/takosumi-capsule-rehearsal",
        commitSha: "abcdef0123456789abcdef0123456789abcdef01",
      };
    case "capsule-session":
      return {
        capsuleId: "cap_rehearsal",
        subject: "tsub_rehearsal",
        sessionId: "session_rehearsal",
      };
    case "capsule-plan-run":
      return {
        capsuleId: "cap_rehearsal",
        planRunId: "run_plan_rehearsal",
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
    case "capsule-apply":
      return {
        capsuleId: "cap_rehearsal",
        applyRunId: "run_apply_rehearsal",
        stateVersionId: "state_version_rehearsal",
        planDigest: testSha256Digest,
      };
    case "oidc-login":
      return {
        capsuleId: "cap_rehearsal",
        oidcClientId: "client_rehearsal",
        sessionId: "app_session_rehearsal",
      };
    case "event-hash-chain":
      return {
        capsuleId: "cap_rehearsal",
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
        tenantACapsuleId: "cap_tenant_a",
        tenantBCapsuleId: "cap_tenant_b",
        runtimeCellId: "cell_rehearsal",
        loadRunId: "two_tenant_load",
      };
    case "isolation-proof":
      return {
        loadRunId: "two_tenant_load",
        isolationCheckId: "isolation_proof",
        result: "passed",
      };
    case "per-capsule-metrics":
      return {
        runtimeCellId: "cell_rehearsal",
        tenantACapsuleId: "cap_tenant_a",
        tenantBCapsuleId: "cap_tenant_b",
        metricsDashboardRef: "dashboard://runtime/per-capsule",
      };
    case "scale-or-drain":
      return {
        runtimeCellId: "cell_rehearsal",
        eventId: "scale_or_drain_event",
        action: "drain",
      };
    case "readiness-before-cutover":
      return {
        capsuleId: "cap_rehearsal",
        probeRunId: "readiness_before_cutover",
        targetRuntimeTargetId: "rtb_dedicated",
      };
    case "materialize-cutover":
      return {
        capsuleId: "cap_rehearsal",
        materializeOperationId: "mat_rehearsal",
        targetRuntimeTargetId: "rtb_dedicated",
      };
    case "rollback-before-final":
      return {
        capsuleId: "cap_rehearsal",
        rollbackOperationId: "rollback_before_final",
        sourceRuntimeTargetId: "rtb_shared",
      };
    case "domain-preservation":
      return {
        capsuleId: "cap_rehearsal",
        domainName: "api.acme.example",
        oidcClientId: "client_rehearsal",
      };
    case "preserve-evidence":
      return {
        capsuleId: "cap_rehearsal",
        sourceCommit: "abcdef0123456789abcdef0123456789abcdef01",
        oidcClientId: "client_rehearsal",
        domainName: "api.acme.example",
        dataNamespace: "ns_rehearsal",
      };
    case "clean-import":
      return {
        importId: "import_rehearsal",
        targetHost: "selfhost.takosumi.local",
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
    migrationTranscriptRef: `run://accounts-migrations/${environment}/2026-05-13`,
    tlsEvidenceRef: `vault://topology/${environment}/tls`,
    artifactDigestEvidenceRef: `vault://topology/${environment}/artifact-digests`,
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
            containerRuntime: true,
            wranglerConfigRef: `artifact://topology/${environment}/accounts/wrangler.toml`,
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

test("launch-readiness validate accepts complete platform readiness evidence", async () => {
  const file = await makeTempFile({ suffix: ".json" });
  const document = await platformReadinessTemplateForTest();
  const rehearsalRun = completeRehearsalRun();
  document.rehearsalRun = rehearsalRun;
  document.domains = document.domains.map((entry) =>
    completePlatformReadinessEntry(entry),
  );
  document.rehearsal = document.rehearsal.map((entry) =>
    completePlatformReadinessEntry(entry, rehearsalRun.id),
  );
  await writeTextFile(file, JSON.stringify(document));

  try {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await main(
      ["launch-readiness", "validate", "--file", file, "--json"],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
    );

    expect(code).toEqual(0);
    expect(stderr).toEqual([]);
    const report = JSON.parse(stdout.join("\n"));
    expect(report.kind).toEqual("takosumi.platform-readiness-report@v1");
    expect(report.ready).toEqual(true);
    expect(report.evidenceDigest).toEqual(await testSha256HexDigest(document));
    expect(report.missingDomains).toEqual([]);
    expect(report.missingRehearsalSteps).toEqual([]);
    expect(report.gapDetails).toEqual([]);
  } finally {
    await removePath(file);
  }
});

test("launch-readiness validate accepts upload source digest identities", async () => {
  const file = await makeTempFile({ suffix: ".json" });
  const document = await platformReadinessTemplateForTest();
  const rehearsalRun = completeRehearsalRun();
  document.rehearsalRun = rehearsalRun;
  document.domains = document.domains.map((entry) =>
    completePlatformReadinessEntry(entry),
  );
  document.rehearsal = document.rehearsal.map((entry) =>
    completePlatformReadinessEntry(entry, rehearsalRun.id),
  );
  const sourceDigest =
    "c9913a5e25d1c58da061f59d72bb0903be1a25e8b42bfbefb244def32349cbc1";
  for (const entry of [...document.domains, ...document.rehearsal]) {
    for (const evidence of entry.evidence as Record<string, unknown>[]) {
      if (typeof evidence.sourceCommit === "string") {
        evidence.sourceCommit = sourceDigest;
      }
    }
  }
  await writeTextFile(file, JSON.stringify(document));

  try {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await main(
      ["launch-readiness", "validate", "--file", file, "--json"],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
    );

    expect(code).toEqual(0);
    expect(stderr).toEqual([]);
    const report = JSON.parse(stdout.join("\n"));
    expect(report.ready).toEqual(true);
  } finally {
    await removePath(file);
  }
});

test("launch-readiness validate accepts zero caps for quota guard drills", async () => {
  const file = await makeTempFile({ suffix: ".json" });
  const document = await platformReadinessTemplateForTest();
  const rehearsalRun = completeRehearsalRun();
  document.rehearsalRun = rehearsalRun;
  document.domains = document.domains.map((entry) =>
    completePlatformReadinessEntry(entry),
  );
  document.rehearsal = document.rehearsal.map((entry) =>
    completePlatformReadinessEntry(entry, rehearsalRun.id),
  );

  const quotaDomainEvidence = document.domains.find(
    (entry) => entry.id === "quota-abuse-spend-control",
  )!.evidence as Record<string, unknown>[];
  quotaDomainEvidence.find((entry) => entry.type === "quota-spike-drill")!.cap =
    0;
  const quotaRehearsalEvidence = document.rehearsal.find(
    (entry) => entry.id === "quota-abuse-drill",
  )!.evidence as Record<string, unknown>[];
  quotaRehearsalEvidence.find((entry) => entry.type === "quota-exceeded")!.cap =
    0;
  await writeTextFile(file, JSON.stringify(document));

  try {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await main(
      ["launch-readiness", "validate", "--file", file, "--json"],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
    );

    expect(code).toEqual(0);
    expect(stderr).toEqual([]);
    const report = JSON.parse(stdout.join("\n"));
    expect(report.ready).toEqual(true);
  } finally {
    await removePath(file);
  }
});

test("launch-readiness validate accepts rehearsal steps collected across multiple runs", async () => {
  const file = await makeTempFile({ suffix: ".json" });
  const document = await platformReadinessTemplateForTest();
  const rehearsalRun = completeRehearsalRun("rehearsal-2026-05-production");
  document.rehearsalRun = rehearsalRun;
  document.domains = document.domains.map((entry) =>
    completePlatformReadinessEntry(entry),
  );
  document.rehearsal = document.rehearsal.map((entry, index: number) =>
    completePlatformReadinessEntry(
      entry,
      `rehearsal-step-${String(index + 1).padStart(2, "0")}`,
    ),
  );
  await writeTextFile(file, JSON.stringify(document));

  try {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await main(
      ["launch-readiness", "validate", "--file", file, "--json"],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
    );

    expect(code).toEqual(0);
    expect(stderr).toEqual([]);
    const report = JSON.parse(stdout.join("\n"));
    expect(report.ready).toEqual(true);
    expect(report.missingRehearsalSteps).toEqual([]);
    expect(report.incompleteRehearsalSteps).toEqual([]);
  } finally {
    await removePath(file);
  }
});

test("launch-readiness validate allows independent operation drills outside user-journey order", async () => {
  const file = await makeTempFile({ suffix: ".json" });
  const document = await platformReadinessTemplateForTest();
  const rehearsalRun = completeRehearsalRun("rehearsal-2026-05-operations");
  document.rehearsalRun = rehearsalRun;
  document.domains = document.domains.map((entry) =>
    completePlatformReadinessEntry(entry),
  );
  document.rehearsal = document.rehearsal.map((entry, index: number) =>
    completePlatformReadinessEntry(entry, `operation-drill-${index}`),
  );
  const sharedCell = document.rehearsal.find(
    (entry) => entry.id === "shared-cell-load",
  )!;
  const backupRestore = document.rehearsal.find(
    (entry) => entry.id === "backup-restore",
  )!;
  sharedCell.completedAt = "2026-05-12T01:50:00Z";
  backupRestore.completedAt = "2026-05-12T01:20:00Z";
  await writeTextFile(file, JSON.stringify(document));

  try {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await main(
      ["launch-readiness", "validate", "--file", file, "--json"],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
    );

    expect(code).toEqual(0);
    expect(stderr).toEqual([]);
    const report = JSON.parse(stdout.join("\n"));
    expect(report.ready).toEqual(true);
    expect(report.errors).toEqual([]);
  } finally {
    await removePath(file);
  }
});

test("launch-readiness public-summary emits a public-safe ready summary", async () => {
  const file = await makeTempFile({ suffix: ".json" });
  const document = await platformReadinessTemplateForTest();
  const rehearsalRun = completeRehearsalRun("rehearsal-2026-05-13-staging");
  document.rehearsalRun = rehearsalRun;
  document.domains = document.domains.map((entry) =>
    completePlatformReadinessEntry(entry),
  );
  document.rehearsal = document.rehearsal.map((entry) =>
    completePlatformReadinessEntry(entry, rehearsalRun.id),
  );
  const evidenceDigest = await writePlatformReadinessForTest(file, document);

  try {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await main(
      [
        "launch-readiness",
        "public-summary",
        "--file",
        file,
        "--evidence-ref",
        "vault://platform-readiness/staging/rehearsal.json",
        "--public-summary",
        "P0 evidence and one staged launch rehearsal passed; operator approval remains separate.",
      ],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
    );

    expect(code).toEqual(0);
    expect(stderr).toEqual([]);
    const summary = JSON.parse(stdout.join("\n"));
    expect(summary.kind).toEqual(
      "takosumi.platform-readiness-public-summary@v1",
    );
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
  const document = await platformReadinessTemplateForTest();
  const rehearsalRun = completeRehearsalRun("rehearsal-2026-05-13-staging");
  document.rehearsalRun = rehearsalRun;
  document.domains = document.domains.map((entry) =>
    completePlatformReadinessEntry(entry),
  );
  document.rehearsal = document.rehearsal.map((entry) =>
    completePlatformReadinessEntry(entry, rehearsalRun.id),
  );
  const evidenceDigest = await writePlatformReadinessForTest(file, document);

  try {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await main(
      [
        "launch-readiness",
        "public-summary",
        "--file",
        file,
        "--evidence-ref",
        "vault://platform-readiness/staging/rehearsal.json",
        "--public-summary",
        "P0 evidence and one staged launch rehearsal passed; operator approval remains separate.",
        "--markdown-row",
      ],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
    );

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
  const document = await platformReadinessTemplateForTest();
  await writePlatformReadinessForTest(file, document);

  try {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await main(
      ["launch-readiness", "public-summary", "--file", file],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
    );

    expect(code).toEqual(0);
    expect(stderr).toEqual([]);
    const summary = JSON.parse(stdout.join("\n"));
    expect(summary.ready).toEqual(false);
    expect(summary.status).toEqual("blocked");
    expect(summary.privateEvidenceRefClass).toEqual(null);
    expect(
      summary.validator.incompleteDomains.includes("offering-definition"),
    ).toBeTruthy();
  } finally {
    await removePath(file);
  }
});

test("launch-readiness public-summary rejects ready summaries without private evidence ref", async () => {
  const file = await makeTempFile({ suffix: ".json" });
  const document = await platformReadinessTemplateForTest();
  const rehearsalRun = completeRehearsalRun();
  document.rehearsalRun = rehearsalRun;
  document.domains = document.domains.map((entry) =>
    completePlatformReadinessEntry(entry),
  );
  document.rehearsal = document.rehearsal.map((entry) =>
    completePlatformReadinessEntry(entry, rehearsalRun.id),
  );
  await writePlatformReadinessForTest(file, document);

  try {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await main(
      ["launch-readiness", "public-summary", "--file", file],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
    );

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
  const document = await platformReadinessTemplateForTest();
  const rehearsalRun = completeRehearsalRun();
  document.rehearsalRun = rehearsalRun;
  document.domains = document.domains.map((entry) =>
    completePlatformReadinessEntry(entry),
  );
  document.rehearsal = document.rehearsal.map((entry) =>
    completePlatformReadinessEntry(entry, rehearsalRun.id),
  );
  await writePlatformReadinessForTest(file, document);

  try {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await main(
      [
        "launch-readiness",
        "public-summary",
        "--file",
        file,
        "--evidence-ref",
        "vault://platform-readiness/staging/rehearsal.json",
        "--public-summary",
        "P0 evidence and one staged launch rehearsal passed for support@example.test arn:aws:iam::123456789012:role/internal acct_sensitive1 cs_live_sensitive1.",
      ],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
    );

    expect(code).toEqual(2);
    expect(stdout).toEqual([]);
    expect(
      stderr
        .join("\n")
        .includes("--platform-public-summary must not contain email addresses"),
    ).toBeTruthy();
    expect(
      stderr
        .join("\n")
        .includes(
          "--platform-public-summary must not contain provider account IDs",
        ),
    ).toBeTruthy();
    expect(
      stderr
        .join("\n")
        .includes(
          "--platform-public-summary must not contain internal resource IDs",
        ),
    ).toBeTruthy();
    expect(
      stderr
        .join("\n")
        .includes(
          "--platform-public-summary must not contain Stripe object IDs",
        ),
    ).toBeTruthy();
  } finally {
    await removePath(file);
  }
});

test("launch-readiness public-summary validate accepts generated summaries", async () => {
  const readinessFile = await makeTempFile({ suffix: ".json" });
  const summaryFile = await makeTempFile({ suffix: ".json" });
  const document = await platformReadinessTemplateForTest();
  const rehearsalRun = completeRehearsalRun("rehearsal-2026-05-13-staging");
  document.rehearsalRun = rehearsalRun;
  document.domains = document.domains.map((entry) =>
    completePlatformReadinessEntry(entry),
  );
  document.rehearsal = document.rehearsal.map((entry) =>
    completePlatformReadinessEntry(entry, rehearsalRun.id),
  );
  await writePlatformReadinessForTest(readinessFile, document);

  try {
    const summaryStdout: string[] = [];
    const summaryCode = await main(
      [
        "launch-readiness",
        "public-summary",
        "--file",
        readinessFile,
        "--evidence-ref",
        "vault://platform-readiness/staging/rehearsal.json",
        "--public-summary",
        "P0 evidence and one staged launch rehearsal passed; operator approval remains separate.",
      ],
      {
        stdout: (line) => summaryStdout.push(line),
        stderr: () => undefined,
      },
    );
    expect(summaryCode).toEqual(0);
    await writeTextFile(summaryFile, summaryStdout.join("\n"));

    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await main(
      [
        "launch-readiness",
        "public-summary",
        "validate",
        "--file",
        summaryFile,
        "--readiness-file",
        readinessFile,
        "--json",
      ],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
    );

    expect(code).toEqual(0);
    expect(stderr).toEqual([]);
    const report = JSON.parse(stdout.join("\n"));
    expect(report.kind).toEqual(
      "takosumi.platform-readiness-public-summary-report@v1",
    );
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
  const document = await platformReadinessTemplateForTest();
  await writePlatformReadinessForTest(readinessFile, document);

  try {
    const summaryStdout: string[] = [];
    const summaryCode = await main(
      ["launch-readiness", "public-summary", "--file", readinessFile],
      {
        stdout: (line) => summaryStdout.push(line),
        stderr: () => undefined,
      },
    );
    expect(summaryCode).toEqual(0);
    const summary = JSON.parse(summaryStdout.join("\n"));
    summary.privateEvidenceRefClass =
      "vault://platform-readiness/staging/rehearsal.json";
    await writeTextFile(summaryFile, JSON.stringify(summary));

    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await main(
      [
        "launch-readiness",
        "public-summary",
        "validate",
        "--file",
        summaryFile,
        "--readiness-file",
        readinessFile,
        "--json",
      ],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
    );

    expect(code).toEqual(1);
    expect(stderr).toEqual([]);
    const report = JSON.parse(stdout.join("\n"));
    expect(report.ready).toEqual(false);
    expect(
      report.errors.includes(
        "privateEvidenceRefClass must be null or a redacted scheme class",
      ),
    ).toBeTruthy();
  } finally {
    await removePath(readinessFile);
    await removePath(summaryFile);
  }
});

test("launch-readiness public-summary validate rejects drifted summaries", async () => {
  const readinessFile = await makeTempFile({ suffix: ".json" });
  const summaryFile = await makeTempFile({ suffix: ".json" });
  const document = await platformReadinessTemplateForTest();
  const rehearsalRun = completeRehearsalRun("rehearsal-2026-05-13-staging");
  document.rehearsalRun = rehearsalRun;
  document.domains = document.domains.map((entry) =>
    completePlatformReadinessEntry(entry),
  );
  document.rehearsal = document.rehearsal.map((entry) =>
    completePlatformReadinessEntry(entry, rehearsalRun.id),
  );
  await writePlatformReadinessForTest(readinessFile, document);

  try {
    const summaryStdout: string[] = [];
    const summaryCode = await main(
      [
        "launch-readiness",
        "public-summary",
        "--file",
        readinessFile,
        "--evidence-ref",
        "vault://platform-readiness/staging/rehearsal.json",
        "--public-summary",
        "P0 evidence and one staged launch rehearsal passed; operator approval remains separate.",
      ],
      {
        stdout: (line) => summaryStdout.push(line),
        stderr: () => undefined,
      },
    );
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
    const code = await main(
      [
        "launch-readiness",
        "public-summary",
        "validate",
        "--file",
        summaryFile,
        "--readiness-file",
        readinessFile,
        "--json",
      ],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
    );

    expect(code).toEqual(1);
    expect(stderr).toEqual([]);
    const report = JSON.parse(stdout.join("\n"));
    expect(report.valid).toEqual(false);
    expect(
      report.errors.includes(
        "validator.evidenceDigest must match readiness file digest",
      ),
    ).toBeTruthy();
    expect(
      report.errors.includes(
        "validator.incompleteDomains must match readiness validation result",
      ),
    ).toBeTruthy();
    expect(
      report.errors.includes(
        "validator.missingRehearsalSteps must match readiness validation result",
      ),
    ).toBeTruthy();
    expect(
      report.errors.includes("rehearsalRun must match readiness file"),
    ).toBeTruthy();
    expect(
      report.errors.includes(
        "--platform-public-summary must not contain Stripe object IDs",
      ),
    ).toBeTruthy();
  } finally {
    await removePath(readinessFile);
    await removePath(summaryFile);
  }
});

test("launch-readiness validate rejects self-approved rehearsal runs", async () => {
  const file = await makeTempFile({ suffix: ".json" });
  const document = await platformReadinessTemplateForTest();
  const rehearsalRun = {
    ...completeRehearsalRun(),
    owner: "Ops ",
    reviewer: "ops",
  };
  document.rehearsalRun = rehearsalRun;
  document.domains = document.domains.map((entry) =>
    completePlatformReadinessEntry(entry),
  );
  document.rehearsal = document.rehearsal.map((entry) =>
    completePlatformReadinessEntry(entry, rehearsalRun.id),
  );

  try {
    await writeTextFile(file, JSON.stringify(document));
    const stdout: string[] = [];
    const code = await main(
      ["launch-readiness", "validate", "--file", file, "--json"],
      {
        stdout: (line) => stdout.push(line),
        stderr: () => undefined,
      },
    );

    expect(code).toEqual(1);
    const report = JSON.parse(stdout.join("\n"));
    expect(report.ready).toEqual(false);
    expect(
      report.errors.includes("rehearsalRun.reviewer must differ from owner"),
    ).toBeTruthy();
  } finally {
    await removePath(file);
  }
});

test("launch-readiness validate rejects self-approved evidence entries", async () => {
  const file = await makeTempFile({ suffix: ".json" });
  const document = await platformReadinessTemplateForTest();
  const rehearsalRun = completeRehearsalRun();
  document.rehearsalRun = rehearsalRun;
  document.domains = document.domains.map((entry) =>
    completePlatformReadinessEntry(entry),
  );
  document.rehearsal = document.rehearsal.map((entry) =>
    completePlatformReadinessEntry(entry, rehearsalRun.id),
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
    const code = await main(
      ["launch-readiness", "validate", "--file", file, "--json"],
      {
        stdout: (line) => stdout.push(line),
        stderr: () => undefined,
      },
    );

    expect(code).toEqual(1);
    const report = JSON.parse(stdout.join("\n"));
    expect(report.ready).toEqual(false);
    expect(
      report.incompleteDomains.includes("offering-definition"),
    ).toBeTruthy();
    expect(
      report.incompleteRehearsalSteps.includes("fresh-signup"),
    ).toBeTruthy();
    expect(
      report.errors.includes(
        "domains.offering-definition.reviewer must differ from owner",
      ),
    ).toBeTruthy();
    expect(
      report.errors.includes(
        "rehearsal.fresh-signup.reviewer must differ from owner",
      ),
    ).toBeTruthy();
  } finally {
    await removePath(file);
  }
});

test("launch-readiness validate fails closed for incomplete evidence", async () => {
  const file = await makeTempFile({ suffix: ".json" });
  await writeTextFile(
    file,
    JSON.stringify({
      kind: "takosumi.platform-readiness@v1",
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
          evidence: [
            {
              type: "issue",
              ref: "issue://launch-brief",
              summary: "launch brief is not approved yet",
            },
          ],
        },
      ],
      rehearsal: [],
    }),
  );

  try {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await main(
      ["launch-readiness", "validate", "--file", file, "--json"],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
    );

    expect(code).toEqual(1);
    expect(stderr).toEqual([]);
    const report = JSON.parse(stdout.join("\n"));
    expect(report.ready).toEqual(false);
    expect(
      report.incompleteDomains.includes("offering-definition"),
    ).toBeTruthy();
    expect(report.missingDomains.includes("production-topology")).toBeTruthy();
    expect(report.missingRehearsalSteps.includes("fresh-signup")).toBeTruthy();
    expect(
      report.gapDetails.some(
        (gap: Record<string, unknown>) =>
          gap.scope === "domains" &&
          gap.id === "offering-definition" &&
          Array.isArray(gap.missingEvidenceTypes) &&
          gap.missingEvidenceTypes.includes("launch-brief") &&
          gap.missingEvidenceTypes.includes("operator-signoff"),
      ),
    ).toBeTruthy();
    expect(
      report.gapDetails.some(
        (gap: Record<string, unknown>) =>
          gap.scope === "domains" &&
          gap.id === "offering-definition" &&
          Array.isArray(gap.evidenceReferenceGaps) &&
          gap.evidenceReferenceGaps.some(
            (referenceGap: Record<string, unknown>) =>
              referenceGap.type === "launch-brief" &&
              referenceGap.status === "missing" &&
              Array.isArray(referenceGap.blockingFields) &&
              referenceGap.blockingFields.includes("evidence"),
          ),
      ),
    ).toBeTruthy();
    expect(
      report.gapDetails.some(
        (gap: Record<string, unknown>) =>
          gap.scope === "rehearsal" &&
          gap.id === "fresh-signup" &&
          gap.status === "missing",
      ),
    ).toBeTruthy();
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
  expect(template.kind).toEqual("takosumi.platform-readiness@v1");
  expect(template.rehearsalRun.id).toEqual("");
  expect(template.domains.length).toEqual(15);
  expect(template.rehearsal.length).toEqual(12);
  expect(
    template.domains.every(
      (entry: { status: string }) => entry.status === "blocked",
    ),
  ).toEqual(true);
  expect(
    template.domains.every(
      (entry: { environment: string; reviewer: string }) =>
        entry.environment === "" && entry.reviewer === "",
    ),
  ).toEqual(true);
  expect(
    template.rehearsal.some(
      (entry: { id: string }) => entry.id === "release-rollback",
    ),
  ).toEqual(true);
  expect(
    template.rehearsal.every((entry: { runId: string }) => entry.runId === ""),
  ).toEqual(true);
  const offeringDefinition = template.domains.find(
    (entry: { id: string }) => entry.id === "offering-definition",
  );
  expect(offeringDefinition).toBeTruthy();
  expect(
    offeringDefinition.evidence.map((entry: { type: string }) => entry.type),
  ).toEqual(offeringDefinition.requiredEvidenceTypes);
  expect(offeringDefinition.evidence[0].private).toEqual(true);
  expect(offeringDefinition.evidence[0].publicSummary).toEqual("");
  expect(offeringDefinition.evidence[0].briefRef).toEqual(
    "vault://platform-readiness/<briefRef>",
  );
  const billingOperation = template.rehearsal.find(
    (entry: { id: string }) => entry.id === "billing-operation",
  );
  expect(billingOperation).toBeTruthy();
  expect(
    billingOperation.evidence.map((entry: { type: string }) => entry.type),
  ).toEqual(billingOperation.requiredEvidenceTypes);
  expect(billingOperation.evidence[0].invoiceId).toEqual("<invoiceId>");
  expect(
    Object.fromEntries(
      template.domains.map(
        (entry: { id: string; requiredEvidenceTypes: string[] }) => [
          entry.id,
          entry.requiredEvidenceTypes,
        ],
      ),
    ),
  ).toEqual({
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
      "launch-token-consume",
      "capsule-created",
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
      "run-kill-switch",
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
  expect(
    Object.fromEntries(
      template.rehearsal.map(
        (entry: { id: string; requiredEvidenceTypes: string[] }) => [
          entry.id,
          entry.requiredEvidenceTypes,
        ],
      ),
    ),
  ).toEqual({
    "fresh-signup": [
      "signup-event",
      "email-assurance",
      "team-membership",
      "terms-acceptance",
      "entitlement-event",
    ],
    "capsule-launch": [
      "launch-token-consume",
      "capsule-created",
      "capsule-session",
    ],
    "git-url-install": [
      "capsule-plan-run",
      "cost-review",
      "capsule-apply",
      "oidc-login",
      "event-hash-chain",
    ],
    "quota-abuse-drill": ["quota-exceeded", "guard-action", "override-audit"],
    "shared-cell-load": [
      "two-tenant-load",
      "isolation-proof",
      "per-capsule-metrics",
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

test("launch-readiness oidc-account-security evidence merges verified JWKS evidence", async () => {
  const readinessFile = await makeTempFile({ suffix: ".json" });
  const jwksFile = await makeTempFile({ suffix: ".json" });
  const outFile = await makeTempFile({ suffix: ".json" });
  const document = await platformReadinessTemplateForTest();
  const rehearsalRun = completeRehearsalRun();
  document.rehearsalRun = rehearsalRun;
  document.domains = document.domains.map((entry) =>
    completePlatformReadinessEntry(entry),
  );
  document.rehearsal = document.rehearsal.map((entry) =>
    completePlatformReadinessEntry(entry, rehearsalRun.id),
  );
  const oidcSecurity = document.domains.find(
    (entry) => entry.id === "oidc-account-security",
  )!;
  oidcSecurity.status = "blocked";
  oidcSecurity.evidence = oidcSecurity.evidence.filter(
    (entry) =>
      !["key-rotation-drill", "client-secret-rotation", "audit-event"].includes(
        entry.type,
      ),
  );

  try {
    await writeTextFile(readinessFile, JSON.stringify(document));
    await writeTextFile(
      jwksFile,
      JSON.stringify({
        keys: [
          { kty: "EC", kid: "kid-before-2026", crv: "P-256" },
          { kty: "EC", kid: "kid-rotated-2026", crv: "P-256" },
        ],
      }),
    );
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await main(
      [
        "launch-readiness",
        "oidc-account-security",
        "evidence",
        "--file",
        readinessFile,
        "--out",
        outFile,
        "--issuer",
        "https://app.takosumi.com",
        "--jwks-file",
        jwksFile,
        "--key-id",
        "kid-rotated-2026",
        "--previous-key-id",
        "kid-before-2026",
        "--rotation-run-id",
        "oidc-rotation-2026-06-23",
        "--client-id",
        "google-client-rotation",
        "--old-secret-id",
        "google-secret-before-2026",
        "--new-secret-id",
        "google-secret-after-2026",
        "--overlap-window-seconds",
        "600",
        "--revocation-event-id",
        "google-secret-revocation-2026",
        "--audit-event-id",
        "audit-oidc-rotation-2026",
        "--audit-subject",
        "operator-release-owner",
        "--owner",
        "ops",
        "--reviewer",
        "release-owner",
        "--environment",
        "staging",
        "--completed-at",
        "2026-05-12T01:00:00Z",
        "--ref-prefix",
        "vault://platform-readiness/oidc-rotation-2026/domains/oidc-account-security",
        "--json",
      ],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
    );

    expect(code).toEqual(0);
    expect(stderr).toEqual([]);
    const result = JSON.parse(stdout.join("\n"));
    expect(result.oidcReady).toEqual(true);
    const updated = JSON.parse(await readFile(outFile, "utf8"));
    const updatedOidc = updated.domains.find(
      (entry: { id: string }) => entry.id === "oidc-account-security",
    );
    expect(updatedOidc.status).toEqual("passed");
    expect(
      updatedOidc.evidence.find(
        (entry: { type: string }) => entry.type === "key-rotation-drill",
      ).keyId,
    ).toEqual("kid-rotated-2026");
    const validateStdout: string[] = [];
    const validateCode = await main(
      ["launch-readiness", "validate", "--file", outFile, "--json"],
      {
        stdout: (line) => validateStdout.push(line),
        stderr: () => undefined,
      },
    );
    expect(validateCode).toEqual(0);
    expect(JSON.parse(validateStdout.join("\n")).ready).toEqual(true);
  } finally {
    await removePath(readinessFile);
    await removePath(jwksFile);
    await removePath(outFile);
  }
});

test("launch-readiness oidc-account-security evidence rejects missing JWKS kid", async () => {
  const readinessFile = await makeTempFile({ suffix: ".json" });
  const jwksFile = await makeTempFile({ suffix: ".json" });
  const document = await platformReadinessTemplateForTest();

  try {
    await writeTextFile(readinessFile, JSON.stringify(document));
    await writeTextFile(jwksFile, JSON.stringify({ keys: [{ kid: "other" }] }));
    const stderr: string[] = [];
    const code = await main(
      [
        "launch-readiness",
        "oidc-account-security",
        "evidence",
        "--file",
        readinessFile,
        "--issuer",
        "https://app.takosumi.com",
        "--jwks-file",
        jwksFile,
        "--key-id",
        "kid-rotated-2026",
        "--previous-key-id",
        "kid-before-2026",
        "--rotation-run-id",
        "oidc-rotation-2026-06-23",
        "--client-id",
        "google-client-rotation",
        "--old-secret-id",
        "google-secret-before-2026",
        "--new-secret-id",
        "google-secret-after-2026",
        "--overlap-window-seconds",
        "600",
        "--revocation-event-id",
        "google-secret-revocation-2026",
        "--audit-event-id",
        "audit-oidc-rotation-2026",
        "--audit-subject",
        "operator-release-owner",
        "--owner",
        "ops",
        "--reviewer",
        "release-owner",
        "--completed-at",
        "2026-05-12T01:00:00Z",
        "--ref-prefix",
        "vault://platform-readiness/oidc-rotation-2026/domains/oidc-account-security",
      ],
      {
        stdout: () => undefined,
        stderr: (line) => stderr.push(line),
      },
    );

    expect(code).toEqual(2);
    expect(stderr.join("\n")).toContain(
      "JWKS does not contain --key-id kid-rotated-2026",
    );
  } finally {
    await removePath(readinessFile);
    await removePath(jwksFile);
  }
});

test("launch-readiness migrate-final-model rewrites legacy evidence names without printing raw evidence", async () => {
  const file = await makeTempFile({ suffix: ".json" });
  const out = await makeTempFile({ suffix: ".json" });
  const legacyDocument = {
    kind: "takosumi.platform-readiness@v1",
    domains: [
      {
        id: "signup-tenant-lifecycle",
        requiredEvidenceTypes: ["launch-token-consume", "installation-created"],
        evidence: [
          {
            type: "launch-token-consume",
            installationId: "inst_private_rehearsal",
          },
          {
            type: "installation-created",
            installationId: "inst_private_rehearsal",
            spaceId: "space_private_rehearsal",
          },
          {
            type: "deploy-kill-switch",
            deploymentId: "dep_private_rehearsal",
          },
          {
            type: "sample-data-verification",
            dataClasses: "account,space,installation,run,output",
          },
          {
            type: "metric-labels",
            labelSet: "installation_id,tenant_id",
          },
        ],
      },
    ],
    rehearsal: [
      {
        id: "git-url-install",
        requiredEvidenceTypes: ["installation-plan-run", "install-apply"],
        evidence: [
          {
            type: "installation-plan-run",
            installationId: "inst_private_rehearsal",
          },
          {
            type: "install-apply",
            installationId: "inst_private_rehearsal",
            deploymentId: "dep_private_rehearsal",
            applyEventId: "apply_private_rehearsal",
          },
        ],
      },
      {
        id: "shared-cell-load",
        requiredEvidenceTypes: ["per-installation-metrics"],
        evidence: [
          {
            type: "per-installation-metrics",
            tenantAInstallationId: "inst_tenant_a_private",
            tenantBInstallationId: "inst_tenant_b_private",
          },
        ],
      },
    ],
  };
  await writeTextFile(file, JSON.stringify(legacyDocument));

  try {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await main(
      [
        "launch-readiness",
        "migrate-final-model",
        "--file",
        file,
        "--out",
        out,
        "--json",
      ],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
    );

    expect(code).toEqual(0);
    expect(stderr).toEqual([]);
    expect(stdout.join("\n")).not.toContain("inst_private_rehearsal");
    const report = JSON.parse(stdout.join("\n"));
    expect(report.changed).toEqual(true);
    expect(
      report.changes.some(
        (change: { from: string; to: string }) =>
          change.from === "installation-created" &&
          change.to === "capsule-created",
      ),
    ).toEqual(true);

    const migrated = JSON.parse(await readFile(out, "utf8"));
    const migratedText = JSON.stringify(migrated);
    expect(migratedText).not.toContain("installation-created");
    expect(migratedText).not.toContain('"installationId"');
    expect(migratedText).not.toContain('"spaceId"');
    expect(migratedText).not.toContain('"deploymentId"');
    expect(migratedText).not.toContain("per-installation-metrics");
    expect(migratedText).toContain("capsule-created");
    expect(migratedText).toContain("capsuleId");
    expect(migratedText).toContain("workspaceId");
    expect(migratedText).toContain("stateVersionId");
    expect(migratedText).toContain("per-capsule-metrics");
    expect(migratedText).toContain("account,workspace,capsule,run,output");
    expect(migratedText).toContain("capsule_id,tenant_id");
  } finally {
    await removePath(file);
    await removePath(out);
  }
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
    const code = await main(
      ["launch-readiness", "validate", "--file", file, "--json"],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
    );

    expect(code).toEqual(1);
    expect(stderr).toEqual([]);
    const report = JSON.parse(stdout.join("\n"));
    expect(report.ready).toEqual(false);
    expect(report.missingDomains).toEqual([]);
    expect(report.missingRehearsalSteps).toEqual([]);
    expect(
      report.incompleteDomains.includes("offering-definition"),
    ).toBeTruthy();
    expect(
      report.incompleteRehearsalSteps.includes("fresh-signup"),
    ).toBeTruthy();
    expect(
      report.gapDetails.some(
        (gap: Record<string, unknown>) =>
          gap.scope === "domains" &&
          gap.id === "offering-definition" &&
          Array.isArray(gap.evidenceReferenceGaps) &&
          gap.evidenceReferenceGaps.some(
            (referenceGap: Record<string, unknown>) =>
              referenceGap.type === "launch-brief" &&
              referenceGap.status === "incomplete" &&
              Array.isArray(referenceGap.blockingFields) &&
              referenceGap.blockingFields.includes("briefRef") &&
              referenceGap.blockingFields.includes("targetCustomer"),
          ),
      ),
    ).toBeTruthy();
  } finally {
    await removePath(file);
  }
});

test("launch-readiness validate rejects shallow evidence references", async () => {
  const file = await makeTempFile({ suffix: ".json" });
  await writeTextFile(
    file,
    JSON.stringify({
      kind: "takosumi.platform-readiness@v1",
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
    const code = await main(
      ["launch-readiness", "validate", "--file", file, "--json"],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
    );

    expect(code).toEqual(1);
    expect(stderr).toEqual([]);
    const report = JSON.parse(stdout.join("\n"));
    expect(report.ready).toEqual(false);
    expect(
      report.incompleteDomains.includes("offering-definition"),
    ).toBeTruthy();
  } finally {
    await removePath(file);
  }
});

test("launch-readiness validate requires public summaries for private evidence", async () => {
  const file = await makeTempFile({ suffix: ".json" });
  const document = await platformReadinessTemplateForTest();
  const rehearsalRun = completeRehearsalRun();
  document.rehearsalRun = rehearsalRun;
  document.domains = document.domains.map((entry) =>
    completePlatformReadinessEntry(entry),
  );
  document.rehearsal = document.rehearsal.map((entry) =>
    completePlatformReadinessEntry(entry, rehearsalRun.id),
  );
  const offeringDefinition = document.domains.find(
    (entry) => entry.id === "offering-definition",
  ) as Record<string, unknown>;
  const evidence = offeringDefinition.evidence as Record<string, unknown>[];
  evidence[0] = { ...evidence[0], private: true };
  delete evidence[0].publicSummary;
  await writeTextFile(file, JSON.stringify(document));

  try {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await main(
      ["launch-readiness", "validate", "--file", file, "--json"],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
    );

    expect(code).toEqual(1);
    expect(stderr).toEqual([]);
    const report = JSON.parse(stdout.join("\n"));
    expect(report.ready).toEqual(false);
    expect(
      report.incompleteDomains.includes("offering-definition"),
    ).toBeTruthy();
  } finally {
    await removePath(file);
  }
});

test("launch-readiness validate requires evidence to be marked private", async () => {
  const file = await makeTempFile({ suffix: ".json" });
  const document = await platformReadinessTemplateForTest();
  const rehearsalRun = completeRehearsalRun();
  document.rehearsalRun = rehearsalRun;
  document.domains = document.domains.map((entry) =>
    completePlatformReadinessEntry(entry),
  );
  document.rehearsal = document.rehearsal.map((entry) =>
    completePlatformReadinessEntry(entry, rehearsalRun.id),
  );
  const offeringDefinition = document.domains.find(
    (entry) => entry.id === "offering-definition",
  ) as Record<string, unknown>;
  const evidence = offeringDefinition.evidence as Record<string, unknown>[];
  evidence[0] = { ...evidence[0], private: false };
  await writeTextFile(file, JSON.stringify(document));

  try {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await main(
      ["launch-readiness", "validate", "--file", file, "--json"],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
    );

    expect(code).toEqual(1);
    expect(stderr).toEqual([]);
    const report = JSON.parse(stdout.join("\n"));
    expect(report.ready).toEqual(false);
    expect(
      report.incompleteDomains.includes("offering-definition"),
    ).toBeTruthy();
  } finally {
    await removePath(file);
  }
});

test("launch-readiness validate rejects placeholder public summaries for private evidence", async () => {
  const file = await makeTempFile({ suffix: ".json" });
  const document = await platformReadinessTemplateForTest();
  const rehearsalRun = completeRehearsalRun();
  document.rehearsalRun = rehearsalRun;
  document.domains = document.domains.map((entry) =>
    completePlatformReadinessEntry(entry),
  );
  document.rehearsal = document.rehearsal.map((entry) =>
    completePlatformReadinessEntry(entry, rehearsalRun.id),
  );
  const offeringDefinition = document.domains.find(
    (entry) => entry.id === "offering-definition",
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
    const code = await main(
      ["launch-readiness", "validate", "--file", file, "--json"],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
    );

    expect(code).toEqual(1);
    expect(stderr).toEqual([]);
    const report = JSON.parse(stdout.join("\n"));
    expect(report.ready).toEqual(false);
    expect(
      report.incompleteDomains.includes("offering-definition"),
    ).toBeTruthy();
  } finally {
    await removePath(file);
  }
});

test("launch-readiness validate accepts private evidence summaries without launch-scope boilerplate", async () => {
  const file = await makeTempFile({ suffix: ".json" });
  const document = await platformReadinessTemplateForTest();
  const rehearsalRun = completeRehearsalRun();
  document.rehearsalRun = rehearsalRun;
  document.domains = document.domains.map((entry) =>
    completePlatformReadinessEntry(entry),
  );
  document.rehearsal = document.rehearsal.map((entry) =>
    completePlatformReadinessEntry(entry, rehearsalRun.id),
  );
  const offeringDefinition = document.domains.find(
    (entry) => entry.id === "offering-definition",
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
    const code = await main(
      ["launch-readiness", "validate", "--file", file, "--json"],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
    );

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
  const document = await platformReadinessTemplateForTest();
  const rehearsalRun = completeRehearsalRun();
  document.rehearsalRun = rehearsalRun;
  document.domains = document.domains.map((entry) =>
    completePlatformReadinessEntry(entry),
  );
  document.rehearsal = document.rehearsal.map((entry) =>
    completePlatformReadinessEntry(entry, rehearsalRun.id),
  );
  const offeringDefinition = document.domains.find(
    (entry) => entry.id === "offering-definition",
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
    const code = await main(
      ["launch-readiness", "validate", "--file", file, "--json"],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
    );

    expect(code).toEqual(1);
    expect(stderr).toEqual([]);
    const report = JSON.parse(stdout.join("\n"));
    expect(report.ready).toEqual(false);
    expect(
      report.incompleteDomains.includes("offering-definition"),
    ).toBeTruthy();
  } finally {
    await removePath(file);
  }
});

test("launch-readiness validate requires billing launch policy evidence", async () => {
  const file = await makeTempFile({ suffix: ".json" });
  const document = await platformReadinessTemplateForTest();
  const rehearsalRun = completeRehearsalRun();
  document.rehearsalRun = rehearsalRun;
  document.domains = document.domains.map((entry) =>
    completePlatformReadinessEntry(entry),
  );
  document.rehearsal = document.rehearsal.map((entry) =>
    completePlatformReadinessEntry(entry, rehearsalRun.id),
  );
  const billing = document.domains.find(
    (entry) => entry.id === "billing-entitlement",
  ) as Record<string, unknown>;
  billing.evidence = (billing.evidence as Record<string, unknown>[]).filter(
    (entry) => entry.type !== "tax-policy",
  );
  await writeTextFile(file, JSON.stringify(document));

  try {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await main(
      ["launch-readiness", "validate", "--file", file, "--json"],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
    );

    expect(code).toEqual(1);
    expect(stderr).toEqual([]);
    const report = JSON.parse(stdout.join("\n"));
    expect(report.ready).toEqual(false);
    expect(
      report.incompleteDomains.includes("billing-entitlement"),
    ).toBeTruthy();
  } finally {
    await removePath(file);
  }
});

test("launch-readiness validate requires structured high-risk P0 evidence", async () => {
  const file = await makeTempFile({ suffix: ".json" });
  const document = await platformReadinessTemplateForTest();
  const rehearsalRun = completeRehearsalRun();
  document.rehearsalRun = rehearsalRun;
  document.domains = document.domains.map((entry) =>
    completePlatformReadinessEntry(entry),
  );
  document.rehearsal = document.rehearsal.map((entry) =>
    completePlatformReadinessEntry(entry, rehearsalRun.id),
  );

  const backup = document.domains.find((entry) => entry.id === "backup-dr")!;
  const release = document.domains.find(
    (entry) => entry.id === "release-provenance",
  )!;
  const security = document.domains.find(
    (entry) => entry.id === "security-operations",
  )!;
  (backup.evidence as Array<Record<string, unknown>>).find(
    (entry) => entry.type === "rpo-rto-sample",
  )!.rpoSeconds = "";
  delete (release.evidence as Array<Record<string, unknown>>).find(
    (entry) => entry.type === "image-digest",
  )!.imageDigest;
  delete (security.evidence as Array<Record<string, unknown>>).find(
    (entry) => entry.type === "security-contact",
  )!.contactTestId;

  try {
    await writeTextFile(file, JSON.stringify(document));
    const stdout: string[] = [];
    const code = await main(
      ["launch-readiness", "validate", "--file", file, "--json"],
      {
        stdout: (line) => stdout.push(line),
        stderr: () => undefined,
      },
    );

    expect(code).toEqual(1);
    const report = JSON.parse(stdout.join("\n"));
    expect(report.ready).toEqual(false);
    expect(report.incompleteDomains.includes("backup-dr")).toBeTruthy();
    expect(
      report.incompleteDomains.includes("release-provenance"),
    ).toBeTruthy();
    expect(
      report.incompleteDomains.includes("security-operations"),
    ).toBeTruthy();
  } finally {
    await removePath(file);
  }
});

test("launch-readiness validate requires structured staged rehearsal evidence", async () => {
  const file = await makeTempFile({ suffix: ".json" });
  const document = await platformReadinessTemplateForTest();
  const rehearsalRun = completeRehearsalRun();
  document.rehearsalRun = rehearsalRun;
  document.domains = document.domains.map((entry) =>
    completePlatformReadinessEntry(entry),
  );
  document.rehearsal = document.rehearsal.map((entry) =>
    completePlatformReadinessEntry(entry, rehearsalRun.id),
  );

  const freshSignup = document.rehearsal.find(
    (entry) => entry.id === "fresh-signup",
  )!;
  const oidcSecurity = document.domains.find(
    (entry) => entry.id === "oidc-account-security",
  )!;
  const gitInstall = document.rehearsal.find(
    (entry) => entry.id === "git-url-install",
  )!;
  const billingOperation = document.rehearsal.find(
    (entry) => entry.id === "billing-operation",
  )!;
  delete (freshSignup.evidence as Array<Record<string, unknown>>).find(
    (entry) => entry.type === "team-membership",
  )!.membershipEventId;
  delete (oidcSecurity.evidence as Array<Record<string, unknown>>).find(
    (entry) => entry.type === "client-secret-rotation",
  )!.revocationEventId;
  delete (gitInstall.evidence as Array<Record<string, unknown>>).find(
    (entry) => entry.type === "capsule-apply",
  )!.planDigest;
  delete (billingOperation.evidence as Array<Record<string, unknown>>).find(
    (entry) => entry.type === "recovery-refund-credit",
  )!.creditNoteId;

  try {
    await writeTextFile(file, JSON.stringify(document));
    const stdout: string[] = [];
    const code = await main(
      ["launch-readiness", "validate", "--file", file, "--json"],
      {
        stdout: (line) => stdout.push(line),
        stderr: () => undefined,
      },
    );

    expect(code).toEqual(1);
    const report = JSON.parse(stdout.join("\n"));
    expect(report.ready).toEqual(false);
    expect(
      report.incompleteDomains.includes("oidc-account-security"),
    ).toBeTruthy();
    expect(
      report.incompleteRehearsalSteps.includes("fresh-signup"),
    ).toBeTruthy();
    expect(
      report.incompleteRehearsalSteps.includes("git-url-install"),
    ).toBeTruthy();
    expect(
      report.incompleteRehearsalSteps.includes("billing-operation"),
    ).toBeTruthy();
  } finally {
    await removePath(file);
  }
});

test("launch-readiness validate rejects malformed structured evidence field shapes", async () => {
  const file = await makeTempFile({ suffix: ".json" });
  const document = await platformReadinessTemplateForTest();
  const rehearsalRun = completeRehearsalRun();
  document.rehearsalRun = rehearsalRun;
  document.domains = document.domains.map((entry) =>
    completePlatformReadinessEntry(entry),
  );
  document.rehearsal = document.rehearsal.map((entry) =>
    completePlatformReadinessEntry(entry, rehearsalRun.id),
  );

  const billingEvidence = document.domains.find(
    (entry) => entry.id === "billing-entitlement",
  )!.evidence as Record<string, unknown>[];
  billingEvidence.find(
    (entry) => entry.type === "usage-aggregation-policy",
  )!.windowEnd = "2026-04-01T00:00:00Z";
  const releaseEvidence = document.domains.find(
    (entry) => entry.id === "release-provenance",
  )!.evidence as Record<string, unknown>[];
  releaseEvidence.find((entry) => entry.type === "image-digest")!.imageDigest =
    "latest";
  const gitInstallEvidence = document.rehearsal.find(
    (entry) => entry.id === "git-url-install",
  )!.evidence as Record<string, unknown>[];
  gitInstallEvidence.find(
    (entry) => entry.type === "capsule-plan-run",
  )!.commitSha = "main";
  const freshSignupEvidence = document.rehearsal.find(
    (entry) => entry.id === "fresh-signup",
  )!.evidence as Record<string, unknown>[];
  freshSignupEvidence.find(
    (entry) => entry.type === "email-assurance",
  )!.verifiedAt = "not-a-date";
  const dedicatedEvidence = document.rehearsal.find(
    (entry) => entry.id === "dedicated-materialize",
  )!.evidence as Record<string, unknown>[];
  dedicatedEvidence.find(
    (entry) => entry.type === "preserve-evidence",
  )!.sourceCommit = "main";
  const sharedCellEvidence = document.domains.find(
    (entry) => entry.id === "shared-cell-production-runtime",
  )!.evidence as Record<string, unknown>[];
  sharedCellEvidence.find((entry) => entry.type === "load-test")!.tenantCount =
    1;
  const materializeEvidence = document.domains.find(
    (entry) => entry.id === "dedicated-materialize",
  )!.evidence as Record<string, unknown>[];
  materializeEvidence.find(
    (entry) => entry.type === "continuity-evidence",
  )!.sourceCommit = "main";
  const exportEvidence = document.domains.find(
    (entry) => entry.id === "export-self-host-sovereignty",
  )!.evidence as Record<string, unknown>[];
  exportEvidence.find(
    (entry) => entry.type === "sample-data-verification",
  )!.dataClasses = "chat,memory,file";
  await writeTextFile(file, JSON.stringify(document));

  try {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await main(
      ["launch-readiness", "validate", "--file", file, "--json"],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
    );

    expect(code).toEqual(1);
    expect(stderr).toEqual([]);
    const report = JSON.parse(stdout.join("\n"));
    expect(report.ready).toEqual(false);
    expect(
      report.incompleteDomains.includes("billing-entitlement"),
    ).toBeTruthy();
    expect(
      report.incompleteDomains.includes("dedicated-materialize"),
    ).toBeTruthy();
    expect(
      report.incompleteDomains.includes("export-self-host-sovereignty"),
    ).toBeTruthy();
    expect(
      report.incompleteDomains.includes("release-provenance"),
    ).toBeTruthy();
    expect(
      report.incompleteDomains.includes("shared-cell-production-runtime"),
    ).toBeTruthy();
    expect(
      report.incompleteRehearsalSteps.includes("fresh-signup"),
    ).toBeTruthy();
    expect(
      report.incompleteRehearsalSteps.includes("git-url-install"),
    ).toBeTruthy();
    expect(
      report.incompleteRehearsalSteps.includes("dedicated-materialize"),
    ).toBeTruthy();
  } finally {
    await removePath(file);
  }
});

test("launch-readiness validate rejects non-passing structured evidence values", async () => {
  const file = await makeTempFile({ suffix: ".json" });
  const document = await platformReadinessTemplateForTest();
  const rehearsalRun = completeRehearsalRun();
  document.rehearsalRun = rehearsalRun;
  document.domains = document.domains.map((entry) =>
    completePlatformReadinessEntry(entry),
  );
  document.rehearsal = document.rehearsal.map((entry) =>
    completePlatformReadinessEntry(entry, rehearsalRun.id),
  );

  const billingEvidence = document.domains.find(
    (entry) => entry.id === "billing-entitlement",
  )!.evidence as Record<string, unknown>[];
  billingEvidence.find((entry) => entry.type === "invoice")!.status = "draft";
  const releaseEvidence = document.domains.find(
    (entry) => entry.id === "release-provenance",
  )!.evidence as Record<string, unknown>[];
  releaseEvidence.find((entry) => entry.type === "ci-equivalent")!.conclusion =
    "neutral";
  const securityEvidence = document.domains.find(
    (entry) => entry.id === "security-operations",
  )!.evidence as Record<string, unknown>[];
  securityEvidence.find((entry) => entry.type === "sandbox-review")!.decision =
    "pending";
  const quotaEvidence = document.rehearsal.find(
    (entry) => entry.id === "quota-abuse-drill",
  )!.evidence as Record<string, unknown>[];
  quotaEvidence.find((entry) => entry.type === "guard-action")!.action =
    "allowed";
  await writeTextFile(file, JSON.stringify(document));

  try {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await main(
      ["launch-readiness", "validate", "--file", file, "--json"],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
    );

    expect(code).toEqual(1);
    expect(stderr).toEqual([]);
    const report = JSON.parse(stdout.join("\n"));
    expect(report.ready).toEqual(false);
    expect(
      report.incompleteDomains.includes("billing-entitlement"),
    ).toBeTruthy();
    expect(
      report.incompleteDomains.includes("release-provenance"),
    ).toBeTruthy();
    expect(
      report.incompleteDomains.includes("security-operations"),
    ).toBeTruthy();
    expect(
      report.incompleteRehearsalSteps.includes("quota-abuse-drill"),
    ).toBeTruthy();
  } finally {
    await removePath(file);
  }
});

test("launch-readiness validate rejects placeholder structured evidence refs", async () => {
  const file = await makeTempFile({ suffix: ".json" });
  const document = await platformReadinessTemplateForTest();
  const rehearsalRun = completeRehearsalRun();
  document.rehearsalRun = rehearsalRun;
  document.domains = document.domains.map((entry) =>
    completePlatformReadinessEntry(entry),
  );
  document.rehearsal = document.rehearsal.map((entry) =>
    completePlatformReadinessEntry(entry, rehearsalRun.id),
  );

  const productionTopology = document.domains.find(
    (entry) => entry.id === "production-topology",
  )!.evidence as Record<string, unknown>[];
  productionTopology.find(
    (entry) => entry.type === "staging-manifest",
  )!.manifestRef = "evidence://todo";
  const securityEvidence = document.domains.find(
    (entry) => entry.id === "security-operations",
  )!.evidence as Record<string, unknown>[];
  securityEvidence.find(
    (entry) => entry.type === "threat-model",
  )!.threatModelRef = "https://example.com/threat-model";
  const legalEvidence = document.domains.find(
    (entry) => entry.id === "legal-privacy-support",
  )!.evidence as Record<string, unknown>[];
  legalEvidence.find((entry) => entry.type === "public-legal-pages")!.termsUrl =
    "https://accounts.example.invalid/terms";
  await writeTextFile(file, JSON.stringify(document));

  try {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await main(
      ["launch-readiness", "validate", "--file", file, "--json"],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
    );

    expect(code).toEqual(1);
    expect(stderr).toEqual([]);
    const report = JSON.parse(stdout.join("\n"));
    expect(report.ready).toEqual(false);
    expect(
      report.incompleteDomains.includes("production-topology"),
    ).toBeTruthy();
    expect(
      report.incompleteDomains.includes("security-operations"),
    ).toBeTruthy();
    expect(
      report.incompleteDomains.includes("legal-privacy-support"),
    ).toBeTruthy();
  } finally {
    await removePath(file);
  }
});

test("launch-readiness validate rejects placeholder generic structured fields", async () => {
  const file = await makeTempFile({ suffix: ".json" });
  const document = await platformReadinessTemplateForTest();
  const rehearsalRun = completeRehearsalRun();
  document.rehearsalRun = rehearsalRun;
  document.domains = document.domains.map((entry) =>
    completePlatformReadinessEntry(entry),
  );
  document.rehearsal = document.rehearsal.map((entry) =>
    completePlatformReadinessEntry(entry, rehearsalRun.id),
  );

  const securityEvidence = document.domains.find(
    (entry) => entry.id === "oidc-account-security",
  )!.evidence as Record<string, unknown>[];
  securityEvidence.find((entry) => entry.type === "oidc-conformance")!.issuer =
    "https://accounts.example.test";
  const signupEvidence = document.rehearsal.find(
    (entry) => entry.id === "fresh-signup",
  )!.evidence as Record<string, unknown>[];
  signupEvidence.find((entry) => entry.type === "signup-event")!.accountId =
    "<accountId>";
  await writeTextFile(file, JSON.stringify(document));

  try {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await main(
      ["launch-readiness", "validate", "--file", file, "--json"],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
    );

    expect(code).toEqual(1);
    expect(stderr).toEqual([]);
    const report = JSON.parse(stdout.join("\n"));
    expect(report.ready).toEqual(false);
    expect(
      report.incompleteDomains.includes("oidc-account-security"),
    ).toBeTruthy();
    expect(
      report.incompleteRehearsalSteps.includes("fresh-signup"),
    ).toBeTruthy();
  } finally {
    await removePath(file);
  }
});

test("launch-readiness validate rejects placeholder evidence summaries", async () => {
  const file = await makeTempFile({ suffix: ".json" });
  const document = await platformReadinessTemplateForTest();
  const rehearsalRun = completeRehearsalRun();
  document.rehearsalRun = rehearsalRun;
  document.domains = document.domains.map((entry) =>
    completePlatformReadinessEntry(entry),
  );
  document.rehearsal = document.rehearsal.map((entry) =>
    completePlatformReadinessEntry(entry, rehearsalRun.id),
  );

  const offeringDefinition = document.domains.find(
    (entry) => entry.id === "offering-definition",
  )!.evidence as Record<string, unknown>[];
  offeringDefinition.find((entry) => entry.type === "launch-brief")!.summary =
    "todo";
  await writeTextFile(file, JSON.stringify(document));

  try {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await main(
      ["launch-readiness", "validate", "--file", file, "--json"],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
    );

    expect(code).toEqual(1);
    expect(stderr).toEqual([]);
    const report = JSON.parse(stdout.join("\n"));
    expect(report.ready).toEqual(false);
    expect(
      report.incompleteDomains.includes("offering-definition"),
    ).toBeTruthy();
  } finally {
    await removePath(file);
  }
});

test("launch-readiness validate rejects sensitive evidence summaries", async () => {
  const file = await makeTempFile({ suffix: ".json" });
  const document = await platformReadinessTemplateForTest();
  const rehearsalRun = completeRehearsalRun();
  document.rehearsalRun = rehearsalRun;
  document.domains = document.domains.map((entry) =>
    completePlatformReadinessEntry(entry),
  );
  document.rehearsal = document.rehearsal.map((entry) =>
    completePlatformReadinessEntry(entry, rehearsalRun.id),
  );

  const billingEvidence = document.domains.find(
    (entry) => entry.id === "billing-entitlement",
  )!.evidence as Record<string, unknown>[];
  billingEvidence.find((entry) => entry.type === "stripe-live")!.summary =
    "Live billing evidence used sk_live_sensitive12345 during rehearsal.";
  await writeTextFile(file, JSON.stringify(document));

  try {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await main(
      ["launch-readiness", "validate", "--file", file, "--json"],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
    );

    expect(code).toEqual(1);
    expect(stderr).toEqual([]);
    const report = JSON.parse(stdout.join("\n"));
    expect(report.ready).toEqual(false);
    expect(
      report.incompleteDomains.includes("billing-entitlement"),
    ).toBeTruthy();
  } finally {
    await removePath(file);
  }
});

test("launch-readiness validate rejects duplicated evidence types", async () => {
  const file = await makeTempFile({ suffix: ".json" });
  const document = await platformReadinessTemplateForTest();
  const rehearsalRun = completeRehearsalRun();
  document.rehearsalRun = rehearsalRun;
  document.domains = document.domains.map((entry) =>
    completePlatformReadinessEntry(entry),
  );
  document.rehearsal = document.rehearsal.map((entry) =>
    completePlatformReadinessEntry(entry, rehearsalRun.id),
  );

  const offeringDefinition = document.domains.find(
    (entry) => entry.id === "offering-definition",
  ) as Record<string, unknown>;
  const evidence = offeringDefinition.evidence as Record<string, unknown>[];
  evidence.push({ ...evidence[0] });
  await writeTextFile(file, JSON.stringify(document));

  try {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await main(
      ["launch-readiness", "validate", "--file", file, "--json"],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
    );

    expect(code).toEqual(1);
    expect(stderr).toEqual([]);
    const report = JSON.parse(stdout.join("\n"));
    expect(report.ready).toEqual(false);
    expect(
      report.errors.includes(
        "domains.offering-definition.evidence.launch-brief is duplicated",
      ),
    ).toBeTruthy();
  } finally {
    await removePath(file);
  }
});

test("launch-readiness validate rejects unexpected evidence types", async () => {
  const file = await makeTempFile({ suffix: ".json" });
  const document = await platformReadinessTemplateForTest();
  const rehearsalRun = completeRehearsalRun();
  document.rehearsalRun = rehearsalRun;
  document.domains = document.domains.map((entry) =>
    completePlatformReadinessEntry(entry),
  );
  document.rehearsal = document.rehearsal.map((entry) =>
    completePlatformReadinessEntry(entry, rehearsalRun.id),
  );

  const offeringDefinition = document.domains.find(
    (entry) => entry.id === "offering-definition",
  ) as Record<string, unknown>;
  const domainEvidence = offeringDefinition.evidence as Record<
    string,
    unknown
  >[];
  domainEvidence.push({
    type: "ad-hoc-note",
    ref: "runbook://platform-readiness/offering-definition/ad-hoc-note",
    summary: "An ad hoc note should not be accepted as launch evidence.",
  });
  const freshSignup = document.rehearsal.find(
    (entry) => entry.id === "fresh-signup",
  ) as Record<string, unknown>;
  const rehearsalEvidence = freshSignup.evidence as Record<string, unknown>[];
  rehearsalEvidence.push({
    type: "extra-signup-screenshot",
    ref: "artifact://platform-readiness/fresh-signup/screenshot",
    summary: "An extra screenshot is not part of the canonical evidence set.",
  });
  await writeTextFile(file, JSON.stringify(document));

  try {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await main(
      ["launch-readiness", "validate", "--file", file, "--json"],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
    );

    expect(code).toEqual(1);
    expect(stderr).toEqual([]);
    const report = JSON.parse(stdout.join("\n"));
    expect(report.ready).toEqual(false);
    expect(
      report.errors.includes(
        "domains.offering-definition.evidence.ad-hoc-note is not a required evidence type",
      ),
    ).toBeTruthy();
    expect(
      report.errors.includes(
        "rehearsal.fresh-signup.evidence.extra-signup-screenshot is not a required evidence type",
      ),
    ).toBeTruthy();
  } finally {
    await removePath(file);
  }
});

test("launch-readiness validate rejects inconsistent staged rehearsal references", async () => {
  const file = await makeTempFile({ suffix: ".json" });
  const document = await platformReadinessTemplateForTest();
  const rehearsalRun = completeRehearsalRun();
  document.rehearsalRun = rehearsalRun;
  document.domains = document.domains.map((entry) =>
    completePlatformReadinessEntry(entry),
  );
  document.rehearsal = document.rehearsal.map((entry) =>
    completePlatformReadinessEntry(entry, rehearsalRun.id),
  );

  const freshSignupEvidence = document.rehearsal.find(
    (entry) => entry.id === "fresh-signup",
  )!.evidence as Record<string, unknown>[];
  freshSignupEvidence.find(
    (entry) => entry.type === "terms-acceptance",
  )!.accountId = "acct_other";
  const gitInstallEvidence = document.rehearsal.find(
    (entry) => entry.id === "git-url-install",
  )!.evidence as Record<string, unknown>[];
  gitInstallEvidence.find((entry) => entry.type === "oidc-login")!.capsuleId =
    "cap_other";
  const billingEvidence = document.rehearsal.find(
    (entry) => entry.id === "billing-operation",
  )!.evidence as Record<string, unknown>[];
  billingEvidence.find(
    (entry) => entry.type === "dunning-suspension",
  )!.invoiceId = "in_other";
  const sharedCellEvidence = document.rehearsal.find(
    (entry) => entry.id === "shared-cell-load",
  )!.evidence as Record<string, unknown>[];
  sharedCellEvidence.find(
    (entry) => entry.type === "per-capsule-metrics",
  )!.runtimeCellId = "cell_other";
  const dedicatedEvidence = document.rehearsal.find(
    (entry) => entry.id === "dedicated-materialize",
  )!.evidence as Record<string, unknown>[];
  dedicatedEvidence.find(
    (entry) => entry.type === "domain-preservation",
  )!.domainName = "other.acme.example";
  const exportEvidence = document.rehearsal.find(
    (entry) => entry.id === "export-self-host-import",
  )!.evidence as Record<string, unknown>[];
  exportEvidence.find(
    (entry) => entry.type === "source-retention-state",
  )!.accountId = "acct_other";
  await writeTextFile(file, JSON.stringify(document));

  try {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await main(
      ["launch-readiness", "validate", "--file", file, "--json"],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
    );

    expect(code).toEqual(1);
    expect(stderr).toEqual([]);
    const report = JSON.parse(stdout.join("\n"));
    expect(report.ready).toEqual(false);
    expect(
      report.incompleteRehearsalSteps.includes("fresh-signup"),
    ).toBeTruthy();
    expect(
      report.incompleteRehearsalSteps.includes("git-url-install"),
    ).toBeTruthy();
    expect(
      report.incompleteRehearsalSteps.includes("shared-cell-load"),
    ).toBeTruthy();
    expect(
      report.incompleteRehearsalSteps.includes("dedicated-materialize"),
    ).toBeTruthy();
    expect(
      report.incompleteRehearsalSteps.includes("export-self-host-import"),
    ).toBeTruthy();
    expect(
      report.incompleteRehearsalSteps.includes("billing-operation"),
    ).toBeTruthy();
  } finally {
    await removePath(file);
  }
});

test("launch-readiness validate rejects generic IDs for structured billing evidence", async () => {
  const file = await makeTempFile({ suffix: ".json" });
  const document = await platformReadinessTemplateForTest();
  const rehearsalRun = completeRehearsalRun();
  document.rehearsalRun = rehearsalRun;
  document.domains = document.domains.map((entry) =>
    completePlatformReadinessEntry(entry),
  );
  document.rehearsal = document.rehearsal.map((entry) =>
    completePlatformReadinessEntry(entry, rehearsalRun.id),
  );
  const billing = document.domains.find(
    (entry) => entry.id === "billing-entitlement",
  ) as Record<string, unknown>;
  const evidence = billing.evidence as Record<string, unknown>[];
  const stripeLive = evidence.find((entry) => entry.type === "stripe-live");
  expect(stripeLive).toBeTruthy();
  stripeLive.checkoutSessionId = "checkout_live_rehearsal";
  stripeLive.webhookEventId = "webhook_live_rehearsal";
  const billingOperation = document.rehearsal.find(
    (entry) => entry.id === "billing-operation",
  ) as Record<string, unknown>;
  const operationEvidence = billingOperation.evidence as Record<
    string,
    unknown
  >[];
  operationEvidence.find((entry) => entry.type === "invoice-paid")!.invoiceId =
    "invoice_paid_rehearsal";
  operationEvidence.find(
    (entry) => entry.type === "recovery-refund-credit",
  )!.creditNoteId = "credit_note_recovery_rehearsal";
  await writeTextFile(file, JSON.stringify(document));

  try {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await main(
      ["launch-readiness", "validate", "--file", file, "--json"],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
    );

    expect(code).toEqual(1);
    expect(stderr).toEqual([]);
    const report = JSON.parse(stdout.join("\n"));
    expect(report.ready).toEqual(false);
    expect(
      report.incompleteDomains.includes("billing-entitlement"),
    ).toBeTruthy();
    expect(
      report.incompleteRehearsalSteps.includes("billing-operation"),
    ).toBeTruthy();
  } finally {
    await removePath(file);
  }
});

test("launch-readiness validate rejects mixed run evidence inside one rehearsal step", async () => {
  const file = await makeTempFile({ suffix: ".json" });
  const document = await platformReadinessTemplateForTest();
  document.rehearsalRun = completeRehearsalRun("rehearsal-a");
  document.domains = document.domains.map((entry) =>
    completePlatformReadinessEntry(entry),
  );
  document.rehearsal = document.rehearsal.map((entry, index: number) =>
    completePlatformReadinessEntry(
      entry,
      index === 0 ? "rehearsal-b" : "rehearsal-a",
    ),
  );
  const capsuleEvidence = document.rehearsal.find(
    (entry) => entry.id === "capsule-launch",
  )!.evidence as Record<string, unknown>[];
  capsuleEvidence[0].runId = "rehearsal-b";
  await writeTextFile(file, JSON.stringify(document));

  try {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await main(
      ["launch-readiness", "validate", "--file", file, "--json"],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
    );

    expect(code).toEqual(1);
    expect(stderr).toEqual([]);
    const report = JSON.parse(stdout.join("\n"));
    expect(report.ready).toEqual(false);
    expect(
      report.incompleteRehearsalSteps.includes("capsule-launch"),
    ).toBeTruthy();
    expect(report.incompleteRehearsalSteps.includes("fresh-signup")).toEqual(
      false,
    );
  } finally {
    await removePath(file);
  }
});

test("launch-readiness validate rejects rehearsal environment mismatch", async () => {
  const file = await makeTempFile({ suffix: ".json" });
  const document = await platformReadinessTemplateForTest();
  const rehearsalRun = completeRehearsalRun("rehearsal-a");
  document.rehearsalRun = rehearsalRun;
  document.domains = document.domains.map((entry) =>
    completePlatformReadinessEntry(entry),
  );
  document.rehearsal = document.rehearsal.map((entry) =>
    completePlatformReadinessEntry(entry, rehearsalRun.id),
  );
  document.rehearsal[0].environment = "production";
  await writeTextFile(file, JSON.stringify(document));

  try {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await main(
      ["launch-readiness", "validate", "--file", file, "--json"],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
    );

    expect(code).toEqual(1);
    expect(stderr).toEqual([]);
    const report = JSON.parse(stdout.join("\n"));
    expect(report.ready).toEqual(false);
    expect(
      report.incompleteRehearsalSteps.includes("fresh-signup"),
    ).toBeTruthy();
  } finally {
    await removePath(file);
  }
});

test("launch-readiness validate rejects future rehearsal evidence", async () => {
  const file = await makeTempFile({ suffix: ".json" });
  const document = await platformReadinessTemplateForTest();
  const rehearsalRun = completeRehearsalRun("rehearsal-a");
  document.rehearsalRun = rehearsalRun;
  document.domains = document.domains.map((entry) =>
    completePlatformReadinessEntry(entry),
  );
  document.rehearsal = document.rehearsal.map((entry) =>
    completePlatformReadinessEntry(entry, rehearsalRun.id),
  );
  document.rehearsal[0].completedAt = "2999-01-01T00:00:00Z";
  await writeTextFile(file, JSON.stringify(document));

  try {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await main(
      ["launch-readiness", "validate", "--file", file, "--json"],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
    );

    expect(code).toEqual(1);
    expect(stderr).toEqual([]);
    const report = JSON.parse(stdout.join("\n"));
    expect(report.ready).toEqual(false);
    expect(
      report.incompleteRehearsalSteps.includes("fresh-signup"),
    ).toBeTruthy();
  } finally {
    await removePath(file);
  }
});

test("launch-readiness validate rejects loose or non-UTC evidence timestamps", async () => {
  const file = await makeTempFile({ suffix: ".json" });
  const document = await platformReadinessTemplateForTest();
  const rehearsalRun = {
    ...completeRehearsalRun("rehearsal-a"),
    startedAt: "2026-05-12 00:00:00",
  };
  document.rehearsalRun = rehearsalRun;
  document.domains = document.domains.map((entry) =>
    completePlatformReadinessEntry(entry),
  );
  document.rehearsal = document.rehearsal.map((entry) =>
    completePlatformReadinessEntry(entry, rehearsalRun.id),
  );
  document.domains[0].completedAt = "2026-05-12T01:00:00+09:00";
  document.rehearsal[0].completedAt = "2026-05-12 01:00:00";
  const billingEvidence = document.domains.find(
    (entry) => entry.id === "billing-entitlement",
  )!.evidence as Record<string, unknown>[];
  billingEvidence.find(
    (entry) => entry.type === "usage-aggregation-policy",
  )!.windowStart = "2026-05-01";
  await writeTextFile(file, JSON.stringify(document));

  try {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await main(
      ["launch-readiness", "validate", "--file", file, "--json"],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
    );

    expect(code).toEqual(1);
    expect(stderr).toEqual([]);
    const report = JSON.parse(stdout.join("\n"));
    expect(report.ready).toEqual(false);
    expect(
      report.errors.includes("rehearsalRun.startedAt must be a valid date"),
    ).toBeTruthy();
    expect(
      report.incompleteDomains.includes("offering-definition"),
    ).toBeTruthy();
    expect(
      report.incompleteDomains.includes("billing-entitlement"),
    ).toBeTruthy();
    expect(
      report.incompleteRehearsalSteps.includes("fresh-signup"),
    ).toBeTruthy();
  } finally {
    await removePath(file);
  }
});

test("launch-readiness validate rejects invalid calendar timestamps", async () => {
  const file = await makeTempFile({ suffix: ".json" });
  const document = await platformReadinessTemplateForTest();
  const rehearsalRun = {
    ...completeRehearsalRun("rehearsal-a"),
    startedAt: "2026-02-29T00:00:00Z",
  };
  document.rehearsalRun = rehearsalRun;
  document.domains = document.domains.map((entry) =>
    completePlatformReadinessEntry(entry),
  );
  document.rehearsal = document.rehearsal.map((entry) =>
    completePlatformReadinessEntry(entry, rehearsalRun.id),
  );
  document.rehearsal[0].completedAt = "2026-02-31T01:00:00Z";
  const securityEvidence = document.domains.find(
    (entry) => entry.id === "security-operations",
  )!.evidence as Record<string, unknown>[];
  securityEvidence.find(
    (entry) => entry.type === "secret-inventory",
  )!.reviewedAt = "2026-02-31T00:00:00Z";
  await writeTextFile(file, JSON.stringify(document));

  try {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await main(
      ["launch-readiness", "validate", "--file", file, "--json"],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
    );

    expect(code).toEqual(1);
    expect(stderr).toEqual([]);
    const report = JSON.parse(stdout.join("\n"));
    expect(report.ready).toEqual(false);
    expect(
      report.errors.includes("rehearsalRun.startedAt must be a valid date"),
    ).toBeTruthy();
    expect(
      report.incompleteDomains.includes("security-operations"),
    ).toBeTruthy();
    expect(
      report.incompleteRehearsalSteps.includes("fresh-signup"),
    ).toBeTruthy();
  } finally {
    await removePath(file);
  }
});

test("launch-readiness validate rejects unsupported rehearsal environments", async () => {
  const file = await makeTempFile({ suffix: ".json" });
  const document = await platformReadinessTemplateForTest();
  document.rehearsalRun = {
    ...completeRehearsalRun("rehearsal-a"),
    environment: "dev",
  };
  document.domains = document.domains.map((entry) =>
    completePlatformReadinessEntry(entry),
  );
  document.rehearsal = document.rehearsal.map((entry) => ({
    ...completePlatformReadinessEntry(entry, "rehearsal-a"),
    environment: "dev",
  }));
  await writeTextFile(file, JSON.stringify(document));

  try {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await main(
      ["launch-readiness", "validate", "--file", file, "--json"],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
    );

    expect(code).toEqual(1);
    expect(stderr).toEqual([]);
    const report = JSON.parse(stdout.join("\n"));
    expect(report.ready).toEqual(false);
    expect(
      report.errors.includes(
        "rehearsalRun.environment must be staging or production",
      ),
    ).toBeTruthy();
    expect(
      report.errors.includes(
        "rehearsal.fresh-signup.environment must be staging or production",
      ),
    ).toBeTruthy();
  } finally {
    await removePath(file);
  }
});

test("launch-readiness validate rejects combined-environment rehearsal steps", async () => {
  const file = await makeTempFile({ suffix: ".json" });
  const document = await platformReadinessTemplateForTest();
  const rehearsalRun = completeRehearsalRun("rehearsal-a");
  document.rehearsalRun = rehearsalRun;
  document.domains = document.domains.map((entry) =>
    completePlatformReadinessEntry(entry),
  );
  document.rehearsal = document.rehearsal.map((entry) =>
    completePlatformReadinessEntry(entry, rehearsalRun.id),
  );
  document.rehearsal[0].environment = "staging+production";
  await writeTextFile(file, JSON.stringify(document));

  try {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await main(
      ["launch-readiness", "validate", "--file", file, "--json"],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
    );

    expect(code).toEqual(1);
    expect(stderr).toEqual([]);
    const report = JSON.parse(stdout.join("\n"));
    expect(report.ready).toEqual(false);
    expect(
      report.errors.includes(
        "rehearsal.fresh-signup.environment must be staging or production",
      ),
    ).toBeTruthy();
    expect(
      report.incompleteRehearsalSteps.includes("fresh-signup"),
    ).toBeTruthy();
  } finally {
    await removePath(file);
  }
});

test("launch-readiness validate rejects out-of-order staged rehearsal evidence", async () => {
  const file = await makeTempFile({ suffix: ".json" });
  const document = await platformReadinessTemplateForTest();
  const rehearsalRun = completeRehearsalRun("rehearsal-a");
  document.rehearsalRun = rehearsalRun;
  document.domains = document.domains.map((entry) =>
    completePlatformReadinessEntry(entry),
  );
  document.rehearsal = document.rehearsal.map((entry) =>
    completePlatformReadinessEntry(entry, rehearsalRun.id),
  );
  document.rehearsal[0].completedAt = "2026-05-12T01:00:00Z";
  document.rehearsal[1].completedAt = "2026-05-12T00:30:00Z";
  await writeTextFile(file, JSON.stringify(document));

  try {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await main(
      ["launch-readiness", "validate", "--file", file, "--json"],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
    );

    expect(code).toEqual(1);
    expect(stderr).toEqual([]);
    const report = JSON.parse(stdout.join("\n"));
    expect(report.ready).toEqual(false);
    expect(
      report.errors.includes(
        "rehearsal.capsule-launch.completedAt must be after rehearsal.fresh-signup.completedAt",
      ),
    ).toBeTruthy();
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
    const code = await main(
      [
        "launch-readiness",
        "production-topology",
        "preflight",
        "--file",
        file,
        "--json",
      ],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
    );

    expect(code).toEqual(0);
    expect(stderr).toEqual([]);
    const report = JSON.parse(stdout.join("\n"));
    expect(report.kind).toEqual(
      "takosumi.production-topology-preflight-report@v1",
    );
    expect(report.ready).toEqual(true);
    expect(report.missingRoles).toEqual([]);
    expect(report.evidenceEntry.id).toEqual("production-topology");
    expect(report.evidenceEntry.evidence[0].topologyEnvironment).toEqual(
      "staging",
    );
    expect(report.evidenceEntry.evidence[0].componentCount).toEqual(6);
    expect(report.evidenceEntry.evidence[1].ref).toEqual(
      "vault://topology/staging/artifact-digests",
    );
    expect(report.evidenceEntry.evidence[3].ref).toEqual(
      "vault://topology/staging/health-probes",
    );
    expect(report.evidenceEntry.evidence[5].rollbackRole).toEqual("accounts");
    expect(report.evidenceEntry.evidence[5].artifactDigest).toEqual(
      testSha256Digest,
    );
    expect(
      report.evidenceEntry.evidence.map(
        (entry: { type: string }) => entry.type,
      ),
    ).toEqual([
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
  const code = await main(
    [
      "launch-readiness",
      "production-topology",
      "template",
      "--environment",
      "production",
    ],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    },
  );

  expect(code).toEqual(0);
  expect(stderr).toEqual([]);
  const template = JSON.parse(stdout.join("\n"));
  expect(template.kind).toEqual("takosumi.production-topology@v1");
  expect(template.environment).toEqual("production");
  expect(template.artifactDigestEvidenceRef).toEqual(
    "vault://platform-readiness/<rehearsal-run-id>/production-topology/production/artifact-digests",
  );
  expect(template.healthProbeEvidenceRef).toEqual(
    "vault://platform-readiness/<rehearsal-run-id>/production-topology/production/health-probes",
  );
  expect(template.rollbackTarget.role).toEqual("accounts");
  expect(template.components.length).toEqual(6);
  expect(
    template.components.map((entry: { role: string }) => entry.role),
  ).toEqual([
    "accounts",
    "dashboard",
    "takosumi-deploy-control",
    "service",
    "object-storage",
    "dns-tls",
  ]);
  const accountsTemplate = template.components.find(
    (entry: { role: string }) => entry.role === "accounts",
  );
  expect(accountsTemplate.wranglerConfigValidation.kind).toEqual(
    "takosumi.cloudflare-rendered-config-validation@v1",
  );
  expect(accountsTemplate.wranglerConfigValidation.ok).toEqual(true);
  expect(accountsTemplate.wranglerConfigValidation.d1BindingPresent).toEqual(
    true,
  );
  expect(accountsTemplate.wranglerConfigValidation.r2BindingPresent).toEqual(
    true,
  );

  const file = await makeTempFile({ suffix: ".json" });
  await writeTextFile(file, JSON.stringify(template));
  try {
    const preflightStdout: string[] = [];
    const preflightCode = await main(
      [
        "launch-readiness",
        "production-topology",
        "preflight",
        "--file",
        file,
        "--json",
      ],
      {
        stdout: (line) => preflightStdout.push(line),
        stderr: () => undefined,
      },
    );
    expect(preflightCode).toEqual(1);
    const report = JSON.parse(preflightStdout.join("\n"));
    expect(report.ready).toEqual(false);
    expect(report.errors.includes("owner is required")).toBeTruthy();
    expect(
      report.errors.includes(
        "rollbackTarget.artifactDigest must be a sha256: digest",
      ),
    ).toBeTruthy();
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
    for (const [topologyFile, reportFile] of [
      [stagingTopologyFile, stagingReportFile],
      [productionTopologyFile, productionReportFile],
    ]) {
      const preflightStdout: string[] = [];
      const preflightCode = await main(
        [
          "launch-readiness",
          "production-topology",
          "preflight",
          "--file",
          topologyFile,
          "--json",
        ],
        {
          stdout: (line) => preflightStdout.push(line),
          stderr: () => undefined,
        },
      );
      expect(preflightCode).toEqual(0);
      await writeTextFile(reportFile, preflightStdout.join("\n"));
    }

    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await main(
      [
        "launch-readiness",
        "production-topology",
        "merge",
        "--staging-report",
        stagingReportFile,
        "--production-report",
        productionReportFile,
        "--json",
      ],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
    );

    expect(code).toEqual(0);
    expect(stderr).toEqual([]);
    const report = JSON.parse(stdout.join("\n"));
    expect(report.kind).toEqual("takosumi.production-topology-merge-report@v1");
    expect(report.ready).toEqual(true);
    expect(report.evidenceEntry.environment).toEqual("staging+production");
    expect(report.evidenceEntry.evidence.length).toEqual(12);
    expect(report.evidenceEntry.evidence[0].type).toEqual("staging-manifest");
    expect(report.evidenceEntry.evidence[6].type).toEqual(
      "production-manifest",
    );

    const document = await platformReadinessTemplateForTest();
    const rehearsalRun = completeRehearsalRun();
    document.rehearsalRun = rehearsalRun;
    document.domains = document.domains.map((entry) =>
      entry.id === "production-topology"
        ? report.evidenceEntry
        : completePlatformReadinessEntry(entry),
    );
    document.rehearsal = document.rehearsal.map((entry) =>
      completePlatformReadinessEntry(entry, rehearsalRun.id),
    );
    await writeTextFile(readinessFile, JSON.stringify(document));

    const validateStdout: string[] = [];
    const validateCode = await main(
      ["launch-readiness", "validate", "--file", readinessFile, "--json"],
      {
        stdout: (line) => validateStdout.push(line),
        stderr: () => undefined,
      },
    );
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
    const preflightCode = await main(
      [
        "launch-readiness",
        "production-topology",
        "preflight",
        "--file",
        stagingTopologyFile,
        "--json",
      ],
      {
        stdout: (line) => preflightStdout.push(line),
        stderr: () => undefined,
      },
    );
    expect(preflightCode).toEqual(0);
    await writeTextFile(stagingReportFile, preflightStdout.join("\n"));

    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await main(
      [
        "launch-readiness",
        "production-topology",
        "merge",
        "--staging-report",
        stagingReportFile,
        "--production-report",
        stagingReportFile,
        "--json",
      ],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
    );

    expect(code).toEqual(1);
    expect(stderr).toEqual([]);
    const report = JSON.parse(stdout.join("\n"));
    expect(report.ready).toEqual(false);
    expect(
      report.errors.includes(
        "production preflight report.environment must be production",
      ),
    ).toBeTruthy();
  } finally {
    await removePath(stagingTopologyFile);
    await removePath(stagingReportFile);
  }
});

test("launch-readiness validate rejects generic production topology evidence refs", async () => {
  const file = await makeTempFile({ suffix: ".json" });
  const document = await platformReadinessTemplateForTest();
  const rehearsalRun = completeRehearsalRun();
  document.rehearsalRun = rehearsalRun;
  document.domains = document.domains.map((entry) =>
    completePlatformReadinessEntry(entry),
  );
  document.rehearsal = document.rehearsal.map((entry) =>
    completePlatformReadinessEntry(entry, rehearsalRun.id),
  );
  const productionTopology = document.domains.find(
    (entry) => entry.id === "production-topology",
  )!;
  productionTopology.evidence = (
    productionTopology.requiredEvidenceTypes as string[]
  ).map((type) => ({
    type,
    ref: `runbook://platform-readiness/production-topology/${type}`,
    summary: `${type} was noted in a generic runbook`,
  }));
  await writeTextFile(file, JSON.stringify(document));

  try {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await main(
      ["launch-readiness", "validate", "--file", file, "--json"],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
    );

    expect(code).toEqual(1);
    expect(stderr).toEqual([]);
    const report = JSON.parse(stdout.join("\n"));
    expect(report.ready).toEqual(false);
    expect(
      report.incompleteDomains.includes("production-topology"),
    ).toBeTruthy();
  } finally {
    await removePath(file);
  }
});

test("launch-readiness validate rejects production topology with single-environment domain", async () => {
  const file = await makeTempFile({ suffix: ".json" });
  const document = await platformReadinessTemplateForTest();
  const rehearsalRun = completeRehearsalRun();
  document.rehearsalRun = rehearsalRun;
  document.domains = document.domains.map((entry) =>
    completePlatformReadinessEntry(entry),
  );
  document.rehearsal = document.rehearsal.map((entry) =>
    completePlatformReadinessEntry(entry, rehearsalRun.id),
  );
  const productionTopology = document.domains.find(
    (entry) => entry.id === "production-topology",
  )!;
  productionTopology.environment = "staging";
  await writeTextFile(file, JSON.stringify(document));

  try {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await main(
      ["launch-readiness", "validate", "--file", file, "--json"],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
    );

    expect(code).toEqual(1);
    expect(stderr).toEqual([]);
    const report = JSON.parse(stdout.join("\n"));
    expect(report.ready).toEqual(false);
    expect(
      report.errors.includes(
        "domains.production-topology.environment must be staging+production",
      ),
    ).toBeTruthy();
    expect(
      report.incompleteDomains.includes("production-topology"),
    ).toBeTruthy();
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
    const preflightCode = await main(
      [
        "launch-readiness",
        "production-topology",
        "preflight",
        "--file",
        topologyFile,
        "--json",
      ],
      {
        stdout: (line) => preflightStdout.push(line),
        stderr: () => undefined,
      },
    );
    expect(preflightCode).toEqual(0);
    const preflightReport = JSON.parse(preflightStdout.join("\n"));

    const document = await platformReadinessTemplateForTest();
    const rehearsalRun = completeRehearsalRun();
    document.rehearsalRun = rehearsalRun;
    document.domains = document.domains.map((entry) =>
      entry.id === "production-topology"
        ? preflightReport.evidenceEntry
        : completePlatformReadinessEntry(entry),
    );
    document.rehearsal = document.rehearsal.map((entry) =>
      completePlatformReadinessEntry(entry, rehearsalRun.id),
    );
    await writeTextFile(readinessFile, JSON.stringify(document));

    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await main(
      ["launch-readiness", "validate", "--file", readinessFile, "--json"],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
    );

    expect(code).toEqual(1);
    expect(stderr).toEqual([]);
    const report = JSON.parse(stdout.join("\n"));
    expect(report.ready).toEqual(false);
    expect(
      report.incompleteDomains.includes("production-topology"),
    ).toBeTruthy();
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
    const code = await main(
      [
        "launch-readiness",
        "production-topology",
        "preflight",
        "--file",
        file,
        "--json",
      ],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
    );

    expect(code).toEqual(1);
    expect(stderr).toEqual([]);
    const report = JSON.parse(stdout.join("\n"));
    expect(report.ready).toEqual(false);
    expect(
      report.errors.includes("completedAt must not be in the future"),
    ).toBeTruthy();
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
    const code = await main(
      [
        "launch-readiness",
        "production-topology",
        "preflight",
        "--file",
        file,
        "--json",
      ],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
    );

    expect(code).toEqual(1);
    expect(stderr).toEqual([]);
    const report = JSON.parse(stdout.join("\n"));
    expect(report.ready).toEqual(false);
    expect(
      report.errors.includes("completedAt must be a valid date"),
    ).toBeTruthy();
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
    const code = await main(
      [
        "launch-readiness",
        "production-topology",
        "preflight",
        "--file",
        file,
        "--json",
      ],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
    );

    expect(code).toEqual(1);
    expect(stderr).toEqual([]);
    const report = JSON.parse(stdout.join("\n"));
    expect(report.ready).toEqual(false);
    expect(
      report.errors.includes("completedAt must be a valid date"),
    ).toBeTruthy();
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
    const code = await main(
      [
        "launch-readiness",
        "production-topology",
        "preflight",
        "--file",
        file,
        "--json",
      ],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
    );

    expect(code).toEqual(1);
    expect(stderr).toEqual([]);
    const report = JSON.parse(stdout.join("\n"));
    expect(report.ready).toEqual(false);
    expect(
      report.errors.includes("reviewer must differ from owner"),
    ).toBeTruthy();
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
    const code = await main(
      [
        "launch-readiness",
        "production-topology",
        "preflight",
        "--file",
        file,
        "--json",
      ],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
    );

    expect(code).toEqual(1);
    expect(stderr).toEqual([]);
    const report = JSON.parse(stdout.join("\n"));
    expect(report.ready).toEqual(false);
    expect(
      report.errors.includes(
        "components[0].artifactDigest must be a sha256: digest",
      ),
    ).toBeTruthy();
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
    const code = await main(
      [
        "launch-readiness",
        "production-topology",
        "preflight",
        "--file",
        file,
        "--json",
      ],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
    );

    expect(code).toEqual(1);
    expect(stderr).toEqual([]);
    const report = JSON.parse(stdout.join("\n"));
    expect(report.ready).toEqual(false);
    expect(
      report.errors.includes("components[1].id duplicates components[0].id"),
    ).toBeTruthy();
    expect(
      report.errors.includes(
        "components[1].role duplicates components[0].role",
      ),
    ).toBeTruthy();
    expect(
      report.errors.includes(
        "rollbackTarget.role must be a deployable component role",
      ),
    ).toBeTruthy();
    expect(
      report.errors.includes("components[6] must be an object"),
    ).toBeTruthy();
  } finally {
    await removePath(file);
  }
});

test("launch-readiness production-topology preflight rejects placeholders and missing roles", async () => {
  const file = await makeTempFile({ suffix: ".json" });
  const topology = completeProductionTopologyForTest();
  topology.manifestRef = "evidence://todo";
  topology.components = (
    topology.components as Record<string, unknown>[]
  ).filter((component) => component.role !== "dns-tls");
  await writeTextFile(file, JSON.stringify(topology));
  try {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await main(
      [
        "launch-readiness",
        "production-topology",
        "preflight",
        "--file",
        file,
        "--json",
      ],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
    );

    expect(code).toEqual(1);
    expect(stderr).toEqual([]);
    const report = JSON.parse(stdout.join("\n"));
    expect(report.ready).toEqual(false);
    expect(report.missingRoles).toEqual(["dns-tls"]);
    expect(
      report.errors.includes("manifestRef must not be a placeholder"),
    ).toBeTruthy();
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
    const code = await main(
      [
        "launch-readiness",
        "production-topology",
        "preflight",
        "--file",
        file,
        "--json",
      ],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
    );

    expect(code).toEqual(1);
    expect(stderr).toEqual([]);
    const report = JSON.parse(stdout.join("\n"));
    expect(report.ready).toEqual(false);
    expect(
      report.errors.includes(
        "migrationTranscriptRef must not be a placeholder",
      ),
    ).toBeTruthy();
    expect(report.errors.includes("tlsEvidenceRef is required")).toBeTruthy();
    expect(
      report.errors.includes(
        "artifactDigestEvidenceRef must not be a placeholder",
      ),
    ).toBeTruthy();
    expect(
      report.errors.includes("healthProbeEvidenceRef is required"),
    ).toBeTruthy();
    expect(
      report.errors.includes(
        "rollbackTarget.artifactDigest must be a sha256: digest",
      ),
    ).toBeTruthy();
    expect(
      report.errors.includes("rollbackTarget.role is required"),
    ).toBeTruthy();
    expect(
      report.errors.includes("components[0].healthProbeRef is required"),
    ).toBeTruthy();
  } finally {
    await removePath(file);
  }
});

test("launch-readiness production-topology preflight requires Accounts Worker D1/R2 evidence", async () => {
  const file = await makeTempFile({ suffix: ".json" });
  const topology = completeProductionTopologyForTest("staging");
  const components = topology.components as Record<string, unknown>[];
  const accounts = components.find(
    (component) => component.role === "accounts",
  )!;
  accounts.runtime = "cloudflare-container";
  accounts.containerRuntime = false;
  accounts.bindings = ["KV:TAKOSUMI_ACCOUNTS_CACHE"];
  delete accounts.wranglerConfigRef;
  delete accounts.wranglerConfigValidation;
  await writeTextFile(file, JSON.stringify(topology));

  try {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await main(
      ["launch-readiness", "production-topology", "preflight", "--file", file],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
    );

    expect(code).toEqual(1);
    const output = [...stdout, ...stderr].join("\n");
    expect(
      output.includes("accounts component runtime must be cloudflare-worker"),
    ).toBeTruthy();
    expect(
      output.includes("accounts component containerRuntime must be true"),
    ).toBeTruthy();
    expect(
      output.includes("accounts component wranglerConfigRef is required"),
    ).toBeTruthy();
    expect(
      output.includes(
        "accounts component wranglerConfigValidation must be an object",
      ),
    ).toBeTruthy();
    expect(
      output.includes(
        "accounts component bindings must include D1:TAKOSUMI_ACCOUNTS_DB",
      ),
    ).toBeTruthy();
    expect(
      output.includes(
        "accounts component bindings must include R2:TAKOSUMI_ACCOUNTS_EXPORTS",
      ),
    ).toBeTruthy();
  } finally {
    await removePath(file);
  }
});

test("launch-readiness production-topology preflight rejects weak Accounts rendered config validation", async () => {
  const file = await makeTempFile({ suffix: ".json" });
  const topology = completeProductionTopologyForTest("staging");
  const components = topology.components as Record<string, unknown>[];
  const accounts = components.find(
    (component) => component.role === "accounts",
  )!;
  accounts.wranglerConfigValidation = {
    ...completeWranglerConfigValidationForTest(),
    ok: false,
    configDigest: "sha256:not-a-digest",
    bareOriginIssuerConfigured: false,
    d1DatabaseIdPlaceholder: true,
    controlD1BindingPresent: false,
    r2BindingPresent: false,
    containerConfigured: false,
    durableObjectPersistenceConfigured: false,
    runnerDurableObjectBindingPresent: false,
    runQueueConfigured: false,
  };
  await writeTextFile(file, JSON.stringify(topology));

  try {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await main(
      ["launch-readiness", "production-topology", "preflight", "--file", file],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
    );

    expect(code).toEqual(1);
    const output = [...stdout, ...stderr].join("\n");
    expect(
      output.includes(
        "accounts component wranglerConfigValidation.ok must be true",
      ),
    ).toBeTruthy();
    expect(
      output.includes(
        "accounts component wranglerConfigValidation.configDigest must be a sha256: digest",
      ),
    ).toBeTruthy();
    expect(
      output.includes(
        "accounts component wranglerConfigValidation.bareOriginIssuerConfigured must be true",
      ),
    ).toBeTruthy();
    expect(
      output.includes(
        "accounts component wranglerConfigValidation.d1DatabaseIdPlaceholder must be false",
      ),
    ).toBeTruthy();
    expect(
      output.includes(
        "accounts component wranglerConfigValidation.controlD1BindingPresent must be true",
      ),
    ).toBeTruthy();
    expect(
      output.includes(
        "accounts component wranglerConfigValidation.r2BindingPresent must be true",
      ),
    ).toBeTruthy();
    expect(
      output.includes(
        "accounts component wranglerConfigValidation.containerConfigured must be true",
      ),
    ).toBeTruthy();
    expect(
      output.includes(
        "accounts component wranglerConfigValidation.durableObjectPersistenceConfigured must be true",
      ),
    ).toBeTruthy();
    expect(
      output.includes(
        "accounts component wranglerConfigValidation.runnerDurableObjectBindingPresent must be true",
      ),
    ).toBeTruthy();
    expect(
      output.includes(
        "accounts component wranglerConfigValidation.runQueueConfigured must be true",
      ),
    ).toBeTruthy();
  } finally {
    await removePath(file);
  }
});

test("accounts serve dry-run prints server plan", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await main(
    [
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
    ],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    },
  );

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
  expect(plan.platformAccess).toEqual({
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
  expect(
    plan.serviceGraphMaterialResolver.paths.includes("takosumi.identity.oidc"),
  ).toEqual(true);
  expect(
    plan.serviceGraphMaterialResolver.paths.includes("takosumi.billing.usage"),
  ).toEqual(true);
  expect(plan.accountPlaneFacades).toEqual([
    "dashboard web/API",
    "Takosumi Accounts deploy facade",
  ]);
});

test("accounts serve dry-run reports explicit in-memory dev sessions", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await main(
    [
      "accounts",
      "serve",
      "--dry-run",
      "--issuer",
      "https://accounts.example.test",
      "--subject",
      "tsub_test",
      "--dev-session-id",
      "sess_dev_test",
    ],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    },
  );

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
  const code = await main(
    [
      "accounts",
      "serve",
      "--dry-run",
      "--issuer",
      "https://accounts.example.test",
      "--dev-session-id",
      "sess_dev_test",
      "--database-url",
      "postgres://accounts:secret@db.internal:5432/takosumi_accounts",
    ],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    },
  );

  expect(code).toEqual(2);
  expect(stdout).toEqual([]);
  expect(stderr).toEqual([
    "--dev-session-id is only supported with in-memory accounts serve",
  ]);
});

test("accounts serve dry-run requires readiness evidence before opening platform readiness access", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await main(
    ["accounts", "serve", "--dry-run", "--platform-access", "open"],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    },
  );

  expect(code).toEqual(2);
  expect(stdout).toEqual([]);
  expect(stderr).toEqual([
    "--platform-access open requires --platform-readiness-file",
  ]);
});

test("accounts serve dry-run rejects incomplete platform readiness evidence", async () => {
  const file = await makeTempFile({ suffix: ".json" });
  const document = {
    kind: "takosumi.platform-readiness@v1",
    domains: [],
    rehearsal: [],
  };
  const readinessDigest = await writePlatformReadinessForTest(file, document);
  try {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await main(
      [
        "accounts",
        "serve",
        "--dry-run",
        "--platform-access",
        "open",
        "--platform-readiness-file",
        file,
        "--platform-readiness-digest",
        readinessDigest,
        "--platform-evidence-ref",
        "vault://platform-readiness/staging/rehearsal.json",
        "--platform-approval-ref",
        "approval://platform-readiness/staging/operator-approval.json",
        "--platform-public-summary",
        "P0 evidence and one staged launch rehearsal passed.",
      ],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
    );

    expect(code).toEqual(2);
    expect(stdout).toEqual([]);
    expect(stderr.join("\n").includes("Missing P0 domains")).toBeTruthy();
  } finally {
    await removePath(file);
  }
});

test("accounts serve dry-run requires matching platform readiness digest", async () => {
  const file = await makeTempFile({ suffix: ".json" });
  const document = await platformReadinessTemplateForTest();
  document.rehearsalRun = completeRehearsalRun("rehearsal-2026-05-13-staging");
  document.domains = document.domains.map((entry) =>
    completePlatformReadinessEntry(entry),
  );
  document.rehearsal = document.rehearsal.map((entry) =>
    completePlatformReadinessEntry(entry, "rehearsal-2026-05-13-staging"),
  );
  await writePlatformReadinessForTest(file, document);

  try {
    const missingDigestStdout: string[] = [];
    const missingDigestStderr: string[] = [];
    const missingDigestCode = await main(
      [
        "accounts",
        "serve",
        "--dry-run",
        "--platform-access",
        "open",
        "--platform-readiness-file",
        file,
        "--platform-evidence-ref",
        "vault://platform-readiness/staging/rehearsal.json",
        "--platform-approval-ref",
        "approval://platform-readiness/staging/operator-approval.json",
        "--platform-public-summary",
        "P0 evidence and one staged launch rehearsal passed.",
      ],
      {
        stdout: (line) => missingDigestStdout.push(line),
        stderr: (line) => missingDigestStderr.push(line),
      },
    );

    expect(missingDigestCode).toEqual(2);
    expect(missingDigestStdout).toEqual([]);
    expect(missingDigestStderr).toEqual([
      "--platform-access open requires --platform-readiness-digest",
    ]);

    const mismatchStdout: string[] = [];
    const mismatchStderr: string[] = [];
    const mismatchCode = await main(
      [
        "accounts",
        "serve",
        "--dry-run",
        "--platform-access",
        "open",
        "--platform-readiness-file",
        file,
        "--platform-readiness-digest",
        testSha256Digest,
        "--platform-evidence-ref",
        "vault://platform-readiness/staging/rehearsal.json",
        "--platform-approval-ref",
        "approval://platform-readiness/staging/operator-approval.json",
        "--platform-public-summary",
        "P0 evidence and one staged launch rehearsal passed.",
      ],
      {
        stdout: (line) => mismatchStdout.push(line),
        stderr: (line) => mismatchStderr.push(line),
      },
    );

    expect(mismatchCode).toEqual(2);
    expect(mismatchStdout).toEqual([]);
    expect(mismatchStderr).toEqual([
      "--platform-readiness-digest must match the readiness file digest",
    ]);
  } finally {
    await removePath(file);
  }
});

test("accounts serve dry-run requires separate platform readiness approval", async () => {
  const file = await makeTempFile({ suffix: ".json" });
  const document = await platformReadinessTemplateForTest();
  document.rehearsalRun = completeRehearsalRun("rehearsal-2026-05-13-staging");
  document.domains = document.domains.map((entry) =>
    completePlatformReadinessEntry(entry),
  );
  document.rehearsal = document.rehearsal.map((entry) =>
    completePlatformReadinessEntry(entry, "rehearsal-2026-05-13-staging"),
  );
  const readinessDigest = await writePlatformReadinessForTest(file, document);

  try {
    const missingApprovalStdout: string[] = [];
    const missingApprovalStderr: string[] = [];
    const missingApprovalCode = await main(
      [
        "accounts",
        "serve",
        "--dry-run",
        "--platform-access",
        "open",
        "--platform-readiness-file",
        file,
        "--platform-readiness-digest",
        readinessDigest,
        "--platform-evidence-ref",
        "vault://platform-readiness/staging/rehearsal.json",
        "--platform-public-summary",
        "P0 evidence and one staged launch rehearsal passed.",
      ],
      {
        stdout: (line) => missingApprovalStdout.push(line),
        stderr: (line) => missingApprovalStderr.push(line),
      },
    );

    expect(missingApprovalCode).toEqual(2);
    expect(missingApprovalStdout).toEqual([]);
    expect(missingApprovalStderr).toEqual([
      "--platform-access open requires --platform-evidence-ref, --platform-public-summary, and --platform-approval-ref",
    ]);

    const placeholderApprovalStdout: string[] = [];
    const placeholderApprovalStderr: string[] = [];
    const placeholderApprovalCode = await main(
      [
        "accounts",
        "serve",
        "--dry-run",
        "--platform-access",
        "open",
        "--platform-readiness-file",
        file,
        "--platform-readiness-digest",
        readinessDigest,
        "--platform-evidence-ref",
        "vault://platform-readiness/staging/rehearsal.json",
        "--platform-approval-ref",
        "approval://todo",
        "--platform-public-summary",
        "P0 evidence and one staged launch rehearsal passed.",
      ],
      {
        stdout: (line) => placeholderApprovalStdout.push(line),
        stderr: (line) => placeholderApprovalStderr.push(line),
      },
    );

    expect(placeholderApprovalCode).toEqual(2);
    expect(placeholderApprovalStdout).toEqual([]);
    expect(placeholderApprovalStderr).toEqual([
      "--platform-approval-ref must not be a placeholder",
    ]);

    const sameApprovalStdout: string[] = [];
    const sameApprovalStderr: string[] = [];
    const sameApprovalCode = await main(
      [
        "accounts",
        "serve",
        "--dry-run",
        "--platform-access",
        "open",
        "--platform-readiness-file",
        file,
        "--platform-readiness-digest",
        readinessDigest,
        "--platform-evidence-ref",
        "vault://platform-readiness/staging/rehearsal.json",
        "--platform-approval-ref",
        "vault://platform-readiness/staging/rehearsal.json",
        "--platform-public-summary",
        "P0 evidence and one staged launch rehearsal passed.",
      ],
      {
        stdout: (line) => sameApprovalStdout.push(line),
        stderr: (line) => sameApprovalStderr.push(line),
      },
    );

    expect(sameApprovalCode).toEqual(2);
    expect(sameApprovalStdout).toEqual([]);
    expect(sameApprovalStderr).toEqual([
      "--platform-approval-ref must differ from --platform-evidence-ref",
    ]);
  } finally {
    await removePath(file);
  }
});

test("accounts serve dry-run rejects placeholder platform readiness access summaries", async () => {
  const file = await makeTempFile({ suffix: ".json" });
  const document = await platformReadinessTemplateForTest();
  document.rehearsalRun = completeRehearsalRun("rehearsal-2026-05-13-staging");
  document.domains = document.domains.map((entry) =>
    completePlatformReadinessEntry(entry),
  );
  document.rehearsal = document.rehearsal.map((entry) =>
    completePlatformReadinessEntry(entry, "rehearsal-2026-05-13-staging"),
  );
  const readinessDigest = await writePlatformReadinessForTest(file, document);

  try {
    const placeholderRefStdout: string[] = [];
    const placeholderRefStderr: string[] = [];
    const placeholderRefCode = await main(
      [
        "accounts",
        "serve",
        "--dry-run",
        "--platform-access",
        "open",
        "--platform-readiness-file",
        file,
        "--platform-readiness-digest",
        readinessDigest,
        "--platform-evidence-ref",
        "evidence://todo",
        "--platform-approval-ref",
        "approval://platform-readiness/staging/operator-approval.json",
        "--platform-public-summary",
        "P0 evidence and one staged launch rehearsal passed.",
      ],
      {
        stdout: (line) => placeholderRefStdout.push(line),
        stderr: (line) => placeholderRefStderr.push(line),
      },
    );

    expect(placeholderRefCode).toEqual(2);
    expect(placeholderRefStdout).toEqual([]);
    expect(placeholderRefStderr).toEqual([
      "--platform-evidence-ref must not be a placeholder",
    ]);

    const shallowSummaryStdout: string[] = [];
    const shallowSummaryStderr: string[] = [];
    const shallowSummaryCode = await main(
      [
        "accounts",
        "serve",
        "--dry-run",
        "--platform-access",
        "open",
        "--platform-readiness-file",
        file,
        "--platform-readiness-digest",
        readinessDigest,
        "--platform-evidence-ref",
        "vault://platform-readiness/staging/rehearsal.json",
        "--platform-approval-ref",
        "approval://platform-readiness/staging/operator-approval.json",
        "--platform-public-summary",
        "todo",
      ],
      {
        stdout: (line) => shallowSummaryStdout.push(line),
        stderr: (line) => shallowSummaryStderr.push(line),
      },
    );

    expect(shallowSummaryCode).toEqual(2);
    expect(shallowSummaryStdout).toEqual([]);
    const shallowSummaryError = shallowSummaryStderr.join("\n");
    expect(
      shallowSummaryError.includes(
        "--platform-public-summary must be at least 40 characters",
      ),
    ).toBeTruthy();
    expect(
      shallowSummaryError.includes(
        "--platform-public-summary must not be a placeholder",
      ),
    ).toBeTruthy();

    const genericSummaryStdout: string[] = [];
    const genericSummaryStderr: string[] = [];
    const genericSummaryCode = await main(
      [
        "accounts",
        "serve",
        "--dry-run",
        "--platform-access",
        "open",
        "--platform-readiness-file",
        file,
        "--platform-readiness-digest",
        readinessDigest,
        "--platform-evidence-ref",
        "vault://platform-readiness/staging/rehearsal.json",
        "--platform-approval-ref",
        "approval://platform-readiness/staging/operator-approval.json",
        "--platform-public-summary",
        "Launch readiness was reviewed and approved by the operator team.",
      ],
      {
        stdout: (line) => genericSummaryStdout.push(line),
        stderr: (line) => genericSummaryStderr.push(line),
      },
    );

    expect(genericSummaryCode).toEqual(2);
    expect(genericSummaryStdout).toEqual([]);
    const genericSummaryError = genericSummaryStderr.join("\n");
    expect(
      genericSummaryError.includes(
        "--platform-public-summary must mention P0 evidence",
      ),
    ).toBeTruthy();
    expect(
      genericSummaryError.includes(
        "--platform-public-summary must mention the staged launch rehearsal",
      ),
    ).toBeTruthy();

    const sensitiveSummaryStdout: string[] = [];
    const sensitiveSummaryStderr: string[] = [];
    const sensitiveSummaryCode = await main(
      [
        "accounts",
        "serve",
        "--dry-run",
        "--platform-access",
        "open",
        "--platform-readiness-file",
        file,
        "--platform-readiness-digest",
        readinessDigest,
        "--platform-evidence-ref",
        "vault://platform-readiness/staging/rehearsal.json",
        "--platform-approval-ref",
        "approval://platform-readiness/staging/operator-approval.json",
        "--platform-public-summary",
        "P0 evidence and one staged launch rehearsal passed for cus_sensitive1.",
      ],
      {
        stdout: (line) => sensitiveSummaryStdout.push(line),
        stderr: (line) => sensitiveSummaryStderr.push(line),
      },
    );

    expect(sensitiveSummaryCode).toEqual(2);
    expect(sensitiveSummaryStdout).toEqual([]);
    expect(
      sensitiveSummaryStderr
        .join("\n")
        .includes(
          "--platform-public-summary must not contain Stripe object IDs",
        ),
    ).toBeTruthy();
  } finally {
    await removePath(file);
  }
});

test("accounts serve dry-run records open platform readiness access after readiness evidence passes", async () => {
  const file = await makeTempFile({ suffix: ".json" });
  const document = await platformReadinessTemplateForTest();
  document.rehearsalRun = completeRehearsalRun("rehearsal-2026-05-13-staging");
  document.domains = document.domains.map((entry) =>
    completePlatformReadinessEntry(entry),
  );
  document.rehearsal = document.rehearsal.map((entry) =>
    completePlatformReadinessEntry(entry, "rehearsal-2026-05-13-staging"),
  );
  const readinessDigest = await writePlatformReadinessForTest(file, document);

  try {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await main(
      [
        "accounts",
        "serve",
        "--dry-run",
        "--platform-access",
        "open",
        "--platform-readiness-file",
        file,
        "--platform-readiness-digest",
        readinessDigest,
        "--platform-evidence-ref",
        "vault://platform-readiness/staging/rehearsal.json",
        "--platform-approval-ref",
        "approval://platform-readiness/staging/operator-approval.json",
        "--platform-public-summary",
        "P0 evidence and one staged launch rehearsal passed.",
      ],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
    );

    expect(code).toEqual(0);
    expect(stderr).toEqual([]);
    const plan = JSON.parse(stdout.join("\n"));
    expect(plan.platformAccess).toEqual({
      status: "open",
      source: "--platform-access",
      readinessFile: file,
      readinessDigest,
      evidenceRef: "vault://platform-readiness/staging/rehearsal.json",
      approvalRef:
        "approval://platform-readiness/staging/operator-approval.json",
      publicSummary: "P0 evidence and one staged launch rehearsal passed.",
    });
  } finally {
    await removePath(file);
  }
});

test("accounts serve dry-run prints shared-cell warm pool slots", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await main(
    [
      "accounts",
      "serve",
      "--dry-run",
      "--shared-cell-slots",
      "tokyo-cell-01:2,tokyo-cell-02:1",
    ],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    },
  );

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
  const code = await main(
    [
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
    ],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    },
  );

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
    envSet("TAKOSUMI_ACCOUNTS_SHARED_CELL_SLOTS", "tokyo-cell-01:1");
    const code = await main(["accounts", "serve", "--dry-run"], {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    });

    expect(code).toEqual(0);
    expect(stderr).toEqual([]);
    const plan = JSON.parse(stdout.join("\n"));
    expect(plan.sharedCellRuntime).toEqual({
      configured: true,
      source: "TAKOSUMI_ACCOUNTS_SHARED_CELL_SLOTS",
      slots: [{ cellId: "tokyo-cell-01", capacity: 1 }],
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
  const code = await main(
    [
      "accounts",
      "serve",
      "--dry-run",
      "--materialize-worker-url",
      "https://workers.example.test/materialize",
      "--materialize-worker-token",
      "secret-worker-token",
    ],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    },
  );

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

test("accounts serve dry-run prints service graph material resolver config", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await main(
    [
      "accounts",
      "serve",
      "--dry-run",
      "--service-graph-material-resolver-token",
      "resolver-token",
      "--billing-portal-url",
      "https://cloud.example.test/account/billing",
    ],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    },
  );

  expect(code).toEqual(0);
  expect(stderr).toEqual([]);
  const plan = JSON.parse(stdout.join("\n"));
  expect(plan.serviceGraphMaterialResolver.resolver).toEqual({
    configured: true,
    source: "--service-graph-material-resolver-token",
    tokenConfigured: true,
    billingPortalUrl: "https://cloud.example.test/account/billing",
  });
});

test("accounts serve dry-run prints metadata export worker config", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await main(
    [
      "accounts",
      "serve",
      "--dry-run",
      "--export-output-dir",
      "/var/lib/takosumi/exports",
      "--export-download-base-url",
      "https://downloads.example.test/accounts/exports",
      "--export-download-ttl-ms",
      "60000",
    ],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    },
  );

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

test("accounts serve dry-run prints static data export config", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await main(
    [
      "accounts",
      "serve",
      "--dry-run",
      "--export-output-dir",
      "/var/lib/takosumi/exports",
      "--export-download-base-url",
      "https://downloads.example.test/accounts/exports",
      "--export-data-dir",
      "/var/lib/takosumi/export-data",
    ],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    },
  );

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
});

test("accounts serve rejects partial materialize worker config", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await main(
    [
      "accounts",
      "serve",
      "--dry-run",
      "--materialize-worker-token",
      "secret-worker-token",
    ],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    },
  );

  expect(code).toEqual(2);
  expect(stdout).toEqual([]);
  expect(stderr).toEqual([
    "Materialize worker requires --materialize-worker-url or TAKOSUMI_ACCOUNTS_MATERIALIZE_WORKER_URL",
  ]);
});

test("accounts serve rejects billing portal without service graph material resolver token", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await main(
    [
      "accounts",
      "serve",
      "--dry-run",
      "--billing-portal-url",
      "https://cloud.example.test/account/billing",
    ],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    },
  );

  expect(code).toEqual(2);
  expect(stdout).toEqual([]);
  expect(stderr).toEqual([
    "--billing-portal-url requires --service-graph-material-resolver-token or TAKOSUMI_ACCOUNTS_SERVICE_GRAPH_MATERIAL_RESOLVER_TOKEN",
  ]);
});

test("accounts serve rejects partial metadata export worker config", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await main(
    [
      "accounts",
      "serve",
      "--dry-run",
      "--export-output-dir",
      "/var/lib/takosumi/exports",
    ],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    },
  );

  expect(code).toEqual(2);
  expect(stdout).toEqual([]);
  expect(stderr).toEqual([
    "Metadata export worker requires --export-output-dir and --export-download-base-url",
  ]);
});

test("accounts serve rejects non-HTTPS export download base outside loopback", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await main(
    [
      "accounts",
      "serve",
      "--dry-run",
      "--export-output-dir",
      "/var/lib/takosumi/exports",
      "--export-download-base-url",
      "http://downloads.example.test/accounts/exports",
    ],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    },
  );

  expect(code).toEqual(2);
  expect(stdout).toEqual([]);
  expect(stderr).toEqual([
    "--export-download-base-url must be https:// or loopback http://",
  ]);
});

test("accounts serve dry-run redacts Stripe billing secrets", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await main(
    [
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
    ],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    },
  );

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
  const code = await main(
    [
      "accounts",
      "serve",
      "--dry-run",
      "--database-url",
      "postgres://accounts:secret@db.internal:5432/takosumi_accounts",
    ],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    },
  );

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
  const code = await main(
    [
      "accounts",
      "serve",
      "--dry-run",
      "--subject-secret",
      "subject-secret",
      "--google-client-id",
      "google-client",
      "--google-client-secret",
      "google-secret",
      "--google-redirect-uri",
      "https://accounts.example.test/v1/auth/upstream/callback",
      "--upstream-session-ttl-ms",
      "60000",
    ],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    },
  );

  expect(code).toEqual(0);
  expect(stderr).toEqual([]);
  const plan = JSON.parse(stdout.join("\n"));
  expect(plan.upstreamOAuth).toEqual({
    configured: true,
    providers: ["google"],
    sessionTtlMs: 60000,
  });
  expect(stdout.join("\n").includes("subject-secret")).toEqual(false);
  expect(stdout.join("\n").includes("google-secret")).toEqual(false);
});

test("accounts serve dry-run treats subject secret without providers as disabled upstream OAuth", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await main(
    ["accounts", "serve", "--dry-run", "--subject-secret", "subject-secret"],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    },
  );

  expect(code).toEqual(0);
  expect(stderr).toEqual([]);
  const plan = JSON.parse(stdout.join("\n"));
  expect(plan.upstreamOAuth).toEqual({
    configured: false,
  });
  expect(stdout.join("\n").includes("subject-secret")).toEqual(false);
});

test("accounts serve dry-run accepts custom upstream OIDC provider", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await main(
    [
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
    ],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    },
  );

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
  const code = await main(
    [
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
    ],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    },
  );

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
  const code = await main(
    [
      "accounts",
      "serve",
      "--dry-run",
      "--deploy-control-url",
      "http://takosumi.internal:8788",
      "--deploy-control-token",
      "deploy-control-secret",
    ],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    },
  );

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

test("accounts serve dry-run redacts static service binding materials", async () => {
  const root = await makeTempDir({ prefix: "takosumi-service-bindings-" });
  const materialsPath = `${root}/service-bindings.json`;
  const stdout: string[] = [];
  const stderr: string[] = [];
  try {
    await writeTextFile(
      materialsPath,
      JSON.stringify({
        db: {
          kind: "storage.sql",
          configRef: "takosumi-accounts://installations/template/db",
          secretRefs: ["secret://db/password"],
          env: {
            DATABASE_HOST: "db.internal",
            DATABASE_NAME: "takos",
          },
        },
      }),
    );
    const code = await main(
      [
        "accounts",
        "serve",
        "--dry-run",
        "--service-binding-materials-file",
        materialsPath,
      ],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
    );

    expect(code).toEqual(0);
    expect(stderr).toEqual([]);
    const plan = JSON.parse(stdout.join("\n"));
    expect(plan.bindingMaterializer).toEqual({
      configured: true,
      source: "--service-binding-materials-file",
      bindings: ["db"],
    });
    expect(stdout.join("\n").includes("postgres://takos:secret")).toEqual(
      false,
    );
    expect(stdout.join("\n").includes("secret://db/password")).toEqual(false);
  } finally {
    await removePath(root, { recursive: true });
  }
});

test("accounts serve rejects secret-bearing static service binding env material", async () => {
  const root = await makeTempDir({ prefix: "takosumi-service-bindings-" });
  const materialsPath = `${root}/service-bindings.json`;
  const stdout: string[] = [];
  const stderr: string[] = [];
  try {
    await writeTextFile(
      materialsPath,
      JSON.stringify({
        db: {
          kind: "storage.sql",
          configRef: "takosumi-accounts://installations/template/db",
          secretRefs: ["secret://db/password"],
          env: {
            DATABASE_URL: "postgres://takos:must-not-leak@db.internal/takos",
          },
        },
      }),
    );
    const code = await main(
      [
        "accounts",
        "serve",
        "--dry-run",
        "--service-binding-materials-file",
        materialsPath,
      ],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
    );

    expect(code).toEqual(2);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual([
      "service binding material 'db'.env.DATABASE_URL may carry secret material; use secretRefs",
    ]);
    expect(stderr.join("\n")).not.toContain("must-not-leak");
  } finally {
    await removePath(root, { recursive: true });
  }
});

test("accounts serve rejects malformed static service binding materials", async () => {
  const root = await makeTempDir({ prefix: "takosumi-service-bindings-" });
  const materialsPath = `${root}/service-bindings.json`;
  const stdout: string[] = [];
  const stderr: string[] = [];
  try {
    await writeTextFile(
      materialsPath,
      JSON.stringify({
        db: { env: { DATABASE_URL: "postgres://takos:secret@db/takos" } },
      }),
    );
    const code = await main(
      [
        "accounts",
        "serve",
        "--dry-run",
        "--service-binding-materials-file",
        materialsPath,
      ],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
    );

    expect(code).toEqual(2);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual([
      "service binding material 'db' requires configRef",
    ]);
  } finally {
    await removePath(root, { recursive: true });
  }
});

test("accounts serve rejects malformed shared-cell warm pool slot shape", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await main(
    ["accounts", "serve", "--dry-run", "--shared-cell-slots", "bad-entry"],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    },
  );

  expect(code).toEqual(2);
  expect(stdout).toEqual([]);
  expect(stderr).toEqual([
    "shared-cell slots must use cell-id:capacity entries",
  ]);
});

test("accounts serve rejects malformed shared-cell warm pool slots", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await main(
    ["accounts", "serve", "--dry-run", "--shared-cell-slots", "Tokyo Cell:0"],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    },
  );

  expect(code).toEqual(2);
  expect(stdout).toEqual([]);
  expect(stderr).toEqual([
    "shared-cell slot capacity must be a positive integer",
  ]);
});

test("accounts serve rejects shared-cell scale-out policy without slots", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await main(
    [
      "accounts",
      "serve",
      "--dry-run",
      "--shared-cell-scale-out-policy",
      JSON.stringify({ strategy: "manual" }),
    ],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    },
  );

  expect(code).toEqual(2);
  expect(stdout).toEqual([]);
  expect(stderr).toEqual([
    "shared-cell scale-out policy requires shared-cell slots",
  ]);
});

test("accounts serve rejects malformed shared-cell scale-out policy", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await main(
    [
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
    ],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    },
  );

  expect(code).toEqual(2);
  expect(stdout).toEqual([]);
  expect(stderr).toEqual([
    "shared-cell scale-out policy minAvailableSlots must be a non-negative integer",
  ]);
});

test("accounts serve rejects invalid ports", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await main(
    ["accounts", "serve", "--dry-run", "--port", "nope"],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    },
  );

  expect(code).toEqual(2);
  expect(stdout).toEqual([]);
  expect(stderr).toEqual(["--port must be a positive integer"]);
});

test("accounts serve rejects invalid database URLs", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await main(
    [
      "accounts",
      "serve",
      "--dry-run",
      "--database-url",
      "http://db.internal/takosumi_accounts",
    ],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    },
  );

  expect(code).toEqual(2);
  expect(stdout).toEqual([]);
  expect(stderr).toEqual([
    "--database-url must be a postgres:// or postgresql:// URL",
  ]);
});

test("accounts serve rejects partial Stripe billing config", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await main(
    ["accounts", "serve", "--dry-run", "--stripe-secret-key", "sk_test"],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    },
  );

  expect(code).toEqual(2);
  expect(stdout).toEqual([]);
  expect(stderr).toEqual([
    "Stripe billing requires --stripe-secret-key and --stripe-webhook-secret",
  ]);
});

test("accounts serve rejects partial upstream OAuth config", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await main(
    [
      "accounts",
      "serve",
      "--dry-run",
      "--subject-secret",
      "subject-secret",
      "--google-client-id",
      "google-client",
    ],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    },
  );

  expect(code).toEqual(2);
  expect(stdout).toEqual([]);
  expect(stderr).toEqual([
    "--google-client-id and --google-redirect-uri are required together",
  ]);
});

test("accounts serve rejects partial custom upstream OIDC config", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await main(
    [
      "accounts",
      "serve",
      "--dry-run",
      "--subject-secret",
      "subject-secret",
      "--oidc-provider-id",
      "keycloak",
      "--oidc-client-id",
      "keycloak-client",
    ],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    },
  );

  expect(code).toEqual(2);
  expect(stdout).toEqual([]);
  expect(stderr).toEqual([
    "OIDC upstream provider requires --oidc-issuer, --oidc-authorization-endpoint, --oidc-token-endpoint, --oidc-userinfo-endpoint, --oidc-redirect-uri",
  ]);
});

test("accounts serve rejects partial passkey config", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await main(
    [
      "accounts",
      "serve",
      "--dry-run",
      "--passkey-rp-id",
      "accounts.example.test",
    ],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    },
  );

  expect(code).toEqual(2);
  expect(stdout).toEqual([]);
  expect(stderr).toEqual([
    "Passkeys require --passkey-rp-id, --passkey-rp-name, and --passkey-origin",
  ]);
});

test("accounts migrate dry-run prints ordered migration plan", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await main(
    [
      "accounts",
      "migrate",
      "--dry-run",
      "--database-url",
      "postgres://accounts:secret@db.internal:5432/takosumi_accounts",
    ],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    },
  );

  expect(code).toEqual(0);
  expect(stderr).toEqual([]);
  const plan = JSON.parse(stdout.join("\n"));
  expect(plan.kind).toEqual("takosumi.accounts.migrate@v1");
  expect(plan.database).toEqual({
    configured: true,
    driver: "postgres",
    source: "--database-url",
  });
  expect(plan.migrations.length).toEqual(26);
  expect(plan.migrations[0].name).toEqual("001_app_installation_ledger.sql");
  expect(plan.migrations[16].name).toEqual(
    "017_drop_binding_grant_runtime_binding.sql",
  );
  expect(plan.migrations[22].name).toEqual("023_account_email_verified.sql");
  expect(plan.migrations[24].name).toEqual("025_privacy_requests.sql");
  expect(plan.migrations[25].name).toEqual(
    "026_app_installation_source_path.sql",
  );
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
  const code = await main(
    [
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
    ],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    },
  );

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
    return Promise.resolve(
      Response.json({
        tokens: [
          {
            id: "pat_1",
            subject: "tsub_owner",
            name: "CLI",
            prefix: "takpat_abc",
            scopes: ["read", "write"],
            created_at: "2026-05-12T00:00:00.000Z",
          },
        ],
      }),
    );
  }) as typeof fetch;

  try {
    const code = await main(
      [
        "accounts",
        "tokens",
        "list",
        "--accounts-url",
        "http://accounts.local/",
        "--token",
        "sess_owner",
        "--json",
      ],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
    );

    expect(code).toEqual(0);
    expect(stderr).toEqual([]);
    expect(requests[0]?.url).toEqual("http://accounts.local/v1/account/tokens");
    expect(requests[0]?.method).toEqual("GET");
    expect(requests[0]?.headers.get("authorization")).toEqual(
      "Bearer sess_owner",
    );
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
    return Response.json(
      {
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
      },
      { status: 201 },
    );
  }) as typeof fetch;

  try {
    const code = await main(
      [
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
      ],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
    );

    expect(code).toEqual(0);
    expect(stderr).toEqual([]);
    expect(requests[0]?.request.url).toEqual(
      "http://accounts.local/v1/account/tokens",
    );
    expect(requests[0]?.request.method).toEqual("POST");
    expect(requests[0]?.request.headers.get("authorization")).toEqual(
      "Bearer sess_owner",
    );
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
    return Promise.resolve(
      Response.json({
        token: {
          id: "pat_2",
          subject: "tsub_owner",
          name: "Workstation",
          prefix: "takpat_cre",
          scopes: ["read", "admin"],
          created_at: "2026-05-12T00:00:00.000Z",
          revoked_at: "2026-05-12T00:05:00.000Z",
        },
      }),
    );
  }) as typeof fetch;

  try {
    const code = await main(
      [
        "accounts",
        "tokens",
        "revoke",
        "pat_2",
        "--accounts-url",
        "http://accounts.local",
        "--token",
        "sess_owner",
      ],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
    );

    expect(code).toEqual(0);
    expect(stderr).toEqual([]);
    expect(requests[0]?.url).toEqual(
      "http://accounts.local/v1/account/tokens/pat_2/revoke",
    );
    expect(requests[0]?.method).toEqual("POST");
    expect(stdout.join("\n")).toEqual(
      [
        "Personal access token pat_2",
        "  name: Workstation",
        "  state: revoked",
      ].join("\n"),
    );
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
    const code = await main(
      ["accounts", "tokens", "create", "--scope", "service.import@v1"],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
    );

    expect(code).toEqual(2);
    expect(stdout).toEqual([]);
    expect(fetchCalled).toEqual(false);
    expect(stderr).toEqual(["--scope must contain only: read, write, admin"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("top-level installations command is retired from the public CLI surface", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await main(["installations", "list"], {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
  });

  expect(code).toEqual(2);
  expect(stdout).toEqual([]);
  expect(stderr.join("\n")).toContain("not a public command");
  expect(stderr.join("\n")).toContain("takosumi internal installations");
});

test("internal installations list calls Takosumi Accounts with the target space", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const requests: Request[] = [];
  const originalFetch = globalThis.fetch;
  const originalSpaceId = envGet("TAKOS_SPACE_ID");
  globalThis.fetch = ((input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    return Promise.resolve(
      Response.json({
        installations: [
          {
            id: "inst_1",
            capsule_id: "takos.chat",
            status: "ready",
            mode: "shared-cell",
          },
        ],
      }),
    );
  }) as typeof fetch;
  envSet("TAKOS_SPACE_ID", "space_1");

  try {
    const code = await main(
      [
        "internal",
        "installations",
        "list",
        "--accounts-url",
        "http://accounts.local/",
        "--token",
        "sess_accounts",
        "--json",
      ],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
    );

    expect(code).toEqual(0);
    expect(stderr).toEqual([]);
    expect(requests[0]?.url).toEqual(
      "http://accounts.local/v1/installation-projections?space_id=space_1",
    );
    expect(requests[0]?.headers.get("authorization")).toEqual(
      "Bearer sess_accounts",
    );
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

test("internal installations inspect prints service bindings and service grants", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const requests: Request[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    return Promise.resolve(
      Response.json({
        installation: {
          id: "inst_1",
          capsule_id: "takos.chat",
          status: "ready",
          mode: "shared-cell",
          space_id: "space_1",
          source: {
            url: "https://github.com/takos/takos",
            ref: "v1.2.3",
          },
        },
        service_bindings: [
          {
            name: "auth",
            kind: "identity.oidc",
          },
        ],
        service_grants: [
          {
            capability: "deploy.intent.write",
            revoked_at: null,
          },
          {
            capability: "logs.read.own",
            revoked_at: "2026-05-09T00:00:00.000Z",
          },
        ],
        oidc_client: {
          client_id: "toc_inst_1",
          token_endpoint_auth_method: "client_secret_post",
          redirect_uris: ["http://localhost:8787/auth/oidc/callback"],
        },
        runtime_target: null,
      }),
    );
  }) as typeof fetch;

  try {
    const code = await main(
      [
        "internal",
        "installations",
        "inspect",
        "inst_1",
        "--accounts-url",
        "http://accounts.local",
        "--token",
        "sess_accounts",
      ],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
    );

    expect(code).toEqual(0);
    expect(stderr).toEqual([]);
    expect(requests[0]?.url).toEqual(
      "http://accounts.local/v1/installation-projections/inst_1",
    );
    expect(requests[0]?.headers.get("authorization")).toEqual(
      "Bearer sess_accounts",
    );
    const output = stdout.join("\n");
    expect(output.includes("Installation inst_1")).toEqual(true);
    expect(output.includes("  capsule: takos.chat")).toEqual(true);
    expect(output.includes("Service bindings:")).toEqual(true);
    expect(output.includes("auth  identity.oidc")).toEqual(true);
    expect(output.includes("toc_inst_1  client_secret_post")).toEqual(true);
    expect(output.includes("http://localhost:8787/auth/oidc/callback")).toEqual(
      true,
    );
    expect(output.includes("Service grants:")).toEqual(true);
    expect(output.includes("deploy.intent.write  active")).toEqual(true);
    expect(output.includes("logs.read.own  revoked")).toEqual(true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("internal installations uninstall deletes through ledger-retained Accounts route", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const requests: Request[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    return Promise.resolve(
      Response.json({
        installation: {
          id: "inst_1",
          status: "suspended",
        },
        revoked_service_grants: [
          {
            id: "grant_logs",
            capability: "logs.read.own",
            revoked_at: "2026-05-09T01:00:00.000Z",
          },
        ],
        event: {
          type: "installation.uninstalled",
        },
      }),
    );
  }) as typeof fetch;

  try {
    const code = await main(
      [
        "internal",
        "installations",
        "uninstall",
        "inst_1",
        "--reason",
        "user removed app",
        "--accounts-url",
        "http://accounts.local",
        "--token",
        "accounts-token",
      ],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
    );

    expect(code).toEqual(0);
    expect(stderr).toEqual([]);
    expect(requests[0]?.url).toEqual(
      "http://accounts.local/v1/installation-projections/inst_1",
    );
    expect(requests[0]?.method).toEqual("DELETE");
    expect(requests[0]?.headers.get("authorization")).toEqual(
      "Bearer accounts-token",
    );
    expect(requests[0]?.headers.get("content-type")).toEqual(
      "application/json",
    );
    expect(await requests[0]?.json()).toEqual({ reason: "user removed app" });
    expect(stdout.join("\n")).toEqual(
      [
        "Installation inst_1",
        "  status: suspended",
        "  revoked service grants: 1",
        "  event: installation.uninstalled",
      ].join("\n"),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("internal installations status patches the target installation", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const requests: Request[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    return Promise.resolve(
      Response.json({
        installation: {
          id: "inst_1",
          status: "ready",
        },
      }),
    );
  }) as typeof fetch;

  try {
    const code = await main(
      [
        "internal",
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
      ],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
    );

    expect(code).toEqual(0);
    expect(stderr).toEqual([]);
    expect(requests[0]?.url).toEqual(
      "http://accounts.local/v1/installation-projections/inst_1/status",
    );
    expect(requests[0]?.method).toEqual("PATCH");
    expect(requests[0]?.headers.get("authorization")).toEqual(
      "Bearer accounts-token",
    );
    expect(requests[0]?.headers.get("content-type")).toEqual(
      "application/json",
    );
    expect(await requests[0]?.json()).toEqual({
      status: "ready",
      reason: "healthcheck passed",
    });
    expect(stdout.join("\n")).toEqual("Installation inst_1\n  status: ready");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("internal installations status sends operation completion metadata", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const requests: Request[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    return Promise.resolve(
      Response.json({
        installation: {
          id: "inst_1",
          status: "ready",
          mode: "dedicated",
        },
        event: {
          type: "installation.materialize-succeeded",
        },
      }),
    );
  }) as typeof fetch;

  try {
    const code = await main(
      [
        "internal",
        "installations",
        "status",
        "inst_1",
        "--status",
        "ready",
        "--mode",
        "dedicated",
        "--operation-id",
        "op_materialize",
        "--preserve-digest",
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
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
      ],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
    );

    expect(code).toEqual(0);
    expect(stderr).toEqual([]);
    expect(await requests[0]?.json()).toEqual({
      status: "ready",
      reason: "dedicated runtime ready",
      mode: "dedicated",
      operationId: "op_materialize",
      preserveDigest:
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
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

test("internal installations status sends export archive digest metadata", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const requests: Request[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    return Promise.resolve(
      Response.json({
        installation: {
          id: "inst_1",
          status: "exported",
        },
        event: {
          type: "installation.exported",
        },
      }),
    );
  }) as typeof fetch;

  try {
    const code = await main(
      [
        "internal",
        "installations",
        "status",
        "inst_1",
        "--status",
        "exported",
        "--operation-id",
        "op_export",
        "--download-url",
        "https://downloads.example.test/export.tar.zst.age",
        "--download-expires-at",
        "2999-05-10T00:00:00.000Z",
        "--archive-digest",
        `sha256:${"c".repeat(64)}`,
        "--accounts-url",
        "http://accounts.local",
      ],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
    );

    expect(code).toEqual(0);
    expect(stderr).toEqual([]);
    expect(await requests[0]?.json()).toEqual({
      status: "exported",
      operationId: "op_export",
      downloadUrl: "https://downloads.example.test/export.tar.zst.age",
      downloadExpiresAt: "2999-05-10T00:00:00.000Z",
      archiveDigest: `sha256:${"c".repeat(64)}`,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("internal installations status sends operation failure metadata", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const requests: Request[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    return Promise.resolve(
      Response.json({
        installation: {
          id: "inst_1",
          status: "failed",
        },
        event: {
          type: "installation.export-failed",
        },
      }),
    );
  }) as typeof fetch;

  try {
    const code = await main(
      [
        "internal",
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
      ],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
    );

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

test("internal installations status rejects missing or invalid status", async () => {
  const missingStdout: string[] = [];
  const missingStderr: string[] = [];
  const missingCode = await main(
    ["internal", "installations", "status", "inst_1"],
    {
      stdout: (line) => missingStdout.push(line),
      stderr: (line) => missingStderr.push(line),
    },
  );
  expect(missingCode).toEqual(2);
  expect(missingStdout).toEqual([]);
  expect(missingStderr).toEqual(["--status is required"]);

  const invalidStdout: string[] = [];
  const invalidStderr: string[] = [];
  const invalidCode = await main(
    ["internal", "installations", "status", "inst_1", "--status", "paused"],
    {
      stdout: (line) => invalidStdout.push(line),
      stderr: (line) => invalidStderr.push(line),
    },
  );
  expect(invalidCode).toEqual(2);
  expect(invalidStdout).toEqual([]);
  expect(invalidStderr).toEqual([
    "--status must be one of: installing, ready, suspended, exported, failed",
  ]);
});

test("internal installations materialize posts a dedicated request", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const requests: Request[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    return Promise.resolve(
      Response.json({
        operationId: "op_materialize",
        installationId: "inst_1",
        fromMode: "shared-cell",
        toMode: "dedicated",
        trackingUrl:
          "/v1/installation-projections/inst_1/events?types=installation.materialize-requested",
      }),
    );
  }) as typeof fetch;

  try {
    const code = await main(
      [
        "internal",
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
      ],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
    );

    expect(code).toEqual(0);
    expect(stderr).toEqual([]);
    expect(requests[0]?.url).toEqual(
      "http://accounts.local/v1/installation-projections/inst_1/materialize",
    );
    expect(requests[0]?.method).toEqual("POST");
    expect(requests[0]?.headers.get("authorization")).toEqual(
      "Bearer accounts-token",
    );
    expect(requests[0]?.headers.get("idempotency-key")).toEqual(
      "idem-materialize",
    );
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
    expect(stdout.join("\n")).toEqual(
      [
        "Materialize operation op_materialize",
        "  installation: inst_1",
        "  mode: shared-cell -> dedicated",
        "  tracking: /v1/installation-projections/inst_1/events?types=installation.materialize-requested",
      ].join("\n"),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("internal installations materialize rejects unsupported modes", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await main(
    [
      "internal",
      "installations",
      "materialize",
      "inst_1",
      "--mode",
      "shared-cell",
      "--region",
      "tokyo",
      "--cost-ack",
    ],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    },
  );

  expect(code).toEqual(2);
  expect(stdout).toEqual([]);
  expect(stderr).toEqual(["--mode must be dedicated"]);
});

test("internal installations materialize requires explicit cost acknowledgement", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await main(
    ["internal", "installations", "materialize", "inst_1", "--region", "tokyo"],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    },
  );

  expect(code).toEqual(2);
  expect(stdout).toEqual([]);
  expect(stderr).toEqual(["--cost-ack is required"]);
});

test("internal installations export posts a pending bundle request", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const requests: Request[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    return Promise.resolve(
      Response.json({
        operationId: "op_export",
        status: "preparing",
        trackingUrl:
          "/v1/installation-projections/inst_1/events?types=installation.export-requested",
        downloadUrl: null,
        downloadExpiresAt: null,
      }),
    );
  }) as typeof fetch;

  try {
    const code = await main(
      [
        "internal",
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
      ],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
    );

    expect(code).toEqual(0);
    expect(stderr).toEqual([]);
    expect(requests[0]?.url).toEqual(
      "http://accounts.local/v1/installation-projections/inst_1/export",
    );
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
    expect(stdout.join("\n")).toEqual(
      [
        "Export operation op_export",
        "  status: preparing",
        "  tracking: /v1/installation-projections/inst_1/events?types=installation.export-requested",
      ].join("\n"),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("internal installations export-operation reads operation status", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const requests: Request[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    return Promise.resolve(
      Response.json({
        operationId: "op_export",
        installationId: "inst_1",
        status: "ready",
        downloadUrl: "https://exports.example/download",
      }),
    );
  }) as typeof fetch;

  try {
    const code = await main(
      [
        "internal",
        "installations",
        "export-operation",
        "inst_1",
        "op_export",
        "--accounts-url",
        "http://accounts.local",
        "--token",
        "accounts-token",
      ],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
    );

    expect(code).toEqual(0);
    expect(stderr).toEqual([]);
    expect(requests[0]?.url).toEqual(
      "http://accounts.local/v1/installation-projections/inst_1/exports/op_export",
    );
    expect(requests[0]?.method).toEqual("GET");
    expect(requests[0]?.headers.get("authorization")).toEqual(
      "Bearer accounts-token",
    );
    expect(stdout.join("\n")).toEqual(
      [
        "Export operation op_export",
        "  installation: inst_1",
        "  status: ready",
        "  download: https://exports.example/download",
      ].join("\n"),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("internal installations export-operation requires operation id", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await main(
    ["internal", "installations", "export-operation", "inst_1"],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    },
  );

  expect(code).toEqual(2);
  expect(stdout).toEqual([]);
  expect(stderr).toEqual(["operation id is required"]);
});

test("internal installations export requires age recipients", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await main(
    [
      "internal",
      "installations",
      "export",
      "inst_1",
      "--encryption-method",
      "age",
    ],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    },
  );

  expect(code).toEqual(2);
  expect(stdout).toEqual([]);
  expect(stderr).toEqual([
    "--recipient is required when --encryption-method age",
  ]);
});

test("internal installations import-plan emits a target restore request", async () => {
  const bundleFile = await makeTempFile({ suffix: ".json" });
  const stdout: string[] = [];
  const stderr: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() => {
    throw new Error("import-plan must not call the retired import route");
  }) as typeof fetch;
  await writeTextFile(
    bundleFile,
    JSON.stringify({
      kind: "takosumi.accounts.installation-export-bundle@v1",
      version: "v1",
      exportedAt: "2026-06-23T13:00:00.000Z",
      installation: {
        installationId: "inst_source",
        accountId: "acct_source",
        spaceId: "space_source",
        appId: "takos.chat",
        billingAccountId: null,
        mode: "dedicated",
        status: "exported",
      },
      source: {
        gitUrl: "https://github.com/takos/takos",
        ref: "v1.2.3",
        commit: "0123456789abcdef0123456789abcdef01234567",
        path: "deploy/opentofu",
        planDigest: "sha256:app",
        artifactDigest: "sha256:compiled",
      },
      runtimeTarget: null,
      oidcClient: {
        clientId: "oidc_source",
        serviceBinding: "auth",
        servicePath: "takosumi.identity.oidc",
        issuerUrl: "https://accounts.source.test",
        redirectUris: ["https://accounts.source.test/auth/callback"],
        allowedScopes: ["openid", "profile"],
        subjectMode: "pairwise",
        tokenEndpointAuthMethod: "none",
      },
      serviceBindings: [
        {
          serviceBindingId: "bind_auth",
          name: "auth",
          kind: "identity.oidc",
          template: {
            configRef:
              "https://accounts.source.test/.well-known/openid-configuration",
          },
        },
      ],
      serviceGrants: [
        {
          serviceGrantId: "grant_threads",
          capability: "threads:read",
          scope: {
            pathPrefix: "threads/",
            apiKey: "sk-secret-from-source",
          },
          grantedAt: "2026-06-23T13:00:00.000Z",
          revokedAt: null,
        },
      ],
      events: [],
    }),
  );

  try {
    const code = await main(
      [
        "internal",
        "installations",
        "import-plan",
        "--bundle-file",
        bundleFile,
        "--target-issuer",
        "https://selfhost.example.test",
        "--target-account",
        "acct_target",
        "--target-space",
        "space_target",
        "--target-installation-id",
        "inst_target",
        "--created-by-subject",
        "tsub_target",
        "--mode",
        "shared-cell",
        "--variables-json",
        '{"accountId":"acct_cf_target","workersSubdomain":"target-subdomain"}',
      ],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
    );

    expect(code).toEqual(0);
    expect(stderr).toEqual([]);
    const plan = JSON.parse(stdout.join("\n"));
    expect(plan.kind).toEqual("takosumi.accounts.installation-import-plan@v1");
    expect(plan.sourceIssuer).toEqual("https://accounts.source.test");
    expect(plan.targetIssuer).toEqual("https://selfhost.example.test");
    expect(plan.target.requestedInstallationId).toEqual("inst_target");
    expect(plan.deployControlPlanRequest).toEqual({
      spaceId: "space_target",
      source: {
        kind: "git",
        url: "https://github.com/takos/takos",
        ref: "v1.2.3",
        commit: "0123456789abcdef0123456789abcdef01234567",
        path: "deploy/opentofu",
      },
      variables: {
        accountId: "acct_cf_target",
        workersSubdomain: "target-subdomain",
      },
    });
    expect(plan.request.installationId).toEqual(undefined);
    expect(plan.request.accountId).toEqual("acct_target");
    expect(plan.request.spaceId).toEqual("space_target");
    expect(plan.request.mode).toEqual("shared-cell");
    expect(plan.request.source.url).toEqual("https://github.com/takos/takos");
    expect(plan.request.source.gitUrl).toEqual(
      "https://github.com/takos/takos",
    );
    expect(plan.request.source.path).toEqual("deploy/opentofu");
    expect(plan.request.oidcClients[0].issuerUrl).toEqual(
      "https://selfhost.example.test",
    );
    expect(plan.request.oidcClients[0].redirectUris).toEqual([
      "https://selfhost.example.test/auth/callback",
    ]);
    expect(JSON.stringify(plan)).not.toContain("sk-secret-from-source");
    expect(plan.request.serviceGrants[0].scope.apiKey).toEqual("[REDACTED]");
    expect(plan.request.serviceGrants[0].declaration).toEqual({
      sourceServiceGrantId: "grant_threads",
    });
  } finally {
    globalThis.fetch = originalFetch;
    await removePath(bundleFile);
  }
});

test("internal installations import-plan accepts Cloudflare R2 export documents", async () => {
  const bundleFile = await makeTempFile({ suffix: ".json" });
  const stdout: string[] = [];
  const stderr: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() => {
    throw new Error("import-plan must not call the retired import route");
  }) as typeof fetch;
  await writeTextFile(
    bundleFile,
    JSON.stringify({
      kind: "takosumi.accounts.cloudflare-r2-installation-export@v1",
      version: "v1",
      exportedAt: "2026-06-23T22:30:00.000Z",
      operationId: "op_r2_export",
      request: {
        includeData: false,
        format: "bundle",
        encryption: { method: "age", recipients: ["age1recipient"] },
        scope: { installation: true, ledger: true, outputs: true },
      },
      bundle: {
        kind: "takosumi.accounts.installation-export-bundle@v1",
        version: "v1",
        exportedAt: "2026-06-23T22:30:00.000Z",
        installation: {
          installationId: "inst_source",
          accountId: "acct_source",
          spaceId: "space_source",
          appId: "takos.chat",
          billingAccountId: null,
          mode: "dedicated",
          status: "exported",
        },
        source: {
          gitUrl: "https://github.com/takos/takos",
          ref: "v1.2.3",
          commit: "0123456789abcdef0123456789abcdef01234567",
          path: "deploy/opentofu",
          planDigest: "sha256:app",
          artifactDigest: null,
        },
        runtimeTarget: null,
        oidcClient: null,
        serviceBindings: [],
        serviceGrants: [],
        events: [],
      },
    }),
  );

  try {
    const code = await main(
      [
        "internal",
        "installations",
        "import-plan",
        "--bundle-file",
        bundleFile,
        "--target-issuer",
        "https://selfhost.example.test",
        "--target-account",
        "acct_target",
        "--target-space",
        "space_target",
        "--created-by-subject",
        "tsub_target",
      ],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
    );

    expect(code).toEqual(0);
    expect(stderr).toEqual([]);
    const plan = JSON.parse(stdout.join("\n"));
    expect(plan.kind).toEqual("takosumi.accounts.installation-import-plan@v1");
    expect(plan.request.installationId).toEqual(undefined);
    expect(plan.deployControlPlanRequest.source.url).toEqual(
      "https://github.com/takos/takos",
    );
    expect(plan.request.accountId).toEqual("acct_target");
    expect(plan.request.spaceId).toEqual("space_target");
    expect(plan.request.mode).toEqual("self-hosted");
  } finally {
    globalThis.fetch = originalFetch;
    await removePath(bundleFile);
  }
});

test("internal installations import-apply creates a target plan and projection", async () => {
  const bundleFile = await makeTempFile({ suffix: ".json" });
  const stdout: string[] = [];
  const stderr: string[] = [];
  const requests: Request[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push(request);
    const url = new URL(request.url);
    if (url.pathname === "/api/v1/sources") {
      return Promise.resolve(
        Response.json({ source: { id: "src_import" } }, { status: 201 }),
      );
    }
    if (url.pathname === "/api/v1/sources/src_import/sync") {
      return Promise.resolve(
        Response.json(
          { run: { id: "ssr_import", status: "succeeded" } },
          { status: 201 },
        ),
      );
    }
    if (url.pathname === "/api/v1/spaces/space_target/installations") {
      return Promise.resolve(
        Response.json(
          { installation: { id: "inst_import_target" } },
          { status: 201 },
        ),
      );
    }
    if (
      url.pathname ===
      "/api/v1/installations/inst_import_target/provider-connections"
    ) {
      return Promise.resolve(
        Response.json(
          {
            providerConnectionSet: {
              connections: [
                {
                  provider: "cloudflare",
                  alias: "main",
                  connectionId: "pcn_cf_target",
                },
                {
                  provider: "registry.opentofu.org/vercel/vercel",
                  alias: "edge",
                  connectionId: "pcn_vercel_target",
                },
              ],
            },
          },
          { status: 200 },
        ),
      );
    }
    if (url.pathname === "/v1/installation-projections/plan-runs") {
      return Promise.resolve(
        Response.json(
          {
            kind: "takosumi.deploy-control.plan-run@v1",
            planRunId: "plan_import",
            planRun: {
              id: "plan_import",
              status: "succeeded",
            },
            expected: {
              planRunId: "plan_import",
              runnerProfileId: "runner_default",
              sourceDigest: "sha256:source",
              variablesDigest: "sha256:variables",
              policyDecisionDigest: "sha256:policy",
              planDigest: "sha256:plan",
              planArtifactDigest: "sha256:artifact",
              sourceCommit: "0123456789abcdef0123456789abcdef01234567",
            },
          },
          { status: 201 },
        ),
      );
    }
    if (url.pathname === "/v1/installation-projections") {
      return Promise.resolve(
        Response.json(
          {
            status: "ready",
            installation: {
              id: "inst_target_canonical",
              spaceId: "space_target",
            },
          },
          { status: 202 },
        ),
      );
    }
    return Promise.reject(
      new Error(`unexpected import-apply request: ${request.url}`),
    );
  }) as typeof fetch;
  await writeTextFile(
    bundleFile,
    JSON.stringify({
      kind: "takosumi.accounts.installation-export-bundle@v1",
      version: "v1",
      exportedAt: "2026-06-23T13:00:00.000Z",
      installation: {
        installationId: "inst_source",
        accountId: "acct_source",
        spaceId: "space_source",
        appId: "takos.chat",
        billingAccountId: null,
        mode: "dedicated",
        status: "exported",
      },
      source: {
        gitUrl: "https://github.com/takos/takos",
        ref: "v1.2.3",
        commit: "0123456789abcdef0123456789abcdef01234567",
        path: "deploy/opentofu",
        planDigest: "sha256:app",
        artifactDigest: null,
      },
      runtimeTarget: null,
      oidcClient: null,
      serviceBindings: [],
      serviceGrants: [],
      events: [],
    }),
  );

  try {
    const code = await main(
      [
        "internal",
        "installations",
        "import-apply",
        "--bundle-file",
        bundleFile,
        "--target-issuer",
        "https://selfhost.example.test",
        "--target-account",
        "acct_target",
        "--target-space",
        "space_target",
        "--created-by-subject",
        "tsub_target",
        "--accounts-url",
        "https://accounts.target.test",
        "--token",
        "takpat_write",
        "--idempotency-key",
        "idem-import-apply",
        "--provider",
        "cloudflare=pcn_cf_target,registry.opentofu.org/vercel/vercel@edge=pcn_vercel_target",
        "--variables-json",
        '{"accountId":"acct_cf_target","workersSubdomain":"target-subdomain"}',
        "--json",
      ],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
    );

    expect({ code, stderr }).toEqual({ code: 0, stderr: [] });
    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      "/api/v1/sources",
      "/api/v1/sources/src_import/sync",
      "/api/v1/spaces/space_target/installations",
      "/api/v1/installations/inst_import_target/provider-connections",
      "/v1/installation-projections/plan-runs",
      "/v1/installation-projections",
    ]);
    expect(requests[0]?.headers.get("authorization")).toEqual(
      "Bearer takpat_write",
    );
    expect(requests[5]?.headers.get("idempotency-key")).toEqual(
      "idem-import-apply",
    );
    expect(await requests[0]?.json()).toEqual({
      spaceId: "space_target",
      name: "takos.chat-source",
      url: "https://github.com/takos/takos",
      defaultRef: "v1.2.3",
      defaultPath: "deploy/opentofu",
    });
    expect(await requests[2]?.json()).toEqual({
      name: "takos.chat-installation",
      environment: "production",
      sourceId: "src_import",
      installConfigId: "cfg-default-opentofu-capsule",
    });
    expect(await requests[3]?.json()).toEqual({
      connections: [
        {
          provider: "cloudflare",
          alias: "main",
          connectionId: "pcn_cf_target",
        },
        {
          provider: "registry.opentofu.org/vercel/vercel",
          alias: "edge",
          connectionId: "pcn_vercel_target",
        },
      ],
    });
    expect(await requests[4]?.json()).toEqual({
      spaceId: "space_target",
      source: {
        kind: "git",
        url: "https://github.com/takos/takos",
        ref: "v1.2.3",
        commit: "0123456789abcdef0123456789abcdef01234567",
        path: "deploy/opentofu",
      },
      installationId: "inst_import_target",
      operation: "create",
      requiredProviders: [
        "registry.opentofu.org/cloudflare/cloudflare",
        "registry.opentofu.org/vercel/vercel",
      ],
      variables: {
        accountId: "acct_cf_target",
        workersSubdomain: "target-subdomain",
      },
    });
    const projectionRequest = await requests[5]?.json();
    expect(projectionRequest.installationId).toEqual(undefined);
    expect(projectionRequest.planRunId).toEqual("plan_import");
    expect(projectionRequest.expected.planArtifactDigest).toEqual(
      "sha256:artifact",
    );
    expect(projectionRequest.source.url).toEqual(
      "https://github.com/takos/takos",
    );
    const result = JSON.parse(stdout.join("\n"));
    expect(result.kind).toEqual(
      "takosumi.accounts.installation-import-apply-result@v1",
    );
    expect(result.planRunId).toEqual("plan_import");
    expect(result.projection.installation.id).toEqual("inst_target_canonical");
  } finally {
    globalThis.fetch = originalFetch;
    await removePath(bundleFile);
  }
});

test("internal installations import-apply reuses duplicate target installation", async () => {
  const bundleFile = await makeTempFile({ suffix: ".json" });
  const stdout: string[] = [];
  const stderr: string[] = [];
  const requests: Request[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push(request);
    const url = new URL(request.url);
    if (url.pathname === "/api/v1/sources") {
      return Promise.resolve(
        Response.json({ source: { id: "src_import" } }, { status: 201 }),
      );
    }
    if (url.pathname === "/api/v1/sources/src_import/sync") {
      return Promise.resolve(
        Response.json(
          { run: { id: "ssr_import", status: "succeeded" } },
          { status: 201 },
        ),
      );
    }
    if (url.pathname === "/api/v1/spaces/space_target/installations") {
      return Promise.resolve(
        Response.json(
          {
            error: {
              code: "failed_precondition",
              message: "installation already exists",
              details: {
                reason: "duplicate_installation",
                installationId: "inst_existing_target",
              },
            },
          },
          { status: 409 },
        ),
      );
    }
    if (
      url.pathname ===
      "/api/v1/installations/inst_existing_target/provider-connections"
    ) {
      return Promise.resolve(
        Response.json(
          {
            providerConnectionSet: {
              connections: [
                {
                  provider: "cloudflare",
                  alias: "main",
                  connectionId: "pcn_cf_target",
                },
              ],
            },
          },
          { status: 200 },
        ),
      );
    }
    if (url.pathname === "/v1/installation-projections/plan-runs") {
      return Promise.resolve(
        Response.json(
          {
            kind: "takosumi.deploy-control.plan-run@v1",
            planRunId: "plan_import",
            planRun: {
              id: "plan_import",
              status: "succeeded",
            },
            expected: {
              planRunId: "plan_import",
              runnerProfileId: "runner_default",
              sourceDigest: "sha256:source",
              variablesDigest: "sha256:variables",
              policyDecisionDigest: "sha256:policy",
              planDigest: "sha256:plan",
              planArtifactDigest: "sha256:artifact",
            },
          },
          { status: 201 },
        ),
      );
    }
    if (url.pathname === "/v1/installation-projections") {
      return Promise.resolve(
        Response.json(
          {
            status: "ready",
            installation: { id: "inst_target_canonical" },
          },
          { status: 202 },
        ),
      );
    }
    return Promise.reject(
      new Error(`unexpected duplicate import request: ${request.url}`),
    );
  }) as typeof fetch;
  await writeTextFile(
    bundleFile,
    JSON.stringify({
      kind: "takosumi.accounts.installation-export-bundle@v1",
      version: "v1",
      exportedAt: "2026-06-23T13:00:00.000Z",
      installation: {
        installationId: "inst_source",
        accountId: "acct_source",
        spaceId: "space_source",
        appId: "takos.chat",
        billingAccountId: null,
        mode: "dedicated",
        status: "exported",
      },
      source: {
        gitUrl: "https://github.com/takos/takos",
        ref: "v1.2.3",
        commit: "0123456789abcdef0123456789abcdef01234567",
        path: "deploy/opentofu",
        planDigest: "sha256:app",
        artifactDigest: null,
      },
      runtimeTarget: null,
      oidcClient: null,
      serviceBindings: [],
      serviceGrants: [],
      events: [],
    }),
  );

  try {
    const code = await main(
      [
        "internal",
        "installations",
        "import-apply",
        "--bundle-file",
        bundleFile,
        "--target-issuer",
        "https://selfhost.example.test",
        "--target-account",
        "acct_target",
        "--target-space",
        "space_target",
        "--created-by-subject",
        "tsub_target",
        "--accounts-url",
        "https://accounts.target.test",
        "--token",
        "takpat_write",
        "--provider",
        "cloudflare=pcn_cf_target",
        "--json",
      ],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
    );

    expect({ code, stderr }).toEqual({ code: 0, stderr: [] });
    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      "/api/v1/sources",
      "/api/v1/sources/src_import/sync",
      "/api/v1/spaces/space_target/installations",
      "/api/v1/installations/inst_existing_target/provider-connections",
      "/v1/installation-projections/plan-runs",
      "/v1/installation-projections",
    ]);
    expect(await requests[3]?.json()).toEqual({
      connections: [
        {
          provider: "cloudflare",
          alias: "main",
          connectionId: "pcn_cf_target",
        },
      ],
    });
    expect(await requests[4]?.json()).toMatchObject({
      installationId: "inst_existing_target",
    });
    const result = JSON.parse(stdout.join("\n"));
    expect(result.planRunId).toEqual("plan_import");
  } finally {
    globalThis.fetch = originalFetch;
    await removePath(bundleFile);
  }
});

test("internal installations import-apply rejects metadata-only upload sources", async () => {
  const bundleFile = await makeTempFile({ suffix: ".json" });
  const stdout: string[] = [];
  const stderr: string[] = [];
  await writeTextFile(
    bundleFile,
    JSON.stringify({
      kind: "takosumi.accounts.installation-export-bundle@v1",
      version: "v1",
      exportedAt: "2026-06-23T13:00:00.000Z",
      installation: {
        installationId: "inst_source",
        accountId: "acct_source",
        spaceId: "space_source",
        appId: "takos.chat",
        billingAccountId: null,
        mode: "dedicated",
        status: "exported",
      },
      source: {
        gitUrl: "https://uploads.takosumi.com/space_source",
        ref: "upload",
        commit: "0123456789abcdef0123456789abcdef01234567",
        planDigest: "sha256:app",
        artifactDigest: null,
      },
      runtimeTarget: null,
      oidcClient: null,
      serviceBindings: [],
      serviceGrants: [],
      events: [],
    }),
  );

  try {
    const code = await main(
      [
        "internal",
        "installations",
        "import-apply",
        "--bundle-file",
        bundleFile,
        "--target-issuer",
        "https://selfhost.example.test",
        "--target-account",
        "acct_target",
        "--target-space",
        "space_target",
        "--created-by-subject",
        "tsub_target",
        "--accounts-url",
        "https://accounts.target.test",
        "--token",
        "takpat_write",
      ],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
    );

    expect(code).toEqual(1);
    expect(stdout).toEqual([]);
    expect(stderr.join("\n")).toContain("metadata-only upload source");
  } finally {
    await removePath(bundleFile);
  }
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
      const rows = [...versions]
        .sort((a, b) => a - b)
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
  expect(
    fake.calls[0].sql.includes(
      "CREATE TABLE IF NOT EXISTS takosumi_accounts_schema_migrations",
    ),
  ).toBeTruthy();
  // The SELECT and the per-migration writes carry the account id through.
  expect(fake.calls.every((call) => call.accountId === "acct-1")).toBeTruthy();
  const inserted = fake.calls.find((call) =>
    call.sql.startsWith("INSERT INTO takosumi_accounts_schema_migrations"),
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
    call.sql.startsWith("INSERT INTO takosumi_accounts_schema_migrations"),
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
      const parsed = JSON.parse(wranglerJson) as Array<{
        results?: Array<{ results?: Array<{ version: number }> }>;
      }>;
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
  const code = await main(
    ["accounts", "serve", "--dry-run", "--port", "not-a-number"],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    },
  );
  expect(code).toEqual(2);
  expect(stdout).toEqual([]);
  expect(stderr).toEqual(["--port must be a positive integer"]);
});

test("accounts serve accepts a valid --port in the dry-run plan", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await main(
    ["accounts", "serve", "--dry-run", "--port", "9090"],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    },
  );
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
    expect((error as TypeError).message).toEqual(
      "--port must be a positive integer",
    );
  }
  expect(threw).toBeTruthy();
});

test("integerOption returns the fallback when the flag is absent", () => {
  expect(integerOption({}, "port", 8787)).toEqual(8787);
  expect(integerOption({ port: "443" }, "port", 8787)).toEqual(443);
});

test("connections set-cloudflare-token reads token file and never prints the secret", async () => {
  const tokenFile = await makeTempFile();
  await writeTextFile(tokenFile, "cf_live_secret\n");
  const stdout: string[] = [];
  const stderr: string[] = [];
  const requests: Array<{ request: Request; body: string }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const request = new Request(input, init);
    const body = await request.clone().text();
    requests.push({ request, body });
    if (request.url.endsWith("/internal/v1/provider-envs")) {
      const payload = JSON.parse(body);
      return Response.json({
        operatorConnectionDefault: {
          id: `ocd_${payload.provider}`,
          provider: payload.provider,
          connectionId: payload.connectionId,
          createdAt: "2026-06-09T00:00:00.000Z",
          updatedAt: "2026-06-09T00:00:00.000Z",
        },
      });
    }
    return Response.json(
      {
        connection: {
          id: "conn_cf",
          scope: "operator",
          provider: "cloudflare",
          kind: "cloudflare_api_token",
          authMethod: "static_secret",
          status: "pending",
          envNames: ["CLOUDFLARE_API_TOKEN"],
          createdAt: "2026-06-09T00:00:00.000Z",
          updatedAt: "2026-06-09T00:00:00.000Z",
        },
      },
      { status: 201 },
    );
  }) as typeof fetch;

  try {
    const code = await main(
      [
        "connections",
        "set-cloudflare-token",
        "--url",
        "https://app.takosumi.test",
        "--token",
        "operator-bearer",
        "--api-token-file",
        tokenFile,
        "--account-id",
        "acct_1",
      ],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
    );

    expect(code).toEqual(0);
    expect(stderr).toEqual([]);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.request.url).toEqual(
      "https://app.takosumi.test/internal/v1/connections/cloudflare/token",
    );
    expect(requests[0]?.request.headers.get("authorization")).toEqual(
      "Bearer operator-bearer",
    );
    const createBody = JSON.parse(requests[0]!.body);
    expect(createBody).toMatchObject({
      provider: "cloudflare",
      kind: "cloudflare_api_token",
      scope: "operator",
      scopeHints: { accountId: "acct_1" },
      values: { CLOUDFLARE_API_TOKEN: "cf_live_secret" },
    });
    const output = stdout.concat(stderr).join("\n");
    expect(output).not.toContain("cf_live_secret");
    expect(output).toContain("Connection conn_cf created");
  } finally {
    globalThis.fetch = originalFetch;
    await removePath(tokenFile);
  }
});

test("root help shows only the stable operator CLI surface", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await main(["run", "--help"], {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
  });

  expect(code).toEqual(0);
  expect(stderr).toEqual([]);
  expect(stdout.join("\n")).toContain("connections");
  expect(stdout.join("\n")).toContain("secrets");
  expect(stdout.join("\n")).not.toContain("accounts seed");
});

test("operator CLI help supports Japanese output", async () => {
  const previous = envGet("TAKOSUMI_LANG");
  envSet("TAKOSUMI_LANG", "ja");
  const stdout: string[] = [];
  const stderr: string[] = [];
  try {
    const code = await main(["run", "--help"], {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    });

    expect(code).toEqual(0);
    expect(stderr).toEqual([]);
    expect(stdout.join("\n")).toContain("deploy");
    expect(stdout.join("\n")).toContain("connections");
    expect(stdout.join("\n")).not.toContain("accounts seed");
  } finally {
    if (previous === undefined) {
      envDelete("TAKOSUMI_LANG");
    } else {
      envSet("TAKOSUMI_LANG", previous);
    }
  }
});

test("connections create-generic-env creates a Space-owned arbitrary provider connection", async () => {
  const valuesFile = await makeTempFile({ suffix: ".json" });
  const filesFile = await makeTempFile({ suffix: ".json" });
  const scopeHintsFile = await makeTempFile({ suffix: ".json" });
  await writeTextFile(
    valuesFile,
    JSON.stringify({
      VERCEL_API_TOKEN: "vercel_secret",
      VERCEL_TEAM_ID: "team_1",
    }),
  );
  await writeTextFile(
    filesFile,
    JSON.stringify([
      {
        path: "vercel-credentials.json",
        content: '{"token":"file_secret"}',
        envName: "VERCEL_CREDENTIALS_FILE",
        mode: 384,
      },
    ]),
  );
  await writeTextFile(
    scopeHintsFile,
    JSON.stringify({ templateId: "vercel-project" }),
  );
  const stdout: string[] = [];
  const stderr: string[] = [];
  const requests: { request: Request; body: string }[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const body = await request.text();
    requests.push({ request, body });
    return Response.json(
      {
        connection: {
          id: "conn_vercel",
          scope: "space",
          provider: "registry.opentofu.org/vercel/vercel",
          kind: "generic_env_provider",
          status: "verified",
          envNames: [
            "VERCEL_API_TOKEN",
            "VERCEL_CREDENTIALS_FILE",
            "VERCEL_TEAM_ID",
          ],
        },
      },
      { status: 201 },
    );
  }) as typeof fetch;

  try {
    const code = await main(
      [
        "connections",
        "create-generic-env",
        "--url",
        "https://app.takosumi.test",
        "--token",
        "operator-bearer",
        "--space",
        "space_1",
        "--provider",
        "registry.opentofu.org/vercel/vercel",
        "--values-file",
        valuesFile,
        "--files-file",
        filesFile,
        "--scope-hints-file",
        scopeHintsFile,
      ],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
    );

    expect({ code, stderr }).toEqual({ code: 0, stderr: [] });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.request.url).toEqual(
      "https://app.takosumi.test/internal/v1/connections/generic-env-provider",
    );
    expect(requests[0]?.request.headers.get("authorization")).toEqual(
      "Bearer operator-bearer",
    );
    const createBody = JSON.parse(requests[0]!.body);
    expect(createBody).toEqual({
      provider: "registry.opentofu.org/vercel/vercel",
      spaceId: "space_1",
      kind: "generic_env_provider",
      authMethod: "static_secret",
      scope: "space",
      scopeHints: { templateId: "vercel-project" },
      values: {
        VERCEL_API_TOKEN: "vercel_secret",
        VERCEL_TEAM_ID: "team_1",
      },
      files: [
        {
          path: "vercel-credentials.json",
          content: '{"token":"file_secret"}',
          envName: "VERCEL_CREDENTIALS_FILE",
          mode: 384,
        },
      ],
    });
    const output = stdout.concat(stderr).join("\n");
    expect(output).toContain("Connection conn_vercel created");
    expect(output).not.toContain("vercel_secret");
    expect(output).not.toContain("file_secret");
  } finally {
    globalThis.fetch = originalFetch;
    await removePath(valuesFile);
    await removePath(filesFile);
    await removePath(scopeHintsFile);
  }
});

test("connections set-cloudflare-token rejects Space-owned connection flags", async () => {
  const tokenFile = await makeTempFile();
  await writeTextFile(tokenFile, "cf_live_secret\n");
  const stdout: string[] = [];
  const stderr: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() => {
    throw new Error("fetch must not be called");
  }) as typeof fetch;

  try {
    const code = await main(
      [
        "connections",
        "set-cloudflare-token",
        "--url",
        "https://app.takosumi.test",
        "--token",
        "operator-bearer",
        "--space",
        "space_1",
        "--api-token-file",
        tokenFile,
      ],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
    );

    expect(code).toEqual(2);
    expect(stdout).toEqual([]);
    expect(stderr.join("\n")).toContain(
      "operator CLI does not create Space-owned Provider Connection backing material",
    );
    expect(stderr.join("\n")).not.toContain("cf_live_secret");
  } finally {
    globalThis.fetch = originalFetch;
    await removePath(tokenFile);
  }
});

test("deploy resolves @handle space flags before upload and deploy", async () => {
  const capsuleDir = await makeTempDir();
  await writeTextFile(pathJoin(capsuleDir, "main.tf"), "terraform {}\n");
  const stdout: string[] = [];
  const stderr: string[] = [];
  const requests: Array<{ request: Request; body: string }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const request = new Request(input, init);
    const body =
      request.headers.get("content-type") === "application/json"
        ? await request.clone().text()
        : "<binary>";
    requests.push({ request, body });
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/api/v1/spaces") {
      return Response.json({
        spaces: [
          {
            id: "space_me",
            handle: "me",
            displayName: "Me",
            type: "personal",
            ownerUserId: "tsub_me",
            createdAt: "2026-06-14T00:00:00.000Z",
            updatedAt: "2026-06-14T00:00:00.000Z",
          },
        ],
      });
    }
    if (
      request.method === "POST" &&
      url.pathname === "/api/v1/spaces/space_me/uploads"
    ) {
      return Response.json({
        snapshot: {
          id: "snap_upload",
          archiveDigest: "sha256:abc",
          archiveSizeBytes: 123,
        },
      });
    }
    if (request.method === "POST" && url.pathname === "/api/v1/deploy") {
      return Response.json({
        installation: { id: "inst_1", name: "my-app" },
        run: { id: "run_plan", status: "queued", type: "plan" },
        planRun: { id: "run_plan", status: "queued", type: "plan" },
        created: true,
      });
    }
    if (request.method === "GET" && url.pathname === "/api/v1/runs/run_plan") {
      return Response.json({
        id: "run_plan",
        status: "succeeded",
        type: "plan",
        policyStatus: "passed",
      });
    }
    if (
      request.method === "POST" &&
      url.pathname === "/api/v1/runs/run_plan/apply"
    ) {
      return Response.json({
        run: { id: "run_apply", status: "queued", type: "apply" },
      });
    }
    if (request.method === "GET" && url.pathname === "/api/v1/runs/run_apply") {
      return Response.json({
        id: "run_apply",
        status: "succeeded",
        type: "apply",
        policyStatus: "passed",
      });
    }
    return Response.json(
      { error: { message: "unexpected request" } },
      { status: 404 },
    );
  }) as typeof fetch;

  try {
    const code = await main(
      [
        "deploy",
        capsuleDir,
        "--space",
        "@me",
        "--name",
        "my-app",
        "--url",
        "https://app.takosumi.test",
        "--token",
        "session-bearer",
      ],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
    );

    expect(code).toEqual(0);
    expect(stderr).toEqual([]);
    expect(
      requests.map(
        ({ request }) => `${request.method} ${new URL(request.url).pathname}`,
      ),
    ).toEqual([
      "GET /api/v1/spaces",
      "POST /api/v1/spaces/space_me/uploads",
      "POST /api/v1/deploy",
      "GET /api/v1/runs/run_plan",
      "POST /api/v1/runs/run_plan/apply",
      "GET /api/v1/runs/run_apply",
    ]);
    expect(
      requests.every(
        ({ request }) =>
          request.headers.get("authorization") === "Bearer session-bearer",
      ),
    ).toEqual(true);
    expect(JSON.parse(requests[2]!.body)).toMatchObject({
      spaceId: "space_me",
      name: "my-app",
      snapshotId: "snap_upload",
      autoApprove: true,
    });
    expect(stdout.join("\n")).toContain("uploading");
    expect(stdout.join("\n")).toContain("to @me");
  } finally {
    globalThis.fetch = originalFetch;
    await removePath(capsuleDir, { recursive: true });
  }
});

test("deploy keeps raw space ids without handle resolution", async () => {
  const capsuleDir = await makeTempDir();
  await writeTextFile(pathJoin(capsuleDir, "main.tf"), "terraform {}\n");
  const stdout: string[] = [];
  const stderr: string[] = [];
  const requests: Array<{ request: Request; body: string }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const request = new Request(input, init);
    const body =
      request.headers.get("content-type") === "application/json"
        ? await request.clone().text()
        : "<binary>";
    requests.push({ request, body });
    const url = new URL(request.url);
    if (
      request.method === "POST" &&
      url.pathname === "/api/v1/spaces/space_direct/uploads"
    ) {
      return Response.json({
        snapshot: {
          id: "snap_direct",
          archiveDigest: "sha256:def",
          archiveSizeBytes: 123,
        },
      });
    }
    if (request.method === "POST" && url.pathname === "/api/v1/deploy") {
      return Response.json({
        installation: { id: "inst_1", name: "app" },
        run: { id: "run_plan", status: "succeeded", type: "plan" },
        created: false,
      });
    }
    if (request.method === "GET" && url.pathname === "/api/v1/runs/run_plan") {
      return Response.json({
        id: "run_plan",
        status: "waiting_approval",
        type: "plan",
      });
    }
    return Response.json(
      { error: { message: "unexpected request" } },
      { status: 404 },
    );
  }) as typeof fetch;

  try {
    const code = await main(
      [
        "plan",
        capsuleDir,
        "--space=space_direct",
        "--url=https://app.takosumi.test",
        "--token=session-bearer",
      ],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
    );

    expect(code).toEqual(0);
    expect(stderr).toEqual([]);
    expect(
      requests.map(
        ({ request }) => `${request.method} ${new URL(request.url).pathname}`,
      ),
    ).toEqual([
      "POST /api/v1/spaces/space_direct/uploads",
      "POST /api/v1/deploy",
      "GET /api/v1/runs/run_plan",
    ]);
    expect(JSON.parse(requests[1]!.body)).toMatchObject({
      spaceId: "space_direct",
      name: "app",
      snapshotId: "snap_direct",
      planOnly: true,
    });
  } finally {
    globalThis.fetch = originalFetch;
    await removePath(capsuleDir, { recursive: true });
  }
});

test("connections provider-envs is hidden from the normal CLI surface", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];

  const code = await main(["connections", "provider-envs"], {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
  });

  expect(code).toEqual(2);
  expect(stdout).toEqual([]);
  expect(stderr.join("\n")).toContain(
    "Unknown connections command: provider-envs",
  );
  expect(stderr.join("\n")).not.toContain("gateway|oauth|secret");
});

test("platform-secrets status compares local vault with remote names", async () => {
  const dir = await makeTempDir();
  await writeTextFile(
    pathJoin(dir, "TAKOSUMI_DEPLOY_CONTROL_TOKEN"),
    "secret-one",
  );
  await writeTextFile(
    pathJoin(dir, "TAKOSUMI_SECRET_STORE_PASSPHRASE"),
    "secret-two",
  );
  await writeTextFile(pathJoin(dir, ".gitignore"), "*");
  const stdout: string[] = [];
  const stderr: string[] = [];
  const commands: string[][] = [];

  try {
    const code = await runPlatformSecrets(
      ["status", "--config", "/operator/wrangler.toml", "--secrets-dir", dir],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
      async (args) => {
        commands.push([...args]);
        return {
          code: 0,
          stdout: JSON.stringify([
            { name: "TAKOSUMI_DEPLOY_CONTROL_TOKEN", type: "secret_text" },
            { name: "REMOTE_ONLY_SECRET", type: "secret_text" },
          ]),
          stderr: "",
        };
      },
    );

    expect(code).toEqual(1);
    expect(stderr).toEqual([]);
    expect(commands).toEqual([
      [
        "bunx",
        "wrangler",
        "secret",
        "list",
        "--config",
        "/operator/wrangler.toml",
      ],
    ]);
    const output = stdout.join("\n");
    expect(output).toContain("Local secrets: 2");
    expect(output).toContain("Remote secrets: 2");
    expect(output).toContain(
      "Generated present: TAKOSUMI_DEPLOY_CONTROL_TOKEN",
    );
    expect(output).toContain(
      "Protected present: TAKOSUMI_SECRET_STORE_PASSPHRASE",
    );
    expect(output).toContain(
      "Missing generated: TAKOSUMI_ACCOUNTS_EXPORT_DOWNLOAD_SECRET",
    );
    expect(output).toContain("TAKOSUMI_ACCOUNTS_PRIVACY_OPERATIONS_TOKEN");
    expect(output).toContain("Missing required manual: none");
    expect(output).toContain("AI Gateway profiles: none");
    expect(output).toContain("AI Gateway OpenAI-compatible profiles: 0");
    expect(output).toContain("AI Gateway missing credential secrets: none");
    expect(output).toContain("Remote only: REMOTE_ONLY_SECRET");
    expect(output).not.toContain("secret-one");
    expect(output).not.toContain("secret-two");
  } finally {
    await removePath(dir, { recursive: true });
  }
});

test("platform-secrets status infers sibling takosumi-private defaults", async () => {
  const root = await makeTempDir();
  const appDir = pathJoin(root, "takosumi");
  const privateDir = pathJoin(root, "takosumi-private");
  const secretsDir = pathJoin(privateDir, ".secrets", "production");
  await Bun.$`mkdir -p ${appDir} ${pathJoin(privateDir, "platform")} ${secretsDir}`.quiet();
  await writeTextFile(
    pathJoin(privateDir, "platform", "wrangler.toml"),
    'name = "takosumi"\n',
  );
  await writeTextFile(
    pathJoin(secretsDir, "TAKOSUMI_DEPLOY_CONTROL_TOKEN"),
    "secret-one",
  );
  const previousCwd = process.cwd();
  const stdout: string[] = [];
  const stderr: string[] = [];
  const commands: string[][] = [];

  try {
    process.chdir(appDir);
    const code = await runPlatformSecrets(
      ["status"],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
      async (args) => {
        commands.push([...args]);
        return { code: 0, stdout: "[]", stderr: "" };
      },
    );

    expect(code).toEqual(1);
    expect(stderr).toEqual([]);
    expect(commands).toEqual([
      [
        "bunx",
        "wrangler",
        "secret",
        "list",
        "--config",
        pathJoin(privateDir, "platform", "wrangler.toml"),
      ],
    ]);
    expect(stdout.join("\n")).toContain(
      "Generated present: TAKOSUMI_DEPLOY_CONTROL_TOKEN",
    );
  } finally {
    process.chdir(previousCwd);
    await removePath(root, { recursive: true });
  }
});

test("platform-secrets status requires AI Gateway profile apiKeyEnv secrets", async () => {
  const dir = await makeTempDir();
  const config = await makeTempFile({ suffix: ".toml" });
  await writeTextFile(
    config,
    [
      "[vars]",
      'TAKOSUMI_AI_GATEWAY_PROFILES = \'[{"id":"deepseek","provider":"deepseek","baseUrl":"https://api.deepseek.example/v1","apiKeyEnv":"TAKOSUMI_AI_GATEWAY_DEEPSEEK_API_KEY","models":[{"publicModel":"deepseek/chat","upstreamModel":"deepseek-chat","endpoints":["chat.completions"]}]}]\'',
    ].join("\n"),
  );
  await writeTextFile(
    pathJoin(dir, "TAKOSUMI_AI_GATEWAY_DEEPSEEK_API_KEY"),
    "deepseek-token",
  );
  const stdout: string[] = [];
  const stderr: string[] = [];

  try {
    const code = await runPlatformSecrets(
      ["status", "--config", config, "--secrets-dir", dir],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
      async () => ({ code: 0, stdout: "[]", stderr: "" }),
    );

    expect(code).toEqual(1);
    expect(stderr).toEqual([]);
    const output = stdout.join("\n");
    expect(output).toContain(
      "Required manual present: TAKOSUMI_AI_GATEWAY_DEEPSEEK_API_KEY",
    );
    expect(output).toContain("Missing required manual: none");
    expect(output).toContain("AI Gateway profiles: 1");
    expect(output).toContain("AI Gateway providers: deepseek");
    expect(output).toContain("AI Gateway OpenAI-compatible profiles: 1");
    expect(output).toContain(
      "AI Gateway required credential secrets: TAKOSUMI_AI_GATEWAY_DEEPSEEK_API_KEY",
    );
    expect(output).toContain("AI Gateway missing credential secrets: none");
    expect(output).not.toContain("deepseek-token");
  } finally {
    await removePath(dir, { recursive: true });
    await removePath(config);
  }
});

test("platform-secrets status accepts Cloudflare Unified Billing API token profiles", async () => {
  const dir = await makeTempDir();
  const config = await makeTempFile({ suffix: ".toml" });
  await writeTextFile(
    config,
    [
      "[vars]",
      "TAKOSUMI_AI_GATEWAY_PROFILES = '''",
      "[",
      '  {"id":"cloudflare-unified","provider":"cloudflare_unified_billing","baseUrl":"https://api.cloudflare.com/client/v4/accounts/account_123/ai/v1","apiKeyEnv":"TAKOSUMI_AI_GATEWAY_CLOUDFLARE_API_TOKEN","headers":{"cf-aig-gateway-id":"default"},"models":[{"publicModel":"takosumi/default","upstreamModel":"openai/gpt-4.1-mini","endpoints":["chat.completions"],"default":true,"billingClass":"operator-paid-preview"}]}',
      "]",
      "'''",
    ].join("\n"),
  );
  await writeTextFile(
    pathJoin(dir, "TAKOSUMI_AI_GATEWAY_CLOUDFLARE_API_TOKEN"),
    "cf-token",
  );
  const stdout: string[] = [];
  const stderr: string[] = [];

  try {
    const code = await runPlatformSecrets(
      ["status", "--config", config, "--secrets-dir", dir],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
      async () => ({ code: 0, stdout: "[]", stderr: "" }),
    );

    expect(code).toEqual(1);
    expect(stderr).toEqual([]);
    const output = stdout.join("\n");
    expect(output).toContain(
      "Required manual present: TAKOSUMI_AI_GATEWAY_CLOUDFLARE_API_TOKEN",
    );
    expect(output).toContain("Missing required manual: none");
    expect(output).toContain("AI Gateway profiles: 1");
    expect(output).toContain(
      "AI Gateway providers: cloudflare_unified_billing",
    );
    expect(output).toContain("AI Gateway OpenAI-compatible profiles: 1");
    expect(output).toContain(
      "AI Gateway required credential secrets: TAKOSUMI_AI_GATEWAY_CLOUDFLARE_API_TOKEN",
    );
    expect(output).toContain("AI Gateway missing credential secrets: none");
    expect(output).not.toContain("cf-token");
  } finally {
    await removePath(dir, { recursive: true });
    await removePath(config);
  }
});

test("platform-secrets status requires configured upstream OAuth client secret", async () => {
  const dir = await makeTempDir();
  const config = await makeTempFile({ suffix: ".toml" });
  await writeTextFile(
    config,
    [
      "[vars]",
      'TAKOSUMI_ACCOUNTS_UPSTREAM_GOOGLE_CLIENT_ID = "google-client"',
      'TAKOSUMI_ACCOUNTS_UPSTREAM_GOOGLE_REDIRECT_URI = "https://app.takosumi.com/sign-in/callback"',
    ].join("\n"),
  );
  const stdout: string[] = [];
  const stderr: string[] = [];

  try {
    const code = await runPlatformSecrets(
      ["status", "--config", config, "--secrets-dir", dir],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
      async () => ({ code: 0, stdout: "[]", stderr: "" }),
    );

    expect(code).toEqual(1);
    expect(stderr).toEqual([]);
    const output = stdout.join("\n");
    expect(output).toContain(
      "Missing required manual: TAKOSUMI_ACCOUNTS_UPSTREAM_GOOGLE_CLIENT_SECRET",
    );
    expect(output).toContain("Manual present: none");
  } finally {
    await removePath(dir, { recursive: true });
    await removePath(config);
  }
});

test("platform-secrets status requires Stripe secrets when billing is configured", async () => {
  const dir = await makeTempDir();
  const config = await makeTempFile({ suffix: ".toml" });
  await writeTextFile(
    config,
    [
      "[vars]",
      "TAKOSUMI_BILLING_PLANS = '''",
      '[{"id":"starter","name":"Starter","stripePriceId":"price_starter","includedCredits":1000}]',
      "'''",
      'TAKOSUMI_ACCOUNTS_BILLING_REDIRECT_ALLOWLIST = "https://app.takosumi.com"',
    ].join("\n"),
  );
  const stdout: string[] = [];
  const stderr: string[] = [];

  try {
    const code = await runPlatformSecrets(
      ["status", "--config", config, "--secrets-dir", dir],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
      async () => ({ code: 0, stdout: "[]", stderr: "" }),
    );

    expect(code).toEqual(1);
    expect(stderr).toEqual([]);
    const output = stdout.join("\n");
    expect(output).toContain("TAKOSUMI_ACCOUNTS_STRIPE_SECRET_KEY");
    expect(output).toContain("TAKOSUMI_ACCOUNTS_STRIPE_WEBHOOK_SECRET");
    expect(output).toContain("Manual present: none");
  } finally {
    await removePath(dir, { recursive: true });
    await removePath(config);
  }
});

test("platform-secrets status reads multiline AI Gateway profiles from wrangler vars", async () => {
  const dir = await makeTempDir();
  const config = await makeTempFile({ suffix: ".toml" });
  await writeTextFile(
    config,
    [
      "[vars]",
      "TAKOSUMI_AI_GATEWAY_PROFILES = '''",
      "[",
      '  {"id":"deepseek","provider":"deepseek","baseUrl":"https://api.deepseek.example/v1","apiKeyEnv":"TAKOSUMI_AI_GATEWAY_DEEPSEEK_API_KEY","models":[{"publicModel":"deepseek/chat","upstreamModel":"deepseek-chat","endpoints":["chat.completions"]}]}',
      "]",
      "'''",
    ].join("\n"),
  );
  const stdout: string[] = [];
  const stderr: string[] = [];

  try {
    const code = await runPlatformSecrets(
      ["status", "--config", config, "--secrets-dir", dir],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
      async () => ({ code: 0, stdout: "[]", stderr: "" }),
    );

    expect(code).toEqual(1);
    expect(stderr).toEqual([]);
    const output = stdout.join("\n");
    expect(output).toContain(
      "Missing required manual: TAKOSUMI_AI_GATEWAY_DEEPSEEK_API_KEY",
    );
    expect(output).toContain("AI Gateway profiles: 1");
    expect(output).toContain(
      "AI Gateway missing credential secrets: TAKOSUMI_AI_GATEWAY_DEEPSEEK_API_KEY",
    );
  } finally {
    await removePath(dir, { recursive: true });
    await removePath(config);
  }
});

test("platform-secrets status accepts Workers AI binding profiles without manual upstream secrets", async () => {
  const dir = await makeTempDir();
  const config = await makeTempFile({ suffix: ".toml" });
  await writeTextFile(
    config,
    [
      "[vars]",
      "TAKOSUMI_AI_GATEWAY_PROFILES = '''",
      "[",
      '  {"type":"workers_ai_binding","id":"workers-ai","provider":"workers_ai","models":[{"publicModel":"workers-ai/llama-3.1-8b-instruct-fast","upstreamModel":"@cf/meta/llama-3.1-8b-instruct-fast","endpoints":["chat.completions"],"default":true}]}',
      "]",
      "'''",
    ].join("\n"),
  );
  const stdout: string[] = [];
  const stderr: string[] = [];

  try {
    const code = await runPlatformSecrets(
      ["status", "--config", config, "--secrets-dir", dir],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
      async () => ({ code: 0, stdout: "[]", stderr: "" }),
    );

    expect(code).toEqual(1);
    expect(stderr).toEqual([]);
    const output = stdout.join("\n");
    expect(output).toContain("Missing required manual: none");
    expect(output).toContain("AI Gateway profiles: 1");
    expect(output).toContain("AI Gateway providers: workers_ai");
    expect(output).toContain("AI Gateway OpenAI-compatible profiles: 0");
    expect(output).toContain("AI Gateway Workers AI profiles: 1");
    expect(output).toContain("AI Gateway required credential secrets: none");
    expect(output).not.toContain("TAKOSUMI_AI_GATEWAY_DEEPSEEK_API_KEY");
  } finally {
    await removePath(dir, { recursive: true });
    await removePath(config);
  }
});

test("platform-secrets status rejects Workers AI binding profiles with upstream secret fields", async () => {
  const dir = await makeTempDir();
  const config = await makeTempFile({ suffix: ".toml" });
  await writeTextFile(
    config,
    [
      "[vars]",
      'TAKOSUMI_AI_GATEWAY_PROFILES = \'[{"type":"workers_ai_binding","id":"workers-ai","provider":"workers_ai","apiKeyEnv":"TAKOSUMI_AI_GATEWAY_UNSAFE_API_KEY","models":[{"publicModel":"workers-ai/chat","upstreamModel":"@cf/meta/llama-3.1-8b-instruct-fast","endpoints":["chat.completions"]}]}]\'',
    ].join("\n"),
  );
  const stdout: string[] = [];
  const stderr: string[] = [];

  try {
    const code = await runPlatformSecrets(
      ["status", "--config", config, "--secrets-dir", dir],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
      async () => ({ code: 0, stdout: "[]", stderr: "" }),
    );

    expect(code).toEqual(1);
    expect(stdout).toEqual([]);
    expect(stderr.join("\n")).toContain("must not define apiKeyEnv");
  } finally {
    await removePath(dir, { recursive: true });
    await removePath(config);
  }
});

test("platform-secrets status rejects AI Gateway static secret headers", async () => {
  const dir = await makeTempDir();
  const config = await makeTempFile({ suffix: ".toml" });
  await writeTextFile(
    config,
    [
      "[vars]",
      'TAKOSUMI_AI_GATEWAY_PROFILES = \'[{"id":"unsafe","provider":"openai_compatible","baseUrl":"https://api.example.test/v1","apiKeyEnv":"TAKOSUMI_AI_GATEWAY_UNSAFE_API_KEY","headers":{"x-api-key":"must-not-be-here"},"models":[{"publicModel":"unsafe/chat","upstreamModel":"unsafe-chat","endpoints":["chat.completions"]}]}]\'',
    ].join("\n"),
  );
  const stdout: string[] = [];
  const stderr: string[] = [];

  try {
    const code = await runPlatformSecrets(
      ["status", "--config", config, "--secrets-dir", dir],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
      async () => ({ code: 0, stdout: "[]", stderr: "" }),
    );

    expect(code).toEqual(1);
    expect(stdout).toEqual([]);
    expect(stderr.join("\n")).toContain("may carry secrets");
  } finally {
    await removePath(dir, { recursive: true });
    await removePath(config);
  }
});

test("platform-secrets status rejects AI Gateway static secret header values", async () => {
  const dir = await makeTempDir();
  const config = await makeTempFile({ suffix: ".toml" });
  await writeTextFile(
    config,
    [
      "[vars]",
      'TAKOSUMI_AI_GATEWAY_PROFILES = \'[{"id":"unsafe","provider":"openai_compatible","baseUrl":"https://api.example.test/v1","apiKeyEnv":"TAKOSUMI_AI_GATEWAY_UNSAFE_API_KEY","headers":{"x-provider-metadata":"Authorization: Bearer static"},"models":[{"publicModel":"unsafe/chat","upstreamModel":"unsafe-chat","endpoints":["chat.completions"]}]}]\'',
    ].join("\n"),
  );
  const stdout: string[] = [];
  const stderr: string[] = [];

  try {
    const code = await runPlatformSecrets(
      ["status", "--config", config, "--secrets-dir", dir],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
      async () => ({ code: 0, stdout: "[]", stderr: "" }),
    );

    expect(code).toEqual(1);
    expect(stdout).toEqual([]);
    expect(stderr.join("\n")).toContain("value may carry secrets");
  } finally {
    await removePath(dir, { recursive: true });
    await removePath(config);
  }
});

test("platform-secrets status rejects AI Gateway public metadata secrets", async () => {
  const dir = await makeTempDir();
  const config = await makeTempFile({ suffix: ".toml" });
  await writeTextFile(
    config,
    [
      "[vars]",
      'TAKOSUMI_AI_GATEWAY_PROFILES = \'[{"id":"unsafe","provider":"openai_compatible","baseUrl":"https://api.example.test/v1","apiKeyEnv":"TAKOSUMI_AI_GATEWAY_UNSAFE_API_KEY","models":[{"publicModel":"unsafe/chat","upstreamModel":"unsafe-chat","endpoints":["chat.completions"],"metadata":{"apiKey":"must-not-be-public","notes":["Authorization: Bearer metadata-token"]}}]}]\'',
    ].join("\n"),
  );
  const stdout: string[] = [];
  const stderr: string[] = [];

  try {
    const code = await runPlatformSecrets(
      ["status", "--config", config, "--secrets-dir", dir],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
      async () => ({ code: 0, stdout: "[]", stderr: "" }),
    );

    expect(code).toEqual(1);
    expect(stdout).toEqual([]);
    expect(stderr.join("\n")).toContain(
      "AI Gateway profile unsafe.models[0].metadata.apiKey may carry secrets",
    );
  } finally {
    await removePath(dir, { recursive: true });
    await removePath(config);
  }
});

test("platform-secrets status rejects AI Gateway token-shaped metadata values", async () => {
  const dir = await makeTempDir();
  const config = await makeTempFile({ suffix: ".toml" });
  await writeTextFile(
    config,
    [
      "[vars]",
      'TAKOSUMI_AI_GATEWAY_PROFILES = \'[{"id":"unsafe","provider":"openai_compatible","baseUrl":"https://api.example.test/v1","apiKeyEnv":"TAKOSUMI_AI_GATEWAY_UNSAFE_API_KEY","models":[{"publicModel":"unsafe/chat","upstreamModel":"unsafe-chat","endpoints":["chat.completions"],"metadata":{"notes":["Authorization: Bearer metadata-token"]}}]}]\'',
    ].join("\n"),
  );
  const stdout: string[] = [];
  const stderr: string[] = [];

  try {
    const code = await runPlatformSecrets(
      ["status", "--config", config, "--secrets-dir", dir],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
      async () => ({ code: 0, stdout: "[]", stderr: "" }),
    );

    expect(code).toEqual(1);
    expect(stdout).toEqual([]);
    expect(stderr.join("\n")).toContain(
      "AI Gateway profile unsafe.models[0].metadata.notes[0] may carry secrets",
    );
  } finally {
    await removePath(dir, { recursive: true });
    await removePath(config);
  }
});

test("platform-secrets apply generates missing safe secrets and pushes value files", async () => {
  const dir = await makeTempDir();
  await writeTextFile(
    pathJoin(dir, "TAKOSUMI_SECRET_STORE_PASSPHRASE"),
    "protected-key",
  );
  const stdout: string[] = [];
  const stderr: string[] = [];
  const commands: string[][] = [];
  const stdinByName = new Map<string, string | undefined>();

  try {
    const code = await runPlatformSecrets(
      ["apply", "--config", "/operator/wrangler.toml", "--secrets-dir", dir],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
      async (args, input) => {
        commands.push([...args]);
        stdinByName.set(args[4] ?? "", input);
        return { code: 0, stdout: "ok", stderr: "" };
      },
    );

    expect(code).toEqual(0);
    expect(stderr).toEqual([]);
    const pushedNames = commands.map((command) => command[4]).sort();
    expect(pushedNames).toEqual([
      "TAKOSUMI_ACCOUNTS_EXPORT_DOWNLOAD_SECRET",
      "TAKOSUMI_ACCOUNTS_PRIVACY_OPERATIONS_TOKEN",
      "TAKOSUMI_CONNECTION_OAUTH_STATE_SECRET",
      "TAKOSUMI_DEPLOY_CONTROL_TOKEN",
      "TAKOSUMI_SECRET_STORE_PASSPHRASE",
    ]);
    for (const command of commands) {
      expect(command.slice(0, 4)).toEqual([
        "bunx",
        "wrangler",
        "secret",
        "put",
      ]);
      expect(command.slice(5, 7)).toEqual([
        "--config",
        "/operator/wrangler.toml",
      ]);
      expect(command).not.toContain("--value-file");
      expect(command).not.toContain(pathJoin(dir, command[4]!));
    }
    const generated = await readFile(
      pathJoin(dir, "TAKOSUMI_DEPLOY_CONTROL_TOKEN"),
      "utf8",
    );
    expect(stdinByName.get("TAKOSUMI_SECRET_STORE_PASSPHRASE")).toEqual(
      "protected-key",
    );
    expect(stdinByName.get("TAKOSUMI_DEPLOY_CONTROL_TOKEN")).toEqual(generated);
    expect(generated.trim().length).toBeGreaterThan(40);
    expect(
      (await stat(pathJoin(dir, "TAKOSUMI_DEPLOY_CONTROL_TOKEN"))).mode & 0o777,
    ).toEqual(0o600);
    const output = stdout.concat(stderr).join("\n");
    expect(output).toContain("Generated: TAKOSUMI_DEPLOY_CONTROL_TOKEN");
    expect(output).toContain("Pushed 5 platform secret(s)");
    expect(output).not.toContain("protected-key");
    expect(output).not.toContain(generated.trim());
  } finally {
    await removePath(dir, { recursive: true });
  }
});

test("platform-secrets apply pushes optional metrics scrape token when present", async () => {
  const dir = await makeTempDir();
  await writeTextFile(
    pathJoin(dir, "TAKOSUMI_SECRET_STORE_PASSPHRASE"),
    "protected-key",
  );
  await writeTextFile(
    pathJoin(dir, "TAKOSUMI_METRICS_SCRAPE_TOKEN"),
    "metrics-token",
  );
  const stdout: string[] = [];
  const stderr: string[] = [];
  const commands: string[][] = [];
  const stdinByName = new Map<string, string | undefined>();

  try {
    const code = await runPlatformSecrets(
      ["apply", "--config", "/operator/wrangler.toml", "--secrets-dir", dir],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
      async (args, input) => {
        commands.push([...args]);
        stdinByName.set(args[4] ?? "", input);
        return { code: 0, stdout: "ok", stderr: "" };
      },
    );

    expect(code).toEqual(0);
    expect(stderr).toEqual([]);
    const pushedNames = commands.map((command) => command[4]).sort();
    expect(pushedNames).toEqual([
      "TAKOSUMI_ACCOUNTS_EXPORT_DOWNLOAD_SECRET",
      "TAKOSUMI_ACCOUNTS_PRIVACY_OPERATIONS_TOKEN",
      "TAKOSUMI_CONNECTION_OAUTH_STATE_SECRET",
      "TAKOSUMI_DEPLOY_CONTROL_TOKEN",
      "TAKOSUMI_METRICS_SCRAPE_TOKEN",
      "TAKOSUMI_SECRET_STORE_PASSPHRASE",
    ]);
    expect(stdinByName.get("TAKOSUMI_METRICS_SCRAPE_TOKEN")).toEqual(
      "metrics-token",
    );
    const output = stdout.concat(stderr).join("\n");
    expect(output).toContain("Pushed 6 platform secret(s)");
    expect(output).not.toContain("metrics-token");
  } finally {
    await removePath(dir, { recursive: true });
  }
});

test("platform-secrets apply fails when configured upstream OAuth client secret is missing", async () => {
  const dir = await makeTempDir();
  const config = await makeTempFile({ suffix: ".toml" });
  await writeTextFile(
    config,
    [
      "[vars]",
      'TAKOSUMI_ACCOUNTS_UPSTREAM_GOOGLE_CLIENT_ID = "google-client"',
      'TAKOSUMI_ACCOUNTS_UPSTREAM_GOOGLE_REDIRECT_URI = "https://app.takosumi.com/sign-in/callback"',
    ].join("\n"),
  );
  await writeTextFile(
    pathJoin(dir, "TAKOSUMI_SECRET_STORE_PASSPHRASE"),
    "protected-key",
  );
  const stdout: string[] = [];
  const stderr: string[] = [];
  const commands: string[][] = [];

  try {
    const code = await runPlatformSecrets(
      ["apply", "--config", config, "--secrets-dir", dir, "--dry-run"],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
      async (args) => {
        commands.push([...args]);
        return { code: 0, stdout: "ok", stderr: "" };
      },
    );

    expect(code).toEqual(2);
    expect(stdout).toEqual([]);
    expect(stderr.join("\n")).toContain(
      "missing required manual platform secret(s): TAKOSUMI_ACCOUNTS_UPSTREAM_GOOGLE_CLIENT_SECRET",
    );
    expect(commands).toEqual([]);
  } finally {
    await removePath(dir, { recursive: true });
    await removePath(config);
  }
});

test("platform-secrets apply fails when configured Cloud extension client secret is missing", async () => {
  const dir = await makeTempDir();
  const config = await makeTempFile({ suffix: ".toml" });
  await writeTextFile(
    config,
    [
      "[vars]",
      'TAKOSUMI_ACCOUNTS_CLIENT_ID = "takosumi-cloud-extensions"',
      'TAKOSUMI_ACCOUNTS_CLIENT_SERVICE_GRAPH_TOKEN_INTROSPECTION = "enabled"',
    ].join("\n"),
  );
  await writeTextFile(
    pathJoin(dir, "TAKOSUMI_SECRET_STORE_PASSPHRASE"),
    "protected-key",
  );
  const stdout: string[] = [];
  const stderr: string[] = [];
  const commands: string[][] = [];

  try {
    const code = await runPlatformSecrets(
      ["apply", "--config", config, "--secrets-dir", dir, "--dry-run"],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
      async (args) => {
        commands.push([...args]);
        return { code: 0, stdout: "ok", stderr: "" };
      },
    );

    expect(code).toEqual(2);
    expect(stdout).toEqual([]);
    expect(stderr.join("\n")).toContain(
      "missing required manual platform secret(s): TAKOSUMI_ACCOUNTS_CLIENT_SECRET",
    );
    expect(commands).toEqual([]);
  } finally {
    await removePath(dir, { recursive: true });
    await removePath(config);
  }
});

test("platform-secrets apply pushes Cloud extension confidential client secret when configured", async () => {
  const dir = await makeTempDir();
  const config = await makeTempFile({ suffix: ".toml" });
  await writeTextFile(
    config,
    [
      "[vars]",
      'TAKOSUMI_ACCOUNTS_CLIENT_ID = "takosumi-cloud-extensions"',
      'TAKOSUMI_ACCOUNTS_CLIENT_SERVICE_GRAPH_TOKEN_INTROSPECTION = "enabled"',
    ].join("\n"),
  );
  await writeTextFile(
    pathJoin(dir, "TAKOSUMI_SECRET_STORE_PASSPHRASE"),
    "protected-key",
  );
  await writeTextFile(
    pathJoin(dir, "TAKOSUMI_ACCOUNTS_CLIENT_SECRET"),
    "cloud-extension-client-secret",
  );
  const stdout: string[] = [];
  const stderr: string[] = [];
  const commands: string[][] = [];
  const stdinByName = new Map<string, string | undefined>();

  try {
    const code = await runPlatformSecrets(
      ["apply", "--config", config, "--secrets-dir", dir],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
      async (args, input) => {
        commands.push([...args]);
        stdinByName.set(args[4] ?? "", input);
        return { code: 0, stdout: "ok", stderr: "" };
      },
    );

    expect(code).toEqual(0);
    expect(stderr).toEqual([]);
    const pushedNames = commands.map((command) => command[4]).sort();
    expect(pushedNames).toContain("TAKOSUMI_ACCOUNTS_CLIENT_SECRET");
    expect(stdinByName.get("TAKOSUMI_ACCOUNTS_CLIENT_SECRET")).toEqual(
      "cloud-extension-client-secret",
    );
    const output = stdout.concat(stderr).join("\n");
    expect(output).toContain("Pushed 6 platform secret(s)");
    expect(output).not.toContain("cloud-extension-client-secret");
  } finally {
    await removePath(dir, { recursive: true });
    await removePath(config);
  }
});

test("platform-secrets apply fails when configured billing Stripe secrets are missing", async () => {
  const dir = await makeTempDir();
  const config = await makeTempFile({ suffix: ".toml" });
  await writeTextFile(
    config,
    [
      "[vars]",
      "TAKOSUMI_BILLING_PLANS = '''",
      '[{"id":"starter","name":"Starter","stripePriceId":"price_starter","includedCredits":1000}]',
      "'''",
      'TAKOSUMI_ACCOUNTS_BILLING_REDIRECT_ALLOWLIST = "https://app.takosumi.com"',
    ].join("\n"),
  );
  await writeTextFile(
    pathJoin(dir, "TAKOSUMI_SECRET_STORE_PASSPHRASE"),
    "protected-key",
  );
  const stdout: string[] = [];
  const stderr: string[] = [];
  const commands: string[][] = [];

  try {
    const code = await runPlatformSecrets(
      ["apply", "--config", config, "--secrets-dir", dir, "--dry-run"],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
      async (args) => {
        commands.push([...args]);
        return { code: 0, stdout: "ok", stderr: "" };
      },
    );

    expect(code).toEqual(2);
    expect(stdout).toEqual([]);
    expect(stderr.join("\n")).toContain("TAKOSUMI_ACCOUNTS_STRIPE_SECRET_KEY");
    expect(stderr.join("\n")).toContain(
      "TAKOSUMI_ACCOUNTS_STRIPE_WEBHOOK_SECRET",
    );
    expect(commands).toEqual([]);
  } finally {
    await removePath(dir, { recursive: true });
    await removePath(config);
  }
});

test("platform-secrets apply can explicitly initialize missing protected secrets", async () => {
  const dir = await makeTempDir();
  const stdout: string[] = [];
  const stderr: string[] = [];
  const commands: string[][] = [];
  const stdinByName = new Map<string, string | undefined>();

  try {
    const code = await runPlatformSecrets(
      [
        "apply",
        "--config",
        "/operator/wrangler.toml",
        "--secrets-dir",
        dir,
        "--init-protected",
      ],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
      async (args, input) => {
        commands.push([...args]);
        stdinByName.set(args[4] ?? "", input);
        return { code: 0, stdout: "ok", stderr: "" };
      },
    );

    expect(code).toEqual(0);
    expect(stderr).toEqual([]);
    const pushedNames = commands.map((command) => command[4]).sort();
    expect(pushedNames).toEqual([
      "TAKOSUMI_ACCOUNTS_ES256_KEY_ID",
      "TAKOSUMI_ACCOUNTS_ES256_PRIVATE_JWK",
      "TAKOSUMI_ACCOUNTS_EXPORT_DOWNLOAD_SECRET",
      "TAKOSUMI_ACCOUNTS_LAUNCH_TOKEN_PAIRWISE_SECRET",
      "TAKOSUMI_ACCOUNTS_OIDC_PAIRWISE_SUBJECT_SECRET",
      "TAKOSUMI_ACCOUNTS_PRIVACY_OPERATIONS_TOKEN",
      "TAKOSUMI_ACCOUNTS_SUBJECT_SECRET",
      "TAKOSUMI_ACCOUNT_SESSION_HASH_SALT",
      "TAKOSUMI_CONNECTION_OAUTH_STATE_SECRET",
      "TAKOSUMI_DEPLOY_CONTROL_TOKEN",
      "TAKOSUMI_SECRET_STORE_PASSPHRASE",
    ]);
    const privateJwkRaw = await readFile(
      pathJoin(dir, "TAKOSUMI_ACCOUNTS_ES256_PRIVATE_JWK"),
      "utf8",
    );
    const privateJwk = JSON.parse(privateJwkRaw);
    expect(privateJwk.kty).toEqual("EC");
    expect(privateJwk.crv).toEqual("P-256");
    expect(typeof privateJwk.d).toEqual("string");
    expect(typeof privateJwk.x).toEqual("string");
    expect(typeof privateJwk.y).toEqual("string");
    for (const name of pushedNames) {
      expect((await stat(pathJoin(dir, name))).mode & 0o777).toEqual(0o600);
      expect(stdinByName.get(name)).toEqual(
        await readFile(pathJoin(dir, name), "utf8"),
      );
    }
    const output = stdout.join("\n");
    expect(output).toContain("Generated: TAKOSUMI_ACCOUNTS_ES256_PRIVATE_JWK");
    expect(output).toContain("Pushed 11 platform secret(s)");
    expect(output).not.toContain(privateJwk.d);
  } finally {
    await removePath(dir, { recursive: true });
  }
});

test("platform-secrets apply local-only initializes the vault without wrangler", async () => {
  const dir = await makeTempDir();
  const config = await makeTempFile({ suffix: ".toml" });
  await writeTextFile(config, 'name = "test-platform"\n');
  const stdout: string[] = [];
  const stderr: string[] = [];
  const commands: string[][] = [];

  try {
    const code = await runPlatformSecrets(
      [
        "apply",
        "--config",
        config,
        "--secrets-dir",
        dir,
        "--init-protected",
        "--local-only",
      ],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
      async (args) => {
        commands.push([...args]);
        return { code: 0, stdout: "ok", stderr: "" };
      },
    );

    expect(code).toEqual(0);
    expect(stderr).toEqual([]);
    expect(commands).toEqual([]);
    expect(
      await pathExists(pathJoin(dir, "TAKOSUMI_ACCOUNTS_ES256_PRIVATE_JWK")),
    ).toEqual(true);
    expect(
      await pathExists(pathJoin(dir, "TAKOSUMI_DEPLOY_CONTROL_TOKEN")),
    ).toEqual(true);
    expect(stdout.join("\n")).toContain("Initialized local vault with 11");
  } finally {
    await removePath(dir, { recursive: true });
    await removePath(config);
  }
});

test("platform-secrets apply rejects protected key regeneration", async () => {
  const dir = await makeTempDir();
  const stdout: string[] = [];
  const stderr: string[] = [];
  const commands: string[][] = [];

  try {
    const code = await runPlatformSecrets(
      [
        "apply",
        "--config",
        "/operator/wrangler.toml",
        "--secrets-dir",
        dir,
        "--regenerate",
        "TAKOSUMI_SECRET_STORE_PASSPHRASE",
      ],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
      async (args) => {
        commands.push([...args]);
        return { code: 0, stdout: "ok", stderr: "" };
      },
    );

    expect(code).toEqual(2);
    expect(stdout).toEqual([]);
    expect(commands).toEqual([]);
    expect(stderr.join("\n")).toContain(
      "TAKOSUMI_SECRET_STORE_PASSPHRASE is protected_key",
    );
  } finally {
    await removePath(dir, { recursive: true });
  }
});

test("platform-secrets legacy low-level commands are hidden and rejected", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await runPlatformSecrets(
    ["sync"],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    },
    async () => {
      throw new Error("wrangler must not be called");
    },
  );

  expect(code).toEqual(2);
  expect(stdout).toEqual([]);
  expect(stderr.join("\n")).toContain("Unknown platform-secrets command: sync");
  expect(stderr.join("\n")).toContain("status");
  expect(stderr.join("\n")).toContain("apply");
  expect(stderr.join("\n")).not.toContain("put <secret-name>");
});
