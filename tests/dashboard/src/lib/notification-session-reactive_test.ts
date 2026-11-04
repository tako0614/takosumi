import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("browser navigation effects cannot restart notifications during sign-out", async () => {
  const fixture = resolve(import.meta.dir, "../../fixtures/notification-session-reactive.ts");
  const child = Bun.spawn([process.execPath, "test", "--conditions=browser", fixture], {
    stdout: "pipe", stderr: "pipe", timeout: 10_000, killSignal: "SIGKILL",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  expect({ exitCode, stdout, stderr }).toMatchObject({ exitCode: 0 });
  expect(stderr).toContain("2 pass");
  expect(stderr).toContain("0 fail");
}, 15_000);
