import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { handleRunnerRequest } from "../../../runner/entrypoint.ts";

test("runner redacts plan stdout and stderr on success", async () => {
  const fixture = await createFakeTofuFixture();
  await withFakeTofu(fixture.binDir, async () => {
    const response = await handleRunnerRequest(
      runRequest("plan_redaction_success", "plan", {
        generatedRoot: minimalGeneratedRoot(),
        planRun: {
          source: { kind: "local", path: fixture.sourceDir },
          operation: "create",
          requiredProviders: [],
        },
      }),
    );

    const payload = await response.json();
    expect(response.status).toBe(200);
    const text = JSON.stringify(payload);
    expect(text).not.toContain("plan-tf-var-secret");
    expect(text).not.toContain("plan-token-secret");
    expect(text).not.toContain("plan-cf-secret");
    expect(text).not.toContain("plan-aws-secret");
    expect(text).not.toContain("plan-db-pass");
    expect(text).not.toContain("plan-password-secret");
    expect(text).not.toContain("plan-auth-secret");
    expect(text).toContain("[redacted]");
  });
});

test("runner redacts bare run-scoped credential values from plan output", async () => {
  const fixture = await createFakeTofuFixture();
  const bareRunKey = "run-key.2000000000.deadbeefcafebabefeedface";
  await withFakeTofu(fixture.binDir, async () => {
    const response = await handleRunnerRequest(
      runRequest("plan_bare_credential_redaction", "plan", {
        generatedRoot: minimalGeneratedRoot(),
        planRun: {
          source: { kind: "local", path: fixture.sourceDir },
          operation: "create",
          requiredProviders: [],
        },
        credentials: {
          TF_VAR_cloudflare_main_api_token: bareRunKey,
        },
      }),
    );

    const payload = await response.json();
    expect(response.status).toBe(200);
    const text = JSON.stringify(payload);
    expect(text).not.toContain(bareRunKey);
    expect(text).toContain("[redacted]");
  });
});

test("runner materializes generic provider credential files for plan and cleans them up", async () => {
  const fixture = await createProviderCredentialFileFixture();
  const envSecret = "generic-env-secret-123456789";
  const fileSecret = "generic-file-secret-123456789";
  await withFakeTofu(fixture.binDir, async () => {
    const response = await handleRunnerRequest(
      runRequest("plan_generic_provider_file", "plan", {
        generatedRoot: minimalGeneratedRoot(),
        planRun: {
          source: { kind: "local", path: fixture.sourceDir },
          operation: "create",
          requiredProviders: ["registry.opentofu.org/example/envfile"],
        },
        runnerProfile: {
          id: "generic-opentofu-provider",
          sourcePolicy: { allowLocalSource: true },
          allowedProviders: ["*"],
        },
        credentials: {
          env: {
            GENERIC_API_TOKEN: envSecret,
          },
          files: [
            {
              path: "provider-credentials.json",
              mode: 0o600,
              content: fileSecret,
              envName: "GENERIC_CREDENTIALS_FILE",
            },
          ],
        },
      }),
    );

    const payload = await response.json();
    expect(response.status).toBe(200);
    const text = JSON.stringify(payload);
    expect(text).not.toContain(envSecret);
    expect(text).not.toContain(fileSecret);
    expect(text).toContain("[redacted]");

    const materializedPath = await readFile(fixture.pathRecord, "utf8");
    expect(materializedPath).toContain("/.provider-credentials/");
    await expect(stat(materializedPath)).rejects.toThrow();
  });
});

