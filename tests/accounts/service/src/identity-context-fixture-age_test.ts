import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("an aged shared fixture module keeps both actual HTTP context workflows current", async () => {
  const directory = await mkdtemp(join(tmpdir(), "takosumi-identity-fixture-age-"));
  const preload = join(directory, "age.ts");
  const fixture = new URL("../fixtures/identity-context-fixture.ts", import.meta.url).href;
  const originalTests = fileURLToPath(new URL("control-identity-reconciler_test.ts", import.meta.url));
  let child: ReturnType<typeof spawn> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Import first, then model a long canonical suite before the HTTP tests.
    // Only this isolated child changes its clock; afterAll is its cleanup hook.
    await writeFile(preload, `import { afterAll } from "bun:test";
await import(${JSON.stringify(fixture)});
const originalNow = Date.now;
Date.now = () => originalNow() + 360_000;
afterAll(() => { Date.now = originalNow; });
`, { mode: 0o600 });
    child = spawn(process.execPath, [
      "test", "--preload", preload, originalTests,
      "--test-name-pattern", "^actual (HTTP identity workflow|verified GitHub HTTP callback)",
    ], { stdio: ["ignore", "pipe", "pipe"], env: process.env });
    let stdout = "", stderr = "";
    child.stdout!.setEncoding("utf8");
    child.stderr!.setEncoding("utf8");
    child.stdout!.on("data", data => { stdout += data; });
    child.stderr!.on("data", data => { stderr += data; });
    timer = setTimeout(() => child?.kill("SIGTERM"), 10_000);
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child!.once("error", reject);
      child!.once("close", resolve);
    });
    const output = stdout + stderr;
    expect(exitCode, output).toBe(0);
    expect(output).toContain("(pass) actual HTTP identity workflow");
    expect(output).toContain("(pass) actual verified GitHub HTTP callback");
    expect(output).toContain("2 pass");
    expect(output).toContain("0 fail");
  } finally {
    if (timer) clearTimeout(timer);
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await new Promise<void>(resolve => { child!.once("close", () => resolve()); });
    }
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);
