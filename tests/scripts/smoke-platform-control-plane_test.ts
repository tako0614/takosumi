import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import {
  CLOUDFLARE_PUBLIC_URL_PROPAGATION_TIMEOUT_MS,
  EXTERNAL_DESTROY_VERIFICATION_KIND,
  EXTERNAL_DESTROY_VERIFIER_RESULT_KIND,
  PLATFORM_CONTROL_PLANE_SMOKE_KIND,
  createExternalDestroyEvidenceVerifier,
  assertInterfaceMaterialization,
  assertInterfacesRetired,
  assertSmokeSerializationSafe,
  capsuleFromLedgerResponse,
  canonicalRunEventSequenceFromActivity,
  createdCapsuleFromCreateResponse,
  defaultHelloWorkerInterfaceBlueprint,
  dryRunResult,
  failedResult,
  isSmokeProviderConnectionMatch,
  isSelectableCapsuleInstallConfig,
  interfaceMaterializationEvidence,
  main,
  projectDestroyEvidencePublicOutputs,
  resolveSmokeProviderBindingsFromCompatibility,
  resolveOptions,
  runPlatformControlPlaneSmoke,
  selectSmokeInstallConfigId,
  shouldMarkPendingSmokeCapsuleError,
  smokeCapsuleProviderBindingsBody,
  smokeSourceCompatibilityCheckBody,
  smokeSourceCapsuleCreateBody,
  smokeCloudflareProviderConnectionMatch,
  smokeWorkspaceCloudflareConnectionBody,
  assertServiceIdentityResponse,
} from "../../scripts/smoke-platform-control-plane.ts";
import type { DestroyEvidenceVerifier } from "../../scripts/smoke-platform-control-plane.ts";

const EXTERNAL_DESTROY_CHECK_NAMES = [
  "module_worker",
  "worker_bundle",
  "worker_version",
  "worker_deployment",
  "worker_endpoint",
] as const;

async function writeDestroyVerifierScript(
  root: string,
  source: string,
): Promise<string> {
  const script = join(root, "destroy-verifier.js");
  await writeFile(script, source, { mode: 0o700 });
  return script;
}

function destroyVerifierResultSource(
  checks: readonly string[] = EXTERNAL_DESTROY_CHECK_NAMES,
): string {
  return `const fs = require("node:fs");\nconst inputFlag = process.argv[2];\nconst inputPath = process.argv[3];\nif (inputFlag !== "--input-file" || !inputPath) process.exit(9);\nconst input = JSON.parse(fs.readFileSync(inputPath, "utf8"));\nif (process.env.CAPTURE_FILE) fs.writeFileSync(process.env.CAPTURE_FILE, JSON.stringify({argv: process.argv.slice(2), env: process.env, input, inputMode: fs.statSync(inputPath).mode & 0o777}));\nconsole.log(JSON.stringify({kind:${JSON.stringify(EXTERNAL_DESTROY_VERIFIER_RESULT_KIND)},verifierId:input.verifierId,scriptDigest:input.scriptDigest,checks:${JSON.stringify(checks.map((name) => ({name,status: "passed"})))}}));\n`;
}

async function destroyVerifierFixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "takosumi-destroy-verifier-test-"));
  await chmod(root, 0o700);
  return root;
}

function destroyVerifierInputFixture() {
  return {
    capsuleId: "cap_external_verifier",
    destroyPlanRunId: "run_destroy_plan_external_verifier",
    destroyApplyRunId: "run_destroy_apply_external_verifier",
    publicOutputs: {
      resource_identities: {
        module_worker: { name: "worker", uid: "uid-worker" },
      },
      endpoint_url: "https://worker.example.test",
    },
  } as const;
}

test("platform smoke preserves the original pre-apply failure when a projected runtime URL is configured", async () => {
  const options = await resolveOptions(
    {
      dryRun: true,
      url: "https://app-staging.takosumi.com",
      workspace: "ws_test",
      cloudflareConnectionMode: "guided",
      cloudflareAccountId: "acc_test",
      cloudflareWorkersSubdomain: "workers-subdomain",
      verificationMode: "cloudflare-worker",
      outputAllowlistJson: JSON.stringify({
        launch_url: { from: "launch_url", type: "url", required: true },
      }),
      runtimePublicUrlOutput: "launch_url",
    },
    {
      TAKOSUMI_ACCOUNT_SESSION_TOKEN: "session-token",
      CLOUDFLARE_API_TOKEN: "cloudflare-token",
    },
  );
  const startedAtMs = Date.now();
  const result = failedResult(options, {
    startedAt: new Date(startedAtMs).toISOString(),
    startedAtMs,
    workspaceId: "ws_test",
    completedSteps: ["sourceSynced"],
    stepTimings: [],
    runTimings: [],
    capsuleGateStatus: "not_reached",
    policyStatus: "not_reached",
    connectionRevoked: false,
    error: new Error("original source install failure"),
  });

  expect(result.status).toBe("failed");
  expect(result.workerUrl).toBe("");
  expect(result.error).toBe("original source install failure");
});

test("Cloudflare public URL verification allows bounded edge propagation", () => {
  expect(CLOUDFLARE_PUBLIC_URL_PROPAGATION_TIMEOUT_MS).toBe(180_000);
});

