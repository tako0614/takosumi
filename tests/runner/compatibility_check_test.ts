import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "bun:test";

import { handleRunnerRequest, safeRunId } from "../../runner/entrypoint.ts";
import {
  prepareStrictProviderMirrorInit,
  providerPluginCacheForWorkspace,
  withProviderPluginCacheInitLock,
} from "../../runner/lib/providers.ts";
import type { RunWorkspace } from "../../runner/lib/types.ts";

const RUN_ROOT = Bun.env.TAKOSUMI_OPENTOFU_RUN_ROOT ?? "/tmp/takosumi-runs";
const RESTORED_GIT_SOURCE = {
  kind: "git",
  url: "https://git.example.com/example/capsule.git",
  commit: "0123456789abcdef0123456789abcdef01234567",
} as const;

function testWorkspace(root: string): RunWorkspace {
  return {
    root,
    sourceRoot: join(root, "source"),
    moduleDir: join(root, "module"),
    planPath: join(root, "tfplan"),
    restoredStatePath: join(root, "terraform.tfstate"),
    moduleInfoPath: join(root, "module-info.json"),
    generatedRootDir: join(root, "generated-root"),
    childModuleDir: join(root, "generated-root", "module"),
    artifactDir: join(root, "artifact"),
    depsDir: join(root, "deps"),
  };
}

async function digestBytes(bytes: Uint8Array): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return `sha256:${Array.from(hash, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")}`;
}

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

