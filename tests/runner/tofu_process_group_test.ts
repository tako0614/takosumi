import { expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { workspaceForRun } from "../../runner/lib/artifacts.ts";
import { RUN_ROOT } from "../../runner/lib/constants.ts";
import {
  runPlan,
  runReviewedPlanApply,
} from "../../runner/lib/plan_apply.ts";
import { safeRunId } from "../../runner/lib/util.ts";

const PROVIDER_SECRET = "tofu-descendant-provider-secret-0123456789abcdef";

test("credential-bearing OpenTofu phases kill descendants before provider credential cleanup", async () => {
  const fixture = await createTofuDescendantFixture("direct");
  try {
    const plan = await runPlan(
      fixture.runId,
      fixture.request,
    );
    expect(plan.status).toBe("succeeded");
    const apply = await runReviewedPlanApply(
      fixture.runId,
      "apply",
      {
        ...fixture.request,
        planArtifact: plan.planArtifact,
      },
    );
    expect(apply.status).toBe("succeeded");

    await Bun.sleep(700);

    expect(await evidenceFiles(fixture.evidenceRoot, ".marker")).toEqual([]);
    expect(await providerCredentialDirectories(fixture.runId)).toEqual([]);
    const visible = JSON.stringify({ plan, apply });
    expect(visible).not.toContain(PROVIDER_SECRET);
    expect(visible).not.toContain(fixture.evidenceRoot);
    expect(visible).not.toContain(fixture.workspace.root);
  } finally {
    await fixture.cleanup();
  }
});

test("credential-bearing OpenTofu timeout kills descendants before cleanup", async () => {
  const fixture = await createTofuDescendantFixture("timeout", {
    hangPhase: "plan",
    maxRunSeconds: 1,
    descendantDelaySeconds: 1.25,
  });
  try {
    const plan = await runPlan(fixture.runId, fixture.request);

    expect(plan.status).toBe("failed");
    expect(plan.exitCode).toBe(124);
    await Bun.sleep(1_400);
    expect(await evidenceFiles(fixture.evidenceRoot, ".marker")).toEqual([]);
    expect(await providerCredentialDirectories(fixture.runId)).toEqual([]);
    const visible = JSON.stringify(plan);
    expect(visible).not.toContain(PROVIDER_SECRET);
    expect(visible).not.toContain(fixture.evidenceRoot);
    expect(visible).not.toContain(fixture.workspace.root);
  } finally {
    await fixture.cleanup();
  }
});

test("credential-bearing OpenTofu cancellation kills descendants before cleanup", async () => {
  const fixture = await createTofuDescendantFixture("abort", {
    hangPhase: "plan",
    descendantDelaySeconds: 0.5,
  });
  const controller = new AbortController();
  try {
    const pending = runPlan(
      fixture.runId,
      fixture.request,
      controller.signal,
    );
    await waitForEvidence(fixture.evidenceRoot, "plan", ".ready");
    controller.abort();
    const plan = await pending;

    expect(plan.status).toBe("failed");
    expect(plan.exitCode).toBe(130);
    await Bun.sleep(650);
    expect(await evidenceFiles(fixture.evidenceRoot, ".marker")).toEqual([]);
    expect(await providerCredentialDirectories(fixture.runId)).toEqual([]);
    const visible = JSON.stringify(plan);
    expect(visible).not.toContain(PROVIDER_SECRET);
    expect(visible).not.toContain(fixture.evidenceRoot);
    expect(visible).not.toContain(fixture.workspace.root);
  } finally {
    await fixture.cleanup();
  }
});

async function createTofuDescendantFixture(
  label: string,
  options: {
    readonly hangPhase?: "init" | "plan" | "show" | "apply" | "output";
    readonly maxRunSeconds?: number;
    readonly descendantDelaySeconds?: number;
  } = {},
) {
  const runId = `tofu_process_group_${label}_${crypto.randomUUID().replaceAll("-", "")}`;
  const workspace = workspaceForRun(runId);
  const fakeBin = await mkdtemp(join(tmpdir(), "takosumi-tofu-group-bin-"));
  const evidenceRoot = await mkdtemp(
    join(tmpdir(), "takosumi-tofu-group-evidence-"),
  );
  const previousPath = Bun.env.PATH;
  const tofuPath = join(fakeBin, "tofu");
  const hangPhase = options.hangPhase ?? "never";
  const descendantDelaySeconds = options.descendantDelaySeconds ?? 0.4;

  await mkdir(workspace.sourceRoot, { recursive: true });
  await writeFile(join(workspace.sourceRoot, "main.tf"), "terraform {}\n");
  await writeFile(
    tofuPath,
    `#!/usr/bin/env bash
set -euo pipefail
phase="$1"
evidence_root=${shellQuote(evidenceRoot)}
ready="$evidence_root/$phase.$$.ready"
marker="$evidence_root/$phase.$$.marker"
(
  secret="$(cat "$CLOUDFLARE_API_TOKEN_FILE")"
  printf 'ready' > "$ready"
  sleep ${descendantDelaySeconds}
  printf '%s' "$secret" > "$marker"
) </dev/null >/dev/null 2>&1 &
for _attempt in {1..100}; do
  test -f "$ready" && break
  sleep 0.01
done
test -f "$ready"
if [ "$phase" = ${shellQuote(hangPhase)} ]; then
  sleep 5
fi
case "$phase" in
  init)
    printf '# fixture lock\n' > .terraform.lock.hcl
    ;;
  plan)
    out=""
    previous=""
    for arg in "$@"; do
      if [ "$previous" = "-out" ]; then out="$arg"; fi
      previous="$arg"
    done
    test -n "$out"
    printf 'fake-plan' > "$out"
    ;;
  show)
    printf '{"format_version":"1.2","resource_changes":[],"output_changes":{}}'
    ;;
  apply)
    ;;
  output)
    printf '{"message":{"sensitive":false,"type":"string","value":"ok"}}'
    ;;
  *)
    exit 2
    ;;
esac
`,
  );
  await chmod(tofuPath, 0o755);
  Bun.env.PATH = `${fakeBin}:${previousPath ?? ""}`;

  const request = {
    planRun: {
      operation: "create",
      source: {
        kind: "git",
        url: "https://git.example.test/capsule.git",
        commit: "0123456789abcdef0123456789abcdef01234567",
      },
      requiredProviders: [],
    },
    runnerProfile: {
      id: "credential-bearing-tofu-process-group",
      allowedProviders: [],
      requireProviderBindings: false,
      ...(options.maxRunSeconds
        ? { resourceLimits: { maxRunSeconds: options.maxRunSeconds } }
        : {}),
    },
    credentials: {
      files: [
        {
          path: "provider-token.txt",
          mode: 0o600,
          content: PROVIDER_SECRET,
          envName: "CLOUDFLARE_API_TOKEN_FILE",
        },
      ],
      manifest: {
        bindings: [
          {
            providerSource: "registry.opentofu.org/cloudflare/cloudflare",
            connectionId: `conn_tofu_process_group_${label}`,
            recipeId: "cloudflare",
            authMode: "api_token_file",
            envNames: ["CLOUDFLARE_API_TOKEN_FILE"],
            fileEnvNames: ["CLOUDFLARE_API_TOKEN_FILE"],
            requiredEnvGroups: [["CLOUDFLARE_API_TOKEN_FILE"]],
          },
        ],
        files: [
          {
            path: "provider-token.txt",
            mode: 0o600,
            envName: "CLOUDFLARE_API_TOKEN_FILE",
          },
        ],
      },
    },
  };

  return {
    runId,
    workspace,
    evidenceRoot,
    request,
    async cleanup() {
      if (previousPath === undefined) delete Bun.env.PATH;
      else Bun.env.PATH = previousPath;
      await rm(workspace.root, { recursive: true, force: true });
      await rm(workspace.depsDir, { recursive: true, force: true });
      for (const directory of await providerCredentialDirectories(runId)) {
        await rm(join(RUN_ROOT, directory), { recursive: true, force: true });
      }
      await rm(fakeBin, { recursive: true, force: true });
      await rm(evidenceRoot, { recursive: true, force: true });
    },
  };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

async function evidenceFiles(root: string, suffix: string): Promise<string[]> {
  return (await readdir(root)).filter((entry) => entry.endsWith(suffix)).sort();
}

async function waitForEvidence(
  root: string,
  phase: string,
  suffix: string,
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (
      (await evidenceFiles(root, suffix)).some((entry) =>
        entry.startsWith(`${phase}.`),
      )
    ) {
      return;
    }
    await Bun.sleep(10);
  }
  throw new Error(`timed out waiting for ${phase} process evidence`);
}

async function providerCredentialDirectories(runId: string): Promise<string[]> {
  const prefix = `${safeRunId(runId)}-credentials-`;
  try {
    return (await readdir(RUN_ROOT))
      .filter((entry) => entry.startsWith(prefix))
      .sort();
  } catch {
    return [];
  }
}
