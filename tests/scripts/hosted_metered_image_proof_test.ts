import { expect, test } from "bun:test";
import { chmod, link, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertHostedMeteredImageIdentity,
  hostedMeteredImageBoundaryProbeScript,
  hostedMeteredImageProofCommandArguments,
  hostedMeteredImageProofCommandEnvironment,
  parseHostedMeteredImageProofArgs,
  verifyHostedMeteredImageReceipt,
} from "../../scripts/prove-runner-hosted-metered.ts";
import {
  hostedMeteredContext,
  importHostedMeteredKey,
  signHostedMeteredReceipt,
} from "../../runner/lib/hosted_metered_protocol.ts";

const IMAGE = `sha256:${"a".repeat(64)}`;
const DESCRIPTOR = `sha256:${"b".repeat(64)}`;
const OPTIONS = { image: IMAGE, descriptor: DESCRIPTOR };

function inspected() {
  return {
    Id: IMAGE,
    Descriptor: { digest: DESCRIPTOR, mediaType: "application/vnd.docker.distribution.manifest.v2+json" },
    Os: "linux", Architecture: "amd64",
    Config: { User: "0:0", Entrypoint: ["/app/runner/start-hosted-metered.sh"], Cmd: [] },
  };
}

test("actual-image proof CLI requires two separate immutable identities and rejects publication/options", () => {
  expect(parseHostedMeteredImageProofArgs(["--image", IMAGE, "--descriptor", DESCRIPTOR])).toEqual(OPTIONS);
  expect(parseHostedMeteredImageProofArgs(["--descriptor", DESCRIPTOR, "--image", IMAGE])).toEqual(OPTIONS);
  for (const args of [
    [], ["--image", IMAGE], ["--image", "runner:latest", "--descriptor", DESCRIPTOR],
    ["--image", `registry.invalid/image@${IMAGE}`, "--descriptor", DESCRIPTOR],
    ["--image", IMAGE, "--descriptor", "sha256:aa"],
    ["--image", IMAGE, "--descriptor", DESCRIPTOR, "--image", IMAGE],
    ["--image", IMAGE, "--descriptor", DESCRIPTOR, "--pull", "true"],
    ["--image", IMAGE, "--descriptor", DESCRIPTOR, "--entrypoint", "/bin/sh"],
  ]) expect(() => parseHostedMeteredImageProofArgs(args)).toThrow();
});

test("image proof binds actual config and manifest independently to the exact root native entrypoint", () => {
  expect(() => assertHostedMeteredImageIdentity(JSON.stringify(inspected()), OPTIONS)).not.toThrow();
  const source = inspected();
  for (const value of [
    { ...source, Id: DESCRIPTOR },
    { ...source, Descriptor: { ...source.Descriptor, digest: IMAGE } },
    { ...source, Os: "darwin" },
    { ...source, Architecture: "arm64" },
    { ...source, Config: { ...source.Config, User: "bun" } },
    { ...source, Config: { ...source.Config, User: "0" } },
    { ...source, Config: { ...source.Config, Entrypoint: ["/app/runner/start.sh"] } },
    { ...source, Config: { ...source.Config, Entrypoint: ["sh", "/app/runner/start-hosted-metered.sh"] } },
    { ...source, Config: { ...source.Config, Cmd: ["--alternate-bootstrap"] } },
  ]) expect(() => assertHostedMeteredImageIdentity(JSON.stringify(value), OPTIONS)).toThrow();
});

