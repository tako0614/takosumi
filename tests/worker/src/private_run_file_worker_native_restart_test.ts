import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Miniflare } from "miniflare";
import { PartitionedSecretBoundaryCrypto } from "../../../core/adapters/secret-store/memory.ts";
import { createPrivateRunFileGrantCodec } from "../../../core/domains/private-run-files/grant.ts";
import {
  ensureD1OpenTofuLedgerSchema,
} from "../../../worker/src/d1_opentofu_store.ts";
import type {
  D1Database,
  R2Bucket,
} from "../../../worker/src/bindings.ts";

const PASSPHRASE = "native-private-run-file-test-key-0123456789abcdef";
const PRIVATE_FILE_PATH = "/internal/private-run-files/v1";
const ENDPOINT = `http://127.0.0.1:8787${PRIVATE_FILE_PATH}`;
const PREFIX = "native-proof/private-run-files/v1";
const MAX_BYTES = 16 * 1024 * 1024;
const NATIVE_OPT_IN =
  process.env.TAKOSUMI_TEST_NATIVE_PRIVATE_RUN_FILE_WORKER_RESTART === "1";
const SCOPE = {
  workspaceId: "native_private_file_workspace",
  capsuleId: "native_private_file_capsule",
  environment: "production",
  slot: "opaque.intent",
} as const;
const AUTHORITY = {
  runId: "native_private_file_run",
  executionAuthorityEpoch: 7,
  leaseToken: "native_private_file_lease",
} as const;
const PAYLOAD = "private-native-worker-payload-7a3f";

test.skipIf(!NATIVE_OPT_IN)(
  "opt-in private Run-file HTTP uses persistent workerd D1 and R2 across OS worker restart",
  async () => {
    await proveNativePrivateRunFileWorkerRestart();
  },
  20_000,
);

