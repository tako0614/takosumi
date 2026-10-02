import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  runnerMutationIdentity,
  type RunnerMutationSemanticPorts,
} from "../../../core/shared/runner_mutation_semantics.ts";
import {
  createRunCredentialToken,
  verifyRunCredentialTokenAuthority,
} from "../../../core/shared/run_credential_tokens.ts";

const secret = "artificial-test-signing-secret-32-bytes-only";
const provider = "registry.example.test/artificial/provider";

async function token(jti: string, scopes = ["provider:apply"]): Promise<string> {
  return (await createRunCredentialToken({
    secret,
    audience: "artificial-provider",
    subject: "principal_1",
    workspaceId: "workspace_1",
    capsuleId: "capsule_1",
    runId: "apply_1",
    installingPrincipalId: "principal_1",
    connectionId: "connection_1",
    provider,
    phase: "apply",
    scopes,
    jti,
  })).token;
}

function request(signedToken: string) {
  return {
    applyRun: {
      id: "apply_1",
      workspaceId: "workspace_1",
      capsuleId: "capsule_1",
      status: "running",
      heartbeatAt: 1,
      stateLock: { backendRef: "state://one", lockRef: "lock://one", acquiredAt: 1 },
      configDigest: "sha256:config-one",
    },
    planRun: {
      id: "plan_1",
      workspaceId: "workspace_1",
      capsuleId: "capsule_1",
      source: { ref: "commit-one", modulePath: "." },
      planDigest: "sha256:plan-one",
      resolvedProviderBindingsDigest: "sha256:bindings-one",
      status: "succeeded",
      auditEvents: [],
    },
    credentials: {
      env: { RUN_TOKEN: signedToken, STATIC_KEY: "artificial-static-one" },
      files: [{ path: "/tmp/artificial", content: "artificial-file-one", mode: 384 }],
      manifest: { bindings: [{ connectionId: "connection_1", providerSource: provider }] },
      runtimeInputs: [{ variableName: "config", names: ["key"], values: { key: "artificial-input-one" } }],
    },
  };
}

function ports(): RunnerMutationSemanticPorts {
  return { verifyCredentialToken: async (value) => {
    const verified = await verifyRunCredentialTokenAuthority(value, { secret });
    if (!verified.ok) throw new Error("verification rejected");
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
    return {
      payload: verified.payload,
      signingAuthorityDigest: `sha256:${Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("")}`,
    };
  } };
}

async function identity(value: unknown, options = ports()) {
  return await runnerMutationIdentity("plan_1", "apply", value, options);
}

test("verified reminting and mutable Run evidence preserve DO semantic identity, not private material", async () => {
  const first = request(await token("artificial-first"));
  const refreshed = request(await token("artificial-second"));
  refreshed.applyRun.status = "succeeded";
  refreshed.applyRun.heartbeatAt = 2;
  refreshed.applyRun.stateLock.acquiredAt = 2;
  refreshed.planRun.status = "running";
  const left = await identity(first);
  const right = await identity(refreshed);
  assert.equal(right.semanticDigest, left.semanticDigest);
  assert.notEqual(right.privateMaterialDigest, left.privateMaterialDigest);
  assert.match(left.semanticDigest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(left).includes("artificial-static-one"), false);
  assert.equal(JSON.stringify(left).includes("artificial-first"), false);
});

test("every stable Run, source, state, lock, provider, and config coordinate changes semantic identity", async () => {
  const base = request(await token("artificial-stable"));
  const original = (await identity(base)).semanticDigest;
  const edits: Array<(value: ReturnType<typeof request>) => void> = [
    (value) => { value.applyRun.id = "apply_2"; },
    (value) => { value.applyRun.configDigest = "sha256:config-two"; },
    (value) => { value.applyRun.stateLock.backendRef = "state://two"; },
    (value) => { value.applyRun.stateLock.lockRef = "lock://two"; },
    (value) => { value.planRun.source.ref = "commit-two"; },
    (value) => { value.planRun.planDigest = "sha256:plan-two"; },
    (value) => { value.planRun.resolvedProviderBindingsDigest = "sha256:bindings-two"; },
    (value) => { value.credentials.manifest.bindings[0]!.providerSource = "other/provider"; },
  ];
  for (const edit of edits) {
    const changed = structuredClone(base);
    edit(changed);
    if (changed.applyRun.id === "apply_2" || changed.credentials.manifest.bindings[0]!.providerSource !== provider) {
      await assert.rejects(identity(changed));
    } else {
      assert.notEqual((await identity(changed)).semanticDigest, original);
    }
  }
});

test("opaque/static material never collapses by default, while signed authority scope remains bound", async () => {
  const base = request(await token("artificial-material"));
  const original = await identity(base);
  const rotated = structuredClone(base);
  rotated.credentials.env.STATIC_KEY = "artificial-static-two";
  assert.notEqual((await identity(rotated)).semanticDigest, original.semanticDigest);
  const changedInput = structuredClone(base);
  changedInput.credentials.runtimeInputs[0]!.values.key = "artificial-input-two";
  assert.notEqual((await identity(changedInput)).semanticDigest, original.semanticDigest);
  const newScope = request(await token("artificial-new-scope", ["provider:apply", "provider:admin"]));
  assert.notEqual((await identity(newScope)).semanticDigest, original.semanticDigest);
});

test("missing verifier, tampered token, and malformed token fail closed", async () => {
  const signed = await token("artificial-reject");
  await assert.rejects(identity(request(signed), {}), /verification authority/);
  await assert.rejects(identity(request(`${signed}x`)));
  await assert.rejects(identity(request("takrct_v1.malformed")));
  await assert.rejects(identity(request("takrct_broken")), /malformed Run credential/);
  const opaque = request(signed);
  opaque.credentials.env.RUN_TOKEN = "artificial-opaque-one";
  const rotated = structuredClone(opaque);
  rotated.credentials.env.RUN_TOKEN = "artificial-opaque-two";
  assert.notEqual((await identity(opaque)).semanticDigest, (await identity(rotated)).semanticDigest);
});
