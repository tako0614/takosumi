/** Root PID1 collector. Never imports/evaluates tenant code or accepts a child
 * frame as admission, closure, signing, or callback authority. Cloudflare
 * admission is deliberately unavailable until the separate owner integration.
 */
import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, rename } from "node:fs/promises";
import {
  acquireRunRootOwnership, assertRunRootOwnershipFor, withRunRootWriter,
} from "./lib/run_root_ownership.ts";
import {
  openHostedMeteredNative, sampleHostedMeteredCpu,
} from "./lib/hosted_metered_native.ts";
import {
  HOSTED_METERED_PROFILE, HOSTED_METERED_MAX_BODY_BYTES,
  HOSTED_METERED_MAX_REQUESTS, HOSTED_METERED_CONTEXT_HEADER,
  HOSTED_METERED_NONCE_HEADER, HOSTED_METERED_SIGNATURE_HEADER,
  authenticateHostedMeteredRequest, hostedMeteredContext, hostedMeteredExactKeys,
  hostedMeteredSha256, importHostedMeteredKey, parseHostedMeteredLocalAdmission,
  parseHostedMeteredResponseFrame, readHostedMeteredFrames, signHostedMeteredReceipt,
} from "./lib/hosted_metered_protocol.ts";

const PRIVATE_ROOT = "/run/takosumi-metered";
const CONTROL_ROOT = PRIVATE_ROOT + "/control";
const LAUNCHER = "/app/runner/native/hosted-metered-launcher";
const CHILD = "/app/runner/hosted-metered-child.ts";
const RUN_ROOT = "/tmp/takosumi-metered-runs";
const CHILD_EXIT_TIMEOUT_MS = 5000;
const DRAIN_TIMEOUT_MS = 5000;

interface PendingRequest {
  readonly resolve: (response: Response) => void;
  readonly removeAbort: () => void;
}

async function readPrivateFile(name: string, max: number): Promise<Uint8Array> {
  const handle = await open(PRIVATE_ROOT + "/" + name,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.uid !== 0 || before.nlink !== 1 ||
      (before.mode & 0o777) !== 0o600 || before.size > max) throw new Error();
    const buffer = new Uint8Array(max + 1);
    const read = await handle.read(buffer, 0, buffer.length, 0);
    const after = await handle.stat();
    if (read.bytesRead > max || read.bytesRead !== before.size ||
      before.dev !== after.dev || before.ino !== after.ino ||
      before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error();
    return buffer.slice(0, read.bytesRead);
  } finally { await handle.close(); }
}

async function writePrivateRecord(name: string, value: unknown): Promise<void> {
  const temporary = CONTROL_ROOT + "/." + name + "-" + randomUUID();
  const handle = await open(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT |
    fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(JSON.stringify(value) + "\n");
    await handle.sync();
  } finally { await handle.close(); }
  await rename(temporary, CONTROL_ROOT + "/" + name);
  const directory = await open(CONTROL_ROOT, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY);
  try { await directory.sync(); } finally { await directory.close(); }
}

async function readBody(request: Request): Promise<Uint8Array> {
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^(0|[1-9][0-9]*)$/u.test(declared) ||
    Number(declared) > HOSTED_METERED_MAX_BODY_BYTES)) throw new Error();
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > HOSTED_METERED_MAX_BODY_BYTES) { await reader.cancel(); throw new Error(); }
    parts.push(next.value);
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.byteLength; }
  return result;
}

const unavailableResponse = () => Response.json({
  status: "pending", errorCode: "hosted_metered_measurement_unavailable",
  completeRunMeasurement: false,
}, { status: 503 });

