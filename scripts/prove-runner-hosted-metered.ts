#!/usr/bin/env bun
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import {
  createHostedMeteredRequestHeaders,
  hostedMeteredContext,
  importHostedMeteredKey,
  parseHostedMeteredContext,
  sameHostedMeteredContext,
  signHostedMeteredReceipt,
  type HostedMeteredContext,
  type HostedMeteredLocalAdmission,
} from "../runner/lib/hosted_metered_protocol.ts";
import { parseLocalRunnerImageIdentity } from "./lib/runner-image-native-proof.ts";
import {
  buildRunnerProofApplyEnvelope,
  buildRunnerProofPlanEnvelope,
  RUNNER_PROOF_MAIN_TF,
  RUNNER_PROOF_OUTPUTS,
} from "./prove-runner-docker-payload.ts";

const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const CID = /^[0-9a-f]{64}$/u;
const ENTRYPOINT = "/app/runner/start-hosted-metered.sh";
const LAUNCHER = "/app/runner/native/hosted-metered-launcher";
const ROOT = resolve(import.meta.dir, "..");
const MAX_COMMAND_OUTPUT = 16 * 1024 * 1024;
const MAX_COMMAND_MS = 90_000;

export interface HostedMeteredImageProofOptions {
  readonly image: string;
  readonly descriptor: string;
}

export function parseHostedMeteredImageProofArgs(argv: readonly string[]): HostedMeteredImageProofOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if ((key !== "--image" && key !== "--descriptor") || !value || values.has(key) || !DIGEST.test(value)) {
      throw new Error("usage: prove-runner-hosted-metered.ts --image sha256:<local-config-id> --descriptor sha256:<manifest-digest>");
    }
    values.set(key, value);
  }
  if (values.size !== 2) throw new Error("both exact local image ID and manifest descriptor are required");
  return { image: values.get("--image")!, descriptor: values.get("--descriptor")! };
}

export function assertHostedMeteredImageIdentity(source: string, options: HostedMeteredImageProofOptions): void {
  const identity = parseLocalRunnerImageIdentity(source);
  const value = JSON.parse(source) as { Config?: { User?: unknown; Entrypoint?: unknown; Cmd?: unknown; Labels?: unknown } };
  // OCI Cmd is optional: https://github.com/opencontainers/image-spec/blob/main/config.md
  if (identity.localImageId !== options.image || identity.descriptorDigest !== options.descriptor ||
    value.Config?.User !== "0:0" || JSON.stringify(value.Config.Entrypoint) !== JSON.stringify([ENTRYPOINT]) ||
    (value.Config.Cmd !== undefined && value.Config.Cmd !== null &&
      (!Array.isArray(value.Config.Cmd) || value.Config.Cmd.length !== 0))) {
    throw new Error("image is not the exact native Hosted-metered composition");
  }
}

interface CommandResult { readonly exitCode: number; readonly stdout: string; readonly stderr: string }
interface HttpResult { readonly status: number; readonly body: Uint8Array }
interface Session {
  readonly cid: string;
  readonly directory: string;
  readonly key: CryptoKey;
  readonly admission: HostedMeteredLocalAdmission;
  readonly context: HostedMeteredContext;
  readonly requestBody: Uint8Array;
  readonly cgroup: string;
  readonly counterDevice: bigint;
  readonly counterInode: bigint;
  readonly observedBeforeUsec: bigint;
}

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function boundedBytes(stream: ReadableStream<Uint8Array>): Promise<string> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.byteLength;
    if (size > MAX_COMMAND_OUTPUT) throw new Error("image proof command output exceeds bound");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function hostedMeteredImageProofCommandEnvironment(source: NodeJS.ProcessEnv, dockerConfig: string): NodeJS.ProcessEnv {
  // The owning release client resolves its selected Docker context BEFORE
  // elevation. Host PID/cgroup qualification cannot prove a remote/TLS daemon.
  if (source.DOCKER_CONTEXT || source.DOCKER_TLS || source.DOCKER_TLS_VERIFY || source.DOCKER_CERT_PATH) {
    throw new Error("owning release client must resolve one local Unix Docker endpoint before image proof");
  }
  const endpoint = source.DOCKER_HOST;
  if (!endpoint || !/^unix:\/\/\/[^\0\r\n]+$/u.test(endpoint)) throw new Error("native image proof requires an explicitly allocated local Unix Docker endpoint");
  return { PATH: "/usr/local/bin:/usr/bin:/bin", DOCKER_HOST: endpoint, DOCKER_CONFIG: dockerConfig };
}

export async function hostedMeteredImageProofCommandArguments(args: readonly string[], source: NodeJS.ProcessEnv): Promise<readonly string[]> {
  if (args[0] !== "docker") return [...args];
  // Only the owning client resolves this internal projection, immediately
  // before the trusted root seam. Never choose a second Docker from root PATH.
  const binary = source.TAKOSUMI_RUNNER_NATIVE_DOCKER;
  if (!binary || !isAbsolute(binary) || /[\0\r\n]/u.test(binary) || await realpath(binary) !== binary) {
    throw new Error("native image proof requires the owning canonical Docker executable");
  }
  const metadata = await lstat(binary);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || (metadata.mode & 0o111) === 0) {
    throw new Error("allocated Docker executable is not one physical executable file");
  }
  return [binary, ...args.slice(1)];
}

