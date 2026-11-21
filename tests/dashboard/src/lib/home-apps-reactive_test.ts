import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("Home search reactive paging, legacy fallback, failure and stale-response guards", async () => {
  // Match production's Solid browser condition in a separate module cache.
  const child = Bun.spawn([process.execPath, "test", "--conditions=browser",
    resolve(import.meta.dir, "../../fixtures/home-apps-reactive.ts")], {
    stdout: "pipe", stderr: "pipe", timeout: 8_000, killSignal: "SIGKILL",
  });
  const [exitCode, stdout, stderr] = await Promise.all([child.exited,
    new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect({ exitCode, stdout, stderr }).toMatchObject({ exitCode: 0 });
  expect(stderr).toContain("9 pass");
  expect(stderr).toContain("0 fail");
}, 10_000);
