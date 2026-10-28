import { expect, test } from "bun:test";
import { resolve } from "node:path";

// Deliberately warm the parent's default (server) module cache, as the other
// reactive fixtures do. A late solid-js mock cannot repair that cached import.
import "../../../../../dashboard/src/views/new/install-attempt.ts";

const fixture = resolve(import.meta.dir, "../../../fixtures/install-attempt-controller.ts");

test("the install attempt controller follows the coordinator without extra requests", async () => {
  // Solid's reactive browser build runs the controller's effects. The child has
  // its own module cache and never mocks the parent's runtime.
  const child = Bun.spawn(
    [process.execPath, "test", "--conditions=browser", fixture],
    {
      stdout: "pipe",
      stderr: "pipe",
      timeout: 60_000,
      killSignal: "SIGKILL",
    },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect({ exitCode, stdout, stderr }).toMatchObject({ exitCode: 0 });
  expect(stderr).toContain("8 pass");
  expect(stderr).toContain("0 fail");
}, 90_000);
