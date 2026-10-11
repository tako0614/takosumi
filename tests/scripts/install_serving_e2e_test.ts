import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runSourceBuild } from "../../runner/lib/source_build.ts";

import {
  DEFAULT_ORIGIN,
  INSTALL_SERVING_E2E_KIND,
  PHASE_GROUPS,
  buildSmokeInvocation,
  canonicalProviderSource,
  dryRunPlan,
  firstRunDiagnosticMessage,
  normalizeOrigin,
  phaseOfStep,
  phaseOfRunType,
  redactInvocation,
  resolveHarnessOptions,
  runInstallServingE2e,
  selectTakoformConnection,
  selectNewestFailedRun,
  selectOwnCapsule,
  summarizeSmokeResult,
} from "../../scripts/install-serving-e2e.ts";

const TOKEN_FILE = "/private/takosumi/install-e2e-pat";

function options(overrides: Record<string, string> = {}) {
  const argv = [
    "--workspace",
    "ws_integration",
    "--token-file",
    TOKEN_FILE,
    ...Object.entries(overrides).flat(),
  ];
  return resolveHarnessOptions(argv, {});
}

test("defaults pin the integration origin and the yurucommu profile", () => {
  const resolved = options();
  expect(resolved.origin).toBe(DEFAULT_ORIGIN);
  expect(resolved.environment).toBe("integration");
  expect(resolved.profile.id).toBe("yurucommu");
  expect(resolved.profile.sourceGitUrl).toBe(
    "https://github.com/tako0614/yurucommu.git",
  );
  expect(resolved.profile.sourcePath).toBe(".");
  expect(resolved.profile.modulePath).toBe("deploy/takoform");
  expect(resolved.appName.startsWith("yuru-install-e2e-")).toBe(true);
  expect(resolved.evidenceDir.includes("takosumi-install-serving-e2e"))
    .toBe(true);
  expect(resolved.authTokenKind).toBe("pat");
});

test("workspace and token file may come from the documented environment", () => {
  const resolved = resolveHarnessOptions([], {
    TAKOSUMI_INSTALL_E2E_WORKSPACE: "@integration",
    TAKOSUMI_INSTALL_E2E_TOKEN_FILE: TOKEN_FILE,
  });
  expect(resolved.workspace).toBe("@integration");
  expect(resolved.tokenFile).toBe(TOKEN_FILE);
});

test("missing workspace, missing token, and relative token paths fail closed", () => {
  expect(() => resolveHarnessOptions(["--token-file", TOKEN_FILE], {})).toThrow(
    /--workspace/,
  );
  expect(() => resolveHarnessOptions(["--workspace", "ws_a"], {})).toThrow(
    /--token-file/,
  );
  expect(() =>
    resolveHarnessOptions([
      "--workspace",
      "ws_a",
      "--token-file",
      "relative/pat",
    ], {})
  ).toThrow(/absolute path/);
});

test("unknown options are refused instead of ignored", () => {
  expect(() => resolveHarnessOptions(["--nope", "value"], {})).toThrow(
    /unknown option/,
  );
});

test("the smoke invocation pins the install-to-serving contract", () => {
  const args = buildSmokeInvocation(options(), {
    workspaceId: "ws_integration",
    connectionId: "conn_takoform",
  });
  const joined = args.join(" ");
  expect(args[0]).toBe("run");
  expect(args[1]).toBe("smoke:platform-control-plane");
  expect(joined).toContain("--provider-connection-id conn_takoform");
  expect(joined).toContain("--cloudflare-connection-mode none");
  expect(joined).toContain("--verification-mode opentofu");
  expect(joined).toContain("--source-path . ");
  expect(joined).toContain("--module-path deploy/takoform");
  expect(joined).toContain("--runtime-public-url-output launch_url");
  expect(joined).toContain(`--pat-token-file ${TOKEN_FILE}`);
  expect(joined).not.toContain("--source-ref");
  expect(joined).toContain("--out-file");
});