test("platform smoke materializes and retires the Plan-pinned Interface through public routes", async () => {
  const options = await resolveOptions(
    {
      url: "https://app-staging.takosumi.com",
      workspace: "ws_test",
      appName: "takosumi-interface-fixture",
      sourceGitUrl: "https://git.example.test/interface-fixture.git",
      cloudflareConnectionMode: "guided",
      verificationMode: "cloudflare-worker",
      cloudflareAccountId: "acc_test",
      cloudflareWorkersSubdomain: "workers.example.test",
      deployTimeoutSeconds: "1",
      pollIntervalMs: "1",
    },
    {
      TAKOSUMI_ACCOUNT_SESSION_TOKEN: "session-secret-fixture",
      CLOUDFLARE_API_TOKEN: "cloudflare-secret-fixture",
    },
  );
  const blueprint = options.interfaceBlueprints?.[0];
  expect(blueprint).toBeDefined();
  const outputDigest = `sha256:${"a".repeat(64)}`;
  const workerUrl = "https://worker.example.test";
  const iface = {
    apiVersion: "takosumi.dev/v1alpha1",
    kind: "Interface",
    metadata: {
      id: "if_fixture",
      workspaceId: "ws_test",
      name: blueprint!.name,
      ownerRef: { kind: "Capsule", id: "cap_fixture" },
      generation: 1,
      materializedFrom: { source: "capsule_blueprint", key: blueprint!.key },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    spec: {
      ...blueprint!.spec,
      inputs: {
        endpoint: {
          source: "capsule_output",
          capsuleId: "cap_fixture",
          outputName: "url",
        },
      },
    },
    status: {
      phase: "Resolved",
      observedGeneration: 1,
      resolvedRevision: 1,
      resolvedInputs: { endpoint: workerUrl },
      resourceUri: `${workerUrl}/`,
      provenance: {
        endpoint: {
          source: "capsule_output",
          runId: "run_apply",
          stateVersionId: "state_fixture",
          outputId: "out_fixture",
          outputDigest,
          outputName: "url",
        },
      },
    },
  } as const;
  const binding = {
    apiVersion: "takosumi.dev/v1alpha1",
    kind: "InterfaceBinding",
    metadata: {
      id: "ib_fixture",
      workspaceId: "ws_test",
      generation: 1,
      materializedFrom: {
        source: "capsule_blueprint",
        interfaceKey: blueprint!.key,
        key: blueprint!.bindings![0]!.key,
      },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    spec: {
      interfaceId: "if_fixture",
      subjectRef: { kind: "Principal", id: "principal_fixture" },
      permissions: ["mcp.invoke"],
      delivery: { type: "none" },
    },
    status: {
      phase: "Ready",
      observedInterfaceRevision: 1,
    },
  } as const;
  const ledger = {
    capsuleStatus: "active",
    stateVersionId: "state_fixture",
    generation: 3,
    applyRunId: "run_apply",
    outputId: "out_fixture",
    outputDigest,
    publicOutputNames: ["url"],
    publicOutputDigest: `sha256:${"b".repeat(64)}`,
    publicOutputs: { url: workerUrl },
  } as const;
  const originalFetch = globalThis.fetch;
  let retired = false;
  globalThis.fetch = (async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/v1/interfaces") {
      return Response.json({ interfaces: [retired ? { ...iface, status: { ...iface.status, phase: "Retired" } } : iface] });
    }
    if (url.pathname === "/api/v1/interfaces/if_fixture") {
      return Response.json(retired ? { ...iface, status: { ...iface.status, phase: "Retired" } } : iface);
    }
    if (url.pathname === "/api/v1/interfaces/if_fixture/bindings") {
      return Response.json({ bindings: [retired ? { ...binding, status: { ...binding.status, phase: "Revoked" } } : binding] });
    }
    if (url.pathname === "/api/v1/interfaces/if_fixture/bindings/ib_fixture") {
      return Response.json(retired ? { ...binding, status: { ...binding.status, phase: "Revoked" } } : binding);
    }
    if (url.href === `${workerUrl}/`) {
      return retired ? new Response("gone", { status: 404 }) : Response.json({ ok: true });
    }
    throw new Error(`unexpected Interface fixture request: ${url}`);
  }) as typeof fetch;
  try {
    const context = await assertInterfaceMaterialization(options, {
      workspaceId: "ws_test",
      capsuleId: "cap_fixture",
      stateVersionLedger: ledger,
    });
    expect(context.records).toHaveLength(1);
    expect(context.records[0]!.interface.metadata.id).toBe("if_fixture");
    expect(context.records[0]!.bindings[0]!.metadata.id).toBe("ib_fixture");
    retired = true;
    const retiredContext = await assertInterfacesRetired(options, context);
    expect(retiredContext.records[0]!.interface.status.phase).toBe("Retired");
    expect(retiredContext.records[0]!.bindings[0]!.status.phase).toBe("Revoked");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("platform smoke canonical Run events are redacted to ids and outcomes", () => {
  const sequence = canonicalRunEventSequenceFromActivity(
    [
      { id: "evt_plan", action: "run.plan_created", targetType: "run", targetId: "plan", runId: "plan", metadata: { capsuleId: "cap", operation: "plan", authorization: "Bearer secret" } },
      { id: "evt_apply", action: "run.applied", targetType: "run", targetId: "apply", runId: "apply", metadata: { capsuleId: "cap", stateVersionId: "state" } },
      { id: "evt_destroy_plan", action: "run.plan_created", targetType: "run", targetId: "destroy-plan", runId: "destroy-plan", metadata: { capsuleId: "cap", operation: "destroy" } },
      { id: "evt_destroy", action: "run.destroyed", targetType: "run", targetId: "destroy", runId: "destroy", metadata: { capsuleId: "cap" } },
    ],
    { capsuleId: "cap", planRunId: "plan", applyRunId: "apply", destroyPlanRunId: "destroy-plan", destroyApplyRunId: "destroy" },
  );
  expect(sequence?.plan.outcome).toBe("planned");
  expect(sequence?.apply.outcome).toBe("applied");
  expect(sequence?.destroyApply.outcome).toBe("destroyed");
  expect(JSON.stringify(sequence)).not.toContain("authorization");
  expect(() => assertSmokeSerializationSafe({ authorization: "Bearer secret-fixture" })).toThrow();
});

test("platform smoke optionally proves an OAuth Interface grant and post-destroy denial", async () => {
  const runtimeToken = "runtime-secret-fixture";
  const issuedToken = "issued-interface-secret-fixture";
  const optionsFromFile = await resolveOptions(
    {
      dryRun: true,
      url: "https://app-staging.takosumi.com",
      workspace: "ws_test",
      appName: "takosumi-interface-oauth-fixture",
      cloudflareConnectionMode: "none",
      verificationMode: "opentofu",
      interfaceBlueprintsJson: JSON.stringify([
        {
          key: "oauth-service",
          name: "oauth-service",
          spec: {
            type: "mcp.server",
            version: "2025-11-25",
            document: { transport: "streamable-http" },
            inputs: {
              endpoint: { source: "capsule_output", outputName: "url" },
            },
            access: { visibility: "workspace", resourceUriInput: "endpoint" },
          },
          bindings: [
            {
              key: "oauth-grant",
              subjectRef: { kind: "Principal", id: "principal_fixture" },
              permissions: ["mcp.invoke"],
              delivery: { type: "oauth2" },
            },
          ],
        },
      ]),
      interfaceTokenProof: true,
      interfaceRuntimeTokenFile: "/private/runtime-token",
      outputAllowlistJson: JSON.stringify({
        url: { from: "url", type: "url", required: true },
      }),
      deployTimeoutSeconds: "1",
      pollIntervalMs: "1",
    },
    { TAKOSUMI_ACCOUNT_SESSION_TOKEN: "session-secret-fixture" },
  );
  const options = {
    ...optionsFromFile,
    dryRun: false,
    interfaceRuntimeToken: runtimeToken,
  } as const;
  const blueprint = options.interfaceBlueprints![0]!;
  const outputDigest = `sha256:${"c".repeat(64)}`;
  const resource = "https://oauth-resource.example.test/";
  const iface = {
    apiVersion: "takosumi.dev/v1alpha1",
    kind: "Interface",
    metadata: {
      id: "if_oauth_fixture",
      workspaceId: "ws_test",
      name: blueprint.name,
      ownerRef: { kind: "Capsule", id: "cap_oauth_fixture" },
      generation: 1,
      materializedFrom: { source: "capsule_blueprint", key: blueprint.key },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    spec: {
      ...blueprint.spec,
      inputs: {
        endpoint: {
          source: "capsule_output",
          capsuleId: "cap_oauth_fixture",
          outputName: "url",
        },
      },
    },
    status: {
      phase: "Resolved",
      observedGeneration: 1,
      resolvedRevision: 1,
      resolvedInputs: { endpoint: resource },
      resourceUri: resource,
      provenance: {
        endpoint: {
          source: "capsule_output",
          runId: "run_apply",
          stateVersionId: "state_oauth_fixture",
          outputId: "out_oauth_fixture",
          outputDigest,
          outputName: "url",
        },
      },
    },
  } as const;
  const binding = {
    apiVersion: "takosumi.dev/v1alpha1",
    kind: "InterfaceBinding",
    metadata: {
      id: "ib_oauth_fixture",
      workspaceId: "ws_test",
      generation: 1,
      materializedFrom: {
        source: "capsule_blueprint",
        interfaceKey: blueprint.key,
        key: blueprint.bindings![0]!.key,
      },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    spec: {
      interfaceId: "if_oauth_fixture",
      subjectRef: { kind: "Principal", id: "principal_fixture" },
      permissions: ["mcp.invoke"],
      delivery: { type: "oauth2" },
    },
    status: { phase: "Ready", observedInterfaceRevision: 1 },
  } as const;
  const ledger = {
    capsuleStatus: "active",
    stateVersionId: "state_oauth_fixture",
    generation: 2,
    applyRunId: "run_apply",
    outputId: "out_oauth_fixture",
    outputDigest,
    publicOutputNames: ["url"],
    publicOutputDigest: `sha256:${"d".repeat(64)}`,
    publicOutputs: { url: resource },
  } as const;
  const originalFetch = globalThis.fetch;
  let retired = false;
  const mismatchedResource = "https://oauth-resource-mismatch.example.test/";
  let tokenResource = mismatchedResource;
  let mismatchedResourceFetches = 0;
  let reflectIssuedToken = false;
  let denyTransportUnavailable = false;
  globalThis.fetch = (async (input, init) => {
    const requestUrl = new URL(String(input));
    const requestPath = requestUrl.pathname;
    if (requestPath === "/api/v1/interfaces") {
      return Response.json({
        interfaces: [retired ? { ...iface, status: { ...iface.status, phase: "Retired" } } : iface],
      });
    }
    if (requestPath === "/api/v1/interfaces/if_oauth_fixture") {
      return Response.json(retired ? { ...iface, status: { ...iface.status, phase: "Retired" } } : iface);
    }
    if (requestPath === "/api/v1/interfaces/if_oauth_fixture/bindings") {
      return Response.json({
        bindings: [retired ? { ...binding, status: { ...binding.status, phase: "Revoked" } } : binding],
      });
    }
    if (requestPath === "/api/v1/interfaces/if_oauth_fixture/bindings/ib_oauth_fixture") {
      return Response.json(retired ? { ...binding, status: { ...binding.status, phase: "Revoked" } } : binding);
    }
    if (requestPath === "/api/v1/interfaces/if_oauth_fixture/token") {
      if (retired) return new Response("denied", { status: 403 });
      return Response.json({
        access_token: issuedToken,
        token_type: "Bearer",
        expires_in: 30,
        expires_at: "2026-01-01T00:00:30.000Z",
        scope: "mcp.invoke",
        resource: tokenResource,
      });
    }
    if (requestUrl.href === mismatchedResource) {
      mismatchedResourceFetches += 1;
      return Response.json({ ok: true });
    }
    if (requestUrl.href === resource) {
      const authorization = new Headers(init?.headers).get("authorization");
      if (
        retired &&
        denyTransportUnavailable &&
        authorization === `Bearer ${issuedToken}`
      ) {
        throw new Error("retired resource transport unavailable");
      }
      if (reflectIssuedToken && authorization === `Bearer ${issuedToken}`) {
        return new Response(`reflected credential ${issuedToken}`, {
          status: 500,
        });
      }
      return retired || authorization !== `Bearer ${issuedToken}`
        ? new Response("denied", { status: 401 })
        : Response.json({ ok: true });
    }
    throw new Error(`unexpected OAuth Interface fixture request: ${requestUrl}`);
  }) as typeof fetch;
  try {
    await expect(
      assertInterfaceMaterialization(options, {
        workspaceId: "ws_test",
        capsuleId: "cap_oauth_fixture",
        stateVersionLedger: ledger,
      }),
    ).rejects.toThrow(/canonical Interface resource/u);
    expect(mismatchedResourceFetches).toBe(0);

    tokenResource = resource;
    reflectIssuedToken = true;
    let reflectedFailure = "";
    try {
      await assertInterfaceMaterialization(options, {
        workspaceId: "ws_test",
        capsuleId: "cap_oauth_fixture",
        stateVersionLedger: ledger,
      });
    } catch (error) {
      reflectedFailure = error instanceof Error ? error.message : String(error);
    }
    expect(reflectedFailure).toContain("reflected credential");
    expect(reflectedFailure).not.toContain(issuedToken);
    reflectIssuedToken = false;

    const context = await assertInterfaceMaterialization(options, {
      workspaceId: "ws_test",
      capsuleId: "cap_oauth_fixture",
      stateVersionLedger: ledger,
    });
    expect(context.records[0]!.issuedToken?.token).toBe(issuedToken);
    expect(context.records[0]!.issuedToken?.permission).toBe("mcp.invoke");
    retired = true;
    denyTransportUnavailable = true;
    await expect(assertInterfacesRetired(options, context)).rejects.toThrow(
      "retired resource transport unavailable",
    );
    denyTransportUnavailable = false;
    const retiredContext = await assertInterfacesRetired(options, context);
    expect(retiredContext.records[0]!.tokenRevoked).toBe(true);
    expect(retiredContext.records[0]!.tokenUseDenied).toBe(true);
    const evidence = interfaceMaterializationEvidence(
      retiredContext.records[0]!,
    );
    expect(JSON.stringify(evidence)).not.toContain(issuedToken);
    expect(evidence.tokenProof?.tokenDigest).toMatch(/^sha256:/u);
    assertSmokeSerializationSafe(evidence, options);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("platform smoke failure redaction includes raw issued Interface access tokens", async () => {
  const issuedToken = "issued-interface-token-reflected-by-provider";
  const options = await resolveOptions(
    {
      dryRun: true,
      url: "https://app-staging.takosumi.com",
      workspace: "ws_test",
      cloudflareConnectionMode: "none",
      verificationMode: "opentofu",
    },
    { TAKOSUMI_ACCOUNT_SESSION_TOKEN: "session-token" },
  );
  const startedAtMs = Date.now();
  const result = failedResult(options, {
    startedAt: new Date(startedAtMs).toISOString(),
    startedAtMs,
    workspaceId: "ws_test",
    completedSteps: [],
    stepTimings: [],
    runTimings: [],
    capsuleGateStatus: "not_reached",
    policyStatus: "not_reached",
    serviceIdentitySampleCount: 0,
    redactedValues: [issuedToken],
    error: new Error(`provider reflected ${issuedToken}`),
  });

  expect(result.error).toContain("provider reflected");
  expect(JSON.stringify(result)).not.toContain(issuedToken);
});

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

  expect(result.kind).toBe("takosumi.platform-control-plane-smoke@v3");
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
    "interfaceMaterializationVerified",
    "destroy",
    "runEventSequenceVerified",
    "interfaceRetiredVerified",
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
    outputId: "output_dry_run",
    outputDigest: `sha256:${"0".repeat(64)}`,
    publicOutputNames: ["url", "worker_name"],
    publicOutputDigest: `sha256:${"0".repeat(64)}`,
  });
  expect(result.interfaceMaterializations).toHaveLength(1);
  expect(result.interfaceMaterialization?.interfacePhase).toBe("Resolved");
  expect(result.interfaceMaterialization?.bindingPhase).toBe("Ready");
  expect(result.interfaceMaterialization?.retiredPhase).toBe("Retired");
  expect(result.interfaceMaterialization?.revokedBindingPhase).toBe("Revoked");
  expect(result.runEventSequence?.plan.runId).toBe("plan_dry_run");
  expect(result.runEventSequence?.apply.runId).toBe("apply_dry_run");
  expect(result.runEventSequence?.destroyApply.runId).toBe(
    "destroy_apply_dry_run",
  );
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

test("platform smoke binds an optional provider-neutral service identity without retaining it", async () => {
  const identity = "immutable-release-revision";
  const options = await resolveOptions(
    {
      dryRun: true,
      url: "https://app-staging.takosumi.com",
      workspace: "ws_test",
      sessionTokenFile: "/operator/private/session",
      cloudflareConnectionMode: "none",
      verificationMode: "opentofu",
      expectedServiceIdentityHeader: "X-Release-Revision",
      expectedServiceIdentity: identity,
    },
    {},
  );

  const result = dryRunResult(options);
  expect(result.serviceIdentity).toEqual({
    headerName: "x-release-revision",
    identityDigest: `sha256:${createHash("sha256")
      .update(identity)
      .digest("hex")}`,
    sampleCount: 0,
    result: "planned",
  });
  expect(JSON.stringify(result)).not.toContain(identity);
  expect(() =>
    assertServiceIdentityResponse(
      new Headers({ "x-release-revision": identity }),
      options.expectedServiceIdentity!,
    ),
  ).not.toThrow();
  expect(() =>
    assertServiceIdentityResponse(
      new Headers({ "x-release-revision": "substituted" }),
      options.expectedServiceIdentity!,
    ),
  ).toThrow("service identity response header did not match expectation");
});

test("platform smoke rejects partial service identity and unsafe private evidence inputs", async () => {
  await expect(
    resolveOptions(
      {
        dryRun: true,
        url: "https://app-staging.takosumi.com",
        workspace: "ws_test",
        sessionTokenFile: "/operator/private/session",
        cloudflareConnectionMode: "none",
        verificationMode: "opentofu",
        expectedServiceIdentityHeader: "x-release-revision",
      },
      {},
    ),
  ).rejects.toThrow("must be provided together");

  const root = await mkdtemp(join(tmpdir(), "takosumi-platform-private-"));
  try {
    await chmod(root, 0o700);
    const session = join(root, "session");
    const evidence = join(root, "evidence.json");
    await writeFile(session, "session-token\n", { mode: 0o644 });
    await expect(
      resolveOptions(
        {
          url: "https://app-staging.takosumi.com",
          workspace: "ws_test",
          sessionTokenFile: session,
          sourceGitUrl: "https://github.com/example/repository.git",
          cloudflareConnectionMode: "none",
          verificationMode: "opentofu",
        },
        {},
      ),
    ).rejects.toThrow("mode 0600");

    await chmod(session, 0o600);
    const args = [
      "--url",
      "https://app-staging.takosumi.com",
      "--workspace",
      "ws_test",
      "--session-token-file",
      session,
      "--cloudflare-connection-mode",
      "none",
      "--verification-mode",
      "opentofu",
      "--expected-service-identity-header",
      "x-release-revision",
      "--expected-service-identity",
      "immutable-release-revision",
      "--out-file",
      evidence,
      "--dry-run",
    ] as const;
    await expect(main(args)).resolves.toBe(0);
    expect((await lstat(evidence)).mode & 0o777).toBe(0o600);
    expect(await readFile(evidence, "utf8")).not.toContain(
      "immutable-release-revision",
    );
    await expect(main(args)).rejects.toThrow("target already exists");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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

  expect(expected.provider).toBe("registry.opentofu.org/cloudflare/cloudflare");

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
      providerSettings: {
        accountId: "account",
        workersSubdomain: "takosumi-smoke",
      },
      moduleInputDefaults: {
        cloudflare_account_id: "account",
        cloudflare_workers_subdomain: "takosumi-smoke",
      },
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

test("platform control-plane smoke accepts an existing ProviderConnection only in none mode", async () => {
  const base = {
    dryRun: true,
    url: "https://app-staging.takosumi.com",
    workspace: "ws_test",
    providerConnectionId: "pcn_existing_takoform",
    verificationMode: "opentofu",
    sourceGitUrl: "https://github.com/tako0614/takosumi.git",
    sourcePath: "examples/takoform-object-bucket-smoke",
    outputAllowlistJson: JSON.stringify({
      object_bucket_id: {
        from: "object_bucket_id",
        type: "string",
        required: true,
      },
    }),
    varsJson: JSON.stringify({ bucket_name: "unique-existing-provider" }),
  } as const;

  const options = await resolveOptions(base, {
    TAKOSUMI_ACCOUNT_SESSION_TOKEN: "session-token",
  });
  expect(options.providerConnectionId).toBe("pcn_existing_takoform");
  expect(options.cloudflareConnectionMode).toBe("none");

  await expect(
    resolveOptions(
      { ...base, cloudflareConnectionMode: "guided" },
      { TAKOSUMI_ACCOUNT_SESSION_TOKEN: "session-token" },
    ),
  ).rejects.toThrow(/mutually exclusive|cannot be combined|requires/u);
  await expect(
    resolveOptions(
      { ...base, cloudflareConnectionMode: "generic-env" },
      { TAKOSUMI_ACCOUNT_SESSION_TOKEN: "session-token" },
    ),
  ).rejects.toThrow(/mutually exclusive|cannot be combined|requires/u);

  const envOptions = await resolveOptions(
    { ...base, providerConnectionId: undefined },
    {
      TAKOSUMI_ACCOUNT_SESSION_TOKEN: "session-token",
      TAKOSUMI_SMOKE_PROVIDER_CONNECTION_ID: "pcn_from_env",
    },
  );
  expect(envOptions.providerConnectionId).toBe("pcn_from_env");
});

test("platform control-plane smoke accepts a deterministic 0..N explicit ProviderBinding set", async () => {
  const bindings = [
    {
      provider: "registry.terraform.io/tako0614/takoform",
      moduleLocalName: "takoform",
      childAlias: "objects",
      rootAlias: "takoform_objects",
      connectionId: "pcn_takoform",
    },
    {
      provider: "registry.opentofu.org/hashicorp/aws",
      moduleLocalName: "aws",
      connectionId: "pcn_aws",
    },
  ];
  const options = await resolveOptions(
    {
      dryRun: true,
      url: "https://app-staging.takosumi.com",
      workspace: "ws_test",
      cloudflareConnectionMode: "none",
      verificationMode: "opentofu",
      sourceGitUrl: "https://github.com/example/multi-provider.git",
      providerBindingsJson: JSON.stringify(bindings),
    },
    { TAKOSUMI_ACCOUNT_SESSION_TOKEN: "session-token" },
  );

  expect(options.providerBindings).toEqual([bindings[1], bindings[0]]);
  expect(options.providerConnectionId).toBeUndefined();
  expect(options.runnerProfileId).toBeUndefined();

  const result = dryRunResult(options);
  expect(result.credentialPath).toBe("workspace_scoped_provider_connection");
  expect(result.steps).toContain("existingProviderConnectionsSelected");
  expect(result.steps).not.toContain("providerConnectionNotRequired");
  expect(result.inputs.providerBindingCount).toBe(2);
  expect(result.inputs.providerBindingsExplicit).toBe(true);
  expect(result.inputs.providerBindingsDigest).toMatch(
    /^sha256:[0-9a-f]{64}$/u,
  );
  expect(JSON.stringify(result)).not.toContain("pcn_takoform");
  expect(JSON.stringify(result)).not.toContain("pcn_aws");
});

test("existing non-Cloudflare ProviderBindings do not inject Cloudflare hello-module variables", async () => {
  const options = await resolveOptions(
    {
      dryRun: true,
      url: "https://app-staging.takosumi.com",
      workspace: "ws_test",
      appName: "generic-service-e2e",
      cloudflareConnectionMode: "none",
      verificationMode: "opentofu",
      sourceGitUrl: "https://github.com/example/generic-service.git",
      modulePath: "deploy/service",
      providerBindingsJson: JSON.stringify([
        {
          provider: "registry.terraform.io/tako0614/takoform",
          moduleLocalName: "takoform",
          connectionId: "pcn_takoform",
        },
      ]),
      varsJson: JSON.stringify({
        service_name: "generic-service-e2e",
      }),
    },
    { TAKOSUMI_ACCOUNT_SESSION_TOKEN: "session-token" },
  );

  const expectedVars = {
    service_name: "generic-service-e2e",
  };
  expect(options.vars).toEqual(expectedVars);
  expect(
    smokeSourceCapsuleCreateBody(options, {
      sourceId: "src_generic_service",
      installConfigId: "cfg_generic",
    }),
  ).toMatchObject({ vars: expectedVars });
});

test("Yurucommu Takoform smoke sends no reviewed variables and leaves project_name to capsule_name", async () => {
  const options = await resolveOptions(
    {
      dryRun: true,
      url: "https://app-staging.takosumi.com",
      workspace: "ws_test",
      appName: "yurucommu-e2e",
      cloudflareConnectionMode: "none",
      verificationMode: "opentofu",
      sourceGitUrl: "https://github.com/tako0614/yurucommu.git",
      modulePath: "deploy/takoform",
      noDefaultVars: true,
      providerBindingsJson: JSON.stringify([
        {
          provider: "registry.terraform.io/tako0614/takoform",
          moduleLocalName: "takoform",
          connectionId: "pcn_takoform",
        },
      ]),
    },
    { TAKOSUMI_ACCOUNT_SESSION_TOKEN: "session-token" },
  );

  expect(options.vars).toEqual({});
  expect(
    smokeSourceCapsuleCreateBody(options, {
      sourceId: "src_yurucommu",
      installConfigId: "cfg_yurucommu_takoform",
    }),
  ).toMatchObject({ name: "yurucommu-e2e", vars: {} });
});

test("an explicit empty ProviderBinding set remains authoritative zero", async () => {
  const base = {
    dryRun: true,
    url: "https://app-staging.takosumi.com",
    workspace: "ws_test",
    cloudflareConnectionMode: "none",
    verificationMode: "opentofu",
    sourceGitUrl: "https://github.com/example/providerless.git",
    providerBindingsJson: "[]",
  } as const;

  const options = await resolveOptions(base, {
    TAKOSUMI_ACCOUNT_SESSION_TOKEN: "session-token",
  });
  const result = dryRunResult(options);
  expect(options.providerBindings).toEqual([]);
  expect(options.providerBindingsExplicit).toBe(true);
  expect(result.inputs.providerBindingCount).toBe(0);
  expect(result.inputs.providerBindingsExplicit).toBe(true);
  expect(result.inputs.providerBindingsDigest).toMatch(
    /^sha256:[0-9a-f]{64}$/u,
  );
  expect(result.steps).toContain("providerConnectionNotRequired");

  await expect(
    resolveOptions(base, {
      TAKOSUMI_ACCOUNT_SESSION_TOKEN: "session-token",
      TAKOSUMI_SMOKE_PROVIDER_CONNECTION_ID: "pcn_legacy",
    }),
  ).rejects.toThrow(/cannot be combined/u);
  await expect(
    resolveOptions(
      {
        ...base,
        cloudflareConnectionMode: "guided",
        cloudflareAccountId: "account",
        cloudflareWorkersSubdomain: "workers-subdomain",
      },
      {
        TAKOSUMI_ACCOUNT_SESSION_TOKEN: "session-token",
        CLOUDFLARE_API_TOKEN: "cloudflare-token",
      },
    ),
  ).rejects.toThrow(/cannot be combined/u);
});

test("platform control-plane smoke rejects ambiguous or non-canonical ProviderBinding input", async () => {
  const base = {
    dryRun: true,
    url: "https://app-staging.takosumi.com",
    workspace: "ws_test",
    cloudflareConnectionMode: "none",
    verificationMode: "opentofu",
    sourceGitUrl: "https://github.com/example/multi-provider.git",
  } as const;
  const env = { TAKOSUMI_ACCOUNT_SESSION_TOKEN: "session-token" };

  await expect(
    resolveOptions(
      {
        ...base,
        providerBindingsJson: JSON.stringify([
          { provider: "hashicorp/aws", connectionId: "pcn_aws" },
        ]),
      },
      env,
    ),
  ).rejects.toThrow(/exact canonical provider source/u);
  await expect(
    resolveOptions(
      {
        ...base,
        providerBindingsJson: JSON.stringify([
          {
            provider: "registry.opentofu.org/hashicorp/aws",
            moduleLocalName: "aws",
            connectionId: "pcn_aws",
          },
          {
            provider: "registry.opentofu.org/hashicorp/aws",
            moduleLocalName: "aws",
            connectionId: "pcn_other",
          },
        ]),
      },
      env,
    ),
  ).rejects.toThrow(/duplicate ProviderBinding address/u);
  await expect(
    resolveOptions(
      {
        ...base,
        providerConnectionId: "pcn_legacy",
        providerBindingsJson: JSON.stringify([
          {
            provider: "registry.opentofu.org/hashicorp/aws",
            connectionId: "pcn_aws",
          },
        ]),
      },
      env,
    ),
  ).rejects.toThrow(/cannot be combined/u);
  await expect(
    resolveOptions(
      {
        ...base,
        providerBindingsJson: JSON.stringify([
          {
            provider: "registry.opentofu.org/hashicorp/aws",
            moduleLocalName: "aws",
            childAlias: "one",
            connectionId: "pcn_one",
          },
          {
            provider: "registry.opentofu.org/hashicorp/aws",
            moduleLocalName: "aws",
            childAlias: "two",
            connectionId: "pcn_two",
          },
        ]),
      },
      env,
    ),
  ).rejects.toThrow(/duplicate root provider target/u);
});

test("platform control-plane smoke binds an existing provider by its source", () => {
  expect(
    smokeCapsuleProviderBindingsBody({
      bindings: [
        {
          provider: "registry.terraform.io/tako0614/takoform",
          moduleLocalName: "takoform",
          childAlias: "objects",
          rootAlias: "takoform_objects",
          connectionId: "pcn_existing_takoform",
        },
        {
          provider: "registry.opentofu.org/hashicorp/aws",
          moduleLocalName: "aws",
          connectionId: "pcn_existing_aws",
        },
      ],
    }),
  ).toEqual({
    bindings: [
      {
        provider: "registry.opentofu.org/hashicorp/aws",
        moduleLocalName: "aws",
        connectionId: "pcn_existing_aws",
      },
      {
        provider: "registry.terraform.io/tako0614/takoform",
        moduleLocalName: "takoform",
        childAlias: "objects",
        rootAlias: "takoform_objects",
        connectionId: "pcn_existing_takoform",
      },
    ],
  });
  expect(
    JSON.stringify(
      smokeCapsuleProviderBindingsBody({
        bindings: [
          {
            provider: "registry.opentofu.org/hashicorp/aws",
            connectionId: "pcn_existing_aws",
          },
        ],
      }),
    ),
  ).not.toContain('"alias"');
});

test("platform smoke resolves an omitted guided binding identity from compatibility", () => {
  const resolved = resolveSmokeProviderBindingsFromCompatibility(
    [
      {
        provider: "registry.opentofu.org/cloudflare/cloudflare",
        connectionId: "pcn_guided_cloudflare",
      },
    ],
    [
      {
        source: "registry.opentofu.org/cloudflare/cloudflare",
        moduleLocalName: "cloudflare",
      },
    ],
  );
  expect(resolved).toEqual([
    {
      provider: "registry.opentofu.org/cloudflare/cloudflare",
      moduleLocalName: "cloudflare",
      connectionId: "pcn_guided_cloudflare",
    },
  ]);
  expect(smokeCapsuleProviderBindingsBody({ bindings: resolved })).toEqual({
    bindings: [
      {
        provider: "registry.opentofu.org/cloudflare/cloudflare",
        moduleLocalName: "cloudflare",
        connectionId: "pcn_guided_cloudflare",
      },
    ],
  });
});

test("platform smoke selects the exact provider source from a multi-provider report", () => {
  expect(
    resolveSmokeProviderBindingsFromCompatibility(
      [
        {
          provider: "registry.opentofu.org/cloudflare/cloudflare",
          connectionId: "pcn_guided_cloudflare",
        },
      ],
      [
        {
          source: "registry.opentofu.org/hashicorp/aws",
          moduleLocalName: "aws",
        },
        {
          // Prove that the report owns the module-local name. The provider
          // source suffix is not a safe fallback.
          source: "cloudflare/cloudflare",
          moduleLocalName: "edge",
        },
      ],
    ),
  ).toEqual([
    {
      provider: "registry.opentofu.org/cloudflare/cloudflare",
      moduleLocalName: "edge",
      connectionId: "pcn_guided_cloudflare",
    },
  ]);
});

test("platform smoke rejects an omitted identity when one source has multiple aliases", () => {
  expect(() =>
    resolveSmokeProviderBindingsFromCompatibility(
      [
        {
          provider: "registry.opentofu.org/cloudflare/cloudflare",
          connectionId: "pcn_guided_cloudflare",
        },
      ],
      [
        {
          source: "registry.opentofu.org/cloudflare/cloudflare",
          moduleLocalName: "edge",
          childAlias: "account",
        },
        {
          source: "registry.opentofu.org/cloudflare/cloudflare",
          moduleLocalName: "edge",
          childAlias: "zone",
        },
      ],
    ),
  ).toThrow(/2 matching root provider requirements.*explicit moduleLocalName and childAlias/u);
});

test("platform smoke rejects an omitted identity with no matching requirement", () => {
  expect(() =>
    resolveSmokeProviderBindingsFromCompatibility(
      [
        {
          provider: "registry.opentofu.org/cloudflare/cloudflare",
          connectionId: "pcn_guided_cloudflare",
        },
      ],
      [
        {
          source: "registry.opentofu.org/hashicorp/aws",
          moduleLocalName: "aws",
        },
      ],
    ),
  ).toThrow(/no matching root provider requirement.*explicit moduleLocalName and childAlias/u);
});

test("platform smoke preserves an explicit provider identity after compatibility validation", () => {
  const binding = {
    provider: "registry.opentofu.org/cloudflare/cloudflare",
    moduleLocalName: "edge-provider",
    childAlias: "zone-edge",
    rootAlias: "production-edge",
    connectionId: "pcn_explicit_cloudflare",
  } as const;
  expect(
    resolveSmokeProviderBindingsFromCompatibility(
      [binding],
      [
        {
          source: binding.provider,
          moduleLocalName: binding.moduleLocalName,
          childAlias: binding.childAlias,
        },
      ],
    ),
  ).toEqual([binding]);
  expect(() =>
    resolveSmokeProviderBindingsFromCompatibility(
      [binding],
      [
        {
          source: binding.provider,
          moduleLocalName: "cloudflare",
        },
      ],
    ),
  ).toThrow(/explicit provider identity.*not declared/u);
});

test("multi-provider smoke evidence redacts explicit ProviderConnection ids on failure", async () => {
  const options = await resolveOptions(
    {
      dryRun: true,
      url: "https://app-staging.takosumi.com",
      workspace: "ws_test",
      cloudflareConnectionMode: "none",
      verificationMode: "opentofu",
      sourceGitUrl: "https://github.com/example/multi-provider.git",
      providerBindingsJson: JSON.stringify([
        {
          provider: "registry.opentofu.org/hashicorp/aws",
          connectionId: "pcn_private_aws",
        },
      ]),
    },
    { TAKOSUMI_ACCOUNT_SESSION_TOKEN: "session-token" },
  );
  const startedAtMs = Date.now();
  const result = failedResult(options, {
    startedAt: new Date(startedAtMs).toISOString(),
    startedAtMs,
    workspaceId: "ws_test",
    completedSteps: [],
    stepTimings: [],
    runTimings: [],
    capsuleGateStatus: "not_reached",
    policyStatus: "not_reached",
    runCancellationError: "cancel failed for pcn_private_aws",
    failureCleanup: {
      attempted: true,
      cloudflareWorkerGone: false,
      capsuleMarkedError: false,
      destroyAttempted: true,
      destroySucceeded: false,
      destroyError: "destroy failed for pcn_private_aws",
      error: "cleanup failed for pcn_private_aws",
    },
    serviceIdentitySampleCount: 0,
    error: new Error(
      "ProviderConnection pcn_private_aws was not available to this Workspace",
    ),
  });

  expect(result.error).toContain("<provider-connection>");
  expect(JSON.stringify(result)).not.toContain("pcn_private_aws");
});

test("platform control-plane smoke records an existing ProviderConnection without revoking or leaking secrets", async () => {
  const options = await resolveOptions(
    {
      dryRun: true,
      url: "https://app-staging.takosumi.com",
      workspace: "ws_test",
      providerConnectionId: "pcn_existing_takoform",
      cloudflareConnectionMode: "none",
      verificationMode: "opentofu",
      sourceGitUrl: "https://github.com/tako0614/takosumi.git",
      sourcePath: "examples/takoform-object-bucket-smoke",
      outputAllowlistJson: JSON.stringify({
        object_bucket_id: {
          from: "object_bucket_id",
          type: "string",
          required: true,
        },
      }),
      varsJson: JSON.stringify({ bucket_name: "unique-existing-provider" }),
    },
    {
      TAKOSUMI_ACCOUNT_SESSION_TOKEN: "session-token",
      TAKOFORM_TOKEN: "provider-secret",
    },
  );

  const result = dryRunResult(options);
  const serialized = JSON.stringify(result);
  expect(result.providerConnectionId).toBe("pcn_existing_takoform");
  expect(result.credentialPath).toBe("workspace_scoped_provider_connection");
  expect(result.steps).toContain("existingProviderConnectionSelected");
  expect(result.steps).not.toContain("providerConnectionNotRequired");
  expect(result.steps).not.toContain("connectionRevoked");
  expect(result.connectionRevoked).toBeUndefined();
  expect(result.inputs.providerConnectionId).toBe("pcn_existing_takoform");
  expect(serialized).not.toContain("provider-secret");
  expect(serialized).not.toContain("TAKOFORM_TOKEN");
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

test("platform control-plane smoke rejects backup restore rehearsal even in dry-run", async () => {
  await expect(
    resolveOptions(
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
    ),
  ).rejects.toThrow(/no manifest-bound restore importer/);
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
    selectSmokeInstallConfigId([{ id: "one" }, { id: "two" }], "two"),
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

test("platform smoke keeps a successfully destroyed Capsule terminal when post-destroy Worker verification lacks Outputs", async () => {
  const appName = "takosumi-destroy-output-fixture";
  const rawConnectionId = "conn_destroy_output_fixture";
  const providerConnectionId = "pcn_destroy_output_fixture";
  const capsuleId = "cap_destroy_output_fixture";
  const sourceId = "src_destroy_output_fixture";
  const sourceSnapshotId = "snap_destroy_output_fixture";
  const runRecords = {
    sync: {
      id: "run_sync_destroy_output_fixture",
      status: "succeeded",
      type: "source_sync",
      sourceSnapshotId,
    },
    planWaitingApproval: {
      id: "run_plan_destroy_output_fixture",
      status: "waiting_approval",
      type: "plan",
    },
    planSucceeded: {
      id: "run_plan_destroy_output_fixture",
      status: "succeeded",
      type: "plan",
    },
    applyFailed: {
      id: "run_apply_destroy_output_fixture",
      status: "failed",
      type: "apply",
    },
    destroyPlanWaitingApproval: {
      id: "run_destroy_plan_output_fixture",
      status: "waiting_approval",
      type: "destroy",
    },
    destroySucceeded: {
      id: "run_destroy_apply_output_fixture",
      status: "succeeded",
      type: "destroy",
    },
  } as const;
  const options = await resolveOptions(
    {
      url: "https://app-staging.takosumi.com",
      workspace: "ws_destroyoutput",
      appName,
      sourceGitUrl: "https://git.example.test/destroy-output-fixture.git",
      cloudflareConnectionMode: "guided",
      verificationMode: "cloudflare-worker",
      noInterfaceProof: true,
      cloudflareWorkerNameOutput: "service_runtime_name",
      runtimePublicUrlOutput: "launch_url",
      outputAllowlistJson: JSON.stringify({
        launch_url: { from: "launch_url", type: "url", required: true },
        service_runtime_name: {
          from: "service_runtime_name",
          type: "string",
        },
      }),
      timeoutSeconds: "1",
      deployTimeoutSeconds: "1",
      pollIntervalMs: "1",
    },
    {
      TAKOSUMI_ACCOUNT_SESSION_TOKEN: "session-token",
      CLOUDFLARE_API_TOKEN: "cloudflare-token",
      CLOUDFLARE_ACCOUNT_ID: "account-fixture",
      CLOUDFLARE_WORKERS_SUBDOMAIN: "workers.example.test",
    },
  );
  const originalFetch = globalThis.fetch;
  const requests: Array<{
    readonly method: string;
    readonly url: string;
    readonly body?: string;
  }> = [];
  globalThis.fetch = (async (input, init) => {
    const requestUrl = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? init.body : undefined;
    requests.push({ method, url: requestUrl.toString(), ...(body ? { body } : {}) });
    if (requestUrl.origin !== options.url) {
      throw new Error(`unexpected external fixture request: ${requestUrl}`);
    }
    const path = requestUrl.pathname;
    if (method === "POST" && path === "/api/v1/connections") {
      return Response.json({ connection: { id: rawConnectionId } });
    }
    if (
      method === "POST" &&
      path === `/api/v1/connections/${rawConnectionId}/test`
    ) {
      return Response.json({ status: "verified" });
    }
    if (method === "GET" && path === "/api/v1/provider-connections") {
      return Response.json({
        providerConnections: [
          {
            id: providerConnectionId,
            providerSource: "registry.opentofu.org/cloudflare/cloudflare",
            displayName: `Layer-2 smoke ${appName}`,
          },
        ],
      });
    }
    if (method === "POST" && path === "/api/v1/sources") {
      return Response.json({ source: { id: sourceId } });
    }
    if (
      method === "POST" &&
      path === `/api/v1/sources/${sourceId}/sync`
    ) {
      return Response.json({ run: runRecords.sync });
    }
    if (
      method === "GET" &&
      path === `/api/v1/runs/${runRecords.sync.id}`
    ) {
      return Response.json({ run: runRecords.sync });
    }
    if (
      method === "GET" &&
      path === `/api/v1/sources/${sourceId}/snapshots`
    ) {
      return Response.json({
        snapshots: [
          {
            id: sourceSnapshotId,
            resolvedCommit: "a".repeat(40),
            archiveRef: "r2://fixture/source.tar.zst",
            archiveDigest: `sha256:${"b".repeat(64)}`,
            archiveSizeBytes: 1,
            fetchedByRunId: runRecords.sync.id,
          },
        ],
      });
    }
    if (method === "GET" && path === "/api/v1/capsule-configs") {
      return Response.json({
        installConfigs: [{ id: "cfg_destroy_output_fixture", workspaceId: options.workspace }],
      });
    }
    if (
      method === "POST" &&
      path === `/api/v1/workspaces/${options.workspace}/capsules`
    ) {
      return Response.json({ capsule: { id: capsuleId, name: appName } });
    }
    if (
      method === "POST" &&
      path === `/api/v1/sources/${sourceId}/compatibility-check`
    ) {
      return Response.json({
        report: {
          id: "compat_destroy_output_fixture",
          rootProviderRequirements: [
            {
              source: "registry.opentofu.org/cloudflare/cloudflare",
              moduleLocalName: "cloudflare",
            },
          ],
        },
      });
    }
    if (
      method === "PUT" &&
      path === `/api/v1/capsules/${capsuleId}/provider-bindings`
    ) {
      return Response.json({});
    }
    if (method === "POST" && path === `/api/v1/capsules/${capsuleId}/plan`) {
      return Response.json({ run: runRecords.planWaitingApproval });
    }
    if (
      method === "GET" &&
      path === `/api/v1/runs/${runRecords.planWaitingApproval.id}`
    ) {
      const planPolls = requests.filter(
        (request) =>
          request.method === "GET" &&
          request.url.endsWith(`/api/v1/runs/${runRecords.planWaitingApproval.id}`),
      ).length;
      return Response.json({
        run:
          planPolls === 1
            ? runRecords.planWaitingApproval
            : runRecords.planSucceeded,
      });
    }
    if (
      method === "POST" &&
      path === `/api/v1/runs/${runRecords.planWaitingApproval.id}/approve`
    ) {
      return Response.json({ run: runRecords.planSucceeded });
    }
    if (
      method === "POST" &&
      path === `/api/v1/runs/${runRecords.planWaitingApproval.id}/apply`
    ) {
      return Response.json({ run: runRecords.applyFailed });
    }
    if (
      method === "GET" &&
      path === `/api/v1/runs/${runRecords.applyFailed.id}`
    ) {
      return Response.json({ run: runRecords.applyFailed });
    }
    if (
      method === "POST" &&
      path === `/api/v1/capsules/${capsuleId}/destroy-plan`
    ) {
      return Response.json({ run: runRecords.destroyPlanWaitingApproval });
    }
    if (
      method === "GET" &&
      path === `/api/v1/runs/${runRecords.destroyPlanWaitingApproval.id}`
    ) {
      return Response.json({ run: runRecords.destroyPlanWaitingApproval });
    }
    if (
      method === "POST" &&
      path === `/api/v1/runs/${runRecords.destroyPlanWaitingApproval.id}/approve`
    ) {
      return Response.json({});
    }
    if (
      method === "POST" &&
      path === `/api/v1/runs/${runRecords.destroyPlanWaitingApproval.id}/apply`
    ) {
      return Response.json({ run: runRecords.destroySucceeded });
    }
    if (
      method === "GET" &&
      path === `/api/v1/runs/${runRecords.destroySucceeded.id}`
    ) {
      return Response.json({ run: runRecords.destroySucceeded });
    }
    if (
      method === "POST" &&
      path === `/api/v1/connections/${rawConnectionId}/revoke`
    ) {
      return Response.json({});
    }
    if (method === "PATCH" && path === `/api/v1/capsules/${capsuleId}`) {
      throw new Error("destroyed Capsule must not be patched to error");
    }
    throw new Error(`unexpected Takosumi fixture request: ${method} ${requestUrl}`);
  }) as typeof fetch;
  try {
    const result = await runPlatformControlPlaneSmoke(options);
    expect(result.status).toBe("failed");
    expect(result.error).toContain("apply run run_apply_destroy_output_fixture ended as failed");
    expect(result.capsuleId).toBe(capsuleId);
    expect(result.applyRunId).toBe(runRecords.applyFailed.id);
    expect(result.destroyPlanRunId).toBe(runRecords.destroyPlanWaitingApproval.id);
    expect(result.destroyApplyRunId).toBe(runRecords.destroySucceeded.id);
    expect(result.destroyVerified).toBe(true);
    expect(result.connectionRevoked).toBe(true);
    expect(result.connectionRevokeSkippedReason).toBeUndefined();
    expect(result.failureCleanup).toMatchObject({
      attempted: true,
      cloudflareWorkerGone: false,
      capsuleMarkedError: false,
      destroyAttempted: true,
      destroyPlanRunId: runRecords.destroyPlanWaitingApproval.id,
      destroyApplyRunId: runRecords.destroySucceeded.id,
      destroySucceeded: true,
      destroyVerification: {
        status: "inconclusive",
        cloudflareWorkerGone: false,
      },
    });
    expect(result.failureCleanup?.error).toContain(
      'Cloudflare Worker name output "service_runtime_name" is missing',
    );
    expect(
      requests.some(
        (request) =>
          request.method === "PATCH" &&
          request.url.endsWith(`/api/v1/capsules/${capsuleId}`),
      ),
    ).toBe(false);
    expect(
      requests.filter(
        (request) =>
          request.method === "POST" &&
          request.url.endsWith(`/api/v1/connections/${rawConnectionId}/revoke`),
      ),
    ).toHaveLength(1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("platform smoke does not retry or directly delete after a failed destroy apply", async () => {
  const appName = "takosumi-destroy-failure-fixture";
  const rawConnectionId = "conn_destroy_failure_fixture";
  const providerConnectionId = "pcn_destroy_failure_fixture";
  const capsuleId = "cap_destroy_failure_fixture";
  const sourceId = "src_destroy_failure_fixture";
  const sourceSnapshotId = "snap_destroy_failure_fixture";
  const stateVersionId = "state_destroy_failure_fixture";
  const outputId = "out_destroy_failure_fixture";
  const runRecords = {
    sync: {
      id: "run_sync_destroy_failure_fixture",
      status: "succeeded",
      type: "source_sync",
      sourceSnapshotId,
    },
    planWaitingApproval: {
      id: "run_plan_destroy_failure_fixture",
      status: "waiting_approval",
      type: "plan",
    },
    planSucceeded: {
      id: "run_plan_destroy_failure_fixture",
      status: "succeeded",
      type: "plan",
    },
    applySucceeded: {
      id: "run_apply_destroy_failure_fixture",
      status: "succeeded",
      type: "apply",
    },
    destroyPlanWaitingApproval: {
      id: "run_destroy_plan_failure_fixture",
      status: "waiting_approval",
      type: "destroy",
    },
    destroyFailed: {
      id: "run_destroy_apply_failure_fixture",
      status: "failed",
      type: "destroy",
    },
  } as const;
  const options = await resolveOptions(
    {
      url: "https://app-staging.takosumi.com",
      workspace: "ws_destroyfailure",
      appName,
      sourceGitUrl: "https://git.example.test/destroy-failure-fixture.git",
      cloudflareConnectionMode: "guided",
      verificationMode: "opentofu",
      noInterfaceProof: true,
      outputAllowlistJson: JSON.stringify({}),
      timeoutSeconds: "1",
      deployTimeoutSeconds: "1",
      pollIntervalMs: "1",
    },
    {
      TAKOSUMI_ACCOUNT_SESSION_TOKEN: "session-token",
      CLOUDFLARE_API_TOKEN: "cloudflare-token",
      CLOUDFLARE_ACCOUNT_ID: "account-fixture",
      CLOUDFLARE_WORKERS_SUBDOMAIN: "workers.example.test",
    },
  );
  const originalFetch = globalThis.fetch;
  const requests: Array<{
    readonly method: string;
    readonly url: string;
    readonly body?: string;
  }> = [];
  globalThis.fetch = (async (input, init) => {
    const requestUrl = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? init.body : undefined;
    requests.push({ method, url: requestUrl.toString(), ...(body ? { body } : {}) });
    if (requestUrl.origin !== options.url) {
      throw new Error(`unexpected external fixture request: ${requestUrl}`);
    }
    const path = requestUrl.pathname;
    if (method === "POST" && path === "/api/v1/connections") {
      return Response.json({ connection: { id: rawConnectionId } });
    }
    if (
      method === "POST" &&
      path === `/api/v1/connections/${rawConnectionId}/test`
    ) {
      return Response.json({ status: "verified" });
    }
    if (method === "GET" && path === "/api/v1/provider-connections") {
      return Response.json({
        providerConnections: [
          {
            id: providerConnectionId,
            providerSource: "registry.opentofu.org/cloudflare/cloudflare",
            displayName: `Layer-2 smoke ${appName}`,
          },
        ],
      });
    }
    if (method === "POST" && path === "/api/v1/sources") {
      return Response.json({ source: { id: sourceId } });
    }
    if (
      method === "POST" &&
      path === `/api/v1/sources/${sourceId}/sync`
    ) {
      return Response.json({ run: runRecords.sync });
    }
    if (
      method === "GET" &&
      path === `/api/v1/runs/${runRecords.sync.id}`
    ) {
      return Response.json({ run: runRecords.sync });
    }
    if (
      method === "GET" &&
      path === `/api/v1/sources/${sourceId}/snapshots`
    ) {
      return Response.json({
        snapshots: [
          {
            id: sourceSnapshotId,
            resolvedCommit: "a".repeat(40),
            archiveRef: "r2://fixture/source.tar.zst",
            archiveDigest: `sha256:${"b".repeat(64)}`,
            archiveSizeBytes: 1,
            fetchedByRunId: runRecords.sync.id,
          },
        ],
      });
    }
    if (method === "GET" && path === "/api/v1/capsule-configs") {
      return Response.json({
        installConfigs: [{ id: "cfg_destroy_failure_fixture", workspaceId: options.workspace }],
      });
    }
    if (
      method === "POST" &&
      path === `/api/v1/workspaces/${options.workspace}/capsules`
    ) {
      return Response.json({ capsule: { id: capsuleId, name: appName } });
    }
    if (
      method === "POST" &&
      path === `/api/v1/sources/${sourceId}/compatibility-check`
    ) {
      return Response.json({
        report: {
          id: "compat_destroy_failure_fixture",
          rootProviderRequirements: [
            {
              source: "registry.opentofu.org/cloudflare/cloudflare",
              moduleLocalName: "cloudflare",
            },
          ],
        },
      });
    }
    if (
      method === "PUT" &&
      path === `/api/v1/capsules/${capsuleId}/provider-bindings`
    ) {
      return Response.json({});
    }
    if (method === "POST" && path === `/api/v1/capsules/${capsuleId}/plan`) {
      return Response.json({ run: runRecords.planWaitingApproval });
    }
    if (
      method === "GET" &&
      path === `/api/v1/runs/${runRecords.planWaitingApproval.id}`
    ) {
      const planPolls = requests.filter(
        (request) =>
          request.method === "GET" &&
          request.url.endsWith(`/api/v1/runs/${runRecords.planWaitingApproval.id}`),
      ).length;
      return Response.json({
        run:
          planPolls === 1
            ? runRecords.planWaitingApproval
            : runRecords.planSucceeded,
      });
    }
    if (
      method === "POST" &&
      path === `/api/v1/runs/${runRecords.planWaitingApproval.id}/approve`
    ) {
      return Response.json({ run: runRecords.planSucceeded });
    }
    if (
      method === "POST" &&
      path === `/api/v1/runs/${runRecords.planWaitingApproval.id}/apply`
    ) {
      return Response.json({ run: runRecords.applySucceeded });
    }
    if (
      method === "GET" &&
      path === `/api/v1/runs/${runRecords.applySucceeded.id}`
    ) {
      return Response.json({ run: runRecords.applySucceeded });
    }
    if (method === "GET" && path === `/api/v1/capsules/${capsuleId}`) {
      return Response.json({
        capsule: {
          id: capsuleId,
          workspaceId: options.workspace,
          status: "active",
          currentStateVersionId: stateVersionId,
          currentStateGeneration: 1,
        },
      });
    }
    if (
      method === "GET" &&
      path === `/api/v1/capsules/${capsuleId}/state-versions`
    ) {
      return Response.json({
        stateVersions: [
          {
            id: stateVersionId,
            workspaceId: options.workspace,
            capsuleId,
            environment: options.environment,
            createdByRunId: runRecords.applySucceeded.id,
            generation: 1,
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      });
    }
    if (method === "GET" && path === `/api/v1/capsules/${capsuleId}/outputs`) {
      return Response.json({
        output: {
          id: outputId,
          workspaceId: options.workspace,
          capsuleId,
          stateGeneration: 1,
          publicOutputs: {},
          outputDigest: `sha256:${"c".repeat(64)}`,
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      });
    }
    if (
      method === "POST" &&
      path === `/api/v1/capsules/${capsuleId}/destroy-plan`
    ) {
      return Response.json({ run: runRecords.destroyPlanWaitingApproval });
    }
    if (
      method === "GET" &&
      path === `/api/v1/runs/${runRecords.destroyPlanWaitingApproval.id}`
    ) {
      return Response.json({ run: runRecords.destroyPlanWaitingApproval });
    }
    if (
      method === "POST" &&
      path === `/api/v1/runs/${runRecords.destroyPlanWaitingApproval.id}/approve`
    ) {
      return Response.json({});
    }
    if (
      method === "POST" &&
      path === `/api/v1/runs/${runRecords.destroyPlanWaitingApproval.id}/apply`
    ) {
      return Response.json({ run: runRecords.destroyFailed });
    }
    if (
      method === "GET" &&
      path === `/api/v1/runs/${runRecords.destroyFailed.id}`
    ) {
      return Response.json({ run: runRecords.destroyFailed });
    }
    if (method === "PATCH" && path === `/api/v1/capsules/${capsuleId}`) {
      throw new Error("failed destroy must retain Capsule evidence");
    }
    if (
      method === "POST" &&
      path === `/api/v1/connections/${rawConnectionId}/revoke`
    ) {
      throw new Error("failed destroy must retain ProviderConnection");
    }
    throw new Error(`unexpected Takosumi fixture request: ${method} ${requestUrl}`);
  }) as typeof fetch;
  try {
    const result = await runPlatformControlPlaneSmoke(options);
    expect(result.status).toBe("failed");
    expect(result.error).toContain(
      `destroy apply run ${runRecords.destroyFailed.id} ended as failed`,
    );
    expect(result.capsuleId).toBe(capsuleId);
    expect(result.applyRunId).toBe(runRecords.applySucceeded.id);
    expect(result.destroyPlanRunId).toBe(runRecords.destroyPlanWaitingApproval.id);
    expect(result.destroyApplyRunId).toBe(runRecords.destroyFailed.id);
    expect(result.connectionRevoked).toBe(false);
    expect(result.connectionRevokeSkippedReason).toContain(
      "keeping ProviderConnection",
    );
    expect(result.failureCleanup).toMatchObject({
      attempted: true,
      cloudflareWorkerGone: false,
      capsuleMarkedError: false,
      destroyAttempted: true,
      destroyApplyAttempted: true,
      destroyPlanRunId: runRecords.destroyPlanWaitingApproval.id,
      destroyApplyRunId: runRecords.destroyFailed.id,
      destroySucceeded: false,
    });
    expect(result.runTimings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "destroy_plan",
          runId: runRecords.destroyPlanWaitingApproval.id,
        }),
        expect.objectContaining({
          name: "destroy_apply",
          runId: runRecords.destroyFailed.id,
        }),
      ]),
    );
    expect(
      requests.filter(
        (request) =>
          request.method === "POST" &&
          request.url.endsWith(`/api/v1/capsules/${capsuleId}/destroy-plan`),
      ),
    ).toHaveLength(1);
    expect(
      requests.filter(
        (request) =>
          request.method === "POST" &&
          request.url.endsWith(
            `/api/v1/runs/${runRecords.destroyPlanWaitingApproval.id}/apply`,
          ),
      ),
    ).toHaveLength(1);
    expect(
      requests.filter(
        (request) =>
          request.method === "DELETE" &&
          request.url.includes("api.cloudflare.com/client/v4/accounts"),
      ),
    ).toHaveLength(0);
    expect(
      requests.filter(
        (request) =>
          request.method === "POST" &&
          request.url.endsWith(`/api/v1/connections/${rawConnectionId}/revoke`),
      ),
    ).toHaveLength(0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

type DestroyApplyReconciliationCase =
  | "mismatched"
  | "cancelled"
  | "already_terminal"
  | "external_verifier";

async function runDestroyApplyReconciliationFixture(
  reconciliation: DestroyApplyReconciliationCase,
  destroyEvidenceVerifier?: DestroyEvidenceVerifier,
) {
  const appName = `takosumi-destroy-apply-${reconciliation}-fixture`;
  const capsuleId = `cap_destroy_apply_${reconciliation}_fixture`;
  const sourceId = `src_destroy_apply_${reconciliation}_fixture`;
  const sourceSnapshotId = `snap_destroy_apply_${reconciliation}_fixture`;
  const stateVersionId = `state_destroy_apply_${reconciliation}_fixture`;
  const outputId = `out_destroy_apply_${reconciliation}_fixture`;
  const destroyPlanRunId = `run_destroy_plan_${reconciliation}_fixture`;
  const destroyApplyRunId = `run_destroy_apply_${reconciliation}_fixture`;
  const staleRunId = `run_destroy_apply_stale_${reconciliation}_fixture`;
  const runRecords = {
    sync: {
      id: `run_sync_${reconciliation}_fixture`,
      status: "succeeded",
      type: "source_sync",
      sourceSnapshotId,
    },
    planWaitingApproval: {
      id: `run_plan_${reconciliation}_fixture`,
      status: "waiting_approval",
      type: "plan",
    },
    planSucceeded: {
      id: `run_plan_${reconciliation}_fixture`,
      status: "succeeded",
      type: "plan",
    },
    applySucceeded: {
      id: `run_apply_${reconciliation}_fixture`,
      status: "succeeded",
      type: "apply",
    },
    destroyPlanWaitingApproval: {
      id: destroyPlanRunId,
      status: "waiting_approval",
      type: "destroy",
    },
    destroyApplyRunning: {
      id: destroyApplyRunId,
      status: "running",
      type: "destroy",
      createdAt: "2026-01-01T00:00:00.000Z",
      startedAt: "2026-01-01T00:00:02.000Z",
    },
    destroyApplyTerminal: {
      id: destroyApplyRunId,
      status:
        reconciliation === "already_terminal"
          ? "failed"
          : reconciliation === "external_verifier"
            ? "succeeded"
            : "cancelled",
      type: "destroy",
      ...(reconciliation === "external_verifier" ? {} : { policyStatus: "deny" }),
      createdAt: "2026-01-01T00:00:00.000Z",
      startedAt: "2026-01-01T00:00:02.000Z",
      finishedAt: "2026-01-01T00:00:03.000Z",
    },
    destroyApplyStale: {
      id: staleRunId,
      status: "succeeded",
      type: "destroy",
      createdAt: "2025-01-01T00:00:00.000Z",
      startedAt: "2025-01-01T00:00:02.000Z",
      finishedAt: "2025-01-01T00:00:03.000Z",
    },
  } as const;
  const options = await resolveOptions(
    {
      url: "https://app-staging.takosumi.com",
      workspace: `ws_destroyapply${reconciliation.replaceAll("_", "")}`,
      appName,
      sourceGitUrl: `https://git.example.test/${reconciliation}.git`,
      cloudflareConnectionMode: "none",
      verificationMode: "opentofu",
      noInterfaceProof: true,
      outputAllowlistJson: JSON.stringify({}),
      timeoutSeconds: "1",
      deployTimeoutSeconds: "1",
      pollIntervalMs: "2000",
    },
    {
      TAKOSUMI_ACCOUNT_SESSION_TOKEN: "session-token",
      CLOUDFLARE_API_TOKEN: "cloudflare-token",
      CLOUDFLARE_ACCOUNT_ID: "account-fixture",
      CLOUDFLARE_WORKERS_SUBDOMAIN: "workers.example.test",
    },
  );
  const smokeOptions = destroyEvidenceVerifier
    ? { ...options, destroyEvidenceVerifier }
    : options;
  const originalFetch = globalThis.fetch;
  const requests: Array<{
    readonly method: string;
    readonly url: string;
    readonly body?: string;
  }> = [];
  let destroyApplyPolls = 0;
  globalThis.fetch = (async (input, init) => {
    const requestUrl = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? init.body : undefined;
    requests.push({ method, url: requestUrl.toString(), ...(body ? { body } : {}) });
    if (requestUrl.origin !== smokeOptions.url) {
      throw new Error(`unexpected external fixture request: ${requestUrl}`);
    }
    const path = requestUrl.pathname;
    if (method === "POST" && path === "/api/v1/sources") {
      return Response.json({ source: { id: sourceId } });
    }
    if (method === "POST" && path === `/api/v1/sources/${sourceId}/sync`) {
      return Response.json({ run: runRecords.sync });
    }
    if (method === "GET" && path === `/api/v1/runs/${runRecords.sync.id}`) {
      return Response.json({ run: runRecords.sync });
    }
    if (method === "GET" && path === `/api/v1/sources/${sourceId}/snapshots`) {
      return Response.json({
        snapshots: [
          {
            id: sourceSnapshotId,
            resolvedCommit: "a".repeat(40),
            archiveRef: "r2://fixture/source.tar.zst",
            archiveDigest: `sha256:${"b".repeat(64)}`,
            archiveSizeBytes: 1,
            fetchedByRunId: runRecords.sync.id,
          },
        ],
      });
    }
    if (method === "GET" && path === "/api/v1/capsule-configs") {
      return Response.json({
        installConfigs: [
          {
            id: `cfg_destroy_apply_${reconciliation}_fixture`,
            workspaceId: options.workspace,
          },
        ],
      });
    }
    if (method === "POST" && path === `/api/v1/workspaces/${options.workspace}/capsules`) {
      return Response.json({ capsule: { id: capsuleId, name: appName } });
    }
    if (
      method === "POST" &&
      path === `/api/v1/sources/${sourceId}/compatibility-check`
    ) {
      return Response.json({
        report: {
          id: `compat_destroy_apply_${reconciliation}_fixture`,
          rootProviderRequirements: [],
        },
      });
    }
    if (method === "POST" && path === `/api/v1/capsules/${capsuleId}/plan`) {
      return Response.json({ run: runRecords.planWaitingApproval });
    }
    if (
      method === "GET" &&
      path === `/api/v1/runs/${runRecords.planWaitingApproval.id}`
    ) {
      return Response.json({ run: runRecords.planWaitingApproval });
    }
    if (
      method === "POST" &&
      path === `/api/v1/runs/${runRecords.planWaitingApproval.id}/approve`
    ) {
      return Response.json({ run: runRecords.planSucceeded });
    }
    if (
      method === "POST" &&
      path === `/api/v1/runs/${runRecords.planWaitingApproval.id}/apply`
    ) {
      return Response.json({ run: runRecords.applySucceeded });
    }
    if (method === "GET" && path === `/api/v1/runs/${runRecords.applySucceeded.id}`) {
      return Response.json({ run: runRecords.applySucceeded });
    }
    if (method === "GET" && path === `/api/v1/capsules/${capsuleId}`) {
      return Response.json({
        capsule: {
          id: capsuleId,
          workspaceId: smokeOptions.workspace,
          status: "active",
          currentStateVersionId: stateVersionId,
          currentStateGeneration: 1,
        },
      });
    }
    if (
      method === "GET" &&
      path === `/api/v1/capsules/${capsuleId}/state-versions`
    ) {
      return Response.json({
        stateVersions: [
          {
            id: stateVersionId,
            workspaceId: options.workspace,
            capsuleId,
            environment: smokeOptions.environment,
            createdByRunId: runRecords.applySucceeded.id,
            generation: 1,
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      });
    }
    if (method === "GET" && path === `/api/v1/capsules/${capsuleId}/outputs`) {
      return Response.json({
        output: {
          id: outputId,
          workspaceId: options.workspace,
          capsuleId,
          stateGeneration: 1,
          publicOutputs: {},
          outputDigest: `sha256:${"c".repeat(64)}`,
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      });
    }
    if (
      method === "POST" &&
      path === `/api/v1/capsules/${capsuleId}/destroy-plan`
    ) {
      return Response.json({ run: runRecords.destroyPlanWaitingApproval });
    }
    if (
      method === "GET" &&
      path === `/api/v1/runs/${destroyPlanRunId}`
    ) {
      return Response.json({ run: runRecords.destroyPlanWaitingApproval });
    }
    if (
      method === "POST" &&
      path === `/api/v1/runs/${destroyPlanRunId}/approve`
    ) {
      return Response.json({});
    }
    if (
      method === "POST" &&
      path === `/api/v1/runs/${destroyPlanRunId}/apply`
    ) {
      return Response.json({ run: runRecords.destroyApplyRunning });
    }
    if (method === "GET" && path === `/api/v1/runs/${destroyApplyRunId}`) {
      destroyApplyPolls += 1;
      if (reconciliation === "mismatched") {
        return Response.json({ run: runRecords.destroyApplyStale });
      }
      if (reconciliation === "external_verifier") {
        return Response.json({ run: runRecords.destroyApplyTerminal });
      }
      if (destroyApplyPolls === 1) {
        return Response.json({ run: runRecords.destroyApplyRunning });
      }
      if (reconciliation === "already_terminal") {
        return Response.json({ run: runRecords.destroyApplyTerminal });
      }
      return Response.json({ run: runRecords.destroyApplyRunning });
    }
    if (
      reconciliation === "cancelled" &&
      method === "POST" &&
      path === `/api/v1/runs/${destroyApplyRunId}/cancel`
    ) {
      return Response.json({ run: runRecords.destroyApplyTerminal });
    }
    throw new Error(`unexpected Takosumi fixture request: ${method} ${requestUrl}`);
  }) as typeof fetch;
  try {
    const result = await runPlatformControlPlaneSmoke(smokeOptions);
    return { result, requests, runRecords };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("platform smoke rejects a destroy poll response for a different Run id", async () => {
  const { result, runRecords } = await runDestroyApplyReconciliationFixture(
    "mismatched",
  );
  expect(result.status).toBe("failed");
  expect(result.error).toContain(
    `run ${runRecords.destroyApplyRunning.id} poll returned mismatched run id ${runRecords.destroyApplyStale.id}`,
  );
  expect(result.destroyApplyRunId).toBe(runRecords.destroyApplyRunning.id);
  expect(result.runTimings).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        name: "destroy_apply",
        runId: runRecords.destroyApplyRunning.id,
      }),
    ]),
  );
  expect(
    result.runTimings.some((timing) => timing.runId === runRecords.destroyApplyStale.id),
  ).toBe(false);
});

test.each([
  "cancelled",
  "already_terminal",
] as const)(
  "platform smoke records the exact terminal destroy Run after %s reconciliation",
  async (reconciliation) => {
    const { result, runRecords } = await runDestroyApplyReconciliationFixture(
      reconciliation,
    );
    expect(result.status).toBe("failed");
    expect(result.timedOutRunId).toBe(runRecords.destroyApplyRunning.id);
    expect(result.runCancellationStatus).toBe(reconciliation);
    expect(result.policyStatus).toBe("denied");
    expect(result.destroyApplyRunId).toBe(runRecords.destroyApplyTerminal.id);
    expect(result.runTimings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "destroy_apply",
          runId: runRecords.destroyApplyTerminal.id,
          finishedAt: runRecords.destroyApplyTerminal.finishedAt,
          executionMs: 1_000,
          totalMs: 3_000,
        }),
      ]),
    );
    expect(result.failureCleanup).toMatchObject({
      destroyApplyRunId: runRecords.destroyApplyTerminal.id,
      destroySucceeded: false,
    });
  },
);

test("external destroy verifier accepts the closed result and records host-owned evidence", async () => {
  const root = await destroyVerifierFixtureRoot();
  try {
    const script = await writeDestroyVerifierScript(
      root,
      destroyVerifierResultSource(),
    );
    const verifier = createExternalDestroyEvidenceVerifier({
      verifierId: "takos/takoserver-native-absence@v1",
      script,
      expectedCheckNames: EXTERNAL_DESTROY_CHECK_NAMES,
      timeoutMs: 2_000,
    });
    const evidence = await verifier.verify(destroyVerifierInputFixture());
    expect(evidence.kind).toBe(EXTERNAL_DESTROY_VERIFICATION_KIND);
    expect(evidence.verifierId).toBe("takos/takoserver-native-absence@v1");
    expect(evidence.scriptDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(evidence.resultDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(evidence.checks.map((check) => check.name)).toEqual(
      [...EXTERNAL_DESTROY_CHECK_NAMES],
    );
    expect(evidence.checkCount).toBe(EXTERNAL_DESTROY_CHECK_NAMES.length);
    expect(evidence.durationMs).toBeGreaterThanOrEqual(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolveOptions wires the optional Destroy verifier from the explicit CLI contract", async () => {
  const root = await destroyVerifierFixtureRoot();
  try {
    const script = await writeDestroyVerifierScript(
      root,
      destroyVerifierResultSource(),
    );
    const options = await resolveOptions(
      {
        dryRun: true,
        url: "https://app-staging.takosumi.com",
        workspace: "ws_destroy_verifier_options",
        sourceGitUrl: "https://git.example.test/destroy-verifier-options.git",
        verificationMode: "opentofu",
        noInterfaceProof: true,
        destroyEvidenceVerifierScript: script,
        destroyEvidenceVerifierId: "takos/takoserver-native-absence@v1",
        destroyEvidenceVerifierChecks: JSON.stringify(EXTERNAL_DESTROY_CHECK_NAMES),
        destroyEvidenceVerifierEnv: "TAKOSERVER_API_ORIGIN,TAKOSERVER_EVIDENCE_API_TOKEN",
        destroyEvidenceVerifierTimeoutSeconds: "7",
      },
      {
        TAKOSUMI_ACCOUNT_SESSION_TOKEN: "session-token",
        TAKOSERVER_API_ORIGIN: "https://takoserver.example.test",
        TAKOSERVER_EVIDENCE_API_TOKEN: "evidence-secret",
      },
    );
    const verifier = options.destroyEvidenceVerifier;
    expect(verifier?.verifierId).toBe("takos/takoserver-native-absence@v1");
    expect(verifier?.expectedCheckNames).toEqual([...EXTERNAL_DESTROY_CHECK_NAMES]);
    expect((verifier as { readonly envNames?: readonly string[] }).envNames).toEqual([
      "TAKOSERVER_API_ORIGIN",
      "TAKOSERVER_EVIDENCE_API_TOKEN",
    ]);
    expect((verifier as { readonly timeoutMs?: number }).timeoutMs).toBe(7_000);
    expect(dryRunResult(options).inputs).toMatchObject({
      destroyEvidenceVerifierId: "takos/takoserver-native-absence@v1",
      destroyEvidenceVerifierCheckNames: EXTERNAL_DESTROY_CHECK_NAMES,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("external destroy verifier input projects only allowlisted public Outputs", () => {
  expect(
    projectDestroyEvidencePublicOutputs(
      {
        endpoint_url: "https://worker.example.test",
        resource_identities: { worker: { uid: "uid-worker" } },
        credential_value: "must-not-cross-boundary",
      },
      {
        endpoint_url: { from: "endpoint_url", type: "url", required: true },
        resource_identities: {
          from: "resource_identities",
          type: "json",
          required: true,
        },
      },
    ),
  ).toEqual({
    endpoint_url: "https://worker.example.test",
    resource_identities: { worker: { uid: "uid-worker" } },
  });
});

test("external destroy verifier rejects malformed and extra child output", async () => {
  const root = await destroyVerifierFixtureRoot();
  try {
    const malformed = await writeDestroyVerifierScript(
      root,
      `console.log("not-json");\n`,
    );
    const verifier = createExternalDestroyEvidenceVerifier({
      verifierId: "malformed",
      script: malformed,
      expectedCheckNames: EXTERNAL_DESTROY_CHECK_NAMES,
      timeoutMs: 2_000,
    });
    await expect(verifier.verify(destroyVerifierInputFixture())).rejects.toThrow(
      /stdout must be one JSON object|result/u,
    );

    const extra = await writeDestroyVerifierScript(
      root,
      `console.log(JSON.stringify({kind:${JSON.stringify(EXTERNAL_DESTROY_VERIFIER_RESULT_KIND)},verifierId:"malformed",scriptDigest:"sha256:${"0".repeat(64)}",checks:[],extra:true}));\n`,
    );
    const extraVerifier = createExternalDestroyEvidenceVerifier({
      verifierId: "malformed",
      script: extra,
      expectedCheckNames: [EXTERNAL_DESTROY_CHECK_NAMES[0]],
      timeoutMs: 2_000,
    });
    await expect(
      extraVerifier.verify(destroyVerifierInputFixture()),
    ).rejects.toThrow(/unexpected|missing|checks/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("external destroy verifier bounds timeout and nonzero exits", async () => {
  const root = await destroyVerifierFixtureRoot();
  try {
    const timeoutScript = await writeDestroyVerifierScript(
      root,
      `setTimeout(() => {}, 10_000);\n`,
    );
    const timeoutVerifier = createExternalDestroyEvidenceVerifier({
      verifierId: "timeout",
      script: timeoutScript,
      expectedCheckNames: EXTERNAL_DESTROY_CHECK_NAMES,
      timeoutMs: 20,
    });
    await expect(
      timeoutVerifier.verify(destroyVerifierInputFixture()),
    ).rejects.toThrow(/timed out|timeout/u);

    const oversizedScript = await writeDestroyVerifierScript(
      root,
      `process.stdout.write("x".repeat(70_000));\n`,
    );
    const oversizedVerifier = createExternalDestroyEvidenceVerifier({
      verifierId: "oversized",
      script: oversizedScript,
      expectedCheckNames: EXTERNAL_DESTROY_CHECK_NAMES,
      timeoutMs: 2_000,
    });
    await expect(
      oversizedVerifier.verify(destroyVerifierInputFixture()),
    ).rejects.toThrow(/output exceeded|oversized/u);

    const nonzeroScript = await writeDestroyVerifierScript(
      root,
      `console.error("non-secret verifier failure"); process.exit(7);\n`,
    );
    const nonzeroVerifier = createExternalDestroyEvidenceVerifier({
      verifierId: "nonzero",
      script: nonzeroScript,
      expectedCheckNames: EXTERNAL_DESTROY_CHECK_NAMES,
      timeoutMs: 2_000,
    });
    await expect(
      nonzeroVerifier.verify(destroyVerifierInputFixture()),
    ).rejects.toThrow(/exited with 7/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("external destroy verifier passes no ambient credentials, output values, or ids in argv", async () => {
  const root = await destroyVerifierFixtureRoot();
  try {
    const captureFile = join(root, "capture.json");
    const script = await writeDestroyVerifierScript(
      root,
      destroyVerifierResultSource(),
    );
    const verifier = createExternalDestroyEvidenceVerifier({
      verifierId: "leak-check",
      script,
      expectedCheckNames: EXTERNAL_DESTROY_CHECK_NAMES,
      envNames: ["CAPTURE_FILE"],
      environment: {
        CAPTURE_FILE: captureFile,
        TAKOSUMI_ACCOUNT_SESSION_TOKEN: "ambient-account-secret",
        CLOUDFLARE_API_TOKEN: "ambient-cloudflare-secret",
      },
      timeoutMs: 2_000,
    });
    await verifier.verify(destroyVerifierInputFixture());
    const captured = JSON.parse(await readFile(captureFile, "utf8")) as {
      argv: string[];
      env: Record<string, string>;
      input: { publicOutputs: Record<string, unknown> };
      inputMode: number;
    };
    expect(captured.argv).toHaveLength(2);
    expect(captured.argv[0]).toBe("--input-file");
    expect(captured.argv[1]).toMatch(/input\.json$/u);
    expect(captured.inputMode).toBe(0o600);
    expect(Object.keys(captured.env)).toEqual(["CAPTURE_FILE"]);
    expect(captured.env).not.toHaveProperty("TAKOSUMI_ACCOUNT_SESSION_TOKEN");
    expect(captured.env).not.toHaveProperty("CLOUDFLARE_API_TOKEN");
    expect(captured.input.publicOutputs.endpoint_url).toBe(
      "https://worker.example.test",
    );
    expect(JSON.stringify(captured)).not.toContain("ambient-account-secret");
    expect(JSON.stringify(captured)).not.toContain("ambient-cloudflare-secret");
    expect(JSON.stringify(verifier)).not.toContain("ambient-account-secret");
    expect(JSON.stringify(verifier)).not.toContain("ambient-cloudflare-secret");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("external destroy verifier rejects duplicate and missing expected checks", async () => {
  const root = await destroyVerifierFixtureRoot();
  try {
    const duplicateScript = await writeDestroyVerifierScript(
      root,
      destroyVerifierResultSource([
        EXTERNAL_DESTROY_CHECK_NAMES[0],
        EXTERNAL_DESTROY_CHECK_NAMES[0],
        ...EXTERNAL_DESTROY_CHECK_NAMES.slice(2),
      ]),
    );
    const verifier = createExternalDestroyEvidenceVerifier({
      verifierId: "duplicate",
      script: duplicateScript,
      expectedCheckNames: EXTERNAL_DESTROY_CHECK_NAMES,
      timeoutMs: 2_000,
    });
    await expect(verifier.verify(destroyVerifierInputFixture())).rejects.toThrow(
      /duplicate|exact|expected/u,
    );

    const missingScript = await writeDestroyVerifierScript(
      root,
      destroyVerifierResultSource(EXTERNAL_DESTROY_CHECK_NAMES.slice(0, -1)),
    );
    const missingVerifier = createExternalDestroyEvidenceVerifier({
      verifierId: "missing",
      script: missingScript,
      expectedCheckNames: EXTERNAL_DESTROY_CHECK_NAMES,
      timeoutMs: 2_000,
    });
    await expect(
      missingVerifier.verify(destroyVerifierInputFixture()),
    ).rejects.toThrow(/expected|exact|missing/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("external destroy verifier failure retains Destroy progress without re-destroying", async () => {
  const destroyEvidenceVerifier: DestroyEvidenceVerifier = {
    verifierId: "takos/external-failure@v1",
    expectedCheckNames: ["worker_endpoint"],
    async verify() {
      throw new Error("external verifier unavailable");
    },
  };
  const { result, requests, runRecords } =
    await runDestroyApplyReconciliationFixture(
      "external_verifier",
      destroyEvidenceVerifier,
    );
  expect(result.status).toBe("failed");
  expect(result.error).toContain("external verifier unavailable");
  expect(result.completedSteps).not.toContain("destroy");
  expect(result.destroyPlanRunId).toBe(runRecords.destroyPlanWaitingApproval.id);
  expect(result.destroyApplyRunId).toBe(runRecords.destroyApplyTerminal.id);
  expect(result.destroyVerified).toBe(false);
  expect(
    requests.filter(
      (request) =>
        request.method === "POST" &&
        request.url.includes("/destroy-plan"),
    ),
  ).toHaveLength(1);
  expect(
    requests.filter(
      (request) =>
        request.method === "POST" &&
        request.url.endsWith(`/runs/${runRecords.destroyPlanWaitingApproval.id}/apply`),
    ),
  ).toHaveLength(1);
});
