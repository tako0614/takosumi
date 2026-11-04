import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

// Command-protocol tests of the actual shell driver. Both Docker and curl are
// isolated stubs: these tests never create a container or contact a network.
const ownedId = "a".repeat(64);
const script = join(import.meta.dir, "../../scripts/prove-runner-docker.sh");
type Mode = "not-created" | "partial-start" | "unready" | "malformed-id" | "cleanup-failed" | "directory-cleanup-failed" | "success";

async function drive(mode: Mode) {
  const root = await mkdtemp(join(tmpdir(), "takosumi-proof-isolation-"));
  const bin = join(root, "bin");
  await mkdir(bin);
  const calls = join(root, "calls.jsonl");
  const wrapper = (body: string) => `#!/usr/bin/env bun\n${body}\n`;
  await writeFile(join(bin, "docker"), wrapper(`
import { appendFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + "\\n");
const mode = ${JSON.stringify(mode)};
if (args[0] === "image") { console.log("256"); process.exit(0); }
if (args[0] === "run") {
  if (mode === "not-created") process.exit(1);
  const index = args.indexOf("--cidfile");
  if (index >= 0) writeFileSync(args[index + 1], mode === "malformed-id" ? "unproven" : ${JSON.stringify(ownedId)});
  if (index >= 0 && mode === "directory-cleanup-failed") writeFileSync(args[index + 1] + ".note", "retain");
  if (mode === "partial-start") process.exit(1);
  console.log(${JSON.stringify(ownedId)}); process.exit(0);
}
if (args[0] === "port") console.log("127.0.0.1:42424");
if (args[0] === "exec" && args.includes("-i")) await Bun.stdin.text();
if (args[0] === "rm" && mode === "cleanup-failed") process.exit(1);
`));
  await writeFile(join(bin, "curl"), wrapper(`
const args = process.argv.slice(2);
const url = args.at(-1);
if (!url?.startsWith("http://127.0.0.1:42424/")) process.exit(1);
if (${JSON.stringify(mode)} === "unready") process.exit(1);
if (url.endsWith("/healthz")) { console.log(JSON.stringify({ ok: true, runner: "opentofu" })); process.exit(0); }
const values = { base_domain: "proof.example.com", public_origin: "https://proof.example.com", member_issuer: "https://proof.example.com/auth", service_registry_url: "https://proof.example.com/.well-known/takosumi-services.json" };
console.log(JSON.stringify({ status: "succeeded", exitCode: 0, planDigest: "sha256:" + "c".repeat(64), plannedOutputs: values, outputs: values }));
`));
  await writeFile(join(bin, "sleep"), "#!/bin/sh\nexit 0\n");
  for (const name of ["docker", "curl", "sleep"]) await chmod(join(bin, name), 0o700);
  try {
    const child = Bun.spawn(["bash", script], {
      env: {
        PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: root, TMPDIR: root, LANG: "C",
        TAKOSUMI_RUNNER_PROOF_SKIP_BUILD: "1", TAKOSUMI_RUNNER_PROOF_IMAGE: "synthetic-no-real-image",
      },
      stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    const commands: string[][] = (await readFile(calls, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    return { root, stdout, stderr, code, commands, close: () => rm(root, { recursive: true, force: true }) };
  } catch (error) { await rm(root, { recursive: true, force: true }); throw error; }
}

for (const mode of ["not-created", "partial-start", "unready", "malformed-id", "cleanup-failed", "directory-cleanup-failed", "success"] as const) {
  test(`native Runner proof preserves loopback and exact-container custody: ${mode}`, async () => {
    const f = await drive(mode);
    try {
      expect(f.code).toBe(mode === "success" ? 0 : 1);
      const launch = f.commands.find(args => args[0] === "run")!;
      expect(launch[launch.indexOf("-p") + 1]).toBe("127.0.0.1::8080");
      const cidfile = launch[launch.indexOf("--cidfile") + 1]!;
      expect(cidfile.startsWith(f.root + "/")).toBe(true);
      const removals = f.commands.filter(args => args[0] === "rm");
      if (mode === "not-created" || mode === "malformed-id") {
        expect(removals).toEqual([]);
        expect(f.commands.filter(args => ["port", "exec", "logs"].includes(args[0]!))).toEqual([]);
      } else {
        expect(removals).toEqual([["rm", "-f", ownedId]]);
        for (const args of f.commands.filter(args => ["port", "logs"].includes(args[0]!))) expect(args[1]).toBe(ownedId);
        for (const args of f.commands.filter(args => args[0] === "exec")) expect(args[args[1] === "-i" ? 2 : 1]).toBe(ownedId);
      }
      if (["not-created", "malformed-id", "cleanup-failed", "directory-cleanup-failed"].includes(mode)) {
        expect(f.stderr).toContain("custody retained");
        if (mode === "directory-cleanup-failed") expect(await readFile(cidfile + ".note", "utf8")).toBe("retain");
        else if (mode !== "not-created") expect(await readFile(cidfile, "utf8")).toBe(mode === "malformed-id" ? "unproven" : ownedId);
      } else {
        await expect(stat(dirname(cidfile))).rejects.toMatchObject({ code: "ENOENT" });
      }
      expect(f.stdout.includes("RESULT: PASS")).toBe(mode === "success");
    } finally { await f.close(); }
  }, 15_000);
}
