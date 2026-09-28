import { expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { workspaceForRun } from "../../runner/lib/artifacts.ts";
import { runPlan, runReviewedPlanApply } from "../../runner/lib/plan_apply.ts";
import { generateOpenTofuChildModuleRoot } from "../../lib/rootgen/src/mod.ts";

test("legacy source-less destroy operator modules require the internal drain marker and generated root", async () => {
  const runId = `legacy-sourceless-destroy-${crypto.randomUUID()}`;
  const workspace = workspaceForRun(runId);
  try {
    const generatedRoot = generateOpenTofuChildModuleRoot({
      rootProviderRequirements: [],
      inputs: {},
      outputAllowlist: {
        message: { from: "message", type: "string" },
      },
    });
    const legacyRequest = {
      planRun: {
        operation: "destroy",
        source: {
          kind: "operator_module",
          digest:
            "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        },
      },
      generatedRoot,
      operatorModule: {
        files: [
          {
            path: "main.tf",
            text: 'output "message" {\n  value = "resource-module"\n}\n',
          },
        ],
      },
      requiredProviders: [],
      runnerProfile: {
        id: "legacy-recovery",
        allowedProviders: [],
        requireProviderBindings: false,
      },
      outputAllowlist: {
        message: { from: "message" },
      },
    } as const;

    for (const operation of ["create", "update"] as const) {
      await expect(
        runPlan(`${runId}-${operation}`, {
          ...legacyRequest,
          planRun: { ...legacyRequest.planRun, operation },
        }),
      ).rejects.toThrow(
        "operator_module is limited to internal legacy source-less destroy recovery",
      );
    }
    await expect(runPlan(`${runId}-unmarked`, legacyRequest)).rejects.toThrow(
      "operator_module is limited to internal legacy source-less destroy recovery",
    );

    const result = await runPlan(runId, {
      ...legacyRequest,
      legacySourcelessDestroyRecovery: true,
    });

    expect(result.status).toBe("succeeded");
    expect(result.planDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(result.plannedOutputs).toBeUndefined();
    expect(generatedRoot.files["main.tf"]).toContain("from = module.app");
    const moduleInfo = JSON.parse(
      await readFile(workspace.moduleInfoPath, "utf8"),
    ) as { readonly moduleDir: string };
    expect(moduleInfo.moduleDir).toBe(workspace.generatedRootDir);

    await expect(
      runPlan(`${runId}-missing-root`, {
        legacySourcelessDestroyRecovery: true,
        planRun: {
          operation: "destroy",
          source: {
            kind: "operator_module",
            digest: "sha256:module",
          },
        },
        operatorModule: {
          files: [{ path: "main.tf", text: "terraform {}" }],
        },
      }),
    ).rejects.toThrow("operatorModule requires a generated root");
  } finally {
    await rm(workspace.root, { recursive: true, force: true });
    await rm(workspace.depsDir, { recursive: true, force: true });
  }
});

test("legacy destroy roots keep implicit terraform_data as a built-in runtime capability", async () => {
  const runId = `legacy-builtin-destroy-${crypto.randomUUID()}`;
  const workspace = workspaceForRun(runId);
  try {
    const generatedRoot = generateOpenTofuChildModuleRoot({
      rootProviderRequirements: [
        {
          source: "terraform.io/builtin/terraform",
          moduleLocalName: "terraform",
        },
      ],
      inputs: {},
      outputAllowlist: {},
    });

    expect(generatedRoot.files["versions.tf"]).not.toContain(
      "terraform.io/builtin/terraform",
    );
    expect(generatedRoot.files["main.tf"]).not.toContain(
      "terraform = terraform",
    );

    const result = await runPlan(runId, {
      legacySourcelessDestroyRecovery: true,
      planRun: {
        operation: "destroy",
        source: {
          kind: "operator_module",
          digest:
            "sha256:123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0",
        },
      },
      generatedRoot,
      operatorModule: {
        files: [
          {
            path: "main.tf",
            text: [
              'resource "terraform_data" "implicit" {',
              '  input = "runtime-capability"',
              "}",
              "",
            ].join("\n"),
          },
        ],
      },
      requiredProviders: [],
      runnerProfile: {
        id: "legacy-builtin-recovery",
        allowedProviders: [],
        requireProviderBindings: false,
      },
      outputAllowlist: {},
    });

    expect(result.status).toBe("succeeded");
    expect(result.planDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
  } finally {
    await rm(workspace.root, { recursive: true, force: true });
    await rm(workspace.depsDir, { recursive: true, force: true });
  }
});

test("restored Git SourceSnapshot modules plan directly as the OpenTofu root", async () => {
  const runId = `direct-root-${crypto.randomUUID()}`;
  const workspace = workspaceForRun(runId);
  const moduleDir = join(workspace.sourceRoot, "infra");
  await mkdir(moduleDir, { recursive: true });
  await writeFile(
    join(moduleDir, "main.tf"),
    [
      'variable "message" {',
      "  type = string",
      "}",
      "",
      'output "message" {',
      "  value = var.message",
      "}",
      "",
    ].join("\n"),
  );

  try {
    const request = {
      planRun: {
        operation: "create",
        source: {
          kind: "git",
          url: "https://git.example.com/example/capsule.git",
          commit: "0123456789abcdef0123456789abcdef01234567",
          modulePath: "infra",
        },
      },
      variables: { message: "plain-module" },
      outputAllowlist: {
        message: { from: "message" },
      },
    };
    const result = await runPlan(runId, request);

    expect(result.status).toBe("succeeded");
    expect(result.plannedOutputs).toEqual({
      message: { sensitive: false, value: "plain-module" },
    });
    const phaseTimings = result.phaseTimings as
      | readonly { readonly phase: string; readonly durationMs: number }[]
      | undefined;
    for (const phase of ["runner_plan_prepare", "runner_plan_finalize"]) {
      const timing = phaseTimings?.find((entry) => entry.phase === phase);
      expect(timing).toBeDefined();
      expect(Number.isFinite(timing?.durationMs)).toBe(true);
      expect(timing?.durationMs).toBeGreaterThan(0);
    }

    const moduleInfo = JSON.parse(
      await readFile(workspace.moduleInfoPath, "utf8"),
    ) as { readonly moduleDir: string };
    expect(moduleInfo.moduleDir).toBe(join(workspace.sourceRoot, "infra"));
    expect(moduleInfo.moduleDir).not.toContain("generated-root");
    expect(
      JSON.parse(
        await readFile(join(workspace.root, "run-inputs.tfvars.json"), "utf8"),
      ),
    ).toEqual({ message: "plain-module" });

    const apply = await runReviewedPlanApply(
      runId,
      "apply",
      { ...request, planArtifact: { digest: result.planDigest } },
    );
    expect(apply.status).toBe("succeeded");
    expect(
      (apply.phaseTimings as readonly { readonly phase: string }[]).some(
        (entry) => entry.phase.startsWith("runner_plan_"),
      ),
    ).toBe(false);
  } finally {
    await rm(workspace.root, { recursive: true, force: true });
    await rm(workspace.depsDir, { recursive: true, force: true });
  }
});

test("direct-root failed and destroy plans do not expose successful-plan-only timers", async () => {
  const failedRunId = `direct-root-failed-${crypto.randomUUID()}`;
  const failedWorkspace = workspaceForRun(failedRunId);
  const failedModuleDir = join(failedWorkspace.sourceRoot, "infra");
  await mkdir(failedModuleDir, { recursive: true });
  await writeFile(
    join(failedModuleDir, "main.tf"),
    [
      'variable "reject" {',
      "  type = bool",
      "  validation {",
      "    condition     = var.reject",
      '    error_message = "intentional validation failure"',
      "  }",
      "}",
      "",
    ].join("\n"),
  );

  const destroyRunId = `direct-root-destroy-${crypto.randomUUID()}`;
  const destroyWorkspace = workspaceForRun(destroyRunId);
  const destroyModuleDir = join(destroyWorkspace.sourceRoot, "infra");
  await mkdir(destroyModuleDir, { recursive: true });
  await writeFile(
    join(destroyModuleDir, "main.tf"),
    'output "message" {\n  value = "destroy-plan"\n}\n',
  );

  try {
    const failed = await runPlan(failedRunId, {
      planRun: {
        operation: "create",
        source: {
          kind: "git",
          url: "https://git.example.com/example/capsule.git",
          commit: "0123456789abcdef0123456789abcdef01234567",
          modulePath: "infra",
        },
      },
      variables: { reject: false },
    });
    expect(failed.status).toBe("failed");
    expect(
      (failed.phaseTimings as readonly { readonly phase: string }[]).some(
        (entry) => entry.phase.startsWith("runner_plan_"),
      ),
    ).toBe(false);

    const destroyRequest = {
      planRun: {
        operation: "destroy",
        source: {
          kind: "git",
          url: "https://git.example.com/example/capsule.git",
          commit: "0123456789abcdef0123456789abcdef01234567",
          modulePath: "infra",
        },
      },
    };
    const destroyPlan = await runPlan(destroyRunId, destroyRequest);
    expect(destroyPlan.status).toBe("succeeded");
    expect(
      (destroyPlan.phaseTimings as readonly { readonly phase: string }[]).some(
        (entry) => entry.phase.startsWith("runner_plan_"),
      ),
    ).toBe(false);
    const destroy = await runReviewedPlanApply(
      destroyRunId,
      "destroy",
      {
        ...destroyRequest,
        planArtifact: { digest: destroyPlan.planDigest },
      },
    );
    expect(destroy.status).toBe("succeeded");
    expect(
      (destroy.phaseTimings as readonly { readonly phase: string }[]).some(
        (entry) => entry.phase.startsWith("runner_plan_"),
      ),
    ).toBe(false);
  } finally {
    for (const workspace of [failedWorkspace, destroyWorkspace]) {
      await rm(workspace.root, { recursive: true, force: true });
      await rm(workspace.depsDir, { recursive: true, force: true });
    }
  }
});