test("runner rematerializes generic provider credential files for apply and cleans them up", async () => {
  const fixture = await createProviderCredentialFileFixture();
  const envSecret = "generic-env-secret-123456789";
  const fileSecret = "generic-file-secret-123456789";
  await withFakeTofu(fixture.binDir, async () => {
    const plan = await handleRunnerRequest(
      runRequest("apply_generic_provider_file", "plan", {
        generatedRoot: minimalGeneratedRoot(),
        planRun: {
          source: { kind: "local", path: fixture.sourceDir },
          operation: "create",
          requiredProviders: ["registry.opentofu.org/example/envfile"],
        },
        runnerProfile: {
          id: "generic-opentofu-provider",
          sourcePolicy: { allowLocalSource: true },
          allowedProviders: ["*"],
        },
        credentials: {
          env: {
            GENERIC_API_TOKEN: envSecret,
          },
          files: [
            {
              path: "provider-credentials.json",
              mode: 0o600,
              content: fileSecret,
              envName: "GENERIC_CREDENTIALS_FILE",
            },
          ],
        },
      }),
    );
    expect(plan.status).toBe(200);
    const planPayload = (await plan.json()) as {
      planArtifact: { digest: string };
    };
    const planMaterializedPath = await readFile(fixture.pathRecord, "utf8");
    expect(planMaterializedPath).toContain("/.provider-credentials/");
    await expect(stat(planMaterializedPath)).rejects.toThrow();

    const apply = await handleRunnerRequest(
      runRequest("apply_generic_provider_file", "apply", {
        generatedRoot: minimalGeneratedRoot(),
        planRun: {
          source: { kind: "local", path: fixture.sourceDir },
          operation: "create",
          requiredProviders: ["registry.opentofu.org/example/envfile"],
        },
        runnerProfile: {
          id: "generic-opentofu-provider",
          sourcePolicy: { allowLocalSource: true },
          allowedProviders: ["*"],
        },
        credentials: {
          env: {
            GENERIC_API_TOKEN: envSecret,
          },
          files: [
            {
              path: "provider-credentials.json",
              mode: 0o600,
              content: fileSecret,
              envName: "GENERIC_CREDENTIALS_FILE",
            },
          ],
        },
        planArtifact: planPayload.planArtifact,
      }),
    );

    const applyPayload = await apply.json();
    expect(apply.status).toBe(200);
    const text = JSON.stringify(applyPayload);
    expect(text).not.toContain(envSecret);
    expect(text).not.toContain(fileSecret);
    expect(text).toContain("[redacted]");

    const applyMaterializedPath = await readFile(fixture.pathRecord, "utf8");
    expect(applyMaterializedPath).toContain("/.provider-credentials/");
    await expect(stat(applyMaterializedPath)).rejects.toThrow();
  });
});

test("runner rematerializes generic provider credential files for destroy and cleans them up", async () => {
  const fixture = await createProviderCredentialFileFixture();
  const envSecret = "generic-env-secret-123456789";
  const fileSecret = "generic-file-secret-123456789";
  await withFakeTofu(fixture.binDir, async () => {
    const plan = await handleRunnerRequest(
      runRequest("destroy_generic_provider_file", "plan", {
        generatedRoot: minimalGeneratedRoot(),
        planRun: {
          source: { kind: "local", path: fixture.sourceDir },
          operation: "destroy",
          requiredProviders: ["registry.opentofu.org/example/envfile"],
        },
        runnerProfile: {
          id: "generic-opentofu-provider",
          sourcePolicy: { allowLocalSource: true },
          allowedProviders: ["*"],
        },
        credentials: {
          env: {
            GENERIC_API_TOKEN: envSecret,
          },
          files: [
            {
              path: "provider-credentials.json",
              mode: 0o600,
              content: fileSecret,
              envName: "GENERIC_CREDENTIALS_FILE",
            },
          ],
        },
      }),
    );
    expect(plan.status).toBe(200);
    const planPayload = (await plan.json()) as {
      planArtifact: { digest: string };
    };
    const planMaterializedPath = await readFile(fixture.pathRecord, "utf8");
    expect(planMaterializedPath).toContain("/.provider-credentials/");
    await expect(stat(planMaterializedPath)).rejects.toThrow();

    const destroy = await handleRunnerRequest(
      runRequest("destroy_generic_provider_file", "destroy", {
        generatedRoot: minimalGeneratedRoot(),
        planRun: {
          source: { kind: "local", path: fixture.sourceDir },
          operation: "destroy",
          requiredProviders: ["registry.opentofu.org/example/envfile"],
        },
        runnerProfile: {
          id: "generic-opentofu-provider",
          sourcePolicy: { allowLocalSource: true },
          allowedProviders: ["*"],
        },
        credentials: {
          env: {
            GENERIC_API_TOKEN: envSecret,
          },
          files: [
            {
              path: "provider-credentials.json",
              mode: 0o600,
              content: fileSecret,
              envName: "GENERIC_CREDENTIALS_FILE",
            },
          ],
        },
        planArtifact: planPayload.planArtifact,
      }),
    );

    const destroyPayload = await destroy.json();
    expect(destroy.status).toBe(200);
    const text = JSON.stringify(destroyPayload);
    expect(text).not.toContain(envSecret);
    expect(text).not.toContain(fileSecret);
    expect(text).toContain("[redacted]");

    const destroyMaterializedPath = await readFile(fixture.pathRecord, "utf8");
    expect(destroyMaterializedPath).toContain("/.provider-credentials/");
    await expect(stat(destroyMaterializedPath)).rejects.toThrow();
  });
});

