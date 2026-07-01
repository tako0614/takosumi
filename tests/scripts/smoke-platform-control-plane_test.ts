import { expect, test } from "bun:test";
import {
  PLATFORM_CONTROL_PLANE_SMOKE_KIND,
  capsuleFromLedgerResponse,
  createdCapsuleFromCreateResponse,
  dryRunResult,
  isSmokeProviderConnectionMatch,
  isSelectableGenericCapsuleInstallConfig,
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
  expect(result.capsuleModule).toBe("git-opentofu-capsule");
  expect(result.credentialPath).toBe("space_scoped_provider_connection");
  expect(result.steps).toEqual([
    "spaceScopedProviderConnection",
    "connectionVerified",
    "sourceRegistered",
    "sourceSynced",
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

test("platform control-plane smoke reads current Capsule create responses", () => {
  expect(
    createdCapsuleFromCreateResponse({
      capsule: { id: "inst_current", name: "current capsule" },
    }),
  ).toEqual({ id: "inst_current", name: "current capsule" });
  expect(
    createdCapsuleFromCreateResponse({
      installation: { id: "inst_legacy", name: "legacy capsule" },
    }),
  ).toEqual({ id: "inst_legacy", name: "legacy capsule" });
  expect(() => createdCapsuleFromCreateResponse({ capsule: {} })).toThrow(
    "capsule create response did not include id",
  );
});

test("platform control-plane smoke reads current Capsule ledger responses", () => {
  expect(
    capsuleFromLedgerResponse({
      capsule: {
        id: "cap_current",
        workspaceId: "space_current",
        currentStateVersionId: "state_current",
        currentStateGeneration: 1,
        status: "active",
      },
    }),
  ).toEqual({
    id: "cap_current",
    workspaceId: "space_current",
    currentStateVersionId: "state_current",
    currentStateGeneration: 1,
    status: "active",
  });
  expect(
    capsuleFromLedgerResponse({
      installation: {
        id: "inst_legacy",
        spaceId: "space_legacy",
        currentDeploymentId: "dep_legacy",
        currentStateGeneration: 1,
        status: "active",
      },
    }),
  ).toEqual({
    id: "inst_legacy",
    spaceId: "space_legacy",
    currentDeploymentId: "dep_legacy",
    currentStateGeneration: 1,
    status: "active",
  });
  expect(() => capsuleFromLedgerResponse({})).toThrow(
    "capsule ledger response did not include capsule",
  );
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

test("platform control-plane smoke records Cloudflare D1 resource preflight", async () => {
  const options = await resolveOptions(
    {
      dryRun: true,
      url: "https://app-staging.takosumi.com",
      space: "@scratch",
      cloudflareResourcePreflight: "d1",
      cloudflareAccountId: "account",
      cloudflareWorkersSubdomain: "takosumi-smoke",
    },
    {
      TAKOSUMI_ACCOUNT_SESSION_TOKEN: "session-token",
      CLOUDFLARE_API_TOKEN: "cloudflare-token",
    },
  );

  const result = dryRunResult(options);

  expect(result.inputs.cloudflareResourcePreflight).toBe("d1");
  expect(result.steps).toContain("cloudflareResourcePreflight");
  expect(result.completedSteps).toContain("cloudflareResourcePreflight");
  expect(result.cloudflareResourcePreflight).toEqual({
    mode: "d1",
    status: "passed",
    checks: ["cloudflare.d1.database.list"],
  });
});

test("platform control-plane smoke records Cloudflare account resource preflight", async () => {
  const options = await resolveOptions(
    {
      dryRun: true,
      url: "https://app-staging.takosumi.com",
      space: "@scratch",
      cloudflareResourcePreflight: "account-resources",
      cloudflareAccountId: "account",
      cloudflareWorkersSubdomain: "takosumi-smoke",
    },
    {
      TAKOSUMI_ACCOUNT_SESSION_TOKEN: "session-token",
      CLOUDFLARE_API_TOKEN: "cloudflare-token",
    },
  );

  const result = dryRunResult(options);

  expect(result.inputs.cloudflareResourcePreflight).toBe("account-resources");
  expect(result.steps).toContain("cloudflareResourcePreflight");
  expect(result.completedSteps).toContain("cloudflareResourcePreflight");
  expect(result.cloudflareResourcePreflight).toEqual({
    mode: "account-resources",
    status: "passed",
    checks: [
      "cloudflare.d1.database.list",
      "cloudflare.kv.namespace.list",
      "cloudflare.r2.bucket.list",
      "cloudflare.queue.list",
      "cloudflare.workflow.list",
      "cloudflare.vectorize.index.list",
    ],
  });
});

test("platform control-plane smoke labels Git sources as Git OpenTofu Capsules", async () => {
  const options = await resolveOptions(
    {
      dryRun: true,
      url: "https://app-staging.takosumi.com",
      space: "@scratch",
      sourceGitUrl: "https://github.com/tako0614/takos.git",
      sourceRef: "main",
      sourcePath: "deploy/opentofu",
      cloudflareConnectionMode: "none",
      verificationMode: "opentofu",
    },
    {
      TAKOSUMI_ACCOUNT_SESSION_TOKEN: "session-token",
    },
  );

  expect(dryRunResult(options).capsuleModule).toBe("git-opentofu-capsule");
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
    "sourceRegistered",
    "sourceSynced",
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

  expect(result.capsuleModule).toBe("git-opentofu-capsule");
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
    "sourceRegistered",
    "sourceSynced",
    "scratchInstall",
    "plan",
    "apply",
    "opentofuApplyVerified",
    "deploymentLedgerVerified",
    "destroy",
  ]);
});

test("platform control-plane smoke can require public URL checks for generic OpenTofu Capsules", async () => {
  const options = await resolveOptions(
    {
      dryRun: true,
      url: "https://app-staging.takosumi.com",
      space: "@scratch",
      appName: "takosumi-public-url-test",
      cloudflareConnectionMode: "none",
      verificationMode: "opentofu",
      outputAllowlistJson: JSON.stringify({
        launch_url: { from: "launch_url", type: "url", required: true },
      }),
      publicUrlChecksJson: JSON.stringify([
        {
          name: "launch",
          output: "launch_url",
          path: "/healthz",
          expectedStatus: 204,
          bodyIncludes: ["ok"],
        },
      ]),
    },
    {
      TAKOSUMI_ACCOUNT_SESSION_TOKEN: "session-token",
    },
  );

  const result = dryRunResult(options);

  expect(options.publicUrlChecks).toEqual([
    {
      name: "launch",
      output: "launch_url",
      path: "/healthz",
      expectedStatus: 204,
      bodyIncludes: ["ok"],
    },
  ]);
  expect(result.steps).toEqual([
    "providerConnectionNotRequired",
    "sourceRegistered",
    "sourceSynced",
    "scratchInstall",
    "plan",
    "apply",
    "opentofuApplyVerified",
    "deploymentLedgerVerified",
    "publicUrlVerified",
    "destroy",
  ]);
  expect(result.publicUrlVerified).toBe(true);
  expect(result.publicUrlChecks).toEqual([
    {
      name: "launch",
      output: "launch_url",
      url: "https://example.invalid/healthz",
      status: 204,
      ok: true,
      bodyIncludes: ["ok"],
      bodyDigest: `sha256:${"0".repeat(64)}`,
    },
  ]);
  expect(result.inputs.publicUrlCheckNames).toEqual(["launch"]);
});

test("platform control-plane smoke rejects untyped output allowlist entries before live API calls", async () => {
  await expect(
    resolveOptions(
      {
        dryRun: true,
        url: "https://app-staging.takosumi.com",
        space: "@scratch",
        appName: "takosumi-untyped-output-test",
        cloudflareConnectionMode: "none",
        verificationMode: "opentofu",
        outputAllowlistJson: JSON.stringify({
          launch_url: { from: "launch_url", required: true },
        }),
      },
      {
        TAKOSUMI_ACCOUNT_SESSION_TOKEN: "session-token",
      },
    ),
  ).rejects.toThrow(
    "output allowlist launch_url.type must be one of string, url, hostname, number, boolean, json",
  );
});

test("platform control-plane smoke ignores scoped generic Capsule config remnants", () => {
  expect(
    isSelectableGenericCapsuleInstallConfig({
      id: "icfg_0123456789abcdef",
      sourceKind: "generic_capsule",
      spaceId: "space_old",
      name: "old-upload",
    }),
  ).toBe(false);
  expect(
    isSelectableGenericCapsuleInstallConfig({
      id: "icfg_0123456789abcdef",
      sourceKind: "generic_capsule",
      workspaceId: "space_old",
      name: "old-config",
    }),
  ).toBe(false);
  expect(
    isSelectableGenericCapsuleInstallConfig({
      id: "generic-opentofu-capsule",
      sourceKind: "generic_capsule",
      name: "Generic OpenTofu Capsule",
    }),
  ).toBe(true);
});

test("platform control-plane smoke uses configured public checks for app Workers", async () => {
  const options = await resolveOptions(
    {
      dryRun: true,
      url: "https://app-staging.takosumi.com",
      space: "@scratch",
      appName: "takos-app-public-url-test",
      cloudflareConnectionMode: "generic-env",
      verificationMode: "cloudflare-worker",
      cloudflareAccountId: "account",
      cloudflareWorkersSubdomain: "takosumi-smoke",
      outputAllowlistJson: JSON.stringify({
        url: { from: "url", type: "url", required: true },
        worker_name: { from: "worker_name", type: "string", required: true },
      }),
      publicUrlChecksJson: JSON.stringify([
        {
          name: "health",
          output: "url",
          path: "/health",
          expectedStatus: 200,
          bodyIncludes: ['"status":"ok"'],
        },
      ]),
    },
    {
      TAKOSUMI_ACCOUNT_SESSION_TOKEN: "session-token",
      CLOUDFLARE_API_TOKEN: "cloudflare-token",
    },
  );

  const result = dryRunResult(options);

  expect(result.steps).toContain("deploymentVerified");
  expect(result.steps).toContain("publicUrlVerified");
  expect(result.publicUrlVerified).toBe(true);
  expect(result.publicUrlChecks).toEqual([
    {
      name: "health",
      output: "url",
      url: "https://example.invalid/health",
      status: 200,
      ok: true,
      bodyIncludes: ['"status":"ok"'],
      bodyDigest: `sha256:${"0".repeat(64)}`,
    },
  ]);
});

test("platform control-plane smoke verifies Cloudflare script for OpenTofu app public checks", async () => {
  const options = await resolveOptions(
    {
      dryRun: true,
      url: "https://app-staging.takosumi.com",
      space: "@scratch",
      appName: "takos-opentofu-public-url-test",
      cloudflareConnectionMode: "guided",
      verificationMode: "opentofu",
      cloudflareAccountId: "account",
      cloudflareWorkersSubdomain: "takosumi-smoke",
      outputAllowlistJson: JSON.stringify({
        url: { from: "url", type: "url", required: true },
        worker_name: { from: "worker_name", type: "string", required: true },
      }),
      publicUrlChecksJson: JSON.stringify([
        {
          name: "health",
          output: "url",
          path: "/health",
          expectedStatus: 200,
          bodyIncludes: ['"status":"ok"'],
        },
      ]),
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
    "sourceRegistered",
    "sourceSynced",
    "scratchInstall",
    "plan",
    "apply",
    "opentofuApplyVerified",
    "deploymentVerified",
    "deploymentLedgerVerified",
    "publicUrlVerified",
    "destroy",
    "connectionRevoked",
  ]);
  expect(result.workerUrl).toBe(
    "https://takos-opentofu-public-url-test.<redacted>.workers.dev",
  );
  expect(result.deploymentVerified).toBe(true);
  expect(result.publicUrlVerified).toBe(true);
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
