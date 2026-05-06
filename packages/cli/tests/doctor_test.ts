import assert from "node:assert/strict";
import { runDoctor } from "../src/commands/doctor.ts";
import { __resetConfigFileCacheForTesting } from "../src/config.ts";

Deno.test("doctor reports the explicit manifest path and local target", async () => {
  const dir = await makeProject();
  const env = snapshotEnv();
  try {
    clearEnv();
    Deno.env.set("TAKOSUMI_CONFIG_FILE", `${dir}/missing-config.yml`);
    __resetConfigFileCacheForTesting();

    const report = await runDoctor({
      cwd: dir,
      manifest: `${dir}/manifest.yml`,
    });

    assert.equal(report.ok, true);
    const text = report.lines.join("\n");
    assert.match(text, /manifest: manifest\.yml \(yaml\)/);
    assert.match(text, /resources: 1 resolved resource/);
    assert.match(text, /deployment: doctor-app/);
    assert.match(text, /mode: local/);
    assert.match(text, /next: takosumi deploy manifest\.yml/);
  } finally {
    restoreEnv(env);
    __resetConfigFileCacheForTesting();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("doctor warns when remote target has no token", async () => {
  const dir = await makeProject();
  const env = snapshotEnv();
  try {
    clearEnv();
    Deno.env.set("TAKOSUMI_CONFIG_FILE", `${dir}/missing-config.yml`);
    __resetConfigFileCacheForTesting();

    const report = await runDoctor({
      cwd: dir,
      manifest: `${dir}/manifest.yml`,
      remote: "https://kernel.example.com",
    });

    assert.equal(report.ok, true);
    const text = report.lines.join("\n");
    assert.match(text, /mode: remote \(https:\/\/kernel\.example\.com\)/);
    assert.match(text, /token: not configured/);
  } finally {
    restoreEnv(env);
    __resetConfigFileCacheForTesting();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("doctor fails clearly when manifest path is omitted", async () => {
  const dir = await Deno.makeTempDir();
  const env = snapshotEnv();
  try {
    clearEnv();
    Deno.env.set("TAKOSUMI_CONFIG_FILE", `${dir}/missing-config.yml`);
    __resetConfigFileCacheForTesting();

    const report = await runDoctor({ cwd: dir });

    assert.equal(report.ok, false);
    const text = report.lines.join("\n");
    assert.match(text, /manifest path is required/);
    assert.match(text, /takosumi-git/);
    assert.match(text, /next: takosumi init <output>/);
  } finally {
    restoreEnv(env);
    __resetConfigFileCacheForTesting();
    await Deno.remove(dir, { recursive: true });
  }
});

async function makeProject(): Promise<string> {
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(
    `${dir}/manifest.yml`,
    `apiVersion: "1.0"
kind: Manifest
metadata:
  name: doctor-app
resources:
  - shape: object-store@v1
    name: assets
    provider: "@takos/selfhost-filesystem"
    spec: { name: assets }
`,
  );
  return dir;
}

function snapshotEnv(): Record<string, string | undefined> {
  return Object.fromEntries(ENV_KEYS.map((key) => [key, Deno.env.get(key)]));
}

function clearEnv(): void {
  for (const key of ENV_KEYS) Deno.env.delete(key);
}

function restoreEnv(
  values: Readonly<Record<string, string | undefined>>,
): void {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) Deno.env.delete(key);
    else Deno.env.set(key, value);
  }
}

const ENV_KEYS = [
  "TAKOSUMI_CONFIG_FILE",
  "TAKOSUMI_REMOTE_URL",
  "TAKOSUMI_KERNEL_URL",
  "TAKOSUMI_DEPLOY_TOKEN",
  "TAKOSUMI_TOKEN",
] as const;