async function proveNativePrivateRunFileWorkerRestart(): Promise<void> {
  if (process.platform !== "linux") {
    throw new Error("native workerd process witness requires Linux procfs");
  }
  const root = await mkdtemp(join(tmpdir(), "takosumi-private-run-file-worker-native-"));
  let runtime: Miniflare | undefined;
  try {
    const bundle = await buildWorkerBundle(root);
    const cryptoBoundary = new PartitionedSecretBoundaryCrypto({
      globalPassphrase: PASSPHRASE,
    });
    const grants = createPrivateRunFileGrantCodec({ cryptoBoundary });
    const grant = await grants.mint({
      scope: SCOPE,
      authority: AUTHORITY,
      operations: ["read", "commit", "resolve"],
      expiresAt: Date.now() + 5 * 60_000,
    });

    const childrenBeforeFirstWorker = await directWorkerdChildren();
    runtime = startWorker(bundle, root);
    const db = await runtime.getD1Database("TAKOSUMI_CONTROL_DB") as unknown as D1Database;
    await ensureD1OpenTofuLedgerSchema(db);
    await seedAuthority(db);

    const noGrant = await request(runtime, "read", undefined, {});
    expect(noGrant.status).toBe(401);
    expect(await noGrant.json()).toEqual({ kind: "authorization_rejected" });
    const firstWorkerd = await newlyStartedWorkerd(childrenBeforeFirstWorker);

    const plaintext = new TextEncoder().encode(PAYLOAD);
    const digest = await digestBytes(plaintext);
    const commit = {
      expectedVersion: 0,
      commitId: "native_private_file_commit_1",
      bytesBase64: toBase64(plaintext),
    };
    // The test-only Worker wrapper drops the completed commit response after
    // the real service has returned it, simulating a lost HTTP ACK.
    const droppedAck = await request(runtime, "commit", grant, commit, true);
    expect(droppedAck.status).toBe(502);
    const droppedText = await droppedAck.text();
    expect(droppedText).not.toContain(PAYLOAD);
    expect(droppedText).not.toContain(AUTHORITY.leaseToken);

    const resolved = await request(runtime, "resolve", grant, {
      expectedVersion: 0,
      commitId: commit.commitId,
      digest,
    });
    expect(resolved.status).toBe(200);
    expect(await resolved.json()).toEqual({
      kind: "committed",
      receipt: {
        version: 1,
        digest,
        commitId: commit.commitId,
        expectedVersion: 0,
      },
    });

    const pointer = await db.prepare(`select version, digest, blob_id
      from private_run_file_pointers where workspace_id = ? and capsule_id = ?
      and environment = ? and slot = ?`)
      .bind(SCOPE.workspaceId, SCOPE.capsuleId, SCOPE.environment, SCOPE.slot)
      .first<{ version: number; digest: string; blob_id: string }>();
    expect(pointer).toEqual({ version: 1, digest, blob_id: expect.any(String) });
    expect(
      (await db.prepare(`select count(*) as count from private_run_file_receipts
        where commit_id = ?`).bind(commit.commitId).first<{ count: number }>())
        ?.count,
    ).toBe(1);

    const bucket = await runtime.getR2Bucket("R2_ARTIFACTS") as unknown as R2Bucket;
    const blobId = pointer!.blob_id;
    const object = await bucket.get(`${PREFIX}/${blobId.slice("sha256:".length)}`);
    expect(object).not.toBeNull();
    const ciphertext = new Uint8Array(await object!.arrayBuffer());
    expect(new TextDecoder().decode(ciphertext)).not.toContain(PAYLOAD);

    const foreignScopeGrant = await grants.mint({
      scope: { ...SCOPE, capsuleId: "native_foreign_capsule" },
      authority: AUTHORITY,
      operations: ["read"],
      expiresAt: Date.now() + 5 * 60_000,
    });
    const foreign = await request(runtime, "read", foreignScopeGrant, {});
    expect(foreign.status).not.toBe(200);
    const foreignText = await foreign.text();
    expect(foreignText).not.toContain(PAYLOAD);
    expect(foreignText).not.toContain(AUTHORITY.leaseToken);
    expect(foreignText).not.toContain(foreignScopeGrant);
    const bodyScopeSubstitution = await request(runtime, "read", grant, {
      workspaceId: "native_foreign_workspace",
    });
    expect(bodyScopeSubstitution.status).toBe(400);
    expect(await bodyScopeSubstitution.text()).not.toContain(PAYLOAD);

    const expired = await expiredGrant(cryptoBoundary);
    const expiredResponse = await request(runtime, "read", expired, {});
    expect(expiredResponse.status).toBe(401);
    expect(await expiredResponse.json()).toEqual({ kind: "authorization_rejected" });

    // Miniflare's dispose sends SIGKILL to its actual workerd child. Verify its
    // exact PID/start-time identity is gone before starting the replacement.
    await runtime.dispose();
    runtime = undefined;
    expect(await processHasIdentity(firstWorkerd)).toBe(false);

    const childrenBeforeRestart = await directWorkerdChildren();
    runtime = startWorker(bundle, root);

    const afterRestart = await request(runtime, "read", grant, {});
    expect(afterRestart.status).toBe(200);
    expect(await afterRestart.json()).toEqual({
      kind: "present",
      version: 1,
      digest,
      bytesBase64: toBase64(plaintext),
    });
    const restartedWorkerd = await newlyStartedWorkerd(childrenBeforeRestart);
    expect(
      restartedWorkerd.pid === firstWorkerd.pid &&
        restartedWorkerd.startTime === firstWorkerd.startTime,
    ).toBe(false);
    const resolvedAfterRestart = await request(runtime, "resolve", grant, {
      expectedVersion: 0,
      commitId: commit.commitId,
      digest,
    });
    expect(resolvedAfterRestart.status).toBe(200);
    expect((await resolvedAfterRestart.json() as { kind: string }).kind)
      .toBe("committed");

    const dbAfterRestart = await runtime.getD1Database(
      "TAKOSUMI_CONTROL_DB",
    ) as unknown as D1Database;
    await dbAfterRestart.prepare(`update workspaces set management_state = 'frozen'
      where id = ?`).bind(SCOPE.workspaceId).run();
    const frozen = await request(runtime, "read", grant, {});
    expect(frozen.status).not.toBe(200);
    const frozenText = await frozen.text();
    expect(frozenText).not.toContain(PAYLOAD);
    expect(frozenText).not.toContain(AUTHORITY.leaseToken);
    expect(frozenText).not.toContain(grant);
  } finally {
    await runtime?.dispose();
    await rm(root, { recursive: true, force: true });
  }
}

