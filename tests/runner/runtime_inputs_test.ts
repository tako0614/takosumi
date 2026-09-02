import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { workspaceForRun, planJsonPath } from "../../runner/lib/artifacts.ts";
import { runPlan, runReviewedPlanApply } from "../../runner/lib/plan_apply.ts";

/**
 * A long, distinctive value. Every negative assertion greps for exactly this
 * string, so a leak into any artifact is unmistakable.
 */
const SECRET = "runtime-input-secret-8f3b2a17c94e6d05b1a7f28c3d4e5f60";
const OTHER_SECRET = "runtime-input-secret-11223344556677889900aabbccddeeff";
const VARIABLE = "takosumi_runtime_inputs__probe";

/**
 * A provider-free generated root shaped exactly like rootgen's output for a
 * Capsule that declares run-scoped sensitive inputs. Keeping it provider-free
 * lets these tests run the real `tofu` binary without a provider mirror.
 *
 * The `validation` block is the delivery proof: it can only pass when OpenTofu
 * actually received the map on standard input.
 */
function generatedRootFor(options: {
  readonly expectValue?: string;
  readonly variableName?: string;
} = {}) {
  const variableName = options.variableName ?? VARIABLE;
  // The expected value is pinned as a DIGEST so this fixture never writes the
  // secret itself into the generated root the assertions below grep.
  const condition = options.expectValue
    ? `length(var.${variableName}) == 0 || sha256(lookup(var.${variableName}, "SIGNING_KEY", "")) == ${JSON.stringify(
        createHash("sha256").update(options.expectValue).digest("hex"),
      )}`
    : `length(var.${variableName}) >= 0`;
  return {
    files: {
      "versions.tf": "terraform {}\n",
      "variables.tf": [
        `variable "${variableName}" {`,
        "  type      = map(string)",
        "  sensitive = true",
        "  ephemeral = true",
        "  validation {",
        `    condition     = ${condition}`,
        '    error_message = "run-scoped sensitive input was not delivered"',
        "  }",
        "}",
        "",
      ].join("\n"),
      "main.tf": [
        'module "child" {',
        '  source = "./module"',
        "}",
        "",
      ].join("\n"),
      "outputs.tf": [
        'output "message" {',
        "  value = module.child.message",
        "}",
        "",
      ].join("\n"),
    },
  };
}

const CHILD_MODULE = {
  files: [
    {
      path: "main.tf",
      text: 'output "message" {\n  value = "runtime-inputs"\n}\n',
    },
  ],
};

const MANIFEST = {
  bindings: [
    {
      providerSource: "registry.opentofu.org/example/probe",
      connectionId: "conn_probe",
      recipeId: "probe",
      authMode: "token",
      envNames: ["PROBE_TOKEN"],
      fileEnvNames: [],
      requiredEnvGroups: [["PROBE_TOKEN"]],
    },
  ],
};

