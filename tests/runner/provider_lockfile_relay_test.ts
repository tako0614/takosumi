import { expect, test } from "bun:test";
import {
  lstat,
  link,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  handleProviderLockfileArtifactRequest,
  workspaceForRun,
} from "../../runner/lib/artifacts.ts";
import { DEFAULT_PROVIDER_LOCKFILE_ARTIFACT_MAX_BYTES } from "../../runner/lib/constants.ts";
import { runProviderLockfileFifoChild } from "./provider_lockfile_fifo_fixture.ts";

async function withWorkspace(
  run: (
    workspace: ReturnType<typeof workspaceForRun>,
    runId: string,
  ) => Promise<void>,
): Promise<void> {
  const runId = `provider-lockfile-relay-${crypto.randomUUID()}`;
  const workspace = workspaceForRun(runId);
  await mkdir(workspace.root, { recursive: true });
  try {
    await run(workspace, runId);
  } finally {
    await rm(workspace.root, { recursive: true, force: true });
  }
}

function relayRequest(runId: string): Request {
  return new Request(
    `http://runner.test/runs/${encodeURIComponent(runId)}/artifacts/tf-lockfile`,
    { method: "GET" },
  );
}

async function expectNotFoundWithoutSecret(
  runId: string,
  secret: string,
): Promise<void> {
  const response = await handleProviderLockfileArtifactRequest(
    runId,
    relayRequest(runId),
  );
  expect(response.status).toBe(404);
  expect(await response.text()).not.toContain(secret);
}

test("provider lockfile relay returns exact regular-file bytes, including empty", async () => {
  for (const bytes of [
    new TextEncoder().encode("# retained\r\n"),
    new Uint8Array(),
  ]) {
    await withWorkspace(async (workspace, runId) => {
      await writeFile(workspace.providerLockfilePath, bytes, { mode: 0o600 });

      const response = await handleProviderLockfileArtifactRequest(
        runId,
        relayRequest(runId),
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe(
        "application/vnd.opentofu.lock.hcl",
      );
      expect(response.headers.get("content-length")).toBe(
        String(bytes.byteLength),
      );
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
      expect((await lstat(workspace.providerLockfilePath)).nlink).toBe(1);
    });
  }
});

test("provider lockfile relay refuses symlink and hardlink paths without reading secret bytes", async () => {
  await withWorkspace(async (workspace, runId) => {
    const scratch = await mkdtemp(join(tmpdir(), "takosumi-lockfile-relay-"));
    const secret = "relay-secret-symlink-hardlink";
    const target = join(scratch, "secret-lockfile");
    try {
      await writeFile(target, secret);
      await symlink(target, workspace.providerLockfilePath);
      await expectNotFoundWithoutSecret(runId, secret);

      await rm(workspace.providerLockfilePath, { force: true });
      await link(target, workspace.providerLockfilePath);
      await expectNotFoundWithoutSecret(runId, secret);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
});

test("provider lockfile relay refuses FIFO promptly without reading secret bytes", async () => {
  await withWorkspace(async (workspace, runId) => {
    const fifo = workspace.providerLockfilePath;
    const makeFifo = Bun.spawn(
      ["mkfifo", fifo],
      { stdout: "ignore", stderr: "ignore" },
    );
    await makeFifo.exited;
    expect(makeFifo.exitCode).toBe(0);

    const child = await runProviderLockfileFifoChild({
      mode: "relay",
      root: workspace.root,
      runId,
      readyPath: join(workspace.root, "provider-lockfile-fifo.ready"),
    });
    expect(child.phase).toBe("completed");
    expect(child.exitCode).toBe(0);
    const output = child.stdout.trim().split(/\r?\n/u).at(-1);
    expect(output).toBeDefined();
    const response = JSON.parse(output ?? "null") as {
      readonly status: number;
      readonly body: string;
    };
    expect(response.status).toBe(404);
    expect(response.body).not.toContain("relay-secret-fifo");
  });
});

test("provider lockfile relay refuses oversized paths before returning secret bytes", async () => {
  await withWorkspace(async (workspace, runId) => {
    const secret = "relay-secret-oversized";
    const bytes = new Uint8Array(
      DEFAULT_PROVIDER_LOCKFILE_ARTIFACT_MAX_BYTES + secret.length + 1,
    );
    bytes.set(new TextEncoder().encode(secret));
    await writeFile(workspace.providerLockfilePath, bytes, { mode: 0o600 });
    await expectNotFoundWithoutSecret(runId, secret);
  });
});
