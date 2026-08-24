import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../..");

async function runBundleCheck(bundle: string): Promise<{
  readonly exitCode: number;
  readonly stderr: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), "takosumi-schema-bundle-"));
  const bundlePath = join(directory, "worker.mjs");
  try {
    await writeFile(bundlePath, bundle);
    const child = Bun.spawn(
      [process.execPath, "scripts/assert-worker-schema-bundle.ts", bundlePath],
      {
        cwd: ROOT,
        stdout: "ignore",
        stderr: "pipe",
      },
    );
    const [exitCode, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
    ]);
    return { exitCode, stderr };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("worker bundle check accepts a bundle without the retired Host schema runtime", async () => {
  await expect(
    runBundleCheck("OpenTofuRunnerObject InterfaceBinding"),
  ).resolves.toEqual({
    exitCode: 0,
    stderr: "",
  });
});

test("worker bundle check rejects the retired generated Host schema marker", async () => {
  const result = await runBundleCheck(
    "OpenTofuRunnerObject draft_2020_schema.generated.ts",
  );
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain(
    "retired Host schema marker draft_2020_schema.generated.ts",
  );
});

test("worker bundle check rejects the retired JSON Schema runtime marker", async () => {
  const result = await runBundleCheck(
    "OpenTofuRunnerObject @cfworker/json-schema",
  );
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain(
    "retired Host schema marker @cfworker/json-schema",
  );
});