// The compatibility check proves an explicit module path against the
// SourceSnapshot module index, and that index is relative to the snapshot
// subtree pinned by the Source path. Repeating a scoped Source path in the
// module path made staging answer 400 repository_install_ux_module_missing.
test("the pinned module path is relative to the Source root", () => {
  const { profile } = options();
  expect(profile.sourcePath).toBe(".");
  expect(profile.modulePath).toBe("deploy/takoform");
  expect(profile.modulePath.startsWith("/")).toBe(false);
  expect(dryRunPlan(options()).modulePath).toBe("deploy/takoform");
  expect(dryRunPlan(options()).sourcePath).toBe(".");
});

// Mirrors Yurucommu's `.well-known/takosumi.json` `deploy/takoform` module
// (declared since 2026-09-04, unchanged through main 28c5e20): its
// `sourceBuild` has no `workingDirectory`, so every command runs at the
// SourceSnapshot root, needs the repository-root `package.json` and
// `scripts/`, and must produce repository-root `deploy/takoform/...` outputs.
const YURUCOMMU_SHAPED_SOURCE_BUILD_OUTPUTS = [
  "deploy/takoform/.generated/yurucommu-worker.js",
  "deploy/takoform/migrations/sql",
] as const;

async function yurucommuShapedRepository(): Promise<string> {
  const repository = await mkdtemp(join(tmpdir(), "install-serving-repo-"));
  await mkdir(join(repository, "scripts"), { recursive: true });
  await mkdir(join(repository, "deploy/takoform/migrations/sql"), {
    recursive: true,
  });
  await writeFile(join(repository, "package.json"), "{}\n");
  await writeFile(join(repository, "deploy/takoform/main.tf"), "");
  await writeFile(
    join(repository, "scripts/prepare-takoform-v1-source.ts"),
    [
      'import { mkdirSync, readFileSync, writeFileSync } from "node:fs";',
      'readFileSync("package.json");',
      'mkdirSync("deploy/takoform/.generated", { recursive: true });',
      'writeFileSync("deploy/takoform/.generated/yurucommu-worker.js", "export default {};\\n");',
      "",
    ].join("\n"),
  );
  return repository;
}

