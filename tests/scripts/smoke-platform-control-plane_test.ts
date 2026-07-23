import { expect, test } from "bun:test";
import {
  PLATFORM_CONTROL_PLANE_SMOKE_KIND,
  capsuleFromLedgerResponse,
  createdCapsuleFromCreateResponse,
  dryRunResult,
  isSmokeProviderConnectionMatch,
  isSelectableCapsuleInstallConfig,
  resolveOptions,
  selectSmokeInstallConfigId,
  shouldMarkPendingSmokeCapsuleError,
  smokeSourceCompatibilityCheckBody,
  smokeSourceCapsuleCreateBody,
  smokeCloudflareProviderConnectionMatch,
  smokeWorkspaceCloudflareConnectionBody,
} from "../../scripts/smoke-platform-control-plane.ts";

test("platform smoke binds compatibility checks to the current Capsule", () => {
  const body = smokeSourceCompatibilityCheckBody({
    sourceSnapshotId: "snap_1",
    capsuleId: "cap_1",
    modulePath: "deploy/opentofu",
  });

  expect(body).toEqual({
    sourceSnapshotId: "snap_1",
    capsuleId: "cap_1",
    modulePath: "deploy/opentofu",
  });
  expect(body).not.toHaveProperty("installationId");
});

test("platform smoke can reproduce Store-backed managed Provider resolution", async () => {
  const storeMetadata = {
    source: {
      git: "https://github.com/tako0614/takos.git",
      path: "deploy/opentofu",
    },
    order: 1_000,
    surface: "service",
    kind: "worker",
    provider: "cloudflare",
    suggestedName: "takos",
    badge: { ja: "追加候補", en: "Installable" },
    name: { ja: "Takos", en: "Takos" },
    description: {
      ja: "AI workspace distribution を公開します。",
      en: "Deploys the Takos AI workspace distribution.",
    },
    inputs: [],
  } as const;
  const options = await resolveOptions(
    {
      dryRun: true,
      url: "https://app.takosumi.com",
      workspace: "ws_test",
      cloudflareConnectionMode: "none",
      verificationMode: "opentofu",
      sourceGitUrl: "https://github.com/tako0614/takos.git",
      modulePath: "deploy/opentofu",
      storeMetadataJson: JSON.stringify(storeMetadata),
    },
    { TAKOSUMI_ACCOUNT_SESSION_TOKEN: "session-token" },
  );

  expect(
    smokeSourceCapsuleCreateBody(options, {
      sourceId: "src_test",
      installConfigId: "cfg_generic",
    }),
  ).toMatchObject({
    sourceId: "src_test",
    installConfigId: "cfg_generic",
    modulePath: "deploy/opentofu",
    store: storeMetadata,
  });
  const result = dryRunResult(options);
  expect(result.inputs.storeMetadataDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
  expect(JSON.stringify(result)).not.toContain(
    "AI workspace distribution を公開します。",
  );
});

test("platform control-plane smoke dry-run is redacted and complete", async () => {
  const options = await resolveOptions(
    {
      dryRun: true,
      url: "https://app-staging.takosumi.com",
      workspace: "ws_test",
      appName: "takosumi-smoke-test",
      cloudflareAccountIdFile:
        "/operator/.secrets/staging/CLOUDFLARE_ACCOUNT_ID",
      cloudflareWorkersSubdomainFile:
        "/operator/.secrets/staging/CLOUDFLARE_WORKERS_SUBDOMAIN",
      sessionTokenFile:
        "/operator/.secrets/staging/TAKOSUMI_ACCOUNT_SESSION_TOKEN",
      cloudflareApiTokenFile: "/operator/.secrets/staging/CLOUDFLARE_API_TOKEN",
      cloudflareConnectionMode: "guided",
      verificationMode: "cloudflare-worker",
    },
    {},
  );

  const result = dryRunResult(options);
  const json = JSON.stringify(result);

  expect(result.kind).toBe(PLATFORM_CONTROL_PLANE_SMOKE_KIND);
  expect(result.status).toBe("dry_run");
  expect(result.environment).toBe("smoke");
  expect(result.capsuleModule).toBe("git-opentofu-capsule");
  expect(result.credentialPath).toBe("workspace_scoped_provider_connection");
  expect(result.steps).toEqual([
    "workspaceScopedProviderConnection",
    "connectionVerified",
    "sourceRegistered",
    "sourceSynced",
    "scratchInstall",
    "compatibilityChecked",
    "plan",
    "apply",
    "runtimeVerified",
    "publicUrlVerified",
    "stateVersionLedgerVerified",
    "destroy",
    "connectionRevoked",
  ]);
  expect(result.workerUrl).toBe(
    "https://takosumi-smoke-test.<redacted>.workers.dev",
  );
  expect(result.publicUrlVerified).toBe(true);
  expect(result.stateVersionLedgerVerified).toBe(true);
  expect(result.destroyVerified).toBe(true);
  expect(result.connectionRevoked).toBe(true);
  expect(result.stateVersionLedger).toEqual({
    capsuleStatus: "active",
    stateVersionId: "state_dry_run",
    generation: 1,
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

test("platform control-plane smoke keeps the Capsule name independent from OpenTofu variable names", async () => {
  const projectOptions = await resolveOptions(
    {
      dryRun: true,
      url: "https://app-staging.takosumi.com",
      workspace: "ws_test",
      cloudflareAccountId: "account",
      cloudflareWorkersSubdomain: "takosumi-smoke",
      varsJson: JSON.stringify({
        project_name: "takos-from-project",
        cloudflare: { account_id: "account" },
      }),
    },
    {
      TAKOSUMI_ACCOUNT_SESSION_TOKEN: "session-token",
      CLOUDFLARE_API_TOKEN: "cloudflare-token",
    },
  );
  expect(projectOptions.appName).toMatch(/^takosumi-smoke-[a-z0-9]+$/u);
  expect(projectOptions.appName).not.toBe("takos-from-project");

  const workerOptions = await resolveOptions(
    {
      dryRun: true,
      url: "https://app-staging.takosumi.com",
      workspace: "ws_test",
      cloudflareAccountId: "account",
      cloudflareWorkersSubdomain: "takosumi-smoke",
      varsJson: JSON.stringify({
        worker_name: "worker-from-vars",
      }),
    },
    {
      TAKOSUMI_ACCOUNT_SESSION_TOKEN: "session-token",
      CLOUDFLARE_API_TOKEN: "cloudflare-token",
    },
  );
  expect(workerOptions.appName).toMatch(/^takosumi-smoke-[a-z0-9]+$/u);
  expect(workerOptions.appName).not.toBe("worker-from-vars");

  const explicitOptions = await resolveOptions(
    {
      dryRun: true,
      url: "https://app-staging.takosumi.com",
      workspace: "ws_test",
      appName: "explicit-name",
      cloudflareAccountId: "account",
      cloudflareWorkersSubdomain: "takosumi-smoke",
      varsJson: JSON.stringify({
        project_name: "takos-from-project",
        worker_name: "worker-from-vars",
      }),
    },
    {
      TAKOSUMI_ACCOUNT_SESSION_TOKEN: "session-token",
      CLOUDFLARE_API_TOKEN: "cloudflare-token",
    },
  );
  expect(explicitOptions.appName).toBe("explicit-name");
});

test("platform control-plane smoke reads current Capsule create responses", () => {
  expect(
    createdCapsuleFromCreateResponse({
      capsule: { id: "inst_current", name: "current capsule" },
    }),
  ).toEqual({ id: "inst_current", name: "current capsule" });
  expect(() =>
    createdCapsuleFromCreateResponse({
      installation: { id: "inst_legacy", name: "legacy capsule" },
    } as never),
  ).toThrow("capsule create response did not include id");
  expect(() => createdCapsuleFromCreateResponse({ capsule: {} })).toThrow(
    "capsule create response did not include id",
  );
});

test("platform control-plane smoke reads current Capsule ledger responses", () => {
  expect(
    capsuleFromLedgerResponse({
      capsule: {
        id: "cap_current",
        workspaceId: "ws_current",
        currentStateVersionId: "state_current",
        currentStateGeneration: 1,
        status: "active",
      },
    }),
  ).toEqual({
    id: "cap_current",
    workspaceId: "ws_current",
    currentStateVersionId: "state_current",
    currentStateGeneration: 1,
    status: "active",
  });
  expect(() =>
    capsuleFromLedgerResponse({
      installation: {
        id: "inst_legacy",
        spaceId: "space_legacy",
        currentStateVersionId: "dep_legacy",
        currentStateGeneration: 1,
        status: "active",
      },
    } as never),
  ).toThrow("capsule ledger response did not include capsule");
  expect(() => capsuleFromLedgerResponse({})).toThrow(
    "capsule ledger response did not include capsule",
  );
});

test("platform control-plane smoke matches canonical provider connection sources", () => {
  const expected = smokeCloudflareProviderConnectionMatch(
    "Layer-2 smoke canonical",
  );

  expect(expected.provider).toBe(
    "registry.opentofu.org/cloudflare/cloudflare",
  );

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
  ).toBe(false);
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

test("platform control-plane smoke creates Provider Connections through installed Credential Recipes", () => {
  const genericEnvOptions = {
    cloudflareConnectionMode: "generic-env" as const,
    cloudflareApiToken: "cloudflare-token",
    cloudflareAccountId: "account",
    cloudflareWorkersSubdomain: "takosumi-smoke",
  };

  expect(
    smokeWorkspaceCloudflareConnectionBody(
      genericEnvOptions,
      "ws_test",
      "Layer-2 smoke canonical",
    ),
  ).toEqual({
    workspaceId: "ws_test",
    provider: "registry.opentofu.org/cloudflare/cloudflare",
    credentialRecipe: {
      id: "generic-env",
      authMode: "env",
      secretPartition: "provider-credentials",
    },
    displayName: "Layer-2 smoke canonical",
    scopeHints: {
      accountId: "account",
      workersSubdomain: "takosumi-smoke",
    },
    values: {
      CLOUDFLARE_API_TOKEN: "cloudflare-token",
      CLOUDFLARE_ACCOUNT_ID: "account",
    },
  });

  expect(
    smokeWorkspaceCloudflareConnectionBody(
      { ...genericEnvOptions, cloudflareConnectionMode: "guided" },
      "ws_test",
      "Layer-2 smoke canonical",
    ),
  ).toMatchObject({
    provider: "registry.opentofu.org/cloudflare/cloudflare",
    credentialRecipe: {
      id: "cloudflare",
      authMode: "api_token",
      secretPartition: "provider-credentials",
    },
    values: { CLOUDFLARE_API_TOKEN: "cloudflare-token" },
  });
});

test("platform control-plane smoke does not infer operator environment from URL", async () => {
  const options = await resolveOptions(
    {
      dryRun: true,
      url: "https://app.takosumi.com",
      workspace: "@smoke-production",
      cloudflareAccountId: "account",
      cloudflareWorkersSubdomain: "takosumi-smoke",
    },
    {
      TAKOSUMI_ACCOUNT_SESSION_TOKEN: "session-token",
      CLOUDFLARE_API_TOKEN: "cloudflare-token",
    },
  );

  expect(options.environment).toBe("smoke");

  const explicit = await resolveOptions(
    {
      dryRun: true,
      url: "https://operator.example.test",
      workspace: "@smoke-production",
      environment: "production",
      cloudflareAccountId: "account",
      cloudflareWorkersSubdomain: "takosumi-smoke",
    },
    {
      TAKOSUMI_ACCOUNT_SESSION_TOKEN: "session-token",
      CLOUDFLARE_API_TOKEN: "cloudflare-token",
    },
  );
  expect(explicit.environment).toBe("production");
});

test("platform control-plane smoke never infers auth authority from token prefixes", async () => {
  const sharedArgs = {
    url: "https://app-staging.takosumi.com",
    workspace: "ws_test",
    cloudflareConnectionMode: "none",
    verificationMode: "opentofu",
    sourceGitUrl: "https://github.example/takosumi/smoke-fixture.git",
  } as const;

  const sessionOptions = await resolveOptions(sharedArgs, {
    TAKOSUMI_ACCOUNT_SESSION_TOKEN: "opaque-token-with-no-session-prefix",
  });
  expect(sessionOptions.accountAuthTokenKind).toBe("session");
  expect(sessionOptions.accountSessionToken).toBe(
    "opaque-token-with-no-session-prefix",
  );

  const patOptions = await resolveOptions(sharedArgs, {
    TAKOSUMI_ACCOUNT_PAT_TOKEN: "another-opaque-token-with-no-pat-prefix",
  });
  expect(patOptions.accountAuthTokenKind).toBe("pat");
  expect(patOptions.accountSessionToken).toBe(
    "another-opaque-token-with-no-pat-prefix",
  );
});

test("platform control-plane smoke records Cloudflare D1 resource preflight", async () => {
  const options = await resolveOptions(
    {
      dryRun: true,
      url: "https://app-staging.takosumi.com",
      workspace: "@scratch",
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
      workspace: "@scratch",
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
      "cloudflare.workers.script.list",
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
      workspace: "@scratch",
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
      workspace: "ws_test",
      appName: "takosumi-smoke-test",
    },
    {
      TAKOSUMI_ACCOUNT_SESSION_TOKEN: "session-token",
    },
  );

  const result = dryRunResult(options);

  expect(result.steps).toEqual([
    "providerConnectionNotRequired",
    "sourceRegistered",
    "sourceSynced",
    "scratchInstall",
    "compatibilityChecked",
    "plan",
    "apply",
    "opentofuApplyVerified",
    "stateVersionLedgerVerified",
    "backupRestoreRehearsal",
    "destroy",
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
      workspace: "@scratch",
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
      workspace: "@scratch",
      cloudflareAccountId: "account",
      cloudflareConnectionMode: "guided",
      verificationMode: "cloudflare-worker",
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
      workspace: "@scratch",
      appName: "takosumi-keyless-test",
    },
    {
      TAKOSUMI_ACCOUNT_SESSION_TOKEN: "session-token",
    },
  );

  const result = dryRunResult(options);

  expect(result.capsuleModule).toBe("git-opentofu-capsule");
  expect(result.providerConnectionMode).toBe("none");
  expect(result.credentialPath).toBe("none");
  expect(result.inputs.runnerProfileId).toBe("opentofu-default");
  expect(options.runnerProfileId).toBe("opentofu-default");
  expect(result.inputs.cloudflareApiTokenSource).toBe("not_required");
  expect(result.inputs.cloudflareAccountIdSource).toBe("not_required");
  expect(result.inputs.outputAllowlistNames).toEqual([
    "example_endpoint",
    "example_label",
  ]);
  expect(options.sourceRef).toBeUndefined();
  expect(result.inputs).not.toHaveProperty("sourceRef");
  expect(options.vars).toEqual({
    name: "takosumi-keyless-test",
    base_url: "https://takosumi-keyless-test.example.invalid",
  });
  expect(result.steps).toEqual([
    "providerConnectionNotRequired",
    "sourceRegistered",
    "sourceSynced",
    "scratchInstall",
    "compatibilityChecked",
    "plan",
    "apply",
    "opentofuApplyVerified",
    "stateVersionLedgerVerified",
    "destroy",
  ]);
});

test("platform control-plane smoke can require public URL checks for generic OpenTofu Capsules", async () => {
  const options = await resolveOptions(
    {
      dryRun: true,
      url: "https://app-staging.takosumi.com",
      workspace: "@scratch",
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
    "compatibilityChecked",
    "plan",
    "apply",
    "opentofuApplyVerified",
    "stateVersionLedgerVerified",
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

test("platform control-plane smoke only reads provider verification Outputs through explicit projection names", async () => {
  const options = await resolveOptions(
    {
      dryRun: true,
      url: "https://app-staging.takosumi.com",
      workspace: "@scratch",
      appName: "explicit-runtime",
      cloudflareConnectionMode: "guided",
      verificationMode: "cloudflare-worker",
      cloudflareAccountId: "account",
      cloudflareWorkersSubdomain: "takosumi-smoke",
      outputAllowlistJson: JSON.stringify({
        endpoint_for_probe: {
          from: "arbitrary_endpoint",
          type: "url",
          required: true,
        },
        resource_for_probe: {
          from: "arbitrary_resource_name",
          type: "string",
          required: true,
        },
      }),
      runtimePublicUrlOutput: "endpoint_for_probe",
      cloudflareWorkerNameOutput: "resource_for_probe",
    },
    {
      TAKOSUMI_ACCOUNT_SESSION_TOKEN: "session-token",
      CLOUDFLARE_API_TOKEN: "cloudflare-token",
    },
  );

  expect(options.runtimePublicUrlOutput).toBe("endpoint_for_probe");
  expect(options.cloudflareWorkerNameOutput).toBe("resource_for_probe");
  expect(dryRunResult(options).inputs).toMatchObject({
    runtimePublicUrlOutput: "endpoint_for_probe",
    cloudflareWorkerNameOutput: "resource_for_probe",
  });
});

test("platform control-plane smoke rejects implicit or mistyped provider verification Output mappings", async () => {
  const base = {
    dryRun: true,
    url: "https://app-staging.takosumi.com",
    workspace: "@scratch",
    cloudflareConnectionMode: "none",
    verificationMode: "opentofu",
    outputAllowlistJson: JSON.stringify({
      endpoint_for_probe: { from: "endpoint", type: "url", required: true },
    }),
  } as const;

  await expect(
    resolveOptions(
      { ...base, runtimePublicUrlOutput: "unlisted_endpoint" },
      { TAKOSUMI_ACCOUNT_SESSION_TOKEN: "session-token" },
    ),
  ).rejects.toThrow(
    "--runtime-public-url-output must also be in the output allowlist",
  );
  await expect(
    resolveOptions(
      {
        ...base,
        cloudflareWorkerNameOutput: "endpoint_for_probe",
      },
      { TAKOSUMI_ACCOUNT_SESSION_TOKEN: "session-token" },
    ),
  ).rejects.toThrow(
    "--cloudflare-worker-name-output must reference an output projected as string",
  );
});

test("platform control-plane smoke rejects untyped output allowlist entries before live API calls", async () => {
  await expect(
    resolveOptions(
      {
        dryRun: true,
        url: "https://app-staging.takosumi.com",
        workspace: "@scratch",
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

test("platform control-plane smoke selects InstallConfig from explicit structure, not ids or retired aliases", () => {
  expect(
    isSelectableCapsuleInstallConfig({
      id: "icfg_0123456789abcdef",
      workspaceId: "ws_current",
      name: "workspace config",
    }),
  ).toBe(true);
  expect(
    isSelectableCapsuleInstallConfig({
      id: "any-id-shape",
      internal: { reason: "per_install_overrides" },
      name: "internal override",
    }),
  ).toBe(false);
  expect(
    isSelectableCapsuleInstallConfig({
      id: "generic-opentofu-capsule",
      name: "Generic OpenTofu Capsule",
    }),
  ).toBe(true);

  expect(
    selectSmokeInstallConfigId([
      { id: "workspace-config", workspaceId: "ws_current" },
    ]),
  ).toBe("workspace-config");
  expect(
    selectSmokeInstallConfigId(
      [{ id: "one" }, { id: "two" }],
      "two",
    ),
  ).toBe("two");
  expect(() =>
    selectSmokeInstallConfigId([{ id: "one" }, { id: "two" }]),
  ).toThrow(
    "multiple selectable Capsule install configs are available; set --install-config-id explicitly",
  );
});

test("platform control-plane smoke uses configured public checks for app Workers", async () => {
  const options = await resolveOptions(
    {
      dryRun: true,
      url: "https://app-staging.takosumi.com",
      workspace: "@scratch",
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

  expect(result.steps).toContain("runtimeVerified");
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

test("platform control-plane smoke does not infer Cloudflare resource verification from ordinary Outputs", async () => {
  const options = await resolveOptions(
    {
      dryRun: true,
      url: "https://app-staging.takosumi.com",
      workspace: "@scratch",
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
    "workspaceScopedProviderConnection",
    "connectionVerified",
    "sourceRegistered",
    "sourceSynced",
    "scratchInstall",
    "compatibilityChecked",
    "plan",
    "apply",
    "opentofuApplyVerified",
    "stateVersionLedgerVerified",
    "publicUrlVerified",
    "destroy",
    "connectionRevoked",
  ]);
  expect(result.workerUrl).toBe("");
  expect(result.runtimeVerified).toBe(false);
  expect(result.publicUrlVerified).toBe(true);
});

test("platform control-plane smoke cleanup only marks failed pending upload remnants", () => {
  expect(
    shouldMarkPendingSmokeCapsuleError(
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
    shouldMarkPendingSmokeCapsuleError(
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
    shouldMarkPendingSmokeCapsuleError(
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
