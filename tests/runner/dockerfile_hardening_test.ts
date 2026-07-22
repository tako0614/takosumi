import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "bun:test";

const dockerfile = resolve(import.meta.dir, "../../runner/Dockerfile");

test("reference runner executes provider and module code as the unprivileged Bun user", async () => {
  const text = await readFile(dockerfile, "utf8");
  const userMatches = [...text.matchAll(/^USER\s+(\S+)\s*$/gmu)];
  const entrypointIndex = text.lastIndexOf("ENTRYPOINT");

  expect(userMatches.length).toBeGreaterThan(0);
  expect(userMatches.at(-1)?.[1]).toBe("bun");
  expect(userMatches.at(-1)?.index ?? -1).toBeLessThan(entrypointIndex);
  expect(text.slice(userMatches.at(-1)?.index ?? 0)).not.toMatch(
    /^USER\s+(?:root|0)(?::0)?\s*$/mu,
  );
  for (const path of [
    "/tmp/takosumi-runs",
    "/tmp/takosumi-provider-cache",
    "/tmp/takosumi-source-build-cache",
  ]) {
    expect(text).toContain(path);
  }
});
