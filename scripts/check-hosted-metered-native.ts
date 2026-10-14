#!/usr/bin/env bun
import { randomUUID } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--image") {
  throw new Error("usage: bun scripts/check-hosted-metered-native.ts --image LOCAL_IMMUTABLE_IMAGE");
}
const image = args[1];
if (!/^[a-z0-9./_-]+@sha256:[a-f0-9]{64}$/.test(image)) {
  throw new Error("native gate needs an immutable image already in the local cache");
}
if (process.platform !== "linux" || process.arch !== "x64" || process.getuid?.() !== 0) {
  throw new Error("native gate unavailable: dedicated Linux x64 Docker host root is required");
}

function command(arguments_: readonly string[]): string {
  const child = Bun.spawnSync([...arguments_], {
    cwd: root,
    env: process.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (child.exitCode !== 0) {
    throw new Error(`${arguments_[0]} failed (${child.exitCode}): ${child.stderr.toString().trim()}`);
  }
  return child.stdout.toString().trim();
}

const inspected = JSON.parse(command(["docker", "image", "inspect", image])) as Array<{
  Id: string;
  Architecture: string;
  Os: string;
}>;
if (inspected.length !== 1 || inspected[0].Architecture !== "amd64" || inspected[0].Os !== "linux") {
  throw new Error("cached image is not one Linux amd64 runtime");
}
const privateDirectory = await mkdtemp(join(tmpdir(), "takosumi-metered-native-"));
await chmod(privateDirectory, 0o700);
const directory = join(privateDirectory, "fixture");
await mkdir(directory, { mode: 0o755 });
await chmod(directory, 0o755);
let containerId: string | undefined;
let attached: Bun.Subprocess<"pipe", "pipe", "pipe"> | undefined;
let ownedCgroup: string | undefined;
let completedReport: Record<string, unknown> | undefined;
try {
  const flags = ["-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", "-Wconversion", "-Wshadow", "-fstack-protector-strong"];
  command(["cc", ...flags, "-static", "-o", join(directory, "hosted-metered-launcher"), "runner/native/hosted-metered-launcher.c"]);
  command(["cc", ...flags, "-static", "-pthread", "-o", join(directory, "hosted-metered-fixture"), "tests/native/hosted-metered-fixture.c", "runner/native/hosted-metered-supervisor.c"]);
  command(["cc", ...flags, "-fPIC", "-shared", "-Wl,-z,relro,-z,now", "-o", join(directory, "libhosted-metered-supervisor.so"), "runner/native/hosted-metered-supervisor.c"]);
  command(["cc", ...flags, "-static", "-o", join(directory, "hosted-metered-guards"), "tests/native/hosted-metered-guards.c"]);
  await chmod(join(directory, "hosted-metered-launcher"), 0o755);
  await chmod(join(directory, "hosted-metered-fixture"), 0o755);
  await chmod(join(directory, "libhosted-metered-supervisor.so"), 0o644);
  const faultGuards = JSON.parse(command([join(directory, "hosted-metered-guards")])) as Record<string, unknown>;
  if (faultGuards.type !== "syscall-fault-unit-guards" || faultGuards.ok !== true ||
    faultGuards.kernelCounterQualification !== false || faultGuards.cases !== 12) {
    throw new Error("native syscall fault guards did not complete");
  }
  await copyFile(join(root, "tests/native/hosted-metered-bun.ts"), join(directory, "hosted-metered-bun.ts"));
  await chmod(join(directory, "hosted-metered-bun.ts"), 0o644);
  command([join(directory, "hosted-metered-fixture"), "require-unavailable"]);
  containerId = command([
    "docker", "create", "--pull=never", "--interactive",
    "--name", `takosumi-metered-native-${randomUUID()}`,
    "--network=none", "--cgroupns=private", "--user=0:0", "--read-only",
    "--cpus=0.5", "--memory=128m", "--memory-swap=128m", "--pids-limit=48",
    "--ulimit", "cpu=20:20", "--ulimit", "nofile=128:128", "--ulimit", "core=0:0",
    "--cap-drop=ALL", "--cap-add=SETUID", "--cap-add=SETGID", "--cap-add=SETPCAP", "--cap-add=KILL",
    "--security-opt=no-new-privileges:true",
    "--tmpfs", "/run:rw,nosuid,nodev,noexec,size=8m",
    "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,size=16m",
    "--mount", `type=bind,src=${directory},dst=/proof,readonly`,
    "--entrypoint", "/proof/hosted-metered-fixture", image,
  ]);
  if (!/^[a-f0-9]{64}$/.test(containerId)) {
    throw new Error("Docker did not return one exact owned container ID");
  }
  attached = Bun.spawn(["docker", "start", "--attach", "--interactive", containerId], {
    cwd: root,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderrPromise = new Response(attached.stderr).text();
  const reader = attached.stdout.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  const records: Array<Record<string, unknown>> = [];
  const timer = setTimeout(() => attached?.kill("SIGKILL"), 45_000);
  try {
    let verified = false;
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffered += decoder.decode(chunk.value, { stream: true });
      for (;;) {
        const newline = buffered.indexOf("\n");
        if (newline < 0) break;
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        if (!line.trim()) continue;
        const record = JSON.parse(line) as Record<string, unknown>;
        records.push(record);
        if (record.type === "ready") {
          if (verified) throw new Error("duplicate native readiness");
          const container = JSON.parse(command(["docker", "inspect", containerId])) as Array<{
            Id: string;
            State: { Pid: number; Running: boolean };
          }>;
          if (container.length !== 1 || container[0].Id !== containerId || !container[0].State.Running) {
            throw new Error("owned Container is not the expected live scope");
          }
          const pid = container[0].State.Pid;
          const membership = await readFile(`/proc/${pid}/cgroup`, "utf8");
          const match = /^0::(\/[^\n]+)\n$/.exec(membership);
          if (!match || !match[1].includes(containerId)) {
            throw new Error("owned Container cgroup does not carry its full exact ID");
          }
          const cgroup = await realpath(join("/sys/fs/cgroup", match[1]));
          if (!cgroup.startsWith("/sys/fs/cgroup/") || !cgroup.includes(containerId)) {
            throw new Error("resolved cgroup escaped the exact owned Container");
          }
          ownedCgroup = cgroup;
          const counter = await stat(join(cgroup, "cpu.stat"), { bigint: true });
          if (counter.dev !== BigInt(String(record.counterDevice)) || counter.ino !== BigInt(String(record.counterInode))) {
            throw new Error("Container counter identity differs from its exact host cgroup");
          }
          verified = true;
          attached.stdin.write("G");
          attached.stdin.flush();
        }
      }
    }
    const exitCode = await attached.exited;
    const stderr = await stderrPromise;
    const cases = records.filter((record) => record.type === "case");
    const security = records.filter((record) => record.type === "postexec-security");
    const protectedBun = records.filter((record) => record.type === "bun-child-protected");
    const summary = records.find((record) => record.type === "summary");
    if (!verified || exitCode !== 0 || cases.length !== 10 || cases.some((record) => record.ok !== true) ||
      security.length !== 2 || security.some((record) => record.ok !== true || record.allCapabilitiesZero !== true || record.inheritedFDCount !== 0) ||
      security.filter((record) => record.protectedBunParent === true).length !== 1 ||
      protectedBun.length !== 1 || protectedBun[0].ok !== true || protectedBun[0].uid !== 65534 || protectedBun[0].dumpableAfterExec !== 0 ||
      summary?.failures !== 0 || summary.allOwnedChildrenDrained !== true || summary.closedSampleRejected !== true) {
      throw new Error(`native gate failed or unavailable (exit ${exitCode}): ${JSON.stringify(records)} ${stderr.trim()}`);
    }
    completedReport = {
      kind: "takosumi.hosted-metered-local-native-proof@v1",
      status: "LOCAL_NATIVE_PASS",
      qualification: "source-bound-cached-runtime-unbuilt-image",
      image,
      localImageId: inspected[0].Id,
      newImageBuilt: false,
      actualCloudflarePolicyQualified: false,
      providerCalls: 0,
      faultGuards,
      security,
      protectedBun,
      cases,
      summary,
    };
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
} finally {
  if (attached && attached.exitCode === null) {
    attached.kill("SIGKILL");
    await attached.exited;
  }
  try {
    if (containerId && /^[a-f0-9]{64}$/.test(containerId)) {
      command(["docker", "rm", "--force", containerId]);
    }
    if (ownedCgroup) {
      try {
        await stat(ownedCgroup);
        throw new Error("exact owned Container cgroup remains after removal");
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
          throw error;
        }
      }
    }
  } finally {
    await rm(privateDirectory, { recursive: true, force: true });
  }
}
if (!completedReport) throw new Error("native gate did not produce a completed report");
console.log(JSON.stringify({
  ...completedReport,
  cleanup: { ownedContainerRemoved: true, exactOwnedCgroupRemoved: true, privateFixtureRemoved: true },
}, null, 2));
