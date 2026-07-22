import { expect, test } from "bun:test";
import { assert, assertEquals, assertRejects } from "../../helpers/assert.ts";
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
import { main } from "../../../cli/src/main.ts";
import { runAccountsMigrateD1 } from "../../../cli/src/cli-accounts-commands.ts";
import {
  applyD1AccountsMigrations,
  type D1ExecuteCommand,
} from "../../../cli/src/cli-accounts-db.ts";
import { integerOption, parseOptions } from "../../../cli/src/cli-options.ts";

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
  "runner-pool-load",
  "runner-profile-migration",
  "export-self-host-migration",
  "backup-restore",
  "sev-simulation",
  "release-rollback",
  "privacy-operation",
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
        launchScope: "platform-capsule-lite",
        sku: "lite",
        quotaPlanRef: "policy://launch/lite-quotas",
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
        planId: "lite",
        quotaPlanRef: "policy://quota/lite",
      };
    case "spend-cap":
      return {
        workspaceId: "ws_rehearsal",
        spendCapRef: "policy://spend-cap/lite",
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
        loadRunId: "runner_pool_load_rehearsal",
        tenantCount: 2,
        tenantACapsuleId: "cap_tenant_a",
        tenantBCapsuleId: "cap_tenant_b",
        runnerPoolId: "pool_rehearsal",
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
        runnerPoolId: "pool_rehearsal",
        eventId: "scale_drain_event",
      };
    case "evacuation-record":
      return {
        evacuationRunId: "evacuation_rehearsal",
        runnerPoolId: "pool_rehearsal",
      };
    case "runner-profile-migration-drill":
      return {
        migrationOperationId: "migration_rehearsal",
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
        interfaceBindingDigest: testSha256Digest,
        noDataLossCheckId: "no_data_loss_rehearsal",
      };
    case "encrypted-export":
      return {
        exportId: "export_rehearsal",
        archiveDigest: testSha256Digest,
        ageRecipient: "age1rehearsal",
      };
    case "self-host-migration":
      return {
        exportId: "export_rehearsal",
        migrationId: "migration_rehearsal",
        targetHost: "selfhost.takos.local",
        oidcIssuer: "https://selfhost.takos.local/accounts",
      };
    case "sample-data-verification":
      return {
        exportId: "export_rehearsal",
        migrationId: "migration_rehearsal",
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
    case "vulnerability-response-policy":
      return {
        policyRef: "doc://security/vulnerability-response-policy",
        dashboardRef: "dashboard://vulnerability-response",
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
        sourceUrl: "https://github.com/tako0614/takos-office.git",
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
        runnerPoolId: "pool_rehearsal",
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
        runnerPoolId: "pool_rehearsal",
        tenantACapsuleId: "cap_tenant_a",
        tenantBCapsuleId: "cap_tenant_b",
        metricsDashboardRef: "dashboard://runtime/per-capsule",
      };
    case "scale-or-drain":
      return {
        runnerPoolId: "pool_rehearsal",
        eventId: "scale_or_drain_event",
        action: "drain",
      };
    case "readiness-before-cutover":
      return {
        capsuleId: "cap_rehearsal",
        probeRunId: "readiness_before_cutover",
        targetRunnerProfileId: "runner_profile_target",
      };
    case "runner-profile-cutover":
      return {
        capsuleId: "cap_rehearsal",
        migrationOperationId: "migration_rehearsal",
        targetRunnerProfileId: "runner_profile_target",
      };
    case "rollback-before-final":
      return {
        capsuleId: "cap_rehearsal",
        rollbackOperationId: "rollback_before_final",
        sourceRunnerProfileId: "runner_profile_source",
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
    case "clean-migration":
      return {
        exportId: "export_rehearsal",
        migrationId: "migration_rehearsal",
        targetHost: "selfhost.takosumi.local",
        result: "passed",
      };
    case "post-migration-login":
      return {
        exportId: "export_rehearsal",
        migrationId: "migration_rehearsal",
        accountId: "acct_rehearsal",
        sessionSubject: "acct_rehearsal",
        sessionCreatedAt: "2026-05-12T00:30:00.000Z",
        verifiedAt: "2026-05-12T00:45:00.000Z",
        expiresAt: "2100-01-01T00:00:00.000Z",
      };
    case "source-retention-state":
      return {
        exportId: "export_rehearsal",
        migrationId: "migration_rehearsal",
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
    case "release-note":
      return {
        releaseCandidate: "takosumi@1.0.0-rc.1",
        releaseNoteRef: "doc://release/operation-note",
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

function completeRuntimeValidationForTest(): Record<string, unknown> {
  return {
    kind: "operator.runtime-validation@v1",
    ok: true,
    evidenceDigest: testSha256Digest,
    checks: {
      artifactVerified: true,
      configurationReviewed: true,
    },
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
      ...(role === "object-storage" || role === "dns-tls"
        ? {}
        : {
            runtime: "operator.test-runtime",
            runtimeEvidenceRef: `artifact://topology/${environment}/${role}/runtime.json`,
            runtimeValidation: completeRuntimeValidationForTest(),
            bindings: [`binding:${role}`],
          }),
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
    expect(report.kind).toEqual("takosumi.platform-readiness-report@v2");
    expect(report.ready).toEqual(true);
    expect(report.evidenceDigest).toEqual(await testSha256HexDigest(document));
    expect(report.requiredDomainIds).toEqual(
      document.domains.map((entry) => entry.id),
    );
    expect(report.requiredRehearsalStepIds).toEqual(
      document.rehearsal.map((entry) => entry.id),
    );
    expect(report.missingDomains).toEqual([]);
    expect(report.missingRehearsalSteps).toEqual([]);
    expect(report.gapDetails).toEqual([]);
  } finally {
    await removePath(file);
  }
});

test("launch-readiness validate accepts Git SHA-256 object identities", async () => {
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
  const gitSha256ObjectId =
    "c9913a5e25d1c58da061f59d72bb0903be1a25e8b42bfbefb244def32349cbc1";
  for (const entry of [...document.domains, ...document.rehearsal]) {
    for (const evidence of entry.evidence as Record<string, unknown>[]) {
      if (typeof evidence.sourceCommit === "string") {
        evidence.sourceCommit = gitSha256ObjectId;
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
    (entry) => entry.id === "quota-abuse-control",
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
  const runnerPool = document.rehearsal.find(
    (entry) => entry.id === "runner-pool-load",
  )!;
  const backupRestore = document.rehearsal.find(
    (entry) => entry.id === "backup-restore",
  )!;
  runnerPool.completedAt = "2026-05-12T01:50:00Z";
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
      "takosumi.platform-readiness-public-summary@v2",
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
        "P0 evidence and one staged launch rehearsal passed for support@example.test arn:aws:iam::123456789012:role/internal acct_sensitive1.",
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
      "takosumi.platform-readiness-public-summary-report@v2",
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
      "P0 evidence and one staged launch rehearsal passed for acct_sensitive1.";
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
      kind: "takosumi.platform-readiness@v2",
      contributions: [],
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
  expect(template.kind).toEqual("takosumi.platform-readiness@v2");
  expect(template.contributions).toEqual([]);
  expect(template.rehearsalRun.id).toEqual("");
  expect(template.domains.length).toEqual(13);
  expect(template.rehearsal.length).toEqual(11);
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
  });
});

test("launch-readiness composes an extension contribution through template, validation, and public summary", async () => {
  const contributionFile = await makeTempFile({ suffix: ".json" });
  const readinessFile = await makeTempFile({ suffix: ".json" });
  const contribution = {
    kind: "takosumi.platform-readiness-contribution@v1",
    id: "operator-external-system",
    version: "2.1.0",
    capability: "operator.external-system.v1",
    domains: [
      {
        id: "external-system-operation",
        requiredEvidenceTypes: ["external-system-proof"],
      },
    ],
    evidenceSchemas: {
      "external-system-proof": {
        fields: ["proofId"],
        patterns: { proofId: "^proof_[a-z0-9]{6,}$" },
      },
    },
    collectionClassHints: {
      "external-provider": ["external-system-proof"],
    },
    forbiddenSummaryPatterns: ["\\bproof_[a-z0-9]{6,}\\b"],
  };
  await writeTextFile(contributionFile, JSON.stringify(contribution));

  try {
    const templateStdout: string[] = [];
    const templateCode = await main(
      ["launch-readiness", "template", "--contribution-file", contributionFile],
      {
        stdout: (line) => templateStdout.push(line),
        stderr: () => undefined,
      },
    );
    expect(templateCode).toEqual(0);
    const document = JSON.parse(templateStdout.join("\n"));
    expect(document.contributions).toEqual([contribution]);
    expect(
      document.domains.some(
        (entry: Record<string, unknown>) =>
          entry.id === "external-system-operation",
      ),
    ).toBe(true);

    const rehearsalRun = completeRehearsalRun();
    document.rehearsalRun = rehearsalRun;
    document.domains = document.domains.map((entry: Record<string, unknown>) =>
      completePlatformReadinessEntry(entry),
    );
    document.rehearsal = document.rehearsal.map(
      (entry: Record<string, unknown>) =>
        completePlatformReadinessEntry(entry, rehearsalRun.id),
    );
    const extensionEntry = document.domains.find(
      (entry: Record<string, unknown>) =>
        entry.id === "external-system-operation",
    );
    extensionEntry.evidence[0].proofId = "proof_abcdef";
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
    const report = JSON.parse(validateStdout.join("\n"));
    expect(report.contributions).toEqual([
      {
        id: contribution.id,
        version: contribution.version,
        capability: contribution.capability,
      },
    ]);
    expect(report.collectionClassHints).toEqual({
      "external-provider": ["external-system-proof"],
    });
    expect(report.requiredDomainIds).toContain("external-system-operation");
    expect(report.requiredDomainIds).toEqual(
      document.domains.map((entry: Record<string, unknown>) => entry.id),
    );
    expect(report.requiredRehearsalStepIds).toEqual(
      document.rehearsal.map((entry: Record<string, unknown>) => entry.id),
    );

    const summaryStdout: string[] = [];
    const summaryCode = await main(
      [
        "launch-readiness",
        "public-summary",
        "--file",
        readinessFile,
        "--evidence-ref",
        "vault://readiness/operator-extension",
        "--public-summary",
        "P0 evidence and the staged launch rehearsal passed for the selected operator extension.",
      ],
      {
        stdout: (line) => summaryStdout.push(line),
        stderr: () => undefined,
      },
    );
    expect(summaryCode).toEqual(0);
    expect(JSON.parse(summaryStdout.join("\n")).profile.contributions).toEqual(
      report.contributions,
    );
  } finally {
    await removePath(contributionFile);
    await removePath(readinessFile);
  }
});

test("launch-readiness rejects contribution definitions that are not self-contained", async () => {
  const contributionFile = await makeTempFile({ suffix: ".json" });
  await writeTextFile(
    contributionFile,
    JSON.stringify({
      kind: "takosumi.platform-readiness-contribution@v1",
      id: "incomplete-operator-extension",
      version: "1.0.0",
      capability: "operator.incomplete-extension.v1",
      domains: [
        {
          id: "external-system-operation",
          requiredEvidenceTypes: ["missing-extension-proof-schema"],
        },
      ],
    }),
  );

  try {
    const stderr: string[] = [];
    const code = await main(
      ["launch-readiness", "template", "--contribution-file", contributionFile],
      {
        stdout: () => undefined,
        stderr: (line) => stderr.push(line),
      },
    );
    expect(code).toEqual(2);
    expect(stderr.join("\n")).toContain(
      "requires evidence schema missing-extension-proof-schema",
    );
  } finally {
    await removePath(contributionFile);
  }
});

function identitySecurityRotationLogForTest() {
  return {
    kind: "takosumi.identity-security-rotation-log@v1",
    rotationRunId: "oidc-rotation-2026-06-23",
    environment: "staging",
    issuer: "https://app.takosumi.com",
    owner: "ops",
    reviewer: "release-owner",
    startedAt: "2026-05-12T00:40:00Z",
    completedAt: "2026-05-12T01:00:00Z",
    result: "passed",
    keyRotation: {
      keyId: "kid-rotated-2026",
      previousKeyId: "kid-before-2026",
      overlapCapturedAt: "2026-05-12T00:45:00Z",
      previousKeyRemovedAt: "2026-05-12T00:55:00Z",
      postRevocationCapturedAt: "2026-05-12T00:56:00Z",
    },
    clientSecretRotation: {
      clientId: "google-client-rotation",
      oldSecretId: "google-secret-before-2026",
      newSecretId: "google-secret-after-2026",
      overlapStartedAt: "2026-05-12T00:45:00Z",
      oldSecretRevokedAt: "2026-05-12T00:55:00Z",
      overlapWindowSeconds: 600,
      revocationEventId: "google-secret-revocation-2026",
    },
    auditEvent: {
      id: "audit-oidc-rotation-2026",
      subject: "operator-release-owner",
      at: "2026-05-12T00:57:00Z",
    },
  };
}

function publicEs256JwkForTest(kid: string) {
  return {
    kty: "EC",
    kid,
    crv: "P-256",
    x: `fixture-x-${kid}`,
    y: `fixture-y-${kid}`,
    use: "sig",
    alg: "ES256",
  };
}

test("launch-readiness oidc-account-security evidence verifies overlap and previous-key removal", async () => {
  const readinessFile = await makeTempFile({ suffix: ".json" });
  const overlapJwksFile = await makeTempFile({ suffix: ".json" });
  const postRevocationJwksFile = await makeTempFile({ suffix: ".json" });
  const rotationLogFile = await makeTempFile({ suffix: ".json" });
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
      overlapJwksFile,
      JSON.stringify({
        keys: [
          publicEs256JwkForTest("kid-before-2026"),
          publicEs256JwkForTest("kid-rotated-2026"),
        ],
      }),
    );
    await writeTextFile(
      postRevocationJwksFile,
      JSON.stringify({ keys: [publicEs256JwkForTest("kid-rotated-2026")] }),
    );
    await writeTextFile(
      rotationLogFile,
      JSON.stringify(identitySecurityRotationLogForTest()),
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
        "--overlap-jwks-file",
        overlapJwksFile,
        "--post-revocation-jwks-file",
        postRevocationJwksFile,
        "--rotation-log-file",
        rotationLogFile,
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
    expect(
      updatedOidc.evidence.find(
        (entry: { type: string }) => entry.type === "key-rotation-drill",
      ).postRevocationJwksKeyIds,
    ).toEqual(["kid-rotated-2026"]);
    const updatedSecurityOperations = updated.domains.find(
      (entry: { id: string }) => entry.id === "security-operations",
    );
    expect(
      updatedSecurityOperations.evidence.find(
        (entry: { type: string }) => entry.type === "secret-rotation-run-log",
      ).rotationRunId,
    ).toEqual("oidc-rotation-2026-06-23");
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
    await removePath(overlapJwksFile);
    await removePath(postRevocationJwksFile);
    await removePath(rotationLogFile);
    await removePath(outFile);
  }
});

test("launch-readiness oidc-account-security evidence rejects previous key after revocation", async () => {
  const readinessFile = await makeTempFile({ suffix: ".json" });
  const overlapJwksFile = await makeTempFile({ suffix: ".json" });
  const postRevocationJwksFile = await makeTempFile({ suffix: ".json" });
  const rotationLogFile = await makeTempFile({ suffix: ".json" });
  const document = await platformReadinessTemplateForTest();

  try {
    await writeTextFile(readinessFile, JSON.stringify(document));
    const overlapJwks = {
      keys: [
        publicEs256JwkForTest("kid-before-2026"),
        publicEs256JwkForTest("kid-rotated-2026"),
      ],
    };
    await writeTextFile(overlapJwksFile, JSON.stringify(overlapJwks));
    await writeTextFile(postRevocationJwksFile, JSON.stringify(overlapJwks));
    await writeTextFile(
      rotationLogFile,
      JSON.stringify(identitySecurityRotationLogForTest()),
    );
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
        "--overlap-jwks-file",
        overlapJwksFile,
        "--post-revocation-jwks-file",
        postRevocationJwksFile,
        "--rotation-log-file",
        rotationLogFile,
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
      "post-revocation JWKS still contains previous key id kid-before-2026",
    );

    stderr.length = 0;
    await writeTextFile(
      overlapJwksFile,
      JSON.stringify({
        keys: [
          { ...publicEs256JwkForTest("kid-before-2026"), d: "private" },
          publicEs256JwkForTest("kid-rotated-2026"),
        ],
      }),
    );
    await writeTextFile(
      postRevocationJwksFile,
      JSON.stringify({ keys: [publicEs256JwkForTest("kid-rotated-2026")] }),
    );
    const privateJwkCode = await main(
      [
        "launch-readiness",
        "oidc-account-security",
        "evidence",
        "--file",
        readinessFile,
        "--issuer",
        "https://app.takosumi.com",
        "--overlap-jwks-file",
        overlapJwksFile,
        "--post-revocation-jwks-file",
        postRevocationJwksFile,
        "--rotation-log-file",
        rotationLogFile,
        "--ref-prefix",
        "vault://platform-readiness/oidc-rotation-2026/domains/oidc-account-security",
      ],
      {
        stdout: () => undefined,
        stderr: (line) => stderr.push(line),
      },
    );
    expect(privateJwkCode).toEqual(2);
    expect(stderr.join("\n")).toContain("unexpected fields: d");

    stderr.length = 0;
    await writeTextFile(overlapJwksFile, JSON.stringify(overlapJwks));
    const outOfRunLog = identitySecurityRotationLogForTest();
    outOfRunLog.startedAt = "2026-05-12T00:50:00Z";
    await writeTextFile(rotationLogFile, JSON.stringify(outOfRunLog));
    const outOfRunTimestampCode = await main(
      [
        "launch-readiness",
        "oidc-account-security",
        "evidence",
        "--file",
        readinessFile,
        "--issuer",
        "https://app.takosumi.com",
        "--overlap-jwks-file",
        overlapJwksFile,
        "--post-revocation-jwks-file",
        postRevocationJwksFile,
        "--rotation-log-file",
        rotationLogFile,
        "--ref-prefix",
        "vault://platform-readiness/oidc-rotation-2026/domains/oidc-account-security",
      ],
      {
        stdout: () => undefined,
        stderr: (line) => stderr.push(line),
      },
    );
    expect(outOfRunTimestampCode).toEqual(2);
    expect(stderr.join("\n")).toContain(
      "rotation log key timestamps must order",
    );
  } finally {
    await removePath(readinessFile);
    await removePath(overlapJwksFile);
    await removePath(postRevocationJwksFile);
    await removePath(rotationLogFile);
  }
});

test("launch-readiness migrate-final-model rewrites legacy evidence names without printing raw evidence", async () => {
  const file = await makeTempFile({ suffix: ".json" });
  const out = await makeTempFile({ suffix: ".json" });
  const legacyDocument = {
    kind: "takosumi.platform-readiness@v1",
    domains: [
      {
        id: "quota-abuse-spend-control",
        requiredEvidenceTypes: [
          "launch-token-consume",
          "installation-created",
          "vulnerability-sla",
        ],
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
          {
            type: "vulnerability-sla",
            policyRef: "doc://security/vulnerability-policy",
          },
        ],
      },
      {
        id: "legal-privacy-support",
        requiredEvidenceTypes: [],
        evidence: [],
      },
      {
        id: "shared-cell-production-runtime",
        requiredEvidenceTypes: ["load-test"],
        evidence: [
          {
            type: "load-test",
            runtimeCellId: "cell_private_rehearsal",
          },
        ],
      },
      {
        id: "dedicated-materialize",
        requiredEvidenceTypes: ["materialize-drill", "continuity-evidence"],
        evidence: [
          {
            type: "materialize-drill",
            materializeOperationId: "materialize_private_rehearsal",
            installationId: "inst_private_rehearsal",
          },
          {
            type: "continuity-evidence",
            serviceGrantDigest: `sha256:${"1".repeat(64)}`,
          },
        ],
      },
      {
        id: "export-self-host-sovereignty",
        requiredEvidenceTypes: ["self-host-import"],
        evidence: [
          {
            type: "self-host-import",
            importId: "import_private_rehearsal",
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
        id: "release-rollback",
        requiredEvidenceTypes: ["per-installation-metrics", "support-note"],
        evidence: [
          {
            type: "per-installation-metrics",
            tenantAInstallationId: "inst_tenant_a_private",
            tenantBInstallationId: "inst_tenant_b_private",
          },
          {
            type: "support-note",
            supportNoteRef: "doc://release/operation-note",
          },
        ],
      },
      {
        id: "shared-cell-load",
        requiredEvidenceTypes: ["two-tenant-load"],
        evidence: [
          {
            type: "two-tenant-load",
            runtimeCellId: "cell_private_rehearsal",
          },
        ],
      },
      {
        id: "dedicated-materialize",
        requiredEvidenceTypes: [
          "readiness-before-cutover",
          "materialize-cutover",
          "rollback-before-final",
        ],
        evidence: [
          {
            type: "readiness-before-cutover",
            targetRuntimeTargetId: "runtime_target_private_rehearsal",
          },
          {
            type: "materialize-cutover",
            materializeOperationId: "materialize_private_rehearsal",
            targetRuntimeTargetId: "runtime_target_private_rehearsal",
          },
          {
            type: "rollback-before-final",
            sourceRuntimeTargetId: "runtime_source_private_rehearsal",
          },
        ],
      },
      {
        id: "export-self-host-import",
        requiredEvidenceTypes: ["clean-import", "post-import-login"],
        evidence: [
          {
            type: "clean-import",
            importId: "import_private_rehearsal",
          },
          {
            type: "post-import-login",
            importId: "import_private_rehearsal",
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
    expect(migrated.kind).toEqual("takosumi.platform-readiness@v2");
    expect(migrated.contributions).toEqual([]);
    const migratedText = JSON.stringify(migrated);
    expect(migratedText).not.toContain("installation-created");
    expect(migratedText).not.toContain("launch-token-consume");
    expect(migratedText).not.toContain('"installationId"');
    expect(migratedText).not.toContain('"spaceId"');
    expect(migratedText).not.toContain('"deploymentId"');
    expect(migratedText).not.toContain("per-installation-metrics");
    expect(migratedText).not.toContain("quota-abuse-spend-control");
    expect(migratedText).not.toContain("legal-privacy-support");
    expect(migratedText).not.toContain("shared-cell-production-runtime");
    expect(migratedText).not.toContain("shared-cell-load");
    expect(migratedText).not.toContain("dedicated-materialize");
    expect(migratedText).not.toContain("export-self-host-import");
    expect(migratedText).not.toContain("runtimeCellId");
    expect(migratedText).not.toContain("materializeOperationId");
    expect(migratedText).not.toContain("targetRuntimeTargetId");
    expect(migratedText).not.toContain("sourceRuntimeTargetId");
    expect(migratedText).not.toContain('"importId"');
    expect(migratedText).not.toContain("serviceGrantDigest");
    expect(migratedText).not.toContain("materialize-drill");
    expect(migratedText).not.toContain("materialize-cutover");
    expect(migratedText).not.toContain("self-host-import");
    expect(migratedText).not.toContain("clean-import");
    expect(migratedText).not.toContain("post-import-login");
    expect(migratedText).not.toContain("support-note");
    expect(migratedText).not.toContain("supportNoteRef");
    expect(migratedText).not.toContain("vulnerability-sla");
    expect(migratedText).toContain("capsule-created");
    expect(migratedText).toContain("capsuleId");
    expect(migratedText).toContain("workspaceId");
    expect(migratedText).toContain("stateVersionId");
    expect(migratedText).toContain("per-capsule-metrics");
    expect(migratedText).toContain("quota-abuse-control");
    expect(migratedText).toContain("legal-privacy");
    expect(migratedText).toContain("runner-pool-production-runtime");
    expect(migratedText).toContain("runner-pool-load");
    expect(migratedText).toContain("runner-profile-migration");
    expect(migratedText).toContain("export-self-host-migration");
    expect(migratedText).toContain("runnerPoolId");
    expect(migratedText).toContain("migrationOperationId");
    expect(migratedText).toContain("targetRunnerProfileId");
    expect(migratedText).toContain("sourceRunnerProfileId");
    expect(migratedText).toContain('"migrationId"');
    expect(migratedText).toContain("interfaceBindingDigest");
    expect(migratedText).toContain("runner-profile-migration-drill");
    expect(migratedText).toContain("runner-profile-cutover");
    expect(migratedText).toContain("self-host-migration");
    expect(migratedText).toContain("clean-migration");
    expect(migratedText).toContain("post-migration-login");
    expect(migratedText).toContain("release-note");
    expect(migratedText).toContain("releaseNoteRef");
    expect(migratedText).toContain("vulnerability-response-policy");
    expect(migratedText).toContain("account,workspace,capsule,run,output");
    expect(migratedText).toContain("capsule_id,tenant_id");
  } finally {
    await removePath(file);
    await removePath(out);
  }
});

test("launch-readiness migrate-final-model preserves an operation drill envelope", async () => {
  const file = await makeTempFile({ suffix: ".json" });
  const out = await makeTempFile({ suffix: ".json" });
  await writeTextFile(
    file,
    JSON.stringify({
      kind: "takosumi.operation-drill-evidence@v1",
      generatedAt: "2026-05-13T00:00:00Z",
      readinessPatch: {
        domains: [
          {
            id: "shared-cell-production-runtime",
            evidence: [
              {
                type: "load-test",
                runtimeCellId: "cell_private_rehearsal",
              },
            ],
          },
        ],
        rehearsal: [
          {
            id: "dedicated-materialize",
            evidence: [
              {
                type: "materialize-cutover",
                materializeOperationId: "materialize_private_rehearsal",
                targetRuntimeTargetId: "runtime_target_private_rehearsal",
              },
            ],
          },
        ],
      },
    }),
  );

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
    expect(stdout.join("\n")).not.toContain("cell_private_rehearsal");
    const migrated = JSON.parse(await readFile(out, "utf8"));
    expect(migrated.kind).toEqual("takosumi.operation-drill-evidence@v1");
    expect(migrated.generatedAt).toEqual("2026-05-13T00:00:00Z");
    expect(migrated.contributions).toBeUndefined();
    expect(migrated.readinessPatch.domains[0]).toMatchObject({
      id: "runner-pool-production-runtime",
      evidence: [
        {
          type: "load-test",
          runnerPoolId: "cell_private_rehearsal",
        },
      ],
    });
    expect(migrated.readinessPatch.rehearsal[0]).toMatchObject({
      id: "runner-profile-migration",
      evidence: [
        {
          type: "runner-profile-cutover",
          migrationOperationId: "materialize_private_rehearsal",
          targetRunnerProfileId: "runtime_target_private_rehearsal",
        },
      ],
    });
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
      kind: "takosumi.platform-readiness@v2",
      contributions: [],
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
  delete (freshSignup.evidence as Array<Record<string, unknown>>).find(
    (entry) => entry.type === "team-membership",
  )!.membershipEventId;
  delete (oidcSecurity.evidence as Array<Record<string, unknown>>).find(
    (entry) => entry.type === "client-secret-rotation",
  )!.revocationEventId;
  delete (gitInstall.evidence as Array<Record<string, unknown>>).find(
    (entry) => entry.type === "capsule-apply",
  )!.planDigest;

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
  const runnerProfileEvidence = document.rehearsal.find(
    (entry) => entry.id === "runner-profile-migration",
  )!.evidence as Record<string, unknown>[];
  runnerProfileEvidence.find(
    (entry) => entry.type === "preserve-evidence",
  )!.sourceCommit = "main";
  const runnerPoolEvidence = document.domains.find(
    (entry) => entry.id === "runner-pool-production-runtime",
  )!.evidence as Record<string, unknown>[];
  runnerPoolEvidence.find((entry) => entry.type === "load-test")!.tenantCount =
    1;
  const runnerProfileDomainEvidence = document.domains.find(
    (entry) => entry.id === "runner-profile-migration",
  )!.evidence as Record<string, unknown>[];
  runnerProfileDomainEvidence.find(
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
      report.incompleteDomains.includes("runner-profile-migration"),
    ).toBeTruthy();
    expect(
      report.incompleteDomains.includes("export-self-host-sovereignty"),
    ).toBeTruthy();
    expect(
      report.incompleteDomains.includes("release-provenance"),
    ).toBeTruthy();
    expect(
      report.incompleteDomains.includes("runner-pool-production-runtime"),
    ).toBeTruthy();
    expect(
      report.incompleteRehearsalSteps.includes("fresh-signup"),
    ).toBeTruthy();
    expect(
      report.incompleteRehearsalSteps.includes("git-url-install"),
    ).toBeTruthy();
    expect(
      report.incompleteRehearsalSteps.includes("runner-profile-migration"),
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
    (entry) => entry.id === "legal-privacy",
  )!.evidence as Record<string, unknown>[];
  legalEvidence.find((entry) => entry.type === "sar-delete-rehearsal")!.result =
    "placeholder";
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
    expect(report.incompleteDomains.includes("legal-privacy")).toBeTruthy();
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

  const offeringEvidence = document.domains.find(
    (entry) => entry.id === "offering-definition",
  )!.evidence as Record<string, unknown>[];
  offeringEvidence[0]!.summary =
    "Readiness evidence used Bearer sensitive_token_123456 during rehearsal.";
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
    (entry) => entry.type === "email-assurance",
  )!.accountId = "acct_other";
  const gitInstallEvidence = document.rehearsal.find(
    (entry) => entry.id === "git-url-install",
  )!.evidence as Record<string, unknown>[];
  gitInstallEvidence.find((entry) => entry.type === "oidc-login")!.capsuleId =
    "cap_other";
  const runnerPoolEvidence = document.rehearsal.find(
    (entry) => entry.id === "runner-pool-load",
  )!.evidence as Record<string, unknown>[];
  runnerPoolEvidence.find(
    (entry) => entry.type === "per-capsule-metrics",
  )!.runnerPoolId = "pool_other";
  const runnerProfileEvidence = document.rehearsal.find(
    (entry) => entry.id === "runner-profile-migration",
  )!.evidence as Record<string, unknown>[];
  runnerProfileEvidence.find(
    (entry) => entry.type === "domain-preservation",
  )!.domainName = "other.acme.example";
  const exportEvidence = document.rehearsal.find(
    (entry) => entry.id === "export-self-host-migration",
  )!.evidence as Record<string, unknown>[];
  exportEvidence.find(
    (entry) => entry.type === "source-retention-state",
  )!.exportId = "export_other";
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
      report.incompleteRehearsalSteps.includes("runner-pool-load"),
    ).toBeTruthy();
    expect(
      report.incompleteRehearsalSteps.includes("runner-profile-migration"),
    ).toBeTruthy();
    expect(
      report.incompleteRehearsalSteps.includes("export-self-host-migration"),
    ).toBeTruthy();
  } finally {
    await removePath(file);
  }
});

test("launch-readiness validate rejects unrelated self-host domain proofs", async () => {
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
  const evidence = document.domains.find(
    (entry) => entry.id === "export-self-host-sovereignty",
  )!.evidence as Record<string, unknown>[];
  evidence.find((entry) => entry.type === "self-host-migration")!.exportId =
    "export_unrelated";
  await writeTextFile(file, JSON.stringify(document));

  try {
    const stdout: string[] = [];
    const code = await main(
      ["launch-readiness", "validate", "--file", file, "--json"],
      { stdout: (line) => stdout.push(line), stderr: () => undefined },
    );
    expect(code).toEqual(1);
    const report = JSON.parse(stdout.join("\n"));
    expect(report.ready).toEqual(false);
    expect(
      report.incompleteDomains.includes("export-self-host-sovereignty"),
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
  expect(accountsTemplate.runtime).toEqual("<operator-runtime-token>");
  expect(accountsTemplate.runtimeValidation.kind).toEqual(
    "operator.runtime-validation@v1",
  );
  expect(accountsTemplate.runtimeValidation.ok).toEqual(true);
  expect(accountsTemplate.runtimeValidation.checks.operatorReviewed).toEqual(
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

test("launch-readiness production-topology preflight requires generic runtime evidence", async () => {
  const file = await makeTempFile({ suffix: ".json" });
  const topology = completeProductionTopologyForTest("staging");
  const components = topology.components as Record<string, unknown>[];
  const accounts = components.find(
    (component) => component.role === "accounts",
  )!;
  accounts.runtime = "";
  accounts.bindings = [""];
  delete accounts.runtimeEvidenceRef;
  delete accounts.runtimeValidation;
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
        "accounts component runtime must be a non-empty implementation token",
      ),
    ).toBeTruthy();
    expect(
      output.includes("accounts component runtimeEvidenceRef is required"),
    ).toBeTruthy();
    expect(
      output.includes("accounts component runtimeValidation must be an object"),
    ).toBeTruthy();
    expect(
      output.includes(
        "accounts component bindings must be an array of non-empty tokens",
      ),
    ).toBeTruthy();
  } finally {
    await removePath(file);
  }
});

test("launch-readiness production-topology preflight rejects weak generic runtime validation", async () => {
  const file = await makeTempFile({ suffix: ".json" });
  const topology = completeProductionTopologyForTest("staging");
  const components = topology.components as Record<string, unknown>[];
  const accounts = components.find(
    (component) => component.role === "accounts",
  )!;
  accounts.runtimeValidation = {
    ...completeRuntimeValidationForTest(),
    ok: false,
    evidenceDigest: "sha256:not-a-digest",
    checks: {
      artifactVerified: false,
      "not a token": true,
    },
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
      output.includes("accounts component runtimeValidation.ok must be true"),
    ).toBeTruthy();
    expect(
      output.includes(
        "accounts component runtimeValidation.evidenceDigest must be a sha256: digest",
      ),
    ).toBeTruthy();
    expect(
      output.includes(
        "accounts component runtimeValidation.checks.artifactVerified must be true",
      ),
    ).toBeTruthy();
    expect(
      output.includes(
        "accounts component runtimeValidation.checks.not a token must be true",
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
  expect(plan.upstreamOAuth.configured).toEqual(false);
  expect(plan.passkeys.configured).toEqual(false);
  expect(plan.platformAccess).toEqual(undefined);
  expect(plan.persistence).toEqual({
    configured: false,
    driver: "memory",
  });
  expect(plan.devSession).toEqual({
    configured: false,
  });
  expect(plan.accountPlaneFacades).toEqual([
    "identity",
    "sessions",
    "OIDC",
    "PAT",
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

test("accounts serve dry-run accepts arbitrary upstream descriptors without exposing subject secrets", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const providers = JSON.stringify([
    {
      providerId: "company-sso",
      issuer: "https://id.example.test",
      authorizationEndpoint: "https://id.example.test/oauth/authorize",
      tokenEndpoint: "https://id.example.test/oauth/token",
      userInfoEndpoint: "https://id.example.test/oauth/userinfo",
      clientId: "accounts-client",
      redirectUri: "https://accounts.example.test/sign-in/callback",
    },
  ]);
  const code = await main(
    [
      "accounts",
      "serve",
      "--dry-run",
      "--subject-secret",
      "subject-secret",
      "--upstream-providers",
      providers,
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
    providers: ["company-sso"],
    sessionTtlMs: 60000,
  });
  expect(stdout.join("\n").includes("subject-secret")).toEqual(false);
  expect(stdout.join("\n").includes("id.example.test")).toEqual(false);
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
  const providers = JSON.stringify([
    {
      providerId: "keycloak",
      issuer: "https://idp.example.test/realms/takos",
      authorizationEndpoint:
        "https://idp.example.test/realms/takos/protocol/openid-connect/auth",
      tokenEndpoint:
        "https://idp.example.test/realms/takos/protocol/openid-connect/token",
      userInfoEndpoint:
        "https://idp.example.test/realms/takos/protocol/openid-connect/userinfo",
      clientId: "keycloak-client",
      redirectUri: "https://accounts.example.test/sign-in/callback",
      scopes: ["openid", "email", "profile"],
    },
  ]);
  const code = await main(
    [
      "accounts",
      "serve",
      "--dry-run",
      "--subject-secret",
      "subject-secret",
      "--upstream-providers",
      providers,
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
  expect(stdout.join("\n").includes("idp.example.test")).toEqual(false);
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

test("accounts serve rejects upstream provider descriptors without a subject secret", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const providers = JSON.stringify([
    {
      providerId: "company-sso",
      issuer: "https://id.example.test",
      authorizationEndpoint: "https://id.example.test/oauth/authorize",
      tokenEndpoint: "https://id.example.test/oauth/token",
      userInfoEndpoint: "https://id.example.test/oauth/userinfo",
      clientId: "accounts-client",
      redirectUri: "https://accounts.example.test/sign-in/callback",
    },
  ]);
  const code = await main(
    ["accounts", "serve", "--dry-run", "--upstream-providers", providers],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    },
  );

  expect(code).toEqual(2);
  expect(stdout).toEqual([]);
  expect(stderr).toEqual([
    "TAKOSUMI_ACCOUNTS_UPSTREAM_PROVIDERS requires TAKOSUMI_ACCOUNTS_SUBJECT_SECRET",
  ]);
});

test("accounts serve rejects incomplete upstream provider descriptors", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await main(
    [
      "accounts",
      "serve",
      "--dry-run",
      "--subject-secret",
      "subject-secret",
      "--upstream-providers",
      JSON.stringify([{ providerId: "company-sso" }]),
    ],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    },
  );

  expect(code).toEqual(2);
  expect(stdout).toEqual([]);
  expect(stderr).toEqual([
    "TAKOSUMI_ACCOUNTS_UPSTREAM_PROVIDERS[0].issuer must be a non-empty string",
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
  expect(plan.migrations.length).toEqual(35);
  expect(plan.migrations[0].name).toEqual("001_app_installation_ledger.sql");
  expect(plan.migrations[16].name).toEqual(
    "017_drop_binding_grant_runtime_binding.sql",
  );
  expect(plan.migrations[22].name).toEqual("023_account_email_verified.sql");
  expect(plan.migrations[24].name).toEqual("025_privacy_requests.sql");
  expect(plan.migrations[25].name).toEqual(
    "026_app_installation_source_path.sql",
  );
  expect(plan.migrations[29].name).toEqual(
    "030_oidc_clients_drop_installation_fkey.sql",
  );
  expect(plan.migrations[30].name).toEqual(
    "031_interface_oauth_token_evidence.sql",
  );
  expect(plan.migrations[31].name).toEqual(
    "032_retire_accounts_capsule_projection_ledger.sql",
  );
  expect(plan.migrations[32].name).toEqual(
    "033_generalize_billing_provider_storage.sql",
  );
  expect(plan.migrations[33].name).toEqual(
    "034_remove_commercial_billing_persistence.sql",
  );
  expect(plan.migrations[34].name).toEqual("035_account_picture.sql");
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
  expect(stderr).toEqual([
    "`takosumi installations` is retired. Use canonical Source/Capsule plan/apply operations.",
  ]);
  expect(stderr.join("\n")).not.toContain("internal installations");
});

// ---------------------------------------------------------------------------
// accounts migrate-d1 (Cloudflare D1 migration runner)
//
// The runner is built around the injectable `D1ExecuteCommand` seam so the
// real `bunx wrangler d1 execute` shell-out can be replaced with a hermetic
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
  expect(report.migrations[1]).toEqual({
    version: 1,
    name: "generalize_billing_provider_storage",
  });
  expect(report.migrations[2]).toEqual({
    version: 2,
    name: "remove_commercial_billing_persistence",
  });
});

test("migrate-d1 applies the bootstrap and retires commercial billing persistence on a clean DB", async () => {
  const fake = createFakeD1Command();
  const report = await applyD1AccountsMigrations({
    databaseId: "db-uuid",
    accountId: "acct-1",
    dryRun: false,
    command: fake.command,
  });
  expect(report.applied).toEqual([0, 1, 2]);
  expect(report.skipped).toEqual([]);
  // Records the version the Worker's ensureD1SchemaVersion later reads
  // (EXPECTED_D1_SCHEMA_VERSION = 2) into the same table name.
  expect(fake.versions()).toEqual([0, 1, 2]);
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
  const billingMigration = fake.calls.find((call) =>
    call.sql.includes("billing_accounts_by_provider_customer"),
  );
  expect(billingMigration?.sql).toContain(
    "json_remove(document, '$.stripeCustomerId'",
  );
  expect(billingMigration?.sql).toContain("'$.providerDefaultPaymentMethodId'");
  const removalMigration = fake.calls.find((call) =>
    call.sql.includes("DELETE FROM takosumi_accounts_documents"),
  );
  expect(removalMigration?.sql).toContain("'billing_accounts'");
  expect(removalMigration?.sql).toContain("'billing_webhook_events'");
  expect(removalMigration?.sql).toContain("'billing_usage_records'");
});

test("migrate-d1 skips already-applied versions (idempotent re-run)", async () => {
  const fake = createFakeD1Command({ seedVersions: [0, 1, 2] });
  const report = await applyD1AccountsMigrations({
    databaseId: "db-uuid",
    dryRun: false,
    command: fake.command,
  });
  expect(report.applied).toEqual([]);
  expect(report.skipped).toEqual([0, 1, 2]);
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
    {
      results: [{ results: [{ version: 0 }, { version: 1 }, { version: 2 }] }],
    },
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
  // Both versions came back from the parsed envelope, so both are skipped.
  expect(report.skipped).toEqual([0, 1, 2]);
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
  expect(report.applied).toEqual([0, 1, 2]);
  expect(fake.versions()).toEqual([0, 1, 2]);
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
  // Workspace-separated form mis-parses a value that looks like a flag, so the
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

test("connections create uses explicit recipe data and never prints the secret", async () => {
  const tokenFile = await makeTempFile();
  await writeTextFile(
    tokenFile,
    JSON.stringify({ CLOUDFLARE_API_TOKEN: "cf_live_secret" }),
  );
  const stdout: string[] = [];
  const stderr: string[] = [];
  const requests: Array<{ request: Request; body: string }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const request = new Request(input, init);
    const body = await request.clone().text();
    requests.push({ request, body });
    return Response.json(
      {
        connection: {
          id: "conn_cf",
          scope: "operator",
          provider: "registry.opentofu.org/cloudflare/cloudflare",
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
        "create",
        "--url",
        "https://app.takosumi.test",
        "--token",
        "operator-bearer",
        "--provider",
        "registry.opentofu.org/cloudflare/cloudflare",
        "--recipe",
        "cloudflare",
        "--auth-mode",
        "api_token",
        "--secret-partition",
        "provider-credentials",
        "--values-file",
        tokenFile,
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
      "https://app.takosumi.test/internal/v1/connections",
    );
    expect(requests[0]?.request.headers.get("authorization")).toEqual(
      "Bearer operator-bearer",
    );
    const createBody = JSON.parse(requests[0]!.body);
    expect(createBody).toMatchObject({
      provider: "registry.opentofu.org/cloudflare/cloudflare",
      credentialRecipe: {
        id: "cloudflare",
        authMode: "api_token",
        secretPartition: "provider-credentials",
      },
      scope: "operator",
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
  expect(stdout.join("\n")).not.toContain("Worker secrets");
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

test("connections create creates a Workspace-owned arbitrary provider connection", async () => {
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
          scope: "workspace",
          provider: "registry.opentofu.org/vercel/vercel",
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
        "create",
        "--url",
        "https://app.takosumi.test",
        "--token",
        "operator-bearer",
        "--workspace",
        "ws_1",
        "--provider",
        "registry.opentofu.org/vercel/vercel",
        "--recipe",
        "generic-env",
        "--auth-mode",
        "env",
        "--secret-partition",
        "tenant:vercel",
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
      "https://app.takosumi.test/internal/v1/connections",
    );
    expect(requests[0]?.request.headers.get("authorization")).toEqual(
      "Bearer operator-bearer",
    );
    const createBody = JSON.parse(requests[0]!.body);
    expect(createBody).toEqual({
      provider: "registry.opentofu.org/vercel/vercel",
      workspaceId: "ws_1",
      credentialRecipe: {
        id: "generic-env",
        authMode: "env",
        secretPartition: "tenant:vercel",
      },
      scope: "workspace",
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

test("connections create rejects operator scope combined with a Workspace", async () => {
  const tokenFile = await makeTempFile();
  await writeTextFile(tokenFile, JSON.stringify({ TOKEN: "cf_live_secret" }));
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
        "create",
        "--url",
        "https://app.takosumi.test",
        "--token",
        "operator-bearer",
        "--workspace",
        "ws_1",
        "--scope",
        "operator",
        "--provider",
        "registry.opentofu.org/example/example",
        "--recipe",
        "generic-env",
        "--auth-mode",
        "env",
        "--secret-partition",
        "tenant:example",
        "--values-file",
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
      "--workspace cannot be combined with --scope operator",
    );
    expect(stderr.join("\n")).not.toContain("cf_live_secret");
  } finally {
    globalThis.fetch = originalFetch;
    await removePath(tokenFile);
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