async function start(): Promise<void> {
  const native = openHostedMeteredNative();
  if (native.symbols.takosumi_meter_init() !== 0) throw new Error();
  const privateRoot = await lstat(PRIVATE_ROOT);
  if (!privateRoot.isDirectory() || privateRoot.isSymbolicLink() || privateRoot.uid !== 0 ||
    (privateRoot.mode & 0o777) !== 0o700) throw new Error();
  const admission = parseHostedMeteredLocalAdmission(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(
    await readPrivateFile("admission.json", 4096),
  )));
  const keyBytes = await readPrivateFile("callback.key", 32);
  const key = await importHostedMeteredKey(keyBytes);
  keyBytes.fill(0);
  const context = hostedMeteredContext(admission, randomUUID());
  // Existing private control data means this boot/run was already admitted.
  // No restart/retry can turn an old unknown attempt into a new measurement.
  await mkdir(CONTROL_ROOT, { mode: 0o700 });
  const owner = await acquireRunRootOwnership(CONTROL_ROOT);
  let releaseHold!: () => void;
  const hold = withRunRootWriter(owner, () => new Promise<void>((resolve) => { releaseHold = resolve; }));
  // Fixed workload directories are initialized only AFTER the native launcher
  // drops privilege. Root never traverses a tenant tree or interprets a tenant
  // cwd while privileged. Existing paths must keep the exact private identity.
  const workloadDirectories = [RUN_ROOT, "/tmp/takosumi-provider-cache", "/tmp/takosumi-source-build-cache"];
  const prepareDirectories = Bun.spawn([LAUNCHER, "--", "/usr/bin/mkdir", "-p", "-m", "0700", "--", ...workloadDirectories], {
    cwd: "/app", stdin: "ignore", stdout: "ignore", stderr: "ignore",
    env: { PATH: "/usr/bin:/bin" },
  });
  if (await prepareDirectories.exited !== 0) throw new Error();
  for (const path of workloadDirectories) {
    const directory = await lstat(path);
    if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== 65534 || directory.gid !== 65534 ||
      (directory.mode & 0o777) !== 0o700) throw new Error();
  }
  const baseline = sampleHostedMeteredCpu(native);
  await writePrivateRecord("intent.json", {
    kind: "takosumi.hosted-metered-local-intent@v1", status: "pending",
    context, requestConsumed: false, completeRunMeasurement: false,
  });

  // Root executes only immutable native/Bun/bootstrap paths, never PATH, a
  // shell, a tenant cwd, an env-selected preload, or provider code.
  const child = Bun.spawn([LAUNCHER, "--", "/usr/local/bin/bun", "--no-env-file", CHILD], {
    cwd: "/app", stdin: "pipe", stdout: "pipe", stderr: "ignore",
    env: {
      PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/workspace", TMPDIR: "/tmp",
      TF_CLI_CONFIG_FILE: "/opt/opentofu/tofu.rc", TF_INPUT: "0", TF_IN_AUTOMATION: "1",
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0", TAKOSUMI_RUNNER_START_SERVER: "0",
      TAKOSUMI_RUNNER_MUTATION_CUSTODY_MODE: "cloudflare-do",
      TAKOSUMI_OPENTOFU_RUN_ROOT: RUN_ROOT,
      TAKOSUMI_OPENTOFU_PLUGIN_CACHE_DIR: "/tmp/takosumi-provider-cache",
      TAKOSUMI_SOURCE_BUILD_CACHE_DIR: "/tmp/takosumi-source-build-cache",
    },
  });
  let phase: "starting" | "ready" | "closing" | "closed" | "pending" = "starting";
  let childExited = false;
  let expectedExit = false;
  let requestConsumed = false;
  let preparingDispatch = false;
  let receipt: unknown;
  let closureCommitted = false;
  let closing: Promise<Response> | undefined;
  let writeTail = Promise.resolve();
  const nonces = new Set<string>();
  const pending = new Map<string, PendingRequest>();
  const isPending = () => phase === "pending";
  let ready!: () => void;
  let notReady!: () => void;
  const readiness = new Promise<boolean>((resolve) => {
    ready = () => resolve(true); notReady = () => resolve(false);
  });

  const fail = () => {
    // Once direct exit, ECHILD, pinned final sample, native close and lease
    // close all succeeded, signals/request-limit failures cannot invalidate
    // that proven raw CPU closure. Publication still must finish durably.
    if (phase === "closed" || closureCommitted) return;
    phase = "pending";
    notReady();
    for (const request of pending.values()) { request.removeAbort(); request.resolve(unavailableResponse()); }
    pending.clear();
    // The initial durable intent is already pending; this detail is optional.
    void writePrivateRecord("pending.json", {
      status: "pending", context, completeRunMeasurement: false,
    }).catch(() => {});
  };
  const writeFrame = (frame: unknown): Promise<void> => {
    writeTail = writeTail.then(async () => {
      const bytes = new TextEncoder().encode(JSON.stringify(frame) + "\n");
      child.stdin.write(bytes);
      await child.stdin.flush();
    });
    void writeTail.catch(fail);
    return writeTail;
  };
  const stream = (async () => {
    for await (const raw of readHostedMeteredFrames(child.stdout)) {
      if (phase === "starting") {
        if (!hostedMeteredExactKeys(raw, ["kind", "pid"]) || raw.kind !== "ready" || raw.pid !== child.pid) throw new Error();
        phase = "ready"; ready(); continue;
      }
      const frame = parseHostedMeteredResponseFrame(raw);
      const original = pending.get(frame.id);
      if (!original || (phase !== "ready" && phase !== "closing")) throw new Error();
      pending.delete(frame.id);
      original.removeAbort();
      original.resolve(new Response(Buffer.from(frame.body, "base64"), {
        status: frame.status, headers: frame.headers as [string, string][],
      }));
    }
    if (!expectedExit) throw new Error();
  })().catch(fail);
  void child.exited.then(() => {
    childExited = true;
    if (!expectedExit) fail();
  }, fail);
  if (!await Promise.race([readiness, Bun.sleep(5000).then(() => false)])) {
    fail(); native.symbols.takosumi_meter_kill_owned(); throw new Error();
  }

  async function close(): Promise<Response> {
    if (phase === "closed") return Response.json(receipt);
    if (phase !== "ready" || pending.size !== 0 || preparingDispatch || !requestConsumed) return unavailableResponse();
    phase = "closing";
    expectedExit = true;
    try {
      assertRunRootOwnershipFor(owner, CONTROL_ROOT);
      await writeFrame({ kind: "shutdown" });
      child.stdin.end();
      let exited = await Promise.race([child.exited.then(() => true), Bun.sleep(CHILD_EXIT_TIMEOUT_MS).then(() => false)]);
      if (!exited) {
        native.symbols.takosumi_meter_kill_owned();
        exited = await Promise.race([child.exited.then(() => true), Bun.sleep(CHILD_EXIT_TIMEOUT_MS).then(() => false)]);
        // A forced producer exit cannot become a successful measurement close.
        fail(); return unavailableResponse();
      }
      await stream;
      if (isPending() || !childExited || child.exitCode !== 0) throw new Error();
      const drainDeadline = performance.now() + DRAIN_TIMEOUT_MS;
      let drained = native.symbols.takosumi_meter_drain();
      if (drained === 1) native.symbols.takosumi_meter_kill_owned();
      while (drained === 1 && performance.now() < drainDeadline) {
        await Bun.sleep(10); drained = native.symbols.takosumi_meter_drain();
      }
      if (drained !== 0) throw new Error();
      assertRunRootOwnershipFor(owner, CONTROL_ROOT);
      const final = sampleHostedMeteredCpu(native);
      if (final.device !== baseline.device || final.inode !== baseline.inode || final.usageUsec < baseline.usageUsec) throw new Error();
      const payload = {
        kind: "takosumi.hosted-metered-cpu-close@v1", status: "closed",
        qualification: "local-native-only", profile: HOSTED_METERED_PROFILE, context,
        scope: "exclusive-collector-open-through-drained",
        kernel: {
          source: "cgroup-v2.cpu.stat/usage_usec", device: final.device.toString(), inode: final.inode.toString(),
          startUsageUsec: baseline.usageUsec.toString(), endUsageUsec: final.usageUsec.toString(),
          usageUsec: (final.usageUsec - baseline.usageUsec).toString(),
        },
        closure: { directChildExited: true, adoptedChildren: "ECHILD", runRootLeaseHeld: true },
        completeRunMeasurement: false,
      };
      const assertClosing = () => { if (phase !== "closing") throw new Error(); };
      assertClosing();
      if (native.symbols.takosumi_meter_close() !== 0) throw new Error();
      releaseHold(); await hold;
      assertClosing();
      await owner.close();
      assertClosing();
      // Monotonic commit point: all facts and owner/native finalization are
      // complete, no child can write, and this boot can never admit a successor.
      // A stop after here waits for publication instead of changing truth to
      // pending. Before here every stop/unknown leaves the original intent pending.
      closureCommitted = true;
      const signed = { ...payload, signature: await signHostedMeteredReceipt(key, payload) };
      // All native/drain/lease finalization that can invalidate closure has
      // completed BEFORE any signed closed record is made durable.
      await writePrivateRecord("outbox.json", signed);
      receipt = signed;
      phase = "closed";
      return Response.json(receipt);
    } catch {
      // Publication failure does not fabricate a reply. The original intent
      // remains pending; an incomplete/unknown publication is never replayed.
      if (closureCommitted) phase = "pending";
      else fail();
      return unavailableResponse();
    }
  }

  const server = Bun.serve({
    hostname: "0.0.0.0", port: Number(Bun.env.PORT ?? "8080"),
    maxRequestBodySize: HOSTED_METERED_MAX_BODY_BYTES,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method === "GET" && (url.pathname === "/healthz" || url.pathname === "/container/health")) {
        return Response.json({ ok: phase === "ready" || phase === "closed", profile: HOSTED_METERED_PROFILE,
          qualification: "local-native-only", status: phase, context });
      }
      let body: Uint8Array;
      try { body = await readBody(request); } catch { return Response.json({ errorCode: "metered_request_too_large" }, { status: 413 }); }
      const nonce = await authenticateHostedMeteredRequest(key, context, request, body);
      if (!nonce) return Response.json({ errorCode: "metered_request_unauthorized" }, { status: 401 });
      // Verify before reservation. Set insertion is synchronous after the await
      // so two concurrent identical authenticated requests cannot both execute.
      if (nonces.has(nonce)) return Response.json({ errorCode: "metered_request_replayed" }, { status: 409 });
      if (nonces.size >= HOSTED_METERED_MAX_REQUESTS) { fail(); return unavailableResponse(); }
      nonces.add(nonce);
      if (url.pathname === "/metered/outbox" && request.method === "GET" && !url.search) {
        return phase === "closed" ? Response.json(receipt) : unavailableResponse();
      }
      if (url.pathname === "/metered/close" && request.method === "POST" && !url.search &&
        new TextDecoder().decode(body) === "{}") {
        if (closing) return await closing;
        if (phase !== "ready" || pending.size !== 0 || preparingDispatch || !requestConsumed) return unavailableResponse();
        closing = close(); return await closing;
      }
      const route = /^\/runs\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})(?:\/|$)/u.exec(url.pathname);
      if (!route || route[1] !== context.runId) return Response.json({ errorCode: "metered_run_mismatch" }, { status: 403 });
      if (phase !== "ready" || pending.size >= 16) return unavailableResponse();
      const dispatch = request.method === "POST" && url.pathname === "/runs/" + context.runId;
      if (dispatch) {
        const bodyDigest = await hostedMeteredSha256(body);
        if (requestConsumed || url.search || bodyDigest !== admission.requestBodySha256) {
          return Response.json({ errorCode: "metered_attempt_mismatch" }, { status: 409 });
        }
        // Mark consumed before either durable write or forward. Failure never
        // retries the same provider effect through this boot.
        requestConsumed = true;
        preparingDispatch = true;
        try {
          await writePrivateRecord("intent.json", { kind: "takosumi.hosted-metered-local-intent@v1",
            status: "pending", context, requestConsumed: true, completeRunMeasurement: false });
        } catch { preparingDispatch = false; fail(); return unavailableResponse(); }
        if (isPending() || childExited) {
          preparingDispatch = false;
          return unavailableResponse();
        }
      }
      const id = randomUUID();
      return await new Promise<Response>((resolve) => {
        const abort = () => { void writeFrame({ kind: "cancel", id }).catch(fail); };
        request.signal.addEventListener("abort", abort, { once: true });
        pending.set(id, { resolve, removeAbort: () => request.signal.removeEventListener("abort", abort) });
        // No await between releasing the dispatch reservation and enrolling
        // the response/cleanup obligation visible to close.
        if (dispatch) preparingDispatch = false;
        const headers = [...request.headers].filter(([name]) => ![
          HOSTED_METERED_CONTEXT_HEADER, HOSTED_METERED_NONCE_HEADER, HOSTED_METERED_SIGNATURE_HEADER,
          "host", "connection", "content-length", "transfer-encoding",
        ].includes(name.toLowerCase()));
        void writeFrame({ kind: "request", id, method: request.method, path: url.pathname + url.search,
          headers, body: Buffer.from(body).toString("base64") }).catch(fail);
        if (request.signal.aborted) abort();
      });
    },
  });
  const stop = () => {
    if (closureCommitted) {
      void closing?.finally(() => server.stop(true));
      return;
    }
    fail(); native.symbols.takosumi_meter_kill_owned();
    // No final receipt before the closure commit point. Keep the lease enrolled
    // while any descendant can still write; provider destruction is external.
    void server.stop(true);
  };
  process.on("SIGTERM", stop); process.on("SIGINT", stop);
}

if (import.meta.main) {
  try { await start(); } catch {
    process.stderr.write("hosted metered collector unavailable\n"); process.exitCode = 1;
  }
}
