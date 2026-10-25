import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSourceBuild } from "../../../runner/lib/source_build.ts";
import { prepareRuntimeSecretFiles } from "../../../runner/lib/runtime_secrets.ts";
import type { RunWorkspace } from "../../../runner/lib/types.ts";

const root = await mkdtemp(join(tmpdir(), "takosumi-supervisor-death-"));
let escapedPid: number | undefined;
try {
  const buildError = await runSourceBuild(
    {
      commands: [{ argv: [process.execPath, "-e", `
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], {
  detached: true,
  stdio: "ignore",
});
child.unref();
writeFileSync("escaped.pid", String(child.pid));
process.kill(process.ppid, "SIGKILL");
`] }],
      outputs: ["escaped.pid"],
    },
    root,
  ).catch((error) => error);
  escapedPid = Number(await readFile(join(root, "escaped.pid"), "utf8"));
  const workspace = { root: join(root, "next-run") } as RunWorkspace;
  const nextSecret = await prepareRuntimeSecretFiles(
    { env: {} },
    workspace,
    {
      contract: "takosumi.runner-runtime-secret-files/v1",
      profileDigest: `sha256:${"a".repeat(64)}`,
      files: [{
        path: "synthetic.json",
        mode: 0o600,
        content: JSON.stringify({ SYNTHETIC: "synthetic-next-run-secret" }),
        envName: "TAKOS_RUNTIME_SECRETS_FILE",
        secretNames: ["SYNTHETIC"],
      }],
    },
  ).then(async (prepared) => {
    await prepared.cleanup();
    return "created";
  }).catch((error) => error instanceof Error ? error.message : String(error));
  console.log(JSON.stringify({
    buildRejected: buildError instanceof Error,
    escapedPid,
    nextSecret,
  }));
} finally {
  if (escapedPid !== undefined && Number.isSafeInteger(escapedPid)) {
    try {
      process.kill(escapedPid, "SIGKILL");
    } catch {
      // Exact child is already gone.
    }
  }
  await rm(root, { recursive: true, force: true });
}
