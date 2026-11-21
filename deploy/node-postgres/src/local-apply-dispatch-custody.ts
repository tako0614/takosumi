/** Encrypted, value-free original dispatch identity. This is not completion evidence. */
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, mkdir, open, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { SecretBoundaryCrypto } from "../../../core/adapters/secret-store/memory.ts";
import type { DispatchStateScope, RunExecutionCommit, RunExecutionAuthority, RunExecutionEvidence } from "@takosumi/internal/deploy-control-api";

export interface LocalMutationEvidenceIdentity {
  readonly runId: string;
  readonly planRunId: string;
  readonly runnerProfileId: string;
  readonly executorId: string;
  readonly authority: Pick<RunExecutionAuthority, "controllerArtifact" | "runnerArtifact" | "executorArtifact">;
  readonly plan: RunExecutionEvidence["plan"];
  readonly commit: RunExecutionCommit;
}
export interface LocalApplyDispatchCustody {
  readonly runId: string;
  readonly stateScope: DispatchStateScope;
  readonly runnerBindingDigest: string;
  readonly requestDigest: string;
  readonly restoredProviderLockDigest?: string;
  readonly reservation: { readonly kind: "v2"; readonly attemptId: string; readonly epoch: number };
  readonly identity: LocalMutationEvidenceIdentity;
}
export interface LocalApplyDispatchCustodyStore {
  readApplyDispatchCustody(input: Pick<LocalApplyDispatchCustody, "runId" | "stateScope" | "runnerBindingDigest">): Promise<LocalApplyDispatchCustody | undefined>;
  commitApplyDispatchCustody(record: LocalApplyDispatchCustody): Promise<void>;
}
const MAX_BYTES = 16 * 1024;
const MAX_EPOCH = 64;
const encoder = new TextEncoder();
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const bad = () => new Error("local Apply dispatch custody is invalid");
function object(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw bad();
  const record = value as Record<string, unknown>;
  if (required.some(key => !(key in record)) || Object.keys(record).some(key => !required.includes(key) && !optional.includes(key))) throw bad();
  return record;
}
function token(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 4096 || value.includes("\0")) throw bad();
  return value;
}
function sha(value: unknown): `sha256:${string}` {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(value)) throw bad();
  return value as `sha256:${string}`;
}
function artifact(value: unknown): RunExecutionAuthority["controllerArtifact"] {
  const r = object(value, ["digest", "immutable"]);
  if (r.immutable !== true) throw bad();
  return { digest: sha(r.digest), immutable: true };
}
function scope(value: unknown): DispatchStateScope {
  // priorState is a caller dispatch detail, not the target coordinate. Do not
  // persist it, provider variables, credentials, or any other raw job fields.
  const r = object(value, ["workspaceId", "subject", "environment", "generation", "stateRef"], ["priorState"]);
  const subject = object(r.subject, ["kind", "id"]);
  if ((subject.kind !== "capsule" && subject.kind !== "resource") || !Number.isSafeInteger(r.generation) || (r.generation as number) < 1) throw bad();
  return { workspaceId: token(r.workspaceId), subject: { kind: subject.kind, id: token(subject.id) }, environment: token(r.environment), generation: r.generation as number, stateRef: token(r.stateRef) };
}
function keyInput(value: Pick<LocalApplyDispatchCustody, "runId" | "stateScope" | "runnerBindingDigest">) {
  return { runId: token(value.runId), stateScope: scope(value.stateScope), runnerBindingDigest: sha(value.runnerBindingDigest) };
}
function normalize(value: unknown): LocalApplyDispatchCustody {
  const r = object(value, ["runId", "stateScope", "runnerBindingDigest", "requestDigest", "reservation", "identity"], ["restoredProviderLockDigest"]);
  const key = keyInput(r as unknown as Parameters<typeof keyInput>[0]);
  const reservation = object(r.reservation, ["kind", "attemptId", "epoch"]);
  if (reservation.kind !== "v2" || typeof reservation.attemptId !== "string" || !/^[0-9a-f-]{36}$/u.test(reservation.attemptId) || !Number.isSafeInteger(reservation.epoch) || (reservation.epoch as number) < 1 || (reservation.epoch as number) > MAX_EPOCH) throw bad();
  const i = object(r.identity, ["runId", "planRunId", "runnerProfileId", "executorId", "authority", "plan", "commit"]);
  if (i.runId !== key.runId) throw bad();
  const a = object(i.authority, ["controllerArtifact", "runnerArtifact", "executorArtifact"]);
  const p = object(i.plan, ["digest", "artifactDigest"]);
  const c = object(i.commit, ["stateVersionId", "outputId"]);
  return { ...key, requestDigest: sha(r.requestDigest), ...(r.restoredProviderLockDigest === undefined ? {} : { restoredProviderLockDigest: sha(r.restoredProviderLockDigest) }),
    reservation: { kind: "v2", attemptId: reservation.attemptId, epoch: reservation.epoch as number },
    identity: { runId: key.runId, planRunId: token(i.planRunId), runnerProfileId: token(i.runnerProfileId), executorId: token(i.executorId),
      authority: { controllerArtifact: artifact(a.controllerArtifact), runnerArtifact: artifact(a.runnerArtifact), executorArtifact: artifact(a.executorArtifact) },
      plan: { digest: sha(p.digest), artifactDigest: sha(p.artifactDigest) }, commit: { stateVersionId: token(c.stateVersionId), outputId: token(c.outputId) } } };
}
async function syncDirectory(path: string): Promise<void> {
  const fd = await open(path, "r");
  try { await fd.sync(); } finally { await fd.close(); }
}
async function readBounded(path: string): Promise<string | undefined> {
  let fd: Awaited<ReturnType<typeof open>>;
  try { fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  try {
    const before = await fd.stat();
    if (!before.isFile() || before.size < 1 || before.size > MAX_BYTES) throw bad();
    const bytes = Buffer.alloc(before.size);
    for (let offset = 0; offset < bytes.length;) {
      const n = await fd.read(bytes, offset, bytes.length - offset, offset);
      if (!n.bytesRead) throw bad();
      offset += n.bytesRead;
    }
    const after = await fd.stat();
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw bad();
    return bytes.toString("utf8");
  } finally { await fd.close(); }
}

export function createFileLocalApplyDispatchCustodyStore(root: string, crypto: SecretBoundaryCrypto): LocalApplyDispatchCustodyStore {
  const target = (input: Parameters<typeof keyInput>[0], epoch: number) => {
    const key = digest(JSON.stringify(keyInput(input)));
    return resolve(root, "apply-dispatch", key.slice(0, 2), key, `${epoch}.json`);
  };
  const read = async (input: Parameters<typeof keyInput>[0], epoch: number): Promise<LocalApplyDispatchCustody | undefined> => {
    const text = await readBounded(target(input, epoch));
    if (text === undefined) return undefined;
    const envelope = object(JSON.parse(text), ["kind", "epoch", "ciphertextBase64"]);
    if (envelope.kind !== "takosumi.local-apply-dispatch@v1" || envelope.epoch !== epoch || typeof envelope.ciphertextBase64 !== "string") throw bad();
    const ciphertext = Buffer.from(envelope.ciphertextBase64, "base64");
    if (ciphertext.toString("base64") !== envelope.ciphertextBase64) throw bad();
    const aad = encoder.encode(JSON.stringify({ kind: envelope.kind, ...keyInput(input), epoch }));
    const record = normalize(JSON.parse(await crypto.open(ciphertext, "global", aad)));
    if (JSON.stringify(keyInput(record)) !== JSON.stringify(keyInput(input)) || record.reservation.epoch !== epoch) throw bad();
    return record;
  };
  return {
    readApplyDispatchCustody: async input => {
      // Epochs may have gaps (a preparation can fail before Node publishes its
      // metadata). A malformed occupied newer epoch never falls back to older.
      for (let epoch = MAX_EPOCH; epoch >= 1; epoch--) {
        const record = await read(input, epoch);
        if (record) return record;
      }
      return undefined;
    },
    commitApplyDispatchCustody: async value => {
      const record = normalize(value);
      const path = target(record, record.reservation.epoch);
      const aad = encoder.encode(JSON.stringify({ kind: "takosumi.local-apply-dispatch@v1", ...keyInput(record), epoch: record.reservation.epoch }));
      const ciphertext = await crypto.seal(JSON.stringify(record), "global", aad);
      const bytes = JSON.stringify({ kind: "takosumi.local-apply-dispatch@v1", epoch: record.reservation.epoch, ciphertextBase64: Buffer.from(ciphertext).toString("base64") }) + "\n";
      if (Buffer.byteLength(bytes) > MAX_BYTES) throw bad();
      // Publish one immutable object per legitimate Runner-issued epoch. Never
      // overwrite an old attempt and never allocate an epoch during recovery.
      const rootPath = resolve(root);
      const directories = [rootPath, resolve(rootPath, "apply-dispatch"), dirname(dirname(path)), dirname(path)];
      for (const directory of directories) {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await syncDirectory(dirname(directory));
      }
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        const fd = await open(temporary, "wx", 0o600);
        try { await fd.writeFile(bytes); await fd.sync(); } finally { await fd.close(); }
        try { await link(temporary, path); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
        await syncDirectory(dirname(path));
        const existing = await read(record, record.reservation.epoch);
        if (!existing || JSON.stringify(existing) !== JSON.stringify(record)) throw bad();
      } finally { await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }); }
    },
  };
}
