import assert from "node:assert/strict";
import { deployCommand } from "../src/commands/deploy.ts";
import { __resetConfigFileCacheForTesting } from "../src/config.ts";

Deno.test("deploy command discovers .takosumi/manifest.yml when no path is passed", async () => {
  const dir = await Deno.makeTempDir();
  const previousCwd = Deno.cwd();
  const previousEnv = snapshotEnv([
    "TAKOSUMI_CONFIG_FILE",
    "TAKOSUMI_REMOTE_URL",
    "TAKOSUMI_KERNEL_URL",
    "TAKOSUMI_DEPLOY_TOKEN",
    "TAKOSUMI_TOKEN",
  ]);
  const originalLog = console.log;
  const output: string[] = [];
  try {
    await Deno.mkdir(`${dir}/.takosumi`);
    await Deno.writeTextFile(
      `${dir}/.takosumi/manifest.yml`,
      `apiVersion: "1.0"
kind: Manifest
metadata:
  name: project-layout
resources:
  - shape: object-store@v1
    name: assets
    provider: "@takos/selfhost-filesystem"
    spec: { name: assets }
`,
    );
    for (const key of Object.keys(previousEnv)) Deno.env.delete(key);
    Deno.env.set("TAKOSUMI_CONFIG_FILE", `${dir}/missing-config.yml`);
    __resetConfigFileCacheForTesting();
    Deno.chdir(dir);
    console.log = (...parts: unknown[]) => {
      output.push(parts.map((part) => String(part)).join(" "));
    };

    await deployCommand.parse([]);

    const dump = output.join("\n");
    assert.match(dump, /\.takosumi\/manifest\.yml/);
    assert.match(dump, /local mode: applying 1 resource/);
    assert.match(dump, /assets \(@takos\/selfhost-filesystem\)/);
  } finally {
    console.log = originalLog;
    Deno.chdir(previousCwd);
    restoreEnv(previousEnv);
    __resetConfigFileCacheForTesting();
    await Deno.remove(dir, { recursive: true });
  }
});

function snapshotEnv(
  keys: readonly string[],
): Record<string, string | undefined> {
  return Object.fromEntries(keys.map((key) => [key, Deno.env.get(key)]));
}

function restoreEnv(
  values: Readonly<Record<string, string | undefined>>,
): void {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) Deno.env.delete(key);
    else Deno.env.set(key, value);
  }
}