test("runner redacts apply stdout and stderr on success", async () => {
  const fixture = await createFakeTofuFixture();
  await withFakeTofu(fixture.binDir, async () => {
    const plan = await handleRunnerRequest(
      runRequest("apply_redaction_success", "plan", {
        generatedRoot: minimalGeneratedRoot(),
        planRun: {
          source: { kind: "local", path: fixture.sourceDir },
          operation: "create",
          requiredProviders: [],
        },
      }),
    );
    const planPayload = (await plan.json()) as {
      planArtifact: { digest: string };
    };

    const response = await handleRunnerRequest(
      runRequest("apply_redaction_success", "apply", {
        generatedRoot: minimalGeneratedRoot(),
        planRun: {
          source: { kind: "local", path: fixture.sourceDir },
          operation: "create",
          requiredProviders: [],
        },
        planArtifact: planPayload.planArtifact,
      }),
    );

    expect(response.status).toBe(200);
    const payload = await response.json();
    const text = JSON.stringify(payload);
    expect(text).not.toContain("apply-tf-var-secret");
    expect(text).not.toContain("apply-token-secret");
    expect(text).not.toContain("apply-cf-secret");
    expect(text).not.toContain("apply-aws-secret");
    expect(text).not.toContain("apply-db-pass");
    expect(text).not.toContain("apply-password-secret");
    expect(text).not.toContain("apply-auth-secret");
    expect(text).toContain("[redacted]");
  });
});

test("runner redacts plan/apply failure payloads", async () => {
  const planFailure = await createFakeTofuFixture("plan");
  await withFakeTofu(planFailure.binDir, async () => {
    const failedPlan = await handleRunnerRequest(
      runRequest("plan_redaction_failure", "plan", {
        generatedRoot: minimalGeneratedRoot(),
        planRun: {
          source: { kind: "local", path: planFailure.sourceDir },
          operation: "create",
          requiredProviders: [],
        },
      }),
    );
    expect(failedPlan.status).toBe(500);
    const text = JSON.stringify(await failedPlan.json());
    expect(text).not.toContain("plan-token-secret");
    expect(text).not.toContain("plan-password-secret");
    expect(text).toContain("[redacted]");
  });

  const applyFailure = await createFakeTofuFixture("apply");
  await withFakeTofu(applyFailure.binDir, async () => {
    const plan = await handleRunnerRequest(
      runRequest("apply_redaction_failure", "plan", {
        generatedRoot: minimalGeneratedRoot(),
        planRun: {
          source: { kind: "local", path: applyFailure.sourceDir },
          operation: "create",
          requiredProviders: [],
        },
      }),
    );
    const planPayload = (await plan.json()) as {
      planArtifact: { digest: string };
    };
    const failedApply = await handleRunnerRequest(
      runRequest("apply_redaction_failure", "apply", {
        generatedRoot: minimalGeneratedRoot(),
        planRun: {
          source: { kind: "local", path: applyFailure.sourceDir },
          operation: "create",
          requiredProviders: [],
        },
        planArtifact: planPayload.planArtifact,
      }),
    );
    expect(failedApply.status).toBe(500);
    const text = JSON.stringify(await failedApply.json());
    expect(text).not.toContain("apply-token-secret");
    expect(text).not.toContain("apply-password-secret");
    expect(text).toContain("[redacted]");
  });
});