function baseRequest(options: {
  readonly generatedRoot: ReturnType<typeof generatedRootFor>;
  readonly runtimeInputs?: unknown;
  readonly operation?: "create" | "destroy";
  readonly planDigest?: string;
}) {
  return {
    legacySourcelessDestroyRecovery: true,
    planRun: {
      operation: options.operation ?? "destroy",
      source: {
        kind: "operator_module",
        digest:
          "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      },
    },
    generatedRoot: options.generatedRoot,
    operatorModule: CHILD_MODULE,
    requiredProviders: [],
    runnerProfile: {
      id: "runtime-inputs-probe",
      allowedProviders: [],
      requireProviderBindings: false,
    },
    outputAllowlist: { message: { from: "message" } },
    ...(options.planDigest
      ? { planArtifact: { kind: "runner-local", digest: options.planDigest } }
      : {}),
    ...(options.runtimeInputs === undefined
      ? {}
      : {
          credentials: {
            env: { PROBE_TOKEN: "probe-run-token" },
            manifest: MANIFEST,
            runtimeInputs: options.runtimeInputs,
          },
        }),
  };
}

async function cleanup(runId: string): Promise<void> {
  const workspace = workspaceForRun(runId);
  await rm(workspace.root, { recursive: true, force: true });
  await rm(workspace.depsDir, { recursive: true, force: true });
}

test("run-scoped sensitive inputs reach tofu without entering any artifact", async () => {
  const runId = `runtime-inputs-${crypto.randomUUID()}`;
  const workspace = workspaceForRun(runId);
  const generatedRoot = generatedRootFor({ expectValue: SECRET });
  const dispatch = [
    { variableName: VARIABLE, names: ["SIGNING_KEY"], values: {} },
  ];
  try {
    const plan = await runPlan(
      runId,
      baseRequest({ generatedRoot, runtimeInputs: dispatch }),
    );
    expect(plan.status).toBe("succeeded");

    const apply = await runReviewedPlanApply(
      runId,
      "destroy",
      baseRequest({
        generatedRoot,
        planDigest: String(plan.planDigest),
        runtimeInputs: [
          {
            variableName: VARIABLE,
            names: ["SIGNING_KEY"],
            values: { SIGNING_KEY: SECRET },
          },
        ],
      }),
      undefined,
    );
    expect(apply.status).toBe("succeeded");

    // The validation block above only passes when the map was delivered, so a
    // succeeded apply IS the positive delivery proof. Everything below proves
    // the value did not survive anywhere it must not.
    const planBytes = await readFile(workspace.planPath);
    expect(new TextDecoder().decode(planBytes)).not.toContain(SECRET);
    expect(await readFile(planJsonPath(workspace), "utf8")).not.toContain(
      SECRET,
    );
    expect(JSON.stringify(plan.plannedOutputs ?? {})).not.toContain(SECRET);
    expect(JSON.stringify(apply.outputs ?? {})).not.toContain(SECRET);
    expect(String(plan.stdout ?? "")).not.toContain(SECRET);
    expect(String(plan.stderr ?? "")).not.toContain(SECRET);
    expect(String(apply.stdout ?? "")).not.toContain(SECRET);
    expect(String(apply.stderr ?? "")).not.toContain(SECRET);

    const generatedRootFiles = await readdir(workspace.generatedRootDir);
    for (const name of generatedRootFiles) {
      if (!name.endsWith(".tf") && name !== "terraform.tfstate") continue;
      expect(
        await readFile(join(workspace.generatedRootDir, name), "utf8"),
      ).not.toContain(SECRET);
    }
    const state = await readFile(
      join(workspace.generatedRootDir, "terraform.tfstate"),
      "utf8",
    ).catch(() => "");
    expect(state).not.toContain(SECRET);

    // The stdin lane writes no plaintext to disk. Any fallback would mkdtemp a
    // sibling of the run workspace, so no such sibling may exist.
    const siblings = await readdir(dirname(workspace.root));
    expect(
      siblings.filter((name) =>
        name.startsWith(`${basename(workspace.root)}-`),
      ),
    ).toEqual([]);
  } finally {
    await cleanup(runId);
  }
}, 120_000);

test("apply refuses to drop a run-scoped sensitive input the plan supplied", async () => {
  const runId = `runtime-inputs-symmetry-${crypto.randomUUID()}`;
  const generatedRoot = generatedRootFor();
  try {
    const plan = await runPlan(
      runId,
      baseRequest({
        generatedRoot,
        runtimeInputs: [
          { variableName: VARIABLE, names: ["SIGNING_KEY"], values: {} },
        ],
      }),
    );
    expect(plan.status).toBe("succeeded");

    // No `credentials.runtimeInputs` at all: the generated root declares a
    // defaultless ephemeral variable, so OpenTofu itself refuses the apply.
    const apply = await runReviewedPlanApply(
      runId,
      "destroy",
      baseRequest({ generatedRoot, planDigest: String(plan.planDigest) }),
      undefined,
    );
    expect(apply.status).toBe("failed");
    expect(
      `${String(apply.stderr ?? "")}${String(apply.stdout ?? "")}`,
    ).toContain("No value for required variable");
  } finally {
    await cleanup(runId);
  }
}, 120_000);

test("a dispatch the generated root never declared is refused before tofu starts", async () => {
  const runId = `runtime-inputs-undeclared-${crypto.randomUUID()}`;
  const workspace = workspaceForRun(runId);
  try {
    await expect(
      runPlan(
        runId,
        baseRequest({
          generatedRoot: generatedRootFor(),
          runtimeInputs: [
            {
              variableName: "takosumi_runtime_inputs__other",
              names: ["SIGNING_KEY"],
              values: {},
            },
          ],
        }),
      ),
    ).rejects.toThrow(
      "run-scoped sensitive input variable is not declared by the generated root",
    );
    // Nothing was spawned, so no workspace was even prepared.
    await expect(readFile(workspace.planPath)).rejects.toThrow();
  } finally {
    await cleanup(runId);
  }
});

test("run-scoped sensitive input dispatch shapes fail closed", async () => {
  const runId = `runtime-inputs-shape-${crypto.randomUUID()}`;
  const generatedRoot = generatedRootFor();
  const rejected: readonly [unknown, string][] = [
    [
      [
        {
          variableName: VARIABLE,
          names: ["SIGNING_KEY"],
          values: { OTHER_KEY: SECRET },
        },
      ],
      "run-scoped sensitive input values do not match their names",
    ],
    [
      [
        {
          variableName: VARIABLE,
          names: ["SIGNING_KEY", "ANOTHER_KEY"],
          values: {},
        },
      ],
      "run-scoped sensitive input names must be sorted and unique",
    ],
    [
      [{ variableName: "app_secret", names: ["SIGNING_KEY"], values: {} }],
      "run-scoped sensitive input variable name is unsafe",
    ],
    [
      [{ variableName: VARIABLE, names: ["lower_case"], values: {} }],
      "run-scoped sensitive input names are malformed",
    ],
  ];
  try {
    for (const [runtimeInputs, message] of rejected) {
      await expect(
        runPlan(runId, baseRequest({ generatedRoot, runtimeInputs })),
      ).rejects.toThrow(message);
    }
  } finally {
    await cleanup(runId);
  }
});

test("run-scoped sensitive inputs never reach tofu argv or env", async () => {
  const runId = `runtime-inputs-argv-${crypto.randomUUID()}`;
  const workspace = workspaceForRun(runId);
  const auditDir = join(workspace.root, "..", `${runId}-audit`);
  const fakeBinDir = join(auditDir, "bin");
  const originalPath = Bun.env.PATH;
  try {
    await mkdir(fakeBinDir, { recursive: true });
    const auditLog = join(auditDir, "invocations.log");
    // A `tofu` shim earlier on PATH than the real binary. It records argv and
    // env for every invocation, lets `init` succeed so the runner reaches the
    // `plan` command, then fails.
    await writeFile(
      join(fakeBinDir, "tofu"),
      [
        "#!/usr/bin/env bash",
        `{ for arg in "$@"; do printf 'argv\\t%s\\n' "$arg"; done; env | sed 's/^/env\\t/'; } >> ${JSON.stringify(auditLog)}`,
        'if [ "$1" = "init" ]; then exit 0; fi',
        "exit 3",
      ].join("\n"),
      { mode: 0o755 },
    );
    Bun.env.PATH = `${fakeBinDir}:${originalPath ?? ""}`;
    const result = await runPlan(
      runId,
      baseRequest({
        generatedRoot: generatedRootFor(),
        runtimeInputs: [
          {
            variableName: VARIABLE,
            names: ["SIGNING_KEY"],
            values: { SIGNING_KEY: OTHER_SECRET },
          },
        ],
      }),
    );
    expect(result.status).toBe("failed");
    const audit = await readFile(auditLog, "utf8");
    // The plan command really ran, and it carried the stdin var file.
    expect(audit).toContain("argv\tplan");
    expect(audit).toContain("argv\t-var-file=/dev/stdin");
    expect(audit).not.toContain(OTHER_SECRET);
    expect(audit).not.toMatch(/(^|\n)argv\t-var$/mu);
    expect(audit).not.toMatch(/(^|\n)env\tTF_VAR_/u);
  } finally {
    Bun.env.PATH = originalPath ?? "";
    await rm(auditDir, { recursive: true, force: true });
    await cleanup(runId);
  }
}, 120_000);
