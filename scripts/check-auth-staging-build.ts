import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const directory = await mkdtemp(join(tmpdir(), "takosumi-auth-stage-build-"));
try {
  for (const entry of ["entry-worker.ts", "staging-bootstrap.ts"]) {
    const result = await Bun.build({ entrypoints: [join(root, "deploy/accounts-cloudflare/src", entry)], target: "browser", format: "esm", external: ["cloudflare:workers"] });
    if (!result.success || result.outputs.length !== 1) throw new Error(`auth staging build failed: ${entry}`);
    const bytes = new Uint8Array(await result.outputs[0]!.arrayBuffer());
    const path = join(directory, `${entry}.mjs`);
    await writeFile(path, bytes);
    const check = Bun.spawn([process.execPath, join(root, "scripts/assert-worker-schema-bundle.ts"), path], { cwd: root, stdin: "ignore", stdout: "inherit", stderr: "inherit" });
    if (await check.exited !== 0) throw new Error(`auth staging schema bundle check failed: ${entry}`);
  }
} finally { await rm(directory, { recursive: true, force: true }); }