test("the Source root is where the module's repository-owned sourceBuild runs", async () => {
  const repository = await yurucommuShapedRepository();
  const sourceBuild = {
    commands: [
      { argv: [process.execPath, "scripts/prepare-takoform-v1-source.ts"] },
    ],
    outputs: [...YURUCOMMU_SHAPED_SOURCE_BUILD_OUTPUTS],
  };
  try {
    const { profile } = options();
    // The runner restores the archive of `sourcePath` as its snapshot root and
    // runs the build there before resolving `modulePath` inside it.
    const snapshotRoot = join(repository, profile.sourcePath);
    await expect(runSourceBuild(sourceBuild, snapshotRoot)).resolves.toContain(
      "source build 1/1",
    );
    expect(existsSync(join(snapshotRoot, profile.modulePath, "main.tf"))).toBe(
      true,
    );
    // A Source scoped to the module subtree has neither the repository-root
    // inputs nor room for the repository-root outputs, which is the staging
    // `source_build_failed` this profile used to hit.
    await expect(
      runSourceBuild(sourceBuild, join(repository, "deploy/takoform")),
    ).rejects.toThrow(/source build 1\/1 .* failed/);
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});

test("public URL checks demand real content and a post-destroy 404", () => {
  const args = buildSmokeInvocation(options(), {
    workspaceId: "ws_integration",
    connectionId: "conn_takoform",
  });
  const index = args.indexOf("--public-url-checks-json");
  const checks = JSON.parse(args[index + 1] ?? "[]") as readonly {
    readonly path: string;
    readonly expectedStatus: number;
    readonly bodyIncludes: readonly string[];
    readonly destroyExpectation: { readonly kind: string };
  }[];
  expect(checks.map((check) => check.path)).toEqual([
    "/healthz",
    "/readyz",
    "/.well-known/social-server",
    "/nodeinfo/2.0",
  ]);
  for (const check of checks) {
    expect(check.expectedStatus).toBe(200);
    expect(check.destroyExpectation.kind).toBe("http-404");
    expect(check.bodyIncludes.length).toBeGreaterThan(0);
  }
});

test("a session token selects the session flag", () => {
  const resolved = resolveHarnessOptions([
    "--workspace",
    "ws_integration",
    "--session-token-file",
    TOKEN_FILE,
  ], {});
  expect(resolved.authTokenKind).toBe("session");
  const args = buildSmokeInvocation(resolved, {
    workspaceId: "ws_integration",
    connectionId: "conn_takoform",
  });
  expect(args.join(" ")).toContain(`--session-token-file ${TOKEN_FILE}`);
});

test("an apply failure names the apply phase and the failing step", () => {
  const summary = summarizeSmokeResult({
    status: "failed",
    steps: [
      "existingProviderConnectionSelected",
      "sourceRegistered",
      "sourceSynced",
      "scratchInstall",
      "compatibilityChecked",
      "plan",
      "apply",
      "stateVersionLedgerVerified",
      "publicUrlVerified",
      "destroy",
      "runEventSequenceVerified",
    ],
    completedSteps: [
      "existingProviderConnectionSelected",
      "sourceRegistered",
      "sourceSynced",
      "scratchInstall",
      "compatibilityChecked",
      "plan",
    ],
    stepTimings: [{ step: "plan", durationMs: 1200 }],
    planRunId: "plan_1",
    applyRunId: "apply_1",
  });
  expect(summary.failedPhase).toBe("apply");
  expect(summary.failedStep).toBe("apply");
  expect(summary.notReachedPhases).toContain("serving");
  expect(summary.notReachedPhases).toContain("destroy");
  expect(summary.runIds.apply).toBe("apply_1");
  expect(summary.phases.find((phase) => phase.phase === "plan")?.status)
    .toBe("passed");
});

test("an HTTP failure names the serving phase", () => {
  const summary = summarizeSmokeResult({
    status: "failed",
    steps: ["plan", "apply", "stateVersionLedgerVerified", "publicUrlVerified"],
    completedSteps: ["plan", "apply", "stateVersionLedgerVerified"],
  });
  expect(summary.failedPhase).toBe("serving");
});

test("a passed run reports every declared phase as reached", () => {
  const steps = ["plan", "apply", "destroy"];
  const summary = summarizeSmokeResult({
    status: "passed",
    steps,
    completedSteps: steps,
  });
  expect(summary.failedPhase).toBe("complete");
  expect(summary.failedStep).toBeUndefined();
  expect(summary.notReachedPhases).toEqual([]);
  expect(summary.phases.every((phase) => phase.status === "passed")).toBe(true);
});

test("phase lookup covers only the declared step vocabulary", () => {
  for (const group of PHASE_GROUPS) {
    for (const step of group.steps) expect(phaseOfStep(step)).toBe(group.phase);
  }
  expect(phaseOfStep("something_new")).toBe("unknown");
});

test("connection discovery accepts exactly one takoform connection", () => {
  expect(
    selectTakoformConnection([
      { id: "conn_other", providerSource: "registry.terraform.io/cloudflare/cloudflare" },
      { id: "conn_takoform", providerSource: "registry.opentofu.org/tako0614/takoform" },
    ]),
  ).toEqual({
    id: "conn_takoform",
    providerSource: "registry.terraform.io/tako0614/takoform",
  });
  expect(() => selectTakoformConnection([])).toThrow(/no registry/);
  expect(() =>
    selectTakoformConnection([
      {
        id: "conn_a",
        providerSource: "registry.terraform.io/tako0614/takoform",
        credentialRecipe: { authMode: "broker-renewable" },
      },
      {
        id: "conn_b",
        providerSource: "registry.terraform.io/tako0614/takoform",
        credentialRecipe: { authMode: "broker-renewable" },
      },
    ])
  ).toThrow(/pass --connection-id/);
  expect(() =>
    selectTakoformConnection([
      { id: "conn_a", providerSource: "registry.terraform.io/tako0614/takoform" },
    ], "conn_missing")
  ).toThrow(/not in this Workspace/);
});

test("the current renewable run-credential connection wins over its predecessor", () => {
  expect(
    selectTakoformConnection([
      {
        id: "conn_takoserverTakoform01",
        providerSource: "registry.terraform.io/tako0614/takoform",
        credentialRecipe: { authMode: "broker" },
      },
      {
        id: "conn_takoserverTakoformRenew01",
        providerSource: "registry.terraform.io/tako0614/takoform",
        credentialRecipe: { authMode: "broker-renewable" },
      },
    ]),
  ).toEqual({
    id: "conn_takoserverTakoformRenew01",
    providerSource: "registry.terraform.io/tako0614/takoform",
  });
});

test("provider sources canonicalize the retired opentofu host", () => {
  expect(canonicalProviderSource("registry.opentofu.org/Cloudflare/Cloudflare"))
    .toBe("registry.terraform.io/cloudflare/cloudflare");
  expect(canonicalProviderSource("registry.terraform.io/tako0614/takoform"))
    .toBe("registry.terraform.io/tako0614/takoform");
});

test("the first error diagnostic is surfaced without the raw payload", () => {
  expect(
    firstRunDiagnosticMessage({
      diagnostics: [
        { severity: "info", code: "started", message: "started" },
        {
          severity: "error",
          code: "apply_failed",
          message: "renewed credential does not match the pinned binding",
        },
      ],
      auditEvents: [{ secret: "must not leak" }],
    }),
  ).toBe("apply_failed: renewed credential does not match the pinned binding");
  expect(firstRunDiagnosticMessage({})).toBeUndefined();
});

test("a diagnostic's redacted detail is kept as one bounded line", () => {
  const message = firstRunDiagnosticMessage({
    diagnostics: [{
      severity: "error",
      code: "source_build_failed",
      message: "runner failure (source_build_failed)",
      detail: "source build 1/3 (bun) failed with exit code 1\noutput: error: Bun could not find a package.json file to install from\nnote: Run \"bun init\" to initialize a project",
    }],
  });
  expect(message).toBe(
    "source_build_failed: runner failure (source_build_failed) (source build 1/3 (bun) failed with exit code 1 output: error: Bun could not find a package.json file to install from note: Run \"bun init\" to initialize a project)",
  );
  const long = firstRunDiagnosticMessage({
    diagnostics: [{ severity: "error", message: "failed", detail: "x".repeat(2_000) }],
  });
  expect(long?.length).toBeLessThan(400);
  expect(long?.endsWith("...)")).toBe(true);
});

test("evidence redaction never keeps the credential path in the plan", () => {
  const redacted = redactInvocation(["--pat-token-file", TOKEN_FILE, "--json"]);
  expect(redacted).toEqual(["--pat-token-file", "<redacted>", "--json"]);
  const plan = JSON.stringify(dryRunPlan(options()));
  expect(plan).toContain(INSTALL_SERVING_E2E_KIND);
  expect(plan).not.toContain(TOKEN_FILE);
  expect(plan).toContain("<redacted>");
});

test("only bare https origins are accepted", () => {
  expect(normalizeOrigin("https://app-staging.takosumi.com/")).toBe(
    "https://app-staging.takosumi.com",
  );
  expect(() => normalizeOrigin("http://app-staging.takosumi.com")).toThrow(
    /https/,
  );
  expect(() => normalizeOrigin("https://app-staging.takosumi.com/api/v1"))
    .toThrow(/bare https origin/);
});

const SMOKE_SKELETON_STEPS = [
  "existingProviderConnectionSelected",
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
  "runEventSequenceVerified",
] as const;

const RENEWABLE_TAKOFORM_CONNECTION = {
  providerConnections: [
    {
      id: "conn_renew",
      providerSource: "registry.terraform.io/tako0614/takoform",
      credentialRecipe: { authMode: "broker-renewable" },
    },
  ],
} as const;

test("a Capsule is matched by the app name and environment this run pinned", () => {
  expect(
    selectOwnCapsule([
      { id: "cap_a", name: "someone-elses-app", environment: "integration" },
      { id: "cap_b", name: "yuru-install-e2e-test00", environment: "production" },
      {
        id: "cap_c",
        name: "yuru-install-e2e-test00",
        environment: "integration",
        status: "error",
      },
    ], { appName: "yuru-install-e2e-test00", environment: "integration" }),
  ).toEqual({
    id: "cap_c",
    name: "yuru-install-e2e-test00",
    environment: "integration",
    status: "error",
  });
  expect(selectOwnCapsule([], { appName: "yuru-install-e2e-test00" }))
    .toBeUndefined();
});

test("Run types share the smoke step phase vocabulary", () => {
  expect(phaseOfRunType("compatibility_check")).toBe("compatibility");
  expect(phaseOfRunType("source_sync")).toBe("source");
  expect(phaseOfRunType("plan")).toBe("plan");
  expect(phaseOfRunType("apply")).toBe("apply");
  expect(phaseOfRunType("destroy")).toBeUndefined();
});

test("only this Capsule's failed Runs are candidates, newest first", () => {
  expect(
    selectNewestFailedRun([
      {
        id: "plan_old",
        capsuleId: "cap_a",
        type: "plan",
        status: "failed",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "plan_new",
        capsuleId: "cap_a",
        type: "plan",
        status: "failed",
        createdAt: "2026-01-02T00:00:00.000Z",
      },
      {
        id: "plan_other",
        capsuleId: "cap_b",
        type: "plan",
        status: "failed",
        createdAt: "2026-01-03T00:00:00.000Z",
      },
      {
        id: "apply_ok",
        capsuleId: "cap_a",
        type: "apply",
        status: "succeeded",
        createdAt: "2026-01-04T00:00:00.000Z",
      },
    ], "cap_a")?.id,
  ).toBe("plan_new");
  expect(selectNewestFailedRun([], "cap_a")).toBeUndefined();
});

type StubRoute = (url: URL) => unknown;

/**
 * Drive the real classifier with a stubbed control plane and a stubbed smoke
 * child, so the failure path is exercised without touching a live Run.
 */
async function runWithStubbedControlPlane(input: {
  readonly routes: readonly StubRoute[];
  readonly smokeResult: Readonly<Record<string, unknown>>;
}): Promise<{ readonly outcome: Awaited<ReturnType<typeof runInstallServingE2e>> }> {
  const dir = await mkdtemp(join(tmpdir(), "install-serving-e2e-test-"));
  const tokenFile = join(dir, "pat");
  await writeFile(tokenFile, "test-token\n", { mode: 0o600 });
  const evidenceDir = join(dir, "evidence");
  const originalFetch = globalThis.fetch;
  const originalWrite = process.stdout.write.bind(process.stdout);
  globalThis.fetch = (async (request: Request | string | URL) => {
    const url = new URL(
      typeof request === "string"
        ? request
        : request instanceof URL
        ? request.href
        : request.url,
    );
    // The edge routes only the public `/api/v1` surface; `/internal/v1` is an
    // in-process seam that a deployed environment always answers with 404.
    if (url.pathname.startsWith("/internal/")) {
      return new Response(JSON.stringify({ error: { code: "not_found" } }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }
    for (const route of input.routes) {
      const body = route(url);
      if (body !== undefined) {
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
    }
    throw new Error("unexpected control-plane request " + url.pathname);
  }) as typeof fetch;
  process.stdout.write = (() => true) as typeof process.stdout.write;
  try {
    const outcome = await runInstallServingE2e(
      resolveHarnessOptions([
        "--workspace",
        "ws_test",
        "--token-file",
        tokenFile,
        "--app-name",
        "yuru-install-e2e-test00",
        "--evidence-dir",
        evidenceDir,
        "--json",
      ], {}),
      {
        runChild: async ({ stdoutPath, stderrPath }) => {
          await writeFile(stdoutPath, "");
          await writeFile(stderrPath, "");
          await writeFile(
            join(evidenceDir, "smoke-result.json"),
            JSON.stringify(input.smokeResult, null, 2),
          );
          return 1;
        },
      },
    );
    return { outcome };
  } finally {
    globalThis.fetch = originalFetch;
    process.stdout.write = originalWrite;
  }
}

test("a coordinator failure is attributed to the Run that failed, not the step gap", async () => {
  const { outcome } = await runWithStubbedControlPlane({
    routes: [
      (url) =>
        url.pathname === "/api/v1/provider-connections"
          ? RENEWABLE_TAKOFORM_CONNECTION
          : undefined,
      (url) =>
        url.pathname === "/api/v1/workspaces/ws_test/capsules"
          ? {
            capsules: [{
              id: "cap_test",
              name: "yuru-install-e2e-test00",
              environment: "integration",
              status: "error",
            }],
          }
          : undefined,
      (url) =>
        url.pathname === "/api/v1/workspaces/ws_test/runs"
          ? {
            runs: [{
              id: "plan_test",
              capsuleId: "cap_test",
              type: "plan",
              status: "failed",
              errorCode: "source_build_failed",
              createdAt: "2026-01-01T00:00:00.000Z",
            }],
          }
          : undefined,
      (url) =>
        url.pathname === "/api/v1/runs/plan_test"
          ? {
            run: {
              id: "plan_test",
              status: "failed",
              errorCode: "source_build_failed",
            },
          }
          : undefined,
      (url) =>
        url.pathname === "/api/v1/runs/plan_test/logs"
          ? {
            diagnostics: [{
              severity: "error",
              code: "source_build_failed",
              message: "the module source build failed",
            }],
          }
          : undefined,
    ],
    smokeResult: {
      kind: "takosumi.platform-control-plane-smoke@v3",
      status: "failed",
      steps: SMOKE_SKELETON_STEPS,
      completedSteps: ["existingProviderConnectionSelected"],
      error: "install coordinator ended without a reviewable Plan (plan_run_failed)",
    },
  });
  expect(outcome.status).toBe("failed");
  // The smoke's step gap alone would say "source"; the failing Run says "plan".
  expect(outcome.phase).toBe("plan");
  expect(outcome.failedRunId).toBe("plan_test");
  expect(outcome.reason).toContain("source_build_failed");
  expect(outcome.reason).toContain("the module source build failed");
  expect(outcome.leftoverCapsule).toEqual({ id: "cap_test", status: "error" });
});

test("an apply failure keeps the apply phase and reports that nothing is left", async () => {
  const { outcome } = await runWithStubbedControlPlane({
    routes: [
      (url) =>
        url.pathname === "/api/v1/provider-connections"
          ? RENEWABLE_TAKOFORM_CONNECTION
          : undefined,
      (url) =>
        url.pathname === "/api/v1/workspaces/ws_test/capsules"
          ? { capsules: [] }
          : undefined,
      (url) =>
        url.pathname === "/api/v1/runs/apply_test"
          ? { run: { id: "apply_test", status: "failed", errorCode: "apply_failed" } }
          : undefined,
      (url) =>
        url.pathname === "/api/v1/runs/apply_test/logs"
          ? {
            diagnostics: [{
              severity: "error",
              code: "apply_failed",
              message: "renewed credential does not match the pinned binding",
            }],
          }
          : undefined,
    ],
    smokeResult: {
      status: "failed",
      steps: SMOKE_SKELETON_STEPS,
      completedSteps: [
        "existingProviderConnectionSelected",
        "sourceRegistered",
        "sourceSynced",
        "scratchInstall",
        "compatibilityChecked",
        "plan",
      ],
      planRunId: "plan_test",
      applyRunId: "apply_test",
      error: "apply failed",
    },
  });
  expect(outcome.phase).toBe("apply");
  expect(outcome.failedRunId).toBe("apply_test");
  expect(outcome.leftoverCapsule).toBeUndefined();
  expect(outcome.reason).toContain("renewed credential does not match the pinned binding");
  expect(outcome.reason).toContain("nothing to clean up");
});