function runRequest(
  runId: string,
  action: "plan" | "apply" | "destroy",
  request: unknown,
): Request {
  return new Request(`https://runner.internal/runs/${runId}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, runId, request }),
  });
}

function minimalGeneratedRoot(): { readonly files: Record<string, string> } {
  return {
    files: {
      "main.tf":
        'terraform {}\nmodule "service" { source = "./template-module" }\n',
    },
  };
}

async function createFakeTofuFixture(fail?: "plan" | "apply"): Promise<{
  readonly binDir: string;
  readonly sourceDir: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "takosumi-runner-redaction-"));
  const binDir = join(root, "bin");
  const sourceDir = join(root, "source");
  await mkdir(binDir, { recursive: true });
  await mkdir(sourceDir, { recursive: true });
  await writeFile(join(sourceDir, "main.tf"), "terraform {}\n");
  const tofuPath = join(binDir, "tofu");
  await writeFile(tofuPath, fakeTofuScript(fail));
  await chmod(tofuPath, 0o755);
  return { binDir, sourceDir };
}

async function createProviderCredentialFileFixture(): Promise<{
  readonly binDir: string;
  readonly sourceDir: string;
  readonly pathRecord: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "takosumi-runner-envfile-"));
  const binDir = join(root, "bin");
  const sourceDir = join(root, "source");
  const pathRecord = join(root, "credential-path.txt");
  await mkdir(binDir, { recursive: true });
  await mkdir(sourceDir, { recursive: true });
  await writeFile(join(sourceDir, "main.tf"), "terraform {}\n");
  const tofuPath = join(binDir, "tofu");
  await writeFile(tofuPath, fakeTofuProviderCredentialFileScript(pathRecord));
  await chmod(tofuPath, 0o755);
  return { binDir, sourceDir, pathRecord };
}

async function withFakeTofu(
  binDir: string,
  callback: () => Promise<void>,
): Promise<void> {
  const previousPath = Bun.env.PATH;
  Bun.env.PATH = `${binDir}:${previousPath ?? "/usr/bin:/bin"}`;
  try {
    await callback();
  } finally {
    if (previousPath === undefined) delete Bun.env.PATH;
    else Bun.env.PATH = previousPath;
  }
}

function fakeTofuScript(fail?: "plan" | "apply"): string {
  return `#!/usr/bin/env bash
set -euo pipefail
fail="${fail ?? ""}"
cmd="\${1:-}"
case "$cmd" in
  init)
    echo "init TF_VAR_cloudflare_main_api_token=init-tf-var-secret"
    echo "Authorization: Bearer init-auth-secret" >&2
    exit 0
    ;;
  plan)
    out=""
    while [ "$#" -gt 0 ]; do
      if [ "$1" = "-out" ]; then
        shift
        out="\${1:-}"
      fi
      shift || true
    done
    echo "plan TF_VAR_cloudflare_main_api_token=plan-tf-var-secret token=plan-token-secret CLOUDFLARE_API_TOKEN=plan-cf-secret AWS_SECRET_ACCESS_KEY=plan-aws-secret DATABASE_URL=postgres://user:plan-db-pass@db.example/takos bare value \${TF_VAR_cloudflare_main_api_token:-}"
    echo "password=plan-password-secret Authorization: Bearer plan-auth-secret" >&2
    if [ "$fail" = "plan" ]; then
      exit 2
    fi
    printf "fake-plan" > "$out"
    exit 0
    ;;
  show)
    printf '{"resource_changes":[]}'
    exit 0
    ;;
  apply)
    echo "apply TF_VAR_cloudflare_main_api_token=apply-tf-var-secret token=apply-token-secret CLOUDFLARE_API_TOKEN=apply-cf-secret AWS_SECRET_ACCESS_KEY=apply-aws-secret DATABASE_URL=postgres://user:apply-db-pass@db.example/takos bare value \${TF_VAR_cloudflare_main_api_token:-}"
    echo "password=apply-password-secret Authorization: Bearer apply-auth-secret" >&2
    if [ "$fail" = "apply" ]; then
      exit 3
    fi
    exit 0
    ;;
  output)
    printf '{}'
    exit 0
    ;;
  *)
    echo "unknown tofu command $cmd" >&2
    exit 127
    ;;
esac
`;
}

function fakeTofuProviderCredentialFileScript(pathRecord: string): string {
  return `#!/usr/bin/env bash
set -euo pipefail
cmd="\${1:-}"
case "$cmd" in
  init)
    test -n "\${GENERIC_API_TOKEN:-}"
    test -n "\${GENERIC_CREDENTIALS_FILE:-}"
    test -f "$GENERIC_CREDENTIALS_FILE"
    test "$(cat "$GENERIC_CREDENTIALS_FILE")" = "generic-file-secret-123456789"
    printf "%s" "$GENERIC_CREDENTIALS_FILE" > "${pathRecord}"
    echo "init env $GENERIC_API_TOKEN file $(cat "$GENERIC_CREDENTIALS_FILE")"
    exit 0
    ;;
  plan)
    out=""
    while [ "$#" -gt 0 ]; do
      if [ "$1" = "-out" ]; then
        shift
        out="\${1:-}"
      fi
      shift || true
    done
    echo "plan env $GENERIC_API_TOKEN file $(cat "$GENERIC_CREDENTIALS_FILE")"
    printf "fake-plan" > "$out"
    exit 0
    ;;
  show)
    printf '{"resource_changes":[]}'
    exit 0
    ;;
  apply)
    test -n "\${GENERIC_API_TOKEN:-}"
    test -n "\${GENERIC_CREDENTIALS_FILE:-}"
    test -f "$GENERIC_CREDENTIALS_FILE"
    test "$(cat "$GENERIC_CREDENTIALS_FILE")" = "generic-file-secret-123456789"
    printf "%s" "$GENERIC_CREDENTIALS_FILE" > "${pathRecord}"
    echo "apply env $GENERIC_API_TOKEN file $(cat "$GENERIC_CREDENTIALS_FILE")"
    exit 0
    ;;
  output)
    printf '{}'
    exit 0
    ;;
  *)
    echo "unknown tofu command $cmd" >&2
    exit 127
    ;;
esac
`;
}
