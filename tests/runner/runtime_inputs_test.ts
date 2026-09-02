import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { inflateRawSync } from "node:zlib";

import { generateOpenTofuChildModuleRoot } from "../../lib/rootgen/src/mod.ts";
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
    //
    // A `.tfplan` is a deflate zip, so grepping its raw bytes proves nothing —
    // a value that DID reach the plan would be compressed and invisible. Every
    // entry is inflated first.
    const planEntries = unzipEntries(await readFile(workspace.planPath));
    expect(planEntries.length).toBeGreaterThan(0);
    for (const entry of planEntries) expect(entry).not.toContain(SECRET);
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

    // The variable file is a FIFO inside a 0700 sibling of the run workspace.
    // It holds no bytes at rest, and both the pipe and its directory are
    // removed as soon as OpenTofu has consumed the body.
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

test("run-scoped sensitive inputs reach neither tofu argv, env, nor fd 0", async () => {
  const runId = `runtime-inputs-argv-${crypto.randomUUID()}`;
  const workspace = workspaceForRun(runId);
  const auditDir = join(workspace.root, "..", `${runId}-audit`);
  const fakeBinDir = join(auditDir, "bin");
  const originalPath = Bun.env.PATH;
  try {
    await mkdir(fakeBinDir, { recursive: true });
    const auditLog = join(auditDir, "invocations.log");
    // A `tofu` shim earlier on PATH than the real binary. It records argv, env,
    // what its own standard input is bound to, and the first bytes readable
    // there — the exact vantage point every provider plugin inherits, since
    // OpenTofu launches plugins with `cmd.Stdin = os.Stdin`. It then drains any
    // `-var-file` so the runner's FIFO writer completes, lets `init` succeed so
    // the runner reaches the `plan` command, and fails.
    await writeFile(
      join(fakeBinDir, "tofu"),
      [
        "#!/usr/bin/env bash",
        "{",
        `  for arg in "$@"; do printf 'argv\\t%s\\n' "$arg"; done`,
        `  env | sed 's/^/env\\t/'`,
        `  printf 'fd0link\\t%s\\n' "$(readlink /proc/self/fd/0 || echo unreadable)"`,
        `  printf 'fd0data\\t%s\\n' "$(head -c 512 /proc/self/fd/0 2>/dev/null | tr -d '\\n')"`,
        "} >> " + JSON.stringify(auditLog),
        'for arg in "$@"; do',
        "  case \"$arg\" in",
        '    -var-file=*) cat "${arg#-var-file=}" > /dev/null 2>&1 || true ;;',
        "  esac",
        "done",
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
    // The plan command really ran, and it carried a var file.
    expect(audit).toContain("argv\tplan");
    expect(audit).toMatch(
      /argv\t-var-file=\S*-runtime-inputs-\S*\/runtime-inputs\.tfvars/u,
    );
    // Standard input is never used for the body: fd 0 stays Bun's default
    // `ignore`, so plugins inherit /dev/null and read nothing.
    expect(audit).not.toContain("/dev/stdin");
    expect(audit).toMatch(/(^|\n)fd0link\t\/dev\/null(\n|$)/u);
    expect(audit).toMatch(/(^|\n)fd0data\t(\n|$)/u);
    expect(audit).not.toContain(OTHER_SECRET);
    expect(audit).not.toMatch(/(^|\n)argv\t-var$/mu);
    expect(audit).not.toMatch(/(^|\n)env\tTF_VAR_/u);
    // Nothing is left behind once the child has read the pipe.
    const siblings = await readdir(dirname(workspace.root));
    expect(
      siblings.filter(
        (name) =>
          name.startsWith(`${basename(workspace.root)}-runtime-inputs-`),
      ),
    ).toEqual([]);
  } finally {
    Bun.env.PATH = originalPath ?? "";
    await rm(auditDir, { recursive: true, force: true });
    await cleanup(runId);
  }
}, 120_000);

test("a rootgen-produced generated root parses under real OpenTofu and carries the run-scoped variable it declares", async () => {
  const runId = `runtime-inputs-rootgen-${crypto.randomUUID()}`;
  const workspace = workspaceForRun(runId);
  const nonce = "Zm9vYmFyYmF6cXV4MDEyMzQ1Njc4OWFiY2RlZmdoaWo";
  const generated = generateOpenTofuChildModuleRoot({
    rootProviderRequirements: [
      {
        moduleLocalName: "probe",
        source: "registry.opentofu.org/example/probe",
        version: "1.0.0",
      },
    ],
    inputs: {},
    outputAllowlist: { message: { from: "message" } },
    providerBindings: [
      {
        provider: "registry.opentofu.org/example/probe",
        moduleLocalName: "probe",
        configuration: { endpoint: "https://probe.example" },
        runtimeInputs: {
          nonce,
          nonceArgument: "runtime_input_nonce",
          mapArgument: "runtime_inputs",
        },
      },
    ],
  });
  const variableName = "takosumi_runtime_inputs__probe";
  expect(Object.keys(generated.files).sort()).toEqual([
    "main.tf",
    "outputs.tf",
    "variables.tf",
    "versions.tf",
  ]);
  expect(generated.files["main.tf"]).toContain(
    `runtime_inputs = var.${variableName}`,
  );
  expect(generated.files["main.tf"]).toContain(
    `runtime_input_nonce = "${nonce}"`,
  );

  // 1. Real OpenTofu parses the exact bytes rootgen emits. `tofu fmt` exits 0
  //    only when every file parses; a syntax defect exits 2 with diagnostics.
  const parseDir = join(auditRootFor(runId), "rootgen");
  await mkdir(parseDir, { recursive: true });
  for (const [name, text] of Object.entries(generated.files)) {
    await writeFile(join(parseDir, name), text);
  }
  const fmt = Bun.spawnSync(["tofu", "fmt", "-no-color", "-list=false"], {
    cwd: parseDir,
  });
  expect(
    `${new TextDecoder().decode(fmt.stdout)}${new TextDecoder().decode(fmt.stderr)}`,
  ).not.toContain("Error");
  expect(fmt.exitCode).toBe(0);

  // 2. The rootgen-produced `variables.tf` — verbatim — is what the runner
  //    binds the map to, and real `tofu` accepts the delivery through it. The
  //    executed root keeps rootgen's variables/outputs and swaps only the
  //    provider-bearing `main.tf`, because a declaring provider block cannot be
  //    initialized offline without that provider's plugin.
  const executable = {
    files: {
      "versions.tf": "terraform {}\n",
      "variables.tf": generated.files["variables.tf"]!,
      "main.tf": 'module "child" {\n  source = "./module"\n}\n',
      "outputs.tf": generated.files["outputs.tf"]!,
    },
  };
  try {
    const plan = await runPlan(
      runId,
      baseRequest({
        generatedRoot: executable,
        runtimeInputs: [
          { variableName, names: ["SIGNING_KEY"], values: {} },
        ],
      }),
    );
    expect(plan.status).toBe("succeeded");
    const apply = await runReviewedPlanApply(
      runId,
      "destroy",
      baseRequest({
        generatedRoot: executable,
        planDigest: String(plan.planDigest),
        runtimeInputs: [
          {
            variableName,
            names: ["SIGNING_KEY"],
            values: { SIGNING_KEY: SECRET },
          },
        ],
      }),
      undefined,
    );
    expect(apply.status).toBe("succeeded");
    expect(String(apply.stdout ?? "")).not.toContain(SECRET);
    const state = await readFile(
      join(workspace.generatedRootDir, "terraform.tfstate"),
      "utf8",
    ).catch(() => "");
    expect(state).not.toContain(SECRET);
  } finally {
    await rm(auditRootFor(runId), { recursive: true, force: true });
    await cleanup(runId);
  }
}, 120_000);

function auditRootFor(runId: string): string {
  return join(dirname(workspaceForRun(runId).root), `${runId}-rootgen`);
}

/**
 * Minimal zip reader for OpenTofu's `.tfplan`. It walks the central directory
 * and inflates every entry, so an assertion about plan contents is real rather
 * than a grep of compressed bytes.
 */
function unzipEntries(archive: Buffer): string[] {
  let eocd = -1;
  for (let index = archive.length - 22; index >= 0; index--) {
    if (archive.readUInt32LE(index) === 0x06054b50) {
      eocd = index;
      break;
    }
  }
  if (eocd < 0) throw new Error("plan artifact is not a zip archive");
  const count = archive.readUInt16LE(eocd + 10);
  let offset = archive.readUInt32LE(eocd + 16);
  const entries: string[] = [];
  for (let index = 0; index < count; index++) {
    if (archive.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error("plan artifact central directory is malformed");
    }
    const method = archive.readUInt16LE(offset + 10);
    const compressedSize = archive.readUInt32LE(offset + 20);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const localOffset = archive.readUInt32LE(offset + 42);
    const localNameLength = archive.readUInt16LE(localOffset + 26);
    const localExtraLength = archive.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const data = archive.subarray(dataStart, dataStart + compressedSize);
    entries.push(
      (method === 8 ? inflateRawSync(data) : Buffer.from(data)).toString(
        "latin1",
      ),
    );
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}
