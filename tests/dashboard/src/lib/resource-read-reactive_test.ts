import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

// Deliberately warm the parent's default (server) module cache, as the sibling
// resource-read tests do. A late solid-js mock cannot repair that cached import.
import "../../../../dashboard/src/lib/resource-read.ts";

const fixture = resolve(
  import.meta.dir,
  "../../fixtures/resource-read-reactive.ts",
);

describe("createLastGoodValue", () => {
  for (const name of [
    "keeps the last good run of this id when a refetch fails",
    "never shows another id's value, loading or failed",
  ]) {
    test(name, async () => {
      // Select Solid's reactive browser build before any modules are loaded.
      // The child has its own module cache and never mocks the parent's runtime.
      const child = Bun.spawn(
        [
          process.execPath,
          "test",
          "--conditions=browser",
          "--test-name-pattern",
          name,
          fixture,
        ],
        {
          stdout: "pipe",
          stderr: "pipe",
          // Stop a hung child before the parent's default five-second timeout.
          timeout: 4_000,
          killSignal: "SIGKILL",
        },
      );
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect({ exitCode, stdout, stderr }).toMatchObject({ exitCode: 0 });
      // A successful exit with no selected test must not masquerade as coverage.
      expect(stderr).toContain("1 pass");
      expect(stderr).toContain("0 fail");
    });
  }
});
