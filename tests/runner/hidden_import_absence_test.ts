import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { workspaceForRun } from "../../runner/lib/artifacts.ts";
import { runPlan, runReviewedPlanApply } from "../../runner/lib/plan_apply.ts";

const SOURCE = {
  kind: "git",
  url: "https://git.example.test/stack.git",
  commit: "a".repeat(40),
  modulePath: "infra",
} as const;

function planJson(importing = false): string {
  return JSON.stringify({
    prior_state: {
      values: {
        root_module: {
          resources: [
            { address: "terraform_data.recorded", values: { name: "recorded" } },
          ],
        },
      },
    },
    planned_values: {
      root_module: {
        resources: [
          { address: "terraform_data.recorded", values: { name: "recorded" } },
          { address: "terraform_data.missing", values: { name: "missing" } },
        ],
      },
    },
    resource_changes: [
      {
        address: "terraform_data.missing",
        type: "terraform_data",
        change: {
          actions: importing ? ["no-op"] : ["create"],
          ...(importing ? { importing: { id: "existing-id" } } : {}),
        },
      },
    ],
  });
}

test("partial state never triggers hidden import or replan in ordinary Plan, Destroy Plan, or saved Apply", async () => {
  const bin = await mkdtemp(join(tmpdir(), "takosumi-no-hidden-import-"));
  const originalPath = Bun.env.PATH;
  const logPath = join(bin, "commands.log");
  const fixturePath = join(bin, "plan.json");
  const runIds: string[] = [];
  try {
    await writeFile(fixturePath, planJson());
    await writeFile(
      join(bin, "tofu"),
      [
        "#!/bin/sh",
        `printf '%s\\n' "$*" >> '${logPath}'`,
        'case "$1" in',
        '  init) exit 0 ;;',
        '  plan) previous=""; for arg in "$@"; do if [ "$previous" = "-out" ]; then printf "saved-plan" > "$arg"; fi; previous="$arg"; done ;;',
        `  show) cat '${fixturePath}' ;;`,
        '  state) printf "terraform_data.recorded\\n" ;;',
        '  apply|output) exit 0 ;;',
        '  import) exit 77 ;;',
        '  *) exit 78 ;;',
        'esac',
      ].join("\n"),
    );
    await chmod(join(bin, "tofu"), 0o755);
    Bun.env.PATH = `${bin}:${originalPath ?? "/usr/bin:/bin"}`;

    for (const operation of ["update", "destroy"] as const) {
      const runId = `no-hidden-import-${operation}-${crypto.randomUUID()}`;
      runIds.push(runId);
      const workspace = workspaceForRun(runId);
      const moduleDir = join(workspace.sourceRoot, "infra");
      await mkdir(moduleDir, { recursive: true });
      await writeFile(
        join(moduleDir, "main.tf"),
        'resource "terraform_data" "recorded" { input = "recorded" }\nresource "terraform_data" "missing" { input = "missing" }\n',
      );
      await writeFile(workspace.restoredStatePath, "{\"version\":4}\n");
      const request = { planRun: { operation, source: SOURCE } };
      const result = await runPlan(runId, request);
      expect(result.status).toBe("succeeded");
      expect(result.stateReconcile).toBeUndefined();
      expect(result.planResourceChanges).toEqual([
        {
          address: "terraform_data.missing",
          type: "terraform_data",
          actions: ["create"],
        },
      ]);
      const planCommands = (await readFile(logPath, "utf8"))
        .trim()
        .split("\n")
        .filter((line) => line.startsWith("plan "));
      expect(planCommands).toHaveLength(runIds.length);
      expect(planCommands.at(-1)?.includes("-destroy")).toBe(
        operation === "destroy",
      );

      if (operation === "update") {
        const apply = await runReviewedPlanApply(runId, "apply", {
          ...request,
          planArtifact: { digest: result.planDigest },
        });
        expect(apply.status).toBe("succeeded");
        expect(apply.stateReconcile).toBeUndefined();
      }
    }

    const commands = (await readFile(logPath, "utf8")).trim().split("\n");
    expect(commands.filter((line) => line.startsWith("plan "))).toHaveLength(2);
    expect(commands.filter((line) => line.startsWith("apply "))).toHaveLength(1);
    expect(commands.some((line) => /^(import|state) /u.test(line))).toBe(false);
  } finally {
    if (originalPath === undefined) delete Bun.env.PATH;
    else Bun.env.PATH = originalPath;
    for (const runId of runIds) {
      const workspace = workspaceForRun(runId);
      await rm(workspace.root, { recursive: true, force: true });
      await rm(workspace.depsDir, { recursive: true, force: true });
    }
    await rm(bin, { recursive: true, force: true });
  }
});

test("explicit import remains visible in the reviewed Plan projection", async () => {
  const bin = await mkdtemp(join(tmpdir(), "takosumi-explicit-import-"));
  const originalPath = Bun.env.PATH;
  const fixturePath = join(bin, "plan.json");
  const runId = `explicit-import-${crypto.randomUUID()}`;
  const workspace = workspaceForRun(runId);
  try {
    await writeFile(fixturePath, planJson(true));
    await writeFile(
      join(bin, "tofu"),
      [
        "#!/bin/sh",
        'case "$1" in',
        '  init) exit 0 ;;',
        '  plan) previous=""; for arg in "$@"; do if [ "$previous" = "-out" ]; then printf "saved-plan" > "$arg"; fi; previous="$arg"; done ;;',
        `  show) cat '${fixturePath}' ;;`,
        '  import) exit 77 ;;',
        '  *) exit 78 ;;',
        'esac',
      ].join("\n"),
    );
    await chmod(join(bin, "tofu"), 0o755);
    Bun.env.PATH = `${bin}:${originalPath ?? "/usr/bin:/bin"}`;
    const moduleDir = join(workspace.sourceRoot, "infra");
    await mkdir(moduleDir, { recursive: true });
    await writeFile(
      join(moduleDir, "main.tf"),
      'resource "terraform_data" "missing" { input = "existing-id" }\nimport { to = terraform_data.missing id = "existing-id" }\n',
    );
    const result = await runPlan(runId, {
      planRun: { operation: "update", source: SOURCE },
    });
    expect(result.status).toBe("succeeded");
    expect(result.planResourceChanges).toEqual([
      {
        address: "terraform_data.missing",
        type: "terraform_data",
        actions: ["no-op"],
        importing: true,
      },
    ]);
    expect(result.stateReconcile).toBeUndefined();
  } finally {
    if (originalPath === undefined) delete Bun.env.PATH;
    else Bun.env.PATH = originalPath;
    await rm(workspace.root, { recursive: true, force: true });
    await rm(workspace.depsDir, { recursive: true, force: true });
    await rm(bin, { recursive: true, force: true });
  }
});
