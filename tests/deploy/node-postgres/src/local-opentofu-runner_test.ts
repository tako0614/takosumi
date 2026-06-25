import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createLocalOpenTofuRunner,
  type SourceArchiveStore,
} from "../../../../deploy/node-postgres/src/local-opentofu-runner.ts";

test("local OpenTofu runner executes generic release commands in restored source", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "takosumi-local-runner-"));
  try {
    const sourceDir = join(tempDir, "source");
    const archivePath = join(tempDir, "source.tar.zst");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, "marker.txt"), "plain source\n");
    createArchive(sourceDir, archivePath);
    const archiveBytes = new Uint8Array(await readFile(archivePath));
    const archiveDigest = `sha256:${createHash("sha256")
      .update(archiveBytes)
      .digest("hex")}`;
    const archiveStore: SourceArchiveStore = {
      write: async () => {
        throw new Error("write should not be called");
      },
      read: async () => archiveBytes,
    };
    const runner = createLocalOpenTofuRunner({ archiveStore });

    const result = await runner.release!({
      runId: "release_apply_1",
      applyRunId: "apply_1",
      installationId: "inst_1",
      deploymentId: "dep_1",
      sourceSnapshot: {
        id: "snap_1",
        archiveObjectKey: "sources/snap_1/source.tar.zst",
        archiveDigest,
      } as never,
      nonSensitiveOutputs: {
        public_url: "https://app.example.test",
      },
      commands: [
        {
          id: "activate",
          phase: "post_apply",
          executor: "runner",
          command: [
            process.execPath,
            "-e",
            [
              "const outputs = JSON.parse(Bun.env.TAKOSUMI_OUTPUTS_JSON)",
              "console.log(`${Bun.env.TAKOSUMI_APPLY_RUN_ID}:${outputs.public_url}`)",
            ].join(";"),
          ],
          workingDirectory: ".",
        },
      ],
    });

    expect(result.status).toBe("succeeded");
    expect(result.runId).toBe("release_apply_1");
    expect(result.commandCount).toBe(1);
    expect(result.stdout).toContain("apply_1:https://app.example.test");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

function createArchive(sourceDir: string, archivePath: string): void {
  const result = spawnSync(
    "tar",
    ["--zstd", "-cf", archivePath, "-C", sourceDir, "."],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(`tar archive failed: ${result.stderr}`);
  }
}
