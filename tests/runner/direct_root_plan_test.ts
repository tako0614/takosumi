import { expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { workspaceForRun } from "../../runner/lib/artifacts.ts";
import { runPlan } from "../../runner/lib/plan_apply.ts";
import { generateOpenTofuChildModuleRoot } from "../../lib/rootgen/src/mod.ts";

test("first-class Resource operator modules execute only through an explicit generated root", async () => {
  const runId = `resource-operator-module-${crypto.randomUUID()}`;
  const workspace = workspaceForRun(runId);
  try {
    const generatedRoot = generateOpenTofuChildModuleRoot({
      requiredProviders: [],
      inputs: {},
      outputAllowlist: {
        message: { from: "message", type: "string" },
      },
    });
    const result = await runPlan(runId, {
      planRun: {
        operation: "create",
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
      outputAllowlist: {
        message: { from: "message" },
      },
    });

    expect(result.status).toBe("succeeded");
    expect(result.plannedOutputs).toEqual({
      message: { sensitive: false, value: "resource-module" },
    });
    expect(generatedRoot.files["main.tf"]).toContain("from = module.app");
    const moduleInfo = JSON.parse(
      await readFile(workspace.moduleInfoPath, "utf8"),
    ) as { readonly moduleDir: string };
    expect(moduleInfo.moduleDir).toBe(workspace.generatedRootDir);

    await expect(
      runPlan(`${runId}-missing-root`, {
        planRun: {
          operation: "create",
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
    const result = await runPlan(runId, {
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
    });

    expect(result.status).toBe("succeeded");
    expect(result.plannedOutputs).toEqual({
      message: { sensitive: false, value: "plain-module" },
    });

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
  } finally {
    await rm(workspace.root, { recursive: true, force: true });
    await rm(workspace.depsDir, { recursive: true, force: true });
  }
});
