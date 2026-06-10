import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";

import { handleRunnerRequest } from "./entrypoint.ts";

const RUN_ROOT = Bun.env.TAKOSUMI_OPENTOFU_RUN_ROOT ?? "/tmp/takosumi-runs";

test("compatibility_check returns restored OpenTofu source files only", async () => {
  const runId = `compat_test_${crypto.randomUUID().replace(/-/g, "")}`;
  const root = join(RUN_ROOT, runId);
  const sourceRoot = join(root, "source");
  try {
    await mkdir(join(sourceRoot, "nested"), { recursive: true });
    await writeFile(join(sourceRoot, "main.tf"), "terraform {}\n");
    await writeFile(
      join(sourceRoot, "nested", "outputs.tf"),
      'output "x" { value = 1 }\n',
    );
    await writeFile(
      join(sourceRoot, "README.md"),
      "not part of compatibility scan\n",
    );

    const response = await handleRunnerRequest(
      new Request(`https://runner/runs/${runId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "takosumi.opentofu-run@v1",
          action: "compatibility_check",
          runId,
          request: {},
        }),
      }),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      runId,
      action: "compatibility_check",
      status: "succeeded",
      exitCode: 0,
    });
    expect(body.files).toEqual([
      { path: "main.tf", text: "terraform {}\n" },
      { path: "nested/outputs.tf", text: 'output "x" { value = 1 }\n' },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("compatibility_check runs tofu init without provider credentials and returns the lockfile", async () => {
  const runId = `compat_init_${crypto.randomUUID().replace(/-/g, "")}`;
  const root = join(RUN_ROOT, runId);
  const sourceRoot = join(root, "source");
  const fakeBin = await mkdtemp(join(tmpdir(), "takosumi-compat-bin-"));
  const previousPath = Bun.env.PATH;
  const previousCloudflareToken = Bun.env.CLOUDFLARE_API_TOKEN;
  try {
    await mkdir(sourceRoot, { recursive: true });
    await writeFile(join(sourceRoot, "main.tf"), "terraform {}\n");
    const tofuPath = join(fakeBin, "tofu");
    await writeFile(
      tofuPath,
      `#!/usr/bin/env bash
set -euo pipefail
case "$1" in
  init)
    if [ -n "\${CLOUDFLARE_API_TOKEN:-}" ]; then
      echo "credential leaked into compatibility_check" >&2
      exit 9
    fi
    printf 'provider "registry.opentofu.org/hashicorp/aws" {}\\n' > .terraform.lock.hcl
    echo "init ok"
    ;;
  *)
    echo "unexpected tofu command: $*" >&2
    exit 2
    ;;
esac
`,
    );
    await chmod(tofuPath, 0o755);
    Bun.env.PATH = `${fakeBin}:${previousPath ?? ""}`;
    Bun.env.CLOUDFLARE_API_TOKEN = "must-not-leak";

    const response = await handleRunnerRequest(
      new Request(`https://runner/runs/${runId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "takosumi.opentofu-run@v1",
          action: "compatibility_check",
          runId,
          request: {},
        }),
      }),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      runId,
      action: "compatibility_check",
      status: "succeeded",
      exitCode: 0,
      stdout: "init ok\n",
    });
    expect(body.providerLockDigest).toStartWith("sha256:");
    expect(body.files).toEqual([
      {
        path: ".terraform.lock.hcl",
        text: 'provider "registry.opentofu.org/hashicorp/aws" {}\n',
      },
      { path: "main.tf", text: "terraform {}\n" },
    ]);
  } finally {
    if (previousPath === undefined) delete Bun.env.PATH;
    else Bun.env.PATH = previousPath;
    if (previousCloudflareToken === undefined)
      delete Bun.env.CLOUDFLARE_API_TOKEN;
    else Bun.env.CLOUDFLARE_API_TOKEN = previousCloudflareToken;
    await rm(root, { recursive: true, force: true });
    await rm(fakeBin, { recursive: true, force: true });
  }
});

