import { expect, test } from "bun:test";
import {
  PLATFORM_CONTROL_PLANE_SMOKE_KIND,
  dryRunResult,
  isSmokeProviderConnectionMatch,
  resolveOptions,
  shouldMarkPendingSmokeInstallationError,
} from "../../scripts/smoke-platform-control-plane.ts";

test("platform control-plane smoke dry-run is redacted and complete", async () => {
  const options = await resolveOptions(
    {
      dryRun: true,
      url: "https://app-staging.takosumi.com",
      space: "space_test",
      appName: "takosumi-smoke-test",
      cloudflareAccountIdFile:
        "/operator/.secrets/staging/CLOUDFLARE_ACCOUNT_ID",
      cloudflareWorkersSubdomainFile:
        "/operator/.secrets/staging/CLOUDFLARE_WORKERS_SUBDOMAIN",
      sessionTokenFile:
        "/operator/.secrets/staging/TAKOSUMI_ACCOUNT_SESSION_TOKEN",
      cloudflareApiTokenFile: "/operator/.secrets/staging/CLOUDFLARE_API_TOKEN",
    },
    {},
  );

  const result = dryRunResult(options);
  const json = JSON.stringify(result);

  expect(result.kind).toBe(PLATFORM_CONTROL_PLANE_SMOKE_KIND);
  expect(result.status).toBe("dry_run");
  expect(result.environment).toBe("staging-smoke");
  expect(result.capsuleModule).toBe("cloudflare-hello-worker");
  expect(result.credentialPath).toBe("space_scoped_provider_connection");
  expect(result.steps).toEqual([
    "spaceScopedProviderConnection",
    "connectionVerified",
    "scratchInstall",
    "plan",
    "apply",
    "deploymentVerified",
    "publicUrlVerified",
    "deploymentLedgerVerified",
    "destroy",
    "connectionRevoked",
  ]);
  expect(result.workerUrl).toBe(
    "https://takosumi-smoke-test.<redacted>.workers.dev",
  );
  expect(result.publicUrlVerified).toBe(true);
  expect(result.deploymentLedgerVerified).toBe(true);
  expect(result.destroyVerified).toBe(true);
  expect(result.connectionRevoked).toBe(true);
  expect(result.deploymentLedger).toEqual({
    installationStatus: "active",
    deploymentId: "dep_dry_run",
    stateGeneration: 1,
    applyRunId: "apply_dry_run",
    publicOutputNames: ["url", "worker_name"],
    publicOutputDigest: `sha256:${"0".repeat(64)}`,
  });
  expect(result.inputs.accountSessionTokenSource).toBe("file");
  expect(result.inputs.cloudflareApiTokenSource).toBe("file");
  expect(result.inputs.cloudflareAccountIdSource).toBe("file");
  expect(result.inputs.cloudflareAccountIdDigest).toMatch(
    /^sha256:[0-9a-f]{64}$/,
  );
  expect(result.inputs.cloudflareWorkersSubdomainSource).toBe("file");
  expect(json).not.toContain("cf-account-secret-ish");
  expect(json).not.toContain("CLOUDFLARE_ACCOUNT_ID");
  expect(json).not.toContain("TAKOSUMI_ACCOUNT_SESSION_TOKEN");
  expect(json).not.toContain("CLOUDFLARE_API_TOKEN");
});

test("platform control-plane smoke matches canonical provider connection sources", () => {
  const expected = {
    provider: "cloudflare",
    displayName: "Layer-2 smoke canonical",
  };

  expect(
    isSmokeProviderConnectionMatch(
      {
        id: "pcn_test",
        providerSource: "registry.opentofu.org/cloudflare/cloudflare",
        displayName: "Layer-2 smoke canonical",
      },
      expected,
    ),
  ).toBe(true);
  expect(
    isSmokeProviderConnectionMatch(
      {
        id: "pcn_test",
        providerSource: "cloudflare",
        displayName: "Layer-2 smoke canonical",
      },
      expected,
    ),
  ).toBe(true);
  expect(
    isSmokeProviderConnectionMatch(
      {
        id: "pcn_test",
        providerSource: "registry.opentofu.org/hashicorp/aws",
        displayName: "Layer-2 smoke canonical",
      },
      expected,
    ),
  ).toBe(false);
});

test("platform control-plane smoke infers production environment from URL", async () => {
  const options = await resolveOptions(
    {
      dryRun: true,
      url: "https://app.takosumi.com",
      space: "@smoke-production",
      cloudflareAccountId: "account",
      cloudflareWorkersSubdomain: "takosumi-smoke",
    },
    {
      TAKOSUMI_ACCOUNT_SESSION_TOKEN: "session-token",
      CLOUDFLARE_API_TOKEN: "cloudflare-token",
    },
  );

  expect(options.environment).toBe("production-smoke");
});