test("compatibility_check runs inside source.modulePath when provided", async () => {
  const runId = `compat_module_${crypto.randomUUID().replace(/-/g, "")}`;
  const root = join(RUN_ROOT, runId);
  const sourceRoot = join(root, "source");
  const moduleRoot = join(sourceRoot, "takos", "deploy", "opentofu");
  const fakeBin = await mkdtemp(join(tmpdir(), "takosumi-compat-bin-"));
  const previousPath = Bun.env.PATH;
  try {
    await mkdir(moduleRoot, { recursive: true });
    await mkdir(join(sourceRoot, ".well-known"), { recursive: true });
    await writeFile(join(sourceRoot, "root.tf"), "terraform {}\n");
    await writeFile(join(moduleRoot, "main.tf"), "terraform {}\n");
    await writeFile(
      join(sourceRoot, ".well-known", "tcs.json"),
      '{"schemaVersion":"tcs.repo/v1","inputs":[]}\n',
    );
    const tofuPath = join(fakeBin, "tofu");
    await writeFile(
      tofuPath,
      `#!/usr/bin/env bash
set -euo pipefail
case "$1" in
  init)
    test -f main.tf
    test ! -f root.tf
    printf 'provider "registry.opentofu.org/cloudflare/cloudflare" {}\\n' > .terraform.lock.hcl
    echo "module init ok"
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

    const response = await handleRunnerRequest(
      new Request(`https://runner/runs/${runId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "takosumi.opentofu-run@v1",
          action: "compatibility_check",
          runId,
          request: { source: { modulePath: "takos/deploy/opentofu" } },
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
      stdout: "module init ok\n",
    });
    expect(
      Array.isArray(body.phaseTimings) &&
        body.phaseTimings.some(
          (entry: unknown) =>
            typeof entry === "object" &&
            entry !== null &&
            (entry as { phase?: unknown }).phase === "tofu_init" &&
            typeof (entry as { durationMs?: unknown }).durationMs === "number",
        ),
    ).toBe(true);
    expect(body.files).toEqual([
      {
        path: ".terraform.lock.hcl",
        text: 'provider "registry.opentofu.org/cloudflare/cloudflare" {}\n',
      },
      { path: "main.tf", text: "terraform {}\n" },
      {
        path: ".well-known/tcs.json",
        text: '{"schemaVersion":"tcs.repo/v1","inputs":[]}\n',
      },
    ]);
  } finally {
    if (previousPath === undefined) delete Bun.env.PATH;
    else Bun.env.PATH = previousPath;
    await rm(root, { recursive: true, force: true });
    await rm(fakeBin, { recursive: true, force: true });
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

test("compatibility_check fails closed when the capsule exceeds the file cap", async () => {
  const runId = `compat_cap_${crypto.randomUUID().replace(/-/g, "")}`;
  const root = join(RUN_ROOT, runId);
  const sourceRoot = join(root, "source");
  const fakeBin = await mkdtemp(join(tmpdir(), "takosumi-compat-bin-"));
  const previousPath = Bun.env.PATH;
  try {
    await mkdir(sourceRoot, { recursive: true });
    // 257 OpenTofu source files (> CAPSULE_COMPATIBILITY_MAX_FILES = 256) must
    // be REJECTED, not silently truncated: a file past the cap could carry a
    // provisioner that escapes Capsule Gate analysis.
    for (let i = 0; i < 257; i++) {
      const name = `f${String(i).padStart(4, "0")}.tf`;
      await writeFile(join(sourceRoot, name), "terraform {}\n");
    }
    const tofuPath = join(fakeBin, "tofu");
    await writeFile(
      tofuPath,
      `#!/usr/bin/env bash
set -euo pipefail
echo "init ok"
`,
    );
    await chmod(tofuPath, 0o755);
    Bun.env.PATH = `${fakeBin}:${previousPath ?? ""}`;

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

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body).toMatchObject({
      runId,
      action: "compatibility_check",
      status: "failed",
      exitCode: 1,
    });
    expect(body.stderr).toContain("exceed");
    expect(body.files).toBeUndefined();
  } finally {
    if (previousPath === undefined) delete Bun.env.PATH;
    else Bun.env.PATH = previousPath;
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

test("backup action does not invent a provider-specific snapshot without an explicit adapter", async () => {
  const runId = `provider_snapshot_unsupported_${crypto.randomUUID().replace(/-/g, "")}`;
  const previous = Bun.env.TAKOSUMI_BACKUP_ADAPTERS_JSON;
  const root = join(RUN_ROOT, runId);
  try {
    delete Bun.env.TAKOSUMI_BACKUP_ADAPTERS_JSON;

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
              adapterId: "cloud-provider-snapshot",
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
      "cloud-provider-snapshot",
    );
  } finally {
    if (previous === undefined) delete Bun.env.TAKOSUMI_BACKUP_ADAPTERS_JSON;
    else Bun.env.TAKOSUMI_BACKUP_ADAPTERS_JSON = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("backup action uses an explicit provider_snapshot artifact pointer directory", async () => {
  const runId = `provider_snapshot_builtin_${crypto.randomUUID().replace(/-/g, "")}`;
  const previous = Bun.env.TAKOSUMI_BACKUP_ADAPTERS_JSON;
  const root = join(RUN_ROOT, runId);
  const pointerDir = join(root, "provider-snapshots");
  try {
    Bun.env.TAKOSUMI_BACKUP_ADAPTERS_JSON = JSON.stringify({
      "pointer-export": { kind: "pointer", directory: pointerDir },
    });
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
              adapterId: "pointer-export",
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
    if (previous === undefined) delete Bun.env.TAKOSUMI_BACKUP_ADAPTERS_JSON;
    else Bun.env.TAKOSUMI_BACKUP_ADAPTERS_JSON = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("backup action runs provider_snapshot adapter without restored source", async () => {
  const runId = `provider_snapshot_${crypto.randomUUID().replace(/-/g, "")}`;
  const previous = Bun.env.TAKOSUMI_BACKUP_ADAPTERS_JSON;
  const root = join(RUN_ROOT, runId);
  try {
    await rm(root, { recursive: true, force: true });
    const command =
      `test "$TAKOSUMI_BACKUP_MODE" = provider_snapshot && ` +
      `test "$TAKOSUMI_BACKUP_ADAPTER_ID" = snapshot-command && ` +
      `test "$TAKOSUMI_BACKUP_OUTPUT_PATH" = provider.snapshot && ` +
      `test "$TAKOSUMI_RUN_ID" = ${runId} && ` +
      `printf '%s\\n' '{"ref":"r2://service-data/provider/provider.tar.zst.enc","digest":"sha256:${"b".repeat(64)}","sizeBytes":456}'`;
    Bun.env.TAKOSUMI_BACKUP_ADAPTERS_JSON = JSON.stringify({
      "snapshot-command": { kind: "command", command },
    });

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
              adapterId: "snapshot-command",
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
    if (previous === undefined) delete Bun.env.TAKOSUMI_BACKUP_ADAPTERS_JSON;
    else Bun.env.TAKOSUMI_BACKUP_ADAPTERS_JSON = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("backup action selects only the exact provider_snapshot adapter id", async () => {
  const runId = `provider_snapshot_command_scoped_${crypto.randomUUID().replace(/-/g, "")}`;
  const previous = Bun.env.TAKOSUMI_BACKUP_ADAPTERS_JSON;
  const root = join(RUN_ROOT, runId);
  try {
    await rm(root, { recursive: true, force: true });
    const command =
      `test "$TAKOSUMI_BACKUP_MODE" = provider_snapshot && ` +
      `test "$TAKOSUMI_BACKUP_ADAPTER_ID" = selected-adapter && ` +
      `test "$TAKOSUMI_BACKUP_OUTPUT_PATH" = provider.snapshot && ` +
      `test "$TAKOSUMI_RUN_ID" = ${runId} && ` +
      `printf '%s\\n' '{"ref":"r2://service-data/provider/cloudflare-native.json.enc","digest":"sha256:${"f".repeat(64)}","sizeBytes":654}'`;
    Bun.env.TAKOSUMI_BACKUP_ADAPTERS_JSON = JSON.stringify({
      "other-adapter": { kind: "command", command: "exit 27" },
      "selected-adapter": { kind: "command", command },
    });

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
              adapterId: "selected-adapter",
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
    if (previous === undefined) delete Bun.env.TAKOSUMI_BACKUP_ADAPTERS_JSON;
    else Bun.env.TAKOSUMI_BACKUP_ADAPTERS_JSON = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("plan with mirror-required policy forces tofu init through a strict filesystem mirror config", async () => {
  const runId = `mirror_test_${crypto.randomUUID().replace(/-/g, "")}`;
  const root = join(RUN_ROOT, runId);
  const sourceRoot = join(root, "source");
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
    await mkdir(sourceRoot, { recursive: true });
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
              source: RESTORED_GIT_SOURCE,
              requiredProviders: [
                "registry.opentofu.org/cloudflare/cloudflare",
              ],
            },
            providerInstallationPolicy: { requireMirror: true },
            runnerProfile: {
              allowedProviders: ["registry.opentofu.org/cloudflare/cloudflare"],
            },
            generatedRoot: {
              files: {
                "main.tf": [
                  'module "child" {',
                  '  source = "./module"',
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
    // A strict mirror run installs ONLY from the operator mirror: a plugin
    // cache would let an earlier run in this container seed the binaries.
    expect(seenConfig).not.toContain("plugin_cache_dir");
    expect(seenConfig).toContain(`path = "${mirrorRoot}"`);
    expect(seenConfig).toContain(
      '"registry.opentofu.org/cloudflare/cloudflare"',
    );
    expect(seenConfig).toContain("direct");
    // strict mirror is fail-closed: the direct registry excludes everything so a
    // provider missing from the mirror include list cannot silently pull from the
    // public registry, it fails at `tofu init` instead.
    expect(seenConfig).toContain('exclude = ["*/*"]');
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
    await rm(fakeBin, { recursive: true, force: true });
    await rm(mirrorRoot, { recursive: true, force: true });
  }
});

test("provider plugin cache can be shared by runner container env", async () => {
  const root = await mkdtemp(join(tmpdir(), "takosumi-cache-root-"));
  const sharedCache = join(root, "shared-provider-cache");
  const previousCache = Bun.env.TAKOSUMI_OPENTOFU_PLUGIN_CACHE_DIR;
  try {
    const workspace = testWorkspace(join(root, "run"));
    expect(providerPluginCacheForWorkspace(workspace)).toEqual({
      path: join(workspace.root, "provider-cache"),
      shared: false,
    });

    Bun.env.TAKOSUMI_OPENTOFU_PLUGIN_CACHE_DIR = sharedCache;
    const init = await prepareStrictProviderMirrorInit(
      workspace,
      { env: {} },
      ["registry.opentofu.org/cloudflare/cloudflare"],
      { requireMirror: false },
    );
    expect(init?.providerCacheDir).toBe(sharedCache);
    expect(init?.sharedProviderCache).toBe(true);
    const config = await readFile(
      join(workspace.root, "takosumi.tofu.rc"),
      "utf8",
    );
    expect(config).toContain(`plugin_cache_dir = "${sharedCache}"`);

    // A strict mirror run never joins the container-wide cache: another
    // Workspace's run could otherwise seed the provider binaries it installs.
    const strict = await prepareStrictProviderMirrorInit(
      testWorkspace(join(root, "strict-run")),
      { env: {} },
      ["registry.opentofu.org/cloudflare/cloudflare"],
      { requireMirror: true },
    );
    expect(strict?.providerCacheDir).toBeUndefined();
    expect(strict?.sharedProviderCache).toBe(false);
    expect(
      await readFile(
        join(root, "strict-run", "takosumi.tofu.rc"),
        "utf8",
      ),
    ).not.toContain("plugin_cache_dir");
  } finally {
    if (previousCache === undefined) {
      delete Bun.env.TAKOSUMI_OPENTOFU_PLUGIN_CACHE_DIR;
    } else {
      Bun.env.TAKOSUMI_OPENTOFU_PLUGIN_CACHE_DIR = previousCache;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("shared provider plugin cache serializes tofu init per cache path", async () => {
  const root = await mkdtemp(join(tmpdir(), "takosumi-cache-lock-root-"));
  const sharedCache = join(root, "shared-provider-cache");
  const previousCache = Bun.env.TAKOSUMI_OPENTOFU_PLUGIN_CACHE_DIR;
  try {
    Bun.env.TAKOSUMI_OPENTOFU_PLUGIN_CACHE_DIR = sharedCache;
    const init = await prepareStrictProviderMirrorInit(
      testWorkspace(join(root, "run")),
      { env: {} },
      ["registry.opentofu.org/cloudflare/cloudflare"],
      { requireMirror: false },
    );
    expect(init?.sharedProviderCache).toBe(true);
    const events: string[] = [];
    let releaseFirst!: () => void;
    let enteredFirst!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      enteredFirst = resolve;
    });
    const first = withProviderPluginCacheInitLock(init, async () => {
      events.push("first:start");
      enteredFirst();
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      events.push("first:end");
    });
    await firstEntered;
    const second = withProviderPluginCacheInitLock(init, async () => {
      events.push("second:start");
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events).toEqual(["first:start"]);

    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(["first:start", "first:end", "second:start"]);
  } finally {
    if (previousCache === undefined) {
      delete Bun.env.TAKOSUMI_OPENTOFU_PLUGIN_CACHE_DIR;
    } else {
      Bun.env.TAKOSUMI_OPENTOFU_PLUGIN_CACHE_DIR = previousCache;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("generated-root destroy plan restores uploaded state before tofu plan", async () => {
  const runId = `plan_state_${crypto.randomUUID().replace(/-/g, "")}`;
  const root = join(RUN_ROOT, runId);
  const sourceRoot = join(root, "source");
  const fakeBin = await mkdtemp(join(tmpdir(), "takosumi-plan-state-bin-"));
  const previousPath = Bun.env.PATH;
  const restoredState = new TextEncoder().encode(
    '{"version":4,"terraform_version":"1.10.0","serial":1,"lineage":"restored-state-marker","resources":[]}\n',
  );
  try {
    await mkdir(sourceRoot, { recursive: true });
    await writeFile(join(sourceRoot, "main.tf"), "terraform {}\n");
    const putState = await handleRunnerRequest(
      new Request(`https://runner/runs/${runId}/artifacts/tfstate`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: restoredState,
      }),
    );
    expect(putState.status).toBe(200);

    const tofuPath = join(fakeBin, "tofu");
    await writeFile(
      tofuPath,
      `#!/usr/bin/env bash
set -euo pipefail
case "$1" in
  init)
    echo "init"
    ;;
  plan)
    test -f terraform.tfstate || { echo "missing restored terraform.tfstate" >&2; exit 9; }
    grep -q "restored-state-marker" terraform.tfstate || { echo "wrong restored state" >&2; exit 10; }
    found_destroy=0
    out=""
    previous=""
    for arg in "$@"; do
      if [ "$arg" = "-destroy" ]; then
        found_destroy=1
      fi
      if [ "$previous" = "-out" ]; then
        out="$arg"
      fi
      previous="$arg"
    done
    test "$found_destroy" = "1" || { echo "missing -destroy" >&2; exit 11; }
    test -n "$out"
    printf 'fake-destroy-plan' > "$out"
    echo "plan"
    ;;
  show)
    printf '{"format_version":"1.2","resource_changes":[{"address":"null_resource.example","change":{"actions":["delete"]}}]}'
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
              id: runId,
              operation: "destroy",
              source: RESTORED_GIT_SOURCE,
              requiredProviders: [],
            },
            runnerProfile: {
              allowedProviders: [],
            },
            generatedRoot: {
              files: {
                "main.tf": [
                  'module "child" {',
                  '  source = "./module"',
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
      readonly status?: string;
      readonly summary?: { readonly destroy?: number };
    };
    expect(body.status).toBe("succeeded");
    expect(body.summary?.destroy).toBe(1);
    await expect(
      readFile(join(root, "generated-root", "terraform.tfstate")),
    ).resolves.toEqual(restoredState);
  } finally {
    if (previousPath === undefined) {
      delete Bun.env.PATH;
    } else {
      Bun.env.PATH = previousPath;
    }
    await rm(root, { recursive: true, force: true });
    await rm(fakeBin, { recursive: true, force: true });
  }
});

test("generated-root refresh plan passes -refresh-only without destroy semantics", async () => {
  const runId = `plan_refresh_${crypto.randomUUID().replace(/-/g, "")}`;
  const root = join(RUN_ROOT, runId);
  const sourceRoot = join(root, "source");
  const fakeBin = await mkdtemp(join(tmpdir(), "takosumi-plan-refresh-bin-"));
  const previousPath = Bun.env.PATH;
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
    echo "init"
    ;;
  plan)
    found_refresh=0
    found_destroy=0
    out=""
    previous=""
    for arg in "$@"; do
      if [ "$arg" = "-refresh-only" ]; then found_refresh=1; fi
      if [ "$arg" = "-destroy" ]; then found_destroy=1; fi
      if [ "$previous" = "-out" ]; then out="$arg"; fi
      previous="$arg"
    done
    test "$found_refresh" = "1" || { echo "missing -refresh-only" >&2; exit 11; }
    test "$found_destroy" = "0" || { echo "unexpected -destroy" >&2; exit 12; }
    test -n "$out"
    printf 'fake-refresh-plan' > "$out"
    ;;
  show)
    printf '{"format_version":"1.2","resource_changes":[{"address":"null_resource.example","type":"null_resource","change":{"actions":["update"]}}]}'
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
              id: runId,
              operation: "update",
              refreshOnly: true,
              source: RESTORED_GIT_SOURCE,
              requiredProviders: [],
            },
            runnerProfile: { allowedProviders: [] },
            generatedRoot: {
              files: {
                "main.tf": [
                  'module "child" {',
                  '  source = "./module"',
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
      readonly status?: string;
      readonly summary?: { readonly change?: number };
    };
    expect(body.status).toBe("succeeded");
    expect(body.summary?.change).toBe(1);
  } finally {
    if (previousPath === undefined) delete Bun.env.PATH;
    else Bun.env.PATH = previousPath;
    await rm(root, { recursive: true, force: true });
    await rm(fakeBin, { recursive: true, force: true });
  }
});

test("generated-root apply falls back to terraform.tfstate outputs when tofu output is empty", async () => {
  const runId = `apply_outputs_${crypto.randomUUID().replace(/-/g, "")}`;
  const root = join(RUN_ROOT, runId);
  const sourceRoot = join(root, "source");
  const fakeBin = await mkdtemp(join(tmpdir(), "takosumi-apply-output-bin-"));
  const previousPath = Bun.env.PATH;
  const planBytes = new TextEncoder().encode("fake-reviewed-plan");
  const planDigest = await digestBytes(planBytes);
  try {
    await mkdir(sourceRoot, { recursive: true });
    await writeFile(join(sourceRoot, "main.tf"), "terraform {}\n");
    const putPlan = await handleRunnerRequest(
      new Request(`https://runner/runs/${runId}/artifacts/tfplan`, {
        method: "PUT",
        headers: { "content-type": "application/vnd.opentofu.plan" },
        body: planBytes,
      }),
    );
    expect(putPlan.status).toBe(200);

    const tofuPath = join(fakeBin, "tofu");
    await writeFile(
      tofuPath,
      `#!/usr/bin/env bash
set -euo pipefail
case "$1" in
  init)
    echo "init"
    ;;
  apply)
    cat > terraform.tfstate <<'JSON'
{"version":4,"terraform_version":"1.10.0","serial":1,"lineage":"output-fallback","outputs":{"worker_name":{"value":"demo-worker","type":"string","sensitive":false},"url":{"value":"https://demo-worker.example.test","type":"string","sensitive":false}},"resources":[]}
JSON
    echo "apply"
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

    const response = await handleRunnerRequest(
      new Request(`https://runner/runs/${runId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "takosumi.opentofu-run@v1",
          action: "apply",
          runId,
          request: {
            planRun: {
              id: runId,
              source: RESTORED_GIT_SOURCE,
              requiredProviders: [],
            },
            planArtifact: {
              kind: "runner-local",
              ref: `runner-local://${runId}/tfplan`,
              digest: planDigest,
            },
            runnerProfile: {
              allowedProviders: [],
            },
            generatedRoot: {
              files: {
                "main.tf": [
                  'module "child" {',
                  '  source = "./module"',
                  "}",
                  "",
                ].join("\n"),
                "outputs.tf": [
                  'output "worker_name" { value = module.child.worker_name }',
                  'output "url" { value = module.child.url }',
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
      readonly status?: string;
      readonly outputs?: Record<string, { readonly value?: unknown }>;
    };
    expect(body.status).toBe("succeeded");
    expect(body.outputs?.worker_name?.value).toBe("demo-worker");
    expect(body.outputs?.url?.value).toBe("https://demo-worker.example.test");
  } finally {
    if (previousPath === undefined) {
      delete Bun.env.PATH;
    } else {
      Bun.env.PATH = previousPath;
    }
    await rm(root, { recursive: true, force: true });
    await rm(fakeBin, { recursive: true, force: true });
  }
});

test("safeRunId neutralizes dot-segment runIds so the workspace stays jailed", () => {
  // The allowed charset permits `.`, so a runId that sanitizes to exactly
  // `.`/`..` would let join(RUN_ROOT, safeRunId(runId)) resolve outside
  // RUN_ROOT. The charset step already collapses `/` (and every other
  // disallowed char) to `_`, so an embedded `..` can never become its own path
  // segment; the final dot-only guard closes the bare `.`/`..` case.
  expect(safeRunId("..")).toBe("_");
  expect(safeRunId(".")).toBe("_");
  expect(safeRunId("../etc")).toBe(".._etc");
  expect(safeRunId("a/../b")).toBe("a_.._b");
  expect(safeRunId("a/./b")).toBe("a_._b");
  // Ordinary dotted runIds are still preserved.
  expect(safeRunId("run.123")).toBe("run.123");
  expect(safeRunId("...")).toBe("...");

  // Whatever the runId, the resolved workspace root never escapes RUN_ROOT.
  const jail = resolve(RUN_ROOT);
  for (const runId of ["..", ".", "../../escape", "a/../../b", "..%2f..%2f"]) {
    const root = resolve(join(RUN_ROOT, safeRunId(runId)));
    expect(root === jail || root.startsWith(`${jail}/`)).toBe(true);
  }
});
