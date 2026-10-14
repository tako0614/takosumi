/** Optional owner-composed custody for every object in a declared physical store.
 * This is a facts-only seam. Hosted policy, prices and admission stay outside OSS.
 */
import type { R2Bucket, R2Object, R2ObjectBody, R2PutOptions } from "./bindings.ts";

export type StoredBucketRole = "state" | "artifacts" | "source" | "backups";
export interface StoredObjectContext {
  readonly sourceRef: string;
  readonly bucketRole: StoredBucketRole;
  readonly writerId: string;
  readonly workspaceId: string;
  readonly objectRef: string;
}
export interface StoredObjectIntent {
  readonly operationRef: string;
  readonly expectedRevision: number;
  readonly kind: "put" | "delete";
  readonly bytes: string;
  readonly contentDigest: string | null;
  readonly state: "pending" | "confirmed" | "cancelled";
}
export interface StoredObjectSnapshot {
  readonly workspaceId: string;
  readonly revision: number;
  readonly bytes: string;
  readonly versionDigest: string | null;
  readonly pending?: StoredObjectIntent;
}
export interface StoredServiceUsagePort {
  readStoredSource(input: { readonly bucketRole: StoredBucketRole; readonly writerId: string }): Promise<{ readonly sourceRef: string; readonly epochRef: string; readonly qualificationDigest: string }>;
  readStoredObject(input: StoredObjectContext): Promise<StoredObjectSnapshot>;
  prepareStoredObject(input: StoredObjectContext & {
    readonly operationRef: string;
    readonly expectedRevision: number;
    readonly expectedVersionDigest: string | null;
    readonly desired: { readonly bytes: string; readonly contentDigest: string } | null;
  }): Promise<{ readonly dispatch: boolean; readonly intent: StoredObjectIntent; readonly dispatchToken?: string }>;
  confirmStoredObject(input: StoredObjectContext & {
    readonly operationRef: string;
    readonly dispatchToken: string;
    readonly acknowledgementDigest: string;
    readonly newVersionDigest: string | null;
  }): Promise<void>;
  cancelStoredObject(input: StoredObjectContext & {
    readonly operationRef: string;
    readonly dispatchToken: string;
    readonly refusalAcknowledgementDigest: string;
    readonly observedVersionDigest: string | null;
  }): Promise<void>;
}
export interface StoredObjectOwnerPort {
  /** Trusted allocation/ledger lookup. Raw object keys stay on the OSS side. */
  resolveStoredObjectOwner(input: { readonly bucketRole: StoredBucketRole; readonly key: string }): Promise<{ readonly workspaceId: string } | null>;
}
export interface StoredServiceComposition {
  readonly usage: StoredServiceUsagePort;
  readonly owners: StoredObjectOwnerPort;
}

export function storedServiceCompositionFromEnv(env: {
  readonly TAKOSUMI_STORED_SERVICE_USAGE?: StoredServiceUsagePort;
  readonly TAKOSUMI_STORED_OBJECT_OWNERS?: StoredObjectOwnerPort;
  readonly TAKOSUMI_ARTIFACT_STORAGE_USAGE?: unknown;
}): StoredServiceComposition | undefined {
  const usage = env.TAKOSUMI_STORED_SERVICE_USAGE;
  const owners = env.TAKOSUMI_STORED_OBJECT_OWNERS;
  if (Boolean(usage) !== Boolean(owners) || (usage && env.TAKOSUMI_ARTIFACT_STORAGE_USAGE)) throw new StoredServiceUsageError();
  return usage && owners ? { usage, owners } : undefined;
}

const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const INTEGER = /^(?:0|[1-9][0-9]{0,255})$/u;
const DEADLINE = 15_000;
const DEFAULT_MAX_BYTES = 512 * 1024 * 1024;
const encoder = new TextEncoder();

