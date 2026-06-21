import { expect, test } from "bun:test";
import {
  PLATFORM_CONTROL_PLANE_SMOKE_KIND,
  dryRunResult,
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
    "destroy",
  ]);
  expect(result.destroyVerified).toBe(true);
  expect(result.inputs.accountSessionTokenSource).toBe("file");
  expect(result.inputs.cloudflareApiTokenSource).toBe("file");
  expect(result.inputs.cloudflareAccountIdSource).toBe("file");
  expect(result.inputs.cloudflareAccountIdDigest).toMatch(
    /^sha256:[0-9a-f]{64}$/,
  );
  expect(json).not.toContain("cf-account-secret-ish");
  expect(json).not.toContain("CLOUDFLARE_ACCOUNT_ID");
  expect(json).not.toContain("TAKOSUMI_ACCOUNT_SESSION_TOKEN");
  expect(json).not.toContain("CLOUDFLARE_API_TOKEN");
});

test("platform control-plane smoke infers production environment from URL", async () => {
  const options = await resolveOptions(
    {
      dryRun: true,
      url: "https://app.takosumi.com",
      space: "@smoke-production",
      cloudflareAccountId: "account",
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
    "backupRestoreRehearsal",
    "destroy",
  ]);
  expect(result.backupRestoreRehearsal).toMatchObject({
    backupId: "bkp_dry_run",
    restoreRunId: "restore_dry_run",
    restoreTargetSmoke: "passed",
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
    },
  );

  expect(options.accountSessionTokenSource).toBe("env");
  expect(options.cloudflareApiTokenSource).toBe("env");
  expect(options.cloudflareAccountIdSource).toBe("arg");
  expect(options.accountSessionToken).toBe("<redacted>");
  expect(options.cloudflareApiToken).toBe("<redacted>");
  expect(options.cloudflareAccountId).toBe("<redacted>");
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
