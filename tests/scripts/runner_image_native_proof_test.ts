import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

import {
  proveRunnerImageHardenedNative,
  RUNNER_BOOT_SMOKE_MARKER,
  RUNNER_BOOT_SMOKE_PLAN_MAX_BYTES,
  type RunnerImageNativeCommand,
} from "../../scripts/lib/runner-image-native-proof.ts";

const identity = {
  localImageId: `sha256:${"a".repeat(64)}`,
  descriptorDigest: `sha256:${"b".repeat(64)}`,
  descriptorMediaType: "application/vnd.oci.image.manifest.v1+json" as const,
  platform: { os: "linux" as const, architecture: "amd64" as const },
};

const MAX_CHILD_OUTPUT_BYTES = 64 * 1024;
type CapturedChildOutput = { text: string; overflow: boolean };

async function captureChildOutput(
  stream: ReadableStream<Uint8Array>,
  onOverflow: () => void,
  abort?: AbortSignal,
): Promise<CapturedChildOutput> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const cancelOnAbort = () => { void reader.cancel().catch(() => {}); };
  abort?.addEventListener("abort", cancelOnAbort, { once: true });
  let text = "";
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return { text: text + decoder.decode(), overflow: false };
      const accepted = value.subarray(0, Math.max(0, MAX_CHILD_OUTPUT_BYTES - size));
      text += decoder.decode(accepted, { stream: true });
      size += accepted.byteLength;
      if (accepted.byteLength !== value.byteLength) {
        onOverflow();
        await reader.cancel();
        return { text: text + decoder.decode(), overflow: true };
      }
    }
  } finally {
    abort?.removeEventListener("abort", cancelOnAbort);
    reader.releaseLock();
  }
}

function assertIsolatedChildResult(
  exitCode: number,
  timedOut: boolean,
  stdout: CapturedChildOutput,
  stderr: CapturedChildOutput,
): void {
  expect(timedOut, `isolated native proof timed out: ${stderr.text.slice(0, 4_096)}`).toBeFalse();
  expect(stdout.overflow || stderr.overflow, "isolated native proof output exceeded 64 KiB per stream").toBeFalse();
  expect(exitCode, `isolated native proof failed: ${stderr.text.slice(0, 4_096)}`).toBe(0);
}

test("isolated native proof diagnostics stop at the output cap", async () => {
  let overflowCalls = 0;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("x".repeat(MAX_CHILD_OUTPUT_BYTES)));
      controller.enqueue(new TextEncoder().encode(RUNNER_BOOT_SMOKE_MARKER));
      controller.close();
    },
  });
  const captured = await captureChildOutput(stream, () => overflowCalls++);
  expect(captured.overflow).toBeTrue();
  expect(overflowCalls).toBe(1);
  expect(Buffer.byteLength(captured.text)).toBe(MAX_CHILD_OUTPUT_BYTES);
  expect(captured.text).not.toContain(RUNNER_BOOT_SMOKE_MARKER);
  expect(() => assertIsolatedChildResult(0, false, captured, { text: "", overflow: false })).toThrow();
});