export class StoredServiceUsageError extends Error {
  constructor() { super("stored service custody is unavailable"); }
}
export async function storedServiceCall<T>(call: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([call(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new StoredServiceUsageError()), DEADLINE);
    })]);
  } catch { throw new StoredServiceUsageError(); }
  finally { if (timer !== undefined) clearTimeout(timer); }
}
function id(value: unknown): asserts value is string {
  if (typeof value !== "string" || !ID.test(value)) throw new StoredServiceUsageError();
}
function digest(value: unknown): asserts value is string {
  if (typeof value !== "string" || !DIGEST.test(value)) throw new StoredServiceUsageError();
}
function version(value: unknown): asserts value is string | null {
  if (value !== null) digest(value);
}
function integer(value: unknown): asserts value is string {
  if (typeof value !== "string" || !INTEGER.test(value)) throw new StoredServiceUsageError();
}
function revision(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new StoredServiceUsageError();
}
function keyValue(key: string): void {
  if (typeof key !== "string" || !key || key.length > 4096 || key.split("/").some(part => !part || part === "." || part === "..") || /[\u0000-\u001f\u007f]/u.test(key)) throw new StoredServiceUsageError();
}
export async function storedDigest(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === "string" ? encoder.encode(value) : value;
  const result = await crypto.subtle.digest("SHA-256", bytes.slice());
  return `sha256:${Array.from(new Uint8Array(result), byte => byte.toString(16).padStart(2, "0")).join("")}`;
}
export async function storedObjectReference(bucketRole: StoredBucketRole, key: string, sourceRef: string): Promise<string> {
  keyValue(key);
  id(sourceRef);
  return await storedDigest(JSON.stringify(["takosumi.stored-service.object.v1", sourceRef, bucketRole, key]));
}
function metadata(input: R2PutOptions | R2Object): { httpMetadata: { contentType?: string }; customMetadata: Record<string, string> } {
  const httpMetadata = input.httpMetadata?.contentType === undefined ? {} : { contentType: input.httpMetadata.contentType };
  if (httpMetadata.contentType !== undefined && typeof httpMetadata.contentType !== "string") throw new StoredServiceUsageError();
  const customMetadata: Record<string, string> = {};
  const keys = Object.keys(input.customMetadata ?? {}).sort();
  if (keys.length > 128) throw new StoredServiceUsageError();
  for (const key of keys) {
    const value = input.customMetadata![key];
    if (typeof value !== "string" || key.length > 1024 || value.length > 8192) throw new StoredServiceUsageError();
    Object.defineProperty(customMetadata, key, { value, enumerable: true, writable: false });
  }
  return { httpMetadata, customMetadata };
}
export async function storedNativeVersion(object: R2Object): Promise<string> {
  keyValue(object.key);
  if (!Number.isSafeInteger(object.size) || object.size < 0 || typeof object.etag !== "string" || !object.etag || object.etag.length > 1024 || typeof object.version !== "string" || !object.version || object.version.length > 1024 || !(object.uploaded instanceof Date) || !Number.isFinite(object.uploaded.getTime())) throw new StoredServiceUsageError();
  return await storedDigest(JSON.stringify(["takosumi.stored-service.version.v1", object.key, object.version, object.size, object.etag, object.uploaded.toISOString(), metadata(object)]));
}
async function contentDigest(bytes: Uint8Array, options: R2PutOptions | R2Object): Promise<string> {
  return await storedDigest(JSON.stringify(["takosumi.stored-service.content.v1", await storedDigest(bytes), metadata(options)]));
}
async function bytesFor(value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null, maximum: number): Promise<Uint8Array> {
  let bytes: Uint8Array;
  if (value === null) bytes = new Uint8Array();
  else if (typeof value === "string") bytes = encoder.encode(value);
  else if (value instanceof ArrayBuffer) bytes = new Uint8Array(value.slice(0));
  else if (ArrayBuffer.isView(value)) bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
  else if (value instanceof ReadableStream) {
    const reader = value.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        if (!(part.value instanceof Uint8Array)) throw new StoredServiceUsageError();
        length += part.value.byteLength;
        if (length > maximum) { await reader.cancel(); throw new StoredServiceUsageError(); }
        chunks.push(part.value.slice());
      }
    } finally { reader.releaseLock(); }
    bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  } else throw new StoredServiceUsageError();
  if (bytes.byteLength > maximum) throw new StoredServiceUsageError();
  return bytes;
}
function validIntent(input: StoredObjectIntent): StoredObjectIntent {
  if (!input || !["put", "delete"].includes(input.kind) || !["pending", "confirmed", "cancelled"].includes(input.state)) throw new StoredServiceUsageError();
  id(input.operationRef); revision(input.expectedRevision); integer(input.bytes); version(input.contentDigest);
  if ((input.kind === "put") !== (input.contentDigest !== null) || (input.kind === "delete" && input.bytes !== "0")) throw new StoredServiceUsageError();
  return input;
}
function validSnapshot(input: StoredObjectSnapshot, workspaceId: string): StoredObjectSnapshot {
  if (!input || input.workspaceId !== workspaceId) throw new StoredServiceUsageError();
  revision(input.revision); integer(input.bytes); version(input.versionDigest);
  if (input.versionDigest === null && input.bytes !== "0") throw new StoredServiceUsageError();
  if (input.pending) {
    validIntent(input.pending);
    if (input.pending.state !== "pending" || input.pending.expectedRevision !== input.revision) throw new StoredServiceUsageError();
  }
  return input;
}
function conditionMatches(object: R2Object | null, condition: R2PutOptions["onlyIf"]): boolean {
  if (!condition) return true;
  if (Object.keys(condition).some(key => !["etagMatches", "etagDoesNotMatch", "uploadedBefore", "uploadedAfter"].includes(key))) throw new StoredServiceUsageError();
  if (condition.etagMatches !== undefined && (!object || (condition.etagMatches !== "*" && condition.etagMatches !== object.etag))) return false;
  if (condition.etagDoesNotMatch !== undefined && object && (condition.etagDoesNotMatch === "*" || condition.etagDoesNotMatch === object.etag)) return false;
  if (condition.uploadedBefore !== undefined && (!object || !(condition.uploadedBefore instanceof Date) || object.uploaded >= condition.uploadedBefore)) return false;
  if (condition.uploadedAfter !== undefined && (!object || !(condition.uploadedAfter instanceof Date) || object.uploaded <= condition.uploadedAfter)) return false;
  return true;
}