test("private real-process attack client is valid Bun code and refuses an unknown PID", () => {
  const transpiler = new Bun.Transpiler({ loader: "js", target: "bun" });
  expect(() => transpiler.transformSync(hostedMeteredImageBoundaryProbeScript(123))).not.toThrow();
  for (const pid of [0, 1, -1, NaN, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    expect(() => hostedMeteredImageBoundaryProbeScript(pid)).toThrow();
  }
});

test("root proof preserves only the allocated local daemon and excludes provider credentials or unresolved contexts", () => {
  expect(hostedMeteredImageProofCommandEnvironment({
    PATH: "/untrusted/bin", DOCKER_HOST: "unix:///run/allocated/docker.sock", DOCKER_CONFIG: "/user/registry-auth",
    CLOUDFLARE_API_TOKEN: "must-not-inherit", BUN_OPTIONS: "--inspect", LD_PRELOAD: "/untrusted/preload.so",
  }, "/private/empty-config")).toEqual({
    PATH: "/usr/local/bin:/usr/bin:/bin", DOCKER_HOST: "unix:///run/allocated/docker.sock", DOCKER_CONFIG: "/private/empty-config",
  });
  for (const source of [
    {},
    { DOCKER_CONTEXT: "allocated-context" }, { DOCKER_HOST: "tcp://docker.invalid:2376" },
    { DOCKER_HOST: "ssh://operator@docker.invalid" }, { DOCKER_HOST: "unix:///socket\nother" },
    { DOCKER_TLS_VERIFY: "1" }, { DOCKER_CERT_PATH: "/private/certs" },
  ]) expect(() => hostedMeteredImageProofCommandEnvironment(source, "/private/empty-config")).toThrow();
});

test("root proof uses exactly the owning physical Docker executable without selecting a second CLI from root PATH", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "takosumi-docker-projection-")));
  try {
    const binary = join(directory, "allocated-docker");
    await writeFile(binary, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    await expect(hostedMeteredImageProofCommandArguments(["docker", "image", "inspect", "docker"], {
      PATH: "/different/tool-cache", TAKOSUMI_RUNNER_NATIVE_DOCKER: binary,
    })).resolves.toEqual([binary, "image", "inspect", "docker"]);
    await expect(hostedMeteredImageProofCommandArguments(["cc", "-static"], {})).resolves.toEqual(["cc", "-static"]);
    for (const value of [undefined, "docker", `${binary}\nother`, directory]) {
      await expect(hostedMeteredImageProofCommandArguments(["docker", "version"], { TAKOSUMI_RUNNER_NATIVE_DOCKER: value })).rejects.toThrow();
    }
    const symbolic = join(directory, "symbolic-docker");
    await symlink(binary, symbolic);
    await expect(hostedMeteredImageProofCommandArguments(["docker"], { TAKOSUMI_RUNNER_NATIVE_DOCKER: symbolic })).rejects.toThrow();
    await chmod(binary, 0o600);
    await expect(hostedMeteredImageProofCommandArguments(["docker"], { TAKOSUMI_RUNNER_NATIVE_DOCKER: binary })).rejects.toThrow();
    await chmod(binary, 0o700);
    const hard = join(directory, "hard-docker");
    await link(binary, hard);
    await expect(hostedMeteredImageProofCommandArguments(["docker"], { TAKOSUMI_RUNNER_NATIVE_DOCKER: binary })).rejects.toThrow();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

const CONTEXT = hostedMeteredContext({
  kind: "takosumi.hosted-metered-local-admission@v1", profile: "hosted-metered-v1", authority: "local-native-proof",
  workspaceId: "workspace-proof", runId: "run-proof", attemptId: "attempt-proof", imageDigest: DESCRIPTOR,
  admissionNonce: "admission-nonce-for-proof", requestBodySha256: "c".repeat(64),
}, "original-boot-proof-0001");
const OWNED_COUNTER = { device: 19n, inode: 23n, beforeUsec: 2000n, afterUsec: 201000n, endUpperBoundUsec: 203000n };

function receiptPayload() {
  return {
    kind: "takosumi.hosted-metered-cpu-close@v1", status: "closed", qualification: "local-native-only", profile: "hosted-metered-v1",
    context: CONTEXT, scope: "exclusive-collector-open-through-drained",
    kernel: { source: "cgroup-v2.cpu.stat/usage_usec", device: "19", inode: "23", startUsageUsec: "1000", endUsageUsec: "202000", usageUsec: "201000" },
    closure: { directChildExited: true, adoptedChildren: "ECHILD", runRootLeaseHeld: true }, completeRunMeasurement: false,
  };
}

test("image receipt proof requires signed original context, owned counter arithmetic, ECHILD and incomplete financial scope", async () => {
  const key = await importHostedMeteredKey(new Uint8Array(32).fill(7));
  const payload = receiptPayload();
  const signed = { ...payload, signature: await signHostedMeteredReceipt(key, payload) };
  await expect(verifyHostedMeteredImageReceipt(signed, key, CONTEXT, OWNED_COUNTER)).resolves.toBeUndefined();
  await expect(verifyHostedMeteredImageReceipt(signed, key, CONTEXT, { ...OWNED_COUNTER, device: 20n })).rejects.toThrow();
  await expect(verifyHostedMeteredImageReceipt({ ...signed, signature: "0".repeat(64) }, key, CONTEXT, OWNED_COUNTER)).rejects.toThrow();
  await expect(verifyHostedMeteredImageReceipt({ ...signed, kernel: { ...payload.kernel, usageUsec: "201001", endUsageUsec: "202001" } }, key, CONTEXT, OWNED_COUNTER)).rejects.toThrow();

  // These retain a valid MAC: the gate must independently refuse a weaker or
  // incomplete measurement contract rather than relying on tampering alone.
  for (const changed of [
    { ...payload, context: { ...CONTEXT, bootId: "another-boot-proof-0002" } },
    { ...payload, context: { ...CONTEXT, runId: "other-run" } },
    { ...payload, completeRunMeasurement: true },
    { ...payload, qualification: "cloudflare-qualified" },
    { ...payload, scope: "walltime" },
    { ...payload, extra: true },
    { ...payload, kernel: { ...payload.kernel, usageUsec: "0201000" } },
    { ...payload, kernel: { ...payload.kernel, usageUsec: "2.01e5" } },
    { ...payload, kernel: { ...payload.kernel, startUsageUsec: "202001" } },
    { ...payload, kernel: { ...payload.kernel, endUsageUsec: "1000", usageUsec: "0" } },
    { ...payload, kernel: { ...payload.kernel, source: "getrusage" } },
    { ...payload, kernel: { ...payload.kernel, startUsageUsec: "201000", endUsageUsec: "201001", usageUsec: "1" } },
    { ...payload, kernel: { ...payload.kernel, startUsageUsec: "1000", endUsageUsec: "99999999999", usageUsec: "99999998999" } },
    { ...payload, closure: { ...payload.closure, adoptedChildren: "timeout" } },
    { ...payload, closure: { ...payload.closure, directChildExited: false } },
    { ...payload, closure: { ...payload.closure, runRootLeaseHeld: false } },
  ]) {
    const value = { ...changed, signature: await signHostedMeteredReceipt(key, changed) };
    await expect(verifyHostedMeteredImageReceipt(value, key, CONTEXT, OWNED_COUNTER)).rejects.toThrow();
  }
});
