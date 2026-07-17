import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../../../cli/src/main.ts";
import { INSTALL_CONFIG_PATCH_V1_KIND } from "takosumi-contract/install-configs";

test("InstallConfig CLI sends the exact selected patch file to the exact target id", async () => {
  const directory = await mkdtemp(join(tmpdir(), "takosumi-install-config-"));
  const file = join(directory, "install-config-patch.json");
  const patch = {
    kind: INSTALL_CONFIG_PATCH_V1_KIND,
    variableMapping: { target: "cloudflare" },
  };
  await writeFile(file, JSON.stringify(patch));
  const originalFetch = globalThis.fetch;
  let captured: Request | undefined;
  let capturedBody = "";
  globalThis.fetch = (async (input, init) => {
    captured = new Request(input, init);
    capturedBody = await captured.clone().text();
    return Response.json({
      installConfig: {
        id: "cfg_takos_production",
        name: "takos-production",
        variableMapping: patch.variableMapping,
        outputAllowlist: {},
        policy: {},
        createdAt: "2026-07-17T00:00:00.000Z",
        updatedAt: "2026-07-17T00:01:00.000Z",
      },
    });
  }) as typeof fetch;
  const stdout: string[] = [];
  const stderr: string[] = [];
  try {
    expect(
      await main(
        [
          "install-configs",
          "patch",
          "cfg_takos_production",
          "--file",
          file,
          "--url",
          "https://takosumi.example.test",
          "--token",
          "operator-bearer",
        ],
        {
          stdout: (line) => stdout.push(line),
          stderr: (line) => stderr.push(line),
        },
      ),
    ).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout).toEqual([
      "InstallConfig cfg_takos_production patched at 2026-07-17T00:01:00.000Z",
    ]);
    expect(captured?.method).toBe("PATCH");
    expect(new URL(captured!.url).pathname).toBe(
      "/internal/v1/install-configs/cfg_takos_production",
    );
    expect(captured?.headers.get("authorization")).toBe(
      "Bearer operator-bearer",
    );
    expect(JSON.parse(capturedBody)).toEqual(patch);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
});

test("InstallConfig CLI rejects unsupported patch files without a request", async () => {
  const directory = await mkdtemp(join(tmpdir(), "takosumi-install-config-"));
  const file = join(directory, "install-config-patch.json");
  await writeFile(file, JSON.stringify({ kind: "other@v1", value: true }));
  let requested = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    requested = true;
    throw new Error("unexpected request");
  }) as typeof fetch;
  const stderr: string[] = [];
  try {
    expect(
      await main(["install-configs", "patch", "cfg_test", "--file", file], {
        stdout: () => {},
        stderr: (line) => stderr.push(line),
      }),
    ).toBe(2);
    expect(requested).toBe(false);
    expect(stderr.join("\n")).toContain(INSTALL_CONFIG_PATCH_V1_KIND);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
});