/** Every PUT/DELETE is admitted before the native effect; exact replay never
 * dispatches a second effect. All participating writers must use this profile.
 */
export function storedServiceUsageBucket(bucket: R2Bucket, composition: StoredServiceComposition | undefined, input: {
  readonly bucketRole: StoredBucketRole;
  readonly writerId: string;
  /** Only a caller already holding Core-validated ownership may supply this. */
  readonly workspaceId?: string;
  /** Strict local mutation authority. Historical owner reads cannot authorize
   * a custody intent. Failure occurs before any remote PREPARE mutation. */
  readonly beforePrepare?: (key: string, kind: "put" | "delete") => Promise<void>;
  /** Local owner fence, rechecked after custody preparation and before R2.
   * A failed fence leaves the prepared intent pending for owner reconciliation. */
  readonly beforeDispatch?: (key: string, kind: "put" | "delete") => Promise<void>;
  readonly maxBytes?: number;
}): R2Bucket {
  if (!composition) return bucket;
  id(input.writerId);
  if (input.workspaceId !== undefined) id(input.workspaceId);
  const bucketRole = input.bucketRole;
  const writerId = input.writerId;
  const ownerWorkspaceId = input.workspaceId;
  const maximum = input.maxBytes ?? DEFAULT_MAX_BYTES;
  if (!Number.isSafeInteger(maximum) || maximum <= 0 || maximum > DEFAULT_MAX_BYTES) throw new StoredServiceUsageError();
  const context = async (key: string): Promise<StoredObjectContext> => {
    keyValue(key);
    const owner = ownerWorkspaceId === undefined ? await storedServiceCall(() => composition.owners.resolveStoredObjectOwner({ bucketRole, key })) : { workspaceId: ownerWorkspaceId };
    if (!owner) throw new StoredServiceUsageError();
    id(owner.workspaceId);
    const workspaceId = owner.workspaceId;
    const source = await storedServiceCall(() => composition.usage.readStoredSource({ bucketRole, writerId }));
    if (!source) throw new StoredServiceUsageError();
    id(source.sourceRef); id(source.epochRef); digest(source.qualificationDigest);
    return { sourceRef: source.sourceRef, bucketRole, writerId, workspaceId, objectRef: await storedObjectReference(bucketRole, key, source.sourceRef) };
  };
  const observe = async (key: string) => await storedServiceCall(() => bucket.head(key));
  const reconcile = async (ctx: StoredObjectContext, key: string, intent: StoredObjectIntent, dispatchToken: string, originalVersionDigest: string | null): Promise<R2ObjectBody | null> => {
    const object = await storedServiceCall(() => bucket.get(key));
    if (intent.kind === "delete") {
      if (object) throw new StoredServiceUsageError();
      const acknowledgementDigest = await storedDigest(JSON.stringify(["takosumi.stored-service.absence.v1", ctx, intent.operationRef]));
      await storedServiceCall(() => composition.usage.confirmStoredObject({ ...ctx, operationRef: intent.operationRef, dispatchToken, newVersionDigest: null, acknowledgementDigest }));
      return null;
    }
    if (!object || String(object.size) !== intent.bytes || object.key !== key) throw new StoredServiceUsageError();
    const body = (object as R2ObjectBody & { readonly body?: ReadableStream }).body;
    const bytes = await storedServiceCall(async () => await bytesFor(body ?? await object.arrayBuffer(), maximum));
    if (String(bytes.byteLength) !== intent.bytes || await contentDigest(bytes, object) !== intent.contentDigest) throw new StoredServiceUsageError();
    const newVersionDigest = await storedNativeVersion(object);
    if (newVersionDigest === originalVersionDigest) throw new StoredServiceUsageError();
    await storedServiceCall(() => composition.usage.confirmStoredObject({ ...ctx, operationRef: intent.operationRef, dispatchToken, acknowledgementDigest: newVersionDigest, newVersionDigest }));
    const replay: R2ObjectBody & { readonly body: ReadableStream<Uint8Array> } = {
      ...object, body: new ReadableStream({ start(controller) { controller.enqueue(bytes.slice()); controller.close(); } }),
      arrayBuffer: async () => bytes.slice().buffer as ArrayBuffer,
    };
    return replay;
  };
  const read = async (key: string, withBody: boolean): Promise<R2Object | R2ObjectBody | null> => {
    const ctx = await context(key);
    const snapshot = validSnapshot(await storedServiceCall(() => composition.usage.readStoredObject(ctx)), ctx.workspaceId);
    if (snapshot.pending) throw new StoredServiceUsageError();
    const object = await storedServiceCall(() => withBody ? bucket.get(key) : bucket.head(key));
    if ((object ? await storedNativeVersion(object) : null) !== snapshot.versionDigest || (object && String(object.size) !== snapshot.bytes)) throw new StoredServiceUsageError();
    return object;
  };
  return {
    get: async key => await read(key, true) as R2ObjectBody | null,
    head: async key => await read(key, false),
    list: options => bucket.list(options),
    async put(key, value, options = {}) {
      const putOptions = { ...metadata(options), ...(options.onlyIf ? { onlyIf: { ...options.onlyIf } } : {}) };
      const bytes = await storedServiceCall(() => bytesFor(value, maximum));
      const ctx = await context(key);
      const desiredDigest = await contentDigest(bytes, putOptions);
      const snapshot = validSnapshot(await storedServiceCall(() => composition.usage.readStoredObject(ctx)), ctx.workspaceId);
      if (snapshot.pending) {
        if (snapshot.pending.kind !== "put" || snapshot.pending.bytes !== String(bytes.byteLength) || snapshot.pending.contentDigest !== desiredDigest) throw new StoredServiceUsageError();
        throw new StoredServiceUsageError();
      }
      const prior = await observe(key);
      if ((prior ? await storedNativeVersion(prior) : null) !== snapshot.versionDigest) throw new StoredServiceUsageError();
      if (!conditionMatches(prior, putOptions.onlyIf)) return null;
      const operationRef = `m_${(await storedDigest(JSON.stringify([ctx, snapshot.revision, "put", desiredDigest]))).slice(7)}`;
      if (input.beforePrepare) await storedServiceCall(() => input.beforePrepare!(key, "put"));
      const prepared = await storedServiceCall(() => composition.usage.prepareStoredObject({ ...ctx, operationRef, expectedRevision: snapshot.revision, expectedVersionDigest: snapshot.versionDigest, desired: { bytes: String(bytes.byteLength), contentDigest: desiredDigest } }));
      const intent = validIntent(prepared?.intent);
      if (intent.operationRef !== operationRef || intent.expectedRevision !== snapshot.revision || intent.kind !== "put" || intent.bytes !== String(bytes.byteLength) || intent.contentDigest !== desiredDigest || typeof prepared.dispatch !== "boolean") throw new StoredServiceUsageError();
      if (!prepared.dispatch) throw new StoredServiceUsageError();
      const dispatchToken = prepared.dispatchToken;
      if (typeof dispatchToken !== "string" || !/^[0-9a-f]{64}$/u.test(dispatchToken)) throw new StoredServiceUsageError();
      if (intent.state !== "pending") throw new StoredServiceUsageError();
      let result: R2Object | null;
      if (input.beforeDispatch) await storedServiceCall(() => input.beforeDispatch!(key, "put"));
      try {
        result = await storedServiceCall(() => bucket.put(key, bytes, { ...putOptions, onlyIf: prior ? { etagMatches: prior.etag } : { etagDoesNotMatch: "*" } }));
      } catch { return await reconcile(ctx, key, intent, dispatchToken, snapshot.versionDigest); }
      if (result === null) {
        const original = await observe(key);
        const observedVersionDigest = original ? await storedNativeVersion(original) : null;
        if (observedVersionDigest !== snapshot.versionDigest) throw new StoredServiceUsageError();
        const refusalAcknowledgementDigest = await storedDigest(JSON.stringify(["takosumi.stored-service.conditional-refusal.v1", ctx, operationRef, observedVersionDigest]));
        await storedServiceCall(() => composition.usage.cancelStoredObject({ ...ctx, operationRef, dispatchToken, refusalAcknowledgementDigest, observedVersionDigest }));
        return null;
      }
      return await reconcile(ctx, key, intent, dispatchToken, snapshot.versionDigest);
    },
    async delete(key) {
      const ctx = await context(key);
      const snapshot = validSnapshot(await storedServiceCall(() => composition.usage.readStoredObject(ctx)), ctx.workspaceId);
      if (snapshot.pending) {
        if (snapshot.pending.kind !== "delete") throw new StoredServiceUsageError();
        throw new StoredServiceUsageError();
      }
      const prior = await observe(key);
      if ((prior ? await storedNativeVersion(prior) : null) !== snapshot.versionDigest) throw new StoredServiceUsageError();
      if (!prior) return;
      const operationRef = `m_${(await storedDigest(JSON.stringify([ctx, snapshot.revision, "delete"]))).slice(7)}`;
      if (input.beforePrepare) await storedServiceCall(() => input.beforePrepare!(key, "delete"));
      const prepared = await storedServiceCall(() => composition.usage.prepareStoredObject({ ...ctx, operationRef, expectedRevision: snapshot.revision, expectedVersionDigest: snapshot.versionDigest, desired: null }));
      const intent = validIntent(prepared?.intent);
      if (intent.operationRef !== operationRef || intent.expectedRevision !== snapshot.revision || intent.kind !== "delete" || typeof prepared.dispatch !== "boolean" || intent.state !== "pending") throw new StoredServiceUsageError();
      if (!prepared.dispatch || typeof prepared.dispatchToken !== "string" || !/^[0-9a-f]{64}$/u.test(prepared.dispatchToken)) throw new StoredServiceUsageError();
      if (input.beforeDispatch) await storedServiceCall(() => input.beforeDispatch!(key, "delete"));
      try { await storedServiceCall(() => bucket.delete(key)); } catch { /* Only this original sender may inspect the exact deletion outcome. */ }
      await reconcile(ctx, key, intent, prepared.dispatchToken, snapshot.versionDigest);
    },
  };
}