async function buildWorkerBundle(root: string): Promise<string> {
  const entry = join(root, "worker-entry.ts");
  const handler = join(import.meta.dir, "../../../worker/src/handler.ts");
  const source = `
    import { createCloudflareWorker } from ${JSON.stringify(handler)};
    const worker = createCloudflareWorker({
      privateRunFiles: {
        endpoint: ${JSON.stringify(ENDPOINT)},
        prefix: ${JSON.stringify(PREFIX)},
        maxBytes: ${MAX_BYTES},
      },
    });
    export default {
      async fetch(request, env, context) {
        const response = await worker.fetch(request, env, context);
        if (request.headers.get("x-native-drop-commit-ack") === "1" &&
            new URL(request.url).pathname === ${JSON.stringify(`${PRIVATE_FILE_PATH}/commit`)} &&
            response.status === 200) {
          return new Response("ack deliberately discarded", { status: 502 });
        }
        return response;
      },
    };
  `;
  await Bun.write(entry, source);
  const output = await Bun.build({
    entrypoints: [entry],
    target: "browser",
    format: "esm",
    external: ["cloudflare:workers"],
    write: false,
  });
  if (!output.success || output.outputs.length !== 1) {
    throw new Error("native private-file Worker bundle unavailable");
  }
  return await output.outputs[0]!.text();
}

function startWorker(bundle: string, root: string): Miniflare {
  return new Miniflare({
    compatibilityDate: "2026-07-17",
    modules: [{ type: "ESModule", path: "private-run-files-worker.mjs", contents: bundle }],
    d1Databases: { TAKOSUMI_CONTROL_DB: "private-run-files-native-control" },
    r2Buckets: { R2_ARTIFACTS: "private-run-files-native-artifacts" },
    d1Persist: join(root, "d1"),
    r2Persist: join(root, "r2"),
    bindings: {
      TAKOSUMI_ENVIRONMENT: "test",
      TAKOSUMI_SECRET_STORE_PASSPHRASE: PASSPHRASE,
      TAKOSUMI_EXPOSE_INTERNAL_EDGE: "1",
      TAKOSUMI_DEPLOY_CONTROL_TOKEN: "synthetic-native-private-file-test-token",
    },
  });
}

interface WorkerdProcessIdentity {
  readonly pid: number;
  readonly startTime: string;
}

async function directWorkerdChildren(): Promise<WorkerdProcessIdentity[]> {
  const childrenPath = `/proc/${process.pid}/task/${process.pid}/children`;
  const children = (await readFile(childrenPath, "utf8")).trim();
  if (!children) return [];
  const identities: WorkerdProcessIdentity[] = [];
  for (const rawPid of children.split(/\s+/u)) {
    const pid = Number(rawPid);
    if (!Number.isSafeInteger(pid) || pid <= 0) continue;
    const commandLine = await readProcFile(`/proc/${pid}/cmdline`);
    if (commandLine === null) continue;
    const normalizedCommandLine = commandLine.replaceAll("\u0000", " ");
    if (!/(?:^|\/)workerd(?:\s|$)/u.test(normalizedCommandLine)) continue;
    const startTime = await processStartTime(pid);
    if (startTime !== null) identities.push({ pid, startTime });
  }
  return identities;
}

async function newlyStartedWorkerd(
  previous: readonly WorkerdProcessIdentity[],
): Promise<WorkerdProcessIdentity> {
  const previousIds = new Set(previous.map(processIdentityKey));
  const candidates = (await directWorkerdChildren()).filter((identity) =>
    !previousIds.has(processIdentityKey(identity))
  );
  if (candidates.length !== 1) {
    throw new Error("expected exactly one newly started direct workerd child");
  }
  return candidates[0]!;
}

