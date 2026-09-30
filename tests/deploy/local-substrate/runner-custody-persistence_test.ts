import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parse } from "yaml";

test("local HTTP runner keeps its entire run root on a named volume", async () => {
  const composePath = resolve(
    import.meta.dir,
    "../../../deploy/local-substrate/compose.substrate.yml",
  );
  const compose = parse(await readFile(composePath, "utf8")) as {
    services?: Record<
      string,
      { environment?: Record<string, string>; volumes?: string[] }
    >;
    volumes?: Record<string, unknown>;
  };
  const runner = compose.services?.["opentofu-runner"];
  expect(runner?.environment?.TAKOSUMI_RUNNER_MUTATION_CUSTODY_MODE).toBe(
    "local-http",
  );
  const runRoot = runner?.environment?.TAKOSUMI_OPENTOFU_RUN_ROOT;
  expect(runRoot).toBe("/tmp/takosumi-runs");
  const mounts = (runner?.volumes ?? []).filter(
    (mount) => mount.split(":")[1] === runRoot,
  );
  expect(mounts).toEqual(["substrate-opentofu-runner-runs:/tmp/takosumi-runs"]);
  expect(compose.volumes).toHaveProperty("substrate-opentofu-runner-runs");
  for (const [name, service] of Object.entries(compose.services ?? {})) {
    if (name === "opentofu-runner") continue;
    expect(
      (service.volumes ?? []).some(
        (mount) => mount.split(":")[0] === "substrate-opentofu-runner-runs",
      ),
    ).toBe(false);
  }
});