test("backup action runs custom_command in the restored source and returns artifact pointer", async () => {
  const runId = `backup_test_${crypto.randomUUID().replace(/-/g, "")}`;
  const root = join(RUN_ROOT, runId);
  const sourceRoot = join(root, "source");
  try {
    await mkdir(sourceRoot, { recursive: true });
    await writeFile(
      join(sourceRoot, "emit-backup.sh"),
      'printf \'%s\\n\' \'{"ref":"r2://service-data/exports/backup.tar.zst.enc","digest":"sha256:' +
        "a".repeat(64) +
        '","sizeBytes":123}\'\n',
    );
    await chmod(join(sourceRoot, "emit-backup.sh"), 0o755);

    const response = await handleRunnerRequest(
      new Request(`https://runner/runs/${runId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "takosumi.opentofu-run@v1",
          action: "backup",
          runId,
          request: {
            backup: {
              mode: "custom_command",
              outputPath: "backup.artifact",
              command: ["./emit-backup.sh"],
            },
          },
        }),
      }),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      runId,
      action: "backup",
      status: "succeeded",
      exitCode: 0,
      outputPath: "backup.artifact",
      artifact: {
        ref: "r2://service-data/exports/backup.tar.zst.enc",
        digest: `sha256:${"a".repeat(64)}`,
        sizeBytes: 123,
      },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("backup action reports provider_snapshot unsupported without adapter command", async () => {
  const runId = `provider_snapshot_unsupported_${crypto.randomUUID().replace(/-/g, "")}`;
  const previous = Bun.env.TAKOSUMI_PROVIDER_SNAPSHOT_COMMAND;
  const previousPointerDir = Bun.env.TAKOSUMI_PROVIDER_SNAPSHOT_POINTER_DIR;
  const root = join(RUN_ROOT, runId);
  try {
    delete Bun.env.TAKOSUMI_PROVIDER_SNAPSHOT_COMMAND;
    delete Bun.env.TAKOSUMI_PROVIDER_SNAPSHOT_POINTER_DIR;

    const response = await handleRunnerRequest(
      new Request(`https://runner/runs/${runId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "takosumi.opentofu-run@v1",
          action: "backup",
          runId,
          request: {
            backup: {
              mode: "provider_snapshot",
              outputPath: "provider.snapshot",
            },
          },
        }),
      }),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      runId,
      action: "backup",
      status: "unsupported",
      exitCode: 0,
    });
    expect(String((body as Record<string, unknown>).reason)).toContain(
      "TAKOSUMI_PROVIDER_SNAPSHOT_COMMAND",
    );
  } finally {
    if (previous === undefined)
      delete Bun.env.TAKOSUMI_PROVIDER_SNAPSHOT_COMMAND;
    else Bun.env.TAKOSUMI_PROVIDER_SNAPSHOT_COMMAND = previous;
    if (previousPointerDir === undefined) {
      delete Bun.env.TAKOSUMI_PROVIDER_SNAPSHOT_POINTER_DIR;
    } else {
      Bun.env.TAKOSUMI_PROVIDER_SNAPSHOT_POINTER_DIR = previousPointerDir;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("backup action has a built-in Cloudflare provider_snapshot adapter", async () => {
  const runId = `provider_snapshot_cloudflare_builtin_${crypto.randomUUID().replace(/-/g, "")}`;
  const previousGeneric = Bun.env.TAKOSUMI_PROVIDER_SNAPSHOT_COMMAND;
  const scopedEnv =
    "TAKOSUMI_PROVIDER_SNAPSHOT_COMMAND_REGISTRY_OPENTOFU_ORG_CLOUDFLARE_CLOUDFLARE";
  const previousScoped = Bun.env[scopedEnv];
  const previousPointerDir = Bun.env.TAKOSUMI_PROVIDER_SNAPSHOT_POINTER_DIR;
  const root = join(RUN_ROOT, runId);
  try {
    delete Bun.env.TAKOSUMI_PROVIDER_SNAPSHOT_COMMAND;
    delete Bun.env[scopedEnv];
    delete Bun.env.TAKOSUMI_PROVIDER_SNAPSHOT_POINTER_DIR;

    const response = await handleRunnerRequest(
      new Request(`https://runner/runs/${runId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "takosumi.opentofu-run@v1",
          action: "backup",
          runId,
          request: {
            backup: {
              mode: "provider_snapshot",
              outputPath: "provider.snapshot",
              provider: "registry.opentofu.org/cloudflare/cloudflare",
            },
          },
        }),
      }),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      runId,
      action: "backup",
      status: "succeeded",
      exitCode: 0,
      outputPath: "provider.snapshot",
      artifact: {
        digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
        contentType: "application/json",
        metadata: {
          provider: "registry.opentofu.org/cloudflare/cloudflare",
          adapter: "takosumi-built-in-provider-snapshot",
          adapterKind: "cloudflare-provider-snapshot",
        },
      },
    });
    const artifact = (body.artifact ?? {}) as Record<string, unknown>;
    expect(String(artifact.ref)).toMatch(
      new RegExp(`^runner-local://${runId}/artifact/.+\\.snapshot\\.json$`),
    );
  } finally {
    if (previousGeneric === undefined)
      delete Bun.env.TAKOSUMI_PROVIDER_SNAPSHOT_COMMAND;
    else Bun.env.TAKOSUMI_PROVIDER_SNAPSHOT_COMMAND = previousGeneric;
    if (previousScoped === undefined) delete Bun.env[scopedEnv];
    else Bun.env[scopedEnv] = previousScoped;
    if (previousPointerDir === undefined) {
      delete Bun.env.TAKOSUMI_PROVIDER_SNAPSHOT_POINTER_DIR;
    } else {
      Bun.env.TAKOSUMI_PROVIDER_SNAPSHOT_POINTER_DIR = previousPointerDir;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("backup action has a built-in AWS provider_snapshot adapter", async () => {
  const runId = `provider_snapshot_aws_builtin_${crypto.randomUUID().replace(/-/g, "")}`;
  const previousGeneric = Bun.env.TAKOSUMI_PROVIDER_SNAPSHOT_COMMAND;
  const scopedEnv =
    "TAKOSUMI_PROVIDER_SNAPSHOT_COMMAND_REGISTRY_OPENTOFU_ORG_HASHICORP_AWS";
  const previousScoped = Bun.env[scopedEnv];
  const previousPointerDir = Bun.env.TAKOSUMI_PROVIDER_SNAPSHOT_POINTER_DIR;
  const root = join(RUN_ROOT, runId);
  try {
    delete Bun.env.TAKOSUMI_PROVIDER_SNAPSHOT_COMMAND;
    delete Bun.env[scopedEnv];
    delete Bun.env.TAKOSUMI_PROVIDER_SNAPSHOT_POINTER_DIR;

    const response = await handleRunnerRequest(
      new Request(`https://runner/runs/${runId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "takosumi.opentofu-run@v1",
          action: "backup",
          runId,
          request: {
            backup: {
              mode: "provider_snapshot",
              outputPath: "provider.snapshot",
              provider: "aws",
            },
          },
        }),
      }),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      runId,
      action: "backup",
      status: "succeeded",
      exitCode: 0,
      artifact: {
        metadata: {
          provider: "registry.opentofu.org/hashicorp/aws",
          adapterKind: "aws-provider-snapshot",
        },
      },
    });
  } finally {
    if (previousGeneric === undefined)
      delete Bun.env.TAKOSUMI_PROVIDER_SNAPSHOT_COMMAND;
    else Bun.env.TAKOSUMI_PROVIDER_SNAPSHOT_COMMAND = previousGeneric;
    if (previousScoped === undefined) delete Bun.env[scopedEnv];
    else Bun.env[scopedEnv] = previousScoped;
    if (previousPointerDir === undefined) {
      delete Bun.env.TAKOSUMI_PROVIDER_SNAPSHOT_POINTER_DIR;
    } else {
      Bun.env.TAKOSUMI_PROVIDER_SNAPSHOT_POINTER_DIR = previousPointerDir;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("backup action uses built-in provider_snapshot pointer directory", async () => {
  const runId = `provider_snapshot_builtin_${crypto.randomUUID().replace(/-/g, "")}`;
  const previous = Bun.env.TAKOSUMI_PROVIDER_SNAPSHOT_COMMAND;
  const previousPointerDir = Bun.env.TAKOSUMI_PROVIDER_SNAPSHOT_POINTER_DIR;
  const root = join(RUN_ROOT, runId);
  const pointerDir = join(root, "provider-snapshots");
  try {
    delete Bun.env.TAKOSUMI_PROVIDER_SNAPSHOT_COMMAND;
    Bun.env.TAKOSUMI_PROVIDER_SNAPSHOT_POINTER_DIR = pointerDir;
    await mkdir(pointerDir, { recursive: true });
    await writeFile(
      join(pointerDir, "provider.snapshot.json"),
      JSON.stringify({
        ref: "r2://service-data/provider/builtin-snapshot.json.enc",
        digest: `sha256:${"c".repeat(64)}`,
        sizeBytes: 789,
        metadata: { provider: "cloudflare" },
      }),
    );

    const response = await handleRunnerRequest(
      new Request(`https://runner/runs/${runId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "takosumi.opentofu-run@v1",
          action: "backup",
          runId,
          request: {
            backup: {
              mode: "provider_snapshot",
              outputPath: "provider.snapshot",
            },
          },
        }),
      }),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      runId,
      action: "backup",
      status: "succeeded",
      exitCode: 0,
      outputPath: "provider.snapshot",
      artifact: {
        ref: "r2://service-data/provider/builtin-snapshot.json.enc",
        digest: `sha256:${"c".repeat(64)}`,
        sizeBytes: 789,
        metadata: { provider: "cloudflare" },
      },
    });
  } finally {
    if (previous === undefined)
      delete Bun.env.TAKOSUMI_PROVIDER_SNAPSHOT_COMMAND;
    else Bun.env.TAKOSUMI_PROVIDER_SNAPSHOT_COMMAND = previous;
    if (previousPointerDir === undefined) {
      delete Bun.env.TAKOSUMI_PROVIDER_SNAPSHOT_POINTER_DIR;
    } else {
      Bun.env.TAKOSUMI_PROVIDER_SNAPSHOT_POINTER_DIR = previousPointerDir;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("backup action prefers provider-scoped built-in provider_snapshot pointers", async () => {
  const runId = `provider_snapshot_scoped_${crypto.randomUUID().replace(/-/g, "")}`;
  const previous = Bun.env.TAKOSUMI_PROVIDER_SNAPSHOT_COMMAND;
  const previousPointerDir = Bun.env.TAKOSUMI_PROVIDER_SNAPSHOT_POINTER_DIR;
  const root = join(RUN_ROOT, runId);
  const pointerDir = join(root, "provider-snapshots");
  const providerDir = join(pointerDir, "registry.opentofu.org_cloudflare_cloudflare");
  try {
    delete Bun.env.TAKOSUMI_PROVIDER_SNAPSHOT_COMMAND;
    Bun.env.TAKOSUMI_PROVIDER_SNAPSHOT_POINTER_DIR = pointerDir;
    await mkdir(pointerDir, { recursive: true });
    await mkdir(providerDir, { recursive: true });
    await writeFile(
      join(pointerDir, "provider.snapshot.json"),
      JSON.stringify({
        ref: "r2://service-data/provider/legacy-snapshot.json.enc",
        digest: `sha256:${"d".repeat(64)}`,
        sizeBytes: 111,
      }),
    );
    await writeFile(
      join(providerDir, "provider.snapshot.json"),
      JSON.stringify({
        ref: "r2://service-data/provider/cloudflare-snapshot.json.enc",
        digest: `sha256:${"e".repeat(64)}`,
        sizeBytes: 222,
        metadata: { provider: "registry.opentofu.org/cloudflare/cloudflare" },
      }),
    );

    const response = await handleRunnerRequest(
      new Request(`https://runner/runs/${runId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "takosumi.opentofu-run@v1",
          action: "backup",
          runId,
          request: {
            backup: {
              mode: "provider_snapshot",
              outputPath: "provider.snapshot",
              provider: "registry.opentofu.org/cloudflare/cloudflare",
            },
          },
        }),
      }),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      runId,
      action: "backup",
      status: "succeeded",
      outputPath: "provider.snapshot",
      artifact: {
        ref: "r2://service-data/provider/cloudflare-snapshot.json.enc",
        digest: `sha256:${"e".repeat(64)}`,
        sizeBytes: 222,
      },
    });
  } finally {
    if (previous === undefined)
      delete Bun.env.TAKOSUMI_PROVIDER_SNAPSHOT_COMMAND;
    else Bun.env.TAKOSUMI_PROVIDER_SNAPSHOT_COMMAND = previous;
    if (previousPointerDir === undefined) {
      delete Bun.env.TAKOSUMI_PROVIDER_SNAPSHOT_POINTER_DIR;
    } else {
      Bun.env.TAKOSUMI_PROVIDER_SNAPSHOT_POINTER_DIR = previousPointerDir;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("backup action runs provider_snapshot adapter without restored source", async () => {
  const runId = `provider_snapshot_${crypto.randomUUID().replace(/-/g, "")}`;
  const previous = Bun.env.TAKOSUMI_PROVIDER_SNAPSHOT_COMMAND;
  const root = join(RUN_ROOT, runId);
  try {
    await rm(root, { recursive: true, force: true });
    Bun.env.TAKOSUMI_PROVIDER_SNAPSHOT_COMMAND =
      `test "$TAKOSUMI_BACKUP_MODE" = provider_snapshot && ` +
      `test "$TAKOSUMI_BACKUP_OUTPUT_PATH" = provider.snapshot && ` +
      `test "$TAKOSUMI_RUN_ID" = ${runId} && ` +
      `printf '%s\\n' '{"ref":"r2://service-data/provider/provider.tar.zst.enc","digest":"sha256:${"b".repeat(64)}","sizeBytes":456}'`;

    const response = await handleRunnerRequest(
      new Request(`https://runner/runs/${runId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "takosumi.opentofu-run@v1",
          action: "backup",
          runId,
          request: {
            backup: {
              mode: "provider_snapshot",
              outputPath: "provider.snapshot",
            },
          },
        }),
      }),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      runId,
      action: "backup",
      status: "succeeded",
      exitCode: 0,
      outputPath: "provider.snapshot",
      artifact: {
        ref: "r2://service-data/provider/provider.tar.zst.enc",
        digest: `sha256:${"b".repeat(64)}`,
        sizeBytes: 456,
      },
    });
  } finally {
    if (previous === undefined)
      delete Bun.env.TAKOSUMI_PROVIDER_SNAPSHOT_COMMAND;
    else Bun.env.TAKOSUMI_PROVIDER_SNAPSHOT_COMMAND = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("backup action prefers provider-scoped provider_snapshot adapter command", async () => {
  const runId = `provider_snapshot_command_scoped_${crypto.randomUUID().replace(/-/g, "")}`;
  const genericEnv = "TAKOSUMI_PROVIDER_SNAPSHOT_COMMAND";
  const scopedEnv =
    "TAKOSUMI_PROVIDER_SNAPSHOT_COMMAND_REGISTRY_OPENTOFU_ORG_CLOUDFLARE_CLOUDFLARE";
  const previousGeneric = Bun.env[genericEnv];
  const previousScoped = Bun.env[scopedEnv];
  const previousPointerDir = Bun.env.TAKOSUMI_PROVIDER_SNAPSHOT_POINTER_DIR;
  const root = join(RUN_ROOT, runId);
  try {
    await rm(root, { recursive: true, force: true });
    delete Bun.env.TAKOSUMI_PROVIDER_SNAPSHOT_POINTER_DIR;
    Bun.env[genericEnv] = "exit 27";
    Bun.env[scopedEnv] =
      `test "$TAKOSUMI_BACKUP_MODE" = provider_snapshot && ` +
      `test "$TAKOSUMI_BACKUP_OUTPUT_PATH" = provider.snapshot && ` +
      `test "$TAKOSUMI_BACKUP_PROVIDER" = registry.opentofu.org/cloudflare/cloudflare && ` +
      `test "$TAKOSUMI_RUN_ID" = ${runId} && ` +
      `printf '%s\\n' '{"ref":"r2://service-data/provider/cloudflare-native.json.enc","digest":"sha256:${"f".repeat(64)}","sizeBytes":654}'`;

    const response = await handleRunnerRequest(
      new Request(`https://runner/runs/${runId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "takosumi.opentofu-run@v1",
          action: "backup",
          runId,
          request: {
            backup: {
              mode: "provider_snapshot",
              outputPath: "provider.snapshot",
              provider: "registry.opentofu.org/cloudflare/cloudflare",
            },
          },
        }),
      }),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      runId,
      action: "backup",
      status: "succeeded",
      exitCode: 0,
      outputPath: "provider.snapshot",
      artifact: {
        ref: "r2://service-data/provider/cloudflare-native.json.enc",
        digest: `sha256:${"f".repeat(64)}`,
        sizeBytes: 654,
      },
    });
  } finally {
    if (previousGeneric === undefined) delete Bun.env[genericEnv];
    else Bun.env[genericEnv] = previousGeneric;
    if (previousScoped === undefined) delete Bun.env[scopedEnv];
    else Bun.env[scopedEnv] = previousScoped;
    if (previousPointerDir === undefined) {
      delete Bun.env.TAKOSUMI_PROVIDER_SNAPSHOT_POINTER_DIR;
    } else {
      Bun.env.TAKOSUMI_PROVIDER_SNAPSHOT_POINTER_DIR = previousPointerDir;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("plan with mirror-required policy forces tofu init through a strict filesystem mirror config", async () => {
  const runId = `mirror_test_${crypto.randomUUID().replace(/-/g, "")}`;
  const root = join(RUN_ROOT, runId);
  const sourceRoot = await mkdtemp(join(tmpdir(), "takosumi-source-"));
  const fakeBin = await mkdtemp(join(tmpdir(), "takosumi-bin-"));
  const mirrorRoot = await mkdtemp(join(tmpdir(), "takosumi-mirror-"));
  const providerPath = join(
    mirrorRoot,
    "registry.opentofu.org",
    "cloudflare",
    "cloudflare",
  );
  const installedProviderPath = join(
    root,
    "generated-root",
    ".terraform",
    "providers",
    "registry.opentofu.org",
    "cloudflare",
    "cloudflare",
  );
  const previousPath = Bun.env.PATH;
  const previousMirror = Bun.env.OPENTOFU_PROVIDER_MIRROR;
  try {
    await mkdir(providerPath, { recursive: true });
    await writeFile(join(sourceRoot, "main.tf"), "terraform {}\n");
    const tofuPath = join(fakeBin, "tofu");
    await writeFile(
      tofuPath,
      `#!/usr/bin/env bash
set -euo pipefail
case "$1" in
  init)
    test -n "\${TF_CLI_CONFIG_FILE:-}"
    cp "$TF_CLI_CONFIG_FILE" "$PWD/strict-tofu.rc.seen"
    mkdir -p "$PWD/.terraform/providers/registry.opentofu.org/cloudflare/cloudflare/1.0.0/linux_amd64"
    printf 'provider-binary' > "$PWD/.terraform/providers/registry.opentofu.org/cloudflare/cloudflare/1.0.0/linux_amd64/terraform-provider-cloudflare"
    echo "init"
    ;;
  plan)
    out=""
    previous=""
    for arg in "$@"; do
      if [ "$previous" = "-out" ]; then
        out="$arg"
      fi
      previous="$arg"
    done
    test -n "$out"
    printf 'fake-plan' > "$out"
    echo "plan"
    ;;
  show)
    printf '{"format_version":"1.2","configuration":{"provider_config":{"cloudflare":{"full_name":"registry.opentofu.org/cloudflare/cloudflare"}}},"resource_changes":[]}'
    ;;
  output)
    printf '{}'
    ;;
  *)
    echo "unexpected tofu command: $*" >&2
    exit 2
    ;;
esac
`,
    );
    await chmod(tofuPath, 0o755);
    Bun.env.PATH = `${fakeBin}:${previousPath ?? ""}`;
    Bun.env.OPENTOFU_PROVIDER_MIRROR = mirrorRoot;

    const response = await handleRunnerRequest(
      new Request(`https://runner/runs/${runId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "takosumi.opentofu-run@v1",
          action: "plan",
          runId,
          request: {
            planRun: {
              id: "plan_mirror",
              operation: "create",
              source: { kind: "local", path: sourceRoot },
              requiredProviders: [
                "registry.opentofu.org/cloudflare/cloudflare",
              ],
            },
            providerInstallationPolicy: { requireMirror: true },
            runnerProfile: {
              sourcePolicy: { allowLocalSource: true },
              allowedProviders: ["registry.opentofu.org/cloudflare/cloudflare"],
            },
            generatedRoot: {
              files: {
                "main.tf": [
                  'module "app" {',
                  '  source = "./template-module"',
                  "}",
                  "",
                ].join("\n"),
                "versions.tf": [
                  "terraform {",
                  "  required_providers {",
                  "    cloudflare = {",
                  '      source = "cloudflare/cloudflare"',
                  "    }",
                  "  }",
                  "}",
                  "",
                ].join("\n"),
              },
            },
            variables: {},
          },
        }),
      }),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      readonly providerInstallation?: readonly Record<string, unknown>[];
    };
    expect(body.providerInstallation?.[0]).toMatchObject({
      provider: "registry.opentofu.org/cloudflare/cloudflare",
      mirrored: true,
      installationMethod: "filesystem_mirror",
      attested: true,
      attestationMethod: "forced_filesystem_mirror_init",
      installedPath: installedProviderPath,
    });
    expect(body.providerInstallation?.[0]?.cliConfigDigest).toEqual(
      expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    );
    expect(body.providerInstallation?.[0]?.installedDigest).toEqual(
      expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    );
    const seenConfig = await readFile(
      join(root, "generated-root", "strict-tofu.rc.seen"),
      "utf8",
    );
    expect(seenConfig).toContain(`path = "${mirrorRoot}"`);
    expect(seenConfig).toContain(
      '"registry.opentofu.org/cloudflare/cloudflare"',
    );
    expect(seenConfig).toContain("direct");
    // strict mirror is fail-closed: the direct registry excludes everything so a
    // provider missing from the mirror include list cannot silently pull from the
    // public registry, it fails at `tofu init` instead.
    expect(seenConfig).toContain('exclude = ["*"]');
  } finally {
    if (previousPath === undefined) {
      delete Bun.env.PATH;
    } else {
      Bun.env.PATH = previousPath;
    }
    if (previousMirror === undefined) {
      delete Bun.env.OPENTOFU_PROVIDER_MIRROR;
    } else {
      Bun.env.OPENTOFU_PROVIDER_MIRROR = previousMirror;
    }
    await rm(root, { recursive: true, force: true });
    await rm(sourceRoot, { recursive: true, force: true });
    await rm(fakeBin, { recursive: true, force: true });
    await rm(mirrorRoot, { recursive: true, force: true });
  }
});