test("platform control-plane smoke can include backup restore rehearsal in dry-run", async () => {
  const options = await resolveOptions(
    {
      dryRun: true,
      backupRestoreRehearsal: true,
      url: "https://app-staging.takosumi.com",
      space: "space_test",
      appName: "takosumi-smoke-test",
      cloudflareAccountId: "account",
      cloudflareWorkersSubdomain: "takosumi-smoke",
    },
    {
      TAKOSUMI_ACCOUNT_SESSION_TOKEN: "session-token",
      CLOUDFLARE_API_TOKEN: "cloudflare-token",
    },
  );

  const result = dryRunResult(options);

  expect(result.steps).toEqual([
    "spaceScopedProviderConnection",
    "connectionVerified",
    "scratchInstall",
    "plan",
    "apply",
    "deploymentVerified",
    "publicUrlVerified",
    "deploymentLedgerVerified",
    "backupRestoreRehearsal",
    "destroy",
    "connectionRevoked",
  ]);
  expect(result.backupRestoreRehearsal).toMatchObject({
    backupId: "bkp_dry_run",
    restoreRunId: "restore_dry_run",
    restoreTargetSmoke: "passed",
  });
});

test("platform control-plane smoke can require release activation evidence", async () => {
  const options = await resolveOptions(
    {
      dryRun: true,
      requireReleaseActivation: "succeeded",
      url: "https://app-staging.takosumi.com",
      space: "@scratch",
      appName: "takosumi-release-smoke",
      cloudflareConnectionMode: "none",
      verificationMode: "opentofu",
    },
    {
      TAKOSUMI_ACCOUNT_SESSION_TOKEN: "session-token",
    },
  );

  const result = dryRunResult(options);

  expect(options.requireReleaseActivation).toBe("succeeded");
  expect(result.steps).toContain("releaseActivationVerified");
  expect(result.releaseActivation).toMatchObject({
    status: "succeeded",
    action: "release_activation.succeeded",
    runId: "apply_dry_run",
  });
});

test("platform control-plane smoke resolves secret sources from environment", async () => {
  const options = await resolveOptions(
    {
      dryRun: true,
      url: "https://app-staging.takosumi.com",
      space: "@scratch",
      cloudflareAccountId: "account",
    },
    {
      TAKOSUMI_ACCOUNT_SESSION_TOKEN: "session-token",
      CLOUDFLARE_API_TOKEN: "cloudflare-token",
      CLOUDFLARE_WORKERS_SUBDOMAIN: "takosumi-smoke",
    },
  );

  expect(options.accountSessionTokenSource).toBe("env");
  expect(options.cloudflareApiTokenSource).toBe("env");
  expect(options.cloudflareAccountIdSource).toBe("arg");
  expect(options.cloudflareWorkersSubdomainSource).toBe("env");
  expect(options.accountSessionToken).toBe("<redacted>");
  expect(options.cloudflareApiToken).toBe("<redacted>");
  expect(options.cloudflareAccountId).toBe("<redacted>");
  expect(options.cloudflareWorkersSubdomain).toBe("<redacted>");
});

test("platform control-plane smoke defaults providerless OpenTofu mode to a keyless capsule", async () => {
  const options = await resolveOptions(
    {
      dryRun: true,
      url: "https://app-staging.takosumi.com",
      space: "@scratch",
      appName: "takosumi-keyless-test",
      cloudflareConnectionMode: "none",
      verificationMode: "opentofu",
    },
    {
      TAKOSUMI_ACCOUNT_SESSION_TOKEN: "session-token",
    },
  );

  const result = dryRunResult(options);

  expect(result.capsuleModule).toBe("opentofu-basic");
  expect(result.providerConnectionMode).toBe("none");
  expect(result.credentialPath).toBe("none");
  expect(result.inputs.runnerProfileId).toBe("generic-opentofu-provider");
  expect(options.runnerProfileId).toBe("generic-opentofu-provider");
  expect(result.inputs.cloudflareApiTokenSource).toBe("not_required");
  expect(result.inputs.cloudflareAccountIdSource).toBe("not_required");
  expect(options.vars).toEqual({
    name: "takosumi-keyless-test",
    base_url: "https://example.invalid/takosumi-keyless-test",
  });
  expect(result.steps).toEqual([
    "providerConnectionNotRequired",
    "scratchInstall",
    "plan",
    "apply",
    "opentofuApplyVerified",
    "deploymentLedgerVerified",
    "destroy",
  ]);
});

test("platform control-plane smoke cleanup only marks failed pending upload remnants", () => {
  expect(
    shouldMarkPendingSmokeInstallationError(
      {
        id: "inst_pending",
        name: "takosumi-smoke-test",
        status: "pending",
        currentStateGeneration: 0,
      },
      "takosumi-smoke-test",
    ),
  ).toBe(true);
  expect(
    shouldMarkPendingSmokeInstallationError(
      {
        id: "inst_active",
        name: "takosumi-smoke-test",
        status: "active",
        currentStateGeneration: 1,
      },
      "takosumi-smoke-test",
    ),
  ).toBe(false);
  expect(
    shouldMarkPendingSmokeInstallationError(
      {
        id: "inst_other",
        name: "other-app",
        status: "pending",
        currentStateGeneration: 0,
      },
      "takosumi-smoke-test",
    ),
  ).toBe(false);
});