async function processHasIdentity(
  identity: WorkerdProcessIdentity,
): Promise<boolean> {
  return await processStartTime(identity.pid) === identity.startTime;
}

async function processStartTime(pid: number): Promise<string | null> {
  const stat = await readProcFile(`/proc/${pid}/stat`);
  if (stat === null) return null;
  const closeCommand = stat.lastIndexOf(")");
  if (closeCommand < 0) throw new Error("process stat record malformed");
  // Field 22 (starttime) follows pid/comm; after comm it is field index 19.
  const fieldsAfterCommand = stat.slice(closeCommand + 1).trim().split(/\s+/u);
  const startTime = fieldsAfterCommand[19];
  if (!startTime || !/^\d+$/u.test(startTime)) {
    throw new Error("process start time unavailable");
  }
  return startTime;
}

async function readProcFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (
      typeof error === "object" && error !== null && "code" in error &&
      error.code === "ENOENT"
    ) {
      return null;
    }
    throw error;
  }
}

function processIdentityKey(identity: WorkerdProcessIdentity): string {
  return `${identity.pid}:${identity.startTime}`;
}

function request(
  runtime: Miniflare,
  operation: "read" | "commit" | "resolve",
  grant: string | undefined,
  body: Record<string, unknown>,
  dropCommitAck = false,
): Promise<Response> {
  const headers = new Headers({ "content-type": "application/json" });
  if (grant) headers.set("authorization", `Bearer ${grant}`);
  if (dropCommitAck) headers.set("x-native-drop-commit-ack", "1");
  return runtime.dispatchFetch(`${ENDPOINT}/${operation}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

async function expiredGrant(
  cryptoBoundary: PartitionedSecretBoundaryCrypto,
): Promise<string> {
  const now = Date.now() - 10_000;
  const expiredCodec = createPrivateRunFileGrantCodec({
    cryptoBoundary,
    now: () => now,
  });
  return await expiredCodec.mint({
    scope: SCOPE,
    authority: AUTHORITY,
    operations: ["read"],
    expiresAt: now + 1_000,
  });
}

async function seedAuthority(db: D1Database): Promise<void> {
  await db.prepare(`insert into workspaces
    (id, handle, record_json, created_at, updated_at)
    values (?, 'native-private-file-workspace', '{}', '2026-10-12', '2026-10-12')`)
    .bind(SCOPE.workspaceId).run();
  await db.prepare(`insert into capsules
    (id, space_id, project_id, name, slug, install_config_id, environment,
     status, record_json, created_at, updated_at, execution_authority_epoch)
    values (?, ?, 'native_private_file_project', 'native-private-file-capsule',
     'native-private-file-capsule', 'native_private_file_install', ?, 'active',
     '{}', '2026-10-12', '2026-10-12', ?)`)
    .bind(
      SCOPE.capsuleId,
      SCOPE.workspaceId,
      SCOPE.environment,
      AUTHORITY.executionAuthorityEpoch,
    ).run();
  await db.prepare(`insert into runs
    (id, space_id, installation_id, environment, type, status,
     lease_token, run_json, created_at)
    values (?, ?, ?, ?, 'plan', 'running', ?, ?, '2026-10-12')`)
    .bind(
      AUTHORITY.runId,
      SCOPE.workspaceId,
      SCOPE.capsuleId,
      SCOPE.environment,
      AUTHORITY.leaseToken,
      JSON.stringify({
        id: AUTHORITY.runId,
        workspaceId: SCOPE.workspaceId,
        capsuleId: SCOPE.capsuleId,
        status: "running",
        capsuleExecutionAuthorityEpoch: AUTHORITY.executionAuthorityEpoch,
        workspaceManagementAuthority: {
          workspaceId: SCOPE.workspaceId,
          managementState: "active",
          managementEpoch: 1,
        },
      }),
    ).run();
}

async function digestBytes(bytes: Uint8Array): Promise<`sha256:${string}`> {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.slice().buffer));
  return `sha256:${[...hash].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