test("the generated hardened smoke executes a real provider-free Plan and checks saved metadata on its exact artifact", async () => {
  if (Bun.env.TAKOSUMI_NATIVE_PROOF_TEST_CHILD !== "1") {
    const root = mkdtempSync(join(tmpdir(), "tksm-native-proof-"));
    try {
      const child = Bun.spawn([
        process.execPath, "test", "--isolate", "--only-failures", fileURLToPath(import.meta.url),
      ], {
        detached: process.platform !== "win32",
        env: {
          ...process.env,
          TAKOSUMI_NATIVE_PROOF_TEST_CHILD: "1",
          TAKOSUMI_OPENTOFU_RUN_ROOT: root,
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      let timedOut = false;
      const outputAbort = new AbortController();
      const stopOwnedChild = () => {
        // A live detached child owns this group; never signal a reused ID after it exits.
        if (child.exitCode !== null) return;
        if (process.platform !== "win32" && child.pid > 0) {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") child.kill("SIGKILL");
          }
        } else {
          child.kill("SIGKILL");
        }
      };
      const deadline = setTimeout(() => {
        timedOut = true;
        stopOwnedChild();
        outputAbort.abort();
      }, 45_000);
      try {
        const [exitCode, stdout, stderr] = await Promise.all([
          child.exited,
          captureChildOutput(child.stdout, stopOwnedChild, outputAbort.signal),
          captureChildOutput(child.stderr, stopOwnedChild, outputAbort.signal),
        ]);
        assertIsolatedChildResult(exitCode, timedOut, stdout, stderr);
      } finally {
        clearTimeout(deadline);
        if (child.exitCode === null) {
          stopOwnedChild();
          await child.exited;
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
    return;
  }

  const root = Bun.env.TAKOSUMI_OPENTOFU_RUN_ROOT;
  if (!root) throw new Error("isolated native proof run root is required");
  const { handleRunnerRequestWithDependencies } = await import("../../runner/lib/http_server.ts");
  let planResult: Record<string, unknown> | undefined;
  let planBytes: Uint8Array | undefined;
  const handler = async (input: string | URL | Request, init?: RequestInit) =>
    handleRunnerRequestWithDependencies(new Request(input, init), { mutationCustodyMode: "cloudflare-do" });
  const capture = async (input: string | URL | Request, init?: RequestInit) => {
    const response = await handler(input, init);
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/artifacts/tfplan") && response.status === 200) {
      planBytes = new Uint8Array(await response.clone().arrayBuffer());
    }
    if (/^\/runs\/[^/]+$/.test(path) && init?.method === "POST" && response.status === 200) {
      planResult = await response.clone().json() as Record<string, unknown>;
    }
    return response;
  };
  const invoke = async (fetcher: typeof capture, token: string, shortTimer = false, noMarker = false) => {
    const commands: string[][] = [];
    const command: RunnerImageNativeCommand = async (executable, args) => {
      commands.push([executable, ...args]);
      if (executable === "docker" && args[0] === "exec") {
        const script = args[args.indexOf("-e") + 1]!;
        let output = "";
        let exitCode = -1;
        const fakeProcess = {
          getuid: () => 1000, // VM branch check only; Docker's user proof is separate.
          stdout: { write: (value: string) => { output += value; } },
          exit: (code: number) => { exitCode = code; },
        };
        const fakeBun = {
          env: { TAKOSUMI_OPENTOFU_RUN_ROOT: root },
          sleep: Bun.sleep,
          CryptoHasher: Bun.CryptoHasher,
          spawn: (argv: string[]) => {
            mkdirSync(argv.at(-1)!, { recursive: true });
            return { exited: Promise.resolve(0) };
          },
          write: async (path: string, value: string) => {
            await writeFile(path, value);
            return Buffer.byteLength(value);
          },
        };
        await runInNewContext(`(async()=>{${script}})()`, {
          process: fakeProcess,
          Bun: fakeBun,
          fetch: fetcher,
          AbortController,
          setTimeout: (callback: () => void, delay: number) =>
            setTimeout(callback, shortTimer && delay === 25_000 ? 5 : delay),
          clearTimeout,
          TextEncoder,
          Uint8Array,
          JSON,
        });
        if (noMarker) expect(output).not.toContain(RUNNER_BOOT_SMOKE_MARKER);
        return { exitCode, stdout: output.trim(), stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    let error: unknown;
    try {
      await proveRunnerImageHardenedNative(identity, token, command, root);
    } catch (caught) {
      error = caught;
    }
    expect(commands.at(-1)?.slice(0, 3)).toEqual(["docker", "rm", "--force"]);
    return error;
  };

  expect(await invoke(capture, "actual-plan")).toBeUndefined();
  expect(planResult?.planDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  expect(planBytes?.byteLength).toBeGreaterThan(0);
  expect(planBytes?.byteLength).toBeLessThanOrEqual(RUNNER_BOOT_SMOKE_PLAN_MAX_BYTES);
  const runId = "runner-release-proof-actual-plan";
  const planPath = join(root, runId, "tfplan");
  expect(existsSync(planPath)).toBeTrue();
  const replay = async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    if (path === `/runs/${runId}` && init?.method === "POST") return Response.json(planResult);
    if (path === `/runs/${runId}/artifacts/tfplan`) return new Response(planBytes, {
      headers: { "content-length": String(planBytes!.byteLength) },
    });
    return handler(input, init);
  };
  expect(await invoke(replay, "actual-plan")).toBeUndefined();
  const wrongDigest = async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    if (path === `/runs/${runId}` && init?.method === "POST") {
      const digest = `sha256:${"0".repeat(64)}`;
      return Response.json({ ...planResult, planDigest: digest,
        planArtifact: { ...(planResult!.planArtifact as object), digest } });
    }
    return replay(input, init);
  };
  expect(await invoke(wrongDigest, "actual-plan")).toBeInstanceOf(Error);
  const oversize = async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    if (path === `/runs/${runId}` && init?.method === "POST") {
      return Response.json({ ...planResult, planArtifact: {
        ...(planResult!.planArtifact as object), sizeBytes: RUNNER_BOOT_SMOKE_PLAN_MAX_BYTES + 1,
      } });
    }
    return replay(input, init);
  };
  expect(await invoke(oversize, "actual-plan")).toBeInstanceOf(Error);
  const badSize = async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    if (path === `/runs/${runId}` && init?.method === "POST") {
      return Response.json({ ...planResult, planArtifact: {
        ...(planResult!.planArtifact as object), sizeBytes: 0,
      } });
    }
    return replay(input, init);
  };
  expect(await invoke(badSize, "actual-plan")).toBeInstanceOf(Error);
  for (const [name, artifactResponse] of [
    ["missing-length", () => new Response(planBytes)],
    ["wrong-length", () => new Response(planBytes, { headers: { "content-length": String(planBytes!.byteLength + 1) } })],
    ["short-body", () => new Response(planBytes!.subarray(0, planBytes!.byteLength - 1), { headers: { "content-length": String(planBytes!.byteLength) } })],
    ["read-error", () => new Response(new ReadableStream({ pull(controller) { controller.error(new Error("private read failure")); } }), { headers: { "content-length": String(planBytes!.byteLength) } })],
  ] as const) {
    const fetcher = async (input: string | URL | Request, init?: RequestInit) =>
      new URL(String(input)).pathname === `/runs/${runId}/artifacts/tfplan`
        ? artifactResponse()
        : replay(input, init);
    expect(await invoke(fetcher, "actual-plan"), name).toBeInstanceOf(Error);
  }
  let overrunMetadataPosts = 0;
  const streamOverrun = async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/plan-state-metadata") && init?.method === "POST") overrunMetadataPosts++;
    if (path === `/runs/${runId}/artifacts/tfplan`) {
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(planBytes);
          controller.enqueue(new Uint8Array([0]));
          controller.close();
        },
      }), { headers: { "content-length": String(planBytes!.byteLength) } });
    }
    return replay(input, init);
  };
  expect(await invoke(streamOverrun, "actual-plan", false, true)).toBeInstanceOf(Error);
  expect(overrunMetadataPosts).toBe(0);
  const missingRoute = async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/plan-state-metadata")) return Response.json({ error: "not found" }, { status: 404 });
    return replay(input, init);
  };
  expect(await invoke(missingRoute, "actual-plan")).toBeInstanceOf(Error);
  const leakedRejection = async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/plan-state-metadata") &&
        init?.headers &&
        new Headers(init.headers).get("x-takosumi-plan-digest") !== planResult!.planDigest) {
      return Response.json({ error: "saved Plan metadata rejected", secret: "never-print-me" }, { status: 409 });
    }
    return replay(input, init);
  };
  const leakFailure = await invoke(leakedRejection, "actual-plan");
  expect(leakFailure).toBeInstanceOf(Error);
  expect(String(leakFailure)).not.toContain("never-print-me");
  const unavailableHealth = async () => { throw new Error("health unavailable"); };
  expect(await invoke(unavailableHealth as typeof capture, "timeout", true)).toBeInstanceOf(Error);
  expect(RUNNER_BOOT_SMOKE_MARKER).toBe("takosumi-runner-boot-ok");
}, 55_000);
