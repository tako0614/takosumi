/**
 * No HTTP listener and no collector key. Execute the native post-exec boundary
 * BEFORE importing any runner module. Provider children cannot read this
 * process's stdio through proc/ptrace; they receive their own pipes/devnull.
 */
import { openHostedMeteredNative } from "./lib/hosted_metered_native.ts";

const native = openHostedMeteredNative();
if (native.symbols.takosumi_meter_harden_child() !== 0) {
  process.stderr.write("metered child boundary unavailable\n");
  process.exit(1);
}

const {
  HOSTED_METERED_MAX_BODY_BYTES,
  HOSTED_METERED_MAX_REQUESTS,
  hostedMeteredExactKeys,
  parseHostedMeteredRequestFrame,
  readHostedMeteredFrames,
} = await import("./lib/hosted_metered_protocol.ts");
const { handleRunnerRequestWithDependencies } = await import("./lib/http_server.ts");
const { acquireRunRootOwnership, withRunRootWriter } = await import("./lib/run_root_ownership.ts");
const { RUN_ROOT } = await import("./lib/constants.ts");

// This is a separate cooperative workspace lock. The root collector's private
// lease remains held until this child and every adopted descendant drain.
const ownership = await acquireRunRootOwnership(RUN_ROOT);
const requests = new Map<string, AbortController>();
const seen = new Set<string>();
const inFlight = new Set<Promise<void>>();
let writeTail = Promise.resolve();
let failed = false;

function writeFrame(frame: unknown): Promise<void> {
  writeTail = writeTail.then(async () => {
    const bytes = new TextEncoder().encode(JSON.stringify(frame) + "\n");
    await Bun.write(Bun.stdout, bytes);
  });
  return writeTail;
}

await writeFrame({ kind: "ready", pid: process.pid });
try {
  for await (const raw of readHostedMeteredFrames(Bun.stdin.stream())) {
    if (native.symbols.takosumi_meter_child_protected() !== 0) throw new Error("metered child boundary lost");
    if (hostedMeteredExactKeys(raw, ["kind", "id"]) && raw.kind === "cancel" && typeof raw.id === "string") {
      const active = requests.get(raw.id);
      if (!active) throw new Error("metered cancellation has no original request");
      active.abort();
      continue;
    }
    if (hostedMeteredExactKeys(raw, ["kind"]) && raw.kind === "shutdown") {
      if (inFlight.size !== 0) throw new Error("metered shutdown before request cleanup");
      break;
    }
    const frame = parseHostedMeteredRequestFrame(raw);
    if (seen.has(frame.id) || seen.size >= HOSTED_METERED_MAX_REQUESTS || requests.size >= 16) {
      throw new Error("metered IPC request custody unavailable");
    }
    seen.add(frame.id);
    const controller = new AbortController();
    requests.set(frame.id, controller);
    const work = withRunRootWriter(ownership, async () => {
      const response = await handleRunnerRequestWithDependencies(new Request(
        "http://runner.invalid" + frame.path,
        {
          method: frame.method,
          headers: frame.headers as [string, string][],
          ...(frame.method !== "GET" && frame.method !== "HEAD"
            ? { body: Buffer.from(frame.body, "base64") } : {}),
          signal: controller.signal,
        },
      ), { mutationCustodyMode: "cloudflare-do" });
      const body = await response.arrayBuffer();
      if (body.byteLength > HOSTED_METERED_MAX_BODY_BYTES) throw new Error("metered response exceeds bound");
      await writeFrame({
        kind: "response", id: frame.id, status: response.status,
        headers: [...response.headers], body: Buffer.from(body).toString("base64"),
      });
    }).catch(() => {
      failed = true;
      // Do not expose raw provider/credential diagnostics in the root protocol.
      process.exitCode = 1;
      void writeFrame({ kind: "unavailable" });
    }).finally(() => {
      requests.delete(frame.id);
      inFlight.delete(work);
    });
    inFlight.add(work);
  }
  for (const controller of requests.values()) controller.abort();
  await Promise.all(inFlight);
  await writeTail;
  if (failed) throw new Error("metered child operation unavailable");
  await ownership.close();
} catch {
  // Failure never creates a synthetic successful response. The collector sees
  // a missing response/abnormal exit and retains pending measurement custody.
  process.stderr.write("metered child custody unavailable\n");
  process.exitCode = 1;
}