async function command(args: readonly string[], dockerConfig: string, stdin?: Uint8Array, timeoutMs = MAX_COMMAND_MS): Promise<CommandResult> {
  const child = Bun.spawn([...(await hostedMeteredImageProofCommandArguments(args, process.env))], {
    cwd: ROOT,
    env: hostedMeteredImageProofCommandEnvironment(process.env, dockerConfig),
    stdin: stdin ? "pipe" : "ignore", stdout: "pipe", stderr: "pipe",
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
  try {
    const output = Promise.all([boundedBytes(child.stdout), boundedBytes(child.stderr)]);
    if (stdin && child.stdin) {
      child.stdin.write(stdin);
      await child.stdin.end();
    }
    const [[stdout, stderr], exitCode] = await Promise.all([output, child.exited]);
    return { exitCode, stdout, stderr };
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) {
      child.kill("SIGKILL");
      await child.exited;
    }
  }
}

async function checked(args: readonly string[], dockerConfig: string, stdin?: Uint8Array): Promise<string> {
  const result = await command(args, dockerConfig, stdin);
  if (result.exitCode !== 0) {
    const kind = args[0] === "docker" ? `docker ${args[1]}` : args[0];
    // Keep the failure, never the remaining argv, stdin, stdout or environment.
    const stderr = result.stderr.trim().slice(0, 2_048);
    throw new Error(`image proof ${kind} failed (${result.exitCode})${stderr ? `: ${stderr}` : ""}`);
  }
  return result.stdout.trim();
}

// The client has no credentials in argv/environment and cannot call the network
// outside this owned --network=none Container. Its CPU is part of this LOCAL
// proof interval; it is not a production attribution or Cloudflare proof.
const HTTP_CLIENT = [
  'const r=JSON.parse(await Bun.stdin.text());',
  'const b=Buffer.from(r.body,"base64");',
  'const response=await fetch("http://127.0.0.1:8080"+r.path,{method:r.method,headers:r.headers,...((r.method==="GET"||r.method==="HEAD")?{}:{body:b}),signal:AbortSignal.timeout(r.timeoutMs)});',
  'console.log(JSON.stringify({status:response.status,body:Buffer.from(await response.arrayBuffer()).toString("base64")}));',
].join("\n");

async function request(cid: string, dockerConfig: string, method: string, path: string, body: Uint8Array = new Uint8Array(), headers: Record<string, string> = {}, timeoutMs = 60_000): Promise<HttpResult> {
  const input = Buffer.from(JSON.stringify({ method, path, body: Buffer.from(body).toString("base64"), headers, timeoutMs }));
  const result = await command(["docker", "exec", "--interactive", "--user", "0:0", cid, "/usr/local/bin/bun", "-e", HTTP_CLIENT], dockerConfig, input, timeoutMs + 2000);
  if (result.exitCode !== 0) throw new Error("actual image HTTP client failed or exceeded its bound");
  const text = result.stdout.trim();
  const response = JSON.parse(text) as { status?: unknown; body?: unknown };
  if (!Number.isInteger(response.status) || Number(response.status) < 100 || Number(response.status) > 599 || typeof response.body !== "string" ||
    Buffer.from(response.body, "base64").toString("base64") !== response.body) throw new Error("invalid image proof HTTP client response");
  return { status: Number(response.status), body: Buffer.from(response.body, "base64") };
}

async function authenticated(session: Session, dockerConfig: string, method: string, path: string, body: Uint8Array = new Uint8Array(), nonce = randomUUID(), context = session.context): Promise<HttpResult> {
  const headers = await createHostedMeteredRequestHeaders(session.key, context, nonce, method, `http://127.0.0.1:8080${path}`, body);
  return await request(session.cid, dockerConfig, method, path, body, { ...headers, "content-type": "application/json" });
}

function json(result: HttpResult): Record<string, unknown> {
  const value: unknown = JSON.parse(Buffer.from(result.body).toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("expected object from actual image");
  return value as Record<string, unknown>;
}

function denied(result: HttpResult): void {
  if (result.status !== 401 && result.status !== 403 && result.status !== 409) throw new Error("unauthorized metered request was not rejected");
}

function unauthorized(result: HttpResult): void {
  if (result.status !== 401) throw new Error("invalid root authentication was not rejected before routing");
}

async function prepareSession(options: HostedMeteredImageProofOptions, directory: string, dockerConfig: string, ownedContainers: Set<string>, action: "plan" | "apply", planDigest?: string): Promise<Session> {
  const runId = `metered-proof-${randomUUID()}`;
  const payload = action === "plan" ? buildRunnerProofPlanEnvelope(runId) : buildRunnerProofApplyEnvelope(runId, planDigest ?? "");
  const requestBody = Buffer.from(JSON.stringify(payload));
  const admission: HostedMeteredLocalAdmission = {
    kind: "takosumi.hosted-metered-local-admission@v1", profile: "hosted-metered-v1", authority: "local-native-proof",
    workspaceId: "metered-native-image-proof", runId, attemptId: `attempt-${randomUUID()}`,
    imageDigest: options.descriptor, admissionNonce: randomUUID(), requestBodySha256: sha256(requestBody),
  };
  await mkdir(directory, { mode: 0o700 });
  const keyBytes = randomBytes(32);
  await writeFile(join(directory, "admission.json"), JSON.stringify(admission), { mode: 0o600 });
  await writeFile(join(directory, "callback.key"), keyBytes, { mode: 0o600 });
  const key = await importHostedMeteredKey(keyBytes);
  keyBytes.fill(0);
  const cid = await checked([
    "docker", "create", "--pull=never", "--name", `takosumi-hosted-metered-image-proof-${randomUUID()}`,
    "--network=none", "--cgroupns=private", "--read-only", "--cpus=1", "--memory=256m", "--memory-swap=256m", "--pids-limit=64",
    "--ulimit", "cpu=30:30", "--ulimit", "nofile=256:256", "--ulimit", "core=0:0",
    "--cap-drop=ALL", "--cap-add=SETUID", "--cap-add=SETGID", "--cap-add=SETPCAP", "--cap-add=KILL",
    "--security-opt=no-new-privileges:true", "--tmpfs", "/tmp:rw,nosuid,nodev,size=96m",
    "--tmpfs", "/run:rw,nosuid,nodev,noexec,size=16m", "--tmpfs", "/proof:rw,exec,nosuid,nodev,mode=755,size=16m",
    "--tmpfs", "/workspace:rw,nosuid,nodev,noexec,uid=65534,gid=65534,mode=700,size=16m",
    "--mount", `type=bind,src=${directory},dst=/run/takosumi-metered`, options.image,
  ], dockerConfig);
  if (!CID.test(cid)) throw new Error("Docker did not return one exact owned Container ID");
  // Register before any later operation can fail, including an unavailable gate.
  ownedContainers.add(cid);
  await checked(["docker", "start", cid], dockerConfig);
  const inspected = JSON.parse(await checked(["docker", "inspect", "--format", "{{json .}}", cid], dockerConfig)) as { Id: string; State: { Pid: number; Running: boolean }; Image: string };
  if (inspected.Id !== cid || inspected.Image !== options.image || !inspected.State.Running || !Number.isSafeInteger(inspected.State.Pid) || inspected.State.Pid <= 1) throw new Error("actual Container identity changed");
  const membership = await readFile(`/proc/${inspected.State.Pid}/cgroup`, "utf8");
  const relative = /^0::(\/[^\n]+)\n$/u.exec(membership)?.[1];
  if (!relative || !relative.includes(cid)) throw new Error("owned Container has no unique host cgroup identity");
  const cgroup = await realpath(join("/sys/fs/cgroup", relative));
  if (!cgroup.startsWith("/sys/fs/cgroup/") || !cgroup.includes(cid)) throw new Error("owned cgroup escaped expected scope");
  const counterMetadata = await stat(join(cgroup, "cpu.stat"), { bigint: true });
  let context: HostedMeteredContext | undefined;
  const readyDeadline = performance.now() + 10_000;
  while (performance.now() < readyDeadline) {
    try {
      const health = json(await request(cid, dockerConfig, "GET", "/healthz", new Uint8Array(), {}, 500));
      if (health.ok === true && health.profile === "hosted-metered-v1" && health.qualification === "local-native-only") {
        context = parseHostedMeteredContext(health.context);
        if (!sameHostedMeteredContext(context, hostedMeteredContext(admission, context.bootId))) throw new Error("health context differs from admission");
        break;
      }
    } catch {
      // A bounded startup retry never retries a Run or manufactures readiness.
    }
    await Bun.sleep(50);
  }
  if (!context) throw new Error("actual Hosted-metered image did not become ready");
  const sourceScript = 'import {mkdir,writeFile,stat} from "node:fs/promises";const r=JSON.parse(await Bun.stdin.text());const p="/tmp/takosumi-metered-runs/"+r.runId+"/source";await mkdir(p,{recursive:true,mode:448});await writeFile(p+"/main.tf",r.source,{mode:384});if((await stat(p+"/main.tf")).uid!==65534)throw new Error("source owner");';
  await checked(["docker", "exec", "--interactive", "--user", "65534:65534", cid, "/usr/local/bin/bun", "-e", sourceScript], dockerConfig,
    Buffer.from(JSON.stringify({ runId, source: RUNNER_PROOF_MAIN_TF })));
  const session = { cid, directory, key, admission, context, requestBody, cgroup, counterDevice: counterMetadata.dev, counterInode: counterMetadata.ino };
  return { ...session, observedBeforeUsec: await counter(session) };
}

async function proveAuthentication(session: Session, dockerConfig: string): Promise<void> {
  const path = `/runs/${session.admission.runId}`;
  unauthorized(await request(session.cid, dockerConfig, "POST", path, session.requestBody));
  const nonce = randomUUID();
  const headers = await createHostedMeteredRequestHeaders(session.key, session.context, nonce, "POST", `http://127.0.0.1:8080${path}`, session.requestBody);
  unauthorized(await request(session.cid, dockerConfig, "POST", path, Buffer.concat([session.requestBody, Buffer.from(" ")]), headers));
  const methodHeaders = await createHostedMeteredRequestHeaders(session.key, session.context, randomUUID(), "POST", `http://127.0.0.1:8080${path}`, new Uint8Array());
  unauthorized(await request(session.cid, dockerConfig, "GET", path, new Uint8Array(), methodHeaders));
  unauthorized(await request(session.cid, dockerConfig, "POST", `${path}?tampered=1`, session.requestBody, headers));
  denied(await authenticated(session, dockerConfig, "POST", path, Buffer.concat([session.requestBody, Buffer.from(" ")])));
  denied(await authenticated(session, dockerConfig, "POST", `/runs/another-run`, session.requestBody));
  for (const context of [
    { ...session.context, bootId: randomUUID() }, { ...session.context, runId: "another-run" },
    { ...session.context, workspaceId: "another-workspace" }, { ...session.context, attemptId: "another-attempt" },
    { ...session.context, imageDigest: `sha256:${"0".repeat(64)}` },
    { ...session.context, admissionNonce: randomUUID() }, { ...session.context, requestBodySha256: "0".repeat(64) },
  ]) unauthorized(await authenticated(session, dockerConfig, "POST", path, session.requestBody, randomUUID(), context));
  // An invalid MAC must not consume a valid nonce. A valid, harmless outbox
  // read reserves it once; a second request with that nonce must be rejected.
  const replay = randomUUID();
  const replayHeaders = await createHostedMeteredRequestHeaders(session.key, session.context, replay, "GET", "http://127.0.0.1:8080/metered/outbox", new Uint8Array());
  const badHeaders = { ...replayHeaders, "x-takosumi-metered-signature": "0".repeat(64) };
  unauthorized(await request(session.cid, dockerConfig, "GET", "/metered/outbox", new Uint8Array(), badHeaders));
  const first = await authenticated(session, dockerConfig, "GET", "/metered/outbox", new Uint8Array(), replay);
  if (first.status !== 503 || json(first).status !== "pending") throw new Error("invalid authentication consumed a valid nonce or outbox state");
  denied(await authenticated(session, dockerConfig, "GET", "/metered/outbox", new Uint8Array(), replay));
}

async function executeRun(session: Session, dockerConfig: string): Promise<Record<string, unknown>> {
  const nonce = randomUUID();
  const responses = await Promise.all([
    authenticated(session, dockerConfig, "POST", `/runs/${session.admission.runId}`, session.requestBody, nonce),
    authenticated(session, dockerConfig, "POST", `/runs/${session.admission.runId}`, session.requestBody, nonce),
  ]);
  const successes = responses.filter((response) => response.status === 200);
  if (successes.length !== 1 || responses.filter((response) => response.status === 409).length !== 1) throw new Error("concurrent original Run replay was not fenced");
  const result = successes[0]!;
  const body = json(result);
  if (result.status !== 200 || body.status !== "succeeded" || body.exitCode !== 0) throw new Error("actual provider-free Run failed");
  denied(await authenticated(session, dockerConfig, "POST", `/runs/${session.admission.runId}`, session.requestBody));
  return body;
}

export async function runHostedMeteredImageProof(options: HostedMeteredImageProofOptions): Promise<Readonly<Record<string, string>>> {
  if (!DIGEST.test(options.image) || !DIGEST.test(options.descriptor) || process.platform !== "linux" || process.arch !== "x64" || process.getuid?.() !== 0) {
    throw new Error("actual image proof requires exact image identities on a Linux amd64 Docker host root");
  }
  const directory = await mkdtemp(join(tmpdir(), "takosumi-hosted-metered-image-"));
  await chmod(directory, 0o700);
  const dockerConfig = join(directory, "docker-config");
  await mkdir(dockerConfig, { mode: 0o700 });
  const ownedContainers = new Set<string>();
  let failure: unknown;
  try {
    assertHostedMeteredImageIdentity(await checked(["docker", "image", "inspect", "--format", "{{json .}}", options.image], dockerConfig), options);
    await proveLegacyEntrypointUnavailable(options, dockerConfig, ownedContainers);
    const plan = await prepareSession(options, join(directory, "plan"), dockerConfig, ownedContainers, "plan");
    await proveAuthentication(plan, dockerConfig);
    const planResult = await executeRun(plan, dockerConfig);
    if (typeof planResult.planDigest !== "string" || !planResult.planDigest) throw new Error("actual plan digest missing");
    const artifact = await authenticated(plan, dockerConfig, "GET", `/runs/${plan.admission.runId}/artifacts/tfplan`);
    if (artifact.status !== 200 || artifact.body.byteLength === 0) throw new Error("actual saved Plan artifact missing");
    const apply = await prepareSession(options, join(directory, "apply"), dockerConfig, ownedContainers, "apply", planResult.planDigest);
    const restore = await authenticated(apply, dockerConfig, "PUT", `/runs/${apply.admission.runId}/artifacts/tfplan`, artifact.body);
    if (restore.status !== 200) throw new Error("authenticated saved Plan restore failed");
    const applyResult = await executeRun(apply, dockerConfig);
    const outputs = applyResult.outputs as Record<string, unknown> | undefined;
    for (const [name, expected] of Object.entries(RUNNER_PROOF_OUTPUTS)) {
      const actual = outputs?.[name];
      if ((actual && typeof actual === "object" && "value" in actual ? actual.value : actual) !== expected) throw new Error("actual Apply output differs");
    }
    // Remaining native/image gates are deliberately required below. This
    // function cannot mint a partial success from a provider-free Plan alone.
    await proveImageBoundaryAndKernel(plan, dockerConfig, directory);
    await closeAndVerify(plan, dockerConfig);
    await closeAndVerify(apply, dockerConfig);
    await proveTerminatedChildRemainsPending(options, directory, dockerConfig, ownedContainers);
  } catch (error) {
    failure = error;
  }
  let cleanupFailed = false;
  for (const cid of ownedContainers) {
    const result = await command(["docker", "rm", "--force", cid], dockerConfig);
    if (result.exitCode !== 0) cleanupFailed = true;
    else ownedContainers.delete(cid);
  }
  if (!cleanupFailed) await rm(directory, { recursive: true, force: true });
  if (cleanupFailed) throw new Error("owned image proof Container cleanup failed");
  if (failure) throw failure;
  return {
    kind: "takosumi.runner-image-hosted-metered-native-report@v1", profile: "hosted-metered-v1",
    descriptorDigest: options.descriptor, nativeEntrypoint: "passed", childBoundary: "passed",
    kernelCpuAndDrain: "passed", authenticatedRunLifecycle: "passed",
  };
}

async function trustedChildPid(session: Session, dockerConfig: string): Promise<number> {
  const script = [
    'import {readFileSync} from "node:fs";',
    'const children=readFileSync("/proc/1/task/1/children","utf8").trim().split(/\\s+/).filter(Boolean);',
    'const found=children.filter(p=>{try{return readFileSync("/proc/"+p+"/cmdline","utf8").includes("/app/runner/hosted-metered-child.ts")}catch{return false}});',
    'if(found.length!==1)throw new Error("actual trusted child identity unavailable");console.log(found[0]);',
  ].join("\n");
  const value = await checked(["docker", "exec", "--user", "0:0", session.cid, "/usr/local/bin/bun", "-e", script], dockerConfig);
  if (!/^[1-9][0-9]*$/u.test(value) || Number(value) <= 1 || !Number.isSafeInteger(Number(value))) throw new Error("actual trusted child PID unavailable");
  return Number(value);
}

async function proveLegacyEntrypointUnavailable(options: HostedMeteredImageProofOptions, dockerConfig: string, ownedContainers: Set<string>): Promise<void> {
  const cid = await checked([
    "docker", "create", "--pull=never", "--name", `takosumi-metered-legacy-guard-${randomUUID()}`,
    "--network=none", "--read-only", "--pids-limit=8", "--memory=64m", "--memory-swap=64m",
    "--cap-drop=ALL", "--security-opt=no-new-privileges:true", "--entrypoint", "/app/runner/start.sh", options.image,
  ], dockerConfig);
  if (!CID.test(cid)) throw new Error("legacy guard did not create one exact owned Container");
  ownedContainers.add(cid);
  const start = await command(["docker", "start", cid], dockerConfig);
  const diagnostic = `${start.stdout}\n${start.stderr}`;
  if (start.exitCode === 0 || !diagnostic.includes("/app/runner/start.sh") || !diagnostic.includes("no such file or directory")) {
    throw new Error("metered root image still admits the ordinary runner entrypoint override");
  }
  const state = JSON.parse(await checked(["docker", "inspect", "--format", "{{json .State}}", cid], dockerConfig)) as { Running?: unknown };
  if (state.Running !== false) throw new Error("ordinary root runner unexpectedly started in metered image");
}

// This code is injected as a private test client, not loaded by the production
// runtime. The ACTUAL image's native launcher executes it as UID65534. It
// attacks the ACTUAL long-lived child and collector, including the IPC FDs.
export function hostedMeteredImageBoundaryProbeScript(childPid: number): string {
  if (!Number.isSafeInteger(childPid) || childPid <= 1) throw new Error("actual protected child PID required");
  return [
    'import {constants,openSync,closeSync,readFileSync,readlinkSync,readdirSync,mkdirSync,writeFileSync,unlinkSync} from "node:fs";',
    'import {dlopen,FFIType,ptr,toArrayBuffer} from "bun:ffi";',
    `const target=${childPid};`,
    'function assert(ok,label){if(!ok)throw new Error(label)}',
    'const status=readFileSync("/proc/self/status","utf8");',
    'const fields=name=>status.split("\\n").find(line=>line.startsWith(name+":")).slice(name.length+1).trim().split(/\\s+/);',
    'for(const kind of ["Uid","Gid"])assert(fields(kind).length===4&&fields(kind).every(value=>value==="65534"),"dropped "+kind);',
    'for(const cap of ["CapInh","CapPrm","CapEff","CapBnd","CapAmb"])assert(fields(cap).every(value=>/^0+$/.test(value)),"cleared "+cap);',
    'assert(fields("NoNewPrivs")[0]==="1"&&fields("Groups").join("")==="","NNP/groups");',
    'function denied(path,flags){try{const fd=openSync(path,flags|constants.O_NONBLOCK|constants.O_NOFOLLOW);closeSync(fd);throw new Error("opened protected "+path)}catch(e){assert(["EACCES","EPERM","EROFS"].includes(e.code),"protected path denial "+path)}}',
    'for(const file of ["/run/takosumi-metered/callback.key","/run/takosumi-metered/admission.json","/run/takosumi-metered/control/intent.json","/run/takosumi-metered/control/outbox.json"])denied(file,constants.O_RDONLY);',
    'for(const pid of [1,target])for(const suffix of ["environ","mem","fd/0","fd/1"]){denied("/proc/"+pid+"/"+suffix,constants.O_RDONLY);if(suffix.startsWith("fd/"))denied("/proc/"+pid+"/"+suffix,constants.O_WRONLY)}',
    'for(const file of ["/app/runner/start-hosted-metered.sh","/app/runner/hosted-metered-child.ts","/app/runner/native/hosted-metered-launcher","/app/runner/native/hosted-metered-supervisor.so"])denied(file,constants.O_WRONLY);',
    'denied("/sys/fs/cgroup/cpu.stat",constants.O_WRONLY);',
    'for(const fd of readdirSync("/proc/self/fd")){let link;try{link=readlinkSync("/proc/self/fd/"+fd)}catch{continue}assert(!link.includes("takosumi-metered")&&!link.includes("callback.key"),"private inherited descriptor")}',
    'for(const name of Object.keys(process.env))assert(!/(?:callback|signing|metered.*key|root_canary)/i.test(name),"private inherited environment");',
    'const libc=dlopen("libc.so.6",{setresuid:{args:[FFIType.u32,FFIType.u32,FFIType.u32],returns:FFIType.i32},kill:{args:[FFIType.i32,FFIType.i32],returns:FFIType.i32},ptrace:{args:[FFIType.i32,FFIType.i32,FFIType.ptr,FFIType.ptr],returns:FFIType.i64},syscall:{args:[FFIType.i64,FFIType.i64,FFIType.i64,FFIType.i64],returns:FFIType.i64},process_vm_readv:{args:[FFIType.i32,FFIType.ptr,FFIType.u64,FFIType.ptr,FFIType.u64,FFIType.u64],returns:FFIType.i64},__errno_location:{args:[],returns:FFIType.ptr}});',
    'const errno=()=>new Int32Array(toArrayBuffer(libc.symbols.__errno_location(),0,4))[0];',
    'assert(libc.symbols.setresuid(0,0,0)===-1,"root regain denied");assert(libc.symbols.kill(1,0)===-1,"collector signal denied");',
    'assert(Number(libc.symbols.ptrace(16,target,null,null))===-1&&errno()===1,"trusted child ptrace denied");',
    'const data=new Uint8Array(1);const local=new BigUint64Array([BigInt(ptr(data)),1n]);const remote=new BigUint64Array([1n,1n]);assert(Number(libc.symbols.process_vm_readv(target,ptr(local),1,ptr(remote),1,0))===-1&&errno()===1,"trusted child memory denied");',
    'const pidfd=Number(libc.symbols.syscall(434,target,0,0));assert(pidfd>=0,"pidfd primitive available");assert(Number(libc.symbols.syscall(438,pidfd,0,0))===-1&&errno()===1,"trusted IPC pidfd theft denied");closeSync(pidfd);',
    'assert(libc.symbols.kill(target,10)===0&&libc.symbols.kill(target,12)===0,"actual sameUID debug signals delivered");',
    'const cache="/tmp/takosumi-source-build-cache";mkdirSync(cache,{recursive:true});const probe=cache+"/image-native-proof-"+crypto.randomUUID();writeFileSync(probe,"untrusted-cache-probe",{mode:384});unlinkSync(probe);',
    'console.log("ACTUAL_IMAGE_BOUNDARY_PASSED");',
  ].join("\n");
}

async function counter(session: Pick<Session, "cgroup" | "counterDevice" | "counterInode">): Promise<bigint> {
  const metadata = await stat(join(session.cgroup, "cpu.stat"), { bigint: true });
  if (metadata.dev !== session.counterDevice || metadata.ino !== session.counterInode) throw new Error("owned kernel counter changed identity");
  const values = (await readFile(join(session.cgroup, "cpu.stat"), "utf8")).split("\n").filter((line) => line.startsWith("usage_usec "));
  if (values.length !== 1 || !/^usage_usec (0|[1-9][0-9]*)$/u.test(values[0]!)) throw new Error("actual owned kernel CPU counter unavailable");
  return BigInt(values[0]!.slice("usage_usec ".length));
}

async function proveImageBoundaryAndKernel(session: Session, dockerConfig: string, directory: string): Promise<void> {
  const pid = await trustedChildPid(session, dockerConfig);
  const attack = await checked(["docker", "exec", "--user", "0:0", session.cid, LAUNCHER, "--", "/usr/local/bin/bun", "-e", hostedMeteredImageBoundaryProbeScript(pid)], dockerConfig);
  if (attack !== "ACTUAL_IMAGE_BOUNDARY_PASSED") throw new Error("actual image sameUID boundary was not proved");
  const health = json(await request(session.cid, dockerConfig, "GET", "/healthz"));
  if (health.ok !== true || health.status !== "ready" || await trustedChildPid(session, dockerConfig) !== pid) throw new Error("sameUID debug signals disrupted trusted child custody");
  // SIGUSR1/2 must not start an inspector or any child HTTP listener.
  const listeners = await checked(["docker", "exec", "--user", "0:0", session.cid, "/usr/local/bin/bun", "-e",
    'import{readFileSync}from"node:fs";const lines=["/proc/net/tcp","/proc/net/tcp6"].flatMap(p=>readFileSync(p,"utf8").trim().split("\\n").slice(1));for(const line of lines){const fields=line.trim().split(/\\s+/);if(fields[3]==="0A"&&!fields[1].endsWith(":1F90"))throw new Error("untrusted debug/listener appeared")}console.log("ONLY_COLLECTOR_HTTP");'], dockerConfig);
  if (listeners !== "ONLY_COLLECTOR_HTTP") throw new Error("actual debug signal protection unavailable");
  const binary = join(directory, "native-workload");
  await checked(["cc", "-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", "-Wconversion", "-Wshadow", "-static", "-pthread", "-o", binary,
    "tests/native/hosted-metered-fixture.c", "runner/native/hosted-metered-supervisor.c"], dockerConfig);
  await chmod(binary, 0o755);
  const bytes = await readFile(binary);
  // Docker cp cannot write this tmpfs through the read-only Container rootfs.
  const installed = JSON.parse(await checked(["docker", "exec", "--interactive", "--user", "0:0", session.cid, "/usr/local/bin/bun", "-e", [
    'import{writeFileSync,readFileSync,statSync}from"node:fs";import{createHash}from"node:crypto";',
    'const d=statSync("/proof");if(!d.isDirectory()||d.uid!==0||d.gid!==0||(d.mode&0o777)!==0o755)throw new Error("fixture directory is not root-owned 0755");',
    'writeFileSync("/proof/native-workload",Buffer.from(await Bun.stdin.arrayBuffer()),{flag:"wx",mode:0o755});',
    'const b=readFileSync("/proof/native-workload"),s=statSync("/proof/native-workload");console.log(JSON.stringify({sha256:createHash("sha256").update(b).digest("hex"),size:b.byteLength,uid:s.uid,gid:s.gid,mode:s.mode&0o777}));',
  ].join("\n")], dockerConfig, bytes)) as Record<string, unknown>;
  if (installed.sha256 !== sha256(bytes) || installed.size !== bytes.byteLength ||
    installed.uid !== 0 || installed.gid !== 0 || installed.mode !== 0o755) {
    throw new Error("actual native fixture bytes or root ownership differ");
  }
  const immutable = await checked(["docker", "exec", "--user", "0:0", session.cid, LAUNCHER, "--", "/usr/local/bin/bun", "-e", [
    'import{writeFileSync}from"node:fs";if(process.getuid?.()!==65534||process.getgid?.()!==65534)throw new Error("fixture attack identity was not dropped");',
    'for(const[path,flag]of[["/proof/native-workload","r+"],["/proof/untrusted-workload","wx"]]){let denied=false;try{writeFileSync(path,"forged",{flag})}catch(error){if(!["EACCES","EPERM"].includes(error.code))throw error;denied=true}if(!denied)throw new Error("untrusted workload can modify root fixture")}',
    'console.log("ROOT_FIXTURE_IMMUTABLE");',
  ].join("\n")], dockerConfig);
  if (immutable !== "ROOT_FIXTURE_IMMUTABLE") throw new Error("actual native fixture write protection unavailable");
  const consumed = new Map<string, bigint>();
  for (const mode of ["sleep", "burn", "threads", "waited-fork", "autoreap-red", "double-fork", "setsid-background"]) {
    const before = await counter(session);
    await checked(["docker", "exec", "--user", "0:0", session.cid, LAUNCHER, "--", "/proof/native-workload", "workload", mode], dockerConfig);
    // The detached grandchildren deliberately outlive their intermediate
    // parent. Wait for their CPU work, leaving actual reaping to the collector.
    if (mode === "double-fork" || mode === "setsid-background") await Bun.sleep(500);
    const after = await counter(session);
    if (after < before) throw new Error("kernel counter regressed during actual native workload");
    const delta = after - before;
    consumed.set(mode, delta);
    if (mode !== "sleep" && delta < 150_000n) throw new Error(`kernel counter lost ${mode} CPU`);
  }
  if (consumed.get("sleep")! >= consumed.get("burn")!) throw new Error("sleep was substituted for active kernel CPU");
  const before = await counter(session);
  const timeoutScript = [
    `const child=Bun.spawn(${JSON.stringify([LAUNCHER, "--", "/proof/native-workload", "workload", "timeout-escaped"])},{stdin:"ignore",stdout:"ignore",stderr:"ignore",env:{PATH:"/usr/local/bin:/usr/bin:/bin"}});`,
    'await Bun.sleep(150);if(child.exitCode!==null)throw new Error("timeout workload ended before kill");child.kill("SIGKILL");await child.exited;',
    'console.log("OWNED_DIRECT_CHILD_KILLED");',
  ].join("\n");
  const escaped = await checked(["docker", "exec", "--user", "0:0", session.cid, "/usr/local/bin/bun", "-e", timeoutScript], dockerConfig);
  if (escaped !== "OWNED_DIRECT_CHILD_KILLED" || await counter(session) <= before) throw new Error("actual escaped timeout workload was not exercised");
  // Docker-exec clients are outside PID1's descendant tree. Kill and await the
  // owned direct fixture INSIDE the Container before closing, so its setsid
  // child is adopted by the real collector rather than left in an unowned
  // docker-exec process after the final sample.
  const adoption = await checked(["docker", "exec", "--user", "0:0", session.cid, "/usr/local/bin/bun", "-e",
    'import{readFileSync}from"node:fs";const ids=readFileSync("/proc/1/task/1/children","utf8").trim().split(/\\s+/).filter(Boolean);if(!ids.some(id=>{try{return readFileSync("/proc/"+id+"/cmdline","utf8").includes("/proof/native-workload")}catch{return false}}))throw new Error("escaped workload was not adopted by actual collector");console.log("ACTUAL_COLLECTOR_ADOPTED_ESCAPE");'], dockerConfig);
  if (adoption !== "ACTUAL_COLLECTOR_ADOPTED_ESCAPE") throw new Error("actual collector orphan adoption unavailable");
}

export async function verifyHostedMeteredImageReceipt(value: unknown, key: CryptoKey, context: HostedMeteredContext, identity: {
  readonly device: bigint; readonly inode: bigint;
  readonly beforeUsec: bigint; readonly afterUsec: bigint; readonly endUpperBoundUsec: bigint;
}): Promise<void> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("actual final CPU receipt missing");
  const signed = value as Record<string, unknown>;
  const keys = ["kind", "status", "qualification", "profile", "context", "scope", "kernel", "closure", "completeRunMeasurement", "signature"];
  if (Object.keys(signed).length !== keys.length || !keys.every((name) => Object.hasOwn(signed, name)) ||
    signed.kind !== "takosumi.hosted-metered-cpu-close@v1" || signed.status !== "closed" ||
    signed.qualification !== "local-native-only" || signed.profile !== "hosted-metered-v1" ||
    signed.scope !== "exclusive-collector-open-through-drained" || signed.completeRunMeasurement !== false ||
    typeof signed.signature !== "string" || !/^[0-9a-f]{64}$/u.test(signed.signature) ||
    !sameHostedMeteredContext(parseHostedMeteredContext(signed.context), context)) throw new Error("actual final CPU receipt identity invalid");
  const kernel = signed.kernel as Record<string, unknown> | undefined;
  const closure = signed.closure as Record<string, unknown> | undefined;
  if (!kernel || Object.keys(kernel).length !== 6 || kernel.source !== "cgroup-v2.cpu.stat/usage_usec" ||
    !["device", "inode", "startUsageUsec", "endUsageUsec", "usageUsec"].every((name) => typeof kernel[name] === "string" && /^(0|[1-9][0-9]*)$/u.test(kernel[name] as string)) ||
    BigInt(kernel.device as string) !== identity.device || BigInt(kernel.inode as string) !== identity.inode ||
    BigInt(kernel.endUsageUsec as string) - BigInt(kernel.startUsageUsec as string) !== BigInt(kernel.usageUsec as string) ||
    identity.beforeUsec > identity.afterUsec || identity.afterUsec > identity.endUpperBoundUsec ||
    BigInt(kernel.startUsageUsec as string) > identity.beforeUsec || BigInt(kernel.endUsageUsec as string) < identity.afterUsec ||
    BigInt(kernel.endUsageUsec as string) > identity.endUpperBoundUsec ||
    BigInt(kernel.usageUsec as string) < identity.afterUsec - identity.beforeUsec ||
    BigInt(kernel.usageUsec as string) <= 0n || !closure || Object.keys(closure).length !== 3 ||
    closure.directChildExited !== true || closure.adoptedChildren !== "ECHILD" || closure.runRootLeaseHeld !== true) {
    throw new Error("actual final CPU receipt lacks owned kernel counter/drain proof");
  }
  const { signature, ...payload } = signed;
  if (await signHostedMeteredReceipt(key, payload) !== signature) throw new Error("actual final CPU receipt authentication failed");
}

async function closeAndVerify(session: Session, dockerConfig: string): Promise<void> {
  const afterUsec = await counter(session);
  try {
    const result = await authenticated(session, dockerConfig, "POST", "/metered/close", Buffer.from("{}"));
    if (result.status !== 200) throw new Error("actual close unavailable");
  } catch {
    // kill(-1) may terminate this owned docker-exec proof client. Only the
    // authenticated immutable outbox can resolve the lost ACK, never a rerun.
  }
  let original: Record<string, unknown> | undefined;
  for (let attempt = 0; attempt < 40; attempt++) {
    const result = await authenticated(session, dockerConfig, "GET", "/metered/outbox");
    if (result.status === 200) {
      original = json(result);
      break;
    }
    await Bun.sleep(100);
  }
  await verifyHostedMeteredImageReceipt(original, session.key, session.context, {
    device: session.counterDevice, inode: session.counterInode,
    beforeUsec: session.observedBeforeUsec, afterUsec, endUpperBoundUsec: await counter(session),
  });
  const durable = JSON.parse(await readFile(join(session.directory, "control", "outbox.json"), "utf8")) as unknown;
  if (JSON.stringify(durable) !== JSON.stringify(original)) throw new Error("actual close was not durably acknowledged before response");
  const second = await authenticated(session, dockerConfig, "GET", "/metered/outbox");
  if (second.status !== 200 || JSON.stringify(json(second)) !== JSON.stringify(original)) throw new Error("actual outbox replay changed the final receipt");
}

async function proveTerminatedChildRemainsPending(options: HostedMeteredImageProofOptions, directory: string, dockerConfig: string, ownedContainers: Set<string>): Promise<void> {
  const session = await prepareSession(options, join(directory, "killed-child"), dockerConfig, ownedContainers, "plan");
  await executeRun(session, dockerConfig);
  const pid = await trustedChildPid(session, dockerConfig);
  await checked(["docker", "exec", "--user", "0:0", session.cid, "/usr/local/bin/bun", "-e", `process.kill(${pid},"SIGKILL");`], dockerConfig);
  await Bun.sleep(100);
  for (const [method, path, body] of [["POST", "/metered/close", Buffer.from("{}")], ["GET", "/metered/outbox", new Uint8Array()]] as const) {
    const response = await authenticated(session, dockerConfig, method, path, body);
    const value = json(response);
    if (value.status === "closed" || value.completeRunMeasurement === true || response.status === 200) throw new Error("terminated producer fabricated a final measurement");
  }
  await requireMissingOutbox(session);
  const collector = await prepareSession(options, join(directory, "killed-collector"), dockerConfig, ownedContainers, "plan");
  await executeRun(collector, dockerConfig);
  await checked(["docker", "kill", "--signal", "KILL", collector.cid], dockerConfig);
  await requireMissingOutbox(collector);
}

async function requireMissingOutbox(session: Session): Promise<void> {
  try {
    await readFile(join(session.directory, "control", "outbox.json"));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  throw new Error("terminated producer/collector persisted a fabricated final outbox");
}

if (import.meta.main) {
  try {
    console.log(JSON.stringify(await runHostedMeteredImageProof(parseHostedMeteredImageProofArgs(process.argv.slice(2)))));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "actual metered image proof unavailable");
    process.exitCode = 1;
  }
}
